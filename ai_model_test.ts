import { assert, assertEquals } from "jsr:@std/assert@1";

// Its own database file, and an admin secret for the /admin/ai gate.
const dir = await Deno.makeTempDir();
Deno.env.set("DB_PATH", `${dir}/ai_model_test.sqlite`);
const SECRET = "test-secret-0123456789-abcdefghijklmnop";
Deno.env.set("ADMIN_API_SECRET", SECRET);

const { aiPoolPresetUrl, handleAiAdminRoute, loadAiSettings } = await import("./ai_model.ts");
const { currentAiConfig, OpenAI, stripThinking } = await import("./openai.ts");

// A pretend OpenAI-shaped server: /v1 is open, /keyed/v1 wants "Bearer sekrit".
const seen: { path: string; auth: string; model: string }[] = [];
const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
  const u = new URL(req.url);
  const auth = req.headers.get("Authorization") ?? "";
  if (u.pathname.startsWith("/keyed/") && auth !== "Bearer sekrit") return new Response("no key", { status: 401 });
  if (u.pathname.endsWith("/models")) return Response.json({ data: [{ id: "qwen-b" }, { id: "qwen-a" }] });
  if (u.pathname.endsWith("/chat/completions")) {
    const body = await req.json();
    seen.push({ path: u.pathname, auth, model: body.model });
    return Response.json({ model: body.model, choices: [{ message: { content: "Welcome, travellers!" } }] });
  }
  return new Response("nope", { status: 404 });
});
const base = `http://127.0.0.1:${server.addr.port}`;

function post(fields: Record<string, string>) {
  const form = new FormData();
  form.set("key", SECRET);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const req = new Request("https://guildscribe.test/admin/ai", { method: "POST", body: form });
  return handleAiAdminRoute(req, new URL(req.url), "/admin/ai");
}

Deno.test({
  name: "/admin/ai: gate, pick, test, key handling, reset",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await loadAiSettings();

    // Locked without the key; other paths aren't handled here.
    const anon = new Request("https://guildscribe.test/admin/ai");
    assertEquals((await handleAiAdminRoute(anon, new URL(anon.url), "/admin/ai"))?.status, 401);
    assertEquals(await handleAiAdminRoute(anon, new URL(anon.url), "/admin/other"), null);

    // Load models from an address without saving anything.
    let html = await (await post({ intent: "models", base_url: `${base}/v1`, model: "" }))!.text();
    assert(html.includes(`data-model="qwen-a"`) && html.includes(`data-model="qwen-b"`));
    assertEquals(currentAiConfig().baseUrlSource === "page", false);

    // A bad address is refused.
    html = await (await post({ intent: "save", base_url: "not a url", model: "x" }))!.text();
    assert(html.includes("doesn"));

    // Save: every AI request now goes there, on that model, without the env key.
    html = await (await post({ intent: "save", base_url: `${base}/v1/`, model: "qwen-b" }))!.text();
    assert(html.includes("Saved."));
    let cfg = currentAiConfig();
    assertEquals([cfg.baseUrl, cfg.baseUrlSource, cfg.model, cfg.modelSource, cfg.apiKey], [`${base}/v1`, "page", "qwen-b", "page", ""]);
    await new OpenAI().chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
    assertEquals(seen.at(-1), { path: "/v1/chat/completions", auth: "", model: "qwen-b" });

    // Test button.
    html = await (await post({ intent: "test" }))!.text();
    assert(html.includes("It answered") && html.includes("Welcome, travellers!"));

    // A keyed server: the typed key is used and kept while the address stays.
    await post({ intent: "save", base_url: `${base}/keyed/v1`, model: "qwen-a", api_key: "sekrit" });
    await post({ intent: "save", base_url: `${base}/keyed/v1`, model: "qwen-b", api_key: "" });
    cfg = currentAiConfig();
    assertEquals([cfg.apiKey, cfg.keySource, cfg.model], ["sekrit", "page", "qwen-b"]);
    html = await (await post({ intent: "models", base_url: `${base}/keyed/v1`, model: "" }))!.text();
    assert(html.includes(`data-model="qwen-a"`));
    await new OpenAI().chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] });
    assertEquals(seen.at(-1)?.auth, "Bearer sekrit");

    // A new address drops the old address's key.
    html = await (await post({ intent: "save", base_url: `${base}/v1`, model: "qwen-a", api_key: "" }))!.text();
    assert(html.includes("removed"));
    assertEquals(currentAiConfig().apiKey, "");

    // It survives a restart (read back from the database).
    await loadAiSettings();
    assertEquals(currentAiConfig().model, "qwen-a");

    // Back to guildscribe.env.
    await post({ intent: "reset" });
    cfg = currentAiConfig();
    assertEquals(cfg.baseUrlSource === "page" || cfg.modelSource === "page" || cfg.keySource === "page", false);

    await server.shutdown();
  },
});

Deno.test("AI Pool preset: AI_POOL_URL, else port 8090 on the env's tailnet machine", () => {
  const before = { base: Deno.env.get("OPENAI_BASE_URL"), pool: Deno.env.get("AI_POOL_URL") };
  try {
    Deno.env.delete("AI_POOL_URL");
    Deno.env.set("OPENAI_BASE_URL", "https://box.tailabc.ts.net/v1");
    assertEquals(aiPoolPresetUrl(), "http://box.tailabc.ts.net:8090/v1");
    Deno.env.set("OPENAI_BASE_URL", "https://api.openai.com/v1");
    assertEquals(aiPoolPresetUrl(), "");
    Deno.env.set("AI_POOL_URL", "http://100.64.0.7:8090/v1/");
    assertEquals(aiPoolPresetUrl(), "http://100.64.0.7:8090/v1");
    Deno.env.set("AI_POOL_URL", "off");
    assertEquals(aiPoolPresetUrl(), "");
  } finally {
    before.base === undefined ? Deno.env.delete("OPENAI_BASE_URL") : Deno.env.set("OPENAI_BASE_URL", before.base);
    before.pool === undefined ? Deno.env.delete("AI_POOL_URL") : Deno.env.set("AI_POOL_URL", before.pool);
  }
});

Deno.test("stripThinking keeps only the answer", () => {
  const reply = (content: string) => stripThinking({ choices: [{ message: { content } }] }).choices[0].message.content;
  assertEquals(reply("<think>hmm, a greeting</think>\n\nWelcome in!"), "Welcome in!");
  assertEquals(reply("hmm, a greeting</think>Welcome in!"), "Welcome in!");
  assertEquals(reply("Welcome in!"), "Welcome in!");
  assertEquals(reply("Welcome<think>still going"), "Welcome");
});

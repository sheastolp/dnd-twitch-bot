import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { AiBusyError, aiQueueState, isAiBusy, OpenAI, setAiOverride } from "./openai.ts";
import { cleanChatReply, fitReply } from "./ai_reply.ts";

// A pretend AI Pool: records each request body, answers after `delay` ms,
// and can be told to answer 503 or 400 first.
const bodies: any[] = [];
let delay = 0;
let failFirst: number | null = null;
let rejectThinkingOff = false;
let inFlight = 0;
let maxInFlight = 0;
const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
  const body = await req.json();
  bodies.push(body);
  if (failFirst !== null) {
    const status = failFirst;
    failFirst = null;
    return new Response("busy", { status });
  }
  if (rejectThinkingOff && body.chat_template_kwargs) return new Response("unknown field", { status: 400 });
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, delay));
  inFlight--;
  return Response.json({ choices: [{ message: { content: "<think>hmm</think>Ale's on the house!" }, finish_reason: "stop" }] });
});
const ai = new OpenAI();
setAiOverride({ baseUrl: `http://127.0.0.1:${server.addr.port}/v1`, model: "qwen3.5-35b-a3b", apiKey: "" });

function reset() {
  bodies.length = 0;
  delay = 0;
  failFirst = null;
  rejectThinkingOff = false;
  maxInFlight = 0;
}

const ask = (opts: { timeoutMs?: number; ifIdle?: boolean } = {}, extra: Record<string, unknown> = {}) =>
  ai.chat.completions.create({ model: "gpt-4o-mini", max_completion_tokens: 50, temperature: 0.8, messages: [{ role: "user", content: "hi" }], ...extra }, opts);

Deno.test({
  name: "pool requests: thinking off, sampling kept, max_tokens, thinking stripped",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    reset();
    const j = await ask();
    assertEquals(j.choices[0].message.content, "Ale's on the house!");
    const b = bodies[0];
    assertEquals(b.model, "qwen3.5-35b-a3b");
    assertEquals(b.chat_template_kwargs, { enable_thinking: false });
    assertEquals(b.reasoning_effort, "none");
    assertEquals(b.temperature, 0.8);
    assertEquals(b.max_tokens, 50);
    assertEquals(b.max_completion_tokens, undefined);
    assertEquals("think" in b, false);

    // think: true leaves thinking on.
    reset();
    await ask({}, { think: true });
    assertEquals(bodies[0].chat_template_kwargs, undefined);
    assertEquals(bodies[0].reasoning_effort, undefined);
  },
});

Deno.test({
  name: "pool requests: one at a time, ifIdle skips, queue waits inside the time limit",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    reset();
    delay = 300;
    const all = await Promise.all([ask(), ask(), ask()]);
    assertEquals(all.length, 3);
    assertEquals(maxInFlight, 1);
    assertEquals(aiQueueState(), { active: 0, waiting: 0 });

    // While one runs, an ifIdle request is skipped at once.
    reset();
    delay = 300;
    const first = ask();
    await assertRejects(() => ask({ ifIdle: true }), AiBusyError);
    await first;

    // A request that can't get a turn in time gives up as "busy".
    reset();
    delay = 600;
    const slow = ask();
    const err = await ask({ timeoutMs: 150 }).catch((e) => e);
    assert(isAiBusy(err));
    await slow;
    assertEquals(aiQueueState(), { active: 0, waiting: 0 });
  },
});

Deno.test({
  name: "pool requests: 503 isn't retried (busy); 400 drops the thinking-off fields",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    reset();
    failFirst = 503;
    const busy = await ask().catch((e) => e);
    assert(isAiBusy(busy));
    assertEquals(bodies.length, 1);

    reset();
    rejectThinkingOff = true;
    await ask();
    assertEquals(bodies.length, 2);
    assertEquals(bodies[1].chat_template_kwargs, undefined);
    assertEquals(bodies[1].reasoning_effort, undefined);

    assert(isAiBusy(new Error("AI request failed: HTTP 503 loading model")));
    assertEquals(isAiBusy(new Error("AI request failed: HTTP 500 boom")), false);
  },
});

Deno.test("fitReply cuts at a sentence end, or a word end with …", () => {
  assertEquals(fitReply("Short one.", 50), "Short one.");
  assertEquals(fitReply("First bit here. Second bit is much longer than the rest.", 30), "First bit here.");
  const cut = fitReply("one two three four five six seven eight nine ten", 20);
  assert(cut.length <= 20 && cut.endsWith("…") && !cut.includes("seve"), cut);
});

Deno.test("cleanChatReply drops labels, stage directions, markdown and quotes", () => {
  assertEquals(cleanChatReply("Grimsby: Aye, the forge is hot.", ["Grimsby"], 100), "Aye, the forge is hot.");
  assertEquals(cleanChatReply("**Old Grimsby:** *wipes hands* Aye.", ["Grimsby"], 100), "Aye.");
  assertEquals(cleanChatReply(`"Welcome, traveller!"`, [], 100), "Welcome, traveller!");
  // A name in the middle of the reply stays.
  assertEquals(cleanChatReply("Aye, Grimsby knows: the forge is hot.", ["Grimsby"], 100), "Aye, Grimsby knows: the forge is hot.");
});

Deno.test({ name: "haggle prompt names the ware's bonus and the last attempt", sanitizeResources: false, sanitizeOps: false, fn: async () => {
  Deno.env.set("DB_PATH", `${await Deno.makeTempDir()}/openai_test.sqlite`);
  const { buildSystemPrompt } = await import("./haggle.ts");
  const p = buildSystemPrompt("Pip", "a lucky rabbit's foot", "1 silver", 10, "+1 DEX", 3);
  assert(p.includes("+1 DEX"));
  assert(p.includes("haggle 3 of 3") && p.includes("last chance"));
  const plain = buildSystemPrompt("Pip", "a lucky rabbit's foot", "1 silver", 10);
  assert(!plain.includes("character sheet") && !plain.includes("haggle 1 of"));
} });

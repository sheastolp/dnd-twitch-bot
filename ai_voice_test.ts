// Tests for AI-worded replies (ai_voice.ts) and the AI switch (openai.ts,
// ai_model.ts), against a throwaway database with Twitch and the AI stubbed.
// deno test -A ai_voice_test.ts

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const dir = Deno.makeTempDirSync();
Deno.env.set("DB_PATH", `${dir.replaceAll("\\", "/")}/test.sqlite`);
Deno.env.set("ORRERY", "off");
Deno.env.set("ORRERY_NO_TIMER", "1");
Deno.env.set("AI_REWORD_TIMEOUT_MS", "1500");
Deno.env.set("AI_REWORD_MAX_WAITING", "1");
const SECRET = "test-secret-0123456789-abcdefghijklmnop";
Deno.env.set("ADMIN_API_SECRET", SECRET);
for (const k of ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_BOT_ID"]) Deno.env.set(k, "test");

// Twitch: chat messages land in `sent`. The AI (http://ai.test/v1): answers
// `aiAnswer`, after `aiDelay` ms; each request lands in `aiAsked`.
const sent: string[] = [];
const aiAsked: any[] = [];
let aiAnswer = "";
let aiDelay = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/helix/chat/messages")) {
    sent.push(JSON.parse(String(init?.body ?? "{}")).message ?? "");
    return Response.json({ data: [{ message_id: "m", is_sent: true }] });
  }
  if (url.startsWith("http://ai.test/")) {
    aiAsked.push(JSON.parse(String(init?.body ?? "{}")));
    if (aiDelay) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, aiDelay);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("timed out", "TimeoutError"));
        });
      });
    }
    return Response.json({ choices: [{ message: { content: aiAnswer }, finish_reason: "stop" }] });
  }
  if (url.includes("oauth2/token")) return Response.json({ access_token: "t", expires_in: 3600, token_type: "bearer" });
  return Response.json({ data: [] });
}) as typeof fetch;

const { aiWordReply, checkFacts, namesIn, notRewordable, numbersIn, rewordPending, rewordStats } = await import("./ai_voice.ts");
const { AiOffError, isAiEnabled, OpenAI, setAiEnabled, setAiOverride } = await import("./openai.ts");
const { handleAiAdminRoute, loadAiSettings, setAiSwitch } = await import("./ai_model.ts");
const { sendChatMessage, sendChatMessages } = await import("./twitch.ts");
const { ensureTables } = await import("./db_schema.ts");
await ensureTables();
await loadAiSettings();
setAiOverride({ baseUrl: "http://ai.test/v1", model: "qwen3.5-35b-a3b", apiKey: "" });

const CH = "2002";
function reset(answer = "") {
  sent.length = 0;
  aiAsked.length = 0;
  aiAnswer = answer;
  aiDelay = 0;
  setAiEnabled(true);
}

const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test("facts: numbers, dice, names, tags, commands, links and quotes must survive", () => {
  assertEquals(numbersIn("@Bob rolled 1d20+3: 14 + 3 = 17, 1,250 gold"), ["1d20+3", "14", "3", "17", "1250"]);
  assertEquals(namesIn("You found a Longsword of Flame in the Goblin's lair. Nice!"), ["Longsword", "Flame", "Goblin's"]);
  const canned = "🎲 rolled 1d20: 14. Your Dagger glints. Try !roll again";
  assertEquals(checkFacts(canned, "The dice tumble: 1d20 shows 14! Your Dagger gleams. Fancy another !roll?"), null);
  assertEquals(checkFacts(canned, "The dice tumble: 1d20 shows 15! Your Dagger gleams. !roll again?"), "added a number");
  assertEquals(checkFacts(canned, "The dice tumble and show 14! Your Dagger gleams. !roll again?"), "lost a number");
  assertEquals(checkFacts(canned, "Your 14 came off a 1d20! Your Dagger gleams. !roll again?"), "moved numbers around");
  assertEquals(checkFacts(canned, "1d20 lands on 14! Your blade gleams. !roll again?"), "lost the name Dagger");
  assertEquals(checkFacts(canned, "1d20 lands on 14! Your Dagger gleams."), "lost a !command");
  assertEquals(checkFacts(canned, "1d20 lands on 14! Your Dagger gleams. !roll or !duel?"), "added a !command");
  assertEquals(checkFacts("thanks @Ann", "thanks @Ann and @Cid"), "added an @-tag");
  assertEquals(checkFacts("see https://x.test/a", "see the page"), "lost a link");
  assertEquals(checkFacts(`the scribe wrote "Bob owes 3 ale"`, `the scribe noted Bob owes 3 mead`), "changed quoted text");
});

Deno.test("only prose is worded: no long text, usage lines, tables or lists", () => {
  assertEquals(notRewordable("@Bob you have 12 gold and 4 silver."), null);
  assertEquals(notRewordable("x".repeat(400)), "long");
  assertEquals(notRewordable("usage: !npc talk <name> <message>"), "usage line");
  assertEquals(notRewordable("STR 14 DEX 12 CON 13 INT 10 WIS 8 CHA 15 HP 9"), "many numbers");
  assertEquals(notRewordable("Fighter | Wizard | Rogue | Cleric"), "list");
});

Deno.test({
  name: "a reply goes out worded by the AI, with its @Name lead and facts intact",
  ...opts,
  fn: async () => {
    reset("The bones clatter across the table: your 1d20 lands on 14!");
    await sendChatMessage("@Bob 🎲 you rolled 1d20 and got 14.", CH);
    assertEquals(sent, ["@Bob The bones clatter across the table: your 1d20 lands on 14!"]);
    assertEquals(aiAsked.length, 1);
    assertEquals(aiAsked[0].chat_template_kwargs, { enable_thinking: false });
    assert(String(aiAsked[0].messages[1].content).includes("you rolled 1d20 and got 14."));

    // The AI repeating the tag doesn't double it.
    reset("@Bob Your 1d20 says 14, the bones have spoken.");
    await sendChatMessages("@Bob 🎲 you rolled 1d20 and got 14.", CH);
    assertEquals(sent, ["@Bob Your 1d20 says 14, the bones have spoken."]);
  },
});

Deno.test({
  name: "the canned line goes out when the AI drops a fact, garbles, or tries a chat command",
  ...opts,
  fn: async () => {
    const canned = "@Bob 🎲 you rolled 1d20 and got 14.";
    for (const bad of ["The bones clatter: a 15!", "////////////////////////////////", "/ban everyone 1d20 14", ""]) {
      reset(bad);
      const before = rewordStats.blocked;
      await sendChatMessage(canned, CH);
      assertEquals(sent, [canned], bad);
      assertEquals(rewordStats.blocked, before + 1, bad);
    }
  },
});

Deno.test({
  name: "ai: false, long text and the streamer's own words go out word for word, with no AI call",
  ...opts,
  fn: async () => {
    reset("Something else entirely 14.");
    await sendChatMessage("📜 #3: \"Never trust a mimic\" — Bob, 2026", CH, [], { ai: false });
    await sendChatMessages("Welcome to the stream, follow for more!", CH, { ai: false });
    const long = "Fireball. 3rd-level evocation. ".repeat(14).trim();
    await sendChatMessages(long, CH);
    assertEquals(aiAsked.length, 0);
    assertEquals(sent[0], "📜 #3: \"Never trust a mimic\" — Bob, 2026");
    assertEquals(sent[1], "Welcome to the stream, follow for more!");
  },
});

Deno.test({
  name: "a slow or busy AI: canned line after the time limit, extra lines skip the queue",
  ...opts,
  fn: async () => {
    reset("Your purse holds 12 gold, friend.");
    aiDelay = 3000; // past AI_REWORD_TIMEOUT_MS (1.5 s)
    const started = Date.now();
    const canned = "@Ann you have 12 gold.";
    const lines = await Promise.all([aiWordReply(canned, CH), aiWordReply(canned, CH), aiWordReply(canned, CH), aiWordReply(canned, CH)]);
    assertEquals(lines, [canned, canned, canned, canned]);
    assert(Date.now() - started < 2900, "nobody waited past the time limit");
    // One worded at a time plus AI_REWORD_MAX_WAITING (1) waiting: the other two never asked.
    assert(aiAsked.length <= 2, `asked ${aiAsked.length}`);
    assertEquals(rewordPending(), 0);
  },
});

Deno.test({
  name: "AI switch off: no AI request at all, canned lines, and it's saved across restarts",
  ...opts,
  fn: async () => {
    reset("The bones clatter: 1d20 shows 14!");
    await setAiSwitch(false, "test");
    assertEquals(isAiEnabled(), false);
    await sendChatMessage("@Bob 🎲 you rolled 1d20 and got 14.", CH);
    assertEquals(sent, ["@Bob 🎲 you rolled 1d20 and got 14."]);
    await assertRejects(() => new OpenAI().chat.completions.create({ model: "m", messages: [] }), AiOffError);
    assertEquals(aiAsked.length, 0);

    // A restart reads the switch back.
    setAiEnabled(true);
    await loadAiSettings();
    assertEquals(isAiEnabled(), false);

    // /admin/ai: the switch is shown and flips it back on.
    const get = new Request(`https://gs.test/admin/ai?key=${SECRET}`);
    const html = await (await handleAiAdminRoute(get, new URL(get.url), "/admin/ai"))!.text();
    assert(html.includes("AI replies: OFF"));
    const form = new FormData();
    form.set("key", SECRET);
    form.set("intent", "power_on");
    const post = new Request("https://gs.test/admin/ai", { method: "POST", body: form });
    const after = await (await handleAiAdminRoute(post, new URL(post.url), "/admin/ai"))!.text();
    assert(after.includes("AI replies: ON"));
    assertEquals(isAiEnabled(), true);
    await loadAiSettings();
    assertEquals(isAiEnabled(), true);
  },
});

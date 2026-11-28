// Tests for !oracle picking from the options it's given (oracle.ts,
// oracle_choices.ts) and the AI guard that keeps the pick (ai_voice.ts),
// against a throwaway database with Twitch and the AI stubbed.
// deno test -A oracle_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";

const dir = Deno.makeTempDirSync();
Deno.env.set("DB_PATH", `${dir.replaceAll("\\", "/")}/test.sqlite`);
Deno.env.set("ORRERY", "off");
Deno.env.set("ORRERY_NO_TIMER", "1");
Deno.env.set("AI_REWORD_TIMEOUT_MS", "1500");
for (const k of ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_BOT_ID"]) Deno.env.set(k, "test");

// Twitch: chat messages land in `sent`. The AI (http://ai.test/v1) answers
// aiAnswer(the line it was asked to word).
const sent: string[] = [];
let aiCalls = 0;
let aiAnswer: (line: string) => string = () => "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/helix/chat/messages")) {
    sent.push(JSON.parse(String(init?.body ?? "{}")).message ?? "");
    return Response.json({ data: [{ message_id: "m", is_sent: true }] });
  }
  if (url.startsWith("http://ai.test/")) {
    aiCalls++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const line = String(body.messages?.[1]?.content ?? "").replace(/^[^:]*:\s*/, "");
    return Response.json({ choices: [{ message: { content: aiAnswer(line) }, finish_reason: "stop" }] });
  }
  if (url.includes("oauth2/token")) return Response.json({ access_token: "t", expires_in: 3600, token_type: "bearer" });
  return Response.json({ data: [] });
}) as typeof fetch;

const { choiceOptions, pickChoice } = await import("./oracle_choices.ts");
const { checkGuard } = await import("./ai_voice.ts");
const { handleOracleCommand } = await import("./oracle.ts");
const { setAiEnabled, setAiOverride } = await import("./openai.ts");
const { ensureTables } = await import("./db_schema.ts");
await ensureTables();
setAiOverride({ baseUrl: "http://ai.test/v1", model: "qwen3.5-35b-a3b", apiKey: "" });

const CH = "3003";
const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test("options are read out of the question", () => {
  const cases: Array<[string, string[] | null]> = [
    ["pizza or tacos?", ["pizza", "tacos"]],
    ["pizza, tacos, or sushi", ["pizza", "tacos", "sushi"]],
    ["pizza, tacos, sushi", ["pizza", "tacos", "sushi"]],
    ["pizza/tacos", ["pizza", "tacos"]],
    ["pizza vs tacos", ["pizza", "tacos"]],
    ["a, b, or c", ["a", "b", "c"]],
    ["should I play Elden Ring or Hades?", ["Elden Ring", "Hades"]],
    ["should I eat pizza or tacos for dinner", ["pizza", "tacos for dinner"]],
    ["should I stream or sleep?", ["stream", "sleep"]],
    ["should I play games or stream", ["play games", "stream"]],
    ["should we go to bed or keep streaming", ["go to bed", "keep streaming"]],
    ["should I stream or not", ["stream", "not stream"]],
    ["is it pizza or tacos", ["pizza", "tacos"]],
    ["which is better, cats or dogs?", ["cats", "dogs"]],
    ["which is better cats or dogs", ["cats", "dogs"]],
    ["what should I eat: pizza, tacos, sushi", ["pizza", "tacos", "sushi"]],
    ["dinner: pizza/tacos", ["pizza", "tacos"]],
    ["hey oracle, Elden Ring or Hades", ["Elden Ring", "Hades"]],
    ["AC/DC or Metallica", ["AC/DC", "Metallica"]],
    ["who goes first, @Bob or @Ann", ["@Bob", "@Ann"]],
    ["pizza or Pizza", null],
    // Plain questions keep naming a chatter.
    ["who should stream next?", null],
    ["will I win tonight?", null],
    ["hey oracle, will I win tonight?", null],
    ["honestly, is this a good idea", null],
    ["I'm tired, should I sleep?", null],
    ["is https://x.test/a/b legit", null],
  ];
  for (const [q, want] of cases) assertEquals(choiceOptions(q), want, q);
});

Deno.test("the pick is one of the options, and every option can come up", () => {
  const options = ["pizza", "tacos", "sushi"];
  assertEquals(pickChoice(options, () => 0), "pizza");
  assertEquals(pickChoice(options, () => 0.5), "tacos");
  assertEquals(pickChoice(options, () => 0.9999), "sushi");
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) seen.add(pickChoice(options));
  assertEquals([...seen].sort(), ["pizza", "sushi", "tacos"]);
});

Deno.test("guard: the AI's wording must name the pick and no other option", () => {
  const canned = `🍀 Fate's coin spins, falls and lands on "tacos"`;
  const guard = { keep: ["tacos"], avoid: ["pizza", "sushi"] };
  assertEquals(checkGuard(canned, `The coin lands: "tacos" it is!`, guard), null);
  assertEquals(checkGuard(canned, `The coin lands on pizza, not "tacos"!`, guard), "named another option");
  assertEquals(checkGuard(canned, `The coin lands on pizza!`, guard), "lost the answer");
  // An unpicked option inside the pick doesn't count.
  assertEquals(checkGuard(`fate chooses "pineapple pizza"`, `Fate picks "pineapple pizza"!`, { keep: ["pineapple pizza"], avoid: ["pizza"] }), null);
  assertEquals(checkGuard(`fate chooses "stream"`, `Fate says "not stream"... I mean "stream"`, { keep: ["stream"], avoid: ["not stream"] }), "named another option");
  assertEquals(checkGuard(`fate chooses "not stream"`, `Fate says "not stream"`, { keep: ["not stream"], avoid: ["stream"] }), null);
});

Deno.test({
  name: "!oracle with options names one of them; the AI can word it but can't swap it",
  ...opts,
  fn: async () => {
    // AI off: canned line, one of the options, no chatter, no other option.
    setAiEnabled(false);
    const counts: Record<string, number> = { pizza: 0, tacos: 0 };
    for (let i = 0; i < 16; i++) {
      sent.length = 0;
      assert(await handleOracleCommand("!oracle pizza or tacos?", "bob", "Bob", CH));
      assertEquals(sent.length, 1);
      const m = sent[0].match(/"(pizza|tacos)"/);
      assert(m, sent[0]);
      assert(sent[0].startsWith("@Bob "), sent[0]);
      assert(!sent[0].includes(m[1] === "pizza" ? "tacos" : "pizza"), sent[0]);
      counts[m[1]]++;
    }
    assert(counts.pizza > 0 && counts.tacos > 0, JSON.stringify(counts));

    // AI on and well behaved: its wording goes out, with the pick in it.
    setAiEnabled(true);
    aiCalls = 0;
    aiAnswer = (line) => `The mists part and the answer is plain: "${line.match(/"([^"]+)"/)![1]}"!`;
    sent.length = 0;
    await handleOracleCommand("!oracle should I play Elden Ring or Hades?", "bob", "Bob", CH);
    assertEquals(aiCalls, 1);
    assert(/^@Bob The mists part and the answer is plain: "(Elden Ring|Hades)"!$/.test(sent[0]), sent[0]);

    // AI on and swapping the answer: the canned line goes out instead.
    aiAnswer = (line) => (line.includes(`"Elden Ring"`) ? `The mists show "Hades", not "Elden Ring"!` : `The mists show "Elden Ring", not "Hades"!`);
    for (let i = 0; i < 5; i++) {
      sent.length = 0;
      await handleOracleCommand("!oracle should I play Elden Ring or Hades?", "bob", "Bob", CH);
      assert(!sent[0].includes("mists"), sent[0]);
      assert(/"(Elden Ring|Hades)"/.test(sent[0]), sent[0]);
    }
    setAiEnabled(false);
  },
});

Deno.test({
  name: "!oracle without options still names a chatter",
  ...opts,
  fn: async () => {
    setAiEnabled(false);
    sent.length = 0;
    await handleOracleCommand("!oracle who should stream next?", "bob", "Bob", CH);
    assertEquals(sent.length, 1);
    // No one has used a command here yet in the throwaway database.
    assert(sent[0].includes("the oracle is silent") || /@\w+/.test(sent[0].slice(5)), sent[0]);
    assert(sent[0].includes("who should stream next?") || sent[0].includes("silent"), sent[0]);
  },
});

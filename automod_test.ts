// Tests for the spam filters' pure parts (automod.ts).
// deno test --allow-env --allow-read --allow-write automod_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  checkMessage,
  DEFAULT_CONFIG,
  findLinks,
  formatLadder,
  isExempt,
  isRepetitive,
  parseLadder,
  repeatKey,
  sanitizeConfig,
  stepFor,
  trackRepeat,
} from "./automod.ts";

const cfg = sanitizeConfig({ filters: { links: true, caps: true, symbols: true, emotes: true, repeats: true, length: true } });
const hit = (message: string, extra: Record<string, unknown> = {}) => checkMessage(cfg, { message, ...extra })?.filter ?? null;

Deno.test("links: urls, bare domains and spelled-out domains", () => {
  assertEquals(findLinks("check https://evil.example.com/x now"), ["evil.example.com"]);
  assertEquals(findLinks("go to streamboost.xyz"), ["streamboost.xyz"]);
  assertEquals(findLinks("grow dot com for viewers"), ["grow.com"]);
  assertEquals(findLinks("www.youtube.com/watch?v=1"), ["youtube.com"]);
  assertEquals(findLinks("thanks all. com on in"), []);
  assertEquals(findLinks("e.g. this, i.e. that, 3.5 hours"), []);
  assertEquals(findLinks("mail me at bob@gmail.com"), []);
});

Deno.test("links: allow list, subdomains and permits", () => {
  assertEquals(hit("look clips.twitch.tv/AbcDef"), null);
  assertEquals(hit("https://www.twitch.tv/somebody"), null);
  assertEquals(hit("buy at cheap-followers.shop"), "links");
  assertEquals(hit("buy at cheap-followers.shop", { permitted: true }), null);
});

Deno.test("caps: ignores short shouts and emote codes", () => {
  assertEquals(hit("LETS GOOOO"), null);
  assertEquals(hit("WHY IS EVERYONE SHOUTING IN THIS CHAT"), "caps");
  assertEquals(hit("Hello there friends, how is the stream going?"), null);
  const fragments = [{ type: "emote", text: "LUL" }, { type: "text", text: " " }, { type: "emote", text: "KEKW" }, { type: "text", text: " that was funny" }];
  assertEquals(checkMessage(cfg, { message: "LUL KEKW that was funny", fragments }), null);
});

Deno.test("symbols, emotes, length", () => {
  assertEquals(hit("░▒▓█▓▒░░▒▓█▓▒░░▒▓█▓▒░"), "symbols");
  assertEquals(hit("nice play!!! wow :)"), null);
  const many = Array.from({ length: 16 }, () => ({ type: "emote", text: "Kappa" }));
  assertEquals(checkMessage(cfg, { message: "Kappa ".repeat(16), fragments: many })?.filter, "emotes");
  assertEquals(hit("a".repeat(10) + " " + "word ".repeat(90)), "length");
});

Deno.test("repetition: inside a message and across messages", () => {
  assert(isRepetitive("spam ".repeat(12)));
  assert(isRepetitive("lo" + "l".repeat(30)));
  assert(!isRepetitive("the quick brown fox jumps over the lazy dog again and again"));
  assertEquals(hit("hello", { repeatCount: 3 }), "repeats");
  assertEquals(hit("hello", { repeatCount: 2 }), null);
  const k = "chan:user";
  assertEquals(trackRepeat(k, "follow me pls", 0), 1);
  assertEquals(trackRepeat(k, "Follow me, pls!", 1000), 2);
  assertEquals(trackRepeat(k, "@bob follow me pls", 2000), 3);
  assertEquals(trackRepeat(k, "follow me pls", 10 * 60_000), 1);
  assertEquals(repeatKey("@bob Hi!!"), "hi");
});

Deno.test("filters can be switched off", () => {
  const off = sanitizeConfig({ filters: { links: false, caps: false, symbols: false, emotes: false, repeats: false, length: false } });
  assertEquals(checkMessage(off, { message: "BUY AT CHEAP-FOLLOWERS.SHOP NOW!!!!!", repeatCount: 9 }), null);
});

Deno.test("ladder parsing, formatting and steps", () => {
  const r = parseLadder("warn, 1m, 10m, 1d, ban");
  assert(r.ok);
  if (!r.ok) return;
  assertEquals(r.ladder, ["warn", 60, 600, 86400, "ban"]);
  assertEquals(formatLadder(r.ladder), "warn, 1m, 10m, 1d, ban");
  assertEquals(stepFor(r.ladder, 1), "warn");
  assertEquals(stepFor(r.ladder, 9), "ban");
  assert(!parseLadder("").ok);
  assert(!parseLadder("warn, forever").ok);
  assert(!parseLadder("3w").ok);
  assertEquals(formatLadder(DEFAULT_CONFIG.ladder), "warn, 1m, 10m");
});

Deno.test("config sanitizing and exemptions", () => {
  const c = sanitizeConfig({ capsPct: 5, lengthMax: 99999, exempt: "admin", allowDomains: ["https://www.YouTube.com/x", "not a domain"] });
  assertEquals(c.capsPct, 30);
  assertEquals(c.lengthMax, 500);
  assertEquals(c.exempt, "vip");
  assertEquals(c.allowDomains, ["youtube.com"]);
  assertEquals(sanitizeConfig("garbage").ladder, DEFAULT_CONFIG.ladder);
  assert(isExempt("vip", [{ set_id: "vip" }]));
  assert(!isExempt("vip", [{ set_id: "subscriber" }]));
  assert(isExempt("sub", [{ set_id: "founder" }]));
  assert(!isExempt("none", [{ set_id: "vip" }]));
});

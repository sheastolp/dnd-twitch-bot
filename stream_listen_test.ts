import { assertEquals } from "jsr:@std/assert@1";
import { cleanTranscript, heardPhrase } from "./stream_listen.ts";

Deno.test("heardPhrase catches both phrases however they're written", () => {
  assertEquals(heardPhrase("Oh my god, that was stupid."), "that was stupid");
  assertEquals(heardPhrase("THAT WAS SO STUPID"), "that was stupid");
  assertEquals(heardPhrase("ugh I'm stupid"), "I'm stupid");
  assertEquals(heardPhrase("I’m stupid, okay"), "I'm stupid");
  assertEquals(heardPhrase("im stupid"), "I'm stupid");
  assertEquals(heardPhrase("I am really stupid"), "I'm stupid");
  assertEquals(heardPhrase("Oh, that was worthy of one."), "that was worthy of one");
  assertEquals(heardPhrase("That's worthy of one, chat"), "that was worthy of one");
  assertEquals(heardPhrase("that was worthy of 1"), "that was worthy of one");
  assertEquals(heardPhrase("that was totally worthy of a shot"), "that was worthy of one");
});

Deno.test("heardPhrase ignores look-alikes", () => {
  assertEquals(heardPhrase("that was stupidly good"), null);
  assertEquals(heardPhrase("him stupid? no"), null);
  assertEquals(heardPhrase("that wasn't stupid"), null);
  assertEquals(heardPhrase("you're stupid"), null);
  assertEquals(heardPhrase("that was worthy of oneself"), null);
  assertEquals(heardPhrase("that wasn't worthy of one"), null);
  assertEquals(heardPhrase(""), null);
});

Deno.test("cleanTranscript drops made-up lines", () => {
  assertEquals(cleanTranscript("Thanks for watching!"), "");
  assertEquals(cleanTranscript("That was stupid. Thanks for watching!"), "That was stupid.");
});

Deno.test("the listen log page shows heard lines, escaped, and filters them", async () => {
  const { ensureTables } = await import("./db_schema.ts");
  await ensureTables();
  const { note } = await import("./stream_listen.ts");
  const { renderListenPage, renderListenLogText } = await import("./listen_page.ts");
  note("said", "testchan", "oh <b>that was stupid</b>");
  note("shot", "testchan", 'heard "that was stupid" — +1, 1 shot this stream.');
  note("said", "otherchan", "hello there");
  const html = await renderListenPage(new URLSearchParams("channel=testchan"), "");
  assertEquals(html.includes("oh &lt;b&gt;that was stupid&lt;/b&gt;"), true);
  assertEquals(html.includes("<b>that was stupid</b>"), false);
  assertEquals(html.includes("hello there"), false); // another channel's line
  const shots = renderListenLogText(new URLSearchParams("kind=shot&channel=testchan"));
  assertEquals(shots.includes("+1, 1 shot"), true);
  assertEquals(shots.includes("hello there"), false);
  assertEquals(renderListenLogText(new URLSearchParams("channel=otherchan")).includes("oh <b>"), false);
});

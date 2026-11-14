import { assertEquals } from "jsr:@std/assert@1";
import { cleanTranscript, heardPhrase } from "./stream_listen.ts";

Deno.test("heardPhrase catches both phrases however they're written", () => {
  assertEquals(heardPhrase("Oh my god, that was stupid."), "that was stupid");
  assertEquals(heardPhrase("THAT WAS SO STUPID"), "that was stupid");
  assertEquals(heardPhrase("ugh I'm stupid"), "I'm stupid");
  assertEquals(heardPhrase("I’m stupid, okay"), "I'm stupid");
  assertEquals(heardPhrase("im stupid"), "I'm stupid");
  assertEquals(heardPhrase("I am really stupid"), "I'm stupid");
});

Deno.test("heardPhrase ignores look-alikes", () => {
  assertEquals(heardPhrase("that was stupidly good"), null);
  assertEquals(heardPhrase("him stupid? no"), null);
  assertEquals(heardPhrase("that wasn't stupid"), null);
  assertEquals(heardPhrase("you're stupid"), null);
  assertEquals(heardPhrase(""), null);
});

Deno.test("cleanTranscript drops made-up lines", () => {
  assertEquals(cleanTranscript("Thanks for watching!"), "");
  assertEquals(cleanTranscript("That was stupid. Thanks for watching!"), "That was stupid.");
});

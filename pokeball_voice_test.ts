import { assertEquals } from "jsr:@std/assert@1";
import { heardThrow } from "./pokeball.ts";

Deno.test("heardThrow names the ball the streamer called for", () => {
  assertEquals(heardThrow("Throw a great ball!"), { ball: "greatball" });
  assertEquals(heardThrow("okay throw an Ultra Ball at it"), { ball: "ultraball" });
  assertEquals(heardThrow("throw an ultraball"), { ball: "ultraball" });
  assertEquals(heardThrow("Throw a Poké Ball."), { ball: "pokeball" });
  assertEquals(heardThrow("throw a pokeball"), { ball: "pokeball" });
  assertEquals(heardThrow("throw the master ball"), { ball: "masterball" });
  assertEquals(heardThrow("let's throw a dusk ball"), { ball: "duskball" });
  assertEquals(heardThrow("throw quick ball"), { ball: "quickball" });
});

Deno.test("heardThrow uses the suggested ball for a plain throw", () => {
  assertEquals(heardThrow("throw a ball"), { ball: null });
  assertEquals(heardThrow("Throw the ball!"), { ball: null });
  assertEquals(heardThrow("throw it, throw it"), { ball: null });
  assertEquals(heardThrow("Catch it!"), { ball: null });
  assertEquals(heardThrow("poke catch"), { ball: null });
});

Deno.test("heardThrow ignores look-alikes", () => {
  assertEquals(heardThrow("throw a football"), null);
  assertEquals(heardThrow("I threw a ball yesterday"), null);
  assertEquals(heardThrow("that was a great ball game"), null);
  assertEquals(heardThrow("catching up with chat"), null);
  assertEquals(heardThrow("throwing it all away"), null);
  assertEquals(heardThrow("hello chat"), null);
});

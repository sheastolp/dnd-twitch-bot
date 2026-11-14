import { assertEquals } from "jsr:@std/assert@1";
import { decide, titleHasWord } from "./shots_auto.ts";

Deno.test("titleHasWord finds the whole word however the title writes it", () => {
  assertEquals(titleHasWord("drunk hollow knight", "drunk"), true);
  assertEquals(titleHasWord("DRUNK Hollow Knight!!", "drunk"), true);
  assertEquals(titleHasWord("Hollow Knight but #drunk | !shots", "drunk"), true);
  assertEquals(titleHasWord("Hollow Knight, drunk.", "drunk"), true);
  assertEquals(titleHasWord("drunken master", "drunk"), false);
  assertEquals(titleHasWord("sober hollow knight", "drunk"), false);
});

Deno.test("decide: the title turns it on/off, a manual choice wins", () => {
  const free = { autoOn: false, manual: null };
  assertEquals(decide(true, false, free), "on");
  assertEquals(decide(true, true, free), null);
  assertEquals(decide(true, false, { autoOn: false, manual: "off" }), null); // mod turned it off
  assertEquals(decide(false, true, { autoOn: true, manual: null }), "off"); // title changed
  assertEquals(decide(false, true, free), null); // turned on by hand / before: leave it
  assertEquals(decide(false, true, { autoOn: true, manual: "on" }), null);
  assertEquals(decide(false, false, { autoOn: true, manual: null }), null);
});

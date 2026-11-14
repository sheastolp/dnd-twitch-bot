import { assertEquals } from "jsr:@std/assert@1";
import { shotCommandFor, typoDistance } from "./shots.ts";

const shot = { one: "shot", many: "shots" };

Deno.test("typoDistance counts one slip as one", () => {
  assertEquals(typoDistance("shoit", "shot"), 1);
  assertEquals(typoDistance("short", "shot"), 1);
  assertEquals(typoDistance("hsot", "shot"), 1); // swapped
  assertEquals(typoDistance("shot", "shot"), 0);
  assertEquals(typoDistance("shout", "shot"), 1);
  assertEquals(typoDistance("shoots", "shot"), 2);
});

Deno.test("shot typos pour one, plural typos show the count", () => {
  for (const t of ["shot", "shoit", "short", "hsot", "sht", "shpt", "sjot"]) assertEquals(shotCommandFor(t, shot), "one", t);
  for (const t of ["shots", "shtos", "shotz", "shost", "shotss", "shott", "shoots"]) assertEquals(shotCommandFor(t, shot), "many", t);
});

Deno.test("not a typo: far off words and GuildScribe's own commands", () => {
  for (const t of ["shop", "so", "roll", "hunt", "sh", "shooter"]) assertEquals(shotCommandFor(t, shot), null, t);
  // Short counted words get no typo help.
  assertEquals(shotCommandFor("sip", { one: "sip", many: "sips" }), "one");
  assertEquals(shotCommandFor("sap", { one: "sip", many: "sips" }), null);
  // Another counted word works the same.
  assertEquals(shotCommandFor("drnik", { one: "drink", many: "drinks" }), "one");
});

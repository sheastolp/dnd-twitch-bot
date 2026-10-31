// Tests for multi-word party names (party_names.ts).
// deno test party_names_test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { normalizePartyName, parseRename, PARTY_NAME_MAX, takePartyName } from "./party_names.ts";

const w = (s: string) => s.split(/\s+/);

Deno.test("normalizes case, spacing and stray characters", () => {
  assertEquals(normalizePartyName("  The   IRON wolves! "), "the iron wolves");
  assertEquals(normalizePartyName("@crew"), "crew");
  assertEquals(normalizePartyName('"night_watch-2"'), "night_watch-2");
  assertEquals(normalizePartyName("x".repeat(50)).length, PARTY_NAME_MAX);
});

Deno.test("takes the longest known party name off the front", () => {
  const known = ["crew", "iron wolves", "iron"];
  assertEquals(takePartyName(w("iron wolves goblin boss"), known), { name: "iron wolves", rest: w("goblin boss") });
  assertEquals(takePartyName(w("iron goblin"), known, "first"), { name: "iron", rest: ["goblin"] });
  assertEquals(takePartyName(w("Crew"), known), { name: "crew", rest: [] });
});

Deno.test("falls back when nothing matches", () => {
  assertEquals(takePartyName(w("lost souls"), ["crew"]), { name: "lost souls", rest: [] });
  assertEquals(takePartyName(w("lost souls"), ["crew"], "first"), { name: "lost", rest: ["souls"] });
  assertEquals(takePartyName([], ["crew"]), { name: "", rest: [] });
});

Deno.test("quoted names are taken as written", () => {
  assertEquals(takePartyName(w('"red hand" adult red dragon'), [], "first"), { name: "red hand", rest: w("adult red dragon") });
  assertEquals(takePartyName(w('"crew" wolves'), ["crew wolves"]), { name: "crew", rest: ["wolves"] });
});

Deno.test("two multi-word parties split for a duel", () => {
  const known = ["iron wolves", "red hand gang"];
  const first = takePartyName(w("iron wolves red hand gang"), known, "first");
  assertEquals(first.name, "iron wolves");
  assertEquals(takePartyName(first.rest, known).name, "red hand gang");
});

Deno.test("rename: old to new", () => {
  assertEquals(parseRename(w("crew to the iron wolves"), ["crew", "other"]), { from: "crew", to: "the iron wolves" });
  assertEquals(parseRename(w("iron wolves -> red hand"), ["iron wolves"]), { from: "iron wolves", to: "red hand" });
  // "to" inside the new name doesn't confuse it
  assertEquals(parseRename(w("crew to back to back"), ["crew", "x"]), { from: "crew", to: "back to back" });
});

Deno.test("rename: old new without a separator", () => {
  assertEquals(parseRename(w("iron wolves red hand"), ["iron wolves", "crew"]), { from: "iron wolves", to: "red hand" });
  assertEquals(parseRename(w("nobody here"), ["iron wolves", "crew"]), null);
});

Deno.test("rename: only the new name when you lead one party", () => {
  assertEquals(parseRename(w("The Iron Wolves"), ["crew"]), { from: "crew", to: "the iron wolves" });
  assertEquals(parseRename(w("anything"), []), null);
  assertEquals(parseRename([], ["crew"]), null);
});

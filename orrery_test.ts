// Tests for orrery.ts: parsing the Grand Orrery's bestiary.md and lore.md,
// and choosing where a fight happens.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  orreryBeasts,
  orreryCreature,
  orreryLoreFor,
  parseBestiary,
  parseLore,
  parseStats,
  placeFor,
  placeForMonster,
  placeText,
  sentencesAbout,
  setOrreryForTest,
} from "./orrery.ts";

const BESTIARY = `# GuildScribe's Bestiary

How to add something:

- \`## Place (tag)\`: a hunting ground.

## GuildScribe's arena (Your idea)

- **Where:** Inside the hall.
- **For:** duels
- **Lines:**
  - The arena sand is raked smooth.
  - The crowd bets in copper.

## The Monster Wood's western edge (Your idea)

- **Where:** Where the wood meets the Kingdom.
- **For:** hunts
- **Levels:** 1-10
- **Lines:**
  - Into the wood from the west.

#### 🐗 Thornback boar (Your idea)

- **Stats:** CR 2 · AC 13 · HP 45 · +5 to hit · 1d10+3
- **Does:** A boar the size of a hay cart.

#### 🦉 Gloamowl (Pitch)

- **Stats:** CR 1/2 · AC 13 · HP 16 · +4 to hit · 1d6+2

## The goblin lands (Your idea)

- **For:** hunts
- **Levels:** 6-14

#### 👺 Goblin raiders (Your idea)

- **In GuildScribe:** Goblin Scavenger, Goblin Boss
- **Does:** Goblins on the run from the Blight.

## A pitched place (Pitch)

- **For:** hunts
- **Levels:** 1-20

#### 🐍 Hidden wyrm (Your idea)

- **Stats:** CR 9 · AC 16 · HP 150 · +10 to hit · 2d10+6

## The deep woods (Your idea)

- **For:** raids
- **Levels:** 13-20
- **Lines:**
  - Something has come out of the deep woods.
`;

Deno.test("parseStats reads a stat line and folds several dice into one", () => {
  assertEquals(parseStats("Boar", "CR 2 · AC 13 · HP 45 · +5 to hit · 1d10+3"), {
    name: "Boar", cr: "2", crValue: 2, ac: 13, hp: 45, attack: 5, die: 10, bonus: 3,
  });
  const half = parseStats("Owl", "CR 1/2 · AC 13 · HP 16 · +4 to hit · 1d6+2")!;
  assertEquals([half.cr, half.crValue], ["1/2", 0.5]);
  // 2d10+6 averages 17; one d20 (avg 10.5) needs +7 (6.5 rounded).
  const wyrm = parseStats("Wyrm", "CR 9 · AC 16 · HP 150 · +10 to hit · 2d10+6")!;
  assertEquals([wyrm.die, wyrm.bonus], [20, 7]);
  assertEquals(parseStats("Nothing", "CR 2 · AC 13"), null);
});

Deno.test("parseBestiary keeps only decided places and creatures", () => {
  const b = parseBestiary(BESTIARY);
  assertEquals(b.places.map((p) => p.name), [
    "GuildScribe's arena",
    "The Monster Wood's western edge",
    "The goblin lands",
    "The deep woods",
  ]);
  const arena = b.places[0];
  assertEquals(arena.uses, ["duels"]);
  assertEquals(arena.lines, ["The arena sand is raked smooth.", "The crowd bets in copper."]);
  assertEquals(b.places[1].levels, [1, 10]);
  // The pitched owl and everything in the pitched place stay out.
  assertEquals(b.creatures.map((c) => c.name), ["Thornback boar", "Goblin raiders"]);
  assertEquals(b.creatures[0].icon, "🐗");
  assertEquals(b.creatures[0].place, "The Monster Wood's western edge");
  assertEquals(b.creatures[1].aliases, ["Goblin Scavenger", "Goblin Boss"]);
  assertEquals(b.creatures[1].stats, null);
});

Deno.test("parseBestiary reads CRLF files the same", () => {
  assertEquals(parseBestiary(BESTIARY.replace(/\n/g, "\r\n")), parseBestiary(BESTIARY));
});

Deno.test("fights are placed by creature, then by level", () => {
  setOrreryForTest(parseBestiary(BESTIARY));
  assertEquals(orreryBeasts().map((m) => m.name), ["Thornback boar"]);
  assertEquals(orreryCreature("goblin boss")?.name, "Goblin raiders");
  // A Verrowen creature fights in its own place, whatever the level.
  assertEquals(placeForMonster("Goblin Scavenger", 1)?.name, "The goblin lands");
  assertEquals(placeForMonster("Thornback boar", 18)?.name, "The Monster Wood's western edge");
  // Anything else goes where its level fits…
  for (let i = 0; i < 20; i++) assertEquals(placeForMonster("Beholder", 3)?.name, "The Monster Wood's western edge");
  for (let i = 0; i < 20; i++) {
    const p = placeForMonster("Beholder", 8)!.name;
    assert(p === "The Monster Wood's western edge" || p === "The goblin lands", p);
  }
  // …or the nearest place when none fits.
  assertEquals(placeForMonster("Beholder", 19)?.name, "The goblin lands");
  assertEquals(placeForMonster("Tarrasque", 20, "raids")?.name, "The deep woods");
  assertEquals(placeFor("duels")?.name, "GuildScribe's arena");
  assertEquals(placeFor("robberies"), null);
  assertEquals(placeText(placeFor("robberies")), "");
  assert(placeText(placeFor("duels")).startsWith("📍 The "));
});

Deno.test("lore for prompts picks the sentences that matter to each speaker", () => {
  const lore = parseLore([
    "# Verrowen lore",
    "WORLD: Verrowen. Common folk just say the world.",
    "TONE: Medieval fantasy with D&D-style monsters.",
    "BEYOND: The Monster Wood lies to the west. GuildScribe is the Kingdom's adventurers' guild hall. Threadbare peddlers take turns at a stall in the capital's market. Murrow hides from everyone.",
  ].join("\n"));
  assertEquals(Object.keys(lore.sections), ["WORLD", "TONE", "BEYOND"]);
  setOrreryForTest({ places: [], creatures: [] }, lore);
  const scribe = orreryLoreFor("scribe");
  assert(scribe.includes("GuildScribe is the Kingdom's adventurers' guild hall."));
  assert(!scribe.includes("peddlers"));
  const peddler = orreryLoreFor("peddler");
  assert(peddler.includes("Threadbare peddlers"));
  assert(!orreryLoreFor("npc").includes("Murrow hides"));
  assertEquals(sentencesAbout("One. Two. Three.", /T/, 6), "Two.");
});

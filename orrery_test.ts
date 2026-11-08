// Tests for orrery.ts: reading the Grand Orrery's database records (the
// bestiary, lore and people) and choosing where a fight happens.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  bestiaryFromEntities,
  loreFromEntities,
  orreryBeasts,
  orreryCreature,
  orreryLoreFor,
  orreryPeddlers,
  orreryPersonLine,
  orreryStatus,
  type OrreryEntity,
  parseStats,
  placeFor,
  placeForMonster,
  placeText,
  rosterFromEntities,
  sentencesAbout,
  setOrreryEntitiesForTest,
  setOrreryForTest,
} from "./orrery.ts";

// bestiary.md's places and creatures as the Orrery's build writes them into
// the database (grand-orrery's tools/build.mjs, parseBestiary).
const BESTIARY: OrreryEntity[] = [
  { id: "place-guildscribes-arena", type: "place", kind: "hunting-ground", name: "GuildScribe's arena", status: "decided", uses: ["duels"], lines: ["The arena sand is raked smooth.", "The crowd bets in copper."], fields: { where: "Inside the hall.", for: "duels", lines: ["The arena sand is raked smooth.", "The crowd bets in copper."] } },
  { id: "place-the-monster-woods-western-edge", type: "place", kind: "hunting-ground", name: "The Monster Wood's western edge", status: "decided", uses: ["hunts"], lines: ["Into the wood from the west."], fields: { where: "Where the wood meets the Kingdom.", for: "hunts", levels: "1-10", lines: ["Into the wood from the west."] } },
  { id: "thornback-boar", type: "creature", name: "Thornback boar", icon: "🐗", place: "place-the-monster-woods-western-edge", status: "decided", fields: { stats: "CR 2 · AC 13 · HP 45 · +5 to hit · 1d10+3", does: "A boar the size of a hay cart." } },
  { id: "gloamowl", type: "creature", name: "Gloamowl", icon: "🦉", place: "place-the-monster-woods-western-edge", status: "pitch", fields: { stats: "CR 1/2 · AC 13 · HP 16 · +4 to hit · 1d6+2" } },
  { id: "place-the-goblin-lands", type: "place", kind: "hunting-ground", name: "The goblin lands", status: "decided", uses: ["hunts"], fields: { for: "hunts", levels: "6-14" } },
  { id: "goblin-raiders", type: "creature", name: "Goblin raiders", icon: "👺", place: "place-the-goblin-lands", status: "decided", fields: { in_guildscribe: "Goblin Scavenger, Goblin Boss", does: "Goblins on the run from the Blight." } },
  { id: "place-a-pitched-place", type: "place", kind: "hunting-ground", name: "A pitched place", status: "pitch", uses: ["hunts"], fields: { for: "hunts", levels: "1-20" } },
  { id: "hidden-wyrm", type: "creature", name: "Hidden wyrm", icon: "🐍", place: "place-a-pitched-place", status: "decided", fields: { stats: "CR 9 · AC 16 · HP 150 · +10 to hit · 2d10+6" } },
  { id: "place-the-deep-woods", type: "place", kind: "hunting-ground", name: "The deep woods", status: "decided", uses: ["raids"], lines: ["Something has come out of the deep woods."], fields: { for: "raids", levels: "13-20", lines: ["Something has come out of the deep woods."] } },
];

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

Deno.test("bestiaryFromEntities keeps only decided places and creatures", () => {
  const b = bestiaryFromEntities(BESTIARY);
  assertEquals(b.places.map((p) => p.name), [
    "GuildScribe's arena",
    "The Monster Wood's western edge",
    "The goblin lands",
    "The deep woods",
  ]);
  const arena = b.places[0];
  assertEquals(arena.uses, ["duels"]);
  assertEquals(arena.where, "Inside the hall.");
  assertEquals(arena.lines, ["The arena sand is raked smooth.", "The crowd bets in copper."]);
  assertEquals(b.places[1].levels, [1, 10]);
  // The pitched owl and everything in the pitched place stay out.
  assertEquals(b.creatures.map((c) => c.name), ["Thornback boar", "Goblin raiders"]);
  assertEquals(b.creatures[0].icon, "🐗");
  assertEquals(b.creatures[0].place, "The Monster Wood's western edge");
  assertEquals(b.creatures[1].aliases, ["Goblin Scavenger", "Goblin Boss"]);
  assertEquals(b.creatures[1].stats, null);
});

Deno.test("fights are placed by creature, then by level", () => {
  setOrreryForTest(bestiaryFromEntities(BESTIARY));
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
  // lore.md's lines as the database holds them: one record each, in order.
  const lore = loreFromEntities([
    { id: "lore-tone", type: "lore", name: "TONE", text: "Medieval fantasy with D&D-style monsters.", order: 2, status: "decided" },
    { id: "lore-world", type: "lore", name: "WORLD", text: "Verrowen. Common folk just say the world.", order: 1, status: "decided" },
    { id: "lore-beyond", type: "lore", name: "BEYOND", text: "The Monster Wood lies to the west. GuildScribe is the Kingdom's adventurers' guild hall. Threadbare peddlers take turns at a stall in the capital's market. Murrow hides from everyone.", order: 3, status: "decided" },
  ]);
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

// What the Orrery's database (entities.public.json) holds for a few people,
// as grand-orrery's tools/build.mjs writes it from roster.md.
const ENTITIES = [
  { id: "burn", type: "person", name: "Burn", race: "Human", sex: "male", age: "about 45", role: "The Wellhouse's regular", line: "Short, mustached, red cap.", world: "verrowen", section: "Stoutwell: the village", place: "stoutwell", status: "decided" },
  { id: "the-scribe", type: "person", name: "The Scribe", race: "Human", sex: "female", age: "old", role: "GuildScribe's senior guildscribe", where: "The capital", line: "Sour, *unimpressed*.", world: "verrowen", section: "The Kingdom: GuildScribe", status: "decided" },
  { id: "bregga-stumpteeth", type: "person", name: "Bregga Stumpteeth", race: "Human", sex: "female", line: "Gap-toothed hawker.", world: "verrowen", section: "The Kingdom: GuildScribe", group: "The capital peddlers", status: "decided" },
  { id: "widow-hesk", type: "person", name: "Widow Hesk", race: "Human", sex: "female", line: "Sells on sympathy.", world: "verrowen", section: "The Kingdom: GuildScribe", group: "The capital peddlers", status: "decided" },
  { id: "wobble", type: "person", name: "Wobble", race: "Halfling", sex: "male", line: "A cart with one bad wheel.", world: "verrowen", section: "The Kingdom: GuildScribe", group: "The road peddlers", status: "decided" },
  { id: "fel", type: "person", name: "Fel", played_by: "felivor", race: "Drow Elf", class: "Fighter", level: 12, kind: "adventurer", world: "verrowen", section: "The Kingdom: GuildScribe's adventurers", status: "decided" },
  { id: "faelan", type: "person", name: "Faelan", race: "Elf", sex: "male", role: "Arandur's father", line: "Distant.", world: "arandurs-world", status: "decided" },
  { id: "role-the-tanner", type: "role", name: "The tanner", status: "open" },
  { id: "verrowen", type: "world", name: "Verrowen", status: "decided" },
  { id: "arandurs-world", type: "world", name: "Arandur's world", status: "decided" },
];

Deno.test("rosterFromEntities reads people and peddlers, never viewers' characters", () => {
  const r = rosterFromEntities(ENTITIES);
  assertEquals(r.peddlers, { capital: ["Bregga Stumpteeth", "Widow Hesk"], road: ["Wobble"] });
  assertEquals(r.people.map((p) => p.name), ["Burn", "The Scribe", "Bregga Stumpteeth", "Widow Hesk", "Wobble", "Faelan"]);
  const burn = r.people[0];
  assertEquals(burn.line, "Short, mustached, red cap.");
  // Race, sex and age as the roster's own column gives them.
  assertEquals(burn.race, "Human, M, about 45");
  assertEquals(r.people[1].group, "The Kingdom: GuildScribe");
  assertEquals(r.people[1].line, "Sour, unimpressed.");
  // Someone with no ### heading is grouped under their world.
  assertEquals(r.people[5].group, "Arandur's world");
});

Deno.test("rosterFromEntities never passes a secret on, even if a record had one", () => {
  const r = rosterFromEntities([{ ...ENTITIES[0], secret: "A runaway court jester." } as never]);
  assert(!JSON.stringify(r).includes("jester"));
});

Deno.test("peddler names and lines come from the database once it's read", () => {
  setOrreryForTest({ places: [], creatures: [] }, { sections: {} }, rosterFromEntities(ENTITIES));
  assertEquals(orreryPeddlers("road"), ["Wobble"]);
  assertEquals(orreryPeddlers("all").length, 3);
  assert(orreryPersonLine("widow hesk").includes("Sells on sympathy."));
  assertEquals(orreryPersonLine("Nobody"), "");
});

Deno.test("the Grand Orrery's real roster.md builds into a roster, if it's checked out next door", async () => {
  let md = "";
  try { md = await Deno.readTextFile(new URL("../grand-orrery/roster.md", import.meta.url)); } catch { return; }
  // The Orrery's own build, so this checks the two ends meet.
  const { parseRoster } = await import(new URL("../grand-orrery/tools/build.mjs", import.meta.url).href);
  const r = rosterFromEntities(parseRoster(md).entities.map(({ secret: _, ...e }: { secret?: string }) => e));
  assert(r.peddlers.capital.length >= 5, `capital peddlers: ${r.peddlers.capital}`);
  assert(r.peddlers.road.length >= 5, `road peddlers: ${r.peddlers.road}`);
  assert(r.people.some((p) => p.name === "The Scribe" && p.line));
  assert(!r.people.some((p) => p.name === "nobody"), "viewers' adventurers stay out");
});

Deno.test("one read of the database gives the bot everything", () => {
  setOrreryEntitiesForTest([
    ...BESTIARY,
    ...ENTITIES,
    { id: "lore-tone", type: "lore", name: "TONE", text: "Medieval fantasy.", order: 1, status: "decided" },
    { id: "empty-wooden-bowl", type: "item", name: "Empty wooden bowl", icon: "🥣", status: "decided", fields: { pitch: "an empty wooden bowl", sold: "1 copper · +1 WIS" } },
  ] as OrreryEntity[]);
  const s = orreryStatus();
  assertEquals([s.places, s.creatures, s.lore, s.peddlers, s.wares, s.relics], [4, 2, 1, 3, 1, 0]);
  assertEquals(orreryPeddlers("road"), ["Wobble"]);
  assertEquals(orreryBeasts().map((m) => m.name), ["Thornback boar"]);
});

Deno.test("the Grand Orrery's real documents build into what the bot needs, if it's checked out next door", async () => {
  let build: { build: () => { entities: OrreryEntity[]; problems: string[] } };
  try { build = await import(new URL("../grand-orrery/tools/build.mjs", import.meta.url).href); } catch { return; }
  // The Orrery's own build, so this checks the two ends meet.
  const { entities, problems } = build.build();
  assertEquals(problems, []);
  const pub = entities.map(({ secret: _, ...e }: OrreryEntity & { secret?: string }) => e);
  const b = bestiaryFromEntities(pub);
  assert(b.places.some((p) => p.uses.includes("duels")), "a place for duels");
  assert(b.places.some((p) => p.uses.includes("hunts") && p.levels), "hunting grounds with levels");
  assert(b.creatures.some((c) => c.stats), "huntable creatures");
  const l = loreFromEntities(pub);
  for (const k of ["WORLD", "TONE", "MAGIC", "BEYOND"]) assert(l.sections[k], `lore ${k}`);
});

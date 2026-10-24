// Tests for the 2024 Wild Shape rules (wildshape_rules.ts).
// deno test --allow-net --allow-env wildshape_test.ts   (downloads the 2024 Monster Manual beasts)

import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Character } from "./types.ts";
import { findBeast, fightForm, formLine, formStats, ineligibleReason, loadBeasts, shapeLimits, turnAttacks } from "./wildshape_rules.ts";

const druid = (level: number, wis = 16): Character => ({
  username: "fern", race: "Elf", subrace: null, cls: "Druid", level, xp: 0,
  scores: { STR: 8, DEX: 14, CON: 14, INT: 12, WIS: wis, CHA: 10 },
  speed: 30, hpMax: 20, hpCurrent: 20, proficiency: level >= 5 ? 3 : 2,
  traits: [], spells: [], items: [], feats: [], abilities: [],
});

Deno.test("limits follow the 2024 Druid table and Beast Shapes", () => {
  assertEquals(shapeLimits(2, null), { uses: 2, known: 4, maxCr: 0.25, fly: false, hours: 1, tempHp: 2, moon: false, slots: 0 });
  const l4 = shapeLimits(4, null);
  assertEquals([l4.maxCr, l4.known, l4.fly], [0.5, 6, false]);
  const l8 = shapeLimits(8, null);
  assertEquals([l8.maxCr, l8.known, l8.fly, l8.uses, l8.hours], [1, 8, true, 3, 4]);
  assertEquals(shapeLimits(17, null).uses, 4);
  assertEquals(shapeLimits(5, null).slots, 9);
});

Deno.test("Circle of the Moon: CR level ÷ 3 (min 1), 3 × level temp HP, from level 3", () => {
  assertEquals(shapeLimits(2, "moon").moon, false);
  assertEquals([shapeLimits(3, "moon").maxCr, shapeLimits(3, "moon").tempHp], [1, 9]);
  assertEquals(shapeLimits(6, "moon").maxCr, 2);
  assertEquals(shapeLimits(18, "moon").maxCr, 6);
  assertEquals(shapeLimits(5, "moon").fly, false); // Circle Forms don't lift the flying limit
});

Deno.test("2024 beasts: eligibility and merged stats", async () => {
  const beasts = await loadBeasts();
  assert(beasts.length > 80);
  const wolf = findBeast(beasts, "wolf").beast!;
  assertEquals(wolf.cr, 0.25);
  assertEquals(ineligibleReason(wolf, shapeLimits(2, null), 2), null);

  const bear = findBeast(beasts, "brown bear").beast!;
  assert(ineligibleReason(bear, shapeLimits(4, null), 4)?.includes("CR 1"));
  assertEquals(ineligibleReason(bear, shapeLimits(3, "moon"), 3), null);
  assert(findBeast(beasts, "bear").options.length >= 3); // ambiguous: asks which

  const hawk = findBeast(beasts, "hawk").beast!;
  assert(ineligibleReason(hawk, shapeLimits(4, null), 4)?.includes("Fly"));
  assertEquals(ineligibleReason(hawk, shapeLimits(8, null), 8), null);

  // Level 2 druid, WIS 16: physical scores are the wolf's, WIS save keeps the druid's proficiency.
  const s = formStats(druid(2), wolf, null);
  assertEquals([s.scores.STR, s.scores.DEX, s.scores.WIS, s.ac, s.tempHp], [14, 15, 16, 12, 2]);
  assertEquals([s.saves.WIS, s.saves.STR], [5, 2]);
  assert(s.actions[0].startsWith("Bite +4 (1d6+2 piercing)"));

  // Moon druid level 6: AC 13 + WIS beats the bear's 11, WIS added to CON saves.
  const m = formStats(druid(6), bear, "moon");
  assertEquals([m.ac, m.tempHp, m.saves.CON], [16, 18, 2 + 3]);
  console.log(formLine(m));
});

Deno.test("fight forms: Multiattack spelled out, rider damage kept", async () => {
  const beasts = await loadBeasts();
  const get = (n: string) => findBeast(beasts, n).beast!;
  assertEquals(turnAttacks(get("brown bear").data).map((a) => a.name), ["Bite", "Claw"]);
  assertEquals(turnAttacks(get("black bear").data).map((a) => a.name), ["Rend", "Rend"]);
  assertEquals(turnAttacks(get("wolf").data), [{ name: "Bite", bonus: 4, dice: 1, die: 6, mod: 2, type: "piercing" }]);
  assertEquals(turnAttacks(get("giant spider").data)[0].plus, { dice: 2, die: 6, type: "poison" });
  assertEquals(turnAttacks(get("cat").data)[0], { name: "Scratch", bonus: 4, dice: 0, die: 0, mod: 1, type: "slashing" });
  const f = fightForm(druid(3), get("brown bear"), "moon");
  assertEquals([f.ac, f.tempHp, f.moon, f.dex], [16, 9, true, 12]);
});

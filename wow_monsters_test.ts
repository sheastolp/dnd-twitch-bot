// Tests for the Azeroth bestiary (wow_monsters.ts) and how hunts use it
// (bestiary.ts), against a throwaway database.
// deno test -A wow_monsters_test.ts

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const dir = Deno.makeTempDirSync();
Deno.env.set("DB_PATH", `${dir.replaceAll("\\", "/")}/test.sqlite`);
Deno.env.set("ORRERY", "off");
Deno.env.set("ORRERY_NO_TIMER", "1");

const { AZEROTH_MONSTERS, azerothInfo, azerothReply, azerothStatBlock } = await import("./wow_monsters.ts");
const { SOLO_MONSTERS, findMonsterByName, randomEncounterMinLevel } = await import("./data.ts");
const { ensureTables } = await import("./db_schema.ts");
const { ensureBestiaryTables, getChannelRoster, summonMonster } = await import("./bestiary.ts");
const { setCommandGroupEnabled } = await import("./db.ts");
await ensureTables();
await ensureBestiaryTables();

Deno.test("every Azeroth foe has a sane, unique stat block", () => {
  const core = new Set(SOLO_MONSTERS.map((m) => m.name.toLowerCase()));
  const seen = new Set<string>();
  for (const m of AZEROTH_MONSTERS) {
    assert(!core.has(m.name.toLowerCase()), `${m.name} shadows a core monster`);
    assert(!seen.has(m.name.toLowerCase()), `${m.name} twice`);
    seen.add(m.name.toLowerCase());
    assert(m.hp >= 6 && m.ac >= 10 && m.ac <= 20 && m.die <= 12 && m.attack > 0, m.name);
    assert(azerothInfo(m.name), m.name);
  }
  assert(AZEROTH_MONSTERS.length >= 80);
});

Deno.test("WoW level sets the CR; bosses sit above their level's wildlife", () => {
  assertEquals(azerothStatBlock("x", 2, "beast", false).cr, "1/4");
  assertEquals(azerothStatBlock("x", 60, "humanoid", false).cr, "5");
  assertEquals(azerothStatBlock("x", 60, "humanoid", true).cr, "8");
  const vc = AZEROTH_MONSTERS.find((m) => m.name === "Edwin VanCleef")!;
  const defias = AZEROTH_MONSTERS.find((m) => m.name === "Defias Pillager")!;
  assert(vc.crValue > defias.crValue);
  // Level-60 wildlife turns up at random for high heroes; low critters at once.
  assertEquals(randomEncounterMinLevel(AZEROTH_MONSTERS.find((m) => m.name === "Young Wolf")!.crValue), 1);
  assert(randomEncounterMinLevel(AZEROTH_MONSTERS.find((m) => m.name === "Twilight Geolord")!.crValue)! >= 15);
});

Deno.test("the channel roster has Azeroth by default; the switch takes it out", async () => {
  const on = await getChannelRoster("2001");
  assert(on.some((m) => m.azeroth && m.name === "Hogger"));
  assertEquals(findMonsterByName("hogger", on)?.name, "Hogger");
  assertEquals(findMonsterByName("vancleef", on)?.name, "Edwin VanCleef");
  await setCommandGroupEnabled("2002", "wowmonsters", false);
  const off = await getChannelRoster("2002");
  assert(!off.some((m) => m.azeroth));
  assertEquals(off.length + AZEROTH_MONSTERS.length, on.length);
});

Deno.test("a WoW hero's random hunt is mostly Azeroth; a named one opens in its zone", async () => {
  let wow = 0;
  for (let i = 0; i < 200; i++) {
    const m = (await summonMonster("2001", 6, null, { azeroth: true }))!;
    if (azerothInfo(m.name)) wow++;
  }
  assert(wow > 110 && wow < 170, `${wow}/200 from Azeroth`); // 70% expected
  let plain = 0;
  for (let i = 0; i < 200; i++) if (azerothInfo((await summonMonster("2001", 6))!.name)) plain++;
  assert(plain > 2 && plain < 45, `${plain}/200 from Azeroth for a 5e hero`); // 10% expected
  const hogger = (await summonMonster("2001", 3, "hogger"))!;
  assertEquals(hogger.name, "Hogger");
  assertMatch(hogger.place?.line ?? "", /Elwynn Forest — WoW level 11 rare elite/);
  const vc = (await summonMonster("2001", 5, "edwin vancleef"))!;
  assertMatch(vc.place?.line ?? "", /Deep in the Deadmines — WoW level 21 boss/);
});

Deno.test("!azeroth lists zones, dungeons and Forever's dungeons", () => {
  assertMatch(azerothReply(""), /Azeroth bestiary: \d+ WoW Classic \+ Forever foes/);
  assertMatch(azerothReply("dungeons"), /Deadmines/);
  assertMatch(azerothReply("forever"), /Hall of Thanes.*Shaper's Terrace/);
  assertMatch(azerothReply("deadmines"), /Rhahk'Zor.*Mr\. Smite.*Edwin VanCleef.*!hunt edwin vancleef/);
  assertMatch(azerothReply("alcaz"), /Alcaz Prison \(WoW: Forever\): Overseer Wrex/);
  assertMatch(azerothReply("narnia"), /no zone or dungeon/);
});

// Tests for WoW loot (wow_loot.ts): drop tables by source, item names, the
// vendored gray junk and who gets the drop.
// deno test -A wow_loot_test.ts

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const dir = Deno.makeTempDirSync();
Deno.env.set("DB_PATH", `${dir.replaceAll("\\", "/")}/test.sqlite`);
Deno.env.set("ORRERY", "off");
Deno.env.set("ORRERY_NO_TIMER", "1");

const { rollWowDrop, lootSource, dropText, wowLootNote, wowGroupLootNote } = await import("./wow_loot.ts");
const { ensureTables } = await import("./db_schema.ts");
const { saveCharacter } = await import("./db.ts");
const { buildWowCharacter } = await import("./wow_chars.ts");
const { generateCharacter } = await import("./characters.ts");
await ensureTables();

const seq = (...xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]; };

Deno.test("what fell decides the table", () => {
  assertEquals(lootSource("Young Wolf"), "normal");
  assertEquals(lootSource("Edwin VanCleef"), "boss");
  assertEquals(lootSource("Hogger"), "boss");
  assertEquals(lootSource("Onyxia"), "raid");
  assertEquals(lootSource("Lord Kazzak"), "raid");
  assertEquals(lootSource("Goblin", 0.25), "normal");
  assertEquals(lootSource("Adult Red Dragon", 17), "raid");
});

Deno.test("drops: qualities and names", () => {
  const poor = rollWowDrop("Young Wolf", "1/4", 0, seq(0, 0));
  assertEquals(poor.quality, "Poor");
  assert(poor.vendorCopper >= 1);
  const green = rollWowDrop("Young Wolf", "1/4", 0, seq(0.9, 0, 0));
  assertEquals(green.quality, "Uncommon");
  assertMatch(green.item, / of the /);
  const epic = rollWowDrop("Onyxia", "13", 0, seq(0.5, 0));
  assertEquals(epic.quality, "Epic");
  assertMatch(epic.item, /^Onyxia's /);
  const sulfuras = rollWowDrop("Ragnaros", "15", 0, seq(0.999));
  assertEquals(sulfuras.quality, "Legendary");
  assertEquals(sulfuras.item, "Sulfuras, Hand of Ragnaros");
  assertMatch(dropText(sulfuras), /🟠 \[Sulfuras, Hand of Ragnaros\] — LEGENDARY!/);
  assertMatch(dropText(epic), /🟣 \[Onyxia's .+\] \(Epic\)/);
  // Raids never drop junk; wildlife never drops epics.
  for (let i = 0; i < 300; i++) {
    assert(!["Poor", "Common"].includes(rollWowDrop("Nefarian", "16").quality));
    assert(!["Epic", "Legendary"].includes(rollWowDrop("Kobold Vermin", "1/4").quality));
  }
});

Deno.test("only WoW heroes get a drop; a group's goes by Need roll", async () => {
  const CH = "4001";
  await saveCharacter(buildWowCharacter("thrall", { faction: "Horde", race: "Orc", cls: "Shaman" }, [16, 15, 14, 12, 10, 8]), CH);
  await saveCharacter(buildWowCharacter("jaina", { faction: "Alliance", race: "Human", cls: "Mage" }, [16, 15, 14, 12, 10, 8]), CH);
  await saveCharacter(generateCharacter("bob"), CH);
  assertMatch(await wowLootNote(CH, "thrall", "Hogger", "2"), /^ 🎁 Loot: (🟢|🔵|🟣) \[/);
  assertEquals(await wowLootNote(CH, "bob", "Hogger", "2"), "");
  assertEquals(await wowGroupLootNote(CH, ["bob"], "Onyxia", "13"), "");
  const solo = await wowGroupLootNote(CH, ["bob", "thrall"], "Onyxia", "13", 0, 2);
  assertMatch(solo, /— thrall.*; .*— thrall/);
  const both = await wowGroupLootNote(CH, ["thrall", "jaina", "bob"], "Onyxia", "13");
  assertMatch(both, /— (thrall|jaina) wins the Need roll \(\d+\)/);
});

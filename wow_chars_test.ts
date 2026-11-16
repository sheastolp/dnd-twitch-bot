// Tests for WoW characters (wow_data.ts, wow_chars.ts): the Classic + Forever
// race/class table, !wowchar parsing, the saved character, and the chat flow
// against a throwaway database with Twitch stubbed out.
// deno test -A wow_chars_test.ts

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const dir = Deno.makeTempDirSync();
Deno.env.set("DB_PATH", `${dir.replaceAll("\\", "/")}/test.sqlite`);
Deno.env.set("ORRERY", "off");
Deno.env.set("ORRERY_NO_TIMER", "1");
for (const k of ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_BOT_ID"]) Deno.env.set(k, "test");

// Twitch: every chat message the bot sends lands in `sent`.
const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/helix/chat/messages")) {
    sent.push(JSON.parse(String(init?.body ?? "{}")).message ?? "");
    return Response.json({ data: [{ message_id: "m", is_sent: true }] });
  }
  if (url.includes("oauth2/token")) return Response.json({ access_token: "t", expires_in: 3600, token_type: "bearer" });
  return Response.json({ data: [] });
}) as typeof fetch;

const { WOW_RACES, WOW_CLASSES, racesFor } = await import("./wow_data.ts");
const { parseWowPicks, buildWowCharacter, handleWowCharCommand } = await import("./wow_chars.ts");
const { ensureTables } = await import("./db_schema.ts");
const { getCharacter, backupCharacter, loadBackup, saveCharacter } = await import("./db.ts");
const { classes } = await import("./data.ts");
const { heroTitle } = await import("./utils.ts");
await ensureTables();

const CH = "1001";
const say = async (user: string, msg: string) => {
  sent.length = 0;
  const handled = await handleWowCharCommand(user, user, CH, msg, "https://gs.test");
  return { handled, reply: sent.join(" | ") };
};

Deno.test("Classic + Forever: 28 race/class pairs a faction, every class maps to a 5e class", () => {
  for (const f of ["Alliance", "Horde"] as const) {
    assertEquals(racesFor(f).reduce((n, r) => n + r.classes.length, 0), 28, f);
  }
  for (const [name, c] of Object.entries(WOW_CLASSES)) assert(classes[c.dnd], `${name} → ${c.dnd}`);
  // Forever's six new pairings.
  const has = (race: string, cls: string) => WOW_RACES.some((r) => r.name === race && r.classes.includes(cls as never));
  for (const [r, c] of [["Human", "Hunter"], ["Dwarf", "Shaman"], ["Gnome", "Priest"], ["Orc", "Mage"], ["Undead", "Paladin"], ["Troll", "Warlock"]]) {
    assert(has(r, c), `${r} ${c}`);
  }
  // Classic limits still hold.
  assert(!has("Tauren", "Rogue"));
  assert(!has("Orc", "Paladin"));
  assert(!has("Human", "Shaman"));
  // Skyborne: Mage only for the Alliance, Shaman only for the Horde.
  const sky = (f: string) => WOW_RACES.find((r) => r.name === "Skyborne" && r.faction === f)!;
  assert(sky("Alliance").classes.includes("Mage") && !sky("Alliance").classes.includes("Shaman"));
  assert(sky("Horde").classes.includes("Shaman") && !sky("Horde").classes.includes("Mage"));
});

Deno.test("parses faction, race and class in any order", () => {
  assertEquals(parseWowPicks("horde tauren druid"), { faction: "Horde", race: "Tauren", cls: "Druid", unknown: [] });
  assertEquals(parseWowPicks("night elf hunter"), { faction: null, race: "Night Elf", cls: "Hunter", unknown: [] });
  assertEquals(parseWowPicks("pally forsaken"), { faction: null, race: "Undead", cls: "Paladin", unknown: [] });
  assertEquals(parseWowPicks("windshaper skyborne shaman").faction, "Horde");
  assertEquals(parseWowPicks("ally gnome lock"), { faction: "Alliance", race: "Gnome", cls: "Warlock", unknown: [] });
  assertEquals(parseWowPicks("banana").unknown, ["banana"]);
});

Deno.test("a WoW character fights with its 5e class and shows its WoW one", () => {
  const c = buildWowCharacter("thrall", { faction: "Horde", race: "Orc", cls: "Shaman" }, [16, 15, 14, 12, 10, 8]);
  assertEquals(c.cls, "Cleric");
  assertEquals(c.race, "Orc");
  assertEquals(c.wow, { faction: "Horde", cls: "Shaman" });
  assertEquals(heroTitle(c), "Orc Shaman");
  assert(c.traits.includes("Savage Attacks"));
  assertEquals(c.scores.WIS, 16); // the Cleric's best score
  assertEquals(c.scores.STR, 15 + 2); // Orc +2 STR on the second best
  const sky = buildWowCharacter("zeph", { faction: "Alliance", race: "Skyborne", cls: "Mage" }, [15, 14, 13, 12, 10, 8]);
  assertEquals(heroTitle(sky), "High Order Skyborne Mage");
  assertEquals(sky.cls, "Wizard");
});

Deno.test("the WoW identity survives save, load, backup and restore", async () => {
  const c = buildWowCharacter("jaina", { faction: "Alliance", race: "Human", cls: "Mage" }, [15, 14, 13, 12, 10, 8]);
  await saveCharacter(c, CH);
  const got = await getCharacter("jaina", CH);
  assertEquals(got?.wow, { faction: "Alliance", cls: "Mage" });
  assertEquals(got?.cls, "Wizard");
  await backupCharacter("jaina", CH);
  await saveCharacter({ ...got!, wow: null, race: "Elf", cls: "Rogue" }, CH);
  assertEquals((await getCharacter("jaina", CH))?.wow, null);
  const back = await loadBackup("jaina", CH);
  assertEquals(back?.wow, { faction: "Alliance", cls: "Mage" });
});

Deno.test("!wowchar in one go, then confirm and save", async () => {
  let r = await say("cairne", "!wowchar horde tauren warrior");
  assert(r.handled);
  assertMatch(r.reply, /Level 1 🐺 Horde Tauren Warrior/);
  assertMatch(r.reply, /5e Fighter/);
  assertMatch(r.reply, /^@cairne ⚠️ NOT SAVED YET — type !answer yes to keep this hero, !answer reroll for new scores, or !answer no\./);
  r = await say("cairne", "!answer reroll");
  assertMatch(r.reply, /Tauren Warrior/); // picked by hand: only the scores change
  r = await say("cairne", "!answer yes");
  assertMatch(r.reply, /Lok'tar ogar!.*Tauren Warrior/);
  const c = await getCharacter("cairne", CH);
  assertEquals(c?.wow, { faction: "Horde", cls: "Warrior" });
  assertEquals(c?.cls, "Fighter");
});

Deno.test("!wowchar step by step, with a wrong pick on the way", async () => {
  let r = await say("tyr", "!wowchar");
  assertMatch(r.reply, /Alliance or for the Horde/);
  r = await say("tyr", "!answer alliance");
  assertMatch(r.reply, /Pick a race: Human, Dwarf, Night Elf, Gnome, Skyborne\*/);
  r = await say("tyr", "!answer orc");
  assertMatch(r.reply, /fights for the Horde\. Pick an Alliance race/);
  r = await say("tyr", "!answer dwarf");
  assertMatch(r.reply, /Shaman\*/);
  r = await say("tyr", "!answer druid");
  assertMatch(r.reply, /Pick a class/);
  r = await say("tyr", "!answer paladin");
  assertMatch(r.reply, /Alliance Dwarf Paladin/);
  r = await say("tyr", "!answer no");
  assertMatch(r.reply, /discarded/);
  assertEquals(await getCharacter("tyr", CH), null);
});

Deno.test("a race decides the faction when only one fits; impossible pairs are caught", async () => {
  let r = await say("baine", "!wowchar tauren druid");
  assertMatch(r.reply, /Horde Tauren Druid/);
  r = await say("val", "!wowchar tauren rogue");
  assertMatch(r.reply, /can't be a Rogue/);
  r = await say("sky", "!wowchar skyborne druid");
  assertMatch(r.reply, /Alliance or for the Horde\? \(Skyborne can be either\)/);
  r = await say("sky", "!answer horde");
  assertMatch(r.reply, /Windshaper Skyborne Druid/);
  // Random saves at once, like !createchar…
  r = await say("rnd", "!wowchar random");
  assertMatch(r.reply, /(For the Alliance!|Lok'tar ogar!) Rolled and saved your level 1 /);
  const rnd = await getCharacter("rnd", CH);
  assert(rnd?.wow, "saved as a WoW hero");
  // …but asks before replacing a hero.
  r = await say("rnd", "!wowchar random");
  assertMatch(r.reply, /^@rnd ⚠️ NOT SAVED YET — type !answer yes to keep this hero \(replaces your Level 1 .+\), !answer reroll for a whole new hero, or !answer no\./);
  // A random hero rerolls whole: race and class can change, not just scores.
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    r = await say("rnd", "!answer reroll");
    const m = r.reply.match(/Level 1 (?:🦁 Alliance|🐺 Horde) (.+?) \(fights as/);
    assert(m, r.reply);
    seen.add(m[1]);
  }
  assert(seen.size > 1, `reroll changed the hero: ${[...seen].join(" / ")}`);
  r = await say("rnd", "!answer no");
  assertEquals((await getCharacter("rnd", CH))?.race, rnd!.race);
  r = await say("x", "!wowchar classes");
  assertMatch(r.reply, /Alliance: Human/);
  r = await say("x", "!answer yes");
  assertEquals(r.handled, false); // no WoW session: not ours
});

Deno.test("WoW heroes get a real combat kit, racials included", async () => {
  const { makeKit } = await import("./combat_abilities.ts");
  const tauren = makeKit(buildWowCharacter("t", { faction: "Horde", race: "Tauren", cls: "Warrior" }, [16, 15, 14, 12, 10, 8]));
  assertEquals(tauren.cls, "fighter");
  assert(tauren.relentless, "Endurance → Relentless Endurance");
  const gnome = makeKit(buildWowCharacter("g", { faction: "Alliance", race: "Gnome", cls: "Mage" }, [16, 15, 14, 12, 10, 8]));
  assertEquals(gnome.cls, "wizard");
  assert(gnome.lucky, "Escape Artist → Lucky");
});

// Tests for faction wars (wow_factionwar.ts): who can join which side, the
// battle, the muster's timed resolve and the cooldown — against a throwaway
// database with Twitch stubbed out.
// deno test -A wow_factionwar_test.ts

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const dir = Deno.makeTempDirSync();
Deno.env.set("DB_PATH", `${dir.replaceAll("\\", "/")}/test.sqlite`);
Deno.env.set("ORRERY", "off");
Deno.env.set("ORRERY_NO_TIMER", "1");
for (const k of ["TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_BOT_ID"]) Deno.env.set(k, "test");

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

const { ensureTables } = await import("./db_schema.ts");
const { saveCharacter } = await import("./db.ts");
const { sqlite } = await import("./sqlite.ts");
const { buildWowCharacter } = await import("./wow_chars.ts");
const { generateCharacter } = await import("./characters.ts");
const war = await import("./wow_factionwar.ts");
await ensureTables();
await war.ensureFactionWarTables();

const CH = "3001";
const SIX = [16, 15, 14, 12, 10, 8];
await saveCharacter(buildWowCharacter("varian", { faction: "Alliance", race: "Human", cls: "Warrior" }, SIX), CH);
await saveCharacter(buildWowCharacter("tyrande", { faction: "Alliance", race: "Night Elf", cls: "Priest" }, SIX), CH);
await saveCharacter(buildWowCharacter("garrosh", { faction: "Horde", race: "Orc", cls: "Warrior" }, SIX), CH);
await saveCharacter(buildWowCharacter("sylvanas", { faction: "Horde", race: "Undead", cls: "Rogue" }, SIX), CH);
await saveCharacter(generateCharacter("bob"), CH);

const say = async (user: string, msg: string, mod = false) => {
  sent.length = 0;
  const handled = await war.handleFactionWarCommand(msg, user, user, CH, mod);
  return { handled, reply: sent.join(" | ") };
};

Deno.test("the battle: one side is left standing, everyone starts at full HP", async () => {
  const { getCharacter } = await import("./db.ts");
  const sides = {
    Alliance: [{ name: "varian", c: (await getCharacter("varian", CH))! }, { name: "tyrande", c: (await getCharacter("tyrande", CH))! }],
    Horde: [{ name: "garrosh", c: (await getCharacter("garrosh", CH))! }],
  };
  let alliance = 0;
  for (let i = 0; i < 40; i++) {
    const f = war.fightFactionWar(sides);
    assert(f.rounds >= 1 && f.rounds <= 20);
    if (f.winner === "Alliance") alliance++;
    if (!f.capped) {
      const loserNames = (f.winner === "Alliance" ? sides.Horde : sides.Alliance).map((s) => s.name);
      for (const n of loserNames) assertEquals(f.hp[n][0], 0, n);
    }
  }
  assert(alliance > 20, `two beat one most of the time (${alliance}/40)`);
});

Deno.test("muster: sides, sellswords and the faction rule", async () => {
  let r = await say("bob", "!factionwar");
  assertMatch(r.reply, /sellsword picks a side/);
  r = await say("nobody", "!factionwar");
  assertMatch(r.reply, /need a hero/);
  r = await say("varian", "!factionwar");
  assertMatch(r.reply, /WAR! 🦁 @varian sounds the call for the Alliance/);
  assertEquals((await war.getFactionWar(CH))!.alliance.map((m) => m.u), ["varian"]);
  r = await say("garrosh", "!factionwar alliance");
  assertMatch(r.reply, /a Horde hero won't fight for the Alliance/);
  r = await say("garrosh", "!factionwar join");
  assertMatch(r.reply, /Lok'tar ogar! you march with the Horde/);
  r = await say("bob", "!factionwar join");
  assertMatch(r.reply, /pick a side/);
  r = await say("bob", "!factionwar horde");
  assertMatch(r.reply, /Horde as a sellsword/);
  r = await say("bob", "!factionwar alliance");
  assertMatch(r.reply, /already marching with the Horde/);
  r = await say("tyrande", "!factionwar");
  assertMatch(r.reply, /you march with the Alliance/);
  r = await say("tyrande", "!factionwar go");
  assertMatch(r.reply, /only whoever sounded the call/);
  r = await say("x", "!factionwar status");
  assertMatch(r.reply, /Alliance 2: varian, tyrande \| 🐺 Horde 2: garrosh, bob \(sellsword\)/);
});

Deno.test("the war is fought once its time is up, then the armies regroup", async () => {
  const w = (await war.getFactionWar(CH))!;
  assert(!(await war.maybeResolveFactionWar(CH, { now: w.ends_at - 1000 })), "not before its time");
  assertEquals(await war.getExpiredFactionWars(w.ends_at + 1), [CH]);
  sent.length = 0;
  assert(await war.maybeResolveFactionWar(CH, { now: w.ends_at + 1 }));
  assert(!(await war.maybeResolveFactionWar(CH, { now: w.ends_at + 2 })), "only once");
  const msg = sent.join(" ");
  assertMatch(msg, /Faction war at .*varian, tyrande vs 🐺 garrosh, bob/);
  assertMatch(msg, /the (Alliance|Horde) (wins|holds the field)/i);
  // Nothing is kept: no battle-log row.
  const log = await sqlite.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'battle_log'");
  if (Number(log.rows[0]?.n)) {
    assertEquals(Number((await sqlite.execute("SELECT COUNT(*) AS n FROM battle_log WHERE broadcaster_id = ?", [CH])).rows[0]?.n), 0);
  }
  const r = await say("sylvanas", "!factionwar");
  assertMatch(r.reply, /still regrouping/);
});

Deno.test("an unopposed side holds the field; a mod can call it off", async () => {
  await sqlite.execute("UPDATE faction_wars SET last_war_at = 0 WHERE broadcaster_id = ?", [CH]);
  let r = await say("sylvanas", "!factionwar");
  assertMatch(r.reply, /WAR! 🐺 @sylvanas sounds the call for the Horde/);
  r = await say("sylvanas", "!factionwar go");
  assertMatch(r.reply, /both sides need at least one hero/);
  const w = (await war.getFactionWar(CH))!;
  sent.length = 0;
  await war.maybeResolveFactionWar(CH, { now: w.ends_at + 1 });
  assertMatch(sent.join(" "), /No one answered for the Alliance — the Horde \(sylvanas\) holds/);
  await sqlite.execute("UPDATE faction_wars SET last_war_at = 0 WHERE broadcaster_id = ?", [CH]);
  await say("varian", "!factionwar");
  r = await say("varian", "!factionwar cancel");
  assertMatch(r.reply, /only a mod/);
  r = await say("mod", "!factionwar cancel", true);
  assertMatch(r.reply, /called off/);
  assertEquals((await war.getFactionWar(CH))!.ends_at, 0);
});

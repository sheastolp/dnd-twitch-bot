// GuildScribe — faction wars: the Alliance and the Horde meet on a Classic
// battlefield, and chat's heroes pick a side.
//
//   !factionwar                   sound the call to war (opens a muster), or show the open one
//   !factionwar join [side]       join: a WoW hero (!wowchar) fights for their own
//   !factionwar alliance | horde  faction; a D&D hero picks a side as a sellsword
//   !factionwar go                fight now (whoever sounded it, or a mod)
//   !factionwar status            who's mustered, and the time left
//   !factionwar cancel            mod: call it off
//
// Each war is a one-off battle: nothing is kept afterwards — no scores, no
// leaderboard, no battle-log entry (so it stays off the overlays), no XP and
// no wounds (everyone fights at full HP on copies of their HP, like a party
// duel). A muster runs FACTIONWAR_MUSTER_SECONDS (default 120) and, like a
// raid muster, has no timer of its own: the next chat message after its time
// is up fights it (maybeResolveFactionWar from main.ts), with the autohunt
// cron as a fallback. The fight is claimed atomically, so it happens once.
// After a war the channel waits FACTIONWAR_COOLDOWN_SECONDS (default 600)
// before the next call to arms. Behind the dashboard switch `wowfactionwar`.
//
// The battle: each side rolls initiative once (d20 + its quickest DEX); every
// round each standing hero, side by side in that order, strikes a random
// standing foe (combat_abilities.ts heroTurn — the same kits as any duel, with
// healers healing their own side). The last side standing wins; at the round
// cap, the side with more of its HP left.

import { sqlite } from "./sqlite.ts";
import { getCharacter, recordMonitorEvent } from "./db.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import { BattleLog, fighterLine } from "./battle.ts";
import { heroFighter, heroTurn, team, type Fighter } from "./combat_abilities.ts";
import { initiativeMod, pick } from "./utils.ts";
import { hpLeft } from "./whisper.ts";
import { recordDuelNaturals, strikeD20s } from "./combat_shared.ts";
import { FACTION_ICON, findWowFaction, type WowFaction } from "./wow_data.ts";

const envSeconds = (name: string, fallback: number, min: number, max: number) => {
  const n = Number(Deno.env.get(name));
  return Number.isFinite(n) && Deno.env.get(name) ? Math.max(min, Math.min(max, n)) : fallback;
};
export const FACTIONWAR_MUSTER_SECONDS = envSeconds("FACTIONWAR_MUSTER_SECONDS", 120, 15, 900);
export const FACTIONWAR_COOLDOWN_SECONDS = envSeconds("FACTIONWAR_COOLDOWN_SECONDS", 600, 0, 7200);
/** Most heroes a side can muster. */
export const FACTIONWAR_SIDE_MAX = 10;
const MAX_ROUNDS = 20;

/** Classic battlefields: [name, what's fought over]. */
export const BATTLEFIELDS: Array<[string, string]> = [
  ["Warsong Gulch", "the Silverwing Sentinels and the Warsong Outriders fight over the flags"],
  ["Arathi Basin", "the League of Arathor and the Defilers race for the farm, the mill and the stables"],
  ["Alterac Valley", "the Stormpike Guard and the Frostwolf Clan clash in the snow"],
  ["Tarren Mill", "Southshore's defenders and Tarren Mill's raiders brawl on the road between"],
  ["the Crossroads", "Alliance raiders hit the Horde's crossroads in the Barrens"],
  ["Ashenvale", "Sentinels and Warsong loggers fight for the forest"],
  ["the Gurubashi Arena", "both factions scrap for the arena chest in Stranglethorn"],
  ["Silithus", "both factions fight for the Silithyst in the sand"],
];

export type WarMember = { u: string; d: string; merc?: boolean };
export type FactionWar = {
  broadcaster_id: string;
  place: string;
  started_by: string;
  ends_at: number;
  alliance: WarMember[];
  horde: WarMember[];
  last_war_at: number;
};

export async function ensureFactionWarTables() {
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS faction_wars (
    broadcaster_id TEXT PRIMARY KEY,
    place TEXT DEFAULT '',
    started_by TEXT DEFAULT '',
    ends_at INTEGER DEFAULT 0,
    alliance TEXT DEFAULT '[]',
    horde TEXT DEFAULT '[]',
    last_war_at INTEGER DEFAULT 0
  )`);
}

export async function purgeFactionWarData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM faction_wars WHERE broadcaster_id = ?", [broadcasterId]);
}

const parse = (raw: unknown): WarMember[] => {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export async function getFactionWar(broadcasterId: string): Promise<FactionWar | null> {
  const res = await sqlite.execute("SELECT * FROM faction_wars WHERE broadcaster_id = ?", [broadcasterId]);
  const r: any = res.rows[0];
  if (!r) return null;
  return {
    broadcaster_id: broadcasterId,
    place: String(r.place ?? ""),
    started_by: String(r.started_by ?? ""),
    ends_at: Number(r.ends_at ?? 0),
    alliance: parse(r.alliance),
    horde: parse(r.horde),
    last_war_at: Number(r.last_war_at ?? 0),
  };
}

async function saveSides(w: FactionWar) {
  await sqlite.execute(
    "UPDATE faction_wars SET alliance = ?, horde = ? WHERE broadcaster_id = ? AND ends_at = ?",
    [JSON.stringify(w.alliance), JSON.stringify(w.horde), w.broadcaster_id, w.ends_at],
  );
}

const sideOf = (w: FactionWar, f: WowFaction) => (f === "Alliance" ? w.alliance : w.horde);
const other = (f: WowFaction): WowFaction => (f === "Alliance" ? "Horde" : "Alliance");
const secs = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
const roll = (w: WarMember[]) => w.map((m) => `${m.d}${m.merc ? " (sellsword)" : ""}`).join(", ") || "nobody yet";

function musterLine(w: FactionWar, now: number): string {
  return `${FACTION_ICON.Alliance} Alliance ${w.alliance.length}: ${roll(w.alliance)} | ${FACTION_ICON.Horde} Horde ${w.horde.length}: ${roll(w.horde)} — ` +
    `${secs(w.ends_at - now)}s to muster at ${w.place}.`;
}

/** Adds the viewer to a side. A reply for chat. */
async function join(w: FactionWar, user: string, display: string, wanted: WowFaction | null, broadcasterId: string): Promise<string> {
  const c = await getCharacter(user, broadcasterId);
  if (!c) return "you need a hero first: !wowchar for a WoW one, or !createchar — then !factionwar join.";
  if (w.alliance.some((m) => m.u === user) || w.horde.some((m) => m.u === user)) {
    const mine: WowFaction = w.alliance.some((m) => m.u === user) ? "Alliance" : "Horde";
    return `you're already marching with the ${mine}. ${musterLine(w, Date.now())}`;
  }
  let side: WowFaction;
  let merc = false;
  if (c.wow) {
    if (wanted && wanted !== c.wow.faction) {
      return `a ${c.wow.faction} hero won't fight for the ${wanted}. !factionwar join puts you with the ${c.wow.faction}.`;
    }
    side = c.wow.faction;
  } else {
    if (!wanted) return "D&D heroes fight as sellswords: pick a side — !factionwar alliance or !factionwar horde.";
    side = wanted;
    merc = true;
  }
  const list = sideOf(w, side);
  if (list.length >= FACTIONWAR_SIDE_MAX) return `the ${side} is at full strength (${FACTIONWAR_SIDE_MAX}).`;
  list.push({ u: user, d: display, ...(merc ? { merc: true } : {}) });
  await saveSides(w);
  const cry = side === "Horde" ? "Lok'tar ogar!" : "For the Alliance!";
  return `${FACTION_ICON[side]} ${cry} you march with the ${side}${merc ? " as a sellsword" : ""}. ${musterLine(w, Date.now())}`;
}

export async function handleFactionWarCommand(
  chatMessage: string,
  user: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const m = chatMessage.match(/^!factionwar(?:\s+(.*))?$/i);
  if (!m) return false;
  const say = (t: string) => sendChatMessage(`@${display} ${t}`, broadcasterId);
  const words = (m[1] ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sub = words[0] ?? "";
  const now = Date.now();
  await ensureFactionWarTables();
  // A muster whose time is up fights before anything else looks at it.
  await maybeResolveFactionWar(broadcasterId, { now });
  let w = await getFactionWar(broadcasterId);
  const open = !!w && w.ends_at > 0;

  if (sub === "help") {
    await say(
      "Faction war: !factionwar sounds the call, !factionwar join (WoW heroes fight for their faction; D&D heroes pick !factionwar alliance or horde as sellswords), " +
        `!factionwar go to fight early, !factionwar status. One battle, nothing kept but the glory. Muster ${FACTIONWAR_MUSTER_SECONDS}s.`,
    );
    return true;
  }
  if (sub === "status") {
    if (open) await say(musterLine(w!, now));
    else {
      const wait = w ? w.last_war_at + FACTIONWAR_COOLDOWN_SECONDS * 1000 - now : 0;
      await say(`no war mustering.${wait > 0 ? ` The armies regroup for ${secs(wait)}s more.` : " !factionwar sounds the call."}`);
    }
    return true;
  }
  if (sub === "cancel" || sub === "end") {
    if (!isModerator) return say("only a mod can call off a war.").then(() => true);
    if (!open) return say("no war is mustering.").then(() => true);
    await sqlite.execute("UPDATE faction_wars SET ends_at = 0, alliance = '[]', horde = '[]' WHERE broadcaster_id = ?", [broadcasterId]);
    await say(`the war at ${w!.place} is called off. Both armies stand down.`);
    return true;
  }
  if (sub === "go" || sub === "fight" || sub === "now") {
    if (!open) return say("no war is mustering — !factionwar sounds the call.").then(() => true);
    if (!isModerator && w!.started_by !== user) return say("only whoever sounded the call (or a mod) can send the armies in early.").then(() => true);
    if (!w!.alliance.length || !w!.horde.length) {
      return say(`both sides need at least one hero. ${musterLine(w!, now)}`).then(() => true);
    }
    await maybeResolveFactionWar(broadcasterId, { now, force: true });
    return true;
  }

  const wanted = findWowFaction(sub === "join" ? words[1] ?? "" : sub);
  if (sub && sub !== "join" && sub !== "start" && !wanted) {
    await say("!factionwar | !factionwar join [alliance|horde] | !factionwar go | !factionwar status | !factionwar help");
    return true;
  }

  if (open) {
    await say(await join(w!, user, display, wanted, broadcasterId));
    return true;
  }
  if (sub === "join") return say("no war is mustering — !factionwar sounds the call.").then(() => true);

  // Sound the call.
  const wait = w ? w.last_war_at + FACTIONWAR_COOLDOWN_SECONDS * 1000 - now : 0;
  if (wait > 0) return say(`the armies are still regrouping from the last war — ${secs(wait)}s more.`).then(() => true);
  const c = await getCharacter(user, broadcasterId);
  if (!c) return say("you need a hero to sound the call: !wowchar for a WoW one, or !createchar.").then(() => true);
  if (!c.wow && !wanted) return say("a sellsword picks a side to sound the call for: !factionwar alliance or !factionwar horde.").then(() => true);
  const [place, what] = pick(BATTLEFIELDS);
  const endsAt = now + FACTIONWAR_MUSTER_SECONDS * 1000;
  await sqlite.execute(
    `INSERT INTO faction_wars (broadcaster_id, place, started_by, ends_at, alliance, horde, last_war_at)
     VALUES (?, ?, ?, ?, '[]', '[]', 0)
     ON CONFLICT(broadcaster_id) DO UPDATE SET place = excluded.place, started_by = excluded.started_by,
       ends_at = excluded.ends_at, alliance = '[]', horde = '[]'
     WHERE faction_wars.ends_at = 0`,
    [broadcasterId, place, user, endsAt],
  );
  w = await getFactionWar(broadcasterId);
  if (!w || w.ends_at !== endsAt || w.started_by !== user) {
    // Someone else sounded it first: join theirs.
    if (w && w.ends_at > 0) await say(await join(w, user, display, wanted, broadcasterId));
    return true;
  }
  const side: WowFaction = c.wow?.faction ?? wanted!;
  const joined = await join(w, user, display, wanted, broadcasterId);
  const placeName = place.charAt(0).toUpperCase() + place.slice(1);
  await sendChatMessage(
    `⚔️ WAR! ${FACTION_ICON[side]} @${display} sounds the call for the ${side} at ${placeName} — ${what}. ` +
      `WoW heroes: !factionwar join to fight for your faction. D&D heroes: !factionwar alliance or !factionwar horde as sellswords. ` +
      `${FACTIONWAR_MUSTER_SECONDS}s to muster, ${FACTION_ICON[other(side)]} ${other(side)}!`,
    broadcasterId,
  );
  if (!/^\S+ (For the Alliance|Lok'tar)/.test(joined)) await say(joined);
  return true;
}

/** The battle itself: who won, the log, and each hero's HP left. Pure. */
export function fightFactionWar(
  sides: Record<WowFaction, Array<{ name: string; c: any }>>,
  rng: () => number = Math.random,
): { winner: WowFaction; rounds: number; battle: BattleLog; hp: Record<string, [number, number]>; capped: boolean } {
  const battle = new BattleLog();
  for (const f of ["Alliance", "Horde"] as WowFaction[]) {
    for (const h of sides[f]) battle.describe(`[${f}] ${fighterLine(h.name, h.c, h.c.hpMax, 10)}`);
  }
  const fighters: Record<WowFaction, Fighter[]> = {
    Alliance: team(...sides.Alliance.map((h) => heroFighter(h.name, h.c, h.c.hpMax, 10))),
    Horde: team(...sides.Horde.map((h) => heroFighter(h.name, h.c, h.c.hpMax, 10))),
  };
  const init = (f: WowFaction) => 1 + Math.floor(rng() * 20) + Math.max(...sides[f].map((h) => initiativeMod(h.c)));
  const a = init("Alliance"), h = init("Horde");
  const order: WowFaction[] = a >= h ? ["Alliance", "Horde"] : ["Horde", "Alliance"];
  battle.describe(`Initiative (d20 + quickest DEX): Alliance ${a}, Horde ${h} — the ${order[0]} strikes first each round.`);
  const standing = (fs: Fighter[]) => fs.filter((f) => f.hp > 0);
  let rounds = 0;
  while (standing(fighters.Alliance).length && standing(fighters.Horde).length && rounds < MAX_ROUNDS) {
    rounds++;
    battle.nextRound();
    for (const f of order) {
      for (const me of fighters[f]) {
        const foes = standing(fighters[other(f)]);
        if (!foes.length) break;
        if (me.hp <= 0) continue;
        heroTurn(me, () => {
          const left = standing(fighters[other(f)]);
          return left.length ? left[Math.floor(rng() * left.length)] : undefined;
        }, battle, rounds);
      }
    }
  }
  const share = (fs: Fighter[]) => fs.reduce((t, x) => t + Math.max(0, x.hp), 0) / Math.max(1, fs.reduce((t, x) => t + x.max, 0));
  const aUp = standing(fighters.Alliance).length > 0, hUp = standing(fighters.Horde).length > 0;
  const capped = aUp && hUp;
  const winner: WowFaction = capped ? (share(fighters.Alliance) >= share(fighters.Horde) ? "Alliance" : "Horde") : aUp ? "Alliance" : "Horde";
  const hp: Record<string, [number, number]> = {};
  for (const x of [...fighters.Alliance, ...fighters.Horde]) hp[x.name] = [Math.max(0, x.hp), x.max];
  return { winner, rounds, battle, hp, capped };
}

/** Fights the channel's muster if its time is up (or `force`). True if it ran. */
export async function maybeResolveFactionWar(broadcasterId: string, opts: { now?: number; force?: boolean } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const w = await getFactionWar(broadcasterId);
  if (!w || !w.ends_at || (!opts.force && w.ends_at > now)) return false;
  const claim: any = await sqlite.execute(
    "UPDATE faction_wars SET ends_at = 0, alliance = '[]', horde = '[]', last_war_at = ? WHERE broadcaster_id = ? AND ends_at = ?",
    [now, broadcasterId, w.ends_at],
  );
  if (typeof claim?.rowsAffected === "number") {
    if (claim.rowsAffected === 0) return false;
  } else {
    const after = await getFactionWar(broadcasterId);
    if (!after || after.ends_at !== 0 || after.last_war_at !== now) return false;
  }

  const load = async (list: WarMember[]) => {
    const out: Array<{ name: string; c: any; m: WarMember }> = [];
    for (const m of list) {
      const c = await getCharacter(m.u, broadcasterId);
      if (c) out.push({ name: m.d, c, m });
    }
    return out;
  };
  const sides = { Alliance: await load(w.alliance), Horde: await load(w.horde) };
  const place = w.place.charAt(0).toUpperCase() + w.place.slice(1);
  if (!sides.Alliance.length && !sides.Horde.length) {
    await sendChatMessage(`🏳️ Nobody answered the call to ${place}. The battlefield stays quiet.`, broadcasterId);
    return true;
  }
  for (const f of ["Alliance", "Horde"] as WowFaction[]) {
    if (!sides[other(f)].length) {
      await sendChatMessage(
        `${FACTION_ICON[f]} No one answered for the ${other(f)} — the ${f} (${sides[f].map((s) => s.name).join(", ")}) holds ${w.place} unopposed. ` +
          `${f === "Horde" ? "Lok'tar ogar!" : "For the Alliance!"}`,
        broadcasterId,
      );
      return true;
    }
  }

  const fight = fightFactionWar(sides);
  await recordDuelNaturals(
    broadcasterId,
    strikeD20s(fight.battle.strikes),
    Object.fromEntries([...sides.Alliance, ...sides.Horde].map((s) => [s.name, s.name])),
  ).catch(() => {});
  const loser = other(fight.winner);
  const cry = fight.winner === "Horde" ? "Lok'tar ogar!" : "For the Alliance!";
  const left = (f: WowFaction) => sides[f].map((s) => `${s.name} ${fight.hp[s.name][0]}/${fight.hp[s.name][1]}`).join(", ");
  const shownLog = fight.battle.render(600);
  const head = `⚔️ Faction war at ${place}: ${FACTION_ICON.Alliance} ${sides.Alliance.map((s) => s.name).join(", ")} vs ` +
    `${FACTION_ICON.Horde} ${sides.Horde.map((s) => s.name).join(", ")} — ${fight.rounds} round${fight.rounds === 1 ? "" : "s"}. `;
  const end = ` — ${FACTION_ICON[fight.winner]} the ${fight.winner} ${fight.capped ? "holds the field as the " + loser + " falls back" : "wins"} at ${w.place}! ${cry} ` +
    `HP [${left("Alliance")}] vs [${left("Horde")}]`;
  const msg = head + shownLog + end;
  await sendChatMessages(msg, broadcasterId, {
    detail: head + fight.battle.renderDetailed() + end,
    names: [...sides.Alliance, ...sides.Horde].map((s) => s.m.u),
    // The one message chat gets when the full log is too long (the log goes
    // to the reply's page): who fought, who won, HP left.
    summary: `${head}${FACTION_ICON[fight.winner]} The ${fight.winner} ${fight.capped ? "holds the field" : "wins"}! ${cry} ` +
      `❤️ HP left: ${hpLeft([...sides.Alliance, ...sides.Horde].map((s): [string, number, number] => [s.name, ...fight.hp[s.name]]))}.`,
  });
  return true;
}

export async function maybeResolveFactionWarSafe(broadcasterId: string) {
  try {
    await maybeResolveFactionWar(broadcasterId);
  } catch (e) {
    await recordMonitorEvent("factionwar_error", `${broadcasterId}: ${String(e)}`).catch(() => {});
  }
}

/** Channels with a muster whose time is up (the cron fallback). */
export async function getExpiredFactionWars(now = Date.now()): Promise<string[]> {
  const res = await sqlite.execute("SELECT broadcaster_id FROM faction_wars WHERE ends_at > 0 AND ends_at <= ?", [now]);
  return res.rows.map((r: any) => String(r.broadcaster_id));
}

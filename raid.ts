// GuildScribe — the stream's raid quest. Once per stream, when the channel goes
// live (stream.online in main.ts), a single raid quest is posted: a high-level
// boss (CR RAID_MIN_CR and up) that no lone hero should take on. Viewers band
// together with !raid into a temporary party that fights it; the boss's HP
// carries over between raids, so the whole chat wears it down over the stream.
//
//   !raid               sound the war horn (opens a muster), or join the one open
//   !raid go            launch the muster now (its leader or a mod)
//   !raid status        the boss, its HP, the muster and the cooldown
//   !raid cooldown [t]  show it; mods set it (90s, 10m, 1h, off; max 2h)
//   !raid new           mod: post a fresh raid quest now (e.g. bot joined mid-stream)
//
// The temporary party is just the muster: whoever typed !raid within
// RAID_MUSTER_SECONDS of the horn. Val Town has no always-on process, so a
// muster whose time is up is launched by the next thing that looks at it — any
// chat message in the channel (maybeLaunchRaid, called from main.ts), !raid
// itself, or the autohunt cron as a fallback. A full muster launches at once.
// The launch is claimed atomically, so it can only happen once.
//
// Cooldown: after a raid launches, no new muster can be opened for the
// channel's raid cooldown (RAID_COOLDOWN_SECONDS env, default 10 minutes; mods
// change it with !raid cooldown). It is per channel, separate from the hunting
// cooldown, and does not stop anyone joining a muster that is already open.
//
// When the boss falls, every hero who struck it during the stream earns its
// full XP and a share of a hoard RAID_LOOT_MULTIPLIER times a normal drop.
// Heroes always start a raid at full HP, so a wipe costs nothing but time.

import { sqlite } from "./sqlite.ts";
import { getBroadcaster, getCharacter, isChannelBlocked, isChannelEnabled, isCommandGroupEnabled, recordMonitorEvent } from "./db.ts";
import { SOLO_MONSTERS, type SoloMonster } from "./data.ts";
import { applyAdaptation, getAdaptation, getChannelRoster, recordMonsterOutcome, stripMeta, tierTag } from "./bestiary.ts";
import { recordBattle } from "./battle_log.ts";
import { BattleLog, fighterLine, fightingAbility, heroAcWhy, MONSTER_AC_WHY, rollDice } from "./battle.ts";
import { awardMonsterXp } from "./characters.ts";
import { settleWounds, startHp, woundsOn } from "./hoard_combat.ts";
import { creditBounty } from "./hoard.ts";
import { monsterLootCopper, splitLoot } from "./loot.ts";
import { adjustBalance, canEarnGold } from "./points_db.ts";
import { formatCoins } from "./coins.ts";
import { parseCooldown, waitText } from "./huntcooldown.ts";
import { combatStats } from "./utils.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import { fightSummary, hpLeft } from "./whisper.ts";
import { forgetOptionCache, optNum } from "./channel_options.ts";

const envNumber = (name: string, fallback: number, min: number, max: number) => {
  const n = Number(Deno.env.get(name) ?? "");
  return Number.isFinite(n) && Deno.env.get(name) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const MAX_RAID_COOLDOWN_SECONDS = 2 * 3600;
export const DEFAULT_RAID_COOLDOWN_SECONDS = Math.floor(envNumber("RAID_COOLDOWN_SECONDS", 600, 0, MAX_RAID_COOLDOWN_SECONDS));
export const RAID_MIN_CR = envNumber("RAID_MIN_CR", 13, 1, 17);
// The muster time, party size, boss HP and hoard multipliers are per-channel
// options (channel_options.ts: raid.muster, raid.party, raid.hp, raid.loot),
// defaulting to RAID_MUSTER_SECONDS (60), RAID_PARTY_MAX (6),
// RAID_HP_MULTIPLIER (2) and RAID_LOOT_MULTIPLIER (5).
const raidOpts = async (broadcasterId: string) => {
  const [muster, party, hp, loot] = await Promise.all(["raid.muster", "raid.party", "raid.hp", "raid.loot"].map((k) => optNum(broadcasterId, k)));
  return { musterMs: muster * 1000, partyMax: party, hpMult: hp, lootMult: loot };
};
/** Rounds one raid lasts before the party has to fall back. */
const RAID_MAX_ROUNDS = 20;

type Member = { u: string; d: string };

export type RaidQuest = {
  broadcaster_id: string;
  stream_started_at: string;
  monster_name: string;
  monster_cr: string;
  monster_ac: number;
  monster_hp: number;
  monster_hp_max: number;
  monster_attack: number;
  monster_die: number;
  monster_bonus: number;
  status: string; // active | slain | expired
  posted_at: number;
  raids: number;
  last_raid_at: number;
  muster_ends_at: number; // 0 = no muster open
  muster_leader: string;
  muster_members: string; // JSON Member[]
  contributors: string; // JSON { login: damage }
};

export async function ensureRaidTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS raid_quests (
      broadcaster_id TEXT PRIMARY KEY, stream_started_at TEXT NOT NULL DEFAULT '',
      monster_name TEXT NOT NULL, monster_cr TEXT NOT NULL, monster_ac INTEGER NOT NULL,
      monster_hp INTEGER NOT NULL, monster_hp_max INTEGER NOT NULL, monster_attack INTEGER NOT NULL,
      monster_die INTEGER NOT NULL, monster_bonus INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', posted_at INTEGER NOT NULL, raids INTEGER NOT NULL DEFAULT 0,
      last_raid_at INTEGER NOT NULL DEFAULT 0, muster_ends_at INTEGER NOT NULL DEFAULT 0,
      muster_leader TEXT NOT NULL DEFAULT '', muster_members TEXT NOT NULL DEFAULT '[]',
      contributors TEXT NOT NULL DEFAULT '{}'
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS raid_settings (
      broadcaster_id TEXT PRIMARY KEY, cooldown_seconds INTEGER NOT NULL, updated_at INTEGER
    )`,
  );
}

const parseJson = <T>(raw: unknown, fallback: T): T => {
  try {
    return raw ? JSON.parse(String(raw)) as T : fallback;
  } catch {
    return fallback;
  }
};

/** True when an UPDATE changed a row (with a re-read fallback when the driver doesn't say). */
async function changed(res: unknown, recheck: () => Promise<boolean>): Promise<boolean> {
  const affected = (res as any)?.rowsAffected;
  return typeof affected === "number" ? affected > 0 : recheck();
}

export async function getRaidQuest(broadcasterId: string): Promise<RaidQuest | null> {
  const res = await sqlite.execute("SELECT * FROM raid_quests WHERE broadcaster_id = ?", [broadcasterId]);
  if (!res.rows.length) return null;
  const r: any = res.rows[0];
  const num = (k: string) => Number(r[k] ?? 0);
  return {
    ...r,
    monster_ac: num("monster_ac"),
    monster_hp: num("monster_hp"),
    monster_hp_max: num("monster_hp_max"),
    monster_attack: num("monster_attack"),
    monster_die: num("monster_die"),
    monster_bonus: num("monster_bonus"),
    posted_at: num("posted_at"),
    raids: num("raids"),
    last_raid_at: num("last_raid_at"),
    muster_ends_at: num("muster_ends_at"),
  } as RaidQuest;
}

export async function getRaidCooldownSeconds(broadcasterId: string): Promise<number> {
  const res = await sqlite.execute("SELECT cooldown_seconds FROM raid_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length ? Number(res.rows[0].cooldown_seconds) : DEFAULT_RAID_COOLDOWN_SECONDS;
}

async function setRaidCooldownSeconds(broadcasterId: string, seconds: number) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO raid_settings (broadcaster_id, cooldown_seconds, updated_at) VALUES (?,?,?)",
    [broadcasterId, seconds, Date.now()],
  );
  forgetOptionCache(broadcasterId); // the dashboard shows it as an option (channel_options.ts)
}

/** Milliseconds until a new raid can be mustered (0 = ready). */
async function raidWaitMs(q: RaidQuest, now = Date.now()): Promise<number> {
  if (!q.last_raid_at) return 0;
  const cd = (await getRaidCooldownSeconds(q.broadcaster_id)) * 1000;
  return Math.max(0, q.last_raid_at + cd - now);
}

/** A random boss from the top of the bestiary (CR RAID_MIN_CR and up). The
 * pool is the channel's live roster (core + learned, see bestiary.ts), so a
 * learned high-CR monster can be posted as a raid boss. */
export function pickRaidBoss(rng: () => number = Math.random, roster: SoloMonster[] = SOLO_MONSTERS, hpMult = 2): SoloMonster {
  const source = roster.length ? roster : SOLO_MONSTERS;
  let pool = source.filter((m) => m.crValue >= RAID_MIN_CR);
  // Fallback grows with the roster (~3% of it, never fewer than 5).
  if (!pool.length) pool = [...source].sort((a, b) => b.crValue - a.crValue).slice(0, Math.max(5, Math.ceil(source.length * 0.03)));
  const base = stripMeta(pool[Math.floor(rng() * pool.length)]);
  return { ...base, hp: Math.max(10, Math.round(base.hp * hpMult)) };
}

/**
 * Posts a fresh raid quest for this stream, replacing any earlier one.
 * `streamStartedAt` dedupes Twitch redelivering the same stream.online: the
 * same stream never gets a second quest. Returns the announcement, or null
 * when this stream already has its quest.
 */
export async function createRaidQuest(broadcasterId: string, streamStartedAt: string): Promise<string | null> {
  const existing = await getRaidQuest(broadcasterId);
  if (streamStartedAt && existing?.stream_started_at === streamStartedAt) return null;
  // Adapted like every other hunt: a boss species the channel keeps slaying
  // comes back having learned from it (bestiary.ts).
  const opts = await raidOpts(broadcasterId);
  const picked = pickRaidBoss(Math.random, await getChannelRoster(broadcasterId), opts.hpMult);
  const boss = applyAdaptation(picked, (await getAdaptation(broadcasterId, picked.name)).tier);
  await sqlite.execute(
    `INSERT OR REPLACE INTO raid_quests (broadcaster_id, stream_started_at, monster_name, monster_cr, monster_ac,
      monster_hp, monster_hp_max, monster_attack, monster_die, monster_bonus, status, posted_at, raids,
      last_raid_at, muster_ends_at, muster_leader, muster_members, contributors)
     VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,0,0,0,'','[]','{}')`,
    [broadcasterId, streamStartedAt, boss.name, boss.cr, boss.ac, boss.hp, boss.hp, boss.attack, boss.die, boss.bonus, Date.now()],
  );
  const cd = await getRaidCooldownSeconds(broadcasterId);
  return `📯 RAID QUEST posted on the guild board! ${withArticle(boss.name)} (CR ${boss.cr}${tierTag(boss.tier)}, AC ${boss.ac}, HP ${boss.hp}) threatens the realm — ` +
    `far too much for one hero. Type !raid to sound the war horn; anyone with a saved hero can join within ${waitText(opts.musterMs)} ` +
    `(up to ${opts.partyMax}). Its wounds carry over between raids${cd > 0 ? `, one raid every ${waitText(cd * 1000)}` : ""}. ` +
    `Slay it this stream for its full XP and a ${opts.lootMult > 0 ? "great hoard" : "place in the chronicle"}!`;
}

/** stream.offline: the quest ends with the stream. */
export async function expireRaidQuest(broadcasterId: string) {
  await sqlite.execute(
    "UPDATE raid_quests SET status = 'expired', muster_ends_at = 0, muster_members = '[]' WHERE broadcaster_id = ? AND status = 'active'",
    [broadcasterId],
  );
}

/**
 * stream.online / stream.offline hook from main.ts: posts the stream's one raid
 * quest when it goes live (if the channel is connected, open and has the raid
 * group on) and retires it when it ends. Never throws.
 */
export async function onRaidStreamStatus(broadcasterId: string, online: boolean, startedAt: unknown) {
  try {
    if (!online) return await expireRaidQuest(broadcasterId);
    const conn = await getBroadcaster(broadcasterId);
    if (!conn || Number(conn.connected) !== 1 || (await isChannelBlocked(broadcasterId))) return;
    if (!(await isChannelEnabled(broadcasterId)) || !(await isCommandGroupEnabled(broadcasterId, "raid"))) return;
    const announcement = await createRaidQuest(broadcasterId, String(startedAt ?? ""));
    if (announcement) await sendChatMessages(announcement, broadcasterId);
  } catch (e) {
    await recordMonitorEvent("raid_quest_error", `${broadcasterId}: ${String(e)}`);
  }
}

/** maybeLaunchRaid for the per-message hook in main.ts. Never throws. */
export async function maybeLaunchRaidSafe(broadcasterId: string) {
  try {
    await maybeLaunchRaid(broadcasterId);
  } catch (e) {
    await recordMonitorEvent("raid_launch_error", `${broadcasterId}: ${String(e)}`);
  }
}

/** Channels with a muster whose time is up (for the cron fallback in autohunt_cron.ts). */
export async function getExpiredRaidMusters(now = Date.now()): Promise<string[]> {
  const res = await sqlite.execute(
    "SELECT broadcaster_id FROM raid_quests WHERE status = 'active' AND muster_ends_at > 0 AND muster_ends_at <= ?",
    [now],
  );
  return res.rows.map((r: any) => String(r.broadcaster_id));
}

export async function purgeRaidData(broadcasterId: string, purge: boolean) {
  await sqlite.execute("DELETE FROM raid_quests WHERE broadcaster_id = ?", [broadcasterId]);
  if (purge) await sqlite.execute("DELETE FROM raid_settings WHERE broadcaster_id = ?", [broadcasterId]);
}

const withArticle = (name: string) => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;

// ---------------------------------------------------------------------------
// The fight
// ---------------------------------------------------------------------------

export type RaidBoss = { name: string; ac: number; hpMax: number; attack: number; die: number; bonus: number };

/**
 * One raid: every standing hero swings at the boss each round, then the boss
 * strikes back — once, plus a legendary action for every second raider — at
 * random standing heroes. Ends when the boss falls, the party is wiped, or
 * RAID_MAX_ROUNDS pass and the party falls back. Pure: no DB, no chat.
 */
export function simulateRaidFight(
  // `hp`: HP going in (Hunt and Hoard wounds); full HP when omitted.
  heroes: Array<{ name: string; c: any; hp?: number }>,
  boss: RaidBoss,
  bossHpStart: number,
  maxRounds = RAID_MAX_ROUNDS,
) {
  let bossHp = bossHpStart;
  const hp: Record<string, number> = {};
  const damage: Record<string, number> = {};
  for (const h of heroes) {
    hp[h.name] = Math.max(1, Math.min(h.c.hpMax, h.hp ?? h.c.hpMax));
    damage[h.name] = 0;
  }
  const battle = new BattleLog();
  const bossAttacks = 1 + Math.floor(heroes.length / 2);
  const d = (sides: number) => 1 + Math.floor(Math.random() * sides);
  for (const h of heroes) battle.describe(fighterLine(h.name, h.c, hp[h.name], 11, { die: 10, edge: 1 }));
  battle.describe(
    `${boss.name}: ${bossHpStart}/${boss.hpMax} HP going in, AC ${boss.ac} (stat block), attack d20 + ${boss.attack}, damage 1d${boss.die} + ${boss.bonus}; ` +
      `strikes back ${bossAttacks} time${bossAttacks === 1 ? "" : "s"} a round (1 + a legendary action for every 2nd raider).`,
  );
  let slayer: string | null = null;

  for (let round = 0; round < maxRounds && bossHp > 0 && heroes.some((h) => hp[h.name] > 0); round++) {
    battle.nextRound();
    for (const h of heroes) {
      if (hp[h.name] <= 0 || bossHp <= 0) continue;
      const s = combatStats(h.c);
      const ability = fightingAbility(h.c).name;
      const roll = d(20);
      const total = roll + s.mod + h.c.proficiency + 1; // same +1 to-hit as solo monster fights
      const crit = roll === 20;
      const hit = crit || (roll !== 1 && total >= boss.ac);
      const rolls = rollDice(crit ? 2 : 1, 10);
      const dmg = hit ? Math.max(1, rolls.reduce((x, y) => x + y, 0) + s.mod + 1) : 0;
      const bossHpBefore = bossHp;
      if (hit) {
        const dealt = Math.min(bossHp, dmg);
        bossHp -= dealt;
        damage[h.name] += dealt;
        if (bossHp <= 0) slayer = h.name;
      }
      battle.strike({
        actor: h.name, target: boss.name, hit, crit, fumble: roll === 1, roll, total, ac: boss.ac,
        damage: dmg, targetHp: bossHp, targetMax: boss.hpMax, acWhy: MONSTER_AC_WHY,
        atk: [[ability, s.mod], ["prof", h.c.proficiency], ["edge", 1]],
        dmgDice: hit ? rolls : undefined, dmgDie: 10, dmgMods: [[ability, s.mod], ["edge", 1]],
        hpBefore: bossHpBefore,
      });
    }
    for (let a = 0; a < bossAttacks && bossHp > 0; a++) {
      const standing = heroes.filter((h) => hp[h.name] > 0);
      if (!standing.length) break;
      const v = standing[Math.floor(Math.random() * standing.length)];
      const vs = combatStats(v.c);
      const ac = 11 + vs.mod + v.c.proficiency;
      const roll = d(20);
      const total = roll + boss.attack;
      const hit = roll !== 1 && (roll === 20 || total >= ac);
      const rolls = rollDice(roll === 20 ? 2 : 1, boss.die);
      const dmg = hit ? Math.max(1, rolls.reduce((x, y) => x + y, 0) + boss.bonus) : 0;
      const victimHpBefore = hp[v.name];
      if (hit) hp[v.name] = Math.max(0, hp[v.name] - dmg);
      battle.strike({
        actor: boss.name, target: v.name, hit, crit: roll === 20, fumble: roll === 1, roll, total, ac,
        damage: dmg, targetHp: hp[v.name], targetMax: v.c.hpMax, acWhy: heroAcWhy(11, v.c),
        atk: [["atk", boss.attack]],
        dmgDice: hit ? rolls : undefined, dmgDie: boss.die, dmgMods: [["bonus", boss.bonus]],
        hpBefore: victimHpBefore,
      });
    }
  }
  return { bossHp, hp, damage, slayer, rounds: battle.roundCount, battle };
}

// ---------------------------------------------------------------------------
// Muster & launch
// ---------------------------------------------------------------------------

/**
 * Launches the open muster if its time is up (or `force`), fights the raid,
 * and posts the result. Safe to call from anywhere: returns false without
 * doing anything when there's nothing to launch or someone else claimed it.
 */
export async function maybeLaunchRaid(broadcasterId: string, opts: { force?: boolean; now?: number } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const q = await getRaidQuest(broadcasterId);
  if (!q || q.status !== "active" || !q.muster_ends_at) return false;
  if (!opts.force && q.muster_ends_at > now) return false;

  const claim = await sqlite.execute(
    `UPDATE raid_quests SET muster_ends_at = 0, muster_members = '[]', muster_leader = '', last_raid_at = ?, raids = raids + 1
     WHERE broadcaster_id = ? AND status = 'active' AND muster_ends_at = ?`,
    [now, broadcasterId, q.muster_ends_at],
  );
  if (!(await changed(claim, async () => (await getRaidQuest(broadcasterId))?.last_raid_at === now))) return false;

  const members = parseJson<Member[]>(q.muster_members, []);
  // Hunt and Hoard wounds (hoard_combat.ts): with the module on, raiders
  // charge at their current HP and anyone at 1 HP stays behind.
  const wounds = await woundsOn(broadcasterId);
  const heroes: Array<{ name: string; c: any; hp: number }> = [];
  const benched: string[] = [];
  for (const m of members) {
    const c = await getCharacter(m.u, broadcasterId);
    if (!c) continue;
    const hp = await startHp(broadcasterId, c, wounds);
    if (wounds && hp <= 1) benched.push(m.u);
    else heroes.push({ name: m.u, c, hp });
  }
  const benchNote = benched.length ? ` (${benched.join(", ")} too wounded to ride out.)` : "";
  const boss: RaidBoss = {
    name: q.monster_name, ac: q.monster_ac, hpMax: q.monster_hp_max,
    attack: q.monster_attack, die: q.monster_die, bonus: q.monster_bonus,
  };
  if (!heroes.length) {
    await sendChatMessage(
      benched.length
        ? `📯 The war horn fades — every raider is too wounded to ride out (1 HP). ${boss.name} waits. (!rest or !use a potion, then !raid)`
        : `📯 The war horn fades — nobody with a saved hero answered. ${boss.name} waits. (!createchar, then !raid)`,
      broadcasterId,
    );
    return true;
  }

  const fight = simulateRaidFight(heroes, boss, q.monster_hp);
  for (const h of heroes) await settleWounds(broadcasterId, h.name, fight.hp[h.name], wounds); // before XP
  const woundsText = wounds ? " 🩸 Wounds carry over." : "";
  const dealt = q.monster_hp - fight.bossHp;
  await sqlite.execute(
    "UPDATE raid_quests SET monster_hp = MAX(0, monster_hp - ?) WHERE broadcaster_id = ? AND status = 'active'",
    [dealt, broadcasterId],
  );
  // Read-modify-write is fine here: launches are claimed one at a time.
  const fresh = await getRaidQuest(broadcasterId);
  const contributors = parseJson<Record<string, number>>(fresh?.contributors ?? q.contributors, {});
  for (const [u, dmg] of Object.entries(fight.damage)) if (dmg > 0) contributors[u] = (contributors[u] ?? 0) + dmg;
  await sqlite.execute("UPDATE raid_quests SET contributors = ? WHERE broadcaster_id = ?", [JSON.stringify(contributors), broadcasterId]);

  const names = heroes.map((h) => h.name);
  const shownLog = fight.battle.render(650);
  const header = `⚔️ Raid #${q.raids + 1}: ${names.join(", ")} charge ${boss.name} (AC ${boss.ac}, HP ${q.monster_hp}/${boss.hpMax})! ` +
    `${fight.rounds} round${fight.rounds === 1 ? "" : "s"}: ${shownLog} — `;
  // The chat summary names the raid party; the detail page gets every round.
  const raiders = `raid #${q.raids + 1} (${names.join(", ")})`;
  const raidSide = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
  const raidHp = (bossLeft: number) =>
    hpLeft([...heroes.map((h): [string, number, number] => [h.name, fight.hp[h.name], h.c.hpMax]), [boss.name, bossLeft, boss.hpMax]]);
  const fullLog = (msg: string) => msg.replace(shownLog, fight.battle.renderDetailed());
  const hits = names.filter((n) => fight.damage[n] > 0).map((n) => `${n} ${fight.damage[n]}`).join(", ") || "none";

  const left = fresh?.monster_hp ?? fight.bossHp;
  if (left <= 0) {
    const slain = await sqlite.execute(
      "UPDATE raid_quests SET status = 'slain' WHERE broadcaster_id = ? AND status = 'active' AND monster_hp <= 0",
      [broadcasterId],
    );
    const won = await changed(slain, async () => true);
    const rewards = won ? await payRaidRewards(broadcasterId, q.monster_cr, contributors) : { note: "", hoard: "" };
    const learnNote = won ? await recordMonsterOutcome(broadcasterId, boss.name, true, raidLevel(heroes)) : "";
    if (won) await recordBattle(broadcasterId, { kind: "raid", side: raidSide, foe: boss.name, outcome: "win" });
    let bountyNote = "";
    if (won) for (const u of Object.keys(contributors)) bountyNote ||= await creditBounty(broadcasterId, u, boss.name);
    const msg = `${header}🏆 ${boss.name} IS SLAIN${fight.slayer ? ` — the killing blow by ${fight.slayer}` : ""}! Damage this raid: ${hits}. ${rewards.note}` +
      ` The raid quest is complete for this stream.${bountyNote}${learnNote}${woundsText}${benchNote}`;
    await sendChatMessages(msg, broadcasterId, {
      names: [...new Set([...names, ...Object.keys(contributors)])],
      detail: fullLog(msg),
      summary: fightSummary({ fighter: raiders, enemy: boss.name, outcome: `🏆 ${boss.name} is slain!`, hp: raidHp(0), loot: rewards.hoard }),
    });
    return true;
  }

  const cd = await getRaidCooldownSeconds(broadcasterId);
  const standing = names.filter((n) => fight.hp[n] > 0).length;
  // A rout is a win the boss learns from; falling back with heroes standing
  // settles nothing either way.
  const learnNote = standing ? "" : await recordMonsterOutcome(broadcasterId, boss.name, false, raidLevel(heroes));
  await recordBattle(broadcasterId, {
    kind: "raid",
    side: raidSide,
    foe: boss.name,
    outcome: standing ? "retreat" : "loss",
    note: `${left}/${boss.hpMax} HP left`,
  });
  const msg = `${header}${standing ? `the party falls back with ${standing} still standing` : "the party is routed"}. ` +
    `Damage this raid: ${hits}. ${boss.name} has ${left}/${boss.hpMax} HP left. ` +
    `${cd > 0 ? `The next raid can muster in ${waitText(cd * 1000)}` : "Sound the horn again with !raid"}.${learnNote}${woundsText}${benchNote}`;
  await sendChatMessages(msg, broadcasterId, {
    names,
    detail: fullLog(msg),
    summary: fightSummary({
      fighter: raiders,
      enemy: boss.name,
      outcome: `${boss.name} holds — the party ${standing ? "falls back" : "is routed"}.`,
      hp: raidHp(left),
    }),
  });
  return true;
}

/** Average hero level of a raid party (sets the odds the boss learns against). */
function raidLevel(heroes: Array<{ c: any }>): number {
  return heroes.length ? Math.round(heroes.reduce((t, h) => t + Number(h.c.level ?? 1), 0) / heroes.length) : 1;
}

/** XP for the boss to every hero who struck it, plus a split hoard. Returns
 * the chat note and the bare hoard for the fight summary. */
async function payRaidRewards(
  broadcasterId: string,
  cr: string,
  contributors: Record<string, number>,
): Promise<{ note: string; hoard: string }> {
  const heroes = Object.keys(contributors);
  if (!heroes.length) return { note: "", hoard: "" };
  const xpNotes: string[] = [];
  for (const u of heroes) {
    const xp = await awardMonsterXp(u, cr, broadcasterId);
    if (xp) xpNotes.push(`${u}+${xp.gained}${xp.leveledTo ? `→Lv${xp.leveledTo}` : ""}`);
  }
  let hoard = "";
  const lootMult = await optNum(broadcasterId, "raid.loot");
  if (lootMult > 0 && (await canEarnGold(broadcasterId))) { // no hoard while offline
    const shares = splitLoot(monsterLootCopper(cr, Math.random, lootMult), heroes.length);
    for (let i = 0; i < heroes.length; i++) await adjustBalance(broadcasterId, heroes[i], heroes[i], shares[i]);
    hoard = heroes.map((u, i) => `${u} +${formatCoins(shares[i])}`).join(", ");
  }
  return { note: `XP to every raider who struck it: ${xpNotes.join(", ") || "none"}.${hoard ? ` 🪙 Hoard: ${hoard}.` : ""}`, hoard };
}

/** What the /roster page shows about the raid quest; null when there's no
 * quest this stream (none posted yet, or it expired with the stream). */
export type RaidRosterStatus = {
  monster: string; cr: string; ac: number; hp: number; hpMax: number; raids: number;
  slain: boolean;
  state: string; // muster / cooldown / ready, as plain text
  contributors: Array<{ name: string; damage: number }>;
};

export async function getRaidRosterStatus(broadcasterId: string): Promise<RaidRosterStatus | null> {
  const q = await getRaidQuest(broadcasterId);
  if (!q || (q.status !== "active" && q.status !== "slain")) return null;
  const slain = q.status === "slain";
  let state = "Slain — a new raid quest goes up next stream.";
  if (!slain) {
    const members = parseJson<Member[]>(q.muster_members, []);
    const wait = await raidWaitMs(q);
    state = q.muster_ends_at
      ? `Muster open (${musterText(members, await optNum(broadcasterId, "raid.party"))}) — launches in ${waitText(Math.max(1000, q.muster_ends_at - Date.now()))}.`
      : wait > 0
      ? `Raiders are recovering — the next raid can muster in ${waitText(wait)}.`
      : "Ready — type !raid in chat to sound the war horn.";
  }
  const contributors = Object.entries(parseJson<Record<string, number>>(q.contributors, {}))
    .filter(([, d]) => Number(d) > 0)
    .map(([name, d]) => ({ name, damage: Number(d) }))
    .sort((a, b) => b.damage - a.damage)
    .slice(0, 10);
  return {
    monster: q.monster_name, cr: String(q.monster_cr), ac: q.monster_ac,
    hp: Math.max(0, q.monster_hp), hpMax: q.monster_hp_max, raids: q.raids,
    slain, state, contributors,
  };
}

function musterText(members: Member[], partyMax: number): string {
  return `${members.length}/${partyMax}: ${members.map((m) => m.d).join(", ")}`;
}

/** Handles !raid and its subcommands. Returns true if it consumed the message. */
export async function handleRaidCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!raid(?:\s+(\S+))?(?:\s+(.*))?$/i);
  if (!m) return false;
  const sub = (m[1] ?? "").toLowerCase();
  const arg = (m[2] ?? "").trim();
  const user = chatter.toLowerCase();
  const say = (t: string) => sendChatMessages(t, broadcasterId);
  const { musterMs: MUSTER_MS, partyMax: RAID_PARTY_MAX } = await raidOpts(broadcasterId);

  if (sub === "cooldown" || sub === "cd") {
    if (arg) {
      if (!isModerator) {
        await say(`@${display} only the broadcaster or a moderator can change the raid cooldown.`);
        return true;
      }
      const seconds = parseCooldown(arg);
      if (seconds === null || seconds > MAX_RAID_COOLDOWN_SECONDS) {
        await say(`@${display} usage: !raid cooldown <time|off> — e.g. 90s, 10m, 1h or off (max ${waitText(MAX_RAID_COOLDOWN_SECONDS * 1000)}).`);
        return true;
      }
      await setRaidCooldownSeconds(broadcasterId, seconds);
      await say(seconds ? `@${display} raid cooldown set to ${waitText(seconds * 1000)} between raids.` : `@${display} raid cooldown is now off.`);
      return true;
    }
    const seconds = await getRaidCooldownSeconds(broadcasterId);
    const q = await getRaidQuest(broadcasterId);
    const wait = q ? await raidWaitMs(q) : 0;
    await say(
      `@${display} raid cooldown: ${seconds ? waitText(seconds * 1000) : "off"}. ${wait > 0 ? `Next raid can muster in ${waitText(wait)}.` : "A raid can muster now."}` +
        (isModerator ? " Change it with !raid cooldown <time|off>." : ""),
    );
    return true;
  }

  if (sub === "new") {
    if (!isModerator) {
      await say(`@${display} only the broadcaster or a moderator can post a new raid quest.`);
      return true;
    }
    const text = await createRaidQuest(broadcasterId, `manual:${Date.now()}`);
    if (text) await say(text);
    return true;
  }

  // Anything due goes first, so status and the horn see the current state.
  await maybeLaunchRaid(broadcasterId);
  const q = await getRaidQuest(broadcasterId);
  if (!q || q.status === "expired") {
    await say(`@${display} no raid quest is posted right now — one goes up on the guild board when the stream starts.`);
    return true;
  }
  if (q.status === "slain") {
    await say(`@${display} 🏆 this stream's raid quest is complete — ${q.monster_name} has been slain. A new one goes up next stream.`);
    return true;
  }
  const members = parseJson<Member[]>(q.muster_members, []);

  if (sub === "status") {
    const wait = await raidWaitMs(q);
    const muster = q.muster_ends_at
      ? `Muster open (${musterText(members, RAID_PARTY_MAX)}) — launches in ${waitText(Math.max(1000, q.muster_ends_at - Date.now()))}.`
      : wait > 0
      ? `Next raid can muster in ${waitText(wait)}.`
      : "Type !raid to sound the war horn.";
    await say(
      `@${display} 📯 Raid quest: ${q.monster_name} (CR ${q.monster_cr}, AC ${q.monster_ac}) HP ${q.monster_hp}/${q.monster_hp_max} after ${q.raids} raid${q.raids === 1 ? "" : "s"}. ${muster}`,
    );
    return true;
  }

  if (sub === "go" || sub === "launch") {
    if (!q.muster_ends_at) {
      await say(`@${display} no muster is open. Type !raid to sound the war horn.`);
      return true;
    }
    if (q.muster_leader !== user && !isModerator) {
      await say(`@${display} only the raid leader or a moderator can launch early.`);
      return true;
    }
    await maybeLaunchRaid(broadcasterId, { force: true });
    return true;
  }

  if (sub) {
    await say(`@${display} raid commands: !raid (sound the horn or join) | !raid go | !raid status | !raid cooldown${isModerator ? " [time|off] | !raid new" : ""}`);
    return true;
  }

  // Plain !raid: join the open muster, or open one.
  const c = await getCharacter(user, broadcasterId);
  if (!c) {
    await say(`@${display} you need a saved hero to join a raid — try !createchar first.`);
    return true;
  }

  if (q.muster_ends_at) {
    if (members.some((x) => x.u === user)) {
      await say(`@${display} you're already in the raid party (${musterText(members, RAID_PARTY_MAX)}).`);
      return true;
    }
    if (members.length >= RAID_PARTY_MAX) {
      await say(`@${display} the raid party is full — catch the next one.`);
      return true;
    }
    const next = [...members, { u: user, d: display }];
    const res = await sqlite.execute(
      "UPDATE raid_quests SET muster_members = ? WHERE broadcaster_id = ? AND muster_ends_at = ? AND muster_members = ?",
      [JSON.stringify(next), broadcasterId, q.muster_ends_at, q.muster_members],
    );
    const ok = await changed(res, async () => (await getRaidQuest(broadcasterId))?.muster_members === JSON.stringify(next));
    if (!ok) {
      await say(`@${display} the raid party shifted as you joined — type !raid again.`);
      return true;
    }
    if (next.length >= RAID_PARTY_MAX) {
      await say(`🛡️ ${display} joins — the raid party is full! (${musterText(next, RAID_PARTY_MAX)})`);
      await maybeLaunchRaid(broadcasterId, { force: true });
    } else {
      await say(`🛡️ ${display} joins the raid (${musterText(next, RAID_PARTY_MAX)}). Launching in ${waitText(Math.max(1000, q.muster_ends_at - Date.now()))}.`);
    }
    return true;
  }

  const wait = await raidWaitMs(q);
  if (wait > 0) {
    await say(`@${display} the raiders are still licking their wounds — the next raid can muster in ${waitText(wait)}. (!raid status)`);
    return true;
  }
  const endsAt = Date.now() + MUSTER_MS;
  const first = [{ u: user, d: display }];
  const res = await sqlite.execute(
    `UPDATE raid_quests SET muster_ends_at = ?, muster_leader = ?, muster_members = ?
     WHERE broadcaster_id = ? AND status = 'active' AND muster_ends_at = 0`,
    [endsAt, user, JSON.stringify(first), broadcasterId],
  );
  if (!(await changed(res, async () => (await getRaidQuest(broadcasterId))?.muster_ends_at === endsAt))) {
    await say(`@${display} someone just sounded the horn — type !raid again to join.`);
    return true;
  }
  if (RAID_PARTY_MAX <= 1) {
    await maybeLaunchRaid(broadcasterId, { force: true });
    return true;
  }
  await say(
    `📯 ${display} sounds the war horn against ${q.monster_name} (HP ${q.monster_hp}/${q.monster_hp_max})! ` +
      `Type !raid within ${waitText(MUSTER_MS)} to join the raid party (up to ${RAID_PARTY_MAX} heroes). ${display}: !raid go to charge early.`,
  );
  return true;
}

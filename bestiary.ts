// GuildScribe — the living bestiary: every monster a channel can hunt, and how
// those monsters learn. Two kinds of learning, both per channel:
//
// 1. The bestiary learns NEW monsters. A successful `!monster <name>` lookup of
//    a creature that isn't huntable yet pulls its stat block from the 5e API
//    into this channel's roster (`monster_learned`), so the next
//    `!dndduel <name>` / party hunt / autohunt / raid can meet it. Mods can
//    `!bestiary forget <name>` a learned monster (it stays blocked from being
//    re-learned) and `!bestiary learn <name>` to teach or un-block one.
//
// 2. Every monster ADAPTS from its fights (`monster_adaptation`). Each solo
//    duel, party hunt, autohunt bout and raid outcome nudges that species'
//    "pressure": heroes winning more often than the bot's designed odds for
//    their level pushes it up, the monster winning pushes it down. Pressure
//    decays a little every fight, so it tracks the channel's recent history.
//    The monster's adaptation tier (ADAPT_MIN_TIER…ADAPT_MAX_TIER) follows
//    the pressure with a one-point dead band, so it doesn't flap between two
//    tiers on every other fight: each tier is ±1 to hit and ±8% HP, and
//    every second tier also ±1 AC and ±1 damage. Adaptation is applied AFTER
//    level scaling and its caps, so it always takes effect.
//
// Every consumer of the bestiary goes through getChannelRoster(), so the pools
// (random encounters, named targets, raid bosses, the !bestiary page) are
// sized by whatever the channel's roster currently holds, not a fixed table.
//
//   !bestiary                    count + link to the web page
//   !bestiary <name>             one monster's stats, record and adaptation
//   !bestiary learn <name>       teach a monster from the 5e API (mods un-block)
//   !bestiary forget <name>      mod: remove + block a learned monster
//   !bestiary reset <name|all>   mod: clear adaptation back to tier 0

import { sqlite } from "./sqlite.ts";
import { findMonsterByName, pickMonsterForLevel, scaleMonsterForLevel, SOLO_MONSTERS, type SoloMonster } from "./data.ts";
import { lookup5e } from "./lookups.ts";
import { sendChatMessage } from "./twitch.ts";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Tier bounds. Positive = the monster has learned from its defeats. */
export const ADAPT_MAX_TIER = 5;
export const ADAPT_MIN_TIER = -3;
/** Share of old pressure kept each fight (memory of past fights). */
const PRESSURE_DECAY = 0.97;
/** Per-tier HP change. */
const HP_PER_TIER = 0.08;
/** Longest monster name the bestiary will learn. */
const MAX_NAME = 60;

/**
 * The win rate the bot is designed to give heroes of this level against a
 * level-scaled monster (see scaleMonsterForLevel: ~90% at L1 tapering to
 * ~65% at L20). Monsters only learn when heroes beat them MORE often than
 * this, so adaptation corrects outliers instead of grinding every fight
 * toward a coin flip.
 */
export function expectedHeroWinRate(level: number): number {
  const lv = Math.max(1, Math.min(20, Math.floor(level || 1)));
  return 0.9 - 0.25 * ((lv - 1) / 19);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function ensureBestiaryTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS monster_learned (
      broadcaster_id TEXT NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL,
      cr TEXT NOT NULL, cr_value REAL NOT NULL, ac INTEGER NOT NULL, hp INTEGER NOT NULL,
      attack INTEGER NOT NULL, die INTEGER NOT NULL, bonus INTEGER NOT NULL,
      api_index TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'learned',
      learned_by TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, name_key)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS monster_adaptation (
      broadcaster_id TEXT NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL,
      hero_wins INTEGER NOT NULL DEFAULT 0, monster_wins INTEGER NOT NULL DEFAULT 0,
      pressure REAL NOT NULL DEFAULT 0, tier INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, name_key)
    )`,
  );
}

export async function purgeBestiaryData(broadcasterId: string) {
  rosterCache.delete(broadcasterId);
  await sqlite.execute("DELETE FROM monster_learned WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM monster_adaptation WHERE broadcaster_id = ?", [broadcasterId]);
}

const keyOf = (name: string) => name.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Roster (core + learned)
// ---------------------------------------------------------------------------

export type HuntableMonster = SoloMonster & { learned?: { by: string; at: number } };

// Short per-isolate memo: the roster is read on every hunt, and learning or
// forgetting invalidates it immediately.
const ROSTER_TTL_MS = 30_000;
const rosterCache = new Map<string, { at: number; roster: HuntableMonster[] }>();

const crSort = (a: SoloMonster, b: SoloMonster) => a.crValue - b.crValue || a.name.localeCompare(b.name);

/** Every monster this channel can hunt: the core table plus everything it has
 * learned (a learned entry never shadows a core one), sorted by CR. */
export async function getChannelRoster(broadcasterId: string): Promise<HuntableMonster[]> {
  const hit = rosterCache.get(broadcasterId);
  if (hit && Date.now() - hit.at < ROSTER_TTL_MS) return hit.roster;
  let learned: HuntableMonster[] = [];
  try {
    const res = await sqlite.execute(
      "SELECT * FROM monster_learned WHERE broadcaster_id = ? AND status = 'learned'",
      [broadcasterId],
    );
    const core = new Set(SOLO_MONSTERS.map((m) => keyOf(m.name)));
    learned = res.rows
      .filter((r: any) => !core.has(String(r.name_key)))
      .map((r: any) => ({
        name: String(r.name),
        cr: String(r.cr),
        crValue: Number(r.cr_value),
        ac: Number(r.ac),
        hp: Number(r.hp),
        attack: Number(r.attack),
        die: Number(r.die),
        bonus: Number(r.bonus),
        learned: { by: String(r.learned_by ?? ""), at: Number(r.created_at) },
      }));
  } catch (e) {
    console.error("bestiary roster read failed", e); // never let this break a hunt
  }
  const roster = [...SOLO_MONSTERS, ...learned].sort(crSort);
  rosterCache.set(broadcasterId, { at: Date.now(), roster });
  return roster;
}

// ---------------------------------------------------------------------------
// Adaptation
// ---------------------------------------------------------------------------

export type AdaptationRecord = { heroWins: number; monsterWins: number; pressure: number; tier: number };

const clampTier = (t: number) => Math.max(ADAPT_MIN_TIER, Math.min(ADAPT_MAX_TIER, t));

/**
 * The tier after a pressure change, with a dead band: it only moves once the
 * pressure is a full point past the current tier (up to its floor, or down
 * to its ceiling), so noise around a boundary doesn't toggle it.
 */
export function nextTier(current: number, pressure: number): number {
  if (pressure >= current + 1) return clampTier(Math.floor(pressure));
  if (pressure <= current - 1) return clampTier(Math.ceil(pressure));
  return clampTier(current);
}

const rowToRecord = (r: any): AdaptationRecord => ({
  heroWins: Number(r.hero_wins ?? 0),
  monsterWins: Number(r.monster_wins ?? 0),
  pressure: Number(r.pressure ?? 0),
  tier: clampTier(Number(r.tier ?? 0)),
});

/** Every adaptation row for a channel, keyed by lowercase name. */
export async function getAdaptations(broadcasterId: string): Promise<Map<string, AdaptationRecord>> {
  const out = new Map<string, AdaptationRecord>();
  try {
    const res = await sqlite.execute("SELECT * FROM monster_adaptation WHERE broadcaster_id = ?", [broadcasterId]);
    for (const r of res.rows as any[]) out.set(String(r.name_key), rowToRecord(r));
  } catch (e) {
    console.error("bestiary adaptation read failed", e);
  }
  return out;
}

export async function getAdaptation(broadcasterId: string, name: string): Promise<AdaptationRecord> {
  try {
    const res = await sqlite.execute(
      "SELECT * FROM monster_adaptation WHERE broadcaster_id = ? AND name_key = ?",
      [broadcasterId, keyOf(name)],
    );
    if (res.rows[0]) return rowToRecord(res.rows[0]);
  } catch (e) {
    console.error("bestiary adaptation read failed", e);
  }
  return { heroWins: 0, monsterWins: 0, pressure: 0, tier: 0 };
}

/** What a tier does to a stat block, as signed deltas. */
export function tierEffects(tier: number) {
  const half = tier >= 0 ? Math.ceil(tier / 2) : -Math.ceil(-tier / 2);
  return { attack: tier, ac: half, bonus: half, hpPct: Math.round(tier * HP_PER_TIER * 100) };
}

/** "+2 to hit, +1 AC, +1 dmg, +16% HP" (empty for tier 0). */
export function describeTier(tier: number): string {
  if (!tier) return "";
  const e = tierEffects(tier);
  const s = (n: number) => (n < 0 ? `−${Math.abs(n)}` : `+${n}`);
  return [`${s(e.attack)} to hit`, e.ac ? `${s(e.ac)} AC` : "", e.bonus ? `${s(e.bonus)} dmg` : "", `${s(e.hpPct)}% HP`]
    .filter(Boolean).join(", ");
}

/** "+2" / "−1" / "0". */
export function signedTier(tier: number): string {
  return tier > 0 ? `+${tier}` : tier < 0 ? `−${Math.abs(tier)}` : "0";
}

/** Short tag for chat, e.g. " 🧠+2" (empty at tier 0). */
export function tierTag(tier: number): string {
  return tier ? ` 🧠${signedTier(tier)}` : "";
}

/** Apply a tier to an already level-scaled stat block. Runs after every cap
 * in scaleMonsterForLevel, so learning is never clamped away. */
export function applyAdaptation<T extends SoloMonster>(m: T, tier: number): T & { tier: number } {
  const e = tierEffects(tier);
  return {
    ...m,
    tier,
    attack: Math.max(0, m.attack + e.attack),
    ac: Math.max(5, m.ac + e.ac),
    bonus: Math.max(0, m.bonus + e.bonus),
    hp: Math.max(1, Math.round(m.hp * (1 + tier * HP_PER_TIER))),
  };
}

/**
 * Record one fight's outcome for a monster species and return a chat note
 * when its tier changed ("" otherwise). `level` is the hero's (or party's
 * average) level, which sets the expected win rate the monster learns
 * against. Never throws — a bookkeeping failure must not break a fight.
 */
export async function recordMonsterOutcome(
  broadcasterId: string,
  monsterName: string,
  heroesWon: boolean,
  level: number,
): Promise<string> {
  try {
    const before = await getAdaptation(broadcasterId, monsterName);
    const expected = expectedHeroWinRate(level);
    // Pressure is bounded a little past the tier caps so a long streak can't
    // bank so much that the monster takes ages to respond the other way.
    const raw = before.pressure * PRESSURE_DECAY + (heroesWon ? 1 - expected : -expected);
    const pressure = Math.max(ADAPT_MIN_TIER - 1, Math.min(ADAPT_MAX_TIER + 1, raw));
    const tier = nextTier(before.tier, pressure);
    await sqlite.execute(
      `INSERT INTO monster_adaptation (broadcaster_id, name_key, name, hero_wins, monster_wins, pressure, tier, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(broadcaster_id, name_key) DO UPDATE SET
         hero_wins = hero_wins + excluded.hero_wins, monster_wins = monster_wins + excluded.monster_wins,
         pressure = excluded.pressure, tier = excluded.tier, name = excluded.name, updated_at = excluded.updated_at`,
      [broadcasterId, keyOf(monsterName), monsterName, heroesWon ? 1 : 0, heroesWon ? 0 : 1, pressure, tier, Date.now()],
    );
    if (tier === before.tier) return "";
    const what = tier ? `${describeTier(tier)}` : "back to normal";
    if (tier > before.tier) {
      return ` 🧠 Word of its defeats spreads — the ${monsterName} has learned (adaptation ${signedTier(tier)}: ${what}).`;
    }
    return ` 🧠 Emboldened by its victories, the ${monsterName} grows careless (adaptation ${signedTier(tier)}: ${what}).`;
  } catch (e) {
    console.error("bestiary outcome failed", e);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Summoning (the one way every hunt picks its monster)
// ---------------------------------------------------------------------------

export type SummonedMonster = SoloMonster & { tier: number };

/**
 * The monster a hero of `level` meets: a named roster entry when `name` is
 * given (null if nothing matches), otherwise a random level-appropriate pick
 * from the whole roster. Level-scaled, then adapted.
 */
export async function summonMonster(
  broadcasterId: string,
  level: number,
  name?: string | null,
): Promise<SummonedMonster | null> {
  const roster = await getChannelRoster(broadcasterId);
  let scaled: SoloMonster;
  if (name) {
    const base = findMonsterByName(name, roster);
    if (!base) return null;
    scaled = scaleMonsterForLevel(base, level);
  } else {
    scaled = pickMonsterForLevel(level, roster);
  }
  const { tier } = await getAdaptation(broadcasterId, scaled.name);
  return applyAdaptation(stripMeta(scaled), tier);
}

/** Drop bestiary-only metadata before a stat block goes into a fight/table. */
export function stripMeta(m: SoloMonster): SoloMonster {
  return { name: m.name, cr: m.cr, crValue: m.crValue, ac: m.ac, hp: m.hp, attack: m.attack, die: m.die, bonus: m.bonus };
}

// ---------------------------------------------------------------------------
// Learning new monsters from the 5e API
// ---------------------------------------------------------------------------

function crText(cr: number): string {
  if (cr === 0.125) return "1/8";
  if (cr === 0.25) return "1/4";
  if (cr === 0.5) return "1/2";
  return String(cr);
}

/** 5e proficiency bonus by CR (used when an API entry lists no attack). */
function profForCr(cr: number): number {
  return 2 + Math.floor(Math.max(0, Math.ceil(cr) - 1) / 4);
}

/** Average of "2d6+3" style dice, plus the parts. */
function parseDice(text: string): { count: number; sides: number; mod: number } | null {
  const m = String(text ?? "").replace(/\s+/g, "").match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  return { count: Number(m[1]), sides: Number(m[2]), mod: Number(m[3] ?? 0) };
}
const avg = (d: { count: number; sides: number; mod: number }) => (d.count * (d.sides + 1)) / 2 + d.mod;

/**
 * Convert a dnd5eapi monster into the bot's one-swing stat block: the attack
 * action with the best average damage sets the to-hit and damage. Multi-dice
 * damage is folded into one die (capped at d20) plus a bonus with the same
 * average, the way the core table was built. Null if the entry has no usable
 * HP/AC/CR.
 */
export function statBlockFromApi(data: any): SoloMonster | null {
  const name = String(data?.name ?? "").trim();
  const cr = Number(data?.challenge_rating);
  const hp = Number(data?.hit_points);
  const acRaw = Array.isArray(data?.armor_class) ? data.armor_class[0]?.value : data?.armor_class;
  const ac = Number(acRaw);
  if (!name || name.length > MAX_NAME || !Number.isFinite(cr) || cr < 0 || !(hp > 0) || !(ac > 0)) return null;

  let best: { attack: number; dmgAvg: number; first: { count: number; sides: number; mod: number } } | null = null;
  for (const a of Array.isArray(data?.actions) ? data.actions : []) {
    if (/multiattack/i.test(String(a?.name ?? ""))) continue;
    const parts = (Array.isArray(a?.damage) ? a.damage : [])
      .map((d: any) => parseDice(d?.damage_dice ?? d?.from?.options?.[0]?.damage_dice ?? ""))
      .filter(Boolean) as Array<{ count: number; sides: number; mod: number }>;
    if (!parts.length) continue;
    const dmgAvg = parts.reduce((t, p) => t + avg(p), 0);
    const attack = Number.isFinite(Number(a?.attack_bonus)) ? Number(a.attack_bonus) : profForCr(cr) + 3;
    if (!best || dmgAvg > best.dmgAvg) best = { attack, dmgAvg, first: parts[0] };
  }

  let die: number;
  let bonus: number;
  let attack: number;
  if (best) {
    // One die worth the first damage part's dice, capped to a d20.
    die = Math.max(4, Math.min(20, best.first.count * best.first.sides));
    bonus = Math.max(0, Math.round(best.dmgAvg - (die + 1) / 2));
    attack = best.attack;
  } else {
    // No attack listed (e.g. a pure caster): a plain CR-appropriate swing.
    die = 6;
    attack = profForCr(cr) + 3;
    bonus = Math.max(1, Math.round(cr * 1.5));
  }
  return { name, cr: crText(cr), crValue: cr, ac: Math.round(ac), hp: Math.round(hp), attack: Math.round(attack), die, bonus };
}

export type LearnResult =
  | { kind: "learned"; monster: SoloMonster }
  | { kind: "known"; monster: SoloMonster }
  | { kind: "blocked"; name: string }
  | { kind: "unusable" };

/**
 * Teach the channel a monster from a 5e API stat block (the `!monster`
 * lookup result). Known (core or already learned) monsters are left alone,
 * and one a mod forgot stays forgotten unless `force` (a mod's
 * `!bestiary learn`).
 */
export async function learnMonsterFromApi(
  broadcasterId: string,
  data: any,
  learnedBy: string,
  force = false,
): Promise<LearnResult> {
  const block = statBlockFromApi(data);
  if (!block) return { kind: "unusable" };
  const key = keyOf(block.name);
  const core = SOLO_MONSTERS.find((m) => keyOf(m.name) === key);
  if (core) return { kind: "known", monster: core };
  const existing = await sqlite.execute(
    "SELECT status FROM monster_learned WHERE broadcaster_id = ? AND name_key = ?",
    [broadcasterId, key],
  );
  const status = String((existing.rows[0] as any)?.status ?? "");
  if (status === "learned") return { kind: "known", monster: block };
  if (status === "blocked" && !force) return { kind: "blocked", name: block.name };
  await sqlite.execute(
    `INSERT OR REPLACE INTO monster_learned
      (broadcaster_id, name_key, name, cr, cr_value, ac, hp, attack, die, bonus, api_index, status, learned_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'learned',?,?)`,
    [broadcasterId, key, block.name, block.cr, block.crValue, block.ac, block.hp, block.attack, block.die, block.bonus,
      String(data?.index ?? ""), learnedBy, Date.now()],
  );
  rosterCache.delete(broadcasterId);
  return { kind: "learned", monster: block };
}

/** One line for a monster's huntable stat block (base, before level scaling). */
export function statLine(m: SoloMonster): string {
  return `CR ${m.cr}, AC ${m.ac}, HP ${m.hp}, +${m.attack} to hit, 1d${m.die}${m.bonus ? `+${m.bonus}` : ""}`;
}

/**
 * Hook for the `!monster` lookup (chat_builtin.ts): learns the looked-up
 * creature if it's new to this channel and returns a short note to append to
 * the lookup reply ("" when nothing was learned). Never throws.
 */
export async function maybeLearnFromLookup(broadcasterId: string, data: any, learnedBy: string): Promise<string> {
  try {
    const r = await learnMonsterFromApi(broadcasterId, data, learnedBy);
    if (r.kind !== "learned") return "";
    return ` 📖 New to the bestiary! ${r.monster.name} (${statLine(r.monster)}) now stalks the wilds — hunt it with !dndduel ${r.monster.name.toLowerCase()}.`;
  } catch (e) {
    console.error("bestiary learn failed", e);
    return "";
  }
}

// ---------------------------------------------------------------------------
// !bestiary
// ---------------------------------------------------------------------------

export function bestiaryUrl(baseUrl: string, broadcasterId: string) {
  return `${baseUrl}/bestiary?channel=${encodeURIComponent(broadcasterId)}`;
}

export async function handleBestiaryCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
  baseUrl: string,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!bestiary(?:\s+(.*))?$/i);
  if (!m) return false;
  const rest = (m[1] ?? "").trim();
  const say = (text: string) => sendChatMessage(`@${display} ${text}`, broadcasterId);
  const url = bestiaryUrl(baseUrl, broadcasterId);

  if (!rest) {
    const roster = await getChannelRoster(broadcasterId);
    const learned = roster.filter((x) => (x as HuntableMonster).learned).length;
    const adapt = await getAdaptations(broadcasterId);
    const adapted = [...adapt.values()].filter((a) => a.tier !== 0).length;
    const low = roster[0]?.cr ?? "?";
    const high = roster[roster.length - 1]?.cr ?? "?";
    await say(
      `📖 ${roster.length} monsters can be hunted here (CR ${low}–${high}; ${roster.length - learned} core, ${learned} learned${adapted ? `, ${adapted} adapting` : ""}). ` +
        `Full list: ${url} — look one up with !bestiary <name>; !monster <name> teaches the bestiary new ones.`,
    );
    return true;
  }

  const sub = rest.match(/^(learn|forget|reset)(?:\s+(.+))?$/i);
  if (sub) {
    const action = sub[1].toLowerCase();
    const arg = (sub[2] ?? "").trim();
    if (action !== "learn" && !isModerator) {
      await say(`only the broadcaster or a moderator can ${action} bestiary entries.`);
      return true;
    }
    if (!arg) {
      await say(`usage: !bestiary ${action} <monster>${action === "reset" ? " | all" : ""}`);
      return true;
    }
    if (action === "learn") {
      if (arg.length > MAX_NAME) {
        await say("that name is too long for the bestiary.");
        return true;
      }
      const data = await lookup5e("monster", arg);
      if (!data) {
        await say(`the sages know no monster called "${arg}". Check the spelling with !monster <name>.`);
        return true;
      }
      const r = await learnMonsterFromApi(broadcasterId, data, chatter, isModerator);
      if (r.kind === "learned") await say(`📖 ${r.monster.name} (${statLine(r.monster)}) is now in the bestiary — hunt it with !dndduel ${r.monster.name.toLowerCase()}.`);
      else if (r.kind === "known") await say(`${r.monster.name} is already in the bestiary.`);
      else if (r.kind === "blocked") await say(`a moderator struck ${r.name} from the bestiary; only a mod can teach it again.`);
      else await say(`${String(data.name ?? arg)} has no stat block the arena can use.`);
      return true;
    }
    if (action === "forget") {
      const key = keyOf(arg);
      if (SOLO_MONSTERS.some((x) => keyOf(x.name) === key)) {
        await say(`${arg} is a core monster and can't be forgotten.`);
        return true;
      }
      const roster = await getChannelRoster(broadcasterId);
      const hit = roster.find((x) => (x as HuntableMonster).learned && keyOf(x.name) === key);
      const name = hit?.name ?? arg;
      // Blocks it even if it was never learned, so a lookup won't add it later.
      await sqlite.execute(
        `INSERT INTO monster_learned (broadcaster_id, name_key, name, cr, cr_value, ac, hp, attack, die, bonus, status, learned_by, created_at)
         VALUES (?,?,?,'0',0,10,1,0,4,0,'blocked',?,?)
         ON CONFLICT(broadcaster_id, name_key) DO UPDATE SET status = 'blocked'`,
        [broadcasterId, key, name, chatter, Date.now()],
      );
      await sqlite.execute("DELETE FROM monster_adaptation WHERE broadcaster_id = ? AND name_key = ?", [broadcasterId, key]);
      rosterCache.delete(broadcasterId);
      await say(hit ? `${name} is struck from the bestiary and won't be re-learned (a mod can !bestiary learn ${name.toLowerCase()}).` : `"${arg}" wasn't a learned monster, but it's now blocked from being learned.`);
      return true;
    }
    // reset
    if (arg.toLowerCase() === "all") {
      await sqlite.execute("DELETE FROM monster_adaptation WHERE broadcaster_id = ?", [broadcasterId]);
      await say("every monster forgets what it learned — all adaptation is back to 0.");
    } else {
      const base = findMonsterByName(arg, await getChannelRoster(broadcasterId));
      if (!base) {
        await say(`no bestiary match for "${arg}".`);
        return true;
      }
      await sqlite.execute("DELETE FROM monster_adaptation WHERE broadcaster_id = ? AND name_key = ?", [broadcasterId, keyOf(base.name)]);
      await say(`${base.name} forgets what it learned — adaptation back to 0.`);
    }
    return true;
  }

  // !bestiary <name>
  const roster = await getChannelRoster(broadcasterId);
  const base = findMonsterByName(rest, roster) as HuntableMonster | undefined;
  if (!base) {
    await say(`no huntable monster matches "${rest}". !monster ${rest} looks it up (and teaches the bestiary if it's new). Full list: ${url}`);
    return true;
  }
  const a = await getAdaptation(broadcasterId, base.name);
  const origin = base.learned ? `learned${base.learned.by ? ` from ${base.learned.by}` : ""}` : "core";
  const record = a.heroWins + a.monsterWins
    ? ` Record here: heroes ${a.heroWins} – ${base.name} ${a.monsterWins}.`
    : " Never fought here yet.";
  const learning = a.tier
    ? ` 🧠 Adaptation ${signedTier(a.tier)}: ${describeTier(a.tier)}.`
    : "";
  await say(`📖 ${base.name} (${origin}): ${statLine(base)} before level scaling.${record}${learning} Hunt: !dndduel ${base.name.toLowerCase()}`);
  return true;
}

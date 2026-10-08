// Pokéball advisor storage — the balls the advisor knows (pokeball.ts picks
// from these, pokeball_page.ts edits them). Own tables:
//
//   pokeball_settings  module on/off per channel (off by default)
//   pokeball_balls     ball rows. Rows under GLOBAL ("*") are ball
//                      definitions shared by every channel: balls a mod
//                      added or taught, and edits of a core ball (same key).
//                      Rows under a channel id are that channel's own state:
//                      "pending" balls its chat used that nobody has taught
//                      yet, and "off" for a ball the channel turned off.
//
// Core balls (CORE_BALLS) are built in, like the bestiary's core monsters;
// a global row with the same key replaces one, and deleting that row puts
// the core ball back.

import { sqlite } from "./sqlite.ts";

/** How a ball decides whether it helps against a Pokémon. */
export type BallRule =
  | "always" //   works on anything at its catch bonus
  | "types" //    bonus against the listed types (value: "water,bug")
  | "heavy" //    bonus at value+ kg
  | "weight" //   catch bonus scales with weight (value: "100:30,200:55,300:80" — kg+:%; below the first, the ball's own bonus)
  | "fast" //     bonus at base Speed value+
  | "hardcatch" // bonus at catch rate value or lower
  | "easycatch" // bonus at catch rate value or higher
  | "legendary" // bonus against legendary/mythical Pokémon
  | "timing" //   depends on when it's thrown (Quick, Timer) — offered as the alternative
  | "unknown"; // seen in chat, not taught yet

export const BALL_RULES: Record<BallRule, { label: string; value?: string }> = {
  always: { label: "Works on anything" },
  types: { label: "Better against types", value: "types, e.g. water, bug" },
  heavy: { label: "Better against heavy Pokémon", value: "minimum weight in kg" },
  weight: { label: "Scales with weight", value: "kg:catch % steps, e.g. 100:30, 200:55, 300:80" },
  fast: { label: "Better against fast Pokémon", value: "minimum base Speed" },
  hardcatch: { label: "Better against hard catches", value: "catch rate at or below (0–255)" },
  easycatch: { label: "Better against easy catches", value: "catch rate at or above (0–255)" },
  legendary: { label: "Better against legendaries" },
  timing: { label: "Depends on timing (suggested as the alternative)" },
  unknown: { label: "Unknown — not taught yet" },
};

export const POKEMON_TYPES = [
  "normal", "fire", "water", "grass", "electric", "ice", "fighting", "poison", "ground",
  "flying", "psychic", "bug", "rock", "ghost", "dragon", "dark", "steel", "fairy",
];

export type BallStatus = "active" | "pending" | "off";

export interface Ball {
  key: string; //     "netball" — what !pokecatch takes, spaces and punctuation removed
  name: string; //    "Net Ball"
  rule: BallRule;
  value: string; //   rule parameter (types list or a number), "" when the rule has none
  pct: number; //     catch bonus: the % chance to catch when the rule applies (Poké Ball 30)
  note: string; //    shown on the page and, for timing balls, in chat
  status: BallStatus;
  origin: "core" | "custom" | "override" | "asked";
  seen: number; //    times chat used/mentioned it (pending balls)
  askedBy: string;
  updatedAt: number;
}

const core = (name: string, rule: BallRule, value: string, pct: number, note: string): Ball => ({
  key: ballKey(name), name, rule, value, pct, note, status: "active", origin: "core", seen: 0, askedBy: "", updatedAt: 0,
});

/** Built-in balls, with Pokémon Community Game catch bonuses. Mods can edit any of them. */
export const CORE_BALLS: Ball[] = [
  core("Poké Ball", "always", "", 30, "The basic ball."),
  core("Premier Ball", "always", "", 30, "Same as a Poké Ball."),
  core("Cherish Ball", "always", "", 30, ""),
  core("Great Ball", "always", "", 55, ""),
  core("Ultra Ball", "always", "", 80, ""),
  core("Master Ball", "legendary", "", 100, "Never fails — saved for legendaries."),
  core("Net Ball", "types", "water,bug", 80, ""),
  core("Heavy Ball", "weight", "100:40,200:70,300:90", 20, "Weaker on light Pokémon."),
  core("Fast Ball", "fast", "100", 80, ""),
  core("Quick Ball", "timing", "", 80, "Best thrown right away."),
];

/** The broadcaster_id of ball definitions every channel shares. */
const GLOBAL = "*";

/** A "weight" ball's steps, lightest first: "100:30, 200:55" → [{kg:100,pct:30},{kg:200,pct:55}]. Bad entries are skipped. */
export function weightSteps(value: string): { kg: number; pct: number }[] {
  return value.split(/[\s,]+/).map((part) => part.split(":").map(Number))
    .filter(([kg, pct]) => Number.isFinite(kg) && Number.isFinite(pct) && kg >= 0 && pct > 0 && pct <= 100)
    .map(([kg, pct]) => ({ kg, pct }))
    .sort((a, b) => a.kg - b.kg);
}

/** "Net Ball", "netball", "net" → "netball". */
export function ballKey(raw: string): string {
  const k = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!k) return "";
  return k.endsWith("ball") ? k : `${k}ball`;
}

/** "duskball" → "Dusk Ball" (a display name for a ball we only know by its key). */
export function ballNameFromKey(key: string): string {
  const stem = key.replace(/ball$/, "");
  if (stem === "poke") return "Poké Ball";
  return `${stem.charAt(0).toUpperCase()}${stem.slice(1)} Ball`;
}

export async function ensurePokeballTables() {
  await sqlite.batch([
    `CREATE TABLE IF NOT EXISTS pokeball_settings (broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS pokeball_balls (
      broadcaster_id TEXT NOT NULL, ball_key TEXT NOT NULL, name TEXT NOT NULL,
      rule TEXT NOT NULL, value TEXT NOT NULL DEFAULT '', mult REAL NOT NULL DEFAULT 1,
      note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      seen INTEGER NOT NULL DEFAULT 0, asked_by TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      catch_pct REAL,
      PRIMARY KEY (broadcaster_id, ball_key)
    )`,
  ]);
  // Tables created before catch bonuses replaced multipliers (catch_pct stays
  // NULL on old rows; rowToBall converts their multiplier).
  try {
    await sqlite.execute(`ALTER TABLE pokeball_balls ADD COLUMN catch_pct REAL`);
  } catch (_) {
    /* column already exists */
  }
  // Balls channels added before balls were shared: copy them to the shared
  // list (newest edit wins), and leave only an "off" marker behind. Old
  // per-channel copies of core balls are dropped so the built-in catch
  // bonuses apply.
  const old = await sqlite.execute(
    `SELECT * FROM pokeball_balls WHERE broadcaster_id != ? AND status != 'pending' AND rule != 'unknown' ORDER BY updated_at`,
    [GLOBAL],
  );
  if (!old.rows.length) return;
  const stmts: { sql: string; args: any[] }[] = [];
  for (const r of old.rows as any[]) {
    const b = rowToBall(r);
    if (!coreByKey.has(b.key)) stmts.push({
      sql: `INSERT INTO pokeball_balls (broadcaster_id, ball_key, name, rule, value, mult, catch_pct, note, status, updated_at) VALUES (?,?,?,?,?,1,?,?,'active',?)
            ON CONFLICT(broadcaster_id, ball_key) DO UPDATE SET name = excluded.name, rule = excluded.rule, value = excluded.value,
              catch_pct = excluded.catch_pct, note = excluded.note, updated_at = excluded.updated_at`,
      args: [GLOBAL, b.key, b.name, b.rule, b.value, b.pct, b.note, b.updatedAt],
    });
    stmts.push(b.status === "off"
      ? { sql: `UPDATE pokeball_balls SET rule = 'unknown' WHERE broadcaster_id = ? AND ball_key = ?`, args: [r.broadcaster_id, b.key] }
      : { sql: `DELETE FROM pokeball_balls WHERE broadcaster_id = ? AND ball_key = ?`, args: [r.broadcaster_id, b.key] });
  }
  await sqlite.batch(stmts);
}

export async function purgePokeballData(broadcasterId: string) {
  await sqlite.batch(
    ["pokeball_settings", "pokeball_balls"].map((t) => ({ sql: `DELETE FROM ${t} WHERE broadcaster_id = ?`, args: [broadcasterId] })),
  );
}

export async function isPokeballEnabled(broadcasterId: string): Promise<boolean> {
  const res = await sqlite.execute("SELECT enabled FROM pokeball_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length > 0 && Number(res.rows[0].enabled) === 1;
}

export async function setPokeballEnabled(broadcasterId: string, enabled: boolean) {
  await sqlite.execute("INSERT OR REPLACE INTO pokeball_settings (broadcaster_id, enabled, updated_at) VALUES (?,?,?)", [
    broadcasterId,
    enabled ? 1 : 0,
    Date.now(),
  ]);
}

const coreByKey = new Map(CORE_BALLS.map((b) => [b.key, b]));
export const isCoreBall = (key: string) => coreByKey.has(key);

function rowToBall(r: any): Ball {
  const key = String(r.ball_key);
  const status = (["active", "pending", "off"].includes(String(r.status)) ? String(r.status) : "active") as BallStatus;
  // Rows from before catch bonuses hold a multiplier (1 = Poké Ball = 30%).
  const pct = r.catch_pct != null ? Number(r.catch_pct) : Math.min(100, Math.round(Number(r.mult ?? 1) * 30));
  return {
    key,
    name: String(r.name),
    rule: (String(r.rule) in BALL_RULES ? String(r.rule) : "unknown") as BallRule,
    value: String(r.value ?? ""),
    pct,
    note: String(r.note ?? ""),
    status,
    origin: coreByKey.has(key) ? "override" : status === "pending" ? "asked" : "custom",
    seen: Number(r.seen ?? 0),
    askedBy: String(r.asked_by ?? ""),
    updatedAt: Number(r.updated_at ?? 0),
  };
}

/** Every ball this channel sees — core balls, the shared list, then the
 * channel's own pending and turned-off balls — sorted by name. */
export async function listBalls(broadcasterId: string): Promise<Ball[]> {
  const res = await sqlite.execute("SELECT * FROM pokeball_balls WHERE broadcaster_id IN (?, ?)", [GLOBAL, broadcasterId]);
  const rows = res.rows as any[];
  const out = new Map(CORE_BALLS.map((b) => [b.key, b]));
  for (const r of rows) if (r.broadcaster_id === GLOBAL) out.set(String(r.ball_key), rowToBall(r));
  for (const r of rows) {
    if (r.broadcaster_id === GLOBAL) continue;
    const key = String(r.ball_key);
    const known = out.get(key);
    if (String(r.status) === "off") {
      if (known) out.set(key, { ...known, status: "off" });
    } else if (!known) {
      out.set(key, rowToBall(r)); // pending: nobody has taught it yet
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Add or replace a ball for every channel (also how a pending ball gets
 * taught). Clears this channel's pending/off row for it. */
export async function saveBall(broadcasterId: string, b: Pick<Ball, "key" | "name" | "rule" | "value" | "pct" | "note">) {
  await sqlite.batch([
    {
      sql: `INSERT INTO pokeball_balls (broadcaster_id, ball_key, name, rule, value, mult, catch_pct, note, status, updated_at) VALUES (?,?,?,?,?,1,?,?,'active',?)
            ON CONFLICT(broadcaster_id, ball_key) DO UPDATE SET name = excluded.name, rule = excluded.rule, value = excluded.value,
              catch_pct = excluded.catch_pct, note = excluded.note, status = 'active', updated_at = excluded.updated_at`,
      args: [GLOBAL, b.key, b.name, b.rule, b.value, b.pct, b.note, Date.now()],
    },
    { sql: "DELETE FROM pokeball_balls WHERE broadcaster_id = ? AND ball_key = ?", args: [broadcasterId, b.key] },
  ]);
}

/** Turn a ball on or off in this channel only. */
export async function setBallStatus(broadcasterId: string, key: string, status: "active" | "off"): Promise<boolean> {
  const existing = (await listBalls(broadcasterId)).find((b) => b.key === key);
  if (!existing || existing.status === "pending") return false;
  if (status === "active") {
    await sqlite.execute("DELETE FROM pokeball_balls WHERE broadcaster_id = ? AND ball_key = ?", [broadcasterId, key]);
  } else {
    // rule 'unknown' marks it as a marker row, not a definition.
    await sqlite.execute(
      `INSERT OR REPLACE INTO pokeball_balls (broadcaster_id, ball_key, name, rule, value, mult, note, status, updated_at) VALUES (?,?,?,'unknown','',1,'','off',?)`,
      [broadcasterId, key, existing.name, Date.now()],
    );
  }
  return true;
}

/** Dismiss a pending ball (this channel), or delete a shared ball for every
 * channel: an added ball is gone, an edited core ball goes back to built-in. */
export async function deleteBall(broadcasterId: string, key: string): Promise<boolean> {
  const own = await sqlite.execute("SELECT status FROM pokeball_balls WHERE broadcaster_id = ? AND ball_key = ?", [broadcasterId, key]);
  if (own.rows.length && String((own.rows[0] as any).status) === "pending") {
    await sqlite.execute("DELETE FROM pokeball_balls WHERE broadcaster_id = ? AND ball_key = ?", [broadcasterId, key]);
    return true;
  }
  const res = await sqlite.execute("DELETE FROM pokeball_balls WHERE broadcaster_id = ? AND ball_key = ?", [GLOBAL, key]);
  if (!coreByKey.has(key)) {
    // The ball is gone everywhere — drop every channel's "off" marker for it too.
    await sqlite.execute("DELETE FROM pokeball_balls WHERE ball_key = ? AND status = 'off'", [key]);
  }
  return Number(res.rowsAffected ?? 0) > 0;
}

/**
 * Note a ball chat used that nobody has taught. Returns true the first time
 * in this channel (the caller asks chat about it then); later sightings only
 * bump the counter. Known balls (core or shared) are left alone.
 */
export async function recordUnknownBall(broadcasterId: string, key: string, askedBy: string): Promise<boolean> {
  if (coreByKey.has(key)) return false;
  const shared = await sqlite.execute("SELECT 1 FROM pokeball_balls WHERE broadcaster_id = ? AND ball_key = ?", [GLOBAL, key]);
  if (shared.rows.length) return false;
  const res = await sqlite.execute(
    `INSERT INTO pokeball_balls (broadcaster_id, ball_key, name, rule, value, mult, note, status, seen, asked_by, updated_at)
     VALUES (?,?,?,'unknown','',1,'','pending',1,?,?) ON CONFLICT(broadcaster_id, ball_key) DO NOTHING`,
    [broadcasterId, key, ballNameFromKey(key), askedBy, Date.now()],
  );
  if (Number(res.rowsAffected ?? 0) > 0) return true;
  await sqlite.execute(
    "UPDATE pokeball_balls SET seen = seen + 1 WHERE broadcaster_id = ? AND ball_key = ? AND status = 'pending'",
    [broadcasterId, key],
  );
  return false;
}

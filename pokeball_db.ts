// Pokéball advisor storage — the balls each channel knows (pokeball.ts picks
// from these, pokeball_page.ts edits them). Own tables, keyed by channel:
//
//   pokeball_settings  module on/off (off by default)
//   pokeball_balls     the channel's own balls: added on the dashboard page,
//                      overrides of a core ball (same key), or "pending" ones
//                      the advisor saw in chat and doesn't know yet
//
// Core balls (CORE_BALLS) are built in, like the bestiary's core monsters;
// a channel row with the same key replaces one, and deleting that row puts
// the core ball back.

import { sqlite } from "./sqlite.ts";

/** How a ball decides whether it helps against a Pokémon. */
export type BallRule =
  | "always" //   works on anything at its multiplier
  | "types" //    bonus against the listed types (value: "water,bug")
  | "heavy" //    bonus at value+ kg
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
  mult: number; //    catch multiplier when the rule applies (1 = Poké Ball)
  note: string; //    shown on the page and, for timing balls, in chat
  status: BallStatus;
  origin: "core" | "custom" | "override" | "asked";
  seen: number; //    times chat used/mentioned it (pending balls)
  askedBy: string;
  updatedAt: number;
}

const core = (name: string, rule: BallRule, value: string, mult: number, note: string): Ball => ({
  key: ballKey(name), name, rule, value, mult, note, status: "active", origin: "core", seen: 0, askedBy: "", updatedAt: 0,
});

/** Built-in balls, with mainline-game multipliers. Channels can override any of them. */
export const CORE_BALLS: Ball[] = [
  core("Poké Ball", "always", "", 1, "The basic ball."),
  core("Premier Ball", "always", "", 1, "Same as a Poké Ball."),
  core("Great Ball", "always", "", 1.5, ""),
  core("Ultra Ball", "always", "", 2, ""),
  core("Master Ball", "legendary", "", 255, "Never fails — saved for legendaries."),
  core("Net Ball", "types", "water,bug", 3.5, ""),
  core("Heavy Ball", "heavy", "200", 2, ""),
  core("Fast Ball", "fast", "100", 4, ""),
  core("Quick Ball", "timing", "", 5, "Best thrown right away."),
];

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
      PRIMARY KEY (broadcaster_id, ball_key)
    )`,
  ]);
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

/** Every ball this channel knows about — core balls merged with its own rows
 * (overrides, custom, pending, off) — sorted by name. */
export async function listBalls(broadcasterId: string): Promise<Ball[]> {
  const res = await sqlite.execute("SELECT * FROM pokeball_balls WHERE broadcaster_id = ?", [broadcasterId]);
  const out = new Map(CORE_BALLS.map((b) => [b.key, b]));
  for (const r of res.rows as any[]) {
    const key = String(r.ball_key);
    const status = (["active", "pending", "off"].includes(String(r.status)) ? String(r.status) : "active") as BallStatus;
    out.set(key, {
      key,
      name: String(r.name),
      rule: (String(r.rule) in BALL_RULES ? String(r.rule) : "unknown") as BallRule,
      value: String(r.value ?? ""),
      mult: Number(r.mult ?? 1),
      note: String(r.note ?? ""),
      status,
      origin: coreByKey.has(key) ? "override" : status === "pending" ? "asked" : "custom",
      seen: Number(r.seen ?? 0),
      askedBy: String(r.asked_by ?? ""),
      updatedAt: Number(r.updated_at ?? 0),
    });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Add or replace a channel ball (also how a pending ball gets taught). */
export async function saveBall(broadcasterId: string, b: Pick<Ball, "key" | "name" | "rule" | "value" | "mult" | "note" | "status">) {
  await sqlite.execute(
    `INSERT INTO pokeball_balls (broadcaster_id, ball_key, name, rule, value, mult, note, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(broadcaster_id, ball_key) DO UPDATE SET name = excluded.name, rule = excluded.rule, value = excluded.value,
       mult = excluded.mult, note = excluded.note, status = excluded.status, updated_at = excluded.updated_at`,
    [broadcasterId, b.key, b.name, b.rule, b.value, b.mult, b.note, b.status, Date.now()],
  );
}

/** Turn a ball on or off. A core ball with no row gets one (a copy of the core entry). */
export async function setBallStatus(broadcasterId: string, key: string, status: "active" | "off"): Promise<boolean> {
  const existing = (await listBalls(broadcasterId)).find((b) => b.key === key);
  if (!existing || existing.status === "pending") return false;
  await saveBall(broadcasterId, { ...existing, status });
  return true;
}

/** Delete the channel's row: a custom ball is gone, an override goes back to the core ball. */
export async function deleteBall(broadcasterId: string, key: string): Promise<boolean> {
  const res = await sqlite.execute("DELETE FROM pokeball_balls WHERE broadcaster_id = ? AND ball_key = ?", [broadcasterId, key]);
  return Number(res.rowsAffected ?? 0) > 0;
}

/**
 * Note a ball chat used that this channel doesn't know. Returns true the
 * first time (the caller asks chat about it then); later sightings only
 * bump the counter. Known balls (core, custom, off) are left alone.
 */
export async function recordUnknownBall(broadcasterId: string, key: string, askedBy: string): Promise<boolean> {
  if (coreByKey.has(key)) return false;
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

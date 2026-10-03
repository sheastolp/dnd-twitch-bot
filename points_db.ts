// Persistence for points.ts — the coin (points) economy, its leaderboard, and
// giveaways. Every amount in this file is an integer number of COPPER (see
// coins.ts; 100 cp = 1 gp). Split out of db.ts (already near Val Town's per-file size cap),
// same as social_db.ts / ads_db.ts. Mirrors db.ts's conventions: every row is
// scoped by broadcaster_id, usernames are stored lowercase, and "no row"
// means the default (here: points ON — a mod can switch it off).

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

export async function ensurePointsTables() {
  // Per-channel on/off switch for the whole points + giveaway system.
  // ON by default (no row = enabled, same "absence means default" pattern as
  // command_toggles); a mod turns it off with !gold off or the dashboard.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS points_settings (
      broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
    )`,
  );
  // One balance row per (channel, viewer); balance is in copper. last_earn_at drives the
  // per-viewer chat-earning cooldown so it survives cold starts.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS points_balances (
      broadcaster_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0,
      last_earn_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (broadcaster_id, username)
    )`,
  );
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_points_balances_rank ON points_balances(broadcaster_id, balance DESC)`,
  );
  // At most one giveaway per channel (open, or closed-with-winner until the
  // next !giveaway start overwrites it). winners is a JSON array of
  // lowercase usernames so a reroll can exclude everyone already drawn.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS giveaways (
      broadcaster_id TEXT PRIMARY KEY,
      prize TEXT NOT NULL,
      cost INTEGER NOT NULL DEFAULT 0,
      max_tickets INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'open',
      started_by TEXT,
      started_at INTEGER,
      winners TEXT NOT NULL DEFAULT '[]',
      closed_at INTEGER
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS giveaway_entries (
      broadcaster_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      tickets INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (broadcaster_id, username)
    )`,
  );
  // !rob cooldowns (rob.ts): when a player last robbed someone, and when
  // they were last targeted, so robbing can't be spammed or dogpiled.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS rob_cooldowns (
      broadcaster_id TEXT NOT NULL,
      username TEXT NOT NULL,
      robber_at INTEGER NOT NULL DEFAULT 0,
      victim_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (broadcaster_id, username)
    )`,
  );
  await migrateToCopper();
}

/** One-time migration: the first version of this feature counted whole
 * "gold" (1 per chat message). Balances and giveaway prices are now copper,
 * so anything written by that version is multiplied by 100 (1 old gold ->
 * 100 cp = 1 gp), preserving everyone's value. A fresh install runs this on
 * empty tables, which is a no-op, and records the marker so it never runs
 * again. */
export async function migrateToCopper() {
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS points_migrations (name TEXT PRIMARY KEY, ran_at INTEGER)`);
  const done = await sqlite.execute("SELECT 1 FROM points_migrations WHERE name = 'coins_v1'");
  if (done.rows.length) return;
  await sqlite.execute("INSERT OR IGNORE INTO points_migrations (name, ran_at) VALUES ('coins_v1', ?)", [Date.now()]);
  await sqlite.execute("UPDATE points_balances SET balance = balance * 100");
  await sqlite.execute("UPDATE giveaways SET cost = cost * 100");
}

// ── Master toggle ──

export async function isPointsEnabled(broadcasterId: string): Promise<boolean> {
  const res = await sqlite.execute("SELECT enabled FROM points_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return !res.rows.length || Number(res.rows[0].enabled) === 1;
}

export async function setPointsEnabled(broadcasterId: string, enabled: boolean) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO points_settings (broadcaster_id, enabled, updated_at) VALUES (?,?,?)",
    [broadcasterId, enabled ? 1 : 0, Date.now()],
  );
}

// ── Balances ──

/** Awards chat-activity copper unless the viewer is still on cooldown.
 * Returns true if points were actually granted. */
export async function awardChatPoints(
  broadcasterId: string,
  username: string,
  displayName: string,
  amount: number,
  cooldownMs: number,
): Promise<boolean> {
  const user = username.toLowerCase();
  const now = Date.now();
  const res = await sqlite.execute(
    "SELECT last_earn_at FROM points_balances WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, user],
  );
  if (res.rows.length && now - Number(res.rows[0].last_earn_at ?? 0) < cooldownMs) return false;
  await sqlite.execute(
    `INSERT INTO points_balances (broadcaster_id, username, display_name, balance, last_earn_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(broadcaster_id, username) DO UPDATE SET
       balance = balance + excluded.balance,
       display_name = excluded.display_name,
       last_earn_at = excluded.last_earn_at`,
    [broadcasterId, user, displayName, amount, now],
  );
  return true;
}

/** Every balance in a channel, keyed by lowercase username (for the /roster page). */
export async function listChannelBalances(broadcasterId: string): Promise<Map<string, number>> {
  const res = await sqlite.execute("SELECT username, balance FROM points_balances WHERE broadcaster_id = ?", [broadcasterId]);
  return new Map((res.rows as any[]).map((r) => [String(r.username).toLowerCase(), Number(r.balance ?? 0)]));
}

export async function getBalance(
  broadcasterId: string,
  username: string,
): Promise<{ balance: number; rank: number; displayName: string } | null> {
  const user = username.toLowerCase();
  const res = await sqlite.execute(
    "SELECT balance, display_name FROM points_balances WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, user],
  );
  if (!res.rows.length) return null;
  const balance = Number(res.rows[0].balance);
  const rankRes = await sqlite.execute(
    "SELECT COUNT(*) AS ahead FROM points_balances WHERE broadcaster_id = ? AND balance > ?",
    [broadcasterId, balance],
  );
  return {
    balance,
    rank: Number(rankRes.rows[0]?.ahead ?? 0) + 1,
    displayName: String(res.rows[0].display_name),
  };
}

/** Adds (or, with a negative delta, removes) points, never dropping below 0.
 * Returns the new balance. Used by mod adjustments and refunds. */
export async function adjustBalance(
  broadcasterId: string,
  username: string,
  displayName: string,
  delta: number,
): Promise<number> {
  const user = username.toLowerCase();
  await sqlite.execute(
    `INSERT INTO points_balances (broadcaster_id, username, display_name, balance, last_earn_at)
     VALUES (?,?,?,MAX(0, ?),0)
     ON CONFLICT(broadcaster_id, username) DO UPDATE SET
       balance = MAX(0, balance + ?)`,
    [broadcasterId, user, displayName, delta, delta],
  );
  const res = await sqlite.execute(
    "SELECT balance FROM points_balances WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, user],
  );
  return Number(res.rows[0]?.balance ?? 0);
}

export async function setBalance(broadcasterId: string, username: string, displayName: string, value: number): Promise<number> {
  const user = username.toLowerCase();
  await sqlite.execute(
    `INSERT INTO points_balances (broadcaster_id, username, display_name, balance, last_earn_at)
     VALUES (?,?,?,?,0)
     ON CONFLICT(broadcaster_id, username) DO UPDATE SET balance = excluded.balance`,
    [broadcasterId, user, displayName, value],
  );
  return value;
}

/** Atomically spends points if (and only if) the viewer can afford it.
 * Returns true on success. */
export async function trySpend(broadcasterId: string, username: string, amount: number): Promise<boolean> {
  const user = username.toLowerCase();
  const res = await sqlite.execute(
    "UPDATE points_balances SET balance = balance - ? WHERE broadcaster_id = ? AND username = ? AND balance >= ?",
    [amount, broadcasterId, user, amount],
  );
  const affected = (res as any).rowsAffected;
  if (typeof affected === "number") return affected > 0;
  // Driver didn't report rowsAffected — fall back to a re-read check.
  const check = await sqlite.execute(
    "SELECT balance FROM points_balances WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, user],
  );
  return check.rows.length > 0;
}

/** Viewer-to-viewer gift. Returns "ok", or why it failed. */
export async function transferPoints(
  broadcasterId: string,
  from: string,
  to: string,
  toDisplay: string,
  amount: number,
): Promise<"ok" | "insufficient"> {
  if (!(await trySpend(broadcasterId, from, amount))) return "insufficient";
  await adjustBalance(broadcasterId, to, toDisplay, amount);
  return "ok";
}

export async function getTopBalances(broadcasterId: string, limit: number) {
  const res = await sqlite.execute(
    `SELECT username, display_name, balance FROM points_balances
     WHERE broadcaster_id = ? AND balance > 0
     ORDER BY balance DESC, username ASC LIMIT ?`,
    [broadcasterId, limit],
  );
  return res.rows.map((r: any) => ({
    username: String(r.username),
    displayName: String(r.display_name),
    balance: Number(r.balance),
  }));
}

// ── Giveaways ──

export interface GiveawayRow {
  prize: string;
  cost: number;
  maxTickets: number;
  status: "open" | "closed";
  startedBy: string;
  winners: string[];
}

export async function getGiveaway(broadcasterId: string): Promise<GiveawayRow | null> {
  const res = await sqlite.execute("SELECT * FROM giveaways WHERE broadcaster_id = ?", [broadcasterId]);
  if (!res.rows.length) return null;
  const r: any = res.rows[0];
  let winners: string[] = [];
  try {
    winners = JSON.parse(String(r.winners ?? "[]"));
  } catch (_) { /* corrupt JSON — treat as no winners */ }
  return {
    prize: String(r.prize),
    cost: Number(r.cost),
    maxTickets: Number(r.max_tickets),
    status: String(r.status) === "open" ? "open" : "closed",
    startedBy: String(r.started_by ?? ""),
    winners,
  };
}

/** Starts a fresh giveaway, replacing any previous (closed) one and its
 * entries. Caller must have already refused if one is still open. */
export async function startGiveaway(
  broadcasterId: string,
  prize: string,
  cost: number,
  maxTickets: number,
  startedBy: string,
) {
  await sqlite.execute("DELETE FROM giveaway_entries WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute(
    `INSERT OR REPLACE INTO giveaways
       (broadcaster_id, prize, cost, max_tickets, status, started_by, started_at, winners, closed_at)
     VALUES (?,?,?,?,'open',?,?,'[]',NULL)`,
    [broadcasterId, prize, cost, maxTickets, startedBy, Date.now()],
  );
}

export async function getEntry(broadcasterId: string, username: string): Promise<number> {
  const res = await sqlite.execute(
    "SELECT tickets FROM giveaway_entries WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, username.toLowerCase()],
  );
  return Number(res.rows[0]?.tickets ?? 0);
}

export async function addEntryTickets(broadcasterId: string, username: string, displayName: string, tickets: number) {
  await sqlite.execute(
    `INSERT INTO giveaway_entries (broadcaster_id, username, display_name, tickets)
     VALUES (?,?,?,?)
     ON CONFLICT(broadcaster_id, username) DO UPDATE SET
       tickets = tickets + excluded.tickets, display_name = excluded.display_name`,
    [broadcasterId, username.toLowerCase(), displayName, tickets],
  );
}

export async function getGiveawayTotals(broadcasterId: string): Promise<{ entrants: number; tickets: number }> {
  const res = await sqlite.execute(
    "SELECT COUNT(*) AS entrants, COALESCE(SUM(tickets),0) AS tickets FROM giveaway_entries WHERE broadcaster_id = ?",
    [broadcasterId],
  );
  return { entrants: Number(res.rows[0]?.entrants ?? 0), tickets: Number(res.rows[0]?.tickets ?? 0) };
}

/** Picks one winner, weighted by ticket count, excluding anyone already
 * drawn, records them and closes the giveaway. Returns null if nobody
 * (eligible) entered. */
export async function drawGiveawayWinner(
  broadcasterId: string,
): Promise<{ username: string; displayName: string } | null> {
  const giveaway = await getGiveaway(broadcasterId);
  if (!giveaway) return null;
  const res = await sqlite.execute(
    "SELECT username, display_name, tickets FROM giveaway_entries WHERE broadcaster_id = ?",
    [broadcasterId],
  );
  const pool = (res.rows as any[])
    .map((r) => ({ username: String(r.username), displayName: String(r.display_name), tickets: Number(r.tickets) }))
    .filter((e) => e.tickets > 0 && !giveaway.winners.includes(e.username));
  const total = pool.reduce((sum, e) => sum + e.tickets, 0);
  if (!pool.length || total <= 0) return null;

  // Unbiased integer in [0, total) from the crypto RNG (rejection sampling).
  const limit = Math.floor(0x100000000 / total) * total;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  let roll = buf[0] % total;
  let winner = pool[pool.length - 1];
  for (const e of pool) {
    if (roll < e.tickets) {
      winner = e;
      break;
    }
    roll -= e.tickets;
  }

  await sqlite.execute(
    "UPDATE giveaways SET status = 'closed', winners = ?, closed_at = ? WHERE broadcaster_id = ?",
    [JSON.stringify([...giveaway.winners, winner.username]), Date.now(), broadcasterId],
  );
  return { username: winner.username, displayName: winner.displayName };
}

/** Cancels the giveaway, refunding every entrant's ticket cost, and
 * removes it entirely. Returns how many entrants were refunded. */
export async function cancelGiveaway(broadcasterId: string): Promise<number> {
  const giveaway = await getGiveaway(broadcasterId);
  if (!giveaway) return 0;
  let refunded = 0;
  if (giveaway.status === "open" && giveaway.cost > 0) {
    const res = await sqlite.execute(
      "SELECT username, display_name, tickets FROM giveaway_entries WHERE broadcaster_id = ?",
      [broadcasterId],
    );
    for (const r of res.rows as any[]) {
      await adjustBalance(broadcasterId, String(r.username), String(r.display_name), giveaway.cost * Number(r.tickets));
      refunded++;
    }
  }
  await sqlite.execute("DELETE FROM giveaway_entries WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM giveaways WHERE broadcaster_id = ?", [broadcasterId]);
  return refunded;
}

// ── Robbery cooldowns (see rob.ts) ──

/** Milliseconds until `username` may rob again (0 = allowed now). */
export async function robberWaitMs(broadcasterId: string, username: string, cooldownMs: number): Promise<number> {
  const res = await sqlite.execute(
    "SELECT robber_at FROM rob_cooldowns WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, username.toLowerCase()],
  );
  const last = Number(res.rows[0]?.robber_at ?? 0);
  return Math.max(0, last + cooldownMs - Date.now());
}

/** Milliseconds `username` is still protected from being targeted (0 = fair game). */
export async function victimProtectedMs(broadcasterId: string, username: string, protectMs: number): Promise<number> {
  const res = await sqlite.execute(
    "SELECT victim_at FROM rob_cooldowns WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, username.toLowerCase()],
  );
  const last = Number(res.rows[0]?.victim_at ?? 0);
  return Math.max(0, last + protectMs - Date.now());
}

/** Stamps a robbery that is about to happen: the robber's cooldown starts and
 * the target's protection window starts, before the duel so a burst of
 * messages can't slip several robberies through. */
export async function stampRobbery(broadcasterId: string, robber: string, victim: string) {
  const now = Date.now();
  await sqlite.execute(
    `INSERT INTO rob_cooldowns (broadcaster_id, username, robber_at, victim_at) VALUES (?,?,?,0)
     ON CONFLICT(broadcaster_id, username) DO UPDATE SET robber_at = excluded.robber_at`,
    [broadcasterId, robber.toLowerCase(), now],
  );
  await sqlite.execute(
    `INSERT INTO rob_cooldowns (broadcaster_id, username, robber_at, victim_at) VALUES (?,?,0,?)
     ON CONFLICT(broadcaster_id, username) DO UPDATE SET victim_at = excluded.victim_at`,
    [broadcasterId, victim.toLowerCase(), now],
  );
}

// ── Offboarding ──

/** `!dndbot leave` (no purge): drop the on/off override (back to the
 * default, on) but keep balances, same as characters being kept. */
export async function disconnectPointsData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM points_settings WHERE broadcaster_id = ?", [broadcasterId]);
}

/** `!dndbot leave purge`: delete everything points-related for the channel. */
export async function purgePointsData(broadcasterId: string) {
  for (const table of ["points_settings", "points_balances", "giveaways", "giveaway_entries", "rob_cooldowns"]) {
    await sqlite.execute(`DELETE FROM ${table} WHERE broadcaster_id = ?`, [broadcasterId]);
  }
}

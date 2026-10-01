// Persistence for autohunt.ts — split out like points_db.ts / ads_db.ts to keep
// db.ts from growing. One row per (channel, viewer) with a running tally; the
// row is the whole session, so there is nothing to clean up but the row itself.
// Every row is scoped by broadcaster_id and usernames are stored lowercase.

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

export interface AutohuntSession {
  broadcaster_id: string;
  username: string;
  display_name: string;
  started_at: number;
  ends_at: number;
  next_at: number; // when the next bout is due
  bouts: number;
  wins: number;
  losses: number;
  total_xp: number;
  total_copper: number;
  levels_gained: number;
  reports_sent: number; // unprompted (cron) reports posted so far; see TAGGED_REPORTS in autohunt.ts
}

export async function ensureAutohuntTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS autohunt_sessions (
      broadcaster_id TEXT NOT NULL, username TEXT NOT NULL, display_name TEXT NOT NULL,
      started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, next_at INTEGER NOT NULL,
      bouts INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
      total_xp INTEGER NOT NULL DEFAULT 0, total_copper INTEGER NOT NULL DEFAULT 0,
      levels_gained INTEGER NOT NULL DEFAULT 0, reports_sent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (broadcaster_id, username)
    )`,
  );
  // Tables created before reports_sent existed.
  try {
    await sqlite.execute(`ALTER TABLE autohunt_sessions ADD COLUMN reports_sent INTEGER NOT NULL DEFAULT 0`);
  } catch (_) {
    /* column already exists */
  }
}

function rowToSession(r: any): AutohuntSession {
  return {
    broadcaster_id: String(r.broadcaster_id),
    username: String(r.username),
    display_name: String(r.display_name),
    started_at: Number(r.started_at),
    ends_at: Number(r.ends_at),
    next_at: Number(r.next_at),
    bouts: Number(r.bouts),
    wins: Number(r.wins),
    losses: Number(r.losses),
    total_xp: Number(r.total_xp),
    total_copper: Number(r.total_copper),
    levels_gained: Number(r.levels_gained),
    reports_sent: Number(r.reports_sent ?? 0),
  };
}

export async function getAutohuntSession(broadcasterId: string, username: string): Promise<AutohuntSession | null> {
  const res = await sqlite.execute(
    "SELECT * FROM autohunt_sessions WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, username.toLowerCase()],
  );
  return res.rows.length ? rowToSession(res.rows[0]) : null;
}

export async function countAutohuntSessions(broadcasterId: string): Promise<number> {
  const res = await sqlite.execute(
    "SELECT COUNT(*) AS n FROM autohunt_sessions WHERE broadcaster_id = ?",
    [broadcasterId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

export async function createAutohuntSession(s: AutohuntSession) {
  await sqlite.execute(
    `INSERT OR REPLACE INTO autohunt_sessions
      (broadcaster_id, username, display_name, started_at, ends_at, next_at, bouts, wins, losses, total_xp, total_copper, levels_gained, reports_sent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      s.broadcaster_id, s.username.toLowerCase(), s.display_name, s.started_at, s.ends_at, s.next_at,
      s.bouts, s.wins, s.losses, s.total_xp, s.total_copper, s.levels_gained, s.reports_sent,
    ],
  );
}

/**
 * Atomically claims the right to settle a session's due bouts by moving
 * next_at forward, only if it is still `expectedNextAt`. The cron and a
 * viewer's own !autohunt status can race; whoever wins the claim simulates and
 * pays, the loser gets false and does nothing — so bouts are never paid twice.
 */
export async function claimAutohuntBouts(
  broadcasterId: string,
  username: string,
  expectedNextAt: number,
  newNextAt: number,
): Promise<boolean> {
  const res = await sqlite.execute(
    "UPDATE autohunt_sessions SET next_at = ? WHERE broadcaster_id = ? AND username = ? AND next_at = ?",
    [newNextAt, broadcasterId, username.toLowerCase(), expectedNextAt],
  );
  const affected = (res as any).rowsAffected;
  if (typeof affected === "number") return affected > 0;
  const check = await getAutohuntSession(broadcasterId, username);
  return !!check && check.next_at === newNextAt;
}

export async function addAutohuntProgress(
  broadcasterId: string,
  username: string,
  d: { bouts: number; wins: number; losses: number; xp: number; copper: number; levels: number },
) {
  await sqlite.execute(
    `UPDATE autohunt_sessions SET bouts = bouts + ?, wins = wins + ?, losses = losses + ?,
       total_xp = total_xp + ?, total_copper = total_copper + ?, levels_gained = levels_gained + ?
     WHERE broadcaster_id = ? AND username = ?`,
    [d.bouts, d.wins, d.losses, d.xp, d.copper, d.levels, broadcasterId, username.toLowerCase()],
  );
}

export async function bumpAutohuntReports(broadcasterId: string, username: string) {
  await sqlite.execute(
    "UPDATE autohunt_sessions SET reports_sent = reports_sent + 1 WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, username.toLowerCase()],
  );
}

export async function deleteAutohuntSession(broadcasterId: string, username: string) {
  await sqlite.execute(
    "DELETE FROM autohunt_sessions WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, username.toLowerCase()],
  );
}

/** Sessions with a bout due (or already past their end), for connected channels. */
export async function getDueAutohuntSessions(now: number): Promise<Array<AutohuntSession & { is_live: number }>> {
  const res = await sqlite.execute(
    `SELECT a.*, b.is_live AS is_live FROM autohunt_sessions a
     JOIN broadcasters b ON b.broadcaster_id = a.broadcaster_id AND b.connected = 1
     WHERE a.next_at <= ? OR a.ends_at <= ?
     ORDER BY a.next_at ASC LIMIT 100`,
    [now, now],
  );
  return res.rows.map((r: any) => ({ ...rowToSession(r), is_live: Number(r.is_live ?? 0) }));
}

/** Called for both `!dndbot leave` and `leave purge`: hunts stop with the bot. */
export async function purgeAutohuntData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM autohunt_sessions WHERE broadcaster_id = ?", [broadcasterId]);
}

// Persistence for ads.ts — split out from db.ts (which is already near Val
// Town's per-file size cap) rather than growing that file further. Mirrors
// db.ts's own conventions (INSERT OR REPLACE, broadcaster_id-keyed rows).

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

export async function ensureAdTables() {
  // The broadcaster's own OAuth token for real Twitch ad-schedule reads
  // (channel:read:ads, requested during /connect) — separate from
  // dashboard_sessions in db.ts, which is a per-login viewer session
  // rather than a durable per-channel credential. Channels connected
  // before this scope existed simply have no row here until they
  // reconnect. See ads.ts.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS broadcaster_ad_tokens (
      broadcaster_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
      scope TEXT, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
  );
  // Last known real ad break, logged manually via !adslogged — a fallback
  // for channels without a broadcaster_ad_tokens row (or when Twitch's ad
  // schedule API has nothing to report) so !adcheck still has something to
  // reason about. See ads.ts.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS ad_tracking (
      broadcaster_id TEXT PRIMARY KEY, last_ad_at INTEGER, last_ad_source TEXT, last_ad_by TEXT, updated_at INTEGER
    )`,
  );
}

/** Persists (or refreshes) the broadcaster's own ad-schedule OAuth token —
 * called once from the /callback OAuth exchange and again by ads.ts
 * whenever a stored token is refreshed. */
export async function saveBroadcasterAdToken(
  broadcasterId: string,
  accessToken: string,
  refreshToken: string,
  scope: string,
  expiresAt: number,
) {
  await sqlite.execute(
    `INSERT OR REPLACE INTO broadcaster_ad_tokens
     (broadcaster_id, access_token, refresh_token, scope, expires_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
    [broadcasterId, accessToken, refreshToken, scope, expiresAt, Date.now()],
  );
}

export async function getBroadcasterAdToken(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM broadcaster_ad_tokens WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length ? res.rows[0] : null;
}

/** Records a mod/broadcaster manually marking "ads were just run" via
 * !adslogged — the fallback source of truth when the real Twitch ad
 * schedule isn't available for this channel. */
export async function recordManualAdTrigger(broadcasterId: string, byUser: string) {
  const now = Date.now();
  await sqlite.execute(
    `INSERT OR REPLACE INTO ad_tracking (broadcaster_id, last_ad_at, last_ad_source, last_ad_by, updated_at)
     VALUES (?,?,?,?,?)`,
    [broadcasterId, now, "manual", byUser, now],
  );
}

export async function getAdTracking(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM ad_tracking WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length ? res.rows[0] : null;
}

/** Credential material tied to the connection itself — cleared on every
 * disconnect (not just purge), same as the broadcasters row and its
 * EventSub subscriptions in db.ts's disconnectBroadcasterData. */
export async function disconnectAdToken(broadcasterId: string) {
  await sqlite.execute("DELETE FROM broadcaster_ad_tokens WHERE broadcaster_id = ?", [broadcasterId]);
}

/** Full ad-data wipe for !dndbot leave purge — both the token and the
 * manually-logged tracking row. */
export async function purgeAdData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM broadcaster_ad_tokens WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM ad_tracking WHERE broadcaster_id = ?", [broadcasterId]);
}

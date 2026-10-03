// Open-stall merchant state (toggle, current listing, haggles, cron health)
// and the operator monitor-event views.
// Split out of db.ts (which re-exports everything here) to keep every file
// well under Val Town's per-file size ceiling.

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

export async function isMerchantEnabled(broadcasterId: string) {
  const res = await sqlite.execute("SELECT enabled FROM merchant_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length > 0 && Number(res.rows[0].enabled) === 1;
}

/** Toggle the open-stall merchant. `nextPostAt` should be a freshly randomized
 * due time (ms epoch) when enabling; pass null when disabling. */
export async function setMerchantEnabled(broadcasterId: string, enabled: boolean, nextPostAt: number | null) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO merchant_settings (broadcaster_id, enabled, next_post_at, updated_at) VALUES (?,?,?,?)",
    [broadcasterId, enabled ? 1 : 0, enabled ? nextPostAt : null, Date.now()],
  );
}

export interface MerchantListing {
  merchantName: string;
  itemDesc: string;
  priceText: string;
  postedAt: number;
  haggledBy: string[];
}

/** Called right after a merchant ad successfully posts — records what's now
 * on offer for !haggle, replacing whatever was listed before. */
export async function setMerchantListing(broadcasterId: string, merchantName: string, itemDesc: string, priceText: string) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO merchant_listings (broadcaster_id, merchant_name, item_desc, price_text, posted_at, haggled_by) VALUES (?,?,?,?,?,'[]')",
    [broadcasterId, merchantName, itemDesc, priceText, Date.now()],
  );
}

export async function getMerchantListing(broadcasterId: string): Promise<MerchantListing | null> {
  const res = await sqlite.execute(
    "SELECT merchant_name, item_desc, price_text, posted_at, haggled_by FROM merchant_listings WHERE broadcaster_id = ?",
    [broadcasterId],
  );
  if (!res.rows.length) return null;
  const r: any = res.rows[0];
  return {
    merchantName: r.merchant_name,
    itemDesc: r.item_desc,
    priceText: r.price_text,
    postedAt: Number(r.posted_at),
    haggledBy: JSON.parse(r.haggled_by || "[]"),
  };
}

/** How many haggle attempts `username` has already spent on a listing. */
export function countListingHaggles(listing: MerchantListing, username: string): number {
  return listing.haggledBy.filter((u) => u === username).length;
}

/** Records one more haggle attempt by `username` on the current listing, so
 * they can't keep re-rolling the same item past `maxAttempts` discount
 * attempts. Pass the `postedAt` from the listing you just read: if the
 * listing has since moved on (a new ad replaced it) this is a no-op and
 * returns "no_listing", so a slow haggle reply can't mark the wrong (newer)
 * listing as haggled. Returns "limit" (and records nothing) if they've
 * already used all their attempts, otherwise "claimed". */
export async function markListingHaggled(
  broadcasterId: string,
  username: string,
  postedAt: number,
  maxAttempts = 1,
): Promise<"claimed" | "no_listing" | "limit"> {
  const listing = await getMerchantListing(broadcasterId);
  if (!listing || listing.postedAt !== postedAt) return "no_listing";
  if (countListingHaggles(listing, username) >= maxAttempts) return "limit";
  const haggledBy = [...listing.haggledBy, username];
  await sqlite.execute(
    "UPDATE merchant_listings SET haggled_by = ? WHERE broadcaster_id = ? AND posted_at = ?",
    [JSON.stringify(haggledBy), broadcasterId, postedAt],
  );
  return "claimed";
}

/** Recently-active chatters in a channel (from activity_logs), most-recent
 * first — the pool !oracle picks a name from. */
export async function getRecentChatters(broadcasterId: string, limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const res = await sqlite.execute(
    `SELECT username, MAX(created_at) AS last_seen
     FROM (SELECT username, created_at FROM activity_logs WHERE broadcaster_id = ? ORDER BY id DESC LIMIT 500) AS recent
     GROUP BY username
     ORDER BY last_seen DESC
     LIMIT ${safeLimit}`,
    [broadcasterId],
  );
  return res.rows.map((r: any) => String(r.username));
}

/** Channels whose merchant is enabled, due for a post, connected, not
 * operator-blocked, and not otherwise disabled via !dndbot off. Carries
 * along b.is_live so merchant_cron.ts can skip offline channels without a
 * separate query per channel. */
export async function getDueMerchantChannels(now: number): Promise<Array<{ broadcasterId: string; isLive: boolean }>> {
  const res = await sqlite.execute(
    `SELECT m.broadcaster_id AS broadcaster_id, b.is_live AS is_live

     FROM merchant_settings m
     JOIN broadcasters b ON b.broadcaster_id = m.broadcaster_id AND b.connected = 1
     LEFT JOIN channel_settings cs ON cs.broadcaster_id = m.broadcaster_id
     LEFT JOIN channel_blocks cb ON cb.broadcaster_id = m.broadcaster_id
     WHERE m.enabled = 1
       AND m.next_post_at IS NOT NULL AND m.next_post_at <= ?
       AND cb.broadcaster_id IS NULL
       AND (cs.enabled IS NULL OR cs.enabled = 1)`,
    [now],
  );
  return res.rows.map((r: any) => ({ broadcasterId: String(r.broadcaster_id), isLive: Number(r.is_live) === 1 }));
}

export async function rescheduleMerchant(broadcasterId: string, nextPostAt: number) {
  await sqlite.execute(
    "UPDATE merchant_settings SET next_post_at = ?, updated_at = ? WHERE broadcaster_id = ?",
    [nextPostAt, Date.now(), broadcasterId],
  );
}

/** Called once per merchant_cron.ts tick — overwrites the single status row
 * so GET /admin/merchant/status and /admin/logs can tell whether the cron is
 * still ticking and whether its last run posted cleanly. */
export async function recordMerchantCronRun(channelsDue: number, postsOk: number, postsFailed: number) {
  await sqlite.execute(
    `INSERT INTO merchant_cron_status (id, last_run_at, channels_due, last_posts_ok, last_posts_failed)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at, channels_due = excluded.channels_due,
       last_posts_ok = excluded.last_posts_ok, last_posts_failed = excluded.last_posts_failed`,
    [Date.now(), channelsDue, postsOk, postsFailed],
  );
}

export async function getMerchantCronStatus() {
  const res = await sqlite.execute("SELECT * FROM merchant_cron_status WHERE id = 1");
  return res.rows.length ? res.rows[0] : null;
}

/** Per-channel merchant on/off + next-due-time, for every connected
 * channel — the operator-only overview table on GET /admin/logs. */
export async function getMerchantOverview() {
  const res = await sqlite.execute(
    `SELECT b.broadcaster_id AS broadcaster_id, b.display_name AS display_name, b.login AS login,
            COALESCE(m.enabled, 0) AS enabled, m.next_post_at AS next_post_at
     FROM broadcasters b
     LEFT JOIN merchant_settings m ON m.broadcaster_id = b.broadcaster_id
     WHERE b.connected = 1
     ORDER BY b.display_name ASC`,
  );
  return res.rows;
}

/** Most recent monitor_events, optionally filtered to one `kind` (e.g.
 * "merchant") — backs both the JSON status endpoint and the /admin/logs page. */
export async function getMonitorEvents(kind?: string, limit = 100) {
  const res = kind
    ? await sqlite.execute("SELECT * FROM monitor_events WHERE kind = ? ORDER BY id DESC LIMIT ?", [kind, limit])
    : await sqlite.execute("SELECT * FROM monitor_events ORDER BY id DESC LIMIT ?", [limit]);
  return res.rows;
}

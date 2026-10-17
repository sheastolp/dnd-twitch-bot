// Automatic thank-you in chat for new followers (EventSub channel.follow).
//
// Gated like the sub/raid thank-yous (connected, enabled, not blocked, live)
// plus its own dashboard switch ("followthanks"). Two guards keep it from
// spamming chat:
//   - each viewer is thanked at most once per FOLLOW_REPEAT_MS, so an
//     unfollow/refollow loop gets one line, not one per refollow;
//   - at most FOLLOW_BURST_MAX thank-yous per channel per FOLLOW_BURST_MS,
//     so a follow-bot wave can't flood the chat queue. Follows past the cap
//     are dropped silently.
//
// The subscription is created by /connect. Channels connected before this
// existed get it lazily when their stream goes live (ensureFollowSubscription),
// as long as they already granted moderator:read:followers — no reconnect.

import { sqlite } from "./sqlite.ts";
import { getBroadcasterAdToken } from "./ads_db.ts";
import { getBroadcaster, getExtraEventSubSubscriptions, isChannelBlocked, isChannelEnabled, isCommandGroupEnabled, recordMonitorEvent, saveExtraEventSubSubscription } from "./db.ts";
import { isChannelBot } from "./channel_bots.ts";
import { createFollowEventSubscription, env, sendChatMessage } from "./twitch.ts";
import { rollFollowThankYou } from "./flavor_events.ts";
import { FOLLOW_SCOPE } from "./watchtime.ts";

const FOLLOW_REPEAT_MS = 7 * 24 * 60 * 60_000;
const FOLLOW_BURST_MS = 60_000;
const FOLLOW_BURST_MAX = Math.max(1, Number(Deno.env.get("FOLLOW_THANKS_PER_MINUTE") ?? "3"));

export async function ensureFollowThanksTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS follow_thanks (
      broadcaster_id TEXT NOT NULL, user_id TEXT NOT NULL, thanked_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, user_id)
    )`,
  );
}

export async function purgeFollowThanksData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM follow_thanks WHERE broadcaster_id = ?", [broadcasterId]);
}

/** Creates the follow subscription for /connect; throws on failure. */
export async function subscribeToFollows(broadcasterId: string, callbackUrl: string) {
  const sub = await createFollowEventSubscription(broadcasterId, callbackUrl);
  await saveExtraEventSubSubscription(broadcasterId, "follow", sub.id);
}

/** Called on stream.online: subscribes a channel that connected before
 * follow thank-yous existed, if its token already carries the scope. */
export async function ensureFollowSubscription(broadcasterId: string, callbackUrl: string) {
  const extras = await getExtraEventSubSubscriptions(broadcasterId);
  if (extras.some((s) => s.kind === "follow")) return;
  const token = await getBroadcasterAdToken(broadcasterId);
  if (!String(token?.scope ?? "").split(/\s+/).includes(FOLLOW_SCOPE)) return;
  try {
    await subscribeToFollows(broadcasterId, callbackUrl);
  } catch (e) {
    await recordMonitorEvent("eventsub_follow_backfill_failed", `${broadcasterId}: ${String(e)}`);
  }
}

/** Claims a thank-you for this follower: false if they were thanked
 * recently or the channel already hit its per-minute cap. */
async function claimFollowThanks(broadcasterId: string, userId: string): Promise<boolean> {
  const now = Date.now();
  const res = await sqlite.execute(
    `SELECT
       (SELECT thanked_at FROM follow_thanks WHERE broadcaster_id = ? AND user_id = ?) AS last,
       (SELECT COUNT(*) FROM follow_thanks WHERE broadcaster_id = ? AND thanked_at > ?) AS recent`,
    [broadcasterId, userId, broadcasterId, now - FOLLOW_BURST_MS],
  );
  const last = Number(res.rows[0]?.last ?? 0);
  const recent = Number(res.rows[0]?.recent ?? 0);
  if (now - last < FOLLOW_REPEAT_MS || recent >= FOLLOW_BURST_MAX) return false;
  await sqlite.execute(
    "INSERT OR REPLACE INTO follow_thanks (broadcaster_id, user_id, thanked_at) VALUES (?,?,?)",
    [broadcasterId, userId, now],
  );
  await sqlite.execute("DELETE FROM follow_thanks WHERE broadcaster_id = ? AND thanked_at < ?", [broadcasterId, now - FOLLOW_REPEAT_MS]);
  return true;
}

// deno-lint-ignore no-explicit-any
export async function onFollow(event: any) {
  const broadcasterId = String(event?.broadcaster_user_id ?? "");
  const userId = String(event?.user_id ?? "");
  const login = String(event?.user_login ?? "");
  const display = String(event?.user_name ?? login);
  if (!broadcasterId || !userId || await isChannelBot(broadcasterId, login, userId, env("TWITCH_BOT_ID"))) return;
  const connection = await getBroadcaster(broadcasterId);
  if (!connection || Number(connection.connected) !== 1 || Number(connection.is_live) !== 1) return;
  const [on, blocked, groupOn] = await Promise.all([
    isChannelEnabled(broadcasterId),
    isChannelBlocked(broadcasterId),
    isCommandGroupEnabled(broadcasterId, "followthanks"),
  ]);
  if (!on || blocked || !groupOn) return;
  if (!(await claimFollowThanks(broadcasterId, userId))) return;
  await sendChatMessage(rollFollowThankYou(display), broadcasterId);
}

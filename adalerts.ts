// Ad-break alerts — makes chat aware of real Twitch ad breaks without anyone
// having to type !adcheck (ads.ts):
//
//   • Start notice. Twitch's channel.ad_break.begin EventSub fires the moment
//     an ad break starts (manual or automatic); the bot says so in chat and
//     records it as the channel's last ad, so !adcheck and the reminder below
//     stay accurate without !adslogged.
//   • Heads-up. A few minutes before Twitch's next scheduled ad break
//     (Get Ad Schedule), the bot warns chat once. Val Town crons can't tick
//     faster than every 15 minutes, so the check rides on chat activity
//     instead: any message in a live channel runs it, at most every 30
//     seconds per channel, with the watch-time cron as a backstop for quiet
//     chats.
//   • Missed breaks. The same check compares Twitch's last_ad_at with the
//     last break on record, so a break the EventSub never delivered (a
//     channel without the subscription, a dropped webhook) is still logged
//     for !adcheck — and announced, if it's still running and the channel
//     has no subscription to announce it.
//   • End notice. Twitch has no ad-break-end event, so the start notice
//     records when the break should finish (start + duration) and the same
//     chat-driven check posts "ads are over" once that time has passed —
//     within ~30 seconds, as long as someone is chatting. A break that ended
//     more than END_NOTICE_STALE_MS ago is let go silently.
//
// Both need the broadcaster's channel:read:ads grant — already requested by
// /connect for !adcheck. Channels that connected before the ad-break
// subscription existed get it created lazily here on their next live chat
// message, so nobody has to reconnect. Dashboard switch: "adalerts" (on by
// default), in the same Codex card as !adcheck.

import { sqlite } from "./sqlite.ts";
import { getValidAdToken } from "./ads.ts";
import { getAdTracking, getBroadcasterAdToken } from "./ads_db.ts";
import { getBroadcaster, isChannelBlocked, isChannelEnabled, isCommandGroupEnabled, recordMonitorEvent, saveExtraEventSubSubscription } from "./db.ts";
import { type AdSchedule, createAdBreakEventSubscription, fetchAdSchedule, sendChatMessage } from "./twitch.ts";
import { pick } from "./utils.ts";

const ADS_SCOPE = "channel:read:ads";
/** How far ahead of a scheduled ad break chat is warned. */
const HEADS_UP_MINUTES = Math.max(1, Number(Deno.env.get("AD_HEADS_UP_MINUTES") ?? "5"));
const CHECK_EVERY_MS = 30_000;
// Twitch's last_ad_at and the EventSub's started_at for the same break can
// differ by a few seconds; anything closer than this is the same break.
const SAME_BREAK_MS = 60_000;
// An end notice this late would just be confusing.
const END_NOTICE_STALE_MS = 5 * 60_000;
// Retry a failed lazy subscription at most this often.
const SUBSCRIBE_RETRY_MS = 30 * 60_000;

export async function ensureAdAlertTables() {
  // subscribed: 1 once channel.ad_break.begin exists for the channel.
  // warned_for: the next_ad_at the heads-up was last posted for (dedupe).
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS ad_alerts (
      broadcaster_id TEXT PRIMARY KEY, subscribed INTEGER NOT NULL DEFAULT 0, subscribe_tried_at INTEGER NOT NULL DEFAULT 0,
      warned_for TEXT NOT NULL DEFAULT '', last_check_at INTEGER NOT NULL DEFAULT 0,
      ad_ends_at INTEGER NOT NULL DEFAULT 0
    )`,
  );
  // ad_ends_at: when the running break should finish; 0 once its end notice is posted.
  try {
    await sqlite.execute(`ALTER TABLE ad_alerts ADD COLUMN ad_ends_at INTEGER NOT NULL DEFAULT 0`);
  } catch (_) {
    /* column already exists */
  }
}

export async function purgeAdAlertData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM ad_alerts WHERE broadcaster_id = ?", [broadcasterId]);
}

/** Marks the channel subscribed — called by /connect after it creates the
 * ad-break subscription alongside the others. */
export async function markAdBreakSubscribed(broadcasterId: string) {
  await sqlite.execute(
    `INSERT INTO ad_alerts (broadcaster_id, subscribed, subscribe_tried_at) VALUES (?,1,?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET subscribed = 1, subscribe_tried_at = excluded.subscribe_tried_at`,
    [broadcasterId, Date.now()],
  );
}

async function hasAdsScope(broadcasterId: string): Promise<boolean> {
  const row = await getBroadcasterAdToken(broadcasterId);
  return String(row?.scope ?? "").split(/\s+/).includes(ADS_SCOPE);
}

/** Creates the ad-break subscription for /connect; throws on failure. */
export async function subscribeToAdBreaks(broadcasterId: string, callbackUrl: string) {
  const sub = await createAdBreakEventSubscription(broadcasterId, callbackUrl);
  await saveExtraEventSubSubscription(broadcasterId, "ad_break", sub.id);
  await markAdBreakSubscribed(broadcasterId);
}

async function alertsAllowed(broadcasterId: string): Promise<boolean> {
  const [on, blocked, groupOn] = await Promise.all([
    isChannelEnabled(broadcasterId),
    isChannelBlocked(broadcasterId),
    isCommandGroupEnabled(broadcasterId, "adalerts"),
  ]);
  return on && !blocked && groupOn;
}

// ── Start notice (EventSub channel.ad_break.begin) ──

const START_LINES: Array<(len: string) => string> = [
  (l) => `📺 Ad break! ${l} of ads rolling now — stretch your legs, refill the tankard, and we'll be right back.`,
  (l) => `📺 The bard takes an intermission: ${l} of ads starting now. Hydrate, adventurers!`,
  (l) => `📺 Ads are running (${l}). A short rest for the party — the tale resumes shortly.`,
  (l) => `📺 ${l} ad break underway. Perfect time for a snack from the tavern kitchen.`,
  (l) => `📺 Commercial break, ${l}. Guard the camp; we march again in a moment.`,
];

function formatLength(seconds: number): string {
  if (!seconds) return "a short";
  if (seconds < 90) return `${seconds}s`;
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m} min`;
}

export async function onAdBreakBegin(event: any) {
  const broadcasterId = String(event?.broadcaster_user_id ?? "");
  if (!broadcasterId) return;
  const startedAt = Date.parse(String(event?.started_at ?? "")) || Date.now();
  // Same row !adslogged writes, so !adcheck's "last ad" stays current.
  await sqlite.execute(
    `INSERT OR REPLACE INTO ad_tracking (broadcaster_id, last_ad_at, last_ad_source, last_ad_by, updated_at) VALUES (?,?,?,?,?)`,
    [broadcasterId, startedAt, event?.is_automatic ? "twitch_auto" : "twitch", String(event?.requester_user_login ?? ""), Date.now()],
  );
  const connection = await getBroadcaster(broadcasterId);
  if (!connection || Number(connection.connected) !== 1 || Number(connection.is_live) !== 1) return;
  if (!(await alertsAllowed(broadcasterId))) return;
  const duration = Number(event?.duration_seconds ?? 0);
  await sendChatMessage(pick(START_LINES)(formatLength(duration)), broadcasterId);
  await scheduleEndNotice(broadcasterId, startedAt + Math.max(duration, 30) * 1000);
}

// ── End notice (no Twitch event for it; checked on chat activity) ──

const END_LINES = [
  "📺 Ads are over — welcome back, adventurers! The tale resumes.",
  "📺 The intermission ends. Ads are done; back to the adventure!",
  "📺 Ad break's over. Grab your dice — we march on!",
  "📺 That's the end of the ads. The bard returns to the stage!",
];

async function scheduleEndNotice(broadcasterId: string, endsAt: number) {
  await sqlite.execute(
    `INSERT INTO ad_alerts (broadcaster_id, ad_ends_at) VALUES (?,?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET ad_ends_at = excluded.ad_ends_at`,
    [broadcasterId, endsAt],
  );
}

/** Posts the end notice once the running break is over. Clearing ad_ends_at
 * is conditional, so only one isolate posts it. */
async function maybeAdEndNotice(broadcasterId: string, endsAt: number, now: number) {
  if (!endsAt || now < endsAt) return;
  const clear = await sqlite.execute("UPDATE ad_alerts SET ad_ends_at = 0 WHERE broadcaster_id = ? AND ad_ends_at = ?", [broadcasterId, endsAt]);
  if (Number((clear as any)?.rowsAffected ?? 1) === 0) return;
  if (now - endsAt > END_NOTICE_STALE_MS) return;
  await sendChatMessage(pick(END_LINES), broadcasterId);
}

// ── Missed breaks (Get Ad Schedule's last_ad_at) ──

const MISSED_START_LINES = [
  "📺 Ad break running now — stretch your legs, refill the tankard, and we'll be right back.",
  "📺 The bard takes an intermission: ads are rolling. Hydrate, adventurers!",
  "📺 Ads are running. A short rest for the party — the tale resumes shortly.",
];

/** Twitch documents last_ad_at/next_ad_at as RFC3339 but has sent Unix
 * seconds before; accepts both. 0 when empty or unparseable. */
function parseTwitchTime(value: string): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return n < 1e12 ? n * 1000 : n;
  }
  return Date.parse(value) || 0;
}

/** Logs a break Twitch reports but nothing on record has — returns true if
 * this call is the one that logged it. */
async function backfillMissedBreak(broadcasterId: string, schedule: AdSchedule, subscribed: boolean, now: number): Promise<boolean> {
  const lastAt = parseTwitchTime(schedule.lastAdAt);
  if (!lastAt || lastAt > now) return false;
  const tracked = Number((await getAdTracking(broadcasterId))?.last_ad_at ?? 0);
  if (lastAt - tracked <= SAME_BREAK_MS) return false;
  // Conditional so two isolates (or a late EventSub) can't log it twice.
  const rec = await sqlite.execute(
    `INSERT INTO ad_tracking (broadcaster_id, last_ad_at, last_ad_source, last_ad_by, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET last_ad_at = excluded.last_ad_at, last_ad_source = excluded.last_ad_source,
       last_ad_by = excluded.last_ad_by, updated_at = excluded.updated_at
     WHERE COALESCE(ad_tracking.last_ad_at, 0) < ?`,
    [broadcasterId, lastAt, "twitch_schedule", "", now, lastAt - SAME_BREAK_MS],
  );
  if (Number((rec as any)?.rowsAffected ?? 1) === 0) return false;
  // With the EventSub in place its own notice covers this (or the break is
  // long over by the time we noticed); only fill in for channels without it.
  const stillRunningMs = Math.max(schedule.durationSeconds || 0, 90) * 1000;
  if (!subscribed && now - lastAt < stillRunningMs) {
    await sendChatMessage(pick(MISSED_START_LINES), broadcasterId);
    await scheduleEndNotice(broadcasterId, lastAt + stillRunningMs);
  }
  return true;
}

// ── Heads-up before the next scheduled break (rides on chat activity) ──

const lastCheck = new Map<string, number>();

/** Run on chat messages in a live channel (and by the watch-time cron, with
 * no baseUrl, which skips the lazy subscription); cheap no-op most of the
 * time. Never throws. */
export async function maybeAdHeadsUp(broadcasterId: string, baseUrl?: string): Promise<void> {
  try {
    const now = Date.now();
    if (now - (lastCheck.get(broadcasterId) ?? 0) < CHECK_EVERY_MS) return;
    lastCheck.set(broadcasterId, now);
    // Claim this minute's check across isolates too.
    const claim = await sqlite.execute(
      `INSERT INTO ad_alerts (broadcaster_id, last_check_at) VALUES (?,?)
       ON CONFLICT(broadcaster_id) DO UPDATE SET last_check_at = excluded.last_check_at WHERE ad_alerts.last_check_at < ?`,
      [broadcasterId, now, now - CHECK_EVERY_MS],
    );
    if (Number((claim as any)?.rowsAffected ?? 1) === 0) return;
    if (!(await alertsAllowed(broadcasterId))) return;

    const state = (await sqlite.execute("SELECT * FROM ad_alerts WHERE broadcaster_id = ?", [broadcasterId])).rows[0] as any;
    await maybeAdEndNotice(broadcasterId, Number(state?.ad_ends_at ?? 0), now);
    if (!(await hasAdsScope(broadcasterId))) return;
    let subscribed = Number(state?.subscribed ?? 0) === 1;
    if (!subscribed && baseUrl && now - Number(state?.subscribe_tried_at ?? 0) > SUBSCRIBE_RETRY_MS) {
      await sqlite.execute("UPDATE ad_alerts SET subscribe_tried_at = ? WHERE broadcaster_id = ?", [now, broadcasterId]);
      try {
        await subscribeToAdBreaks(broadcasterId, baseUrl);
        subscribed = true;
      } catch (e) {
        await recordMonitorEvent("eventsub_ad_break_backfill_failed", `${broadcasterId}: ${String(e)}`);
      }
    }

    const token = await getValidAdToken(broadcasterId);
    if (!token) return;
    const schedule = await fetchAdSchedule(token, broadcasterId);
    if (!schedule) return;
    await backfillMissedBreak(broadcasterId, schedule, subscribed, now);
    const nextAt = parseTwitchTime(schedule.nextAdAt);
    if (!nextAt) return;
    const minutes = (nextAt - now) / 60_000;
    if (!(minutes > 0 && minutes <= HEADS_UP_MINUTES)) return;
    // One warning per scheduled break, even with several isolates racing.
    const mark = await sqlite.execute(
      "UPDATE ad_alerts SET warned_for = ? WHERE broadcaster_id = ? AND warned_for != ?",
      [schedule.nextAdAt, broadcasterId, schedule.nextAdAt],
    );
    if (Number((mark as any)?.rowsAffected ?? 1) === 0) return;
    const inMin = Math.max(1, Math.round(minutes));
    const snooze = schedule.snoozeCount > 0 ? ` (Streamer: ${schedule.snoozeCount} snooze${schedule.snoozeCount === 1 ? "" : "s"} left if now's a bad moment.)` : "";
    await sendChatMessage(
      `📺 Heads up: a ${formatLength(schedule.durationSeconds)} ad break is due in ~${inMin} min.${snooze}`,
      broadcasterId,
    );
  } catch (e) {
    await recordMonitorEvent("ad_heads_up_error", `${broadcasterId}: ${String(e)}`).catch(() => {});
  }
}

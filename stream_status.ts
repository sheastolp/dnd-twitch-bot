// GuildScribe — stream.online / stream.offline, with a reconnect grace period.
//
// A stream that drops and comes back (OBS crash, internet blip, encoder
// restart) makes Twitch send stream.offline and then a fresh stream.online.
// Treating those as a real end and start would reset everything mid-session:
// the raid quest expires and a new one is posted, the saving throws tally
// starts over, the checklist / go-live announcement / message of the day post
// again, and the offline lock kicks in.
//
// So stream.offline only *marks* the channel as possibly ending
// (broadcasters.offline_pending_at) and leaves is_live and every per-stream
// state alone. If stream.online arrives within STREAM_RECONNECT_GRACE_MS, it's
// the same stream reconnecting: the mark is cleared and nothing else happens.
// Otherwise the minute cron (runStreamOfflineGrace, server.ts) finishes the
// offline once the grace runs out — is_live goes to 0 and the offline hooks
// run, timed from when the stream actually dropped.

import { getBroadcaster, isChannelBlocked, recordMonitorEvent, setBroadcasterLiveStatus, sqlite } from "./db.ts";
import { PUBLIC_ORIGIN } from "./config.ts";
import { onRaidStreamStatus } from "./raid.ts";
import { resetSavingThrowTally } from "./savingthrows.ts";
import { resetShotsForNewStream } from "./shots.ts";
import { onChecklistStreamOnline } from "./checklist.ts";
import { ensureFollowSubscription } from "./follow_thanks.ts";
import { onStreamStatusGuard } from "./stream_guard.ts";
import { onStreamOnlineMotd } from "./motd.ts";

export const STREAM_RECONNECT_GRACE_MS = 5 * 60_000;

/** stream.offline (main.ts): start the grace period; the cron finishes it. */
export async function onStreamOffline(broadcasterId: string, now = Date.now()) {
  // Keep the first drop's time if Twitch redelivers the notification.
  await sqlite.execute(
    "UPDATE broadcasters SET offline_pending_at = ? WHERE broadcaster_id = ? AND is_live = 1 AND offline_pending_at = 0",
    [now, broadcasterId],
  );
  // Already marked offline (e.g. the connect-time seed said so): nothing to wait for.
  const b = await getBroadcaster(broadcasterId);
  if (b && Number(b.is_live) !== 1) await finishStreamOffline(broadcasterId, now);
}

/** stream.online (main.ts): a reconnect inside the grace period resets nothing. */
export async function onStreamOnline(broadcasterId: string, startedAt: unknown, now = Date.now()) {
  const b = await getBroadcaster(broadcasterId);
  const pendingAt = Number(b?.offline_pending_at ?? 0);
  if (pendingAt > 0) {
    const claim = await sqlite.execute(
      "UPDATE broadcasters SET offline_pending_at = 0 WHERE broadcaster_id = ? AND offline_pending_at = ?",
      [broadcasterId, pendingAt],
    );
    if (now - pendingAt <= STREAM_RECONNECT_GRACE_MS) {
      await recordMonitorEvent("stream_reconnect", `${broadcasterId}: back after ${Math.round((now - pendingAt) / 1000)}s`);
      return;
    }
    // The grace ran out but the cron hasn't caught it yet: end the old stream first.
    if (claim.rowsAffected) await finishStreamOffline(broadcasterId, pendingAt, false);
  }

  await setBroadcasterLiveStatus(broadcasterId, true);
  await onRaidStreamStatus(broadcasterId, true, startedAt);
  // A new stream starts a fresh saving throws tally (savingthrows.ts).
  await resetSavingThrowTally(broadcasterId);
  // ...and a fresh shot counter (shots.ts).
  await resetShotsForNewStream(broadcasterId);
  // Start-of-stream checklist for the streamer (checklist.ts).
  if (!(await isChannelBlocked(broadcasterId))) await onChecklistStreamOnline(broadcasterId);
  // Channels connected before follow thank-yous existed (follow_thanks.ts).
  await ensureFollowSubscription(broadcasterId, PUBLIC_ORIGIN);
  // Offline lock + going-live announcement (stream_guard.ts).
  try { await onStreamStatusGuard(broadcasterId, true); } catch (e) { await recordMonitorEvent("stream_guard_error", String(e)); }
  // The developer's message of the day (motd.ts); says nothing when there isn't one.
  try { await onStreamOnlineMotd(broadcasterId); } catch (e) { await recordMonitorEvent("motd_error", String(e)); }
}

/** The stream really ended at `offlineAt`: mark it offline and run the offline hooks. */
async function finishStreamOffline(broadcasterId: string, offlineAt: number, clearPending = true) {
  if (clearPending) await sqlite.execute("UPDATE broadcasters SET offline_pending_at = 0 WHERE broadcaster_id = ?", [broadcasterId]);
  await setBroadcasterLiveStatus(broadcasterId, false);
  await onRaidStreamStatus(broadcasterId, false, undefined);
  try { await onStreamStatusGuard(broadcasterId, false, offlineAt); } catch (e) { await recordMonitorEvent("stream_guard_error", String(e)); }
}

/** Cron (server.ts, every minute): ends streams whose grace period ran out. */
export async function runStreamOfflineGrace(now = Date.now()) {
  const rows = (await sqlite.execute(
    "SELECT broadcaster_id, offline_pending_at FROM broadcasters WHERE offline_pending_at > 0 AND offline_pending_at <= ?",
    [now - STREAM_RECONNECT_GRACE_MS],
  )).rows as any[];
  for (const r of rows) {
    const id = String(r.broadcaster_id);
    const pendingAt = Number(r.offline_pending_at);
    try {
      // Claim it so a stream.online landing at the same moment can't double up.
      const claim = await sqlite.execute(
        "UPDATE broadcasters SET offline_pending_at = 0 WHERE broadcaster_id = ? AND offline_pending_at = ?",
        [id, pendingAt],
      );
      if (claim.rowsAffected) await finishStreamOffline(id, pendingAt, false);
    } catch (e) {
      await recordMonitorEvent("stream_offline_error", `${id}: ${String(e)}`);
    }
  }
}

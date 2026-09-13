// Real Twitch commercial-break ("ad") detection + reminders — distinct
// from the D&D-flavored open-stall merchant "ads" in merchant.ts, which
// are flavor text only. This talks to Twitch's actual Get Ad Schedule API
// using the broadcaster's own OAuth token (channel:read:ads scope,
// requested during /connect and stored in broadcaster_ad_tokens).
//
// !adcheck reports live status from that API when available, falling back
// to a manually logged timestamp (!adslogged) for channels that haven't
// (re)granted the scope yet, or whenever Twitch has nothing to report.

import {
  getAdTracking,
  getBroadcasterAdToken,
  recordManualAdTrigger,
  saveBroadcasterAdToken,
} from "./ads_db.ts";
import { fetchAdSchedule, refreshUserToken, sendChatMessage } from "./twitch.ts";

const AD_REMINDER_MINUTES = Math.max(1, Number(Deno.env.get("AD_REMINDER_MINUTES") ?? "20"));

function minutesSince(msOrIso: number | string): number | null {
  const ts = typeof msOrIso === "number" ? msOrIso : Date.parse(msOrIso);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60_000));
}

function minutesUntil(iso: string): number | null {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.round((ts - Date.now()) / 60_000);
}

/** A valid broadcaster ad-schedule token, refreshing (and persisting the
 * refresh) if the stored one is expiring soon. Returns null if this
 * channel has never granted channel:read:ads, or the refresh itself fails
 * (revoked) — either way the mod needs to (re)visit /connect. */
async function getValidAdToken(broadcasterId: string): Promise<string | null> {
  const row = await getBroadcasterAdToken(broadcasterId);
  if (!row) return null;
  if (Date.now() < Number(row.expires_at) - 60_000) {
    return String(row.access_token);
  }
  try {
    const refreshed = await refreshUserToken(String(row.refresh_token));
    const expiresAt = Date.now() + Math.max(0, Number(refreshed.expires_in ?? 0) * 1000 - 60_000);
    const scope = Array.isArray(refreshed.scope) ? refreshed.scope.join(" ") : String(row.scope ?? "");
    await saveBroadcasterAdToken(
      broadcasterId,
      refreshed.access_token,
      refreshed.refresh_token ?? String(row.refresh_token),
      scope,
      expiresAt,
    );
    return String(refreshed.access_token);
  } catch (_e) {
    return null;
  }
}

/** Handles !adcheck (status) and !adslogged (manual mark). Both mod/
 * broadcaster only. Returns true if the message matched. */
export async function handleAdCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
  baseUrl: string,
): Promise<boolean> {
  const trimmed = chatMessage.trim();
  const isCheck = /^!adcheck$/i.test(trimmed);
  const isLog = /^!adslogged$/i.test(trimmed);
  if (!isCheck && !isLog) return false;

  if (!isModerator) {
    await sendChatMessage(
      `@${display} only the broadcaster or a moderator can use ${isCheck ? "!adcheck" : "!adslogged"}.`,
      broadcasterId,
    );
    return true;
  }

  if (isLog) {
    await recordManualAdTrigger(broadcasterId, display);
    await sendChatMessage(
      `@${display} 📺 Logged — ad break marked as just run. !adcheck will flag it again in ~${AD_REMINDER_MINUTES} min if nothing else rolls first.`,
      broadcasterId,
    );
    return true;
  }

  // !adcheck
  const tracking = await getAdTracking(broadcasterId);
  const manualAgo = tracking?.last_ad_at ? minutesSince(Number(tracking.last_ad_at)) : null;

  const token = await getValidAdToken(broadcasterId);
  if (!token) {
    const bits = [
      `@${display} 📺 Can't read Twitch's ad schedule yet — reconnect at ${baseUrl}/connect to grant ad-read access.`,
      `Last ad: ${manualAgo !== null ? `~${manualAgo} min ago (manually logged)` : "not logged yet — run !adslogged right after you roll one"}.`,
      `Next ad: unknown until reconnected.`,
    ];
    if (manualAgo !== null && manualAgo >= AD_REMINDER_MINUTES) {
      bits.push(`⚠️ that's over ${AD_REMINDER_MINUTES} min — might be time to roll ads.`);
    }
    await sendChatMessage(bits.join(" "), broadcasterId);
    return true;
  }

  let schedule;
  try {
    schedule = await fetchAdSchedule(token, broadcasterId);
  } catch (_e) {
    await sendChatMessage(`@${display} 📺 Twitch's ad schedule API didn't respond — try again shortly.`, broadcasterId);
    return true;
  }

  if (!schedule || (!schedule.nextAdAt && !schedule.lastAdAt)) {
    const bits = [
      `@${display} 📺 No ad schedule data right now (stream may be offline or not yet monetized).`,
      `Last ad: ${manualAgo !== null ? `~${manualAgo} min ago (manually logged)` : "not logged"}.`,
      `Next ad: not scheduled.`,
    ];
    await sendChatMessage(bits.join(" "), broadcasterId);
    return true;
  }

  const apiAgo = schedule.lastAdAt ? minutesSince(schedule.lastAdAt) : null;
  const untilNext = schedule.nextAdAt ? minutesUntil(schedule.nextAdAt) : null;
  const mostRecentAgo = [apiAgo, manualAgo]
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b)[0] ?? null;

  // Lead with the two things asked for at a glance — how long ago the last
  // ad ran, and when the next one can run — then duration/snoozes/warning.
  const bits: string[] = [];
  bits.push(`Last ad: ${mostRecentAgo !== null ? `~${mostRecentAgo} min ago` : "unknown"}`);
  bits.push(
    untilNext === null
      ? "Next ad: not scheduled"
      : untilNext <= 0
        ? "⚠️ Next ad: due now"
        : `Next ad: in ~${untilNext} min`,
  );
  bits.push(`${schedule.durationSeconds || "?"}s long`);
  bits.push(`${schedule.snoozeCount} snooze${schedule.snoozeCount === 1 ? "" : "s"} left`);
  if (mostRecentAgo !== null && mostRecentAgo >= AD_REMINDER_MINUTES && (untilNext === null || untilNext > 2)) {
    bits.push(`⚠️ over ${AD_REMINDER_MINUTES} min since the last ad`);
  }

  await sendChatMessage(`@${display} 📺 Ad status: ${bits.join(" | ")}.`, broadcasterId);
  return true;
}

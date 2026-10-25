// GuildScribe — watch-time chatters poll.
// Run on an interval by server.ts (WATCHTIME_CRON_MINUTES, default 5). Each tick reads every live channel's chat
// list (Twitch Get Chatters, needs the broadcaster to have granted
// moderator:read:chatters via /connect) and credits the time since the last
// tick to everyone in it, lurkers included. The credit is computed from real
// elapsed time, so a faster schedule just makes
// the numbers more precise. See watchtime.ts for the full model.
//
// It also runs the ad-break check (adalerts.ts) for live channels, which
// normally rides on chat activity — so a quiet chat still gets missed breaks
// logged and, when the timing lines up, the heads-up.

import { ensureAdAlertTables, maybeAdHeadsUp } from "./adalerts.ts";
import { recordMonitorEvent } from "./db.ts";
import { ensureWatchtimeTables, getWatchtimePollChannels, pollWatchtime } from "./watchtime.ts";

export default async function () {
  await ensureWatchtimeTables();
  await ensureAdAlertTables();
  const channels = await getWatchtimePollChannels();
  const counts: Record<string, number> = { polled: 0, closed: 0, idle: 0, no_permission: 0, error: 0 };

  for (const { broadcasterId, isLive, reconnecting } of channels) {
    try {
      counts[await pollWatchtime(broadcasterId, isLive, reconnecting)]++;
    } catch (e) {
      counts.error++;
      await recordMonitorEvent("watchtime_poll_error", `${broadcasterId}: ${String(e)}`);
    }
    if (isLive) await maybeAdHeadsUp(broadcasterId);
  }

  console.log(`GuildScribe watchtime cron: ${channels.length} channel(s) — ${JSON.stringify(counts)}`);
}

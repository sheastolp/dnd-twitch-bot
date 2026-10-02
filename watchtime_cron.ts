// GuildScribe — watch-time chatters poll.
// Val Town CRON TRIGGER. Set the schedule in the Val Town UI; every 15 minutes
// is the fastest Val Town allows. Each tick reads every live channel's chat
// list (Twitch Get Chatters, needs the broadcaster to have granted
// moderator:read:chatters via /connect) and credits the time since the last
// tick to everyone in it, lurkers included. The credit is computed from real
// elapsed time, so a faster schedule (if the plan ever allows one) just makes
// the numbers more precise. See watchtime.ts for the full model.

import { recordMonitorEvent } from "./db.ts";
import { ensureWatchtimeTables, getWatchtimePollChannels, pollWatchtime } from "./watchtime.ts";

export default async function () {
  await ensureWatchtimeTables();
  const channels = await getWatchtimePollChannels();
  const counts: Record<string, number> = { polled: 0, closed: 0, idle: 0, no_permission: 0, error: 0 };

  for (const { broadcasterId, isLive } of channels) {
    try {
      counts[await pollWatchtime(broadcasterId, isLive)]++;
    } catch (e) {
      counts.error++;
      await recordMonitorEvent("watchtime_poll_error", `${broadcasterId}: ${String(e)}`);
    }
  }

  console.log(`GuildScribe watchtime cron: ${channels.length} channel(s) — ${JSON.stringify(counts)}`);
}

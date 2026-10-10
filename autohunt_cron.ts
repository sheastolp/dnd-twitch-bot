// GuildScribe — autohunt settlement.
// Val Town CRON TRIGGER (interval val). Set the schedule in the Val Town UI;
// every 15 minutes is Val Town's minimum and is plenty: each run settles every
// bout that has come due since the last one and posts ONE chat message per
// channel: a lone hunter's full report, or for several a roll call of everyone
// autohunting with their W/L (see postAutohuntReports in autohunt.ts).
//
// Only channels that are live get settled; an offline channel's sessions wait
// (their end time still counts down, so the hunt can finish the moment the
// stream returns). A session's own !autohunt / status / stop also settles it,
// and claims are atomic, so the two can never both pay the same bout.

import { ensureTables, recordMonitorEvent } from "./db.ts";
import { ensureAutohuntTables, getDueAutohuntSessions } from "./autohunt_db.ts";
import { ensureBestiaryTables } from "./bestiary.ts";
import { type AutohuntReport, postAutohuntReports, settleAutohunt } from "./autohunt.ts";
import { ensureRaidTables, getExpiredRaidMusters, maybeLaunchRaid } from "./raid.ts";

export default async function () {
  await ensureTables();
  await ensureAutohuntTables();
  await ensureBestiaryTables();
  const now = Date.now();
  const due = await getDueAutohuntSessions(now);
  let reports = 0;
  let skippedOffline = 0;
  // Settle everyone first, then post each channel's reports together.
  const byChannel = new Map<string, AutohuntReport[]>();

  for (const { is_live, ...session } of due) {
    if (!is_live) {
      skippedOffline++;
      continue;
    }
    try {
      const report = await settleAutohunt(session, { now });
      if (report) {
        const list = byChannel.get(session.broadcaster_id) ?? [];
        list.push(report);
        byChannel.set(session.broadcaster_id, list);
        reports++;
      }
    } catch (e) {
      await recordMonitorEvent("autohunt_settle_error", `${session.broadcaster_id}#${session.username}: ${String(e)}`);
    }
  }
  for (const [broadcasterId, list] of byChannel) {
    try {
      await postAutohuntReports(list, broadcasterId);
    } catch (e) {
      await recordMonitorEvent("autohunt_post_error", `${broadcasterId}: ${String(e)}`);
    }
  }

  // Fallback for raid musters (raid.ts): normally the next chat message
  // launches one whose time is up; this catches a muster in a quiet chat.
  await ensureRaidTables();
  for (const broadcasterId of await getExpiredRaidMusters(now)) {
    try {
      await maybeLaunchRaid(broadcasterId, { now });
    } catch (e) {
      await recordMonitorEvent("raid_launch_error", `${broadcasterId}: ${String(e)}`);
    }
  }

  console.log(`GuildScribe autohunt cron: ${reports} report(s) from ${due.length} due session(s) (${skippedOffline} skipped offline)`);
}

// GuildScribe — open-stall merchant, periodic posting.
// Val Town CRON TRIGGER. Set the schedule in the Val Town UI; every 5-10
// minutes is a good tick rate. The actual per-channel posting cadence is
// randomized (see MERCHANT_MIN/MAX_INTERVAL_MINUTES in merchant.ts) and
// tracked per-broadcaster in the merchant_settings table via next_post_at,
// so a frequent tick here just checks who's due rather than posting on
// every run.
//
// Every tick's outcome (channels due, posts sent, posts failed, last error)
// is written to merchant_cron_status via recordMerchantCronRun, readable at
// GET /admin/merchant/status (see main.ts) without needing to dig through
// Val Town's run history or the raw monitor_events table.

import {
  ensureTables,
  getDueMerchantChannels,
  recordMerchantCronRun,
  recordMonitorEvent,
  rescheduleMerchant,
} from "./db.ts";
import { sendChatMessage } from "./twitch.ts";
import { generateMerchantAd, randomMerchantIntervalMs } from "./merchant.ts";

export default async function () {
  await ensureTables();
  const now = Date.now();
  const due = await getDueMerchantChannels(now);

  let postsOk = 0;
  let postsFailed = 0;
  let lastError: string | null = null;

  for (const broadcasterId of due) {
    try {
      await sendChatMessage(generateMerchantAd(), broadcasterId);
      postsOk++;
    } catch (e) {
      postsFailed++;
      lastError = `${broadcasterId}: ${String(e)}`;
      // console.error (not console.log) so it's visible in Val Town's run
      // history at a glance, in addition to the persisted DB record below.
      console.error(
        `GuildScribe merchant cron: failed to post to ${broadcasterId}:`,
        e,
      );
      await recordMonitorEvent("merchant_post_error", lastError);
    }
    // Always reschedule, even on a send failure, so one bad channel can't
    // wedge the cron into retrying it every tick forever.
    try {
      await rescheduleMerchant(broadcasterId, now + randomMerchantIntervalMs());
    } catch (e) {
      // Rescheduling is what prevents a retry storm, so a failure here is
      // worth its own alarm even if the post itself succeeded.
      const detail = `${broadcasterId}: ${String(e)}`;
      console.error(
        `GuildScribe merchant cron: failed to reschedule ${broadcasterId}:`,
        e,
      );
      await recordMonitorEvent("merchant_reschedule_error", detail);
      postsFailed++;
      lastError = detail;
    }
  }

  await recordMerchantCronRun(now, due.length, postsOk, postsFailed, lastError);

  const summary =
    `GuildScribe merchant cron: ${due.length} channel(s) due, ${postsOk} posted, ${postsFailed} failed`;
  if (postsFailed > 0) {
    console.error(summary);
  } else {
    console.log(summary);
  }
}
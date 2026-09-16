// GuildScribe — open-stall merchant, periodic posting.
// Val Town CRON TRIGGER. Set the schedule in the Val Town UI; every 5-10
// minutes is a good tick rate. The actual per-channel posting cadence is
// randomized (see MERCHANT_MIN/MAX_INTERVAL_MINUTES in merchant.ts) and
// tracked per-broadcaster in the merchant_settings table via next_post_at,
// so a frequent tick here just checks who's due rather than posting on
// every run.

import { ensureTables, getDueMerchantChannels, rescheduleMerchant, recordMonitorEvent, recordMerchantCronRun } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";
import { generateMerchantAd, randomMerchantIntervalMs } from "./merchant.ts";

export default async function () {
  await ensureTables();
  const now = Date.now();
  const due = await getDueMerchantChannels(now);
  let postsOk = 0;
  let postsFailed = 0;
  let postsSkippedOffline = 0;

  for (const { broadcasterId, isLive } of due) {
    try {
      // Skip posting (but still reschedule below) while the channel is
      // offline — no point hawking wares to an empty chat. isLive comes
      // straight from the query (broadcasters.is_live), kept current by the
      // stream.online/offline EventSub notifications in main.ts, so this is
      // a plain column read, not a Twitch API call. Not counted as an
      // ok/failed post so /admin/merchant/status doesn't read this as a
      // real send.
      if (!isLive) {
        postsSkippedOffline++;
      } else if (await sendChatMessage(generateMerchantAd(), broadcasterId)) {
        postsOk++;
      } else {
        postsFailed++;
      }
    } catch (e) {
      postsFailed++;
      await recordMonitorEvent("merchant_post_error", `${broadcasterId}: ${String(e)}`);
    }
    // Always reschedule, even on a send failure, so one bad channel can't
    // wedge the cron into retrying it every tick forever.
    await rescheduleMerchant(broadcasterId, now + randomMerchantIntervalMs());
  }

  // Recorded even when nothing was due, so GET /admin/merchant/status can
  // tell "cron ticked, nobody due" apart from "cron hasn't ticked in a while".
  await recordMerchantCronRun(due.length, postsOk, postsFailed);

  console.log(
    `GuildScribe merchant cron: posted to ${postsOk} of ${due.length} due channel(s) (${postsSkippedOffline} skipped offline, ${postsFailed} failed)`,
  );
}

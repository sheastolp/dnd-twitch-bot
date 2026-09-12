// GuildScribe — timed messages, periodic posting.
// Val Town CRON TRIGGER. Set the schedule in the Val Town UI; every 5-10
// minutes is a good tick rate (Val Town's cron minimum is 15 minutes, which
// caps how precisely any message's own interval can be honored — the same
// slop already accepted for merchant.cron.ts). Each timed_messages row
// schedules its own next_post_at (see db.ts), so a frequent tick here just
// checks who's due rather than posting on every run, and messages with
// different intervals in the same channel rotate independently.

import { ensureTables, getDueTimedMessages, recordTimedMessageSent, recordMonitorEvent } from "./db.ts";
import { sendChatMessages } from "./twitch.ts";
import { renderTimedMessage } from "./timedmessages.ts";

export default async function () {
  await ensureTables();
  const now = Date.now();
  const due = await getDueTimedMessages(now);

  for (const row of due) {
    const id = Number(row.id);
    const broadcasterId = String(row.broadcaster_id);
    const intervalMinutes = Number(row.interval_minutes);
    try {
      const text = renderTimedMessage(String(row.message ?? ""), Number(row.uses ?? 0) + 1);
      await sendChatMessages(text, broadcasterId);
    } catch (e) {
      await recordMonitorEvent("timedmsg_post_error", `${broadcasterId}#${id}: ${String(e)}`);
    }
    // Always reschedule, even on a send failure, so one bad channel/message
    // can't wedge the cron into retrying it every tick forever.
    await recordTimedMessageSent(id, now + intervalMinutes * 60_000);
  }

  console.log(`GuildScribe timed messages cron: posted ${due.length} message(s)`);
}

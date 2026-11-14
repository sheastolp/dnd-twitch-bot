// Hydration reminders for the shot counter (shots.ts): while a channel is
// live with the shots switch on, GuildScribe reminds the streamer in chat
// every shots.hydrate minutes (default 30, "off" turns it off; Quick setup →
// Shot counter → ⚙ Options) to drink some water or anything non-alcoholic,
// mentioning the shot count once there is one.
//
// server.ts runs this every minute. The timer is kept in memory per channel
// and starts when the channel is first seen live, so the first reminder
// comes one interval into the stream (or after a bot restart), never the
// moment it goes live. A channel-point reward with "hydrate" in its title
// (onHydrateRedemption) restarts the timer and says so in chat.

import { sqlite } from "./sqlite.ts";
import { sendChatMessage } from "./twitch.ts";
import { isChannelBlocked, isChannelEnabled, isCommandGroupEnabled } from "./db.ts";
import { optNum } from "./channel_options.ts";
import { getShotCount, shotWords } from "./shots.ts";
import { pick } from "./utils.ts";

// broadcaster_id → when the last reminder went out (or the timer started).
const lastReminder = new Map<string, number>();

/** A channel-point reward that's about hydrating ("Hydrate!", "Hydration
 * check", "Make the streamer hydrate"). */
export function isHydrateReward(title: string): boolean {
  return /\bhydrat(?:e|es|ed|ion|ing)\b/i.test(title);
}

/** EventSub channel-point redemption (main.ts): a hydrate reward restarts
 * the timer, so the next reminder is a full interval after it. */
// deno-lint-ignore no-explicit-any
export async function onHydrateRedemption(event: any, now = Date.now()): Promise<boolean> {
  const id = String(event?.broadcaster_user_id ?? "");
  const title = String(event?.reward?.title ?? "");
  if (!id || !isHydrateReward(title)) return false;
  lastReminder.set(id, now);
  const everySec = await optNum(id, "shots.hydrate");
  if (everySec <= 0 || !(await isCommandGroupEnabled(id, "shots"))) return true;
  if (!(await isChannelEnabled(id)) || (await isChannelBlocked(id))) return true;
  const who = String(event?.user_name ?? event?.user_login ?? "Someone");
  const mins = Math.round(everySec / 60);
  await sendChatMessage(`💧 ${who} redeemed "${title}" — drink up! Next hydration reminder in ${mins} minute${mins === 1 ? "" : "s"}.`, id);
  return true;
}

/** When the next reminder is due for a channel (tests and the timer). */
export function hydrationTimerStartedAt(broadcasterId: string): number | undefined {
  return lastReminder.get(broadcasterId);
}

const PLAIN = [
  "💧 Hydration check! Grab some water (or anything without alcohol) — the quest goes better hydrated.",
  "💧 The healer insists: drink some water. Non-alcoholic potions only for this one.",
  "💧 Water break! A glass of something without alcohol keeps the adventurer on their feet.",
  "💧 Even dragons drink water. Time for a non-alcoholic sip, streamer.",
];

const WITH_SHOTS = [
  (n: string) => `💧 ${n} down this stream — chase it with some water (or anything non-alcoholic)!`,
  (n: string) => `💧 Hydration check: ${n} so far, so the next one's water. Non-alcoholic, please!`,
  (n: string) => `💧 The barkeep slides over a glass of water: ${n} in, time to hydrate with something non-alcoholic.`,
];

/** The reminder text for a channel with `count` shots so far. */
export function hydrationLine(count: number, w: { one: string; many: string }): string {
  return count > 0 ? pick(WITH_SHOTS)(`${count} ${count === 1 ? w.one : w.many}`) : pick(PLAIN);
}

/** One tick: post the reminder in every live channel that's due. */
export async function runHydrationReminders(now = Date.now()): Promise<void> {
  const { rows } = await sqlite.execute(`SELECT broadcaster_id FROM broadcasters WHERE is_live = 1 AND connected = 1`);
  const live = new Set((rows as any[]).map((r) => String(r.broadcaster_id)));
  // Offline channels start over next stream.
  for (const id of lastReminder.keys()) if (!live.has(id)) lastReminder.delete(id);

  for (const id of live) {
    try {
      const everySec = await optNum(id, "shots.hydrate");
      if (everySec <= 0 || !(await isCommandGroupEnabled(id, "shots"))) {
        lastReminder.delete(id);
        continue;
      }
      const since = lastReminder.get(id);
      if (since === undefined) {
        lastReminder.set(id, now); // timer starts now
        continue;
      }
      if (now - since < everySec * 1000) continue;
      lastReminder.set(id, now);
      if (!(await isChannelEnabled(id)) || (await isChannelBlocked(id))) continue;
      const [count, w] = await Promise.all([getShotCount(id), shotWords(id)]);
      await sendChatMessage(hydrationLine(count, w), id);
    } catch (e) {
      console.error(`hydration reminder failed for ${id}:`, e);
    }
  }
}

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
// (onHydrateRedemption) restarts the timer and tells chat how long it's
// been since the redeem before it, and every
// reminder says how long it's been since the last one (hydrate_redeems,
// cleared when a new stream starts, so it survives a bot restart).

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
  const previous = await lastHydrateRedeem(id);
  await saveRedeem(id, now, title);
  if (!(await isCommandGroupEnabled(id, "shots"))) return true;
  if (!(await isChannelEnabled(id)) || (await isChannelBlocked(id))) return true;
  const who = String(event?.user_name ?? event?.user_login ?? "Someone");
  await sendChatMessage(hydrateRedeemLine(who, title, previous, now), id);
  return true;
}

/** The chat line for a hydrate redeem: how long since the one before it. */
export function hydrateRedeemLine(who: string, title: string, previous: { at: number } | null, now = Date.now()): string {
  const since = previous
    ? `It's been ${sinceText(now - previous.at)} since the last one`
    : "That's the first one this stream";
  return `💧 ${who} redeemed "${title}" — drink up! ${since}.`;
}

/** When the next reminder is due for a channel (tests and the timer). */
export function hydrationTimerStartedAt(broadcasterId: string): number | undefined {
  return lastReminder.get(broadcasterId);
}

// ── The last hydrate redeem this stream (survives a bot restart) ──

export async function ensureHydrateTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS hydrate_redeems (
      broadcaster_id TEXT PRIMARY KEY,
      redeemed_at INTEGER NOT NULL,
      reward_title TEXT NOT NULL DEFAULT ''
    )`,
  );
}

async function saveRedeem(broadcasterId: string, at: number, title: string) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO hydrate_redeems (broadcaster_id, redeemed_at, reward_title) VALUES (?, ?, ?)",
    [broadcasterId, at, title.slice(0, 100)],
  );
}

/** The last hydrate redeem this stream, or null. */
export async function lastHydrateRedeem(broadcasterId: string): Promise<{ at: number; title: string } | null> {
  const { rows } = await sqlite.execute("SELECT redeemed_at, reward_title FROM hydrate_redeems WHERE broadcaster_id = ?", [broadcasterId]);
  const r = (rows as any[])[0];
  return r ? { at: Number(r.redeemed_at), title: String(r.reward_title ?? "") } : null;
}

/** stream.online (stream_status.ts): a new stream has had no redeem yet. */
export async function resetHydrationForNewStream(broadcasterId: string) {
  lastReminder.delete(broadcasterId);
  await sqlite.execute("DELETE FROM hydrate_redeems WHERE broadcaster_id = ?", [broadcasterId]).catch(() => {});
}

export async function purgeHydrateData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM hydrate_redeems WHERE broadcaster_id = ?", [broadcasterId]).catch(() => {});
}

/** 45_000 → "1 minute", 75 min → "1 hour 15 minutes". */
export function sinceText(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(mins / 60), m = mins % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (!h) return part(m, "minute");
  return m ? `${part(h, "hour")} ${part(m, "minute")}` : part(h, "hour");
}

const TAILS = [
  "grab some water (or anything without alcohol)!",
  "time for a glass of water — non-alcoholic, please!",
  "the healer insists on some water. Non-alcoholic potions only!",
  "even dragons drink water. Time for a non-alcoholic sip!",
];

/** The reminder text: how long since the last hydrate redeem (or that there
 * hasn't been one this stream), the shot count once there is one, and a
 * nudge toward water or anything non-alcoholic. */
export function hydrationLine(count: number, w: { one: string; many: string }, lastRedeem: { at: number; title: string } | null, now = Date.now()): string {
  const reward = lastRedeem?.title ? `“${lastRedeem.title}”` : "hydrate";
  const since = lastRedeem
    ? `It's been ${sinceText(now - lastRedeem.at)} since the last ${reward} redeem`
    : "No hydrate redeem yet this stream";
  const shots = count > 0 ? ` and ${count} ${count === 1 ? `${w.one} is` : `${w.many} are`} down` : "";
  return `💧 Hydration check! ${since}${shots} — ${pick(TAILS)}`;
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
      const [count, w, redeem] = await Promise.all([getShotCount(id), shotWords(id), lastHydrateRedeem(id)]);
      await sendChatMessage(hydrationLine(count, w, redeem, now), id);
    } catch (e) {
      console.error(`hydration reminder failed for ${id}:`, e);
    }
  }
}

// Per-person reply limit: the bot answers any one chatter at most
// REPLY_LIMIT_COUNT times per REPLY_LIMIT_WINDOW_MS (default 2 a minute).
//
// main.ts checks hasReplyBudget() before running any chat handler for a
// non-mod chatter and drops the message silently when they're out of budget
// (a "slow down" reply would itself be a reply). The handlers then run
// inside trackReplies(), and only if one of them actually posted to chat
// does the use get recorded — so a "!lurk" meant for another bot, or plain
// chat nobody answered, costs nothing. One command counts once, however
// many chat messages its answer takes.
//
// Sends from work started outside trackReplies (raid musters, ad heads-ups
// and other defer()'d bookkeeping) never count against the chatter.

import { AsyncLocalStorage } from "node:async_hooks";
import { sqlite } from "./sqlite.ts";

export const REPLY_LIMIT_COUNT = Math.max(1, Number(Deno.env.get("REPLY_LIMIT_COUNT") ?? "2"));
export const REPLY_LIMIT_WINDOW_MS = Math.max(1000, Number(Deno.env.get("REPLY_LIMIT_WINDOW_MS") ?? "60000"));

const replyScope = new AsyncLocalStorage<{ sent: boolean }>();

export async function ensureReplyLimitTables() {
  // times: comma-separated epoch ms of this chatter's most recent replies.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS reply_rate_limits (broadcaster_id TEXT, username TEXT, times TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, PRIMARY KEY (broadcaster_id, username))`,
  );
}

function recentTimes(raw: unknown, now: number): number[] {
  return String(raw ?? "")
    .split(",")
    .map(Number)
    .filter((t) => Number.isFinite(t) && t > now - REPLY_LIMIT_WINDOW_MS);
}

/** Whether the bot may still answer this chatter right now. */
export async function hasReplyBudget(broadcasterId: string, username: string): Promise<boolean> {
  const res = await sqlite.execute("SELECT times FROM reply_rate_limits WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username]);
  return recentTimes(res.rows[0]?.times, Date.now()).length < REPLY_LIMIT_COUNT;
}

let lastPrune = 0;

/** Counts one reply to this chatter against their budget. */
export async function recordReply(broadcasterId: string, username: string) {
  const now = Date.now();
  const res = await sqlite.execute("SELECT times FROM reply_rate_limits WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username]);
  const times = [...recentTimes(res.rows[0]?.times, now), now].slice(-REPLY_LIMIT_COUNT);
  await sqlite.execute(
    `INSERT INTO reply_rate_limits (broadcaster_id,username,times,updated_at) VALUES (?,?,?,?)
     ON CONFLICT(broadcaster_id,username) DO UPDATE SET times = excluded.times, updated_at = excluded.updated_at`,
    [broadcasterId, username, times.join(","), now],
  );
  if (now - lastPrune > 60_000) {
    lastPrune = now;
    sqlite.execute("DELETE FROM reply_rate_limits WHERE updated_at < ?", [now - REPLY_LIMIT_WINDOW_MS - 60_000]).catch(() => {});
  }
}

/** Called by sendChatMessage: marks that the handlers being tracked replied. */
export function markReplySent() {
  const store = replyScope.getStore();
  if (store) store.sent = true;
}

/** Runs the chat handlers for one message; if `limited` and any of them
 * posted to chat, records the reply against the chatter. */
export async function trackReplies<T>(broadcasterId: string, username: string, limited: boolean, fn: () => Promise<T>): Promise<T> {
  if (!limited) return await fn();
  const store = { sent: false };
  try {
    return await replyScope.run(store, fn);
  } finally {
    if (store.sent) await recordReply(broadcasterId, username).catch((e) => console.error("recordReply failed", e));
  }
}

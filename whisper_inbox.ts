// Commands by whisper: a viewer can whisper the bot "!roll d20" (or just
// "roll d20") instead of typing in a stream's chat — on the mobile app,
// switching between the stream and whispers is awkward, so everything can
// stay in the whisper thread.
//
// Twitch delivers whispers to the bot as the EventSub user.whisper.message
// event (one subscription for the bot account, created once /connect-bot is
// done — see ensureWhisperInboxSubscription). A whisper has no channel, so
// it's run in the channel the viewer last chatted in (whisper_channels, kept
// current from chat by noteViewerChannel), or the one they picked by
// whispering "!channel <name>". main.ts runs it like a chat message from
// them in that channel, in whisper mode "all" (whisper.ts): replies to them
// are whispered, and anything posted for the whole chat (fight results, a
// duel challenge…) is posted there and whispered to them too.
//
// Whispered commands skip the spam filters (nothing reaches chat) and count
// the viewer as a plain viewer: mod-only commands still need chat.

import { sqlite } from "./sqlite.ts";
import { PUBLIC_ORIGIN } from "./config.ts";
import { getBroadcaster, getBroadcasterByLogin, isChannelBlocked, recordMonitorEvent } from "./db.ts";
import { createBotWhisperSubscription } from "./twitch.ts";
import { hasBotWhisperToken, sendWhisperParts, WHISPER_MAX } from "./whisper.ts";
import { splitChatMessage } from "./utils.ts";

const RETRY_SUBSCRIBE_MS = 10 * 60_000;

export async function ensureWhisperInboxTables() {
  // The bot's one user.whisper.message subscription (one row).
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS whisper_inbox (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      subscription_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
  // Which channel a viewer's whispered commands run in.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS whisper_channels (
      user_id TEXT PRIMARY KEY,
      broadcaster_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
}

// ── The subscription ──

let subscribed = false;
let lastAttempt = 0;

/** Makes sure Twitch sends the bot's whispers here. Cheap after the first
 * call per isolate; retries a failed attempt at most every few minutes.
 * `force` (right after /connect-bot) recreates it regardless. Returns true
 * when subscribed, false when /connect-bot isn't done; throws Twitch's error. */
export async function ensureWhisperInboxSubscription(force = false): Promise<boolean> {
  if (subscribed && !force) return true;
  if (!force && Date.now() - lastAttempt < RETRY_SUBSCRIBE_MS) return false;
  lastAttempt = Date.now();
  if (!force && (await sqlite.execute("SELECT 1 FROM whisper_inbox WHERE id = 1")).rows.length) {
    subscribed = true;
    return true;
  }
  if (!(await hasBotWhisperToken())) return false;
  try {
    const sub = await createBotWhisperSubscription(PUBLIC_ORIGIN);
    await sqlite.execute("INSERT OR REPLACE INTO whisper_inbox (id, subscription_id, created_at) VALUES (1, ?, ?)", [String(sub.id), Date.now()]);
    subscribed = true;
    return true;
  } catch (e) {
    await recordMonitorEvent("whisper_inbox_subscribe_failed", String(e)).catch(() => {});
    throw e;
  }
}

/** Twitch revoked the subscription (e.g. the bot's grant was removed):
 * forget it so the next attempt recreates it. */
export async function forgetWhisperInboxSubscription() {
  subscribed = false;
  lastAttempt = 0;
  await sqlite.execute("DELETE FROM whisper_inbox WHERE id = 1").catch(() => {});
}

// ── Which channel ──

const channelCache = new Map<string, string>();

/** Records the channel a viewer just chatted in; writes only on a change. */
export async function noteViewerChannel(userId: string, broadcasterId: string) {
  if (!userId || channelCache.get(userId) === broadcasterId) return;
  await sqlite.execute(
    "INSERT OR REPLACE INTO whisper_channels (user_id, broadcaster_id, updated_at) VALUES (?, ?, ?)",
    [userId, broadcasterId, Date.now()],
  );
  channelCache.set(userId, broadcasterId);
  if (channelCache.size > 5000) channelCache.delete(channelCache.keys().next().value!);
}

async function viewerChannel(userId: string): Promise<string | null> {
  const row: any = (await sqlite.execute("SELECT broadcaster_id FROM whisper_channels WHERE user_id = ?", [userId])).rows[0];
  return row ? String(row.broadcaster_id) : null;
}

function whisperBack(userId: string, text: string) {
  return sendWhisperParts(userId, splitChatMessage(text, WHISPER_MAX).filter((p) => p.trim()));
}

const channelName = (b: any) => String(b?.display_name || b?.login || "that channel");

/** A user.whisper.message event: answers !channel itself, otherwise returns
 * the command to run as a chat message in the viewer's channel (main.ts),
 * or null when there's nothing to run. */
export async function whisperedCommand(event: any): Promise<{ text: string; userId: string; login: string; display: string; broadcasterId: string } | null> {
  const userId = String(event?.from_user_id ?? "");
  const login = String(event?.from_user_login ?? "");
  const display = String(event?.from_user_name ?? login);
  let text = String(event?.whisper?.text ?? "").trim();
  if (!userId || !text || userId === Deno.env.get("TWITCH_BOT_ID")) return null;
  if (!text.startsWith("!")) text = `!${text}`;

  const pick = text.match(/^!channel(?:\s+@?([A-Za-z0-9_]{1,25}))?$/i);
  if (pick) {
    if (!pick[1]) {
      const current = await viewerChannel(userId);
      const b = current ? await getBroadcaster(current) : null;
      await whisperBack(
        userId,
        b
          ? `Your whispered commands go to ${channelName(b)}'s channel. Whisper !channel <name> to switch (chatting in a channel switches too).`
          : "No channel yet — chat once in a channel GuildScribe is in, or whisper !channel <name>.",
      );
      return null;
    }
    const b: any = await getBroadcasterByLogin(pick[1]);
    if (!b || Number(b.connected) !== 1 || (await isChannelBlocked(String(b.broadcaster_id)))) {
      await whisperBack(userId, `GuildScribe isn't in ${pick[1]}'s channel.`);
      return null;
    }
    await noteViewerChannel(userId, String(b.broadcaster_id));
    await whisperBack(userId, `✅ Your whispered commands now go to ${channelName(b)}'s channel.`);
    return null;
  }

  const broadcasterId = await viewerChannel(userId);
  const b: any = broadcasterId ? await getBroadcaster(broadcasterId) : null;
  if (!broadcasterId || !b || Number(b.connected) !== 1) {
    await whisperBack(userId, "Which channel is this for? Chat once in a channel GuildScribe is in, or whisper !channel <name>, then whisper your command again.");
    return null;
  }
  return { text, userId, login, display, broadcasterId };
}

/** Whispered when a whispered command can't run because the stream is offline. */
export function whisperOffline(userId: string, broadcasterId: string) {
  return (async () => {
    const b = await getBroadcaster(broadcasterId);
    await whisperBack(userId, `${channelName(b)} isn't live, so commands are paused there. Whisper !channel <name> to use another channel.`);
  })();
}

// First-time chatter manners: a viewer whose very first message in a channel
// asks to play ("can I join?", "add me") or for help ("help me pls") gets a
// friendly reminder to talk with chat first. Dashboard switch "firstchat"
// (off by default, like every group).
//
// Twitch's EventSub chat event has no "first-time chatter" flag (that's an
// IRC-only tag), so a message counts as a first chat when either:
//   - Twitch marked it as a first-chat intro (message_type "user_intro"), or
//   - GuildScribe has never seen this login chat in this channel before
//     (chatters_seen). The table is seeded from the nickname/viewer-name
//     tables so existing regulars aren't treated as new, and a channel still
//     in its first LEARNING_MS of tracking only trusts Twitch's intro flag,
//     so a freshly connected channel doesn't flag every regular.

import { sqlite } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";
import { ensureViewerNameTables } from "./mentions.ts";

const LEARNING_MS = 3 * 24 * 60 * 60_000;

export async function ensureFirstChatterTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS chatters_seen (
      broadcaster_id TEXT NOT NULL, username TEXT NOT NULL, first_seen INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, username)
    )`,
  );
  // Everyone the bot already knows counts as seen (first_seen 0, so it also
  // ends the channel's learning window). Its tables are created first since
  // schema setup runs the ensure functions in parallel.
  await ensureViewerNameTables();
  await sqlite.execute("INSERT OR IGNORE INTO chatters_seen (broadcaster_id, username, first_seen) SELECT broadcaster_id, username, 0 FROM viewer_nicknames");
  await sqlite.execute("INSERT OR IGNORE INTO chatters_seen (broadcaster_id, username, first_seen) SELECT broadcaster_id, username, 0 FROM viewer_names");
}

export async function purgeFirstChatterData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM chatters_seen WHERE broadcaster_id = ?", [broadcasterId]);
  for (const key of seenCache) if (key.startsWith(`${broadcasterId}:`)) seenCache.delete(key);
  trackingSince.delete(broadcasterId);
}

// Per-isolate caches so a regular's messages skip the write entirely.
const seenCache = new Set<string>();
const trackingSince = new Map<string, number>();

/** Records the chatter as seen; true if this is the first time the channel
 * has seen them. */
async function markSeen(broadcasterId: string, login: string): Promise<boolean> {
  const key = `${broadcasterId}:${login}`;
  if (seenCache.has(key)) return false;
  const res = await sqlite.execute("INSERT OR IGNORE INTO chatters_seen (broadcaster_id, username, first_seen) VALUES (?,?,?)", [
    broadcasterId,
    login,
    Date.now(),
  ]);
  seenCache.add(key);
  return Boolean(res.rowsAffected);
}

async function stillLearning(broadcasterId: string): Promise<boolean> {
  let since = trackingSince.get(broadcasterId);
  if (since === undefined) {
    const res = await sqlite.execute("SELECT MIN(first_seen) AS since FROM chatters_seen WHERE broadcaster_id = ?", [broadcasterId]);
    since = Number(res.rows[0]?.since ?? Date.now());
    trackingSince.set(broadcasterId, since);
  }
  return Date.now() - since < LEARNING_MS;
}

const PLAY_PATTERNS: RegExp[] = [
  /\b(?:can|could|may|lemme|let)\s+(?:i|me|we|us)\s+(?:please\s+|pls\s+|plz\s+)?(?:play|join|hop\s+in|jump\s+in|squad\s+up|team\s+up|duo|queue)\b/,
  /\b(?:i|we)\s+(?:wanna|want\s+to|would\s+like\s+to|'d\s+like\s+to)\s+(?:play|join)\b/,
  /\bplay\s+with\s+(?:me|us|you|u)\b/,
  /\b(?:add|invite|inv|carry|boost)\s+me\b/,
  /\blemme\s+(?:play|join)\b/,
  /\bjoin\s+(?:you|u)\b/,
  /\bjoin\s+(?:your|ur|the)\s+(?:next\s+)?(?:game|party|lobby|squad|team|group|server|session|campaign|table|match|run)\b/,
  /\b(?:what(?:'?s|\s+is)\s+(?:your|ur)\s+)(?:friend\s+code|gamertag|gamer\s+tag|psn|xbox|epic|steam|ign|username|lobby\s+code)\b/,
];

const HELP_PATTERNS: RegExp[] = [
  /\bhelp\s+me\b/,
  /\bneed\s+(?:some\s+)?help\b/,
  /\b(?:can|could|would)\s+(?:you|u|someone|anyone|somebody|anybody)\s+(?:please\s+|pls\s+)?help\b/,
  /\b(?:pls|plz|please)\s+help\b/,
  /\bhelp\s+(?:pls|plz|please)\b/,
];

/** True when a plain chat message asks to play with the streamer or for help. */
export function isPlayOrHelpRequest(text: string): boolean {
  const t = text.toLowerCase().replace(/[’`]/g, "'");
  return PLAY_PATTERNS.some((re) => re.test(t)) || HELP_PATTERNS.some((re) => re.test(t));
}

/** Tracks every chatter as seen, and reminds a first-time chatter whose
 * message is a play/help request to talk first. True if a reminder was sent. */
export async function maybeRemindFirstChatter(opts: {
  chatMessage: string;
  messageType: string;
  chatter: string;
  display: string;
  broadcasterId: string;
  isModerator: boolean;
  enabled: () => Promise<boolean>;
}): Promise<boolean> {
  const { chatMessage, messageType, chatter, display, broadcasterId, isModerator } = opts;
  const login = chatter.toLowerCase();
  if (!login) return false;
  const firstForBot = await markSeen(broadcasterId, login);
  if (isModerator || chatMessage.startsWith("!")) return false;
  const intro = messageType === "user_intro";
  if (!intro && !firstForBot) return false;
  if (!isPlayOrHelpRequest(chatMessage)) return false;
  if (!intro && await stillLearning(broadcasterId)) return false;
  if (!(await opts.enabled())) return false;
  await sendChatMessage(
    `@${display} Welcome to the guild hall! Hang out and chat with us for a bit before asking to play or for help — say hi first and get to know the party. 🛡️`,
    broadcasterId,
  );
  return true;
}

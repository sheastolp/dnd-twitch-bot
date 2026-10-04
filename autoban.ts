// Auto-ban for "ai viewers" spam — the fake-viewer-service bots that drop
// "get ai viewers for your stream" style ads into chat. When a non-mod
// chatter's message contains a phrase on the channel's auto-ban list, the bot
// permanently bans them and posts a short D&D-flavored "I just banned another
// one for you" line.
//
// The list is per channel and starts with "ai viewers"; mods edit it, and the
// ignore list, on /dashboard/autoban (autoban_page.ts). It also learns: domains
// in banned messages, and promo pitches sent by several chatters, are added
// on their own (see autoban_words.ts).
//
// Off by default per channel (toggle: !autoban on|off|status; on/off are
// broadcaster or mod) because a permanent ban is not something to switch on for
// a channel that didn't ask for it.
//
// Bans go through Helix Ban User, which needs a *user* access token for a
// moderator of the channel with the moderator:manage:banned_users scope. The
// channel's own broadcaster token — the one /connect already stores in
// broadcaster_ad_tokens (see ads_db.ts) — qualifies: a broadcaster is always
// a moderator of their own channel, and ads.ts already refreshes that token
// when it expires. Channels that connected before this scope was requested
// simply have no ban permission until they revisit /connect; the toggle
// tells them so instead of silently doing nothing.

import { sqlite } from "./sqlite.ts";
import { getValidAdToken } from "./ads.ts";
import { getBroadcasterAdToken } from "./ads_db.ts";
import { recordMonitorEvent } from "./db.ts";
import { banChatUser, sendChatMessage } from "./twitch.ts";
import { pick } from "./utils.ts";
import { describeMatch, ensureAutoBanHistoryTables, findHistoryMatch, purgeAutoBanHistory, recordBan } from "./autoban_history.ts";
import { currentLearnMode, ensureAutoBanWordTables, findMatch, isUserIgnored, purgeAutoBanWordData, suggestFromHistory, learnFromBannedMessage, learnFromMessage, recordHit } from "./autoban_words.ts";

export const BAN_SCOPE = "moderator:manage:banned_users";

const banReason = (phrase: string) => `Auto-ban: "${phrase.slice(0, 60)}" spam (GuildScribe)`;

// Several spam messages can land before the first ban does; only announce
// once per chatter in a short window.
const ANNOUNCE_DEDUPE_MS = 60_000;
const recentlyAnnounced = new Map<string, number>();

// The "I need permission" nudge is throttled so a spam wave can't turn the
// bot itself into the spammer.
const PERMISSION_HINT_COOLDOWN_MS = 30 * 60_000;
const lastPermissionHintAt = new Map<string, number>();

// Announcements. Every line is the same beat — "I just banned another one
// for you" — dressed up differently.
const BAN_LINES: Array<(name: string) => string> = [
  (n) => `🔨 I just banned another one for you — ${n} has been cast out of the guild hall.`,
  (n) => `⚔️ I just banned another one for you. ${n} tried to sell the tavern phantom patrons and met the city guard.`,
  (n) => `🛡️ Another one down — I just banned ${n} for you. The gates of the guild hall stay shut.`,
  (n) => `🐉 I just banned another one for you: ${n} was carried off by a very unimpressed dragon.`,
  (n) => `📜 By decree of the scribes, I just banned another one for you. ${n} is struck from the roll.`,
  (n) => `🧙 A wizard snapped their fingers and ${n} is gone — I just banned another one for you.`,
  (n) => `🕳️ I just banned another one for you. ${n} stepped on a trapdoor labeled "ai viewers."`,
  (n) => `🏰 The portcullis drops behind ${n}. I just banned another one for you.`,
  (n) => `🗡️ Rogue's work, quietly done: I just banned another one for you, and ${n} never saw it coming.`,
  (n) => `🔮 The oracle foresaw it — I just banned another one for you. Farewell, ${n}.`,
  (n) => `🎲 ${n} rolled a natural 1 on their sales pitch. I just banned another one for you.`,
  (n) => `🧌 A troll under the bridge collected ${n}'s toll in full. I just banned another one for you.`,
  (n) => `🦉 My familiar spotted a fake in the crowd. I just banned another one for you — goodbye, ${n}.`,
  (n) => `⛓️ Off to the dungeon with ${n}. I just banned another one for you.`,
  (n) => `🪄 Dispel Magic, and the illusion of ${n} vanishes. I just banned another one for you.`,
  (n) => `🍺 The innkeeper tossed ${n} out the door. I just banned another one for you.`,
  (n) => `🏹 One well-placed arrow and ${n} is out of the party. I just banned another one for you.`,
  (n) => `🧿 The wards flared and ${n} bounced right off them. I just banned another one for you.`,
  (n) => `🔥 ${n} wandered into a Fireball meant for ghosts. I just banned another one for you.`,
  (n) => `🐀 The rat catchers of the guild found ${n} in the cellar. I just banned another one for you.`,
  (n) => `🚪 Sending ${n} through the door marked "no return." I just banned another one for you.`,
  (n) => `📯 The town crier announces the banishment of ${n}. I just banned another one for you.`,
  (n) => `🧭 ${n} took a wrong turn at the crossroads and it led straight out. I just banned another one for you.`,
  (n) => `💀 ${n} failed the death save on their marketing plan. I just banned another one for you.`,
  (n) => `🪤 The bait worked and the trap snapped shut on ${n}. I just banned another one for you.`,
];

// ── Persistence (own table — db.ts is already near Val Town's file-size cap)

export async function ensureAutoBanTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS autoban_settings (
      broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    )`,
  );
  await ensureAutoBanWordTables();
  await ensureAutoBanHistoryTables();
}

export async function isAutoBanEnabled(broadcasterId: string) {
  const res = await sqlite.execute("SELECT enabled FROM autoban_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length > 0 && Number(res.rows[0].enabled) === 1;
}

export async function setAutoBanEnabled(broadcasterId: string, enabled: boolean) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO autoban_settings (broadcaster_id, enabled, updated_at) VALUES (?,?,?)",
    [broadcasterId, enabled ? 1 : 0, Date.now()],
  );
  enabledCache.delete(broadcasterId);
}

// The chat hook now reads the flag on every message (the list match needs it
// first), so it's cached briefly; toggling clears the entry.
const ENABLED_TTL_MS = 30_000;
const enabledCache = new Map<string, { enabled: boolean; at: number }>();
async function isAutoBanEnabledCached(broadcasterId: string) {
  const hit = enabledCache.get(broadcasterId);
  if (hit && Date.now() - hit.at < ENABLED_TTL_MS) return hit.enabled;
  const enabled = await isAutoBanEnabled(broadcasterId);
  enabledCache.set(broadcasterId, { enabled, at: Date.now() });
  return enabled;
}

/** Wipes the channel's auto-ban setting — called from !dndbot leave purge. */
export async function purgeAutoBanData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM autoban_settings WHERE broadcaster_id = ?", [broadcasterId]);
  enabledCache.delete(broadcasterId);
  await purgeAutoBanWordData(broadcasterId);
  await purgeAutoBanHistory(broadcasterId);
}

// ── Token / permission ──

type BanToken = { token: string } | { problem: "no_token" | "no_scope" };

/** The broadcaster's user token, refreshed if needed, plus a check that it
 * was actually granted the ban scope. */
export async function getBanToken(broadcasterId: string): Promise<BanToken> {
  const token = await getValidAdToken(broadcasterId);
  if (!token) return { problem: "no_token" };
  // Read the row *after* getValidAdToken so a just-refreshed scope is seen.
  const row = await getBroadcasterAdToken(broadcasterId);
  const scopes = String(row?.scope ?? "").split(/\s+/).filter(Boolean);
  if (!scopes.includes(BAN_SCOPE)) return { problem: "no_scope" };
  return { token };
}

/** Whether the channel's stored token was granted the ban scope. Read-only
 * (no refresh, no Twitch call) so the dashboard can show it cheaply. */
export async function hasBanPermission(broadcasterId: string): Promise<boolean> {
  const row = await getBroadcasterAdToken(broadcasterId);
  return String(row?.scope ?? "").split(/\s+/).includes(BAN_SCOPE);
}

async function sendPermissionHint(broadcasterId: string, baseUrl: string) {
  const now = Date.now();
  if (now - (lastPermissionHintAt.get(broadcasterId) ?? 0) < PERMISSION_HINT_COOLDOWN_MS) return;
  lastPermissionHintAt.set(broadcasterId, now);
  await sendChatMessage(
    `⚠️ Auto-ban spotted spam but can't ban yet — broadcaster, please reconnect at ${baseUrl}/connect to grant ban permission.`,
    broadcasterId,
  );
}

// ── Chat hook ──

/** Bans a non-mod chatter whose message matches the channel's auto-ban list.
 * The on/off flag and the list are cached briefly (autoban_words.ts), so normal
 * chat costs no network work beyond that. Messages that don't match but read
 * like promo spam feed the learner. Returns true if the message was consumed (a ban was issued, or the chatter
 * was already unbannable) so the caller can skip further processing of a
 * spammer's message; false means carry on as normal. Works whether or not
 * the channel is live; the announcement is only posted while live, matching
 * the bot's "quiet while offline" behavior. */
export async function maybeAutoBan(
  chatMessage: string,
  display: string,
  chatterLogin: string,
  chatterId: string,
  broadcasterId: string,
  isModerator: boolean,
  isLive: boolean,
  baseUrl: string,
): Promise<boolean> {
  if (isModerator || !chatterId || chatterId === broadcasterId) return false;
  if (!(await isAutoBanEnabledCached(broadcasterId))) return false;
  if (await isUserIgnored(broadcasterId, chatterLogin)) return false;
  const match = await findMatch(broadcasterId, chatMessage);
  // No phrase matched: check the ban history (autoban_history.ts) — a repeat
  // of a banned message, or a bot-farm name with a promo message. Learning
  // mode decides: auto bans, suggest queues it for review, off skips it.
  let history: Awaited<ReturnType<typeof findHistoryMatch>> = null;
  if (!match) {
    const mode = await currentLearnMode(broadcasterId);
    history = mode === "off" ? null : await findHistoryMatch(broadcasterId, chatMessage, chatterLogin);
    if (!history) {
      await learnFromMessage(broadcasterId, chatMessage, chatterId);
      return false;
    }
    if (mode === "suggest") {
      await suggestFromHistory(broadcasterId, chatMessage, chatterId);
      return false;
    }
  }
  const reason = match ? banReason(match.phrase) : `Auto-ban: ${describeMatch(history!)} (GuildScribe)`;

  const auth = await getBanToken(broadcasterId);
  if ("problem" in auth) {
    await recordMonitorEvent("autoban_no_permission", `${broadcasterId}: ${auth.problem}`);
    if (isLive) await sendPermissionHint(broadcasterId, baseUrl);
    return false;
  }

  // The broadcaster is the moderator of record: the token belongs to them.
  const result = await banChatUser(auth.token, broadcasterId, broadcasterId, chatterId, reason);

  if (result.ok) {
    await Promise.all([
      recordMonitorEvent("autoban", `${broadcasterId}: banned ${chatterId} — ${match ? `"${match.phrase}"` : describeMatch(history!)}`),
      match ? recordHit(broadcasterId, match.id) : Promise.resolve(),
      learnFromBannedMessage(broadcasterId, chatMessage, chatterId),
      // Every ban becomes a reference for the next ones.
      recordBan(broadcasterId, { userId: chatterId, login: chatterLogin, message: chatMessage, reason, source: match ? "autoban" : "history" }),
    ]);
    const now = Date.now();
    const last = recentlyAnnounced.get(chatterId) ?? 0;
    recentlyAnnounced.set(chatterId, now);
    for (const [id, at] of recentlyAnnounced) {
      if (now - at > ANNOUNCE_DEDUPE_MS) recentlyAnnounced.delete(id);
    }
    if (isLive && now - last > ANNOUNCE_DEDUPE_MS) {
      await sendChatMessage(pick(BAN_LINES)(display), broadcasterId);
    }
    return true;
  }

  // 400 = Twitch refused for this target (already banned, or a moderator /
  // the broadcaster). Nothing more to do, and no point announcing it.
  if (result.status === 400) {
    await recordMonitorEvent("autoban_skipped", `${broadcasterId}: ${chatterId}: ${result.message}`);
    return true;
  }

  // 401/403: token revoked or scope missing on Twitch's side. Anything else
  // (429, 5xx, network) is transient.
  await recordMonitorEvent("autoban_failed", `${broadcasterId}: ${chatterId}: ${result.status} ${result.message}`);
  if ((result.status === 401 || result.status === 403) && isLive) {
    await sendPermissionHint(broadcasterId, baseUrl);
  }
  return false;
}

// ── Command ──

/** Handles !autoban on | off | status. `status` is open to everyone;
 * `on`/`off` are broadcaster/mod. Bans still run on the broadcaster's own
 * token, so only the broadcaster can grant the permission by reconnecting.
 * Returns true if the message matched. */
export async function handleAutoBanCommand(
  chatMessage: string,
  display: string,
  isModerator: boolean,
  broadcasterId: string,
  baseUrl: string,
): Promise<boolean> {
  const match = chatMessage.trim().match(/^!autoban\s+(on|off|status)$/i);
  if (!match) return false;
  const action = match[1].toLowerCase();

  if (action === "status") {
    const enabled = await isAutoBanEnabled(broadcasterId);
    await sendChatMessage(
      `@${display} Auto-ban is ${
        enabled ? "on — anyone who is not a mod using a phrase on the channel's auto-ban list is permanently banned" : "off in this channel"
      }. Mods can toggle with !autoban on or !autoban off, and edit the list from !dashboard.`,
      broadcasterId,
    );
    return true;
  }

  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can toggle auto-ban.`, broadcasterId);
    return true;
  }

  if (action === "off") {
    await setAutoBanEnabled(broadcasterId, false);
    await sendChatMessage(`@${display} Auto-ban is off. The gate guards stand down.`, broadcasterId);
    return true;
  }

  await setAutoBanEnabled(broadcasterId, true);
  const auth = await getBanToken(broadcasterId);
  if ("problem" in auth) {
    await sendChatMessage(
      `@${display} Auto-ban is on, but I don't have ban permission yet — the broadcaster needs to reconnect at ${baseUrl}/connect and approve the new permission.`,
      broadcasterId,
    );
  } else {
    await sendChatMessage(
      `@${display} Auto-ban is on. Anyone who is not a mod using a phrase on the auto-ban list (starts with "ai viewers"; edit it from !dashboard) gets a permanent ban.`,
      broadcasterId,
    );
  }
  return true;
}

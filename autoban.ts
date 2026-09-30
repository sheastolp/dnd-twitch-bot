// Auto-ban for "ai viewers" spam — the fake-viewer-service bots that drop
// "get ai viewers for your stream" style ads into chat. When a non-mod
// chatter's message contains the phrase, the bot permanently bans them and
// posts a short D&D-flavored "I just banned another one for you" line.
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

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { getValidAdToken } from "./ads.ts";
import { getBroadcasterAdToken } from "./ads_db.ts";
import { recordMonitorEvent } from "./db.ts";
import { banChatUser, sendChatMessage } from "./twitch.ts";
import { pick } from "./utils.ts";

export const BAN_SCOPE = "moderator:manage:banned_users";

// "ai viewers", any casing / spacing. Word-bounded so it doesn't match
// inside a longer word.
const AI_VIEWERS_RE = /\bai\s+viewers\b/i;

const BAN_REASON = 'Auto-ban: "ai viewers" spam (GuildScribe)';

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
}

/** Wipes the channel's auto-ban setting — called from !dndbot leave purge. */
export async function purgeAutoBanData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM autoban_settings WHERE broadcaster_id = ?", [broadcasterId]);
}

// ── Token / permission ──

type BanToken = { token: string } | { problem: "no_token" | "no_scope" };

/** The broadcaster's user token, refreshed if needed, plus a check that it
 * was actually granted the ban scope. */
async function getBanToken(broadcasterId: string): Promise<BanToken> {
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

/** Bans a non-mod chatter who says "ai viewers". Cheap for normal chat: the
 * phrase check runs first, so no DB or network work happens unless it hits.
 * Returns true if the message was consumed (a ban was issued, or the chatter
 * was already unbannable) so the caller can skip further processing of a
 * spammer's message; false means carry on as normal. Works whether or not
 * the channel is live; the announcement is only posted while live, matching
 * the bot's "quiet while offline" behavior. */
export async function maybeAutoBan(
  chatMessage: string,
  display: string,
  chatterId: string,
  broadcasterId: string,
  isModerator: boolean,
  isLive: boolean,
  baseUrl: string,
): Promise<boolean> {
  if (!AI_VIEWERS_RE.test(chatMessage)) return false;
  if (isModerator || !chatterId || chatterId === broadcasterId) return false;
  if (!(await isAutoBanEnabled(broadcasterId))) return false;

  const auth = await getBanToken(broadcasterId);
  if ("problem" in auth) {
    await recordMonitorEvent("autoban_no_permission", `${broadcasterId}: ${auth.problem}`);
    if (isLive) await sendPermissionHint(broadcasterId, baseUrl);
    return false;
  }

  // The broadcaster is the moderator of record: the token belongs to them.
  const result = await banChatUser(auth.token, broadcasterId, broadcasterId, chatterId, BAN_REASON);

  if (result.ok) {
    await recordMonitorEvent("autoban", `${broadcasterId}: banned ${chatterId}`);
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
        enabled ? 'on — anyone who is not a mod saying "ai viewers" is permanently banned' : "off in this channel"
      }. Mods can toggle with !autoban on or !autoban off.`,
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
      `@${display} Auto-ban is on. Anyone who is not a mod saying "ai viewers" gets a permanent ban.`,
      broadcasterId,
    );
  }
  return true;
}

// Twitch API helpers (tokens, chat, EventSub)

import { limitNameMentions, lookupNicknames, lookupViewerNames, mentionNames, shortenNames } from "./mentions.ts";
import { MAX_LOOKUP_MESSAGE_LENGTH } from "./data.ts";
import { splitChatMessage } from "./utils.ts";
import { getReplyInitiator, LONG_REPLY_PARTS, replySummary, sendWhisperParts, WHISPER_MAX } from "./whisper.ts";
import { saveReplyPage } from "./replypages.ts";

export const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

const CHAT_MAX = Math.min(MAX_LOOKUP_MESSAGE_LENGTH, 480);
// Rules need more parts than other lookups; spells use sendSpellSections separately.
const MAX_PARTS = 5;
const PART_DELAY_MS = 450;
// Twitch chat-send limits apply per channel, not bot-account-wide. With the
// bot modded in its channels, the applicable limit is 100 messages/30s
// (~300ms/message); default sits a little above that floor for safety.
// Each channel gets its own queue slot so a busy channel's duels/lookups
// never throttle chat sends in a different channel.
const GLOBAL_CHAT_MIN_INTERVAL_MS = Math.max(50, Number(Deno.env.get("CHAT_GLOBAL_MIN_INTERVAL_MS") ?? "320"));
const nextChatSendAtByChannel = new Map<string, number>();

async function waitForChatSlot(broadcasterId: string) {
  const now = Date.now();
  const nextAt = nextChatSendAtByChannel.get(broadcasterId) ?? 0;
  const wait = Math.max(0, nextAt - now);
  nextChatSendAtByChannel.set(broadcasterId, Math.max(now, nextAt) + GLOBAL_CHAT_MIN_INTERVAL_MS);
  if (wait) await sleep(wait);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cap + truncate parts so multi-message lookups always finish. */
function prepareParts(text: string, maxLen = CHAT_MAX, maxParts = MAX_PARTS): string[] {
  let parts = splitChatMessage(text, maxLen).map((p) => p.slice(0, maxLen));
  if (parts.length > maxParts) {
    parts = parts.slice(0, maxParts);
    const last = parts[parts.length - 1];
    parts[parts.length - 1] = last.slice(0, Math.max(0, maxLen - 12)).trimEnd() + " …(cut)";
  }
  return parts.filter((p) => p.length > 0);
}

/** Keep URL on the first chat part so it is never dropped. */
function preferLinkInFirstPart(parts: string[]): string[] {
  if (parts.length <= 1) return parts;
  const linkMatch = parts.join(" ").match(/https?:\/\/[^\s|]+/);
  if (!linkMatch) return parts;
  const link = linkMatch[0];
  if (parts[0].includes(link)) return parts;
  const prefix = `🔗 ${link} | `;
  let first = prefix + parts[0].replace(/🔗\s*https?:\/\/[^\s|]+\s*\|\s*/g, "");
  if (first.length > CHAT_MAX) first = first.slice(0, CHAT_MAX - 1) + "…";
  const rest = parts
    .slice(1)
    .map((p) => p.replace(link, "").replace(/\s*\|\s*$/g, "").trim())
    .filter(Boolean);
  return [first, ...rest];
}

export async function sendChatMessage(text: string, broadcasterId: string) {
  const message = text.slice(0, 500);
  if (!message.trim()) return true;
  try {
    await waitForChatSlot(broadcasterId);
    const send = async (token: string) =>
      fetch("https://api.twitch.tv/helix/chat/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Client-Id": env("TWITCH_CLIENT_ID"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          broadcaster_id: broadcasterId,
          sender_id: env("TWITCH_BOT_ID"),
          message,
        }),
      });

    let res = await send(await getAppToken());
    if (res.status === 401) {
      // Cached token was rejected (expired/revoked) — drop it and get a fresh one, once.
      invalidateAppToken();
      await waitForChatSlot(broadcasterId);
      res = await send(await getAppToken());
    }
    if (!res.ok && res.status !== 429) {
      console.error(`Twitch chat send failed: ${res.status}`);
    }
    // Brief backoff on rate limit so following parts can still send
    if (res.status === 429) {
      await sleep(1100);
      return false;
    }
    return res.ok;
  } catch (err) {
    console.error("sendChatMessage failed", err);
    return false;
  }
}

export async function sendChatMessages(
  text: string,
  broadcasterId: string,
  // summary: the one chat message used in place of a long reply (see
  // summarizeLongReply) — fights pass fightSummary(...). detail: the full
  // output for the reply's /r/<id> page when it differs from `text` (fights
  // pass their uncut battle log).
  opts?: { maxParts?: number; names?: string[]; summary?: string; detail?: string },
) {
  const original = text;
  const maxParts = opts?.maxParts ?? MAX_PARTS;
  // Battle logs shorten bare names; "@name" tags are capped at two. See mentions.ts.
  if (opts?.names?.length) {
    // Battle logs: bare names -> one whole word of the display name ("Stoned").
    let displays = new Map<string, string>();
    try {
      displays = await lookupViewerNames(broadcasterId, opts.names);
    } catch (_) { /* table not ready: fall back to what the text itself shows */ }
    let nicks = new Map<string, string>();
    try {
      nicks = await lookupNicknames(broadcasterId, opts.names);
    } catch (_) { /* table not ready: no !nick overrides */ }
    const lead = text.match(/^(?:[^\w@]*)@([A-Za-z0-9_]{1,25})\b/)?.[1];
    if (lead) displays.set(lead.toLowerCase(), lead);
    text = shortenNames(text, opts.names, displays, nicks);
  }
  text = limitNameMentions(text, mentionNames(text, opts?.names));
  let parts = prepareParts(text, CHAT_MAX, maxParts);
  parts = preferLinkInFirstPart(parts);
  if (await summarizeLongReply(text, opts?.detail ?? original, parts.length, broadcasterId, opts?.summary)) return;
  for (let i = 0; i < parts.length; i++) {
    const ok = await sendChatMessage(parts[i], broadcasterId);
    if (!ok && i < parts.length - 1) {
      await sleep(700);
      await sendChatMessage(parts[i], broadcasterId);
    }
    if (i < parts.length - 1) await sleep(PART_DELAY_MS);
  }
}

/** Anything that would take LONG_REPLY_PARTS+ chat messages becomes one chat
 * message: a short summary ending in a link to a page with the full output
 * (replypages.ts). A reply to someone's !command is also whispered to them
 * in full when the bot has whisper access (whisper.ts). Returns false — send
 * in chat as usual — only when the detail page can't be saved. */
async function summarizeLongReply(
  text: string,
  detail: string,
  chatParts: number,
  broadcasterId: string,
  summary?: string,
): Promise<boolean> {
  if (chatParts < LONG_REPLY_PARTS) return false;
  const found = getReplyInitiator();
  const initiator = found?.broadcasterId === broadcasterId ? found : undefined;
  let line = summary
    ? (initiator ? `@${initiator.display} ${summary}` : summary)
    : replySummary(initiator?.display, text);
  // Keep a link the reply exists to deliver (!guide, !dashboard, map pages…)
  // even when the summary is cut before it.
  const replyLink = text.match(/https?:\/\/[^\s|]+/)?.[0];
  if (replyLink && !line.includes(replyLink)) line += ` 🔗 ${replyLink}`;
  let link: string;
  try {
    // One page per viewer: whoever ran the command, else whoever the reply
    // is addressed to (autohunt reports…), else the channel's shared page.
    const owner = initiator?.login || text.match(/^\W*@([A-Za-z0-9_]{1,25})\b/)?.[1];
    link = await saveReplyPage(broadcasterId, owner, line, detail);
  } catch (err) {
    console.error("saveReplyPage failed", err);
    return false;
  }
  const tail = ` 📜 Full ${summary ? "battle log" : "reply"}: ${link}`;
  const head = line.length + tail.length > CHAT_MAX ? line.slice(0, CHAT_MAX - tail.length - 1).trimEnd() + "…" : line;
  await sendChatMessage(head + tail, broadcasterId);
  // Bonus copy by whisper; silently skipped until /connect-bot is done.
  if (initiator) await sendWhisperParts(initiator.userId, splitChatMessage(text, WHISPER_MAX).filter((p) => p.trim()));
  return true;
}

export async function sendSpellSections(sections: string[], display: string, broadcasterId: string) {
  // Flatten sections into a limited stream of chat parts (avoid dropping mid-spell)
  const combined: string[] = [];
  for (const section of sections) {
    combined.push(...prepareParts(`@${display} ${section}`, CHAT_MAX, 3));
  }
  const full = sections.join(" | ");
  if (await summarizeLongReply(full, full, combined.length, broadcasterId)) return;
  const parts = combined.slice(0, MAX_PARTS);
  if (combined.length > MAX_PARTS && parts.length) {
    parts[parts.length - 1] =
      parts[parts.length - 1].slice(0, Math.max(0, CHAT_MAX - 12)).trimEnd() + " …(cut)";
  }
  for (let i = 0; i < parts.length; i++) {
    await sendChatMessage(parts[i], broadcasterId);
    if (i < parts.length - 1) await sleep(PART_DELAY_MS);
  }
}

export type BanResult = { ok: true } | { ok: false; status: number; message: string };

/** Permanently bans a user (no duration = permanent) via Helix Ban User.
 * Needs a *user* access token — not the app token used for chat sends —
 * belonging to `moderatorId`, a moderator (or the broadcaster) of the
 * channel, with the moderator:manage:banned_users scope. See autoban.ts. */
export async function banChatUser(
  userAccessToken: string,
  broadcasterId: string,
  moderatorId: string,
  targetUserId: string,
  reason: string,
): Promise<BanResult> {
  try {
    const params = new URLSearchParams({ broadcaster_id: broadcasterId, moderator_id: moderatorId });
    const res = await fetch(`https://api.twitch.tv/helix/moderation/bans?${params.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
        "Client-Id": env("TWITCH_CLIENT_ID"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: { user_id: targetUserId, reason: reason.slice(0, 500) } }),
    });
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, message: (await res.text()).slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, message: String(err).slice(0, 200) };
  }
}

// App access tokens (client_credentials) are valid for ~hours, not one request —
// cache and reuse instead of re-fetching one from Twitch on every chat send.
let cachedAppToken: { token: string; expiresAt: number } | null = null;

export function invalidateAppToken() {
  cachedAppToken = null;
}

export async function getAppToken() {
  if (cachedAppToken && Date.now() < cachedAppToken.expiresAt) {
    return cachedAppToken.token;
  }
  const body = new URLSearchParams({
    client_id: env("TWITCH_CLIENT_ID"),
    client_secret: env("TWITCH_CLIENT_SECRET"),
    grant_type: "client_credentials",
  });
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`App token failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const expiresInMs = Number(data.expires_in ?? 0) * 1000;
  // Refresh a minute early so we never send a request with a token that
  // expires mid-flight.
  cachedAppToken = {
    token: data.access_token as string,
    expiresAt: Date.now() + Math.max(0, expiresInMs - 60_000),
  };
  return cachedAppToken.token;
}

// Live channel info for custom command/trigger placeholders ({game},
// {title}, {status}, {uptime}). Uses the existing cached app token — no new
// OAuth scope needed since these are public Helix endpoints.
export async function getChannelInfo(broadcasterId: string): Promise<{ gameName: string; title: string } | null> {
  try {
    const token = await getAppToken();
    const res = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${broadcasterId}`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": env("TWITCH_CLIENT_ID") },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const row = data?.data?.[0];
    if (!row) return null;
    return { gameName: String(row.game_name ?? ""), title: String(row.title ?? "") };
  } catch (err) {
    console.error("getChannelInfo failed", err);
    return null;
  }
}

/** One-off "is this channel live right now" check against Twitch's Get
 * Streams endpoint. NOT used in the chat hot path (that would mean a Twitch
 * API round-trip on every message — see the stream.online/offline EventSub
 * subscriptions below for the fast path). Only called once, at connect time,
 * to seed broadcasters.is_live before the first future stream.online/offline
 * event arrives to keep it updated. */
export async function fetchIsChannelLiveNow(broadcasterId: string): Promise<boolean> {
  try {
    const token = await getAppToken();
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_id=${broadcasterId}`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": env("TWITCH_CLIENT_ID") },
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data?.data?.[0]);
  } catch (err) {
    console.error("fetchIsChannelLiveNow failed", err);
    return false;
  }
}

/** Returns a formatted uptime string ("1h 12m"/"12m"), or null if offline. */
export async function getStreamUptime(broadcasterId: string): Promise<string | null> {
  try {
    const token = await getAppToken();
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_id=${broadcasterId}`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": env("TWITCH_CLIENT_ID") },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const startedAt = data?.data?.[0]?.started_at;
    if (!startedAt) return null; // offline
    const totalMinutes = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  } catch (err) {
    console.error("getStreamUptime failed", err);
    return null;
  }
}

export async function exchangeCode(code: string, redirectUri: string) {
  const body = new URLSearchParams({
    client_id: env("TWITCH_CLIENT_ID"),
    client_secret: env("TWITCH_CLIENT_SECRET"),
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`OAuth exchange failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function refreshUserToken(refreshToken: string) {
  const body = new URLSearchParams({
    client_id: env("TWITCH_CLIENT_ID"),
    client_secret: env("TWITCH_CLIENT_SECRET"),
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export interface AdSchedule {
  snoozeCount: number;
  snoozeRefreshAt: string;
  nextAdAt: string;
  lastAdAt: string;
  durationSeconds: number;
  prerollFreeTime: number;
}

/** Twitch's real ad schedule for a channel (Get Ad Schedule) — requires the
 * broadcaster's own user access token with the channel:read:ads scope
 * (requested during /connect, stored in broadcaster_ad_tokens). Returns
 * null if Twitch has nothing to report (e.g. stream offline / not yet
 * monetized) or the token was rejected (expired/revoked) — callers should
 * treat a rejected token as "needs reconnect", not a hard failure. */
export async function fetchAdSchedule(userAccessToken: string, broadcasterId: string): Promise<AdSchedule | null> {
  const res = await fetch(
    `https://api.twitch.tv/helix/channels/ads?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
    {
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
        "Client-Id": env("TWITCH_CLIENT_ID"),
      },
    },
  );
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`Ad schedule fetch failed: ${res.status} ${await res.text()}`);
  const row = (await res.json()).data?.[0];
  if (!row) return null;
  return {
    snoozeCount: Number(row.snooze_count ?? 0),
    snoozeRefreshAt: String(row.snooze_refresh_at ?? ""),
    nextAdAt: String(row.next_ad_at ?? ""),
    lastAdAt: String(row.last_ad_at ?? ""),
    durationSeconds: Number(row.duration ?? 0),
    prerollFreeTime: Number(row.preroll_free_time ?? 0),
  };
}

async function createEventSubSubscription(
  type: string,
  version: string,
  condition: Record<string, string>,
  callbackUrl: string,
) {
  const appToken = await getAppToken();
  const res = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Client-Id": env("TWITCH_CLIENT_ID"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type,
      version,
      condition,
      transport: {
        method: "webhook",
        callback: callbackUrl,
        secret: env("EVENTSUB_SECRET"),
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`EventSub subscription failed (${type}): ${res.status} ${text}`);
  return JSON.parse(text).data[0];
}

export async function createChatSubscription(broadcasterId: string, callbackUrl: string) {
  return createEventSubSubscription(
    "channel.chat.message",
    "1",
    { broadcaster_user_id: broadcasterId, user_id: env("TWITCH_BOT_ID") },
    callbackUrl,
  );
}

// New subscriptions (channel.subscribe) and renewals shared with a message
// in chat (channel.subscription.message) — used to power the D&D-themed
// !hug-style auto thank-you. Both require the broadcaster to have granted
// the "channel:read:subscriptions" scope during OAuth; older connections
// made before that scope was requested will need to reconnect for these to
// take effect. Best-effort: callers should not fail the whole connect flow
// if these throw (e.g. scope not yet granted).
export async function createSubEventSubscriptions(broadcasterId: string, callbackUrl: string) {
  const [newSub, resub, gift] = await Promise.all([
    createEventSubSubscription("channel.subscribe", "1", { broadcaster_user_id: broadcasterId }, callbackUrl),
    createEventSubSubscription("channel.subscription.message", "1", { broadcaster_user_id: broadcasterId }, callbackUrl),
    createEventSubSubscription("channel.subscription.gift", "1", { broadcaster_user_id: broadcasterId }, callbackUrl),
  ]);
  return { newSub, resub, gift };
}

// Incoming raids — powers the automatic D&D-themed raid thank-you. Unlike
// the subscribe/resub/gift events above, channel.raid with a
// to_broadcaster_user_id condition needs no extra OAuth scope (it's public
// EventSub data), so this should reliably succeed for every connected
// channel. Still created as its own best-effort call in main.ts so a hiccup
// here never blocks the core chat connection.
// Channel-point reward redemptions — powers redemptions.ts (robbery shield /
// "can't use <feature>" rewards). Needs the broadcaster to have granted
// channel:read:redemptions, so channels connected before this existed must
// reconnect once. Best-effort at the call site, like the subscribe events.
export async function createRedemptionEventSubscription(broadcasterId: string, callbackUrl: string) {
  return createEventSubSubscription(
    "channel.channel_points_custom_reward_redemption.add",
    "1",
    { broadcaster_user_id: broadcasterId },
    callbackUrl,
  );
}

export async function createRaidEventSubscription(broadcasterId: string, callbackUrl: string) {
  return createEventSubSubscription(
    "channel.raid",
    "1",
    { to_broadcaster_user_id: broadcasterId },
    callbackUrl,
  );
}

// Stream going live/offline — powers the fast, no-API-call "quiet while
// offline" check (broadcasters.is_live, updated by these notifications; see
// main.ts). Like channel.raid, both need no extra OAuth scope beyond the
// broadcaster_user_id condition, so this should reliably succeed for every
// connected channel. Kept as its own best-effort call in main.ts so a hiccup
// here never blocks the core chat connection.
export async function createStreamStatusEventSubscriptions(broadcasterId: string, callbackUrl: string) {
  const [online, offline] = await Promise.all([
    createEventSubSubscription("stream.online", "1", { broadcaster_user_id: broadcasterId }, callbackUrl),
    createEventSubSubscription("stream.offline", "1", { broadcaster_user_id: broadcasterId }, callbackUrl),
  ]);
  return { online, offline };
}

export async function deleteEventSubSubscription(subscriptionId: string) {
  if (!subscriptionId) return true;
  const appToken = await getAppToken();
  const res = await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${encodeURIComponent(subscriptionId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${appToken}`, "Client-Id": env("TWITCH_CLIENT_ID") },
  });
  if (res.status === 404) return true;
  if (!res.ok) throw new Error(`EventSub deletion failed: ${res.status} ${await res.text()}`);
  return true;
}

/** Constant-time string compare — doesn't branch/short-circuit on content,
 * only on length (which isn't secret), so it doesn't leak how many leading
 * characters of the signature matched via response timing. Exported for
 * reuse by dashboard.ts's session cookie verification. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyEventSub(req: Request, rawBody: string) {
  const id = req.headers.get("Twitch-Eventsub-Message-Id") ?? "";
  const timestamp = req.headers.get("Twitch-Eventsub-Message-Timestamp") ?? "";
  const received = req.headers.get("Twitch-Eventsub-Message-Signature") ?? "";
  if (!id || !timestamp || !received) return false;
  const receivedAt = Date.parse(timestamp);
  if (!Number.isFinite(receivedAt) || Math.abs(Date.now() - receivedAt) > 10 * 60 * 1000) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env("EVENTSUB_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id + timestamp + rawBody)),
  );
  const hex = [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = `sha256=${hex}`;
  return timingSafeEqual(expected, received);
}

// ── Dashboard login (viewer-side OAuth, separate from the broadcaster
// connect flow above) — used by dashboard.ts to verify that whoever is
// sitting at the web dashboard is actually a moderator/broadcaster of the
// channel, not just someone who found the link. ──

/** The logged-in viewer's own Twitch identity, from their own access token
 * (no user_id param needed — Helix defaults to the token's owner). */
export async function getViewerIdentity(accessToken: string): Promise<{ id: string; login: string; display_name: string } | null> {
  const res = await fetch("https://api.twitch.tv/helix/users", {
    headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": env("TWITCH_CLIENT_ID") },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const user = data.data?.[0];
  if (!user) return null;
  return { id: String(user.id), login: String(user.login), display_name: String(user.display_name ?? user.login) };
}

// Get Moderated Channels only returns channels the viewer moderates for
// *someone else* — the broadcaster of their own channel is never in this
// list, so callers must check viewerId === broadcasterId separately.
// Requires the viewer's own token with scope user:read:moderated_channels.
const MAX_MODERATED_CHANNELS_PAGES = 10;

export async function isUserModeratorOfChannel(accessToken: string, viewerId: string, broadcasterId: string): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MODERATED_CHANNELS_PAGES; page++) {
    const params = new URLSearchParams({ user_id: viewerId, first: "100" });
    if (cursor) params.set("after", cursor);
    const res = await fetch(`https://api.twitch.tv/helix/moderation/channels?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}`, "Client-Id": env("TWITCH_CLIENT_ID") },
    });
    if (!res.ok) return false;
    const data = await res.json();
    const rows: any[] = data.data ?? [];
    if (rows.some((r) => String(r.broadcaster_id) === broadcasterId)) return true;
    cursor = data.pagination?.cursor;
    if (!cursor) break;
  }
  return false;
}

// Twitch API helpers (tokens, chat, EventSub)

import { MAX_LOOKUP_MESSAGE_LENGTH } from "./data.ts";
import { splitChatMessage } from "./utils.ts";

export const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

const CHAT_MAX = Math.min(MAX_LOOKUP_MESSAGE_LENGTH, 480);
// Rules need more parts than other lookups; spells use sendSpellSections separately.
const MAX_PARTS = 5;
const PART_DELAY_MS = 450;
// Twitch chat-send limits are shared by the bot account. Keep a conservative
// global queue by default; operators can lower this after Twitch grants the
// appropriate bot rate limit/verification.
const GLOBAL_CHAT_MIN_INTERVAL_MS = Math.max(50, Number(Deno.env.get("CHAT_GLOBAL_MIN_INTERVAL_MS") ?? "1600"));
let nextChatSendAt = 0;

async function waitForGlobalChatSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextChatSendAt - now);
  nextChatSendAt = Math.max(now, nextChatSendAt) + GLOBAL_CHAT_MIN_INTERVAL_MS;
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
    await waitForGlobalChatSlot();
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
      await waitForGlobalChatSlot();
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
  opts?: { maxParts?: number },
) {
  const maxParts = opts?.maxParts ?? MAX_PARTS;
  let parts = prepareParts(text, CHAT_MAX, maxParts);
  parts = preferLinkInFirstPart(parts);
  for (let i = 0; i < parts.length; i++) {
    const ok = await sendChatMessage(parts[i], broadcasterId);
    if (!ok && i < parts.length - 1) {
      await sleep(700);
      await sendChatMessage(parts[i], broadcasterId);
    }
    if (i < parts.length - 1) await sleep(PART_DELAY_MS);
  }
}

export async function sendSpellSections(sections: string[], display: string, broadcasterId: string) {
  // Flatten sections into a limited stream of chat parts (avoid dropping mid-spell)
  const combined: string[] = [];
  for (const section of sections) {
    combined.push(...prepareParts(`@${display} ${section}`, CHAT_MAX, 3));
  }
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

// Used to keep a /dashboard login session alive past its ~4h access token
// without asking the viewer to sign in again — refresh_token grant per
// Twitch's OAuth docs. Twitch rotates the refresh token on every use, so
// callers must persist the new one, not just the new access token.
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

/** Identifies the viewer behind a user access token — used right after the
 * /dashboard OAuth exchange to learn who just logged in. Works with any
 * valid user token; no extra scope required. */
export async function getSelfUser(userToken: string) {
  const res = await fetch("https://api.twitch.tv/helix/users", {
    headers: {
      Authorization: `Bearer ${userToken}`,
      "Client-Id": env("TWITCH_CLIENT_ID"),
    },
  });
  if (!res.ok) throw new Error(`Could not identify user: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data[0];
}

/** Every channel a Twitch user currently moderates (requires the
 * user:read:moderated_channels scope on their token) — does NOT include a
 * channel they broadcast themselves; callers should check that separately.
 * Paginated, capped at 500 channels as a sane ceiling for a single viewer. */
export async function getModeratedChannelIds(userToken: string, userId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ user_id: userId, first: "100" });
    if (cursor) params.set("after", cursor);
    const res = await fetch(`https://api.twitch.tv/helix/moderation/channels?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Client-Id": env("TWITCH_CLIENT_ID"),
      },
    });
    if (!res.ok) throw new Error(`Get Moderated Channels failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    for (const row of data.data ?? []) ids.push(String(row.broadcaster_id));
    cursor = data.pagination?.cursor || undefined;
  } while (cursor && ids.length < 500);
  return ids;
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
export async function createRaidEventSubscription(broadcasterId: string, callbackUrl: string) {
  return createEventSubSubscription(
    "channel.raid",
    "1",
    { to_broadcaster_user_id: broadcasterId },
    callbackUrl,
  );
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
 * characters of the signature matched via response timing. */
function timingSafeEqual(a: string, b: string): boolean {
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

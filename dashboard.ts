// !dashboard — gives a mod/broadcaster the link to this channel's web
// dashboard (GET /dashboard, rendered by renderDashboardPage in pages.ts,
// routed in main.ts), where they can manage custom commands, chat triggers,
// and timed messages with plain HTML forms instead of chat syntax.
//
// Two layers of access control, not just one:
//   1. dashboard_key (see db.ts) — a per-channel capability token embedded
//      in the link, only ever handed out via this mod-gated chat command.
//   2. A live Twitch login (GET /dashboard/login → /dashboard/callback)
//      that checks — at the moment the page is opened — whether the logged
//      -in Twitch account is actually a moderator/broadcaster of *this*
//      channel, via Get Moderated Channels (scope user:read:moderated_channels).
//      A signed, channel-scoped, short-lived session cookie remembers that
//      check so it isn't repeated on every click.
// The key alone stops a random stranger from finding the page; the login
// on top of it means even a screenshotted/leaked link is useless to anyone
// who isn't currently a mod of that channel on Twitch.
//
//   !dashboard         (mod) get this channel's dashboard link
//   !dashboard reset   (mod) invalidate the old link and issue a new one

import { sendChatMessage, exchangeCode, getViewerIdentity, isUserModeratorOfChannel, timingSafeEqual, env } from "./twitch.ts";
import {
  getOrCreateDashboardKey,
  regenerateDashboardKey,
  verifyDashboardKey,
  getBroadcaster,
  listCustomCommandsFull,
  listCustomTriggers,
  listTimedMessages,
  addCustomCommand,
  editCustomCommand,
  deleteCustomCommand,
  setCustomCommandCooldown,
  addCustomTrigger,
  editCustomTrigger,
  deleteCustomTrigger,
  setCustomTriggerCooldown,
  addTimedMessage,
  editTimedMessage,
  setTimedMessageInterval,
  setTimedMessageEnabled,
  deleteTimedMessage,
  saveDashboardOAuthState,
  consumeDashboardOAuthState,
  isChannelEnabled,
  setChannelEnabled,
  isMerchantEnabled,
  setMerchantEnabled,
  getCommandGroupToggles,
  setCommandGroupEnabled,
} from "./db.ts";
import { isChronicleEnabled, setChronicleEnabled, isNpcEnabled, setNpcEnabled, isNpcChatterEnabled, setNpcChatterEnabled } from "./social_db.ts";
import { randomMerchantIntervalMs } from "./merchant.ts";
import { COMMAND_GROUPS } from "./utils.ts";
import {
  sanitizeCommandName,
  sanitizeTriggerKeyword,
  RESERVED_NAMES,
  MAX_CUSTOM_RESPONSE_LEN,
  MAX_COOLDOWN_SECONDS,
  parseCooldownSeconds,
} from "./customcommands.ts";
import { parseIntervalMinutes, sanitizeTimedMessageText, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES } from "./timedmessages.ts";
import { renderDashboardPage, renderDashboardLoginGate, type DashboardData } from "./pages.ts";

export async function handleDashboardCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
  baseUrl: string,
): Promise<boolean> {
  const match = chatMessage.trim().match(/^!dashboard(?:\s+(reset))?$/i);
  if (!match) return false;

  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can access the dashboard.`, broadcasterId);
    return true;
  }

  const reset = !!match[1];
  const key = reset ? await regenerateDashboardKey(broadcasterId) : await getOrCreateDashboardKey(broadcasterId);
  const link = `${baseUrl}/dashboard?channel=${broadcasterId}&key=${key}`;
  await sendChatMessage(
    `@${display} ${reset ? "New dashboard link (the old one no longer works): " : "Dashboard: "}${link} — you'll be asked to log in with Twitch to confirm you're a mod. Keep this link private regardless.`,
    broadcasterId,
  );
  return true;
}

// ── Session cookie (proves "logged in and verified as a mod of this
// channel", separate from and in addition to the dashboard_key) ──

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function sessionCookieName(channelId: string): string {
  return `gs_dash_${channelId}`;
}

function base64urlEncode(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return atob(padded);
}

// Derived (not the raw secret) so this cookie's signing key is distinct
// from whatever else EVENTSUB_SECRET is used for, in case they're ever
// reused across a future feature.
async function getSessionHmacKey(): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`${env("EVENTSUB_SECRET")}:dashboard-session-v1`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function hmacHex(payload: string): Promise<string> {
  const key = await getSessionHmacKey();
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return [...signature].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signDashboardSession(channelId: string, viewerId: string, expiresAt: number): Promise<string> {
  const payload = `${channelId}:${viewerId}:${expiresAt}`;
  const sig = await hmacHex(payload);
  return `${base64urlEncode(payload)}.${sig}`;
}

/** Returns the verified viewer id if the cookie is a validly-signed,
 * unexpired session for this exact channel — null otherwise. */
async function verifyDashboardSession(token: string, channelId: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload: string;
  try {
    payload = base64urlDecode(payloadB64);
  } catch {
    return null;
  }
  const expectedSig = await hmacHex(payload);
  if (!timingSafeEqual(sig, expectedSig)) return null;
  const parts = payload.split(":");
  if (parts.length !== 3) return null;
  const [chId, viewerId, expiresAtStr] = parts;
  if (chId !== channelId) return null;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return viewerId;
}

function getCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sessionSetCookieHeader(channelId: string, token: string): string {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  return `${sessionCookieName(channelId)}=${token}; Path=/dashboard; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

// ── GET /dashboard ──

function redirectTo(location: string, extraHeaders?: Record<string, string>): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store", ...extraHeaders } });
}

function dashboardUrl(baseUrl: string, channelId: string, key: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ channel: channelId, key, ...extra });
  return `${baseUrl}/dashboard?${params.toString()}`;
}

function loginUrl(baseUrl: string, channelId: string, key: string): string {
  const params = new URLSearchParams({ channel: channelId, key });
  return `${baseUrl}/dashboard/login?${params.toString()}`;
}

/**
 * Renders the dashboard for GET /dashboard?channel=&key=. Checks the
 * dashboard_key first (400/401 on failure, same as before), then checks for
 * a valid mod session cookie — if that's missing or expired, shows a
 * "log in with Twitch" gate instead of the management UI.
 */
export async function renderDashboard(
  channelId: string | null,
  key: string | null,
  cookieHeader: string | null,
  baseUrl: string,
  opts?: { notice?: string; error?: string },
): Promise<Response> {
  if (!channelId || !/^\d+$/.test(channelId) || !key) {
    return new Response("Missing channel or key. Get your link in chat with !dashboard.", { status: 400 });
  }
  if (!(await verifyDashboardKey(channelId, key))) {
    return new Response("Unauthorized. Get a valid link in chat with !dashboard.", { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const cookie = getCookie(cookieHeader, sessionCookieName(channelId));
  const viewerId = cookie ? await verifyDashboardSession(cookie, channelId) : null;
  const broadcaster = await getBroadcaster(channelId);
  const broadcasterName = String(broadcaster?.display_name || broadcaster?.login || channelId);

  if (!viewerId) {
    return new Response(
      renderDashboardLoginGate({ broadcasterName, loginUrl: loginUrl(baseUrl, channelId, key), error: opts?.error }),
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
    );
  }

  const [commands, triggers, timedMessages, botEnabled, marketEnabled, chronicleEnabled, npcEnabled, npcChatterEnabled, groupToggles] = await Promise.all([
    listCustomCommandsFull(channelId),
    listCustomTriggers(channelId),
    listTimedMessages(channelId),
    isChannelEnabled(channelId),
    isMerchantEnabled(channelId),
    isChronicleEnabled(channelId),
    isNpcEnabled(channelId),
    isNpcChatterEnabled(channelId),
    getCommandGroupToggles(channelId),
  ]);
  const data: DashboardData = {
    broadcasterId: channelId,
    broadcasterName,
    channelKey: key,
    commands,
    triggers,
    timedMessages,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    maxIntervalMinutes: MAX_INTERVAL_MINUTES,
    maxCooldownSeconds: MAX_COOLDOWN_SECONDS,
    notice: opts?.notice,
    error: opts?.error,
    botEnabled,
    marketEnabled,
    chronicleEnabled,
    npcEnabled,
    npcChatterEnabled,
    groupToggles,
  };
  return new Response(renderDashboardPage(data), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ── GET /dashboard/login, GET /dashboard/callback ──

export async function handleDashboardLogin(channelId: string | null, key: string | null, baseUrl: string): Promise<Response> {
  if (!channelId || !/^\d+$/.test(channelId) || !key) {
    return new Response("Missing channel or key. Get your link in chat with !dashboard.", { status: 400 });
  }
  if (!(await verifyDashboardKey(channelId, key))) {
    return new Response("Unauthorized. Get a valid link in chat with !dashboard.", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const state = crypto.randomUUID();
  await saveDashboardOAuthState(state, channelId, key, Date.now() + OAUTH_STATE_TTL_MS);
  const auth = new URL("https://id.twitch.tv/oauth2/authorize");
  auth.search = new URLSearchParams({
    client_id: env("TWITCH_CLIENT_ID"),
    redirect_uri: `${baseUrl}/dashboard/callback`,
    response_type: "code",
    scope: "user:read:moderated_channels",
    state,
  }).toString();
  return redirectTo(auth.toString());
}

export async function handleDashboardCallback(
  code: string | null,
  state: string | null,
  oauthError: string | null,
  baseUrl: string,
): Promise<Response> {
  if (!state) return new Response("Missing OAuth state.", { status: 400 });
  const stateRow = await consumeDashboardOAuthState(state);
  if (!stateRow) return new Response("Invalid or expired login attempt. Get a fresh link in chat with !dashboard.", { status: 400 });
  const channelId = String(stateRow.channel_id);
  const key = String(stateRow.dashboard_key);

  // The key may have been reset (e.g. !dashboard reset) while this login
  // was in flight — re-check rather than trusting the state row blindly.
  if (!(await verifyDashboardKey(channelId, key))) {
    return new Response("This dashboard link is no longer valid. Get a fresh one in chat with !dashboard.", { status: 401 });
  }

  if (oauthError) {
    return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Twitch login was cancelled." }));
  }
  if (!code) return new Response("Missing OAuth code.", { status: 400 });

  try {
    const token = await exchangeCode(code, `${baseUrl}/dashboard/callback`);
    const viewer = await getViewerIdentity(token.access_token);
    if (!viewer) {
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Couldn't verify your Twitch account — try logging in again." }));
    }
    const isBroadcaster = viewer.id === channelId;
    const isMod = isBroadcaster || (await isUserModeratorOfChannel(token.access_token, viewer.id, channelId));
    if (!isMod) {
      return redirectTo(
        dashboardUrl(baseUrl, channelId, key, { error: `${viewer.display_name} isn't a moderator of this channel on Twitch.` }),
      );
    }
    const sessionToken = await signDashboardSession(channelId, viewer.id, Date.now() + SESSION_TTL_MS);
    return redirectTo(dashboardUrl(baseUrl, channelId, key), { "Set-Cookie": sessionSetCookieHeader(channelId, sessionToken) });
  } catch (e) {
    console.error("dashboard oauth callback failed", e);
    return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Twitch login failed — try again." }));
  }
}

// ── POST /dashboard/commands, /dashboard/triggers, /dashboard/timedmessages ──
//
// Each takes the already-parsed form body, the request's own origin (for
// building redirects), and the raw Cookie header, verifies the embedded
// channel+key *and* the mod session cookie exactly like the GET route,
// applies one mutation, then redirects back to the dashboard with a flash
// notice/error — a plain POST/redirect/GET flow that needs no client-side JS.

async function authFromForm(form: FormData, baseUrl: string, cookieHeader: string | null): Promise<{ channelId: string; key: string } | Response> {
  const channelId = String(form.get("channel") ?? "");
  const key = String(form.get("key") ?? "");
  if (!channelId || !/^\d+$/.test(channelId) || !key) {
    return new Response("Missing channel or key.", { status: 400 });
  }
  if (!(await verifyDashboardKey(channelId, key))) {
    return new Response("Unauthorized.", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const cookie = getCookie(cookieHeader, sessionCookieName(channelId));
  const viewerId = cookie ? await verifyDashboardSession(cookie, channelId) : null;
  if (!viewerId) {
    // Session missing/expired — bounce back through Twitch login rather
    // than just failing, since the form's key is otherwise still valid.
    return redirectTo(loginUrl(baseUrl, channelId, key));
  }
  return { channelId, key };
}

export async function handleDashboardCommandsForm(form: FormData, baseUrl: string, cookieHeader: string | null): Promise<Response> {
  const auth = await authFromForm(form, baseUrl, cookieHeader);
  if (auth instanceof Response) return auth;
  const { channelId, key } = auth;
  const intent = String(form.get("intent") ?? "");
  const name = sanitizeCommandName(String(form.get("name") ?? ""));
  const cooldownSeconds = parseCooldownSeconds(String(form.get("cooldown_seconds") ?? ""));

  if (!name) {
    return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Command names must be 2-25 characters: letters, numbers, - or _." }));
  }

  if (intent === "add") {
    if (RESERVED_NAMES.has(name)) {
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: `!${name} is a built-in command and can't be added.` }));
    }
    const response = String(form.get("response") ?? "").slice(0, MAX_CUSTOM_RESPONSE_LEN).trim();
    if (!response) return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Give the command a response." }));
    const result = await addCustomCommand(channelId, name, response, "dashboard");
    if (!result.ok) {
      const msg = result.error === "exists"
        ? `!${name} already exists.`
        : `This channel's custom command limit (${result.max}) is reached.`;
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: msg }));
    }
    if (cooldownSeconds !== null) await setCustomCommandCooldown(channelId, name, cooldownSeconds * 1000);
    return redirectTo(dashboardUrl(baseUrl, channelId, key, { notice: `Added !${name}.` }));
  }

  if (intent === "save") {
    const response = String(form.get("response") ?? "").slice(0, MAX_CUSTOM_RESPONSE_LEN).trim();
    if (!response) return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Give the command a response." }));
    const updated = await editCustomCommand(channelId, name, response);
    if (!updated) return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: `!${name} doesn't exist.` }));
    if (cooldownSeconds !== null) await setCustomCommandCooldown(channelId, name, cooldownSeconds * 1000);
    return redirectTo(dashboardUrl(baseUrl, channelId, key, { notice: `Updated !${name}.` }));
  }

  if (intent === "delete") {
    const removed = await deleteCustomCommand(channelId, name);
    return redirectTo(
      dashboardUrl(baseUrl, channelId, key, removed ? { notice: `Removed !${name}.` } : { error: `!${name} doesn't exist.` }),
    );
  }

  return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Unknown action." }));
}

export async function handleDashboardTriggersForm(form: FormData, baseUrl: string, cookieHeader: string | null): Promise<Response> {
  const auth = await authFromForm(form, baseUrl, cookieHeader);
  if (auth instanceof Response) return auth;
  const { channelId, key } = auth;
  const intent = String(form.get("intent") ?? "");
  const keyword = sanitizeTriggerKeyword(String(form.get("keyword") ?? ""));
  const cooldownSeconds = parseCooldownSeconds(String(form.get("cooldown_seconds") ?? ""));

  if (!keyword) {
    return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Keywords must be 2-40 characters, up to 5 words." }));
  }

  if (intent === "add") {
    const response = String(form.get("response") ?? "").slice(0, MAX_CUSTOM_RESPONSE_LEN).trim();
    if (!response) return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Give the trigger a response." }));
    const result = await addCustomTrigger(channelId, keyword, response, "dashboard");
    if (!result.ok) {
      const msg = result.error === "exists"
        ? `A trigger for "${keyword}" already exists.`
        : `This channel's trigger limit (${result.max}) is reached.`;
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: msg }));
    }
    if (cooldownSeconds !== null) await setCustomTriggerCooldown(channelId, keyword, cooldownSeconds * 1000);
    return redirectTo(dashboardUrl(baseUrl, channelId, key, { notice: `Added trigger "${keyword}".` }));
  }

  if (intent === "save") {
    const response = String(form.get("response") ?? "").slice(0, MAX_CUSTOM_RESPONSE_LEN).trim();
    if (!response) return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Give the trigger a response." }));
    const updated = await editCustomTrigger(channelId, keyword, response);
    if (!updated) return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: `No trigger found for "${keyword}".` }));
    if (cooldownSeconds !== null) await setCustomTriggerCooldown(channelId, keyword, cooldownSeconds * 1000);
    return redirectTo(dashboardUrl(baseUrl, channelId, key, { notice: `Updated trigger "${keyword}".` }));
  }

  if (intent === "delete") {
    const removed = await deleteCustomTrigger(channelId, keyword);
    return redirectTo(
      dashboardUrl(baseUrl, channelId, key, removed ? { notice: `Removed trigger "${keyword}".` } : { error: `No trigger found for "${keyword}".` }),
    );
  }

  return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Unknown action." }));
}

export async function handleDashboardTimedMessagesForm(form: FormData, baseUrl: string, cookieHeader: string | null): Promise<Response> {
  const auth = await authFromForm(form, baseUrl, cookieHeader);
  if (auth instanceof Response) return auth;
  const { channelId, key } = auth;
  const intent = String(form.get("intent") ?? "");

  if (intent === "add") {
    const minutes = parseIntervalMinutes(String(form.get("interval_minutes") ?? ""));
    const message = sanitizeTimedMessageText(form.get("message"));
    if (minutes === null) {
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: `Interval must be ${MIN_INTERVAL_MINUTES}-${MAX_INTERVAL_MINUTES} minutes.` }));
    }
    if (!message) return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Give the timed message some text." }));
    const result = await addTimedMessage(channelId, message, minutes, "dashboard");
    if (!result.ok) {
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: `This channel's timed message limit (${result.max}) is reached.` }));
    }
    return redirectTo(dashboardUrl(baseUrl, channelId, key, { notice: `Added timed message #${result.id}.` }));
  }

  const id = Number.parseInt(String(form.get("id") ?? ""), 10);
  if (!Number.isFinite(id)) return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Missing timed message id." }));

  if (intent === "save") {
    const minutes = parseIntervalMinutes(String(form.get("interval_minutes") ?? ""));
    const message = sanitizeTimedMessageText(form.get("message"));
    const enabled = String(form.get("enabled") ?? "") === "on";
    if (minutes === null) {
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: `Interval must be ${MIN_INTERVAL_MINUTES}-${MAX_INTERVAL_MINUTES} minutes.` }));
    }
    if (!message) return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Give the timed message some text." }));
    const updated = await editTimedMessage(channelId, id, message);
    if (!updated) return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: `No timed message #${id} in this channel.` }));
    await setTimedMessageInterval(channelId, id, minutes);
    await setTimedMessageEnabled(channelId, id, enabled);
    return redirectTo(dashboardUrl(baseUrl, channelId, key, { notice: `Updated timed message #${id}.` }));
  }

  if (intent === "delete") {
    const removed = await deleteTimedMessage(channelId, id);
    return redirectTo(
      dashboardUrl(baseUrl, channelId, key, removed ? { notice: `Removed timed message #${id}.` } : { error: `No timed message #${id} in this channel.` }),
    );
  }

  return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Unknown action." }));
}

export async function handleDashboardFeaturesForm(form: FormData, baseUrl: string, cookieHeader: string | null): Promise<Response> {
  const auth = await authFromForm(form, baseUrl, cookieHeader);
  if (auth instanceof Response) return auth;
  const { channelId, key } = auth;
  const intent = String(form.get("intent") ?? "");

  switch (intent) {
    case "bot_on":
    case "bot_off": {
      const enabled = intent === "bot_on";
      await setChannelEnabled(channelId, enabled);
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { notice: `Bot turned ${enabled ? "on" : "off"}.` }));
    }
    case "market_on":
    case "market_off": {
      const enabled = intent === "market_on";
      await setMerchantEnabled(channelId, enabled, enabled ? Date.now() + randomMerchantIntervalMs() : null);
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { notice: `Merchant turned ${enabled ? "on" : "off"}.` }));
    }
    case "chronicle_on":
    case "chronicle_off": {
      const enabled = intent === "chronicle_on";
      await setChronicleEnabled(channelId, enabled);
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { notice: `Chronicle turned ${enabled ? "on" : "off"}.` }));
    }
    case "npc_on":
    case "npc_off": {
      const enabled = intent === "npc_on";
      await setNpcEnabled(channelId, enabled);
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { notice: `AI NPCs turned ${enabled ? "on" : "off"}.` }));
    }
    case "npcchatter_on":
    case "npcchatter_off": {
      const enabled = intent === "npcchatter_on";
      await setNpcChatterEnabled(channelId, enabled);
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { notice: `AI NPC chatter turned ${enabled ? "on" : "off"}.` }));
    }
    case "group_on":
    case "group_off": {
      const group = String(form.get("group") ?? "");
      if (!(group in COMMAND_GROUPS)) {
        return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Unknown feature group." }));
      }
      const enabled = intent === "group_on";
      await setCommandGroupEnabled(channelId, group, enabled);
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { notice: `${COMMAND_GROUPS[group].label.split(" (")[0]} turned ${enabled ? "on" : "off"}.` }));
    }
    default:
      return redirectTo(dashboardUrl(baseUrl, channelId, key, { error: "Unknown action." }));
  }
}

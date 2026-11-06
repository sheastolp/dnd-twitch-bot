// Who may open the operator pages (/admin/*). Two ways in:
//   1. ADMIN_API_SECRET — as `Authorization: Bearer <secret>`, ?key=<secret>
//      on the URL, or a key form field on POST (unchanged, for scripts).
//   2. A Twitch login by a bot admin (bot_admins.ts): GET /admin/login →
//      Twitch → /dashboard/callback (shared, so no new redirect URL to
//      register) → a signed gs_admin cookie, Path=/admin, 12 hours.
//
// The cookie is SameSite=Strict so no other site can make a logged-in
// browser POST to /admin/* (repoint subscriptions, disable a channel). Strict
// also means it isn't sent on the redirect chain back from twitch.tv, so the
// callback shows a page with links instead of redirecting.
// The login is re-checked against bot_admins.ts on every request, so taking
// a name off that list locks it out of a session it already holds.

import { env, exchangeCode, getViewerIdentity, timingSafeEqual } from "./twitch.ts";
import { saveDashboardOAuthState } from "./db.ts";
import { isBotAdminLogin } from "./bot_admins.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

/** dashboard_oauth_state.channel_id marking an /admin login (dashboard.ts
 * routes /dashboard/callback here when it sees it). */
export const OPERATOR_STATE = "admin";
const COOKIE = "gs_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
}

// Its own derived key, so a dashboard or merchant-sale cookie can never
// verify as an operator one.
async function hmacHex(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env("EVENTSUB_SECRET")}:operator-session-v1`));
  const key = await crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signSession(login: string, expiresAt: number): Promise<string> {
  const payload = `op:${login.toLowerCase()}:${expiresAt}`;
  return `${b64urlEncode(payload)}.${await hmacHex(payload)}`;
}

/** The bot admin's login if the cookie is valid, unexpired and still on the list. */
async function verifySession(token: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  let payload: string;
  try {
    payload = b64urlDecode(token.slice(0, dot));
  } catch {
    return null;
  }
  if (!timingSafeEqual(token.slice(dot + 1), await hmacHex(payload))) return null;
  const parts = payload.split(":");
  if (parts.length !== 3 || parts[0] !== "op") return null;
  const expiresAt = Number(parts[2]);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return isBotAdminLogin(parts[1]) ? parts[1] : null;
}

function cookieValue(req: Request): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** True if this request may use the operator pages: the ADMIN_API_SECRET (as
 * a Bearer header or the given ?key= / form key), or a bot admin's session. */
export async function isOperatorRequest(req: Request, key = ""): Promise<boolean> {
  const secret = Deno.env.get("ADMIN_API_SECRET");
  if (secret && secret.length >= 32) {
    const auth = req.headers.get("Authorization") ?? "";
    if (timingSafeEqual(auth, `Bearer ${secret}`) || (key && timingSafeEqual(key, secret))) return true;
  }
  const token = cookieValue(req);
  return !!token && !!(await verifySession(token));
}

export function operatorUnauthorized(): Response {
  return new Response("Unauthorized. Log in at /admin/login, or append ?key=<ADMIN_API_SECRET> to the URL.", {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

function operatorPage(title: string, body: string): Response {
  return new Response(scrollDoc(`${title} — GuildScribe`, body, { width: 900, css: LEDGER_CSS }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** GET /admin/login — off to Twitch to prove who you are. */
export async function handleOperatorLogin(baseUrl: string): Promise<Response> {
  const state = crypto.randomUUID();
  await saveDashboardOAuthState(state, OPERATOR_STATE, "", Date.now() + OAUTH_STATE_TTL_MS);
  const auth = new URL("https://id.twitch.tv/oauth2/authorize");
  auth.search = new URLSearchParams({
    client_id: env("TWITCH_CLIENT_ID"),
    redirect_uri: `${baseUrl}/dashboard/callback`,
    response_type: "code",
    scope: "user:read:moderated_channels",
    state,
  }).toString();
  return new Response(null, { status: 302, headers: { Location: auth.toString(), "Cache-Control": "no-store" } });
}

/** /dashboard/callback for a state row made by handleOperatorLogin. */
export async function handleOperatorCallback(code: string | null, oauthError: string | null, baseUrl: string): Promise<Response> {
  const retry = `<p><a href="/admin/login">Try again</a> · <a href="/">Bot home</a></p>`;
  if (oauthError) return operatorPage("Login cancelled", `<h1>Login cancelled</h1><p>Twitch login was cancelled.</p>${retry}`);
  if (!code) return new Response("Missing OAuth code.", { status: 400 });
  try {
    const token = await exchangeCode(code, `${baseUrl}/dashboard/callback`);
    const viewer = await getViewerIdentity(token.access_token);
    if (!viewer) return operatorPage("Login failed", `<h1>Login failed</h1><p>Couldn't verify your Twitch account.</p>${retry}`);
    if (!isBotAdminLogin(viewer.login)) {
      return new Response(
        scrollDoc("Not an operator — GuildScribe", `<h1>Not an operator</h1><p>${escapeHtml(viewer.display_name)} isn't a GuildScribe bot admin.</p><p><a href="/">Bot home</a></p>`, { width: 900, css: LEDGER_CSS }),
        { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
      );
    }
    const session = await signSession(viewer.login, Date.now() + SESSION_TTL_MS);
    const res = operatorPage(
      "Operator login",
      `<h1>Welcome, ${escapeHtml(viewer.display_name)}</h1><p>You're logged in to the operator pages for 12 hours.</p><ul class="list"><li><a href="/admin/channels">Channel connections</a></li><li><a href="/admin/logs">Operator logs</a></li><li><a href="/admin/motd">Message of the day</a></li><li><a href="/admin/eventsub">EventSub subscriptions</a></li></ul>`,
    );
    res.headers.set("Set-Cookie", `${COOKIE}=${session}; Path=/admin; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Strict`);
    return res;
  } catch (e) {
    console.error("operator oauth callback failed", e);
    return operatorPage("Login failed", `<h1>Login failed</h1><p>Twitch login failed.</p>${retry}`);
  }
}

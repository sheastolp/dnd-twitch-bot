// Long replies: summary in chat, full output by link (and by whisper).
//
// When anything the bot says would take more than one chat message
// (LONG_REPLY_PARTS), sendChatMessages (twitch.ts) posts one short summary
// message in chat ending in a link to a page with the full output
// (replypages.ts). When it answers someone's !command, the full reply is
// also whispered to them if whispers are set up.
//
// Who "ran the command" is tracked per request with AsyncLocalStorage:
// main.ts wraps every request in runRequestScope() and calls
// setReplyInitiator() once it knows the chatter, so concurrent requests in
// the same isolate never see each other's chatter.
//
// Whispers are sent by the bot account itself (Helix Send Whisper), which
// needs a *user* token for the bot with the user:manage:whispers scope —
// not the app token chat uses. Log in as the bot account and visit
// /connect-bot once to grant it; the refresh token is stored in
// bot_user_tokens and refreshed automatically. Until that's done (or if
// Twitch refuses a whisper, e.g. the viewer blocks whispers from strangers),
// only the chat summary and link are sent.

import { AsyncLocalStorage } from "node:async_hooks";
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

// Any reply that would take more than one chat message is summarized.
export const LONG_REPLY_PARTS = 2;
// Twitch caps a whisper at 500 characters until the recipient has whispered
// the sender back (10,000 after that); stay under the stricter limit.
export const WHISPER_MAX = 500;
const MAX_WHISPER_PARTS = 10;
const WHISPER_DELAY_MS = 400; // Twitch allows 3 whispers/second
const BOT_WHISPER_SCOPE = "user:manage:whispers";

export interface ReplyInitiator { userId: string; login: string; display: string; broadcasterId: string }

const requestScope = new AsyncLocalStorage<{ initiator?: ReplyInitiator }>();

/** Runs one request with its own (initially empty) reply-initiator slot. */
export function runRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  return requestScope.run({}, fn);
}

/** Marks the chatter whose command this request is answering. */
export function setReplyInitiator(initiator: ReplyInitiator) {
  const store = requestScope.getStore();
  if (store && initiator.userId) store.initiator = initiator;
}

export function getReplyInitiator(): ReplyInitiator | undefined {
  return requestScope.getStore()?.initiator;
}

function env(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Bot user token (user:manage:whispers) ──

export async function ensureWhisperTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS bot_user_tokens (
      bot_id TEXT PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    )`,
  );
  // The last whisper attempt's outcome (one row), for /connect-bot/status
  // and !whispertest — Twitch's error text is otherwise only in the logs.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS whisper_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      at INTEGER NOT NULL, ok INTEGER NOT NULL, status INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT ''
    )`,
  );
}

export type WhisperResult = { ok: boolean; status: number; detail: string };

async function recordWhisperResult(r: WhisperResult) {
  try {
    await sqlite.execute(
      "INSERT OR REPLACE INTO whisper_status (id, at, ok, status, detail) VALUES (1, ?, ?, ?, ?)",
      [Date.now(), r.ok ? 1 : 0, r.status, r.detail.slice(0, 500)],
    );
  } catch (_) { /* table missing in a cron isolate: diagnostics only */ }
}

/** Plain-English reason for a failed whisper, from Twitch's status code. */
export function explainWhisperFailure(r: WhisperResult): string {
  switch (r.status) {
    case 0: return r.detail || "the bot has no whisper token — log in to Twitch as the bot account and open /connect-bot";
    case 400: return `Twitch rejected the request (400): ${r.detail}`;
    case 401: return `the bot's token is invalid or lacks user:manage:whispers (401: ${r.detail}) — redo /connect-bot as the bot account`;
    case 403: return `Twitch refused (403: ${r.detail}). Usually the bot account has no verified phone number (Twitch → Settings → Security and Privacy), or the viewer blocks whispers from strangers`;
    case 404: return `Twitch couldn't find the recipient (404: ${r.detail})`;
    case 429: return `rate-limited by Twitch (429) — whispers to new recipients are capped per day/minute. ${r.detail}`;
    default: return `Twitch returned ${r.status}: ${r.detail}`;
  }
}

async function saveBotToken(botId: string, token: any) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO bot_user_tokens (bot_id, access_token, refresh_token, expires_at, updated_at) VALUES (?,?,?,?,?)",
    [botId, token.access_token, token.refresh_token, Date.now() + Number(token.expires_in ?? 0) * 1000, Date.now()],
  );
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getBotUserToken(forceRefresh = false): Promise<string | null> {
  const botId = env("TWITCH_BOT_ID");
  if (!forceRefresh && cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) return cachedToken.token;
  const res = await sqlite.execute("SELECT * FROM bot_user_tokens WHERE bot_id = ?", [botId]);
  const row: any = res.rows[0];
  if (!row) return null; // /connect-bot not done yet — callers fall back to chat
  if (!forceRefresh && row.access_token && Number(row.expires_at) - 60_000 > Date.now()) {
    cachedToken = { token: String(row.access_token), expiresAt: Number(row.expires_at) };
    return cachedToken.token;
  }
  const refreshed = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("TWITCH_CLIENT_ID"),
      client_secret: env("TWITCH_CLIENT_SECRET"),
      grant_type: "refresh_token",
      refresh_token: String(row.refresh_token),
    }),
  });
  if (!refreshed.ok) {
    console.error(`Bot whisper token refresh failed: ${refreshed.status}`);
    cachedToken = null;
    return null;
  }
  const token = await refreshed.json();
  if (!token.refresh_token) token.refresh_token = row.refresh_token;
  await saveBotToken(botId, token);
  cachedToken = { token: token.access_token, expiresAt: Date.now() + Number(token.expires_in ?? 0) * 1000 };
  return cachedToken.token;
}

async function sendOneWhisper(toUserId: string, message: string): Promise<WhisperResult> {
  const send = (token: string) =>
    fetch(
      `https://api.twitch.tv/helix/whispers?${new URLSearchParams({ from_user_id: env("TWITCH_BOT_ID"), to_user_id: toUserId })}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Client-Id": env("TWITCH_CLIENT_ID"), "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      },
    );
  const noToken = { ok: false, status: 0, detail: "" };
  let token = await getBotUserToken();
  if (!token) return noToken;
  let res = await send(token);
  if (res.status === 401) {
    token = await getBotUserToken(true);
    if (!token) return { ...noToken, detail: "the bot's whisper token could not be refreshed — redo /connect-bot as the bot account" };
    res = await send(token);
  }
  let detail = "";
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    try {
      detail = String(JSON.parse(body).message ?? body);
    } catch {
      detail = body;
    }
    console.error(`Twitch whisper failed: ${res.status} ${detail}`);
  }
  const result = { ok: res.ok, status: res.status, detail };
  await recordWhisperResult(result);
  return result;
}

/** Whispers `parts` (each ≤ WHISPER_MAX) in order. Returns false if the
 * first one couldn't be sent, so the caller can fall back to chat; a later
 * part failing just ends the whisper early. */
export async function sendWhisperParts(toUserId: string, parts: string[]): Promise<boolean> {
  return (await sendWhisperPartsDetailed(toUserId, parts)).ok;
}

/** sendWhisperParts, but returns why the first part failed (for !whispertest). */
export async function sendWhisperPartsDetailed(toUserId: string, parts: string[]): Promise<WhisperResult> {
  const list = parts.slice(0, MAX_WHISPER_PARTS);
  let first: WhisperResult = { ok: false, status: 0, detail: "nothing to send" };
  for (let i = 0; i < list.length; i++) {
    let r: WhisperResult;
    try {
      r = await sendOneWhisper(toUserId, list[i].slice(0, WHISPER_MAX));
    } catch (err) {
      console.error("sendWhisper failed", err);
      r = { ok: false, status: -1, detail: String(err) };
    }
    if (i === 0) first = r;
    if (!r.ok) return i > 0 ? { ...first, ok: true } : r;
    if (i < list.length - 1) await sleep(WHISPER_DELAY_MS);
  }
  return first;
}

/** Everything about the bot's whisper setup, for GET /connect-bot/status. */
export async function whisperDiagnostics(): Promise<string[]> {
  const out: string[] = [];
  const botId = Deno.env.get("TWITCH_BOT_ID");
  out.push(botId ? `TWITCH_BOT_ID is set (${botId}).` : "❌ TWITCH_BOT_ID is not set.");
  const row: any = botId ? (await sqlite.execute("SELECT * FROM bot_user_tokens WHERE bot_id = ?", [botId])).rows[0] : null;
  if (!row) {
    out.push("❌ No whisper token stored for the bot. Log in to Twitch AS THE BOT ACCOUNT and open /connect-bot (its /connect-bot/callback URL must be added to your Twitch app's OAuth Redirect URLs).");
  } else {
    out.push(`✅ Whisper token stored (last updated ${new Date(Number(row.updated_at)).toISOString()}).`);
    const token = await getBotUserToken(true);
    if (!token) {
      out.push("❌ Refreshing the token failed — redo /connect-bot as the bot account.");
    } else {
      const v = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${token}` } });
      if (!v.ok) {
        out.push(`❌ Twitch says the token is invalid (${v.status}) — redo /connect-bot.`);
      } else {
        const info = await v.json();
        const scopes: string[] = info.scopes ?? [];
        out.push(`${String(info.user_id) === botId ? "✅" : "❌"} Token belongs to ${info.login} (${info.user_id})${String(info.user_id) === botId ? "" : ` — NOT the bot (${botId})`}.`);
        out.push(`${scopes.includes(BOT_WHISPER_SCOPE) ? "✅" : "❌"} Scopes: ${scopes.join(", ") || "none"}.`);
      }
    }
  }
  const last: any = (await sqlite.execute("SELECT * FROM whisper_status WHERE id = 1")).rows[0];
  if (!last) out.push("No whisper has been attempted yet. Run !whispertest in chat (mods), or trigger a reply longer than one chat message.");
  else {
    const r = { ok: Number(last.ok) === 1, status: Number(last.status), detail: String(last.detail) };
    out.push(`Last whisper attempt ${new Date(Number(last.at)).toISOString()}: ${r.ok ? "✅ delivered" : `❌ ${explainWhisperFailure(r)}`}.`);
  }
  out.push("Reminder: Twitch only lets accounts with a verified phone number send whispers, and only replies longer than one chat message are whispered (or run !whispertest).");
  return out;
}

/** The one-paragraph chat summary of a long reply: its opening sentences, up
 * to SUMMARY_MAX characters, cut at a sentence end where possible. The
 * caller appends the link to the full reply. */
const SUMMARY_MAX = 220;
export function replySummary(display: string | undefined, text: string): string {
  if (!display) display = text.match(/^\W*@([A-Za-z0-9_]{1,25})\b/)?.[1] ?? "";
  const body = (display ? text.replace(new RegExp(`^\\W*@${display.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[\\s,:]*`, "i"), "") : text).replace(/\s*\|\s*/g, " · ").trim();
  let gist = body;
  if (gist.length > SUMMARY_MAX) {
    const cut = gist.slice(0, SUMMARY_MAX);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    gist = end > 60 ? cut.slice(0, end + 1) : cut.slice(0, SUMMARY_MAX - 1).trimEnd() + "…";
  }
  return display ? `@${display} ${gist}` : gist;
}

/** Chat summary for a long fight: who fought whom, how it ended, and
 * the loot won ("none" when there was none, e.g. PvP or a loss). */
export function fightSummary(f: { fighter: string; enemy: string; outcome: string; loot?: string }): string {
  return `⚔️ ${f.fighter} vs ${f.enemy} — ${f.outcome} 🪙 Loot: ${f.loot || "none"}.`;
}

// ── /connect-bot: grant the bot account's whisper scope once ──

/** Handles GET /connect-bot and /connect-bot/callback; null for any other path. */
export async function handleBotConnectRoute(req: Request, url: URL, path: string): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const redirectUri = `${url.origin}/connect-bot/callback`;
  const html = (title: string, body: string, status = 200) =>
    new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><p>${body}</p>`, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

  if (path === "/connect-bot") {
    const state = crypto.randomUUID();
    await sqlite.execute("INSERT INTO oauth_states (state,expires_at) VALUES (?,?)", [state, Date.now() + 10 * 60 * 1000]);
    const auth = new URL("https://id.twitch.tv/oauth2/authorize");
    auth.search = new URLSearchParams({
      client_id: env("TWITCH_CLIENT_ID"),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: BOT_WHISPER_SCOPE,
      force_verify: "true",
      state,
    }).toString();
    return Response.redirect(auth.toString(), 302);
  }

  if (path === "/connect-bot/status") {
    const lines = await whisperDiagnostics();
    return html("Whisper status", `<b>GuildScribe whisper status</b></p><ul>${lines.map((l) => `<li>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</li>`).join("")}</ul><p>`);
  }

  if (path === "/connect-bot/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return html("Bot connection cancelled", "Bot connection cancelled or missing OAuth code.", 400);
    const check = await sqlite.execute("SELECT 1 FROM oauth_states WHERE state = ? AND expires_at > ?", [state, Date.now()]);
    if (!check.rows.length) return html("Expired", "Invalid or expired OAuth state — start again at /connect-bot.", 400);
    await sqlite.execute("DELETE FROM oauth_states WHERE state = ?", [state]);
    const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("TWITCH_CLIENT_ID"),
        client_secret: env("TWITCH_CLIENT_SECRET"),
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) return html("Failed", `Twitch token exchange failed (${tokenRes.status}).`, 502);
    const token = await tokenRes.json();
    const userRes = await fetch("https://api.twitch.tv/helix/users", {
      headers: { Authorization: `Bearer ${token.access_token}`, "Client-Id": env("TWITCH_CLIENT_ID") },
    });
    const user = userRes.ok ? (await userRes.json()).data?.[0] : null;
    // Only the bot's own account may store this token — anyone else who
    // follows the link just gets turned away.
    if (!user || String(user.id) !== env("TWITCH_BOT_ID")) {
      return html("Wrong account", "That isn't the bot's Twitch account. Log in to Twitch as the bot and try /connect-bot again.", 403);
    }
    await saveBotToken(String(user.id), token);
    cachedToken = null;
    return html("Bot connected", `Whispers enabled for ${String(user.display_name ?? user.login)}. Long replies will now be whispered.`);
  }

  return null;
}

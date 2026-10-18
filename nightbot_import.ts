// GuildScribe — Nightbot side of /dashboard/import (se_import.ts owns the
// page, the staging table and the import step; this file only fetches and
// translates).
//
// Two ways in:
//   • By Twitch username, no login. Nightbot's public command list
//     (nightbot.tv/t/<name>/commands) comes from its API with a
//     "Nightbot-Channel" header. That list hides each $(variable) as
//     [variable] and drops its arguments, so known names are turned back into
//     $(…) and anything that needed arguments ($(urlfetch …), $(eval …)) is
//     flagged. Timers aren't public.
//   • "Log in with Nightbot" (only when NIGHTBOT_CLIENT_ID/SECRET are set —
//     register an app at nightbot.tv/account/applications with the redirect
//     URI <PUBLIC_ORIGIN>/nightbot/callback). The channel owner approves
//     read access to commands + timers; GuildScribe fetches both with the
//     real $(…) text, then revokes the token. Nothing is stored but the
//     30-minute staged preview.
//
// Nightbot has no quote book, so there are never quotes to import.

import { sqlite } from "./sqlite.ts";
import { PUBLIC_ORIGIN } from "./config.ts";
import { convertDollarSyntax } from "./dollar_syntax.ts";
import { MAX_COOLDOWN_SECONDS, MAX_CUSTOM_RESPONSE_LEN } from "./customcommands.ts";
import { MAX_INTERVAL_MINUTES, MAX_TIMED_MESSAGE_LEN, MIN_INTERVAL_MINUTES } from "./timedmessages.ts";
import { type CommandSource, existingTimedMessages, saveStage, type StagedTimer, stageCommands } from "./se_import.ts";

const NB_API = "https://api.nightbot.tv/1";
const NB_OAUTH = "https://api.nightbot.tv/oauth2";
const FETCH_TIMEOUT_MS = 15_000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const LABEL = "Nightbot";

const clientId = () => Deno.env.get("NIGHTBOT_CLIENT_ID") ?? "";
const clientSecret = () => Deno.env.get("NIGHTBOT_CLIENT_SECRET") ?? "";
const redirectUri = () => `${PUBLIC_ORIGIN}/nightbot/callback`;

/** Whether the "Log in with Nightbot" button can work on this deployment. */
export function nightbotConnectConfigured(): boolean {
  return !!clientId() && !!clientSecret();
}

export async function ensureNightbotImportTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS nightbot_oauth_states (
      state TEXT PRIMARY KEY, broadcaster_id TEXT NOT NULL, dash_key TEXT NOT NULL, created_at INTEGER NOT NULL
    )`,
  );
}

export async function purgeNightbotImportData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM nightbot_oauth_states WHERE broadcaster_id = ?", [broadcasterId]);
}

// ── Translating Nightbot variables ──────────────────────────────────────────

// Every $(…) Nightbot documents, for un-hiding the public list's [name].
const NB_VARS = new Set([
  "user", "touser", "query", "querystring", "count", "channel", "time", "twitch", "urlfetch", "customapi", "eval",
  "countdown", "countup", "weather", "followage", "followers", "offlineonly", "provider", "pastebin", "randomnick",
  "userid", "userlevel", "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);
// Nightbot names whose meaning differs from the GuildScribe word of the same name.
const NB_SIMPLE: Record<string, string> = { query: "args", querystring: "args" };

/** The public list writes $(user) as [user] and $(urlfetch https://…) as
 * [urlfetch]. Turns known names back into $(…), innermost first. */
export function unhidePublicNightbot(message: string): string {
  let out = message;
  for (let i = 0; i < 6; i++) {
    const next = out.replace(/\[([a-z0-9]+)((?:\s[^\[\]]*)?)\]/gi, (whole, word: string, rest: string) =>
      NB_VARS.has(word.toLowerCase()) ? `$(${word}${rest})` : whole);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Turns a Nightbot reply into a GuildScribe response (same contract as translateSeReply). */
export function translateNightbotReply(message: string): { text: string; notes: string[]; ok: boolean } {
  const notes: string[] = [];
  let ok = true;
  let out = message.replace(/\$\(\s*([a-z0-9]+)((?:\s[^()]*)?)\)/gi, (whole, word: string) => {
    const w = word.toLowerCase();
    if (w === "querystring") notes.push("$(querystring) isn't URL-encoded here");
    if (NB_SIMPLE[w]) return `$(${NB_SIMPLE[w]})`;
    if (w === "time") {
      notes.push("time is shown in UTC");
      return "$(time)";
    }
    if (w === "offlineonly") {
      notes.push("only answered while offline in Nightbot; always answers here");
      return "";
    }
    return whole;
  });
  out = convertDollarSyntax(out);
  const left = [...out.matchAll(/\$\(\s*([^\s()]+)/g)].map((m) => m[1].toLowerCase());
  for (const w of new Set(left)) notes.push(`$(${w}) has no GuildScribe equivalent`);
  if (left.length) ok = false;
  if (out.length > MAX_CUSTOM_RESPONSE_LEN) {
    notes.push(`cut to ${MAX_CUSTOM_RESPONSE_LEN} characters`);
    out = out.slice(0, MAX_CUSTOM_RESPONSE_LEN);
  }
  return { text: out.trim(), notes: [...new Set(notes)], ok };
}

/** Nightbot timers run on a cron string; returns minutes, or null if it's
 * not a plain repeating interval. */
export function cronToMinutes(cron: string): number | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || f.slice(2).some((x) => x !== "*")) return null;
  const [min, hour] = f;
  let m = min.match(/^\*\/(\d+)$/);
  if (m && hour === "*") return Number(m[1]);
  if (min === "*" && hour === "*") return 1;
  if (/^\d+$/.test(min)) {
    if (hour === "*") return 60;
    m = hour.match(/^\*\/(\d+)$/);
    if (m) return Number(m[1]) * 60;
  }
  return null;
}

// ── Fetching ────────────────────────────────────────────────────────────────

async function nbGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${NB_API}${path}`, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  let body: any = null;
  try { body = await res.json(); } catch (_) { /* non-JSON error page */ }
  return { status: res.status, body };
}

const LEVEL_LABELS: Record<string, string> = { subscriber: "subscribers", regular: "regulars", twitch_vip: "VIPs", moderator: "mods", admin: "mods", owner: "the broadcaster" };

function toCommandSources(raw: any[], hidden: boolean): CommandSource[] {
  const byName = new Map<string, any>();
  for (const c of raw) byName.set(String(c.name ?? "").toLowerCase(), c);
  const out: CommandSource[] = [];
  for (const c of raw) {
    const rawName = String(c.name ?? "");
    let message = String(c.message ?? "");
    const notes: string[] = [];
    let ok = true;
    const alias = String(c.alias ?? "").trim();
    if (alias) {
      const target = byName.get(alias.toLowerCase());
      if (!message && target && !target.alias) {
        message = String(target.message ?? "");
        notes.push(`alias of ${alias} in Nightbot; copies its reply`);
      } else {
        notes.push(`runs ${alias} in Nightbot${message ? " with extra text" : ""}; that doesn't carry over`);
        ok = false;
      }
    }
    if (hidden) {
      const before = message;
      message = unhidePublicNightbot(message);
      if (message !== before) notes.push("variables rebuilt from Nightbot's public list — check them");
    }
    const t = translateNightbotReply(message);
    notes.push(...t.notes);
    if (!t.ok) ok = false;
    if (!rawName.startsWith("!")) {
      notes.push(`Nightbot answered “${rawName.slice(0, 30)}” without a !; here it's a ! command`);
      ok = false;
    }
    const level = String(c.userLevel ?? "everyone");
    if (level !== "everyone") {
      notes.push(`only ${LEVEL_LABELS[level] ?? level} could use it in Nightbot; anyone can here`);
      if (["moderator", "admin", "owner"].includes(level)) ok = false;
    }
    out.push({
      names: [rawName.replace(/^!/, "")],
      text: t.text,
      notes,
      ok,
      cooldownSec: Math.min(MAX_COOLDOWN_SECONDS, Math.max(0, Number(c.coolDown ?? 30) || 0)),
      enabled: true, // Nightbot commands have no on/off switch
      uses: Number(c.count ?? 0) || 0, // $(count) picks up where Nightbot left off
    });
  }
  return out;
}

async function toTimers(broadcasterId: string, raw: any[]): Promise<StagedTimer[]> {
  const existing = await existingTimedMessages(broadcasterId);
  const timers: StagedTimer[] = [];
  for (const t of raw) {
    const tr = translateNightbotReply(String(t.message ?? ""));
    const notes = tr.notes.filter((n) => !n.startsWith("cut to"));
    if (/\{(?!count\})[^}]*\}/.test(tr.text)) {
      notes.push("timed messages can't fill in chat variables");
      tr.ok = false;
    }
    const cron = String(t.interval ?? "");
    const every = cronToMinutes(cron);
    if (every === null) notes.push(`schedule “${cron.slice(0, 30)}” isn't a plain interval; set to 15 min`);
    const interval = Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, every ?? 15));
    if (every !== null && interval !== every) notes.push(`every ${every} min in Nightbot`);
    if (Number(t.lines ?? 0) > 0) notes.push(`needed ${t.lines} chat lines in between in Nightbot; not here`);
    const message = tr.text.slice(0, MAX_TIMED_MESSAGE_LEN);
    if (tr.text.length > MAX_TIMED_MESSAGE_LEN) notes.push(`cut to ${MAX_TIMED_MESSAGE_LEN} characters`);
    if (existing.has(message.toLowerCase())) {
      notes.push("already a timed message here");
      tr.ok = false;
    }
    if (t.enabled === false) notes.push("off in Nightbot");
    timers.push({ name: String(t.name ?? ""), message, intervalMinutes: interval, enabled: t.enabled !== false, notes, ok: tr.ok && !!message && t.enabled !== false });
  }
  return timers;
}

const NO_QUOTES = "Nightbot doesn't have a quote book, so there are no quotes to bring over.";

/** By username, no login: public commands only. */
export async function stageNightbotPublic(broadcasterId: string, rawUsername: string): Promise<{ id: string } | { error: string }> {
  const username = rawUsername.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(username)) return { error: "Enter a Twitch username, like stonedsheamus." };
  let channel: { status: number; body: any };
  try {
    channel = await nbGet(`/channels/t/${encodeURIComponent(username)}`, {});
  } catch (e) {
    return { error: `Couldn't reach Nightbot (${String(e).slice(0, 80)}). Try again in a minute.` };
  }
  if (channel.status === 404 || !channel.body?.channel?._id) return { error: `Nightbot has no channel for “${username}”.` };
  if (channel.status !== 200) return { error: `Nightbot answered ${channel.status}. Try again in a minute.` };
  const ch = channel.body.channel;
  const cmdRes = await nbGet("/commands", { "Nightbot-Channel": String(ch._id) }).catch(() => null);
  if (!cmdRes || cmdRes.status !== 200) return { error: `Couldn't read ${username}'s Nightbot commands${cmdRes ? ` (Nightbot answered ${cmdRes.status})` : ""}. Try again in a minute.` };
  const raw: any[] = Array.isArray(cmdRes.body?.commands) ? cmdRes.body.commands : [];
  const commands = await stageCommands(broadcasterId, toCommandSources(raw, true), LABEL);
  const id = await saveStage(broadcasterId, {
    source: "nightbot", username, displayName: String(ch.displayName || ch.name || username), commands, quotes: [], timers: [],
    quotesStatus: NO_QUOTES,
    timersStatus: nightbotConnectConfigured() ? "Timers aren't public — use “Log in with Nightbot” to include them." : "Timers aren't public on Nightbot, so only commands came across.",
  });
  return { id };
}

/** URL to send the mod to for "Log in with Nightbot", or null if not set up. */
export async function startNightbotConnect(broadcasterId: string, dashKey: string): Promise<string | null> {
  if (!nightbotConnectConfigured()) return null;
  const state = crypto.randomUUID().replace(/-/g, "");
  await sqlite.execute("DELETE FROM nightbot_oauth_states WHERE created_at < ?", [Date.now() - OAUTH_STATE_TTL_MS]);
  await sqlite.execute("INSERT INTO nightbot_oauth_states (state, broadcaster_id, dash_key, created_at) VALUES (?,?,?,?)", [state, broadcasterId, dashKey, Date.now()]);
  const params = new URLSearchParams({ response_type: "code", client_id: clientId(), redirect_uri: redirectUri(), scope: "commands timers", state });
  return `${NB_OAUTH}/authorize?${params}`;
}

/** GET /nightbot/callback — trusted by its one-time state (made behind the
 * dashboard gate). Fetches everything with the token, revokes it, and sends
 * the mod back to the import page's checklist. */
export async function handleNightbotCallback(url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const row = state ? (await sqlite.execute("SELECT broadcaster_id, dash_key, created_at FROM nightbot_oauth_states WHERE state = ?", [state])).rows[0] as any : null;
  if (state) await sqlite.execute("DELETE FROM nightbot_oauth_states WHERE state = ?", [state]);
  if (!row || Date.now() - Number(row.created_at) > OAUTH_STATE_TTL_MS) {
    return new Response("This Nightbot link has expired — start again from your dashboard's Import page.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const broadcasterId = String(row.broadcaster_id);
  const back = (params: Record<string, string>) => {
    const p = new URLSearchParams({ channel: broadcasterId, key: String(row.dash_key), from: "nightbot", ...params });
    return new Response(null, { status: 302, headers: { Location: `${PUBLIC_ORIGIN}/dashboard/import?${p}`, "Cache-Control": "no-store" } });
  };
  const code = url.searchParams.get("code");
  if (!code) return back({ error: url.searchParams.get("error") === "access_denied" ? "Nightbot wasn't connected — access was declined." : "Nightbot didn't send a code back — try again." });

  let token = "";
  try {
    const res = await fetch(`${NB_OAUTH}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), grant_type: "authorization_code", redirect_uri: redirectUri(), code }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    token = String(body?.access_token ?? "");
    if (!res.ok || !token) {
      console.error("nightbot token exchange failed", res.status, body);
      return back({ error: "Nightbot wouldn't finish logging in. Try again in a minute." });
    }
  } catch (e) {
    console.error("nightbot token exchange failed", e);
    return back({ error: "Couldn't reach Nightbot to log in. Try again in a minute." });
  }

  try {
    const auth = { Authorization: `Bearer ${token}` };
    const [me, cmds, tms] = await Promise.all([nbGet("/me", auth), nbGet("/commands", auth), nbGet("/timers", auth)]);
    if (me.status !== 200 || cmds.status !== 200) return back({ error: `Nightbot answered ${me.status !== 200 ? me.status : cmds.status} when reading the commands. Try again in a minute.` });
    const user = me.body?.user ?? {};
    const rawCmds: any[] = Array.isArray(cmds.body?.commands) ? cmds.body.commands : [];
    const rawTimers: any[] = tms.status === 200 && Array.isArray(tms.body?.timers) ? tms.body.timers : [];
    const commands = await stageCommands(broadcasterId, toCommandSources(rawCmds, false), LABEL);
    const timers = await toTimers(broadcasterId, rawTimers);
    const id = await saveStage(broadcasterId, {
      source: "nightbot", username: String(user.name ?? "").toLowerCase(), displayName: String(user.displayName || user.name || "Nightbot"),
      commands, quotes: [], timers, quotesStatus: NO_QUOTES, timersStatus: tms.status === 200 ? "" : `Nightbot answered ${tms.status} for timers.`,
    });
    return back({ stage: id });
  } finally {
    // Only needed for this one read.
    fetch(`${NB_OAUTH}/token/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
}

// Bot viewer check — scans the channel's current chat list and flags accounts
// that look like follow/view-bots, so the broadcaster and mods can review
// and block them by hand. Nothing is banned automatically.
//
//   !botcheck                        anyone: "N likely bot viewers out of M"
//   !botcheck ignore <user>          mod: stop flagging a real viewer
//   !botcheck unignore <user>        mod: flag them again
//   GET  /dashboard/botcheck         mod: the full list with reasons, behind
//   POST /dashboard/botcheck           the dashboard's key + Twitch login
//
// Each chatter is scored on account age, a default profile picture and a
// generated-looking username. It's a heuristic, not a verdict: the page says
// so, and the ignore list (per channel, permanent until un-ignored) covers
// real viewers who happen to trip it. Known service bots (isBotAccount), the
// broadcaster and GuildScribe itself are never flagged.
//
// The chat list comes from fetchChatters in watchtime.ts, which uses the
// broadcaster's own token and needs moderator:read:chatters — already
// requested by /connect for !watchtime. Channels that connected before that
// scope get a "broadcaster, please reconnect" reply instead.
// Adapted from the standalone "Bot Viewer Detector" val.

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { getAppToken, env, sendChatMessage } from "./twitch.ts";
import { fetchChatters } from "./watchtime.ts";
import { escapeHtml, isBotAccount } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

// ── Persistence ──

export async function ensureBotDetectTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS botcheck_ignored (
      broadcaster_id TEXT NOT NULL, login TEXT NOT NULL, ignored_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, login)
    )`,
  );
}

/** Wipes the channel's ignore list — called from !dndbot leave purge. */
export async function purgeBotDetectData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM botcheck_ignored WHERE broadcaster_id = ?", [broadcasterId]);
  scanCache.delete(broadcasterId);
}

async function setIgnored(broadcasterId: string, login: string, ignored: boolean) {
  if (ignored) {
    await sqlite.execute("INSERT OR REPLACE INTO botcheck_ignored (broadcaster_id, login, ignored_at) VALUES (?,?,?)", [
      broadcasterId,
      login.toLowerCase(),
      Date.now(),
    ]);
  } else {
    await sqlite.execute("DELETE FROM botcheck_ignored WHERE broadcaster_id = ? AND login = ?", [broadcasterId, login.toLowerCase()]);
  }
  scanCache.delete(broadcasterId);
}

async function listIgnored(broadcasterId: string): Promise<Array<{ login: string; ignoredAt: number }>> {
  const res = await sqlite.execute("SELECT login, ignored_at FROM botcheck_ignored WHERE broadcaster_id = ? ORDER BY ignored_at DESC", [broadcasterId]);
  return res.rows.map((r: any) => ({ login: String(r.login), ignoredAt: Number(r.ignored_at) }));
}

// ── Scoring ──

// Shapes commonly produced by follow/view-bot generator tools.
const BOT_NAME_PATTERNS = [
  /^[a-z]{3,12}\d{5,}$/i, // short word + 5+ trailing digits, e.g. "coolgamer88421"
  /^[a-z0-9]{16,}$/i, // long random alphanumeric blob
];

interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  created_at: string;
  profile_image_url: string;
}

export interface BotScore {
  login: string;
  displayName: string;
  score: number;
  reasons: string[];
  accountAgeDays: number;
}

/** Null when nothing about the account looks off. */
function scoreUser(user: TwitchUser): BotScore | null {
  const reasons: string[] = [];
  let score = 0;
  const ageDays = (Date.now() - new Date(user.created_at).getTime()) / 86_400_000;
  if (ageDays < 3) {
    score += 3;
    reasons.push(`Account is ${ageDays.toFixed(1)} days old`);
  } else if (ageDays < 14) {
    score += 2;
    reasons.push(`Account is only ${Math.round(ageDays)} days old`);
  } else if (ageDays < 45) {
    score += 1;
    reasons.push(`Account is ${Math.round(ageDays)} days old`);
  }
  if (!user.profile_image_url || user.profile_image_url.includes("user-default-pictures")) {
    score += 2;
    reasons.push("Default profile picture");
  }
  if (BOT_NAME_PATTERNS.some((p) => p.test(user.login))) {
    score += 2;
    reasons.push("Username matches common bot-generator patterns");
  }
  if (score === 0) return null;
  return { login: user.login, displayName: user.display_name, score, reasons, accountAgeDays: Math.round(ageDays) };
}

/** Get Users, 100 logins per request (Helix's max). */
async function getUsersByLogin(logins: string[]): Promise<TwitchUser[]> {
  const out: TwitchUser[] = [];
  const token = await getAppToken();
  for (let i = 0; i < logins.length; i += 100) {
    const params = new URLSearchParams();
    for (const l of logins.slice(i, i + 100)) params.append("login", l);
    const res = await fetch(`https://api.twitch.tv/helix/users?${params}`, {
      headers: { "Client-Id": env("TWITCH_CLIENT_ID"), Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Get Users failed: ${res.status}`);
    out.push(...((await res.json())?.data ?? []));
  }
  return out;
}

// ── Scanning ──

// A scan is one Get Chatters walk plus a Get Users call per 100 chatters, so
// results are reused briefly: repeated !botcheck calls and page reloads cost
// nothing. Ignoring/un-ignoring clears the channel's entry.
const SCAN_TTL_MS = 60_000;
// Bounds the Get Users fan-out on very large chats.
const MAX_SCANNED = 5000;

export type ScanResult = { totalChatters: number; flagged: BotScore[]; scannedAt: number; truncated: boolean };
const scanCache = new Map<string, ScanResult>();

/** "no_permission" when the broadcaster hasn't granted moderator:read:chatters. */
export async function scanChannel(broadcasterId: string, fresh = false): Promise<ScanResult | "no_permission"> {
  const hit = scanCache.get(broadcasterId);
  if (!fresh && hit && Date.now() - hit.scannedAt < SCAN_TTL_MS) return hit;
  const chatters = await fetchChatters(broadcasterId);
  if (chatters === "no_permission") return "no_permission";
  const ignored = new Set((await listIgnored(broadcasterId)).map((r) => r.login));
  const botId = env("TWITCH_BOT_ID");
  const candidates = chatters
    .filter((c) => c.id !== broadcasterId && !isBotAccount(c.login, c.id, botId) && !ignored.has(c.login))
    .map((c) => c.login);
  const users = await getUsersByLogin(candidates.slice(0, MAX_SCANNED));
  const flagged = users
    .map(scoreUser)
    .filter((r): r is BotScore => r !== null)
    .sort((a, b) => b.score - a.score || a.accountAgeDays - b.accountAgeDays);
  const result = { totalChatters: chatters.length, flagged, scannedAt: Date.now(), truncated: candidates.length > MAX_SCANNED };
  scanCache.set(broadcasterId, result);
  return result;
}

// ── Chat ──

const RECONNECT_HINT = "the broadcaster needs to reconnect GuildScribe once (/connect) to grant the chat-list permission";

export async function handleBotCheckCommand(
  chatMessage: string,
  display: string,
  isModerator: boolean,
  broadcasterId: string,
  baseUrl: string,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!botcheck(?:\s+(.*))?$/i);
  if (!m) return false;
  const args = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const action = (args[0] ?? "").toLowerCase();

  if (action === "ignore" || action === "unignore") {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can change the bot-check ignore list.`, broadcasterId);
      return true;
    }
    const target = (args[1] ?? "").replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(target)) {
      await sendChatMessage(`@${display} usage: !botcheck ${action} <username>`, broadcasterId);
      return true;
    }
    await setIgnored(broadcasterId, target, action === "ignore");
    await sendChatMessage(
      action === "ignore"
        ? `@${display} 🤖 ${target} is on the ignore list and won't be flagged again.`
        : `@${display} 🤖 ${target} is off the ignore list and can be flagged again.`,
      broadcasterId,
    );
    return true;
  }

  try {
    const scan = await scanChannel(broadcasterId);
    if (scan === "no_permission") {
      await sendChatMessage(`@${display} 🤖 Bot check can't read the chat list yet — ${RECONNECT_HINT}.`, broadcasterId);
      return true;
    }
    const n = scan.flagged.length;
    const summary = n === 0
      ? `🤖 No likely bot viewers spotted out of ${scan.totalChatters} in chat right now.`
      : `🤖 ${n} likely bot viewer${n === 1 ? "" : "s"} out of ${scan.totalChatters} in chat right now.`;
    const modHint = isModerator && n > 0 ? " Mods: the full list is on the dashboard (!dashboard → Bot viewer check)." : "";
    await sendChatMessage(`${summary}${modHint}`, broadcasterId);
  } catch (e) {
    console.error("botcheck failed", e);
    await sendChatMessage(`@${display} 🤖 Bot check couldn't reach Twitch just now — try again in a minute.`, broadcasterId);
  }
  return true;
}

// ── Dashboard page (auth is done by the caller; see dashboard.ts) ──

export async function applyBotCheckForm(broadcasterId: string, form: FormData): Promise<string | null> {
  const action = String(form.get("intent") ?? "");
  const login = String(form.get("login") ?? "").replace(/^@/, "").trim().toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(login) || (action !== "ignore" && action !== "unignore")) return null;
  await setIgnored(broadcasterId, login, action === "ignore");
  return action === "ignore" ? `${login} will no longer be flagged.` : `${login} can be flagged again.`;
}

export async function renderBotCheckPage(d: { broadcasterId: string; broadcasterName: string; key: string; notice?: string; fresh?: boolean }): Promise<string> {
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const form = (intent: string, login: string, label: string, cls = "") =>
    `<form method="post" action="/dashboard/botcheck" class="inline">${hidden}<input type="hidden" name="intent" value="${intent}"><input type="hidden" name="login" value="${escapeHtml(login)}"><button type="submit" class="${cls}">${label}</button></form>`;
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);

  let scan: ScanResult | "no_permission" | "error";
  try {
    scan = await scanChannel(d.broadcasterId, d.fresh);
  } catch (e) {
    console.error("botcheck page scan failed", e);
    scan = "error";
  }
  const ignored = await listIgnored(d.broadcasterId);

  let main: string;
  if (scan === "no_permission") {
    main = `<p class="banner error">GuildScribe can't read this channel's chat list yet — ${RECONNECT_HINT}.</p><p><a class="btn ember" href="/connect">Reconnect the channel</a></p>`;
  } else if (scan === "error") {
    main = `<p class="banner error">Couldn't reach Twitch just now. <a href="/dashboard/botcheck?${qs}&fresh=1">Try again</a>.</p>`;
  } else {
    const rows = scan.flagged.map((r) =>
      `<tr><td><a href="https://twitch.tv/${encodeURIComponent(r.login)}" target="_blank" rel="noopener">${escapeHtml(r.displayName || r.login)}</a></td><td class="num"><span class="score s${Math.min(r.score, 7)}">${r.score}</span></td><td class="num">${r.accountAgeDays}d</td><td class="small">${escapeHtml(r.reasons.join(" · "))}</td><td class="num">${form("ignore", r.login, "Ignore", "ghost")}</td></tr>`
    ).join("");
    const when = new Date(scan.scannedAt).toISOString().slice(11, 16) + " UTC";
    main = `<div class="stats"><div class="stat"><b>${scan.totalChatters}</b>in chat</div><div class="stat"><b>${scan.flagged.length}</b>flagged</div><div class="stat"><b>${ignored.length}</b>ignored</div></div>
<p class="muted small">Scanned ${when}${scan.truncated ? ` · only the first ${MAX_SCANNED} chatters were checked` : ""} · <a href="/dashboard/botcheck?${qs}&fresh=1">Rescan now</a></p>
${scan.flagged.length
      ? `<div class="table-wrap"><table><thead><tr><th>Account</th><th class="num">Score</th><th class="num">Age</th><th>Why flagged</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="note">Nothing flagged right now — the chat list looks clean.</p>`}`;
  }

  const ignoredList = ignored.length
    ? `<ul class="list">${ignored.map((r) => `<li><span class="who">${escapeHtml(r.login)}</span><span class="muted small">since ${new Date(r.ignoredAt).toISOString().slice(0, 10)}</span><span style="margin-left:auto">${form("unignore", r.login, "Un-ignore", "ghost")}</span></li>`).join("")}</ul>`
    : `<p class="muted">No one yet. Use <strong>Ignore</strong> above, or <code>!botcheck ignore &lt;user&gt;</code> in chat.</p>`;

  const body = `<header class="dash-top"><div><span class="pill">Moderation · Bot viewer check</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>Accounts in chat right now that look like follow/view-bots: very new accounts, default profile pictures and generated-looking names. This is a <strong>heuristic, not a verdict</strong> — open an account before blocking it. Nothing is banned automatically.</p>
${main}
<h2>Ignore list</h2><p class="muted">Real viewers who tripped the check. They stay ignored until un-ignored.</p>${ignoredList}
<p class="colophon muted">In chat: <code>!botcheck</code> · <code>!botcheck ignore &lt;user&gt;</code> · <code>!botcheck unignore &lt;user&gt;</code></p>`;

  return scrollDoc(`${name} — Bot viewer check`, body, {
    width: 1000,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}form.inline{display:inline;margin:0}form.inline button{padding:5px 12px;font-size:.78rem}.score{display:inline-block;min-width:26px;text-align:center;border-radius:999px;padding:1px 8px;font-weight:700;background:#dccea8;color:var(--ink)}.score.s5,.score.s6,.score.s7{background:var(--bad-bg);color:var(--bad)}.score.s3,.score.s4{background:#e2c08f;color:var(--seal-dk)}td{vertical-align:middle}`,
  });
}

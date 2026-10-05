// The channel's bot list — accounts GuildScribe treats as bots on top of the
// ones it always recognizes (bot_accounts.ts: GuildScribe itself, logins
// ending in "bot", the built-in list, MY_BOT_ACCOUNTS and BOT_USERNAMES).
// Bots are left out everywhere the bot deals with real viewers: commands,
// chat gold, watch time, !oracle, sub/raid thank-yous, channel-point hexes,
// !botcheck counts and The Endless Delve.
//
//   GET  /dashboard/bots     mod: type names in, see and remove entries, behind
//   POST /dashboard/bots       the dashboard's key + Twitch login (dashboard.ts)
//
// Entries come from two places: names typed in on the page ("manual"), and
// the bot viewer check (botdetect.ts, "botcheck"), which adds the chatters
// it's fairly sure about (score ≥ BOTCHECK_AUTO_ADD_SCORE) on every scan
// unless the channel switches that off, plus any a mod adds with its "Add to
// bot list" button. Removing an entry the check added also puts the
// account on the check's ignore list, so the next scan doesn't add it back.
//
// Lookups go through a short per-isolate cache, so the chat hot path costs
// one read per channel every BOT_CACHE_MS at most.

import { sqlite } from "./sqlite.ts";
import { escapeHtml } from "./utils.ts";
import { isBotAccount, KNOWN_BOT_ACCOUNTS, MY_BOT_ACCOUNTS } from "./bot_accounts.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

/** The bot viewer check adds flagged chatters at or above this score (max 7). */
export const BOTCHECK_AUTO_ADD_SCORE = 4;
const MAX_ENTRIES = 1000;
const BOT_CACHE_MS = 30_000;
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;

export type BotSource = "manual" | "botcheck";
export type ChannelBot = { login: string; source: BotSource; note: string; addedAt: number };

export async function ensureChannelBotTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS channel_bots (
      broadcaster_id TEXT NOT NULL, login TEXT NOT NULL, source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, login)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS channel_bot_settings (
      broadcaster_id TEXT PRIMARY KEY, botcheck_auto INTEGER NOT NULL DEFAULT 1
    )`,
  );
}

/** Wipes the channel's bot list — called from !dndbot leave purge. */
export async function purgeChannelBotData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM channel_bots WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM channel_bot_settings WHERE broadcaster_id = ?", [broadcasterId]);
  cache.delete(broadcasterId);
}

const cache = new Map<string, { at: number; all: Set<string>; manual: Set<string> }>();

async function loadSets(broadcasterId: string) {
  const hit = cache.get(broadcasterId);
  if (hit && Date.now() - hit.at < BOT_CACHE_MS) return hit;
  const res = await sqlite.execute("SELECT login, source FROM channel_bots WHERE broadcaster_id = ?", [broadcasterId]);
  const all = new Set<string>(), manual = new Set<string>();
  for (const r of res.rows as any[]) {
    all.add(String(r.login));
    if (r.source === "manual") manual.add(String(r.login));
  }
  const out = { at: Date.now(), all, manual };
  cache.set(broadcasterId, out);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return out;
}

/** Every login on the channel's bot list (lowercase). */
export async function getChannelBotLogins(broadcasterId: string, onlyManual = false): Promise<Set<string>> {
  const sets = await loadSets(broadcasterId);
  return onlyManual ? sets.manual : sets.all;
}

/** isBotAccount plus the channel's own bot list. Never throws: a failed
 * lookup falls back to the built-in rules alone. */
export async function isChannelBot(broadcasterId: string, login: string, userId: string, botUserId: string): Promise<boolean> {
  if (isBotAccount(login, userId, botUserId)) return true;
  if (!broadcasterId || !login) return false;
  try {
    return (await loadSets(broadcasterId)).all.has(login.toLowerCase());
  } catch (e) {
    console.error("channel bot list lookup failed", e);
    return false;
  }
}

export async function listChannelBots(broadcasterId: string): Promise<ChannelBot[]> {
  const res = await sqlite.execute(
    "SELECT login, source, note, added_at FROM channel_bots WHERE broadcaster_id = ? ORDER BY added_at DESC LIMIT ?",
    [broadcasterId, MAX_ENTRIES],
  );
  return (res.rows as any[]).map((r) => ({ login: String(r.login), source: r.source === "botcheck" ? "botcheck" : "manual", note: String(r.note ?? ""), addedAt: Number(r.added_at) }));
}

/** Adds accounts; ones already listed are left as they are. Returns the logins actually added. */
export async function addChannelBots(broadcasterId: string, entries: Array<{ login: string; note?: string }>, source: BotSource): Promise<string[]> {
  const added: string[] = [];
  const existing = await sqlite.execute("SELECT COUNT(*) AS n FROM channel_bots WHERE broadcaster_id = ?", [broadcasterId]);
  let room = MAX_ENTRIES - Number((existing.rows as any[])[0]?.n ?? 0);
  for (const e of entries) {
    const login = e.login.trim().replace(/^@/, "").toLowerCase();
    if (!LOGIN_RE.test(login) || room <= 0) continue;
    const res = await sqlite.execute(
      "INSERT OR IGNORE INTO channel_bots (broadcaster_id, login, source, note, added_at) VALUES (?,?,?,?,?)",
      [broadcasterId, login, source, (e.note ?? "").slice(0, 200), Date.now()],
    );
    if (Number(res.rowsAffected) > 0) {
      added.push(login);
      room--;
    }
  }
  if (added.length) cache.delete(broadcasterId);
  return added;
}

/** Removes an account. One the bot viewer check added goes on its ignore list
 * too, so the next scan doesn't put it straight back. */
export async function removeChannelBot(broadcasterId: string, login: string): Promise<boolean> {
  const row = (await sqlite.execute("SELECT source FROM channel_bots WHERE broadcaster_id = ? AND login = ?", [broadcasterId, login])).rows[0] as any;
  if (!row) return false;
  await sqlite.execute("DELETE FROM channel_bots WHERE broadcaster_id = ? AND login = ?", [broadcasterId, login]);
  if (row.source === "botcheck") {
    // botcheck_ignored belongs to botdetect.ts (created by its ensure function).
    await sqlite.execute("INSERT OR REPLACE INTO botcheck_ignored (broadcaster_id, login, ignored_at) VALUES (?,?,?)", [broadcasterId, login, Date.now()]);
  }
  cache.delete(broadcasterId);
  return true;
}

/** Whether the bot viewer check adds likely bots to the list by itself (on unless switched off). */
export async function isBotCheckAutoAdd(broadcasterId: string): Promise<boolean> {
  const row = (await sqlite.execute("SELECT botcheck_auto FROM channel_bot_settings WHERE broadcaster_id = ?", [broadcasterId])).rows[0] as any;
  return !row || Number(row.botcheck_auto) === 1;
}

async function setBotCheckAutoAdd(broadcasterId: string, on: boolean) {
  await sqlite.execute(
    "INSERT INTO channel_bot_settings (broadcaster_id, botcheck_auto) VALUES (?,?) ON CONFLICT(broadcaster_id) DO UPDATE SET botcheck_auto = excluded.botcheck_auto",
    [broadcasterId, on ? 1 : 0],
  );
}

// ── Dashboard page (auth is done by the caller; see dashboard.ts) ──

/** Names typed into the box: separated by spaces, commas or new lines, "@" optional. */
function parseNames(raw: string): { ok: string[]; bad: string[] } {
  const ok: string[] = [], bad: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const login = part.trim().replace(/^@/, "").toLowerCase();
    if (!login) continue;
    (LOGIN_RE.test(login) ? ok : bad).push(login);
  }
  return { ok: [...new Set(ok)], bad };
}

export async function applyBotListForm(broadcasterId: string, form: FormData): Promise<{ ok: boolean; message: string } | null> {
  const intent = String(form.get("intent") ?? "");
  if (intent === "add") {
    const { ok, bad } = parseNames(String(form.get("names") ?? ""));
    if (!ok.length) return { ok: false, message: bad.length ? `"${bad[0]}" isn't a Twitch username (letters, numbers and _ only, up to 25).` : "Type at least one username." };
    const added = await addChannelBots(broadcasterId, ok.map((login) => ({ login })), "manual");
    const already = ok.length - added.length;
    let message = added.length ? `Added ${added.join(", ")} to the bot list.` : "Already on the list.";
    if (added.length && already) message += ` ${already} already listed.`;
    if (bad.length) message += ` Skipped ${bad.join(", ")} (not a valid username).`;
    return { ok: true, message };
  }
  if (intent === "remove") {
    const login = String(form.get("login") ?? "").toLowerCase();
    if (!LOGIN_RE.test(login)) return null;
    return (await removeChannelBot(broadcasterId, login))
      ? { ok: true, message: `${login} is off the bot list.` }
      : { ok: false, message: `${login} wasn't on the list.` };
  }
  if (intent === "auto_on" || intent === "auto_off") {
    await setBotCheckAutoAdd(broadcasterId, intent === "auto_on");
    return { ok: true, message: intent === "auto_on" ? "The bot viewer check will add likely bots to the list." : "The bot viewer check won't add anyone to the list by itself." };
  }
  return null;
}

export async function renderBotListPage(d: { broadcasterId: string; broadcasterName: string; key: string; notice?: string; error?: string }): Promise<string> {
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const btn = (intent: string, label: string, extra = "", cls = "ghost") =>
    `<form method="post" action="/dashboard/bots" class="inline">${hidden}<input type="hidden" name="intent" value="${intent}">${extra}<button type="submit" class="${cls}">${label}</button></form>`;
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);
  const [bots, auto] = await Promise.all([listChannelBots(d.broadcasterId), isBotCheckAutoAdd(d.broadcasterId)]);
  const fmtDate = (t: number) => new Date(t).toISOString().slice(0, 10);

  const rows = bots.map((b) =>
    `<tr><td><a class="who" href="https://twitch.tv/${encodeURIComponent(b.login)}" target="_blank" rel="noopener">${escapeHtml(b.login)}</a></td><td>${b.source === "botcheck" ? `<span class="badge learned">bot viewer check</span>` : `<span class="badge">typed in</span>`}</td><td class="small">${b.note ? escapeHtml(b.note) : `<span class="muted">—</span>`}</td><td class="num small">${fmtDate(b.addedAt)}</td><td class="num">${btn("remove", "Remove", `<input type="hidden" name="login" value="${escapeHtml(b.login)}">`)}</td></tr>`
  ).join("");
  const fromCheck = bots.filter((b) => b.source === "botcheck").length;
  const builtIn = [...new Set([...KNOWN_BOT_ACCOUNTS, ...MY_BOT_ACCOUNTS, ...(Deno.env.get("BOT_USERNAMES") ?? "").split(",")].map((x) => x.trim().toLowerCase()).filter(Boolean))];

  const body = `<header class="dash-top"><div><span class="pill">Moderation · Bot list</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>Accounts on this list are treated as <strong>bots</strong>: GuildScribe ignores their messages and commands, and leaves them out wherever it deals with real viewers — chat gold, watch time, <code>!oracle</code>, sub and raid thank-yous, channel-point hexes, <code>!botcheck</code> counts and The Endless Delve. Nobody is banned or blocked.</p>
<h2>Add bots</h2>
<form method="post" action="/dashboard/bots" class="add">${hidden}<input type="hidden" name="intent" value="add"><textarea name="names" rows="2" placeholder="Twitch usernames — one or several, separated by spaces, commas or new lines" required aria-label="Usernames to add"></textarea><button type="submit" class="ember">Add to bot list</button></form>
<h2>From the bot viewer check</h2>
<div class="controls">${auto ? btn("auto_off", "Turn off") : btn("auto_on", "Turn on", "", "ember")}<span>${auto ? `<strong>On</strong> — every scan adds the chatters it's fairly sure are bots (score ${BOTCHECK_AUTO_ADD_SCORE}+ out of 7).` : "<strong>Off</strong> — the check only adds an account when you press <em>Add to bot list</em> on its page."}</span></div>
<p class="muted small">Removing an account the check added also puts it on the check's ignore list, so it isn't added back. <a href="/dashboard/botcheck?${qs}">Open the bot viewer check →</a></p>
<h2>The bot list</h2>
<div class="stats"><div class="stat"><b>${bots.length}</b>on the list</div><div class="stat"><b>${bots.length - fromCheck}</b>typed in</div><div class="stat"><b>${fromCheck}</b>from the check</div></div>
${bots.length
    ? `<div class="table-wrap"><table><thead><tr><th>Account</th><th>Added by</th><th>Why</th><th class="num">Added</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="note">Nothing yet. Type a name above, or let the bot viewer check fill it in.</p>`}
<h2>Always treated as bots</h2>
<p class="muted">No need to add these: GuildScribe itself, <strong>any account whose name ends in "bot"</strong>, and ${builtIn.map((b) => `<code>${escapeHtml(b)}</code>`).join(", ")}.</p>`;

  return scrollDoc(`${name} — Bot list`, body, {
    width: 1000,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}form.inline{display:inline;margin:0}form.inline button{padding:5px 12px;font-size:.78rem}form.add{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}form.add textarea{flex:1 1 320px;padding:9px 12px;font:inherit;resize:vertical}.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.badge{white-space:nowrap}td{vertical-align:middle}`,
  });
}

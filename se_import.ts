// GuildScribe — /dashboard/import: bring a channel's StreamElements bot setup
// over by Twitch username (dashboard.ts handleImportPage/handleImportForm do
// the dashboard auth).
//
//   1. A mod types a Twitch username (defaults to this channel). Custom
//      commands come from StreamElements' public command list, so nothing
//      else is needed for those. Quotes and timers aren't public: for those
//      the mod also pastes the channel's StreamElements JWT token
//      (streamelements.com/dashboard/account/channels → "Show secrets").
//      The token is used for that one fetch and never stored.
//   2. GuildScribe fetches everything, translates StreamElements' ${…}
//      variables into GuildScribe placeholders, and parks the result in
//      se_import_staging for 30 minutes. The page shows it as a checklist:
//      anything that can't be carried over cleanly is flagged and unticked.
//   3. The mod ticks what they want and imports. Commands become custom
//      commands (cooldown and on/off carried over; aliases become their own
//      commands), quotes keep their numbers when free, timers become timed
//      messages.

import { sqlite } from "./sqlite.ts";
import { addCustomCommand, editCustomCommand, getBroadcaster, getCustomCommand, listTimedMessages, addTimedMessage, setCustomCommandCooldown, setCustomCommandEnabled } from "./db.ts";
import { MAX_COOLDOWN_SECONDS, MAX_CUSTOM_RESPONSE_LEN, RESERVED_NAMES, sanitizeCommandName } from "./customcommands.ts";
import { MAX_INTERVAL_MINUTES, MAX_TIMED_MESSAGE_LEN, MIN_INTERVAL_MINUTES } from "./timedmessages.ts";
import { addQuote, listQuotes, MAX_QUOTE_LEN } from "./quotes.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

const SE_API = "https://api.streamelements.com/kappa/v2";
const STAGE_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_QUOTE_PAGES = 100; // 100 per page → up to 10,000 quotes
// Words GuildScribe answers itself even though they aren't in RESERVED_NAMES
// (features that yield to a custom command of the same name). Importing one
// is allowed, but it takes the word over from the built-in feature.
const SHADOWS_FEATURE: Record<string, string> = {
  quote: "GuildScribe's quotes", quotes: "GuildScribe's quotes", addquote: "GuildScribe's quotes", delquote: "GuildScribe's quotes",
  sound: "Sound Bytes", sounds: "Sound Bytes",
};

export type StagedCommand = { name: string; response: string; cooldownSec: number; enabled: boolean; notes: string[]; ok: boolean; exists: boolean; aliasOf?: string };
export type StagedQuote = { no: number; text: string; game: string; createdAt: number; addedBy: string; duplicate: boolean };
export type StagedTimer = { name: string; message: string; intervalMinutes: number; enabled: boolean; notes: string[]; ok: boolean };
export type Staged = {
  username: string;
  displayName: string;
  commands: StagedCommand[];
  quotes: StagedQuote[];
  timers: StagedTimer[];
  quotesStatus: string; // "" when fetched, otherwise why not
  timersStatus: string;
};

export async function ensureSeImportTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS se_import_staging (
      id TEXT PRIMARY KEY, broadcaster_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    )`,
  );
}

export async function purgeSeImportData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM se_import_staging WHERE broadcaster_id = ?", [broadcasterId]);
}

// ── Translating StreamElements variables ────────────────────────────────────

const SIMPLE_VARS: Record<string, string> = {
  "user": "{user}", "user.name": "{user}", "user.display_name": "{user}", "sender": "{sender}", "source": "{user}",
  "touser": "{touser}", "channel": "{channel}", "channel.display_name": "{channel}", "game": "{game}", "title": "{title}",
  "uptime": "{uptime}", "count": "{count}", "1:": "{args}", "args": "{args}",
};

/** Turns a StreamElements reply into a GuildScribe response. `notes` lists
 * what didn't carry over; `ok` is false when the result would misbehave. */
export function translateSeReply(reply: string): { text: string; notes: string[]; ok: boolean } {
  const notes: string[] = [];
  let ok = true;
  // Innermost ${…} first, so ${random.pick ${user} 'x'} still parses.
  let out = reply;
  for (let i = 0; i < 10 && /\$\{[^{}]*\}/.test(out); i++) {
    out = out.replace(/\$\{([^{}]*)\}/g, (whole, inner: string) => {
      const v = inner.trim();
      if (SIMPLE_VARS[v.toLowerCase()]) return SIMPLE_VARS[v.toLowerCase()];
      let m = v.match(/^([1-9])(?:\s*\|.*)?$/);
      if (m) {
        if (v.includes("|")) notes.push(`\${${v}}'s fallback isn't carried over`);
        return `{${m[1]}}`;
      }
      m = v.match(/^random\.(-?\d+)-(-?\d+)$/i);
      if (m) return `{randnum:${m[1]}-${m[2]}}`;
      m = v.match(/^random\.pick\s+(.+)$/i);
      if (m) {
        const options = [...m[1].matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((x) => x[1] ?? x[2] ?? x[3]).filter((x) => x !== undefined);
        if (options.length) return `{random:${options.join("|")}}`;
      }
      if (/^time(\s|$)/i.test(v)) {
        notes.push("time is shown in UTC");
        return "{time}";
      }
      notes.push(`\${${v.length > 30 ? v.slice(0, 30) + "…" : v}} has no GuildScribe equivalent`);
      ok = false;
      return whole.replace(/\$\{/g, "\u0000"); // parked so the loop moves on; restored below
    });
  }
  out = out.replace(/\u0000/g, "${");
  if (ok && out.includes("${")) {
    notes.push("has nested StreamElements variables that didn't carry over");
    ok = false;
  }
  if (out.length > MAX_CUSTOM_RESPONSE_LEN) {
    notes.push(`cut to ${MAX_CUSTOM_RESPONSE_LEN} characters`);
    out = out.slice(0, MAX_CUSTOM_RESPONSE_LEN);
  }
  return { text: out.trim(), notes: [...new Set(notes)], ok };
}

// ── Fetching ────────────────────────────────────────────────────────────────

async function seGet(path: string, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${SE_API}${path}`, {
    headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let body: any = null;
  try { body = await res.json(); } catch (_) { /* non-JSON error page */ }
  return { status: res.status, body };
}

const ACCESS_LABELS: Record<number, string> = { 250: "subscribers", 300: "regulars", 400: "VIPs", 500: "mods", 1000: "the broadcaster" };

/** Fetches and translates a channel's StreamElements setup into a staged
 * import for `broadcasterId`; returns its id, or an error for the page. */
export async function stageSeImport(broadcasterId: string, rawUsername: string, rawToken: string): Promise<{ id: string } | { error: string }> {
  const username = rawUsername.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(username)) return { error: "Enter a Twitch username, like stonedsheamus." };
  const token = rawToken.trim().replace(/^(bearer|jwt)\s+/i, "");
  if (token && !/^[A-Za-z0-9_\-.]{20,4000}$/.test(token)) return { error: "That doesn't look like a StreamElements JWT token — copy the whole “JWT Token” value." };

  let channel: { status: number; body: any };
  try {
    channel = await seGet(`/channels/${encodeURIComponent(username)}`);
  } catch (e) {
    return { error: `Couldn't reach StreamElements (${String(e).slice(0, 80)}). Try again in a minute.` };
  }
  if (channel.status === 404 || !channel.body?._id) return { error: `StreamElements has no channel for “${username}”.` };
  if (channel.status !== 200) return { error: `StreamElements answered ${channel.status}. Try again in a minute.` };
  const seId = String(channel.body._id);
  const displayName = String(channel.body.displayName || channel.body.username || username);

  // Commands: every command (hidden ones too) with the token, else the public list.
  let cmdRes = token ? await seGet(`/bot/commands/${seId}`, token).catch(() => null) : null;
  let tokenRejected = false;
  if (cmdRes && cmdRes.status !== 200) {
    tokenRejected = cmdRes.status === 401 || cmdRes.status === 403;
    cmdRes = null;
  }
  cmdRes ??= await seGet(`/bot/commands/${seId}/public`).catch(() => null);
  const rawCommands: any[] = Array.isArray(cmdRes?.body) ? cmdRes!.body : [];

  const commands: StagedCommand[] = [];
  const seen = new Set<string>();
  for (const c of rawCommands) {
    const reply = String(c.reply ?? "");
    const t = translateSeReply(reply);
    if (String(c.type ?? "say") === "reply") t.text = `@{user} ${t.text}`;
    if (String(c.type ?? "say") === "whisper") t.notes.push("was a whisper in StreamElements; posts in chat here");
    const access = Number(c.accessLevel ?? 100);
    if (access > 100) {
      t.notes.push(`only ${ACCESS_LABELS[access] ?? `access level ${access}`} could use it in StreamElements; anyone can here`);
      if (access >= 500) t.ok = false;
    }
    if (c.enabled === false) t.notes.push("off in StreamElements; imports switched off");
    if (c.regex) t.notes.push("its regex trigger isn't carried over");
    if (Number(c.cost ?? 0) > 0) t.notes.push(`cost ${c.cost} points in StreamElements; free here`);
    const cooldownSec = Math.min(MAX_COOLDOWN_SECONDS, Math.max(0, Number(c.cooldown?.global ?? 5)));
    const names = [String(c.command ?? ""), ...(Array.isArray(c.aliases) ? c.aliases.map(String) : [])];
    for (const [i, raw] of names.entries()) {
      const notes = [...t.notes];
      let ok = t.ok && !!t.text;
      const name = sanitizeCommandName(raw);
      if (!name) {
        notes.push(`“!${raw.slice(0, 30)}” isn't a valid command name here (2–25 letters, numbers, - or _)`);
        ok = false;
      } else if (RESERVED_NAMES.has(name)) {
        notes.push(`!${name} is a built-in GuildScribe command`);
        ok = false;
      } else if (SHADOWS_FEATURE[name]) {
        notes.push(`replaces ${SHADOWS_FEATURE[name]} for !${name}`);
        ok = false;
      }
      const key = name ?? raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const exists = !!name && !!(await getCustomCommand(broadcasterId, name));
      if (exists) notes.push("already exists here — importing overwrites it");
      commands.push({
        name: name ?? raw.slice(0, 30), response: t.text, cooldownSec, enabled: c.enabled !== false,
        notes, ok: ok && !exists && c.enabled !== false, exists, aliasOf: i > 0 ? String(c.command) : undefined,
      });
    }
  }

  // Quotes and timers need the token.
  const quotes: StagedQuote[] = [];
  const timers: StagedTimer[] = [];
  let quotesStatus = "";
  let timersStatus = "";
  const noToken = "Needs the StreamElements JWT token.";
  if (!token) {
    quotesStatus = timersStatus = noToken;
  } else if (tokenRejected) {
    quotesStatus = timersStatus = `StreamElements rejected the token — it must be ${displayName}'s own JWT token.`;
  } else {
    const existing = new Set((await listQuotes(broadcasterId)).map((q) => q.text.toLowerCase()));
    try {
      for (let page = 0, total = Infinity; page < MAX_QUOTE_PAGES && page * 100 < total; page++) {
        const r = await seGet(`/bot/quotes/${seId}?limit=100&offset=${page * 100}`, token);
        if (r.status !== 200) {
          quotesStatus = r.status === 401 || r.status === 403 ? `StreamElements rejected the token — it must be ${displayName}'s own JWT token.` : `StreamElements answered ${r.status}.`;
          break;
        }
        const list: any[] = Array.isArray(r.body) ? r.body : Array.isArray(r.body?.quotes) ? r.body.quotes : [];
        total = Number(r.body?.total ?? list.length);
        if (!list.length) break;
        for (const q of list) {
          const text = String(q.text ?? q.message ?? "").trim().slice(0, MAX_QUOTE_LEN);
          if (!text) continue;
          const created = Date.parse(String(q.createdAt ?? ""));
          quotes.push({
            no: Number(q.id ?? q.quoteId ?? 0) || 0,
            text,
            game: String(q.game ?? q.category ?? "").slice(0, 80),
            createdAt: Number.isFinite(created) ? created : 0,
            addedBy: String(q.user?.username ?? q.username ?? q.creator ?? "").slice(0, 40),
            duplicate: existing.has(text.toLowerCase()),
          });
        }
        if (!Array.isArray(r.body?.quotes)) break; // an un-paged list came back whole
      }
    } catch (e) {
      quotesStatus = `Couldn't fetch quotes (${String(e).slice(0, 80)}).`;
    }
    quotes.sort((a, b) => a.no - b.no);

    try {
      const r = await seGet(`/bot/timers/${seId}`, token);
      if (r.status !== 200) {
        timersStatus = r.status === 401 || r.status === 403 ? `StreamElements rejected the token — it must be ${displayName}'s own JWT token.` : `StreamElements answered ${r.status}.`;
      } else {
        const existing = new Set((await listTimedMessages(broadcasterId)).map((m: any) => String(m.message ?? "").toLowerCase()));
        for (const t of Array.isArray(r.body) ? r.body : []) {
          const messages: string[] = (Array.isArray(t.messages) ? t.messages : []).map(String).filter((m: string) => m.trim());
          const every = Number(t.online?.interval ?? t.interval ?? 15) || 15;
          // A StreamElements timer rotates its messages, one per interval; here
          // each message is its own timed message, so each one comes round
          // once per full rotation.
          const interval = Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, every * messages.length));
          for (const m of messages) {
            const tr = translateSeReply(m);
            const notes = tr.notes.filter((n) => !n.startsWith("cut to"));
            // Timed messages only know {count}; anything else would post literally.
            if (/\{(?!count\})[^}]*\}/.test(tr.text)) {
              notes.push("timed messages can't fill in chat variables");
              tr.ok = false;
            }
            let message = tr.text.slice(0, MAX_TIMED_MESSAGE_LEN);
            if (tr.text.length > MAX_TIMED_MESSAGE_LEN) notes.push(`cut to ${MAX_TIMED_MESSAGE_LEN} characters`);
            if (existing.has(message.toLowerCase())) {
              notes.push("already a timed message here");
              tr.ok = false;
            }
            if (messages.length > 1) notes.push(`1 of ${messages.length} rotating messages every ${every} min → each every ${interval} min`);
            else if (interval !== every) notes.push(`every ${every} min in StreamElements`);
            if (t.enabled === false) notes.push("off in StreamElements");
            message ||= "";
            timers.push({ name: String(t.name ?? ""), message, intervalMinutes: interval, enabled: t.enabled !== false, notes, ok: tr.ok && !!message && t.enabled !== false });
          }
        }
      }
    } catch (e) {
      timersStatus = `Couldn't fetch timers (${String(e).slice(0, 80)}).`;
    }
  }

  const staged: Staged = { username, displayName, commands, quotes, timers, quotesStatus, timersStatus };
  const id = crypto.randomUUID();
  const now = Date.now();
  await sqlite.execute("DELETE FROM se_import_staging WHERE created_at < ? OR broadcaster_id = ?", [now - STAGE_TTL_MS, broadcasterId]);
  await sqlite.execute("INSERT INTO se_import_staging (id, broadcaster_id, payload, created_at) VALUES (?,?,?,?)", [id, broadcasterId, JSON.stringify(staged), now]);
  return { id };
}

async function loadStage(broadcasterId: string, id: string): Promise<Staged | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const res = await sqlite.execute(
    "SELECT payload FROM se_import_staging WHERE id = ? AND broadcaster_id = ? AND created_at >= ?",
    [id, broadcasterId, Date.now() - STAGE_TTL_MS],
  );
  if (!res.rows.length) return null;
  try { return JSON.parse(String(res.rows[0].payload)); } catch (_) { return null; }
}

// ── Applying ────────────────────────────────────────────────────────────────

type Result = { ok: boolean; message: string; stage?: string };

/** POST /dashboard/import. intent=fetch stages a preview; intent=import
 * applies the ticked rows of one. */
export async function applyImportForm(broadcasterId: string, form: FormData): Promise<Result> {
  const intent = String(form.get("intent") ?? "");
  if (intent === "fetch") {
    const r = await stageSeImport(broadcasterId, String(form.get("username") ?? ""), String(form.get("token") ?? ""));
    return "error" in r ? { ok: false, message: r.error } : { ok: true, message: "", stage: r.id };
  }
  if (intent !== "import") return { ok: false, message: "Unknown action." };
  const stageId = String(form.get("stage") ?? "");
  const staged = await loadStage(broadcasterId, stageId);
  if (!staged) return { ok: false, message: "That preview expired (they last 30 minutes) — fetch it again." };
  const picked = (field: string) => new Set(form.getAll(field).map((v) => Number(v)).filter(Number.isInteger));
  const cmdPicks = picked("cmd"), quotePicks = picked("quote"), timerPicks = picked("timer");

  const done = { commands: 0, quotes: 0, timers: 0 };
  const problems: string[] = [];
  for (const [i, c] of staged.commands.entries()) {
    if (!cmdPicks.has(i)) continue;
    const name = sanitizeCommandName(c.name);
    if (!name || RESERVED_NAMES.has(name) || !c.response) continue;
    if (await getCustomCommand(broadcasterId, name)) {
      await editCustomCommand(broadcasterId, name, c.response);
    } else {
      const r = await addCustomCommand(broadcasterId, name, c.response, `streamelements:${staged.username}`);
      if (!r.ok) {
        if (r.error === "cap") { problems.push(`custom command limit (${r.max}) reached`); break; }
        continue;
      }
    }
    await setCustomCommandCooldown(broadcasterId, name, c.cooldownSec * 1000);
    await setCustomCommandEnabled(broadcasterId, name, c.enabled);
    done.commands++;
  }
  for (const [i, q] of staged.quotes.entries()) {
    if (!quotePicks.has(i)) continue;
    const r = await addQuote(broadcasterId, { text: q.text, game: q.game, addedBy: q.addedBy, createdAt: q.createdAt || undefined, source: "streamelements", preferNo: q.no });
    if (!r.ok) {
      if (r.error === "cap") { problems.push("the quote book is full"); break; }
      continue;
    }
    done.quotes++;
  }
  for (const [i, t] of staged.timers.entries()) {
    if (!timerPicks.has(i) || !t.message) continue;
    const r = await addTimedMessage(broadcasterId, t.message, t.intervalMinutes, `streamelements:${staged.username}`);
    if (!r.ok) { problems.push(`timed message limit (${r.max}) reached`); break; }
    done.timers++;
  }
  await sqlite.execute("DELETE FROM se_import_staging WHERE id = ?", [stageId]);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const summary = `Imported ${plural(done.commands, "command")}, ${plural(done.quotes, "quote")} and ${plural(done.timers, "timed message")} from ${staged.displayName}.`;
  return { ok: problems.length === 0, message: problems.length ? `${summary} Stopped early: ${problems.join("; ")}.` : summary };
}

// ── The page ────────────────────────────────────────────────────────────────

const CSS = `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}
.fetchform{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px 16px;margin:12px 0}.fetchform label{display:flex;flex-direction:column;gap:4px}.fetchform .row{grid-column:1/-1}
td{vertical-align:top}td.pick{width:34px}td.pick input{width:18px;height:18px}td.resp{word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:.84rem}.warn{color:#8a3b12}tr.skip td{opacity:.6}
.sect-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.sect-head button{padding:5px 12px;font-size:.78rem}.sticky{position:sticky;bottom:0;background:var(--paper,#efe6cc);padding:12px 0;border-top:1px solid var(--rule);margin-top:20px}`;

export async function renderImportPage(d: {
  broadcasterId: string;
  broadcasterName: string;
  key: string;
  stage?: string;
  notice?: string;
  error?: string;
}): Promise<string> {
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);
  const b = await getBroadcaster(d.broadcasterId);
  const staged = d.stage ? await loadStage(d.broadcasterId, d.stage) : null;
  const defaultUser = staged?.username ?? String(b?.login ?? "");

  const fetchForm = `<form method="post" action="/dashboard/import" class="fetchform">${hidden}<input type="hidden" name="intent" value="fetch">
<label>Twitch username on StreamElements<input type="text" name="username" value="${escapeHtml(defaultUser)}" required maxlength="25" autocomplete="off" placeholder="stonedsheamus"></label>
<label>StreamElements JWT token <span class="muted small">(optional — only for quotes and timers)</span><input type="password" name="token" autocomplete="off" placeholder="Paste to include quotes and timers"></label>
<div class="row"><button type="submit" class="ember">Fetch from StreamElements</button> <span class="muted small">Nothing is imported until you pick what to keep on the next step.</span></div></form>
<details class="card"><summary><strong>Where's the JWT token?</strong></summary><p>Log in at <a href="https://streamelements.com/dashboard/account/channels" target="_blank" rel="noopener">streamelements.com → Account → Channels</a> as the channel owner, click <em>Show secrets</em>, and copy <em>JWT Token</em>. GuildScribe sends it to StreamElements once to read the quotes and timers and doesn't keep it. It's a password for your StreamElements account — paste it only here, and you can reset it on that same page afterwards if you like. Custom commands are public, so they import without it — including from another channel's username.</p></details>`;

  let preview = "";
  if (d.stage && !staged) {
    preview = `<p class="banner error">That preview expired (they last 30 minutes) — fetch it again.</p>`;
  } else if (staged) {
    const notes = (n: string[]) => (n.length ? `<div class="small warn">${n.map(escapeHtml).join(" · ")}</div>` : "");
    const box = (field: string, i: number, on: boolean) => `<td class="pick"><input type="checkbox" name="${field}" value="${i}"${on ? " checked" : ""} aria-label="Import"></td>`;
    const section = (field: string, title: string, count: number, inner: string, status: string) =>
      `<div class="sect-head"><h2>${title} <span class="muted small">(${count})</span></h2>${count ? `<span><button type="button" class="ghost" data-all="${field}">Tick all</button> <button type="button" class="ghost" data-none="${field}">Untick all</button></span>` : ""}</div>` +
      (status ? `<p class="note">${escapeHtml(status)}</p>` : count ? inner : `<p class="note">None found.</p>`);

    const cmdRows = staged.commands.map((c, i) =>
      `<tr${c.ok ? "" : ` class="skip"`}>${box("cmd", i, c.ok)}<td><strong>!${escapeHtml(c.name)}</strong>${c.aliasOf ? `<div class="muted small">alias of !${escapeHtml(c.aliasOf)}</div>` : ""}<div class="muted small">${c.cooldownSec}s cooldown${c.enabled ? "" : " · off"}</div></td><td class="resp">${escapeHtml(c.response)}${notes(c.notes)}</td></tr>`
    ).join("");
    const quoteRows = staged.quotes.map((q, i) =>
      `<tr${q.duplicate ? ` class="skip"` : ""}>${box("quote", i, !q.duplicate)}<td class="num">#${q.no || "?"}</td><td>${escapeHtml(q.text)}${q.duplicate ? `<div class="small warn">already in the quote book</div>` : ""}</td><td class="small">${escapeHtml([q.game, q.createdAt ? new Date(q.createdAt).toISOString().slice(0, 10) : ""].filter(Boolean).join(" · "))}</td></tr>`
    ).join("");
    const timerRows = staged.timers.map((t, i) =>
      `<tr${t.ok ? "" : ` class="skip"`}>${box("timer", i, t.ok)}<td>${escapeHtml(t.name)}<div class="muted small">every ${t.intervalMinutes} min</div></td><td class="resp">${escapeHtml(t.message)}${notes(t.notes)}</td></tr>`
    ).join("");
    const table = (head: string, rows: string) => `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;

    preview = `<h2 style="margin-bottom:0">From ${escapeHtml(staged.displayName)}'s StreamElements</h2>
<p class="muted">Ticked rows import. Unticked ones are flagged — read the note in orange, and tick it anyway if that's fine. Variables like <code>\${user}</code> were changed to GuildScribe's <code>{user}</code>.</p>
<form method="post" action="/dashboard/import">${hidden}<input type="hidden" name="intent" value="import"><input type="hidden" name="stage" value="${escapeHtml(d.stage!)}">
${section("cmd", "Commands", staged.commands.length, table(`<th></th><th>Command</th><th>Response</th>`, cmdRows), "")}
${section("quote", "Quotes", staged.quotes.length, table(`<th></th><th class="num">#</th><th>Quote</th><th>Game · date</th>`, quoteRows), staged.quotesStatus)}
${staged.quotes.length ? `<p class="muted small">Quotes keep their StreamElements number when it's free here; otherwise they're added at the end.</p>` : ""}
${section("timer", "Timers → timed messages", staged.timers.length, table(`<th></th><th>Timer</th><th>Message</th>`, timerRows), staged.timersStatus)}
<div class="sticky"><button type="submit" class="ember">Import ticked items</button> <a class="btn ghost" href="/dashboard/import?${qs}">Cancel</a></div></form>
<script>document.addEventListener("click",function(e){var t=e.target,f=t.getAttribute&&(t.getAttribute("data-all")||t.getAttribute("data-none"));if(!f)return;var on=!!t.getAttribute("data-all");[].forEach.call(document.querySelectorAll('input[name="'+f+'"]'),function(c){c.checked=on})});</script>`;
  }

  const body = `<header class="dash-top"><div><span class="pill">Import from StreamElements</span><h1>${name}</h1></div><span><a class="btn ghost" href="/dashboard/quotes?${qs}">📜 Quotes</a> <a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></span></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>Moving over from the StreamElements chatbot? Bring its <strong>custom commands</strong>, <strong>quotes</strong> and <strong>timers</strong> across by Twitch username. You'll see everything first and pick what to keep.</p>
${staged ? "" : fetchForm}
${preview}`;
  return scrollDoc(`${name} — Import`, body, { width: 1100, css: CSS });
}

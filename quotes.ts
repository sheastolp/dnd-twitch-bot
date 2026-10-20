// GuildScribe — Quotes: the channel's book of memorable lines, numbered like
// StreamElements/Nightbot quotes so imported ones keep their numbers.
//
//   !quote                       anyone: a random quote
//   !quote <number>              anyone: that quote
//   !quote <words>               anyone: a random quote containing the words
//   !quotes                      anyone: how many there are + the public list link
//   !quote add <text>            mod: add one (the current game and date are saved with it)
//   !addquote <text>             mod: same
//   !quote edit <number> <text>  mod: reword one
//   !quote remove <number>       mod: delete one (also !delquote <number>); numbers aren't reused
//   GET /quotes?channel=<id>     public list (read-only)
//   GET /dashboard/quotes        mod page: add, edit, delete, search (dashboard.ts does the auth)
//
// Dashboard switch "quotes" (off by default). Like Sound Bytes, the words are
// checked here rather than listed in COMMAND_GROUPS, so a channel's own
// !quote custom command (or an imported one) keeps working instead.

import { sqlite } from "./sqlite.ts";
import { getChannelInfo, sendChatMessage } from "./twitch.ts";
import { getCustomCommand, isCommandGroupEnabled, setCommandGroupEnabled } from "./db.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

export const MAX_QUOTE_LEN = 400;
const MAX_QUOTES_PER_CHANNEL = Math.max(1, Number(Deno.env.get("MAX_QUOTES_PER_CHANNEL") ?? "5000"));
// Viewers share one short channel-wide cooldown on reading quotes; mods skip it.
const QUOTE_COOLDOWN_MS = 5_000;
const lastQuoteAt = new Map<string, number>();

export type Quote = { no: number; text: string; game: string; addedBy: string; createdAt: number; source: string };

export async function ensureQuoteTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS quotes (
      broadcaster_id TEXT NOT NULL,
      quote_no INTEGER NOT NULL,
      text TEXT NOT NULL,
      game TEXT NOT NULL DEFAULT '',
      added_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'chat',
      PRIMARY KEY (broadcaster_id, quote_no)
    )`,
  );
}

export async function purgeQuoteData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM quotes WHERE broadcaster_id = ?", [broadcasterId]);
}

const toQuote = (r: any): Quote => ({
  no: Number(r.quote_no),
  text: String(r.text ?? ""),
  game: String(r.game ?? ""),
  addedBy: String(r.added_by ?? ""),
  createdAt: Number(r.created_at ?? 0),
  source: String(r.source ?? ""),
});

export async function listQuotes(broadcasterId: string): Promise<Quote[]> {
  const res = await sqlite.execute("SELECT * FROM quotes WHERE broadcaster_id = ? ORDER BY quote_no ASC", [broadcasterId]);
  return res.rows.map(toQuote);
}

export async function countQuotes(broadcasterId: string): Promise<number> {
  const res = await sqlite.execute("SELECT COUNT(*) AS n FROM quotes WHERE broadcaster_id = ?", [broadcasterId]);
  return Number(res.rows[0]?.n ?? 0);
}

export async function getQuote(broadcasterId: string, no: number): Promise<Quote | null> {
  const res = await sqlite.execute("SELECT * FROM quotes WHERE broadcaster_id = ? AND quote_no = ?", [broadcasterId, no]);
  return res.rows.length ? toQuote(res.rows[0]) : null;
}

async function randomQuote(broadcasterId: string, search?: string): Promise<Quote | null> {
  const like = search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const res = await sqlite.execute(
    `SELECT * FROM quotes WHERE broadcaster_id = ?${like ? " AND (text LIKE ? ESCAPE '\\' OR game LIKE ? ESCAPE '\\')" : ""} ORDER BY RANDOM() LIMIT 1`,
    like ? [broadcasterId, like, like] : [broadcasterId],
  );
  return res.rows.length ? toQuote(res.rows[0]) : null;
}

/** Adds a quote and returns its number. With `preferNo` (an import keeping
 * its StreamElements number) that number is used when free; otherwise the
 * next one after the highest — numbers of deleted quotes aren't reused. */
export async function addQuote(
  broadcasterId: string,
  q: { text: string; game?: string; addedBy?: string; createdAt?: number; source?: string; preferNo?: number },
): Promise<{ ok: true; no: number } | { ok: false; error: "cap" | "empty" }> {
  const text = q.text.trim().replace(/\s+/g, " ").slice(0, MAX_QUOTE_LEN);
  if (!text) return { ok: false, error: "empty" };
  if ((await countQuotes(broadcasterId)) >= MAX_QUOTES_PER_CHANNEL) return { ok: false, error: "cap" };
  const values = [text, q.game ?? "", q.addedBy ?? "", q.createdAt ?? Date.now(), q.source ?? "chat"];
  if (q.preferNo && Number.isInteger(q.preferNo) && q.preferNo > 0) {
    const res = await sqlite.execute(
      "INSERT OR IGNORE INTO quotes (broadcaster_id, quote_no, text, game, added_by, created_at, source) VALUES (?,?,?,?,?,?,?)",
      [broadcasterId, q.preferNo, ...values],
    );
    if (Number(res.rowsAffected ?? 0) > 0) return { ok: true, no: q.preferNo };
  }
  // One statement picks the number and inserts, so two adds at once can't collide.
  await sqlite.execute(
    `INSERT INTO quotes (broadcaster_id, quote_no, text, game, added_by, created_at, source)
     SELECT ?, COALESCE(MAX(quote_no), 0) + 1, ?, ?, ?, ?, ? FROM quotes WHERE broadcaster_id = ?`,
    [broadcasterId, ...values, broadcasterId],
  );
  const res = await sqlite.execute("SELECT MAX(quote_no) AS n FROM quotes WHERE broadcaster_id = ?", [broadcasterId]);
  return { ok: true, no: Number(res.rows[0]?.n ?? 0) };
}

export async function editQuote(broadcasterId: string, no: number, text: string, game?: string): Promise<boolean> {
  const clean = text.trim().replace(/\s+/g, " ").slice(0, MAX_QUOTE_LEN);
  if (!clean) return false;
  const res = game === undefined
    ? await sqlite.execute("UPDATE quotes SET text = ? WHERE broadcaster_id = ? AND quote_no = ?", [clean, broadcasterId, no])
    : await sqlite.execute("UPDATE quotes SET text = ?, game = ? WHERE broadcaster_id = ? AND quote_no = ?", [clean, game.trim().slice(0, 80), broadcasterId, no]);
  return Number(res.rowsAffected ?? 0) > 0;
}

export async function deleteQuote(broadcasterId: string, no: number): Promise<boolean> {
  const res = await sqlite.execute("DELETE FROM quotes WHERE broadcaster_id = ? AND quote_no = ?", [broadcasterId, no]);
  return Number(res.rowsAffected ?? 0) > 0;
}

const fmtDate = (t: number) => (t ? new Date(t).toISOString().slice(0, 10) : "");

/** How a quote reads in chat: #12: "text" [Game · 2026-10-15] */
export function formatQuote(q: Quote): string {
  const meta = [q.game, fmtDate(q.createdAt)].filter(Boolean).join(" · ");
  return `#${q.no}: ${q.text}${meta ? ` [${meta}]` : ""}`;
}

export async function handleQuoteCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
  baseUrl: string,
): Promise<boolean> {
  const match = chatMessage.trim().match(/^!(quotes?|addquote|delquote)(?:\s+([\s\S]*))?$/i);
  if (!match) return false;
  const word = match[1].toLowerCase();
  // Switched off, or the channel has its own command by that name: fall through to it.
  const [on, custom] = await Promise.all([isCommandGroupEnabled(broadcasterId, "quotes"), getCustomCommand(broadcasterId, word)]);
  if (!on || custom) return false;
  let arg = (match[2] ?? "").trim();
  const say = (text: string) => sendChatMessage(`@${display} ${text}`, broadcasterId);

  if (word === "quotes" && !arg) {
    const n = await countQuotes(broadcasterId);
    await say(`📜 ${n ? `${n} quote${n === 1 ? "" : "s"} in the book` : "The quote book is empty"}. All of them: ${baseUrl}/quotes?channel=${broadcasterId}`);
    return true;
  }

  let sub = "";
  if (word === "addquote") sub = "add";
  else if (word === "delquote") sub = "remove";
  else {
    const m = arg.match(/^(add|new|edit|remove|delete|del|count|list)\b\s*([\s\S]*)$/i);
    if (m) {
      sub = m[1].toLowerCase();
      arg = m[2].trim();
    }
  }

  if (sub === "count" || sub === "list") {
    const n = await countQuotes(broadcasterId);
    await say(`📜 ${n} quote${n === 1 ? "" : "s"} in the book. All of them: ${baseUrl}/quotes?channel=${broadcasterId}`);
    return true;
  }

  if (sub === "add" || sub === "new") {
    if (!isModerator) return await say("only the broadcaster or a mod can add quotes."), true;
    if (!arg) return await say("usage: !quote add <text>"), true;
    const info = await getChannelInfo(broadcasterId);
    const result = await addQuote(broadcasterId, { text: arg, game: info?.gameName ?? "", addedBy: display });
    if (!result.ok) return await say(result.error === "cap" ? `the quote book is full (${MAX_QUOTES_PER_CHANNEL}).` : "usage: !quote add <text>"), true;
    await say(`📜 Quote #${result.no} added.`);
    return true;
  }

  if (sub === "edit") {
    if (!isModerator) return await say("only the broadcaster or a mod can edit quotes."), true;
    const m = arg.match(/^#?(\d+)\s+([\s\S]+)$/);
    if (!m) return await say("usage: !quote edit <number> <new text>"), true;
    const ok = await editQuote(broadcasterId, Number(m[1]), m[2]);
    await say(ok ? `📜 Quote #${m[1]} updated.` : `there's no quote #${m[1]}.`);
    return true;
  }

  if (sub === "remove" || sub === "delete" || sub === "del") {
    if (!isModerator) return await say("only the broadcaster or a mod can remove quotes."), true;
    const m = arg.match(/^#?(\d+)$/);
    if (!m) return await say("usage: !quote remove <number>"), true;
    const ok = await deleteQuote(broadcasterId, Number(m[1]));
    await say(ok ? `📜 Quote #${m[1]} removed.` : `there's no quote #${m[1]}.`);
    return true;
  }

  // Reading a quote: channel-wide cooldown for viewers.
  if (!isModerator) {
    const now = Date.now();
    if (now - (lastQuoteAt.get(broadcasterId) ?? 0) < QUOTE_COOLDOWN_MS) return true;
    lastQuoteAt.set(broadcasterId, now);
  }
  const numbered = arg.match(/^#?(\d+)$/);
  const q = numbered ? await getQuote(broadcasterId, Number(numbered[1])) : await randomQuote(broadcasterId, arg || undefined);
  if (!q) {
    await say(numbered ? `there's no quote #${numbered[1]}.` : arg ? `no quote mentions "${arg.slice(0, 40)}".` : "the quote book is empty. Mods: !quote add <text>");
    return true;
  }
  await sendChatMessage(`📜 ${formatQuote(q)}`, broadcasterId);
  return true;
}

// ── Pages ───────────────────────────────────────────────────────────────────

const PAGE_CSS = `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}form.inline{display:inline;margin:0}form.inline button{padding:5px 12px;font-size:.78rem}td{vertical-align:middle}td.actions{white-space:nowrap}.qform{display:grid;grid-template-columns:1fr 200px auto;gap:10px;align-items:end;margin:12px 0}.qform label{display:flex;flex-direction:column;gap:4px}.qrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.qrow input[name=text]{flex:1 1 320px}.qrow input[name=game]{flex:0 1 160px}@media(max-width:640px){.qform{grid-template-columns:1fr}}`;

const searchScript = `<script>(function(){var q=document.getElementById("q"),rows=[].slice.call(document.querySelectorAll("#t tbody tr"));if(!q)return;q.addEventListener("input",function(){var t=q.value.trim().toLowerCase();rows.forEach(function(r){r.hidden=!!t&&r.getAttribute("data-search").indexOf(t)===-1})})})();</script>`;

/** Public, read-only list: GET /quotes?channel=<id>. */
export async function renderPublicQuotesPage(broadcasterId: string, channelName: string): Promise<string> {
  const quotes = await listQuotes(broadcasterId);
  const name = escapeHtml(channelName);
  const rows = quotes.map((q) =>
    `<tr data-search="${escapeHtml(`#${q.no} ${q.text} ${q.game}`.toLowerCase())}"><td class="num">#${q.no}</td><td>${escapeHtml(q.text)}</td><td class="small">${escapeHtml(q.game) || `<span class="muted">—</span>`}</td><td class="num small">${fmtDate(q.createdAt)}</td></tr>`
  ).join("");
  const body = `<span class="pill">Quote book</span><h1>${name}</h1>
<p class="lede">Every quote saved in ${name}'s chat. In chat: <code>!quote</code> for a random one, <code>!quote 12</code> for a number, <code>!quote &lt;words&gt;</code> to search.</p>
${quotes.length
    ? `<div class="controls"><input id="q" class="search" type="search" placeholder="Search ${quotes.length} quotes…" autocomplete="off" aria-label="Search quotes"></div><div class="table-wrap"><table id="t"><thead><tr><th class="num">#</th><th>Quote</th><th>Game</th><th class="num">Date</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="note">No quotes yet.</p>`}
${searchScript}`;
  return scrollDoc(`${name} — Quotes`, body, { width: 1000, css: PAGE_CSS });
}

type Result = { ok: boolean; message: string } | null;

/** POST /dashboard/quotes (auth already done in dashboard.ts). */
export async function applyQuotesForm(broadcasterId: string, form: FormData, addedBy: string): Promise<Result> {
  const intent = String(form.get("intent") ?? "");
  const no = Number(String(form.get("no") ?? ""));
  const text = String(form.get("text") ?? "");
  const game = String(form.get("game") ?? "");
  if (intent === "module_on" || intent === "module_off") {
    await setCommandGroupEnabled(broadcasterId, "quotes", intent === "module_on");
    return { ok: true, message: `Quotes turned ${intent === "module_on" ? "on" : "off"}.` };
  }
  if (intent === "add") {
    const result = await addQuote(broadcasterId, { text, game: game.trim().slice(0, 80), addedBy, source: "dashboard" });
    if (!result.ok) return { ok: false, message: result.error === "cap" ? `The quote book is full (${MAX_QUOTES_PER_CHANNEL}).` : "Type the quote first." };
    return { ok: true, message: `Added quote #${result.no}.` };
  }
  if (!Number.isInteger(no) || no <= 0) return null;
  if (intent === "save") {
    return (await editQuote(broadcasterId, no, text, game))
      ? { ok: true, message: `Saved quote #${no}.` }
      : { ok: false, message: `Couldn't save #${no} — it's gone, or the text is empty.` };
  }
  if (intent === "delete") {
    return (await deleteQuote(broadcasterId, no)) ? { ok: true, message: `Removed quote #${no}.` } : { ok: false, message: `There's no quote #${no}.` };
  }
  return null;
}

export async function renderQuotesDashboardPage(d: {
  broadcasterId: string;
  broadcasterName: string;
  key: string;
  notice?: string;
  error?: string;
}): Promise<string> {
  const [quotes, on] = await Promise.all([listQuotes(d.broadcasterId), isCommandGroupEnabled(d.broadcasterId, "quotes")]);
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);
  const toggle = `<form method="post" action="/dashboard/quotes" class="inline">${hidden}<input type="hidden" name="intent" value="${on ? "module_off" : "module_on"}"><button type="submit" class="${on ? "ghost" : "ember"}">${on ? "Turn off" : "Turn on"}</button></form>`;
  const rows = quotes.slice().reverse().map((q) => {
    const id = `q${q.no}`;
    return `<tr data-search="${escapeHtml(`#${q.no} ${q.text} ${q.game} ${q.addedBy}`.toLowerCase())}"><td class="num">#${q.no}</td><td>
<form method="post" action="/dashboard/quotes" id="${id}" class="qrow">${hidden}<input type="hidden" name="no" value="${q.no}"><input type="text" name="text" value="${escapeHtml(q.text)}" maxlength="${MAX_QUOTE_LEN}" required aria-label="Quote #${q.no}"><input type="text" name="game" value="${escapeHtml(q.game)}" maxlength="80" placeholder="Game" aria-label="Game"></form>
<div class="muted small">${[q.addedBy && `added by ${escapeHtml(q.addedBy)}`, fmtDate(q.createdAt), q.source && q.source !== "chat" ? escapeHtml(q.source) : ""].filter(Boolean).join(" · ")}</div></td>
<td class="actions"><button type="submit" form="${id}" name="intent" value="save" class="ghost">Save</button> <button type="submit" form="${id}" name="intent" value="delete" class="ghost" onclick="return confirm('Delete quote #${q.no}?')">Delete</button></td></tr>`;
  }).join("");

  const body = `<header class="dash-top"><div><span class="pill">Quotes</span><h1>${name}</h1></div><span><a class="btn ghost" href="/dashboard/import?${qs}">⇪ Import from StreamElements / Nightbot</a> <a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></span></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<div class="controls">${toggle}<span>${on ? "<strong>On</strong> — <code>!quote</code> answers in chat." : "<strong>Off</strong> — <code>!quote</code> is silent (or runs your own custom command by that name)."}</span></div>
<p>Chat: <code>!quote</code> random · <code>!quote 12</code> · <code>!quote &lt;words&gt;</code> search · <code>!quotes</code> count + <a href="/quotes?channel=${encodeURIComponent(d.broadcasterId)}" target="_blank" rel="noopener">public list ↗</a>. Mods: <code>!quote add &lt;text&gt;</code> (saves the current game) · <code>!quote edit &lt;n&gt; &lt;text&gt;</code> · <code>!quote remove &lt;n&gt;</code>.</p>
<h2>Add a quote</h2>
<form method="post" action="/dashboard/quotes" class="qform">${hidden}<input type="hidden" name="intent" value="add"><label>Quote<input type="text" name="text" maxlength="${MAX_QUOTE_LEN}" required placeholder="&quot;I meant to do that.&quot; — the streamer, falling off a cliff"></label><label>Game <span class="muted small">(optional)</span><input type="text" name="game" maxlength="80"></label><button type="submit" class="ember">Add</button></form>
<h2>The book <span class="muted small">(${quotes.length})</span></h2>
${quotes.length
    ? `<div class="controls"><input id="q" class="search" type="search" placeholder="Search quotes…" autocomplete="off" aria-label="Search quotes"></div><div class="table-wrap"><table id="t"><thead><tr><th class="num">#</th><th>Quote</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="note">No quotes yet — add one above, in chat, or <a href="/dashboard/import?${qs}">import them from StreamElements</a>.</p>`}
${searchScript}`;
  return scrollDoc(`${name} — Quotes`, body, { width: 1100, css: PAGE_CSS });
}

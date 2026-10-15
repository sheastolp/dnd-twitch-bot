// GuildScribe — /dashboard/swearjar, the swear jar's word list (swearjar.ts),
// behind the dashboard key + Twitch mod login (dashboard.ts
// handleSwearJarPage/handleSwearJarForm do the auth). Shows the built-in
// words, the words the jar has learned in this channel and the ones it's still
// watching; mods can add a word, learn a candidate now, forget a word (never
// learn it again) or un-ignore it. Everything here is per channel.

import {
  BUILTIN_SWEARS,
  getJarTotal,
  isBuiltinSwear,
  listSwearWords,
  normalizeSwearWord,
  removeSwearWord,
  setSwearWordStatus,
} from "./swearjar.ts";
import { isPointsEnabled } from "./points_db.ts";
import { formatCoins } from "./coins.ts";
import { optNum } from "./channel_options.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

type Result = { ok: boolean; message: string } | null;

export async function applySwearJarForm(broadcasterId: string, form: FormData): Promise<Result> {
  const intent = String(form.get("intent") ?? "");
  const raw = String(form.get("word") ?? "");
  const word = normalizeSwearWord(raw);
  if (!intent) return null;
  if (!word) return { ok: false, message: raw.trim() ? `"${raw.trim().slice(0, 30)}" isn't a plain word (2–25 letters).` : "Type a word first." };
  if (isBuiltinSwear(word) && (intent === "add" || intent === "learn")) {
    return { ok: false, message: `"${word}" is already a built-in word — it's charged everywhere.` };
  }
  switch (intent) {
    case "add":
    case "learn":
      await setSwearWordStatus(broadcasterId, word, "learned");
      return { ok: true, message: `"${word}" now costs a fine in this channel.` };
    case "block":
      await setSwearWordStatus(broadcasterId, word, "blocked");
      return { ok: true, message: `Forgot "${word}" — the jar won't charge or learn it here.` };
    case "remove":
      return (await removeSwearWord(broadcasterId, word))
        ? { ok: true, message: `Removed "${word}" — the jar may learn it again from chat.` }
        : { ok: false, message: "That word isn't on the list." };
  }
  return null;
}

export async function renderSwearJarPage(d: {
  broadcasterId: string;
  broadcasterName: string;
  key: string;
  notice?: string;
  error?: string;
}): Promise<string> {
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const btn = (intent: string, label: string, word: string, cls = "ghost") =>
    `<form method="post" action="/dashboard/swearjar" class="inline">${hidden}<input type="hidden" name="intent" value="${intent}"><input type="hidden" name="word" value="${escapeHtml(word)}"><button type="submit" class="${cls}">${label}</button></form>`;
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);
  const [words, total, goldOn, cost] = await Promise.all([
    listSwearWords(d.broadcasterId),
    getJarTotal(d.broadcasterId),
    isPointsEnabled(d.broadcasterId),
    optNum(d.broadcasterId, "jar.cost"),
  ]);
  const learned = words.filter((w) => w.status === "learned");
  const candidates = words.filter((w) => w.status === "candidate").sort((a, b) => b.hits - a.hits || b.users - a.users);
  const blocked = words.filter((w) => w.status === "blocked");
  const fmtDate = (t: number) => (t ? new Date(t).toISOString().slice(0, 10) : "");
  const ratio = (w: { hits: number; total: number }) => (w.total ? `${Math.round((w.hits / w.total) * 100)}%` : "—");
  const evidence = (w: { hits: number; total: number; users: number }) =>
    w.total ? `${w.hits} of ${w.total} uses near swearing · ${w.users} chatter${w.users === 1 ? "" : "s"}` : `added by a mod`;

  const learnedRows = learned.map((w) =>
    `<tr data-search="${escapeHtml(w.word)}"><td><strong>${escapeHtml(w.word)}</strong></td><td class="small">${escapeHtml(evidence(w))}</td>` +
    `<td class="num small">${fmtDate(w.updatedAt)}</td><td class="num actions">${btn("block", "Forget", w.word)}</td></tr>`
  ).join("");
  const candidateRows = candidates.map((w) =>
    `<tr data-search="${escapeHtml(w.word)}"><td><strong>${escapeHtml(w.word)}</strong></td><td class="num">${w.hits}/${w.total}</td><td class="num">${ratio(w)}</td><td class="num">${w.users}</td>` +
    `<td class="num small">${fmtDate(w.updatedAt)}</td><td class="num actions">${btn("learn", "Learn now", w.word, "ember")} ${btn("block", "Ignore", w.word)}</td></tr>`
  ).join("");
  const blockedRows = blocked.map((w) =>
    `<tr data-search="${escapeHtml(w.word)}"><td><strong>${escapeHtml(w.word)}</strong></td><td class="num small">${fmtDate(w.updatedAt)}</td>` +
    `<td class="num actions">${btn("learn", "Charge it", w.word)} ${btn("remove", "Un-ignore", w.word)}</td></tr>`
  ).join("");
  const builtin = BUILTIN_SWEARS.bases.map((b) => `<span class="chip" data-search="${escapeHtml(b)}">${escapeHtml(b)}</span>`).join("");

  const body = `<header class="dash-top"><div><span class="pill">Swear jar · Words</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>Every swear word in plain chat costs the chatter <strong>${escapeHtml(formatCoins(cost))}</strong> into the swear jar (up to 5 per message). Built-in words are charged everywhere; on top of those, the jar <strong>learns</strong> words ${name}'s chat keeps using right next to swearing — at least 5 times, by 3 different chatters, with 60% or more of its uses near a swear. Everything on this page only affects ${name}.</p>
${goldOn ? "" : `<p class="banner error">Gold is off in this channel, so nobody is being fined right now — the jar is still learning words. Turn gold on from the dashboard or with <code>!gold on</code>.</p>`}
<div class="stats"><div class="stat"><b>${escapeHtml(formatCoins(total))}</b>in the jar</div><div class="stat"><b>${BUILTIN_SWEARS.bases.length}</b>built-in</div><div class="stat"><b>${learned.length}</b>learned</div><div class="stat"><b>${candidates.length}</b>watching</div><div class="stat"><b>${blocked.length}</b>ignored</div></div>
<h2>Add a word</h2>
<form method="post" action="/dashboard/swearjar" class="controls">${hidden}<input type="text" name="word" placeholder="e.g. frak" required maxlength="25" autocomplete="off" aria-label="Word to charge"><button type="submit" name="intent" value="add" class="ember">Charge this word</button><button type="submit" name="intent" value="block" class="ghost">Never charge it</button></form>
<p class="muted small">Whole words only. Plurals and stretched spellings (“fraaak”) are caught for built-in words; a word you add matches as typed, ignoring stretched letters.</p>
<div class="controls"><input id="q" class="search" type="search" placeholder="Search words…" autocomplete="off" aria-label="Search words"></div>
<h2>Learned words</h2>
${learned.length
    ? `<div class="table-wrap"><table class="filter"><thead><tr><th>Word</th><th>Evidence</th><th class="num">Learned</th><th></th></tr></thead><tbody>${learnedRows}</tbody></table></div>`
    : `<p class="note">None yet — the jar hasn't learned any words in this channel.</p>`}
<h2>Words being watched</h2>
${candidates.length
    ? `<p class="muted">Words chat has used next to swearing that aren't charged yet. Unused ones are dropped after 14 days.</p><div class="table-wrap"><table class="filter"><thead><tr><th>Word</th><th class="num">Near a swear</th><th class="num">Ratio</th><th class="num">Chatters</th><th class="num">Last seen</th><th></th></tr></thead><tbody>${candidateRows}</tbody></table></div>`
    : `<p class="note">Nothing being watched right now.</p>`}
<h2>Ignored words</h2>
${blocked.length
    ? `<p class="muted">Forgotten words — never charged and never learned again here.</p><div class="table-wrap"><table class="filter"><thead><tr><th>Word</th><th class="num">Since</th><th></th></tr></thead><tbody>${blockedRows}</tbody></table></div>`
    : `<p class="note">No ignored words.</p>`}
<h2>Built-in words</h2>
<p class="muted">Charged in every channel, with these optional prefixes (${escapeHtml(BUILTIN_SWEARS.prefixes.join(", "))}) and endings (${escapeHtml(BUILTIN_SWEARS.suffixes.map((s) => "-" + s).join(", "))}), and common letter swaps like <code>sh1t</code> or <code>$hit</code>. These can only be changed in the bot's code.</p>
<div class="chips" id="builtin">${builtin}</div>
<div class="card"><p class="muted small" style="margin:0">Chat: <code>!jar</code> · <code>!jar words</code> · <code>!jar forget &lt;word&gt;</code> (mods) · <code>!jar giveaway</code> (mods) · <code>!fine</code></p></div>
<script>(function(){var q=document.getElementById("q"),items=[].slice.call(document.querySelectorAll("table.filter tbody tr, #builtin .chip"));q.addEventListener("input",function(){var t=q.value.trim().toLowerCase();items.forEach(function(r){r.hidden=!!t&&r.getAttribute("data-search").indexOf(t)===-1})})})();</script>`;

  return scrollDoc(`${name} — Swear jar`, body, {
    width: 1100,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}form.inline{display:inline;margin:0}form.inline button{padding:5px 12px;font-size:.78rem}.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:12px 0}td{vertical-align:middle}td.actions{white-space:nowrap}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.chip{border:1px solid var(--rule);border-radius:999px;padding:3px 10px;font-size:.85rem}.chip[hidden]{display:none}.card{margin-top:22px}`,
  });
}

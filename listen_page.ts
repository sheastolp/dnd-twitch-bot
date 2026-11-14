// GET /admin/listen — the operator page for the shot counter's listening
// (stream_listen.ts), modelled on UndercoverBurn's /logs page with its
// "Audio lines" filter: what GuildScribe heard on stream, which lines
// poured a shot, and why it isn't listening when it should be. Same auth as
// /admin/logs (operator login or ?key=<ADMIN_API_SECRET>).
//
// The lines live in memory only (the newest LISTEN_LOG_MAX, lost when the
// bot restarts); journalctl keeps the [listen] lines for longer.
// /admin/listen.txt is the same list as plain text, newest last.

import { escapeHtml } from "./utils.ts";
import { getListenLog, getListenStatus, LISTEN_LOG_MAX, listenLogStartedAt, type ListenLogLine } from "./stream_listen.ts";

const KINDS: Record<string, string> = {
  said: "What was said",
  shot: "Shots poured",
  cooldown: "Heard again (cooldown)",
  status: "Start / stop",
  error: "Problems",
};

type Filter = { channel: string; kind: string; q: string; limit: number };

function readFilter(params: URLSearchParams): Filter {
  return {
    channel: (params.get("channel") ?? "").trim().toLowerCase(),
    kind: KINDS[params.get("kind") ?? ""] ? String(params.get("kind")) : "",
    q: (params.get("q") ?? "").trim(),
    limit: Math.min(LISTEN_LOG_MAX, Math.max(1, Number(params.get("limit")) || 500)),
  };
}

function filtered(f: Filter): ListenLogLine[] {
  const needle = f.q.toLowerCase();
  return getListenLog()
    .filter((l) =>
      (!f.channel || l.login === f.channel || l.login === "") &&
      (!f.kind || l.kind === f.kind) &&
      (!needle || l.text.toLowerCase().includes(needle))
    )
    .slice(-f.limit);
}

/** UTC, like journalctl's default and Burn's page. */
const stamp = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 19);

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
};

/** /admin/listen.txt: plain text, newest last. */
export function renderListenLogText(params: URLSearchParams): string {
  return filtered(readFilter(params))
    .map((l) => `${stamp(l.ts)} ${l.kind.toUpperCase().padEnd(8)} ${l.login ? `${l.login}: ` : ""}${l.text}`)
    .join("\n") + "\n";
}

export const LISTEN_PAGE_CSS = `
.listen-stats{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
.listen-stats .stat{border:1px solid var(--edge);border-radius:6px;padding:8px 12px;min-width:150px}
.listen-stats .stat b{display:block;font-size:1.05rem}
form.filter{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:14px 0}
form.filter label{display:flex;gap:6px;align-items:center}
form.filter input[type=text]{min-width:180px}
.logbox{background:#15120f;color:#e8dcc4;border-radius:8px;padding:10px 12px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;overflow-x:auto}
.logbox .l{white-space:pre-wrap;word-break:break-word;padding:2px 0;border-bottom:1px solid #2a2219}
.logbox .ts{color:#8a7d68}
.logbox .who{color:#c9a96a}
.logbox .kind{display:inline-block;min-width:66px;color:#8a7d68}
.logbox .l.shot{color:#9be39b;font-weight:700}
.logbox .l.cooldown{color:#d8c690}
.logbox .l.status{color:#9fb7d8}
.logbox .l.error{color:#ff9a8f}
`;

/** The page body (web_routes.ts wraps it in scrollDoc). `key` is the ?key= the
 * operator came in with ("" when logged in), carried on every link. */
export function renderListenPage(params: URLSearchParams, key: string): string {
  const f = readFilter(params);
  const auto = params.get("auto") === "1";
  const st = getListenStatus();
  const shown = filtered(f).reverse();
  const all = getListenLog();
  const channels = [...new Set(all.map((l) => l.login).filter(Boolean).concat(st.captures.map((c) => c.login)))].sort();

  const link = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (key) p.set("key", key);
    const merged = { channel: f.channel, kind: f.kind, q: f.q, auto: auto ? "1" : "", ...extra };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  const now = Date.now();
  const listening = st.captures.length
    ? st.captures.map((c) => `${escapeHtml(c.login)} <span class="muted">(${ago(c.startedAt)})</span>`).join(", ")
    : "nobody";
  let transcriber = st.failures === 0 ? "✅ working" : `⚠️ ${st.failures} failure${st.failures === 1 ? "" : "s"} in a row`;
  if (!st.hasKey) transcriber = "⚠️ no API key (TRANSCRIBE_API_KEY / OPENAI_API_KEY)";
  if (st.pausedUntil > now) transcriber += ` — paused for ${ago(now - (st.pausedUntil - now))}`;
  const tools = st.unavailableUntil > now ? "⚠️ streamlink/ffmpeg can't run (see Problems)" : "✅";
  const shotsPoured = all.filter((l) => l.kind === "shot").length;

  const rows = shown.map((l) =>
    `<div class="l ${l.kind}"><span class="ts">${stamp(l.ts)}</span> <span class="kind">${l.kind}</span> ${l.login ? `<span class="who">${escapeHtml(l.login)}</span> ` : ""}${escapeHtml(l.text)}</div>`
  ).join("");

  const keyField = key ? `<input type="hidden" name="key" value="${escapeHtml(key)}">` : "";
  const k = key ? `?key=${encodeURIComponent(key)}` : "";

  return `<h1>🎙 Shot counter — what GuildScribe heard</h1>
  <p class="muted"><a href="/admin/logs${k}">Operator logs</a> · <a href="/admin/channels${k}">Channel connections</a> · <a href="/">Bot home</a></p>
  <p class="muted">Everything GuildScribe transcribed from live streams with shot listening on (<code>!feature shot listen on</code>), newest first. Lines that poured a shot are green. Kept in memory only: the newest ${LISTEN_LOG_MAX} lines since the bot last started (${stamp(listenLogStartedAt)} UTC). Times are UTC. Older lines: <code>journalctl</code> on the laptop, filtered for <code>[listen]</code>.</p>
  <div class="listen-stats">
    <div class="stat"><b>${listening}</b>listening now</div>
    <div class="stat"><b>${transcriber}</b>transcriber (${escapeHtml(st.host)}, ${escapeHtml(st.model)})</div>
    <div class="stat"><b>${tools}</b>streamlink + ffmpeg</div>
    <div class="stat"><b>${shotsPoured}</b>shots poured (kept lines)</div>
  </div>
  ${st.lastError && st.failures ? `<p>Last transcription error: <code>${escapeHtml(st.lastError)}</code></p>` : ""}
  <form class="filter" method="get" action="/admin/listen">
    ${keyField}
    <label>Channel <select name="channel"><option value="">All</option>${channels.map((c) => `<option${c === f.channel ? " selected" : ""}>${escapeHtml(c)}</option>`).join("")}</select></label>
    <label>Show <select name="kind"><option value="">Everything</option>${Object.entries(KINDS).map(([v, t]) => `<option value="${v}"${v === f.kind ? " selected" : ""}>${t}</option>`).join("")}</select></label>
    <input type="text" name="q" value="${escapeHtml(f.q)}" placeholder="Search the words, e.g. stupid">
    <label><input type="checkbox" name="auto" value="1"${auto ? " checked" : ""}> Auto-refresh (5s)</label>
    <button type="submit">Apply</button>
    <a href="/admin/listen${link({ kind: "shot" })}">Shots only</a> ·
    <a href="/admin/listen${k}">Clear</a> ·
    <a href="/admin/listen.txt${link({ auto: "" })}">Plain text</a>
  </form>
  <p class="muted">${shown.length} line${shown.length === 1 ? "" : "s"} shown of ${all.length} kept.</p>
  <div class="logbox">${rows || `<div class="l">(nothing heard yet — lines show up here while a channel with shot listening on is live)</div>`}</div>`;
}

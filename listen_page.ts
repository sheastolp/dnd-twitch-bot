// The shot counter's listening log (stream_listen.ts): what GuildScribe heard
// on stream, which lines poured a shot, and why it isn't listening when it
// should be. Modelled on UndercoverBurn's /logs page with its "Audio lines"
// filter, but split per channel:
//
//   GET /admin/listen               operator overview: one section per channel
//                                   (every channel with listening on, plus any
//                                   heard since the restart), its newest lines
//                                   and a link to its full log
//   GET /admin/listen?channel=<login>   one channel's full log (operator)
//   GET /admin/listen.txt[?channel=]    the same as plain text, newest last
//   GET /dashboard/listen           the streamer's own channel's log, behind
//                                   the dashboard key + login like the other
//                                   dashboard pages
//
// The lines live in memory only (the newest LISTEN_LOG_MAX across all
// channels, lost when the bot restarts); journalctl keeps the [listen]
// lines for longer.

import { sqlite } from "./sqlite.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";
import { isCommandGroupEnabled } from "./db.ts";
import { optWord } from "./channel_options.ts";
import { wantsVoiceThrows } from "./pokeball.ts";
import { getListenLog, getListenStatus, LISTEN_LOG_MAX, listenLogStartedAt, type ListenLogLine } from "./stream_listen.ts";

const KINDS: Record<string, string> = {
  said: "What was said",
  shot: "Shots poured",
  throw: "Pokéballs thrown",
  cooldown: "Heard again (cooldown)",
  status: "Start / stop",
  error: "Problems",
};

type Filter = { channel: string; kind: string; q: string; limit: number };

function readFilter(params: URLSearchParams, channel?: string): Filter {
  return {
    channel: (channel ?? params.get("channel") ?? "").trim().toLowerCase(),
    kind: KINDS[params.get("kind") ?? ""] ? String(params.get("kind")) : "",
    q: (params.get("q") ?? "").trim(),
    limit: Math.min(LISTEN_LOG_MAX, Math.max(1, Number(params.get("limit")) || 500)),
  };
}

/** Matching lines, oldest first. A channel's log is only its own lines;
 * server-wide lines (login "") only show in the overview's own section. */
function filtered(f: Filter): ListenLogLine[] {
  const needle = f.q.toLowerCase();
  return getListenLog()
    .filter((l) =>
      (f.channel === "*" || l.login === f.channel) &&
      (!f.kind || l.kind === f.kind) &&
      (!needle || l.text.toLowerCase().includes(needle))
    )
    .slice(-f.limit);
}

/** UTC, like journalctl's default and Burn's page. */
const stamp = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 19);

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
};

/** /admin/listen.txt: plain text, newest last. No channel = every line. */
export function renderListenLogText(params: URLSearchParams): string {
  const f = readFilter(params);
  if (!f.channel) f.channel = "*";
  return filtered(f)
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
.chan{margin:26px 0 8px}
.chan h2{margin:0 0 4px;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:baseline}
.chan h2 small{font-size:.8rem;font-weight:400}
.logbox{background:#15120f;color:#e8dcc4;border-radius:8px;padding:10px 12px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;overflow-x:auto}
.logbox .l{white-space:pre-wrap;word-break:break-word;padding:2px 0;border-bottom:1px solid #2a2219}
.logbox .ts{color:#8a7d68}
.logbox .who{color:#c9a96a}
.logbox .kind{display:inline-block;min-width:66px;color:#8a7d68}
.logbox .l.shot{color:#9be39b;font-weight:700}
.logbox .l.throw{color:#ff8f8f;font-weight:700}
.logbox .l.cooldown{color:#d8c690}
.logbox .l.status{color:#9fb7d8}
.logbox .l.error{color:#ff9a8f}
.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}
.dash-top h1{margin:8px 0 0}
`;

/** Newest first. `showWho` adds the channel name to each line. */
function logBox(lines: ListenLogLine[], empty: string, showWho = false): string {
  const rows = [...lines].reverse().map((l) =>
    `<div class="l ${l.kind}"><span class="ts">${stamp(l.ts)}</span> <span class="kind">${l.kind}</span> ${showWho && l.login ? `<span class="who">${escapeHtml(l.login)}</span> ` : ""}${escapeHtml(l.text)}</div>`
  ).join("");
  return `<div class="logbox">${rows || `<div class="l">${escapeHtml(empty)}</div>`}</div>`;
}

function transcriberStat(): string {
  const st = getListenStatus();
  const now = Date.now();
  let t = st.failures === 0 ? "✅ working" : `⚠️ ${st.failures} failure${st.failures === 1 ? "" : "s"} in a row`;
  if (!st.hasKey) t = "⚠️ no API key (TRANSCRIBE_API_KEY / OPENAI_API_KEY)";
  if (st.pausedUntil > now) t += ` — paused for ${ago(st.pausedUntil - now)}`;
  return `<div class="stat"><b>${t}</b>transcriber (${escapeHtml(st.host)}, ${escapeHtml(st.model)})</div>`;
}

type ChannelRow = { id: string; login: string; name: string; live: boolean; listenOn: boolean; shotsOn: boolean; throwsOn: boolean };

/** Why a channel is or isn't being listened to, in a few words. */
function channelState(c: ChannelRow | undefined, login: string): string {
  const st = getListenStatus();
  const cap = st.captures.find((x) => x.login === login);
  if (cap) return `🎙 listening now (${ago(Date.now() - cap.startedAt)})`;
  if (!c) return "not connected";
  if (!c.listenOn && !c.throwsOn) return "listening is off (!feature shot listen on, or !ball voice on)";
  if (!c.throwsOn && !c.shotsOn) return "⚠️ shot counter is off (!feature shots on)";
  if (!c.live) return "offline — starts when the stream goes live";
  if (st.unavailableUntil > Date.now()) return "⚠️ streamlink/ffmpeg can't run — see Problems";
  if (!st.hasKey) return "⚠️ no transcription API key";
  return "starting… (checked every 30 s)";
}

async function channelRow(r: any): Promise<ChannelRow> {
  const id = String(r.broadcaster_id);
  const [listen, shots, throwsOn] = await Promise.all([
    optWord(id, "shots.listen").catch(() => "off"),
    isCommandGroupEnabled(id, "shots").catch(() => false),
    wantsVoiceThrows(id).catch(() => false),
  ]);
  return {
    id,
    login: String(r.login ?? "").toLowerCase(),
    name: String(r.display_name || r.login || id),
    live: Number(r.is_live) === 1,
    listenOn: listen === "on",
    shotsOn: shots,
    throwsOn,
  };
}

/** Channels with listening switched on, plus any that have lines in the log. */
async function overviewChannels(): Promise<ChannelRow[]> {
  const logins = [...new Set(getListenLog().map((l) => l.login).filter(Boolean))];
  const { rows } = await sqlite.execute(
    `SELECT b.broadcaster_id, b.login, b.display_name, b.is_live FROM broadcasters b
     WHERE b.connected = 1 AND b.login IS NOT NULL AND (
       EXISTS (SELECT 1 FROM channel_options o WHERE o.broadcaster_id = b.broadcaster_id AND o.opt_key IN ('shots.listen', 'pokeball.listen') AND o.value = 'on')
       ${logins.length ? `OR LOWER(b.login) IN (${logins.map(() => "?").join(",")})` : ""}
     )`,
    logins,
  );
  const out = await Promise.all((rows as any[]).map(channelRow));
  return out.sort((a, b) => Number(b.live) - Number(a.live) || a.login.localeCompare(b.login));
}

function filterForm(action: string, f: Filter, auto: boolean, hidden: Record<string, string>, extraLinks: string): string {
  const fields = Object.entries(hidden).filter(([, v]) => v).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join("");
  return `<form class="filter" method="get" action="${action}">
    ${fields}
    <label>Show <select name="kind"><option value="">Everything</option>${Object.entries(KINDS).map(([v, t]) => `<option value="${v}"${v === f.kind ? " selected" : ""}>${t}</option>`).join("")}</select></label>
    <input type="text" name="q" value="${escapeHtml(f.q)}" placeholder="Search the words, e.g. stupid">
    <label><input type="checkbox" name="auto" value="1"${auto ? " checked" : ""}> Auto-refresh (5s)</label>
    <button type="submit">Apply</button>
    ${extraLinks}
  </form>`;
}

const keepNote = () =>
  `Kept in memory only: the newest ${LISTEN_LOG_MAX} lines across all channels since the bot last started (${stamp(listenLogStartedAt)} UTC). Times are UTC.`;

/** GET /admin/listen — the overview, or one channel's full log with ?channel=. */
export async function renderListenPage(params: URLSearchParams, key: string): Promise<string> {
  const auto = params.get("auto") === "1";
  const k = key ? `key=${encodeURIComponent(key)}` : "";
  const href = (q: Record<string, string>) => {
    const p = new URLSearchParams();
    if (key) p.set("key", key);
    for (const [a, b] of Object.entries(q)) if (b) p.set(a, b);
    const s = p.toString();
    return `/admin/listen${s ? `?${s}` : ""}`;
  };
  const nav = `<p class="muted"><a href="/admin/logs${k ? `?${k}` : ""}">Operator logs</a> · <a href="/admin/channels${k ? `?${k}` : ""}">Channel connections</a> · <a href="/">Bot home</a></p>`;
  const f = readFilter(params);

  // ── One channel's full log ──
  if (f.channel) {
    const { rows } = await sqlite.execute(
      `SELECT broadcaster_id, login, display_name, is_live FROM broadcasters WHERE LOWER(login) = ?`,
      [f.channel],
    );
    const c = rows.length ? await channelRow((rows as any[])[0]) : undefined;
    const lines = filtered(f);
    const all = getListenLog().filter((l) => l.login === f.channel);
    const txt = `/admin/listen.txt?${new URLSearchParams({ ...(key ? { key } : {}), channel: f.channel, ...(f.kind ? { kind: f.kind } : {}), ...(f.q ? { q: f.q } : {}) })}`;
    return `<p class="muted"><a href="${href({})}">← All channels</a></p>
  <h1>🎙 ${escapeHtml(c?.name ?? f.channel)} — what GuildScribe heard</h1>
  ${nav}
  <p class="muted">Everything GuildScribe transcribed from this channel with shot listening on, newest first. Lines that poured a shot are green. ${keepNote()}</p>
  <div class="listen-stats">
    <div class="stat"><b>${escapeHtml(channelState(c, f.channel))}</b>status</div>
    ${transcriberStat()}
    <div class="stat"><b>${all.filter((l) => l.kind === "shot").length}</b>shots poured (kept lines)</div>
    <div class="stat"><b>${all.filter((l) => l.kind === "said").length}</b>lines heard (kept)</div>
  </div>
  ${filterForm("/admin/listen", f, auto, { key, channel: f.channel }, `<a href="${href({ channel: f.channel, kind: "shot" })}">Shots only</a> · <a href="${href({ channel: f.channel })}">Clear</a> · <a href="${escapeHtml(txt)}">Plain text</a>`)}
  <p class="muted">${lines.length} line${lines.length === 1 ? "" : "s"} shown of ${all.length} kept for this channel.</p>
  ${logBox(lines, "(nothing heard from this channel yet — lines show up here while it's live with shot listening on)")}`;
  }

  // ── Overview: a section per channel ──
  const channels = await overviewChannels();
  const st = getListenStatus();
  const PER_CHANNEL = 8;
  const sections = channels.map((c) => {
    const lines = getListenLog().filter((l) => l.login === c.login);
    const shots = lines.filter((l) => l.kind === "shot").length;
    return `<section class="chan">
      <h2>${escapeHtml(c.name)} <small class="muted">${escapeHtml(channelState(c, c.login))} · ${lines.length} line${lines.length === 1 ? "" : "s"} · ${shots} shot${shots === 1 ? "" : "s"}</small> <small><a href="${href({ channel: c.login })}">Full log →</a></small></h2>
      ${logBox(lines.slice(-PER_CHANNEL), "(nothing heard yet)")}
    </section>`;
  }).join("");
  const general = getListenLog().filter((l) => !l.login).slice(-20);
  const allLines = getListenLog();

  return `<h1>🎙 Shot listening — what GuildScribe heard</h1>
  ${nav}
  <p class="muted">One section per channel with shot listening on (<code>!feature shot listen on</code>), each with its newest ${PER_CHANNEL} lines; open <em>Full log</em> for everything, with search and auto-refresh. Streamers see their own channel's log on their dashboard (🎙 Listening log). ${keepNote()}</p>
  <div class="listen-stats">
    <div class="stat"><b>${st.captures.length}</b>channel${st.captures.length === 1 ? "" : "s"} listening now</div>
    ${transcriberStat()}
    <div class="stat"><b>${st.unavailableUntil > Date.now() ? "⚠️ can't run" : "✅"}</b>streamlink + ffmpeg</div>
    <div class="stat"><b>${allLines.filter((l) => l.kind === "shot").length}</b>shots poured (kept lines)</div>
  </div>
  ${st.lastError && st.failures ? `<p>Last transcription error: <code>${escapeHtml(st.lastError)}</code></p>` : ""}
  ${sections || `<p class="note">No channel has shot listening on yet. A mod turns it on in chat with <code>!feature shot listen on</code> (or Quick setup → Shot counter → ⚙ Options).</p>`}
  ${general.length ? `<section class="chan"><h2>Server-wide <small class="muted">not tied to one channel</small></h2>${logBox(general, "")}</section>` : ""}
  <p class="muted"><a href="/admin/listen.txt${k ? `?${k}` : ""}">Every line as plain text</a>${auto ? "" : ` · <a href="${href({ auto: "1" })}">Auto-refresh</a>`}</p>`;
}

/** GET /dashboard/listen — one channel's own log (auth done by dashboard.ts). */
export async function renderDashboardListenPage(d: { broadcasterId: string; key: string; params: URLSearchParams }): Promise<string> {
  const { rows } = await sqlite.execute(
    `SELECT broadcaster_id, login, display_name, is_live FROM broadcasters WHERE broadcaster_id = ?`,
    [d.broadcasterId],
  );
  const c = rows.length ? await channelRow((rows as any[])[0]) : undefined;
  const login = c?.login ?? "";
  const f = readFilter(d.params, login || "\u0000");
  const auto = d.params.get("auto") === "1";
  const lines = filtered(f);
  const all = getListenLog().filter((l) => l.login === login && login);
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(c?.name ?? d.broadcasterId);

  const body = `<header class="dash-top"><div><span class="pill">Shot counter · Listening log</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
  <p>What GuildScribe heard on your stream while shot listening is on, newest first. Saying <strong>"that was stupid"</strong>, <strong>"I'm stupid"</strong> or <strong>"that was worthy of one"</strong> adds a shot — those lines are green. Only you and your mods can see this page. Nothing here is saved: it's the newest lines since the bot last restarted (${stamp(listenLogStartedAt)} UTC). Times are UTC.</p>
  <div class="listen-stats">
    <div class="stat"><b>${escapeHtml(channelState(c, login))}</b>status</div>
    <div class="stat"><b>${all.filter((l) => l.kind === "shot").length}</b>shots poured (kept lines)</div>
    <div class="stat"><b>${all.filter((l) => l.kind === "said").length}</b>lines heard (kept)</div>
  </div>
  ${filterForm("/dashboard/listen", f, auto, { channel: d.broadcasterId, key: d.key }, `<a href="/dashboard/listen?${qs}&kind=shot">Shots only</a> · <a href="/dashboard/listen?${qs}">Clear</a>`)}
  <p class="muted">${lines.length} line${lines.length === 1 ? "" : "s"} shown of ${all.length} kept.</p>
  ${logBox(lines, "(nothing heard yet — lines show up here while you're live with shot listening on)")}
  <div class="card" style="margin-top:22px"><p class="muted small" style="margin:0">Chat: <code>!feature shot listen on|off|status</code> (mods) · <code>!shot undo</code> takes back a shot it got wrong · <code>!shots</code></p></div>`;

  return scrollDoc(`${c?.name ?? "Channel"} — Listening log`, body, {
    width: 1100,
    head: auto ? `<meta http-equiv="refresh" content="5">` : "",
    css: LEDGER_CSS + LISTEN_PAGE_CSS,
  });
}

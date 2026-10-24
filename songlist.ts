// GuildScribe — the song request list: requests that can't go into a Spotify
// queue (YouTube, SoundCloud and other links, or any request while Spotify
// isn't connected), kept as a list the streamer and mods work through.
//
//   !sr <YouTube/SoundCloud/any https link>   goes on the list (songrequests.ts)
//   !sr <song name>                           goes on the list when Spotify isn't set up for
//                                             song requests, with a YouTube search link
//   GET  /dashboard/songs                     the list (mods only: dashboard key + Twitch mod login)
//   GET  /dashboard/songs?format=json         what the page polls to stay current
//   POST /dashboard/songs                     intent=done|undo|add|clear (the page posts with
//                                             fetch; plain form posts still work without JS)
//
// Each row has the link and who asked for it. "Done" takes a row off the list
// (it's kept marked done for DONE_KEEP_MS so the page can undo it), and the
// page refreshes on its own every few seconds, so several mods can work the
// list at once. Titles for YouTube and SoundCloud links come from their public
// oEmbed endpoints (no keys), best-effort; other links show their address.
// Same "songrequests" switch and per-viewer limit as Spotify requests. Viewer
// text only reaches the page escaped (server-rendered) or via textContent.

import { sqlite } from "./sqlite.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

/** Finished rows are kept this long (for undo), then deleted. */
const DONE_KEEP_MS = 24 * 60 * 60_000;
const MAX_PENDING = 200;
const MAX_LABEL = 200;

export type ListRequest = { id: number; login: string; display: string; url: string; label: string; requestedAt: number; doneAt: number };

export async function ensureSongListTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS song_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT, broadcaster_id TEXT NOT NULL, login TEXT NOT NULL, display TEXT NOT NULL,
      url TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', requested_at INTEGER NOT NULL, done_at INTEGER NOT NULL DEFAULT 0
    )`,
  );
  await sqlite.execute("CREATE INDEX IF NOT EXISTS song_list_channel ON song_list (broadcaster_id, done_at, id)");
}

export async function purgeSongListData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM song_list WHERE broadcaster_id = ?", [broadcasterId]);
}

/** A typed link → a clean https URL, or null. */
export function cleanLink(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".") || u.username || u.password) return null;
    u.protocol = "https:";
    return u.toString();
  } catch (_) {
    return null;
  }
}

export const youtubeSearchLink = (query: string) => `https://www.youtube.com/results?${new URLSearchParams({ search_query: query.slice(0, 200) })}`;

/** The song's title from YouTube's or SoundCloud's oEmbed (no keys); "" otherwise. */
async function lookupTitle(url: string): Promise<string> {
  let host = "";
  try { host = new URL(url).hostname.replace(/^(www|m|music)\./, ""); } catch (_) { return ""; }
  const endpoint = host === "youtube.com" || host === "youtu.be"
    ? `https://www.youtube.com/oembed?${new URLSearchParams({ url, format: "json" })}`
    : host === "soundcloud.com"
    ? `https://soundcloud.com/oembed?${new URLSearchParams({ url, format: "json" })}`
    : "";
  if (!endpoint) return "";
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return "";
    const d = await res.json();
    const title = String(d?.title ?? "").trim();
    const author = String(d?.author_name ?? "").trim();
    // YouTube titles usually name the artist already; SoundCloud's are "Song by Artist".
    return (title && author && host !== "soundcloud.com" && !title.toLowerCase().includes(author.toLowerCase()) ? `${title} — ${author}` : title).slice(0, MAX_LABEL);
  } catch (_) {
    return "";
  }
}

/** Puts a request on the list. `label` is the song name for a search link;
 * links get their title looked up. */
export async function addListRequest(
  broadcasterId: string,
  r: { login: string; display: string; url: string; label?: string },
): Promise<{ ok: true; label: string } | { ok: false; reason: "duplicate" | "full" }> {
  const pending = await sqlite.execute(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN url = ? THEN 1 ELSE 0 END) AS dup FROM song_list WHERE broadcaster_id = ? AND done_at = 0",
    [r.url, broadcasterId],
  );
  if (Number(pending.rows[0]?.dup ?? 0) > 0) return { ok: false, reason: "duplicate" };
  if (Number(pending.rows[0]?.n ?? 0) >= MAX_PENDING) return { ok: false, reason: "full" };
  const label = (r.label?.trim() || await lookupTitle(r.url)).slice(0, MAX_LABEL);
  const now = Date.now();
  await sqlite.execute(
    "INSERT INTO song_list (broadcaster_id, login, display, url, label, requested_at) VALUES (?,?,?,?,?,?)",
    [broadcasterId, r.login.toLowerCase(), r.display.slice(0, 40), r.url, label, now],
  );
  await sqlite.execute("DELETE FROM song_list WHERE broadcaster_id = ? AND done_at > 0 AND done_at < ?", [broadcasterId, now - DONE_KEEP_MS]);
  return { ok: true, label };
}

/** How many of this viewer's requests are still on the list. */
export async function pendingCountFor(broadcasterId: string, login: string): Promise<number> {
  const res = await sqlite.execute("SELECT COUNT(*) AS n FROM song_list WHERE broadcaster_id = ? AND login = ? AND done_at = 0", [broadcasterId, login.toLowerCase()]);
  return Number(res.rows[0]?.n ?? 0);
}

export async function pendingCount(broadcasterId: string): Promise<number> {
  const res = await sqlite.execute("SELECT COUNT(*) AS n FROM song_list WHERE broadcaster_id = ? AND done_at = 0", [broadcasterId]);
  return Number(res.rows[0]?.n ?? 0);
}

const toRequest = (r: any): ListRequest => ({
  id: Number(r.id), login: String(r.login), display: String(r.display), url: String(r.url),
  label: String(r.label), requestedAt: Number(r.requested_at), doneAt: Number(r.done_at),
});

/** The list, oldest first, and the most recently finished few (for undo). */
export async function getSongList(broadcasterId: string): Promise<{ pending: ListRequest[]; done: ListRequest[] }> {
  const [pending, done] = await Promise.all([
    sqlite.execute("SELECT * FROM song_list WHERE broadcaster_id = ? AND done_at = 0 ORDER BY id", [broadcasterId]),
    sqlite.execute("SELECT * FROM song_list WHERE broadcaster_id = ? AND done_at > 0 ORDER BY done_at DESC LIMIT 5", [broadcasterId]),
  ]);
  return { pending: (pending.rows as any[]).map(toRequest), done: (done.rows as any[]).map(toRequest) };
}

// ── The mods' page (auth is done by the caller; see dashboard.ts) ───────────

export async function applySongListForm(broadcasterId: string, form: FormData, modName: string): Promise<{ ok: boolean; message: string }> {
  const intent = String(form.get("intent") ?? "");
  const id = Math.floor(Number(form.get("id")));
  if (intent === "done" || intent === "undo") {
    if (!Number.isFinite(id) || id <= 0) return { ok: false, message: "That request is no longer on the list." };
    const res = await sqlite.execute(
      `UPDATE song_list SET done_at = ? WHERE broadcaster_id = ? AND id = ? AND ${intent === "done" ? "done_at = 0" : "done_at > 0"}`,
      [intent === "done" ? Date.now() : 0, broadcasterId, id],
    );
    if (!res.rowsAffected) return { ok: true, message: intent === "done" ? "Already done." : "Already back on the list." };
    return { ok: true, message: intent === "done" ? "Marked done." : "Put back on the list." };
  }
  if (intent === "clear") {
    const res = await sqlite.execute("UPDATE song_list SET done_at = ? WHERE broadcaster_id = ? AND done_at = 0", [Date.now(), broadcasterId]);
    return { ok: true, message: `Cleared ${res.rowsAffected} request${res.rowsAffected === 1 ? "" : "s"}.` };
  }
  if (intent === "add") {
    const raw = String(form.get("link") ?? "").trim();
    const who = String(form.get("who") ?? "").trim().replace(/^@/, "").slice(0, 40) || modName;
    if (!raw) return { ok: false, message: "Paste a link or type a song name." };
    const url = cleanLink(raw);
    const added = await addListRequest(broadcasterId, url ? { login: who, display: who, url } : { login: who, display: who, url: youtubeSearchLink(raw), label: raw });
    if (!added.ok) return { ok: false, message: added.reason === "duplicate" ? "That's already on the list." : "The list is full — clear some first." };
    return { ok: true, message: `Added${added.label ? ` "${added.label}"` : ""}.` };
  }
  return { ok: false, message: "Unknown action." };
}

export async function renderSongListPage(d: { broadcasterId: string; broadcasterName: string; key: string; notice?: string; error?: string }): Promise<string> {
  const list = await getSongList(d.broadcasterId);
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const cfgJson = JSON.stringify({ channel: d.broadcasterId, key: d.key, list }).replace(/</g, "\\u003c");
  const body = `<header class="dash-top"><div><span class="pill">Stream · Song request list</span><h1>${escapeHtml(d.broadcasterName)}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>Song requests that can't go into Spotify: YouTube, SoundCloud and other links from <code>!sr</code>, plus every <code>!sr</code> while Spotify isn't connected for song requests. Oldest first. Press <strong>Done</strong> once a song has played. The page refreshes on its own, so other mods can work the list at the same time.</p>
<div class="bar"><span id="count" class="count"></span><span id="live" class="muted small"></span>
<form method="post" action="/dashboard/songs" class="inline" id="clear-form">${hidden}<input type="hidden" name="intent" value="clear"><button type="submit" class="ghost">Clear all</button></form></div>
<ol class="list" id="list"></ol>
<noscript><p class="muted">Turn on JavaScript for the live list.</p></noscript>
<div id="undo-box" class="undo" hidden><span id="undo-text"></span><button type="button" class="ghost" id="undo-btn">Undo</button></div>
<details class="add"><summary>Add a request by hand</summary>
<form method="post" action="/dashboard/songs" class="grid2" id="add-form">${hidden}<input type="hidden" name="intent" value="add">
<label>Link or song name<input name="link" maxlength="300" required placeholder="https://youtu.be/… or Artist - Song" autocomplete="off"></label>
<label>Requested by<input name="who" maxlength="40" placeholder="viewer's name (blank = you)" autocomplete="off"></label>
<button type="submit" class="ember">Add</button></form></details>
<h2>Recently done</h2><ul class="done" id="done"></ul>
<script>
(function(){
  const CFG=${cfgJson};
  const $=(id)=>document.getElementById(id);
  const ago=(t)=>{const s=Math.max(0,Math.round((Date.now()-t)/1000));return s<60?"just now":s<3600?Math.floor(s/60)+" min ago":Math.floor(s/3600)+" h ago"};
  const host=(u)=>{try{return new URL(u).hostname.replace(/^www\\./,"")}catch(e){return u}};
  function link(r){const a=document.createElement("a");a.href=r.url;a.target="_blank";a.rel="noopener noreferrer";a.textContent=r.label||r.url;a.className="song";return a}
  function render(list){
    const ol=$("list");ol.textContent="";
    $("count").textContent=list.pending.length?list.pending.length+" waiting":"Nothing waiting";
    $("clear-form").hidden=!list.pending.length;
    list.pending.forEach((r)=>{const li=document.createElement("li");
      const main=document.createElement("div");main.className="main";main.append(link(r));
      const meta=document.createElement("div");meta.className="meta";
      const by=document.createElement("b");by.textContent=r.display;
      meta.append("requested by ",by," · "+ago(r.requestedAt)+" · "+host(r.url));main.append(meta);
      const btn=document.createElement("button");btn.type="button";btn.className="ember";btn.textContent="✓ Done";btn.onclick=()=>act("done",r);
      li.append(main,btn);ol.append(li)});
    if(!list.pending.length){const li=document.createElement("li");li.className="empty";li.textContent="No requests right now. New ones show up here by themselves.";ol.append(li)}
    const ul=$("done");ul.textContent="";
    list.done.forEach((r)=>{const li=document.createElement("li");li.append(link(r)," · ",r.display+" ");
      const b=document.createElement("button");b.type="button";b.className="ghost";b.textContent="Put back";b.onclick=()=>act("undo",r);li.append(b);ul.append(li)});
    if(!list.done.length){const li=document.createElement("li");li.className="muted";li.textContent="None yet.";ul.append(li)}
  }
  function post(fields){const f=new FormData();f.set("channel",CFG.channel);f.set("key",CFG.key);for(const k in fields)f.set(k,fields[k]);
    return fetch("/dashboard/songs",{method:"POST",body:f,headers:{Accept:"application/json"},credentials:"same-origin"}).then((r)=>{if(!r.ok||!(r.headers.get("content-type")||"").includes("json"))throw new Error("auth");return r.json()})}
  let undoTimer;
  async function act(intent,r){
    if(intent==="done"){CFG.list.pending=CFG.list.pending.filter((x)=>x.id!==r.id);render(CFG.list)}
    try{const d=await post({intent,id:r.id});if(d.list){CFG.list=d.list;render(d.list)}
      if(intent==="done"){$("undo-text").textContent="Done: "+(r.label||host(r.url));$("undo-box").hidden=false;$("undo-btn").onclick=()=>{$("undo-box").hidden=true;act("undo",r)};
        clearTimeout(undoTimer);undoTimer=setTimeout(()=>$("undo-box").hidden=true,8000)}}
    catch(e){location.reload()}
  }
  $("add-form").addEventListener("submit",async(e)=>{e.preventDefault();const f=new FormData(e.target);
    try{const d=await post({intent:"add",link:f.get("link"),who:f.get("who")});if(d.list){CFG.list=d.list;render(d.list)}
      $("live").textContent=d.message;if(d.ok)e.target.reset()}catch(err){e.target.submit()}});
  $("clear-form").addEventListener("submit",(e)=>{if(!confirm("Mark every waiting request done?"))e.preventDefault()});
  async function poll(){try{const r=await fetch("/dashboard/songs?channel="+encodeURIComponent(CFG.channel)+"&key="+encodeURIComponent(CFG.key)+"&format=json",{cache:"no-store",credentials:"same-origin"});
    if(!r.ok||!(r.headers.get("content-type")||"").includes("json")){$("live").textContent="Logged out — reload to log in again.";return}
    // Redraw only on a change, so a Done button never gets swapped out from under a click.
    const list=(await r.json()).list;if(JSON.stringify(list)!==JSON.stringify(CFG.list)){CFG.list=list;render(list)}$("live").textContent="· updated "+new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"})}catch(e){$("live").textContent="· offline, retrying…"}}
  // "2 min ago" labels tick over once a minute.
  render(CFG.list);setInterval(poll,5000);setInterval(()=>render(CFG.list),60000);
})();
</script>`;
  return scrollDoc(`${d.broadcasterName} — Song request list`, body, {
    width: 900,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}
form.inline{display:inline;margin:0}.bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0 8px}.bar .count{font-weight:700;font-size:1.1rem}.bar form{margin-left:auto}
ol.list{list-style:none;padding:0;margin:0;display:grid;gap:8px}
ol.list li{display:flex;align-items:center;gap:14px;padding:12px 14px;border:1px solid var(--edge);border-radius:8px;background:#efe5c8}
ol.list li.empty{justify-content:center;color:var(--ink-3);background:#f3ead0;border-style:dashed}
ol.list .main{flex:1;min-width:0}ol.list .song{font-weight:600;font-size:1.05rem;overflow-wrap:anywhere}
ol.list .meta{font-size:.86rem;color:var(--ink-3);margin-top:3px;overflow-wrap:anywhere}ol.list .meta b{color:var(--seal)}
ol.list button{flex:none;padding:8px 14px}
.undo{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);display:flex;gap:12px;align-items:center;padding:10px 16px;border-radius:8px;background:#2a1d12;color:#f4eadb;box-shadow:0 6px 18px #0006;max-width:calc(100vw - 32px)}
.undo button{color:#f5c873;border-color:#f5c87388}
details.add{margin:18px 0}details.add summary{cursor:pointer;font-weight:600}
form.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:10px;align-items:end;margin:10px 0}form.grid2 label{display:flex;flex-direction:column;gap:4px;font-weight:600;font-size:.9rem}form.grid2 input{padding:9px 12px;font-weight:400}
ul.done{padding-left:1.2em}ul.done li{margin:6px 0;overflow-wrap:anywhere}ul.done button{padding:3px 10px;font-size:.78rem;margin-left:6px}
.muted{color:var(--ink-3)}.small{font-size:.86rem}`,
  });
}

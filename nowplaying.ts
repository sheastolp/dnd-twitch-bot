// GuildScribe — "Now playing": the song the streamer has on, shown on stream.
//
// Two sources, set up per channel on the dashboard's 🎵 Now playing page:
//   • Spotify — connected directly (OAuth, user-read-currently-playing). The
//     operator needs a Spotify app: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET,
//     with {PUBLIC_BASE_URL}/spotify/callback as a redirect URI.
//   • Last.fm — for Apple Music (which has no live "now playing" API) or any
//     player a scrobbler app reports to Last.fm. Just a Last.fm username; the
//     operator needs LASTFM_API_KEY.
// With both set up, Spotify wins while it's playing, Last.fm otherwise.
//
//   GET  /overlay/nowplaying?channel=<id|login>   public JSON: { ok, track } (track null when nothing plays)
//   GET  /overlay?channel=<id|login>&panel=music  standalone overlay (520×120)
//   GET  /dashboard/music · POST /dashboard/music  settings page (dashboard key + mod login; dashboard.ts)
//   GET  /dashboard/music/spotify                  starts the Spotify connection
//   GET  /spotify/callback                         Spotify's OAuth return
//
// The theme shows it top-left in every scene with &music=1 (overlay_theme.ts).
// Lookups are cached a few seconds per channel and shared between identical
// requests, so any number of open sources cost one Spotify/Last.fm call per
// NOW_PLAYING_CACHE_MS. Only song details ever leave the server, never tokens.

import { sqlite } from "./sqlite.ts";
import { escapeHtml } from "./utils.ts";
import { PUBLIC_BASE_URL } from "./config.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

const NOW_PLAYING_CACHE_MS = 4_000;
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const SPOTIFY_SCOPE = "user-read-currently-playing";
const LASTFM_USER_RE = /^[A-Za-z][A-Za-z0-9_-]{1,14}$/;
const LASTFM_BLANK_ART = "2a96cbd8b46e442fc41c2b86b821562f"; // Last.fm's grey star placeholder

const spotifyClientId = () => Deno.env.get("SPOTIFY_CLIENT_ID") ?? "";
const spotifyClientSecret = () => Deno.env.get("SPOTIFY_CLIENT_SECRET") ?? "";
const lastfmKey = () => Deno.env.get("LASTFM_API_KEY") ?? "";
export const spotifyRedirectUri = () => `${PUBLIC_BASE_URL}/spotify/callback`;

export type NowPlaying = {
  source: "spotify" | "lastfm";
  title: string;
  artist: string;
  album: string;
  art: string;
  url: string;
  playing: boolean;
  /** Spotify only: position and length, for a progress bar. */
  progressMs?: number;
  durationMs?: number;
  at: number;
};

export async function ensureNowPlayingTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS now_playing (
      broadcaster_id TEXT PRIMARY KEY,
      lastfm_user TEXT NOT NULL DEFAULT '',
      spotify_user TEXT NOT NULL DEFAULT '',
      spotify_refresh TEXT NOT NULL DEFAULT '',
      spotify_access TEXT NOT NULL DEFAULT '',
      spotify_expires INTEGER NOT NULL DEFAULT 0
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS spotify_oauth_states (
      state TEXT PRIMARY KEY, broadcaster_id TEXT NOT NULL, dash_key TEXT NOT NULL, created_at INTEGER NOT NULL
    )`,
  );
}

/** !dndbot leave (purge or not): forget the Spotify connection and the Last.fm name. */
export async function purgeNowPlayingData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM now_playing WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM spotify_oauth_states WHERE broadcaster_id = ?", [broadcasterId]);
  cache.delete(broadcasterId);
}

type Settings = { lastfmUser: string; spotifyUser: string; spotifyRefresh: string; spotifyAccess: string; spotifyExpires: number };

async function getSettings(broadcasterId: string): Promise<Settings> {
  const r = (await sqlite.execute("SELECT * FROM now_playing WHERE broadcaster_id = ?", [broadcasterId])).rows[0] as any;
  return {
    lastfmUser: String(r?.lastfm_user ?? ""),
    spotifyUser: String(r?.spotify_user ?? ""),
    spotifyRefresh: String(r?.spotify_refresh ?? ""),
    spotifyAccess: String(r?.spotify_access ?? ""),
    spotifyExpires: Number(r?.spotify_expires ?? 0),
  };
}

async function saveSettings(broadcasterId: string, patch: Partial<Settings>) {
  const s = { ...(await getSettings(broadcasterId)), ...patch };
  await sqlite.execute(
    `INSERT INTO now_playing (broadcaster_id, lastfm_user, spotify_user, spotify_refresh, spotify_access, spotify_expires) VALUES (?,?,?,?,?,?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET lastfm_user = excluded.lastfm_user, spotify_user = excluded.spotify_user,
       spotify_refresh = excluded.spotify_refresh, spotify_access = excluded.spotify_access, spotify_expires = excluded.spotify_expires`,
    [broadcasterId, s.lastfmUser, s.spotifyUser, s.spotifyRefresh, s.spotifyAccess, s.spotifyExpires],
  );
  cache.delete(broadcasterId);
}

// ── Spotify ──

async function spotifyToken(body: Record<string, string>): Promise<any> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${spotifyClientId()}:${spotifyClientSecret()}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`spotify token ${res.status}: ${data?.error ?? ""}`);
  return data;
}

/** A live access token, refreshed when it's within a minute of expiring. "" when not connected or revoked. */
async function spotifyAccess(broadcasterId: string, s: Settings): Promise<string> {
  if (!s.spotifyRefresh || !spotifyClientId()) return "";
  if (s.spotifyAccess && Date.now() < s.spotifyExpires - 60_000) return s.spotifyAccess;
  try {
    const t = await spotifyToken({ grant_type: "refresh_token", refresh_token: s.spotifyRefresh });
    await saveSettings(broadcasterId, {
      spotifyAccess: String(t.access_token),
      spotifyExpires: Date.now() + Number(t.expires_in ?? 3600) * 1000,
      ...(t.refresh_token ? { spotifyRefresh: String(t.refresh_token) } : {}),
    });
    return String(t.access_token);
  } catch (e) {
    // invalid_grant: the streamer removed access in their Spotify account — forget it.
    if (/invalid_grant/.test(String(e))) await saveSettings(broadcasterId, { spotifyRefresh: "", spotifyAccess: "", spotifyExpires: 0, spotifyUser: "" });
    console.error("spotify refresh failed", e);
    return "";
  }
}

async function fromSpotify(broadcasterId: string, s: Settings): Promise<NowPlaying | null> {
  const token = await spotifyAccess(broadcasterId, s);
  if (!token) return null;
  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 204) return null; // nothing on
  if (res.status === 401) {
    await saveSettings(broadcasterId, { spotifyAccess: "", spotifyExpires: 0 });
    return null;
  }
  if (!res.ok) throw new Error(`spotify currently-playing ${res.status}`);
  const d = await res.json().catch(() => null);
  const item = d?.item;
  if (!item) return null;
  const episode = item.type === "episode";
  const images: any[] = (episode ? item.images ?? item.show?.images : item.album?.images) ?? [];
  return {
    source: "spotify",
    title: String(item.name ?? ""),
    artist: episode ? String(item.show?.name ?? "") : (item.artists ?? []).map((a: any) => a.name).join(", "),
    album: episode ? "" : String(item.album?.name ?? ""),
    art: String(images[0]?.url ?? ""),
    url: String(item.external_urls?.spotify ?? ""),
    playing: Boolean(d.is_playing),
    progressMs: Number(d.progress_ms ?? 0),
    durationMs: Number(item.duration_ms ?? 0),
    at: Date.now(),
  };
}

// ── Last.fm (Apple Music and anything else that scrobbles) ──

async function fromLastfm(s: Settings): Promise<NowPlaying | null> {
  if (!s.lastfmUser || !lastfmKey()) return null;
  const params = new URLSearchParams({ method: "user.getrecenttracks", user: s.lastfmUser, api_key: lastfmKey(), format: "json", limit: "1" });
  const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`lastfm ${res.status}`);
  const d = await res.json().catch(() => null);
  const raw = d?.recenttracks?.track;
  const t = Array.isArray(raw) ? raw[0] : raw;
  // Only a track Last.fm marks as playing right now; the last scrobble isn't "now playing".
  if (!t || t["@attr"]?.nowplaying !== "true") return null;
  const images: any[] = Array.isArray(t.image) ? t.image : [];
  const art = String(images[images.length - 1]?.["#text"] ?? "");
  return {
    source: "lastfm",
    title: String(t.name ?? ""),
    artist: String(t.artist?.["#text"] ?? t.artist?.name ?? ""),
    album: String(t.album?.["#text"] ?? ""),
    art: art.includes(LASTFM_BLANK_ART) ? "" : art,
    url: String(t.url ?? ""),
    playing: true,
    at: Date.now(),
  };
}

const cache = new Map<string, { at: number; track: NowPlaying | null }>();
const inflight = new Map<string, Promise<NowPlaying | null>>();

/** What's playing for a channel: Spotify while it plays, else Last.fm. Never throws. */
export function getNowPlaying(broadcasterId: string): Promise<NowPlaying | null> {
  const hit = cache.get(broadcasterId);
  if (hit && Date.now() - hit.at < NOW_PLAYING_CACHE_MS) return Promise.resolve(hit.track);
  let load = inflight.get(broadcasterId);
  if (!load) {
    load = (async () => {
      let track: NowPlaying | null = null;
      try {
        const s = await getSettings(broadcasterId);
        const spotify = await fromSpotify(broadcasterId, s).catch((e) => { console.error("now playing (spotify)", e); return null; });
        track = spotify?.playing ? spotify : (await fromLastfm(s).catch((e) => { console.error("now playing (lastfm)", e); return null; })) ?? spotify;
      } catch (e) {
        console.error("now playing failed", e);
        track = hit?.track ?? null; // keep the last answer through a blip
      }
      cache.set(broadcasterId, { at: Date.now(), track });
      if (cache.size > 300) cache.delete(cache.keys().next().value!);
      return track;
    })().finally(() => inflight.delete(broadcasterId));
    inflight.set(broadcasterId, load);
  }
  return load;
}

// ── Spotify connection (OAuth) ──

/** The Spotify authorize URL for a dashboard user already checked by the caller. */
export async function startSpotifyConnect(broadcasterId: string, dashKey: string): Promise<string | null> {
  if (!spotifyClientId() || !spotifyClientSecret()) return null;
  const state = crypto.randomUUID().replace(/-/g, "");
  await sqlite.execute("DELETE FROM spotify_oauth_states WHERE created_at < ?", [Date.now() - OAUTH_STATE_TTL_MS]);
  await sqlite.execute("INSERT INTO spotify_oauth_states (state, broadcaster_id, dash_key, created_at) VALUES (?,?,?,?)", [state, broadcasterId, dashKey, Date.now()]);
  const params = new URLSearchParams({ client_id: spotifyClientId(), response_type: "code", redirect_uri: spotifyRedirectUri(), scope: SPOTIFY_SCOPE, state, show_dialog: "true" });
  return `https://accounts.spotify.com/authorize?${params}`;
}

/** GET /spotify/callback — trades the code for tokens, then back to the settings page. */
export async function handleSpotifyCallback(url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const row = state ? (await sqlite.execute("SELECT broadcaster_id, dash_key, created_at FROM spotify_oauth_states WHERE state = ?", [state])).rows[0] as any : null;
  if (state) await sqlite.execute("DELETE FROM spotify_oauth_states WHERE state = ?", [state]);
  if (!row || Date.now() - Number(row.created_at) > OAUTH_STATE_TTL_MS) {
    return new Response("This Spotify link has expired — start again from your dashboard's 🎵 Now playing page.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const back = (k: "notice" | "error", msg: string) => {
    const p = new URLSearchParams({ channel: String(row.broadcaster_id), key: String(row.dash_key), [k]: msg });
    return new Response(null, { status: 302, headers: { Location: `${PUBLIC_BASE_URL}/dashboard/music?${p}`, "Cache-Control": "no-store" } });
  };
  const code = url.searchParams.get("code");
  if (!code) return back("error", url.searchParams.get("error") === "access_denied" ? "Spotify wasn't connected (access was declined)." : "Spotify didn't send a code back — try again.");
  try {
    const t = await spotifyToken({ grant_type: "authorization_code", code, redirect_uri: spotifyRedirectUri() });
    let user = "";
    try {
      const me = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(5000) });
      if (me.ok) { const m = await me.json(); user = String(m.display_name || m.id || ""); }
    } catch (_) { /* the name is only for show */ }
    await saveSettings(String(row.broadcaster_id), {
      spotifyRefresh: String(t.refresh_token ?? ""),
      spotifyAccess: String(t.access_token ?? ""),
      spotifyExpires: Date.now() + Number(t.expires_in ?? 3600) * 1000,
      spotifyUser: user,
    });
    return back("notice", `Spotify connected${user ? ` (${user})` : ""}.`);
  } catch (e) {
    console.error("spotify connect failed", e);
    return back("error", "Spotify wouldn't connect. Check the app's redirect URI and that your Spotify account is on its user list, then try again.");
  }
}

// ── Dashboard page (auth is done by the caller; see dashboard.ts) ──

export async function applyNowPlayingForm(broadcasterId: string, form: FormData): Promise<{ ok: boolean; message: string } | null> {
  const intent = String(form.get("intent") ?? "");
  if (intent === "lastfm_set") {
    const user = String(form.get("lastfm_user") ?? "").trim();
    if (!LASTFM_USER_RE.test(user)) return { ok: false, message: "That doesn't look like a Last.fm username (2–15 letters, numbers, _ or -, starting with a letter)." };
    await saveSettings(broadcasterId, { lastfmUser: user });
    return { ok: true, message: `Last.fm set to ${user}.` };
  }
  if (intent === "lastfm_clear") {
    await saveSettings(broadcasterId, { lastfmUser: "" });
    return { ok: true, message: "Last.fm removed." };
  }
  if (intent === "spotify_disconnect") {
    await saveSettings(broadcasterId, { spotifyRefresh: "", spotifyAccess: "", spotifyExpires: 0, spotifyUser: "" });
    return { ok: true, message: "Spotify disconnected." };
  }
  return null;
}

export async function renderNowPlayingPage(d: { broadcasterId: string; broadcasterName: string; key: string; channelKey: string; notice?: string; error?: string }): Promise<string> {
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const btn = (intent: string, label: string, cls = "ghost") =>
    `<form method="post" action="/dashboard/music" class="inline">${hidden}<input type="hidden" name="intent" value="${intent}"><button type="submit" class="${cls}">${label}</button></form>`;
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);
  const s = await getSettings(d.broadcasterId);
  const track = await getNowPlaying(d.broadcasterId);
  const spotifyReady = Boolean(spotifyClientId() && spotifyClientSecret());
  const lastfmReady = Boolean(lastfmKey());
  const themeLink = `${PUBLIC_BASE_URL}/overlay?channel=${encodeURIComponent(d.channelKey)}&panel=theme&music=1`;
  const panelLink = `${PUBLIC_BASE_URL}/overlay?channel=${encodeURIComponent(d.channelKey)}&panel=music`;

  const nowCard = track
    ? `<div class="np">${track.art ? `<img src="${escapeHtml(track.art)}" alt="">` : `<div class="noart">♪</div>`}<div><b>${escapeHtml(track.title)}</b><br>${escapeHtml(track.artist)}${track.album ? ` <span class="muted">· ${escapeHtml(track.album)}</span>` : ""}<br><span class="badge">${track.source === "spotify" ? "Spotify" : "Last.fm"}${track.playing ? "" : " · paused"}</span></div></div>`
    : `<p class="note">Nothing playing right now${s.spotifyRefresh || s.lastfmUser ? "" : " — connect a source below"}. Start a song and reload this page to check.</p>`;

  const spotify = !spotifyReady
    ? `<p class="note">Not set up on this GuildScribe server yet. The operator needs a Spotify app (developer.spotify.com → Create app, "Web API"), with this redirect URI: <code>${escapeHtml(spotifyRedirectUri())}</code>, and its keys in the <code>SPOTIFY_CLIENT_ID</code> and <code>SPOTIFY_CLIENT_SECRET</code> environment variables. While the app is in development mode, add your Spotify account under its <em>User Management</em>.</p>`
    : s.spotifyRefresh
    ? `<div class="controls"><span>✅ Connected${s.spotifyUser ? ` as <strong>${escapeHtml(s.spotifyUser)}</strong>` : ""}.</span>${btn("spotify_disconnect", "Disconnect")}</div>`
    : `<div class="controls"><a class="btn ember" href="/dashboard/music/spotify?${qs}">Connect Spotify</a><span class="muted small">Sign in with the Spotify account you play music on.</span></div>`;

  const lastfm = !lastfmReady
    ? `<p class="note">Not set up on this GuildScribe server yet. The operator needs a free Last.fm API key (last.fm/api/account/create) in the <code>LASTFM_API_KEY</code> environment variable.</p>`
    : `<form method="post" action="/dashboard/music" class="add">${hidden}<input type="hidden" name="intent" value="lastfm_set"><input name="lastfm_user" value="${escapeHtml(s.lastfmUser)}" placeholder="your Last.fm username" maxlength="15" required aria-label="Last.fm username"><button type="submit" class="ember">${s.lastfmUser ? "Update" : "Save"}</button></form>${s.lastfmUser ? `<div class="controls"><span class="muted small">Reading <a href="https://www.last.fm/user/${encodeURIComponent(s.lastfmUser)}" target="_blank" rel="noopener">last.fm/user/${escapeHtml(s.lastfmUser)}</a></span>${btn("lastfm_clear", "Remove")}</div>` : ""}`;

  const body = `<header class="dash-top"><div><span class="pill">Stream · Now playing</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>Show the song you're playing on stream. Connect <strong>Spotify</strong> directly, or use <strong>Last.fm</strong> for <strong>Apple Music</strong> (or any player that scrobbles). With both, Spotify shows while it's playing and Last.fm otherwise.</p>
<h2>Playing now</h2>${nowCard}
<h2>Spotify</h2>${spotify}
<h2>Apple Music (via Last.fm)</h2>
<p class="muted">Apple doesn't share what's playing live, so Apple Music goes through Last.fm: make a free Last.fm account, install a scrobbler that sends Apple Music to it — on a Mac, <em>NepTunes</em> or <em>Scrobbles for Last.fm</em>; on Windows, <em>AMWin-RP</em> (turn on its Last.fm scrobbling) — then enter your Last.fm username. The song shows a few seconds after it starts.</p>
${lastfm}
<h2>Put it on stream</h2>
<ul><li><strong>In the theme</strong> (every scene, top-left corner): add <code>&amp;music=1</code> to your theme link, or tick <em>Now playing</em> on the overlay setup page. E.g. <code>${escapeHtml(themeLink)}</code></li>
<li><strong>On its own</strong>, anywhere: a Browser source with <code>${escapeHtml(panelLink)}</code> at 520 × 120.</li></ul>
<p class="muted small">It hides itself while nothing is playing.</p>`;

  return scrollDoc(`${name} — Now playing`, body, {
    width: 1000,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}form.inline{display:inline;margin:0}form.inline button{padding:5px 12px;font-size:.78rem}form.add{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}form.add input{flex:1 1 240px;padding:9px 12px}.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.np{display:flex;gap:16px;align-items:center;padding:12px;border:1px solid var(--edge);border-radius:8px;background:#efe5c8}.np img,.np .noart{width:84px;height:84px;border-radius:6px;object-fit:cover;flex:none}.np .noart{display:flex;align-items:center;justify-content:center;font-size:40px;background:#dccea8}code{word-break:break-all}`,
  });
}

// ── Standalone overlay (/overlay?panel=music) ──

export function renderNowPlayingOverlay(channelKey: string): string {
  const cfgJson = JSON.stringify({ channel: channelKey }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GuildScribe overlay · now playing</title>
<style>*{box-sizing:border-box}html,body{margin:0;background:transparent;overflow:hidden;font-family:Georgia,"Times New Roman",serif;color:#f4eadb;text-shadow:0 1px 2px #000c}
#np{position:absolute;left:10px;top:10px;right:10px;height:100px;display:flex;gap:14px;align-items:center;padding:10px 16px 10px 10px;border:1px solid #b97545;border-radius:12px;background:rgba(21,18,15,.84);box-shadow:0 4px 14px #0008;transition:opacity .6s,transform .6s}
#np.off{opacity:0;transform:translateY(-8px)}
#art{width:80px;height:80px;border-radius:8px;object-fit:cover;flex:none;background:#3a2c20}
#np .t{min-width:0;flex:1}#np small{display:block;color:#e6a56e;font-size:13px;letter-spacing:.12em;text-transform:uppercase}
#title{font-size:24px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#artist{font-size:18px;color:#cbb9a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#bar{height:4px;margin-top:6px;border-radius:2px;background:#ffffff22;overflow:hidden}#bar i{display:block;height:100%;width:0;background:#e6a56e}</style></head>
<body><div id="np" class="off"><img id="art" alt=""><div class="t"><small id="src">♪ Now playing</small><div id="title"></div><div id="artist"></div><div id="bar" hidden><i></i></div></div></div>
<script>const CFG=${cfgJson};${NOW_PLAYING_CLIENT}
nowPlaying({card:document.getElementById("np"),title:document.getElementById("title"),artist:document.getElementById("artist"),art:document.getElementById("art"),bar:document.getElementById("bar"),src:document.getElementById("src")},CFG.channel,new URLSearchParams(location.search).get("always")==="1")</script></body></html>`;
}

/** Shared client (the theme uses it too): polls every 5 s, ticks the progress bar
 * between polls, hides the card while nothing plays. Viewer-facing text goes in
 * through textContent; the art URL only ever comes from Spotify or Last.fm. */
export const NOW_PLAYING_CLIENT = `
// No cover art (some Last.fm tracks): a gold note on a dark disc instead.
const NOTE="data:image/svg+xml,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" rx="8" fill="#3a2614"/><path d="M50 18v32a9 7 0 1 1-4-6V28l-16 4v22a9 7 0 1 1-4-6V26z" fill="#e8c25a"/></svg>');
function nowPlaying(el,channel,demo,isOn){let cur=null,got=0;
  const DEMO={title:"Tavern Song (Demo)",artist:"The Bards of Waterdeep",art:"",playing:true,source:"spotify",progressMs:60000,durationMs:200000};
  function show(t){cur=t;got=Date.now();const on=!!(t&&t.playing&&t.title);el.card.classList.toggle("off",!on);if(!on)return;
    el.title.textContent=t.title;el.title.title=t.title;el.artist.textContent=t.artist+(t.album?" — "+t.album:"");
    if(el.src)el.src.textContent="♪ Now playing"+(t.source==="spotify"?" · Spotify":"");
    const art=t.art||NOTE;if(el.art.getAttribute("src")!==art)el.art.src=art;
    if(el.bar)el.bar.hidden=!t.durationMs;tick()}
  function tick(){if(!el.bar||!cur||!cur.durationMs)return;const p=Math.min(1,((cur.progressMs||0)+(cur.playing?Date.now()-got:0))/cur.durationMs);el.bar.firstElementChild.style.width=(p*100).toFixed(1)+"%"}
  async function poll(){if(isOn&&!isOn())return;try{const r=await fetch("/overlay/nowplaying?channel="+encodeURIComponent(channel),{cache:"no-store"});const d=await r.json();
    if(d&&d.ok)show(d.track||(demo?DEMO:null))}catch(e){}}
  if(demo)show(DEMO);poll();setInterval(poll,5000);setInterval(tick,1000)}
`;

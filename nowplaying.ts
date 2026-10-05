// GuildScribe — "Now playing": the song the streamer has on, shown on stream.
//
// Every channel sets itself up on its dashboard's 🎵 Now playing page, a
// step-by-step guide that needs nobody else: no server keys, no developer.
//   • Spotify — the streamer makes their own (free) Spotify app, pastes its
//     Client ID and secret, and connects (OAuth, user-read-currently-playing).
//     Their own app means Spotify's development-mode user list only needs
//     their own account. Keys are checked with Spotify before they're saved.
//   • Apple Music — Apple has no live "now playing" API, so it goes through
//     Last.fm: a scrobbler app reports the song, and the streamer enters their
//     own free Last.fm API key and username (checked with Last.fm on save).
//   • Spotify via Last.fm — the same Last.fm route with Spotify's built-in
//     scrobbling, for streamers who'd rather not make a Spotify app.
// With Spotify and Last.fm both set up, Spotify wins while it's playing.
//
// Optional server-wide fallbacks (a channel's own keys always win):
// SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET and LASTFM_API_KEY.
//
//   GET  /overlay/nowplaying?channel=<id|login>   public JSON: { ok, track } (track null when nothing plays)
//   GET  /overlay?channel=<id|login>&panel=music  standalone overlay (520×120)
//   GET  /dashboard/music · POST /dashboard/music  the setup guide (dashboard key + mod login; dashboard.ts)
//   GET  /dashboard/music/spotify                  starts the Spotify connection
//   GET  /spotify/callback                         Spotify's OAuth return (the same for every channel)
//
// The theme shows it with &music=1 (overlay_theme.ts): top-left in gameplay,
// under the "Be right back" / "Just chatting" card in those scenes.
// Lookups are cached a few seconds per channel and shared between identical
// requests, so any number of open sources cost one Spotify/Last.fm call per
// NOW_PLAYING_CACHE_MS. Only song details ever leave the server: keys,
// secrets and tokens are never sent to a page (the guide shows them masked).

import { sqlite } from "./sqlite.ts";
import { escapeHtml } from "./utils.ts";
import { PUBLIC_BASE_URL } from "./config.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

const NOW_PLAYING_CACHE_MS = 4_000;
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const SPOTIFY_SCOPE = "user-read-currently-playing";
const LASTFM_USER_RE = /^[A-Za-z][A-Za-z0-9_-]{1,14}$/;
const KEY_RE = /^[0-9a-f]{32}$/i; // Spotify client ID/secret and Last.fm API keys are all 32 hex characters
const LASTFM_BLANK_ART = "2a96cbd8b46e442fc41c2b86b821562f"; // Last.fm's grey star placeholder

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
  // Per-channel keys (the self-serve setup guide); added after the table first shipped.
  for (const col of ["spotify_client_id", "spotify_client_secret", "lastfm_key", "setup_path"]) {
    try { await sqlite.execute(`ALTER TABLE now_playing ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`); } catch (_) { /* already there */ }
  }
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS spotify_oauth_states (
      state TEXT PRIMARY KEY, broadcaster_id TEXT NOT NULL, dash_key TEXT NOT NULL, created_at INTEGER NOT NULL
    )`,
  );
}

/** !dndbot leave (purge or not): forget the keys, the Spotify connection and the Last.fm name. */
export async function purgeNowPlayingData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM now_playing WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM spotify_oauth_states WHERE broadcaster_id = ?", [broadcasterId]);
  cache.delete(broadcasterId);
}

type SetupPath = "spotify" | "apple" | "spotifylastfm";
const PATHS: SetupPath[] = ["spotify", "apple", "spotifylastfm"];

type Settings = {
  lastfmUser: string;
  lastfmKey: string;
  spotifyUser: string;
  spotifyRefresh: string;
  spotifyAccess: string;
  spotifyExpires: number;
  spotifyClientId: string;
  spotifyClientSecret: string;
  setupPath: string;
};

async function getSettings(broadcasterId: string): Promise<Settings> {
  const r = (await sqlite.execute("SELECT * FROM now_playing WHERE broadcaster_id = ?", [broadcasterId])).rows[0] as any;
  return {
    lastfmUser: String(r?.lastfm_user ?? ""),
    lastfmKey: String(r?.lastfm_key ?? ""),
    spotifyUser: String(r?.spotify_user ?? ""),
    spotifyRefresh: String(r?.spotify_refresh ?? ""),
    spotifyAccess: String(r?.spotify_access ?? ""),
    spotifyExpires: Number(r?.spotify_expires ?? 0),
    spotifyClientId: String(r?.spotify_client_id ?? ""),
    spotifyClientSecret: String(r?.spotify_client_secret ?? ""),
    setupPath: String(r?.setup_path ?? ""),
  };
}

async function saveSettings(broadcasterId: string, patch: Partial<Settings>) {
  const s = { ...(await getSettings(broadcasterId)), ...patch };
  await sqlite.execute(
    `INSERT INTO now_playing (broadcaster_id, lastfm_user, lastfm_key, spotify_user, spotify_refresh, spotify_access, spotify_expires, spotify_client_id, spotify_client_secret, setup_path)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET lastfm_user = excluded.lastfm_user, lastfm_key = excluded.lastfm_key, spotify_user = excluded.spotify_user,
       spotify_refresh = excluded.spotify_refresh, spotify_access = excluded.spotify_access, spotify_expires = excluded.spotify_expires,
       spotify_client_id = excluded.spotify_client_id, spotify_client_secret = excluded.spotify_client_secret, setup_path = excluded.setup_path`,
    [broadcasterId, s.lastfmUser, s.lastfmKey, s.spotifyUser, s.spotifyRefresh, s.spotifyAccess, s.spotifyExpires, s.spotifyClientId, s.spotifyClientSecret, s.setupPath],
  );
  cache.delete(broadcasterId);
}

/** The channel's own Spotify app keys, else the server's (optional), else null. */
function spotifyCreds(s: Settings): { id: string; secret: string; own: boolean } | null {
  if (s.spotifyClientId && s.spotifyClientSecret) return { id: s.spotifyClientId, secret: s.spotifyClientSecret, own: true };
  const id = Deno.env.get("SPOTIFY_CLIENT_ID") ?? "", secret = Deno.env.get("SPOTIFY_CLIENT_SECRET") ?? "";
  return id && secret ? { id, secret, own: false } : null;
}

/** The channel's own Last.fm API key, else the server's (optional). */
const lastfmKeyFor = (s: Settings) => s.lastfmKey || (Deno.env.get("LASTFM_API_KEY") ?? "");

// ── Spotify ──

async function spotifyToken(creds: { id: string; secret: string }, body: Record<string, string>): Promise<any> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${creds.id}:${creds.secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`spotify token ${res.status}: ${data?.error ?? ""}`);
  return data;
}

/** Checks a Client ID + secret pair with Spotify (an app-only token request). */
async function checkSpotifyKeys(id: string, secret: string): Promise<"ok" | "invalid" | "unreachable"> {
  try {
    await spotifyToken({ id, secret }, { grant_type: "client_credentials" });
    return "ok";
  } catch (e) {
    return /spotify token 4\d\d/.test(String(e)) ? "invalid" : "unreachable";
  }
}

/** A live access token, refreshed when it's within a minute of expiring. "" when not connected or revoked. */
async function spotifyAccess(broadcasterId: string, s: Settings): Promise<string> {
  const creds = spotifyCreds(s);
  if (!s.spotifyRefresh || !creds) return "";
  if (s.spotifyAccess && Date.now() < s.spotifyExpires - 60_000) return s.spotifyAccess;
  try {
    const t = await spotifyToken(creds, { grant_type: "refresh_token", refresh_token: s.spotifyRefresh });
    await saveSettings(broadcasterId, {
      spotifyAccess: String(t.access_token),
      spotifyExpires: Date.now() + Number(t.expires_in ?? 3600) * 1000,
      ...(t.refresh_token ? { spotifyRefresh: String(t.refresh_token) } : {}),
    });
    return String(t.access_token);
  } catch (e) {
    // invalid_grant/invalid_client: access was removed in Spotify, or the app changed — forget the connection.
    if (/invalid_grant|invalid_client/.test(String(e))) await saveSettings(broadcasterId, { spotifyRefresh: "", spotifyAccess: "", spotifyExpires: 0, spotifyUser: "" });
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

/** Checks a Last.fm API key and username together (user.getinfo). */
async function checkLastfm(key: string, user: string): Promise<"ok" | "bad_key" | "no_user" | "unreachable"> {
  try {
    const params = new URLSearchParams({ method: "user.getinfo", user, api_key: key, format: "json" });
    const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`, { signal: AbortSignal.timeout(5000) });
    const d = await res.json().catch(() => null);
    if (d?.user) return "ok";
    const code = Number(d?.error ?? 0);
    if (code === 6) return "no_user";
    if (code === 10 || code === 26 || code === 4) return "bad_key";
    return "unreachable";
  } catch (_) {
    return "unreachable";
  }
}

async function fromLastfm(s: Settings): Promise<NowPlaying | null> {
  const key = lastfmKeyFor(s);
  if (!s.lastfmUser || !key) return null;
  const params = new URLSearchParams({ method: "user.getrecenttracks", user: s.lastfmUser, api_key: key, format: "json", limit: "1" });
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

/** The Spotify authorize URL for a dashboard user already checked by the caller; null without keys. */
export async function startSpotifyConnect(broadcasterId: string, dashKey: string): Promise<string | null> {
  const creds = spotifyCreds(await getSettings(broadcasterId));
  if (!creds) return null;
  const state = crypto.randomUUID().replace(/-/g, "");
  await sqlite.execute("DELETE FROM spotify_oauth_states WHERE created_at < ?", [Date.now() - OAUTH_STATE_TTL_MS]);
  await sqlite.execute("INSERT INTO spotify_oauth_states (state, broadcaster_id, dash_key, created_at) VALUES (?,?,?,?)", [state, broadcasterId, dashKey, Date.now()]);
  const params = new URLSearchParams({ client_id: creds.id, response_type: "code", redirect_uri: spotifyRedirectUri(), scope: SPOTIFY_SCOPE, state, show_dialog: "true" });
  return `https://accounts.spotify.com/authorize?${params}`;
}

/** GET /spotify/callback — trades the code for tokens with the channel's app, then back to the guide. */
export async function handleSpotifyCallback(url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const row = state ? (await sqlite.execute("SELECT broadcaster_id, dash_key, created_at FROM spotify_oauth_states WHERE state = ?", [state])).rows[0] as any : null;
  if (state) await sqlite.execute("DELETE FROM spotify_oauth_states WHERE state = ?", [state]);
  if (!row || Date.now() - Number(row.created_at) > OAUTH_STATE_TTL_MS) {
    return new Response("This Spotify link has expired — start again from your dashboard's 🎵 Now playing page.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const channelId = String(row.broadcaster_id);
  const back = (k: "notice" | "error", msg: string) => {
    const p = new URLSearchParams({ channel: channelId, key: String(row.dash_key), path: "spotify", [k]: msg });
    return new Response(null, { status: 302, headers: { Location: `${PUBLIC_BASE_URL}/dashboard/music?${p}#step-connect`, "Cache-Control": "no-store" } });
  };
  const code = url.searchParams.get("code");
  if (!code) return back("error", url.searchParams.get("error") === "access_denied" ? "Spotify wasn't connected — access was declined. Press Connect Spotify again and choose Agree." : "Spotify didn't send a code back — press Connect Spotify again.");
  const creds = spotifyCreds(await getSettings(channelId));
  if (!creds) return back("error", "Your Spotify keys are missing — paste them in step 3 first.");
  try {
    const t = await spotifyToken(creds, { grant_type: "authorization_code", code, redirect_uri: spotifyRedirectUri() });
    let user = "";
    try {
      const me = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(5000) });
      if (me.ok) { const m = await me.json(); user = String(m.display_name || m.id || ""); }
    } catch (_) { /* the name is only for show */ }
    await saveSettings(channelId, {
      spotifyRefresh: String(t.refresh_token ?? ""),
      spotifyAccess: String(t.access_token ?? ""),
      spotifyExpires: Date.now() + Number(t.expires_in ?? 3600) * 1000,
      spotifyUser: user,
      setupPath: "spotify",
    });
    return back("notice", `Spotify connected${user ? ` as ${user}` : ""}. Play a song to test it below.`);
  } catch (e) {
    console.error("spotify connect failed", e);
    return back("error", "Spotify wouldn't finish connecting. Check that the Redirect URI in your Spotify app is exactly the one in step 1 and that your account is under User Management (step 2), then press Connect Spotify again.");
  }
}

// ── The setup guide (auth is done by the caller; see dashboard.ts) ──

const mask = (v: string) => (v ? `••••${v.slice(-4)}` : "");

export async function applyNowPlayingForm(broadcasterId: string, form: FormData): Promise<{ ok: boolean; message: string; path?: string } | null> {
  const intent = String(form.get("intent") ?? "");
  const s = await getSettings(broadcasterId);

  if (intent === "spotify_keys") {
    const id = String(form.get("client_id") ?? "").trim();
    const secret = String(form.get("client_secret") ?? "").trim();
    if (!KEY_RE.test(id)) return { ok: false, path: "spotify", message: "That Client ID doesn't look right — it's 32 letters and numbers, under Settings → Basic Information in your Spotify app." };
    if (!KEY_RE.test(secret)) return { ok: false, path: "spotify", message: "That Client secret doesn't look right — press View client secret in your Spotify app and copy all 32 characters." };
    const check = await checkSpotifyKeys(id, secret);
    if (check === "invalid") return { ok: false, path: "spotify", message: "Spotify didn't accept that Client ID and secret together. Copy both again from the same app (Settings → Basic Information)." };
    if (check === "unreachable") return { ok: false, path: "spotify", message: "Couldn't reach Spotify to check the keys — try again in a minute." };
    // A different app's connection can't carry over: its refresh token belongs to the old app.
    const sameApp = id === s.spotifyClientId;
    await saveSettings(broadcasterId, { spotifyClientId: id, spotifyClientSecret: secret, setupPath: "spotify", ...(sameApp ? {} : { spotifyRefresh: "", spotifyAccess: "", spotifyExpires: 0, spotifyUser: "" }) });
    return { ok: true, path: "spotify", message: "Spotify accepted your keys. Next: press Connect Spotify (step 4)." };
  }
  if (intent === "spotify_keys_clear") {
    await saveSettings(broadcasterId, { spotifyClientId: "", spotifyClientSecret: "", spotifyRefresh: "", spotifyAccess: "", spotifyExpires: 0, spotifyUser: "" });
    return { ok: true, path: "spotify", message: "Spotify keys removed (and disconnected)." };
  }
  if (intent === "spotify_disconnect") {
    await saveSettings(broadcasterId, { spotifyRefresh: "", spotifyAccess: "", spotifyExpires: 0, spotifyUser: "" });
    return { ok: true, path: "spotify", message: "Spotify disconnected." };
  }
  if (intent === "lastfm_save") {
    const path = PATHS.includes(String(form.get("path")) as SetupPath) ? String(form.get("path")) : "apple";
    const user = String(form.get("lastfm_user") ?? "").trim();
    // A blank key field keeps the key already saved (it's never shown back).
    const typedKey = String(form.get("lastfm_key") ?? "").trim();
    const key = typedKey || lastfmKeyFor(s);
    if (!KEY_RE.test(key)) return { ok: false, path, message: "That API key doesn't look right — it's the 32-character \"API key\" Last.fm showed after you created it (not the shared secret)." };
    if (!LASTFM_USER_RE.test(user)) return { ok: false, path, message: "That doesn't look like a Last.fm username (2–15 letters, numbers, _ or -, starting with a letter)." };
    const check = await checkLastfm(key, user);
    if (check === "bad_key") return { ok: false, path, message: "Last.fm didn't accept that API key. Copy the \"API key\" again from last.fm/api/accounts." };
    if (check === "no_user") return { ok: false, path, message: `Last.fm has no user called "${user}". Check the spelling — it's the name in your profile link, last.fm/user/<name>.` };
    if (check === "unreachable") return { ok: false, path, message: "Couldn't reach Last.fm to check — try again in a minute." };
    await saveSettings(broadcasterId, { lastfmUser: user, lastfmKey: typedKey || s.lastfmKey, setupPath: path });
    return { ok: true, path, message: `Last.fm accepted your key and found ${user}. Play a song to test it below.` };
  }
  if (intent === "lastfm_clear") {
    await saveSettings(broadcasterId, { lastfmUser: "", lastfmKey: "" });
    return { ok: true, path: s.setupPath || "apple", message: "Last.fm removed." };
  }
  return null;
}

const COPY = (v: string) => `<button type="button" class="ghost copy" data-copy="${escapeHtml(v)}">Copy</button>`;
const FIELD = (label: string, v: string, note = "") => `<tr><th>${label}</th><td><code>${escapeHtml(v)}</code>${note ? ` <span class="muted small">${note}</span>` : ""}</td><td>${COPY(v)}</td></tr>`;

function stepHtml(n: number, id: string, title: string, done: boolean, body: string, locked = false): string {
  return `<section class="step${done ? " done" : ""}${locked ? " locked" : ""}" id="step-${id}"><h3><span class="num">${done ? "✓" : n}</span>${title}</h3><div class="sbody">${body}</div></section>`;
}

export async function renderNowPlayingPage(d: { broadcasterId: string; broadcasterName: string; key: string; channelKey: string; path?: string; notice?: string; error?: string }): Promise<string> {
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const btn = (intent: string, label: string, cls = "ghost", confirm = "") =>
    `<form method="post" action="/dashboard/music" class="inline"${confirm ? ` onsubmit="return confirm('${confirm}')"` : ""}>${hidden}<input type="hidden" name="intent" value="${intent}"><button type="submit" class="${cls}">${label}</button></form>`;
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);
  const s = await getSettings(d.broadcasterId);
  const creds = spotifyCreds(s);
  const lastfmKey = lastfmKeyFor(s);
  const spotifyConnected = Boolean(s.spotifyRefresh && creds);
  const lastfmReady = Boolean(s.lastfmUser && lastfmKey);
  const path: SetupPath | "" = PATHS.includes(d.path as SetupPath) ? d.path as SetupPath
    : PATHS.includes(s.setupPath as SetupPath) ? s.setupPath as SetupPath
    : spotifyConnected || s.spotifyClientId ? "spotify" : s.lastfmUser ? "apple" : "";

  const base = `${PUBLIC_BASE_URL}/overlay?channel=${encodeURIComponent(d.channelKey)}`;
  const overlayLinks = `<table class="kv">${FIELD("Gameplay theme", `${base}&panel=theme&music=1`)}${FIELD("Be right back theme", `${base}&panel=theme&scene=brb&music=1`)}${FIELD("Just chatting theme", `${base}&panel=theme&scene=chat&music=1`)}${FIELD("On its own (520 × 120)", `${base}&panel=music`)}</table>`;

  const chooser = `<div class="paths">${[
    ["spotify", "🟢 Spotify", "Connect your Spotify directly. Instant, with a progress bar. About 10 minutes, one time."],
    ["apple", "🍎 Apple Music", "Through Last.fm (Apple doesn't share what's playing live). Needs a small free scrobbler app on your computer."],
    ["spotifylastfm", "🎧 Spotify via Last.fm", "No Spotify app to make — Last.fm reads Spotify for you. Can lag a little, no progress bar."],
  ].map(([k, t, b]) => `<a class="path${path === k ? " on" : ""}" href="/dashboard/music?${qs}&path=${k}"><b>${t}</b><span>${b}</span></a>`).join("")}</div>`;

  const testStep = (n: number, done: boolean) => stepHtml(n, "test", "Test it", false,
    `<p>Play a song${path === "apple" ? " in Apple Music" : " on Spotify"}. It shows up here within a few seconds${path === "spotify" ? "" : " (Last.fm can take up to half a minute)"}:</p>
<div class="live" id="live"><div class="noart">♪</div><div><b id="lt">Checking…</b><br><span id="la" class="muted"></span></div></div>
${done ? "" : `<p class="muted small">Finish the steps above first.</p>`}`);
  const streamStep = (n: number) => stepHtml(n, "stream", "Put it on stream", false,
    `<p>In OBS, open each GuildScribe theme source (right-click → Properties) and paste the matching link below as its URL — it's your theme with <code>&amp;music=1</code> added. If your links already have other extras on them, just add <code>&amp;music=1</code> to the end instead. The song shows top-left in Gameplay and under the "Be right back" / "Just chatting" message in those scenes, and turns fully transparent while nothing plays.</p>${overlayLinks}
<p class="muted small">Prefer it somewhere else? Add a new Browser source with the "On its own" link at 520 × 120. All your overlays: <a href="/overlays?channel=${encodeURIComponent(d.broadcasterId)}" target="_blank" rel="noopener">overlay setup page</a>.</p>`);

  const lastfmForm = (p: SetupPath) => `<form method="post" action="/dashboard/music" class="grid2">${hidden}<input type="hidden" name="intent" value="lastfm_save"><input type="hidden" name="path" value="${p}">
<label>Last.fm username<input name="lastfm_user" value="${escapeHtml(s.lastfmUser)}" placeholder="the name in last.fm/user/…" maxlength="15" required autocomplete="off"></label>
<label>API key<input name="lastfm_key" placeholder="${s.lastfmKey ? `saved (${mask(s.lastfmKey)}) — leave blank to keep` : "32 letters and numbers"}" maxlength="40" ${s.lastfmKey || Deno.env.get("LASTFM_API_KEY") ? "" : "required"} autocomplete="off" spellcheck="false"></label>
<button type="submit" class="ember">${lastfmReady ? "Check &amp; update" : "Check &amp; save"}</button></form>
${lastfmReady ? `<p class="ok-line">✓ Reading <a href="https://www.last.fm/user/${encodeURIComponent(s.lastfmUser)}" target="_blank" rel="noopener">last.fm/user/${escapeHtml(s.lastfmUser)}</a>${s.lastfmKey ? ` with your key ${mask(s.lastfmKey)}` : ""}. ${btn("lastfm_clear", "Remove", "ghost", "Remove the Last.fm setup?")}</p>` : ""}`;

  const lastfmKeyStep = (n: number) => stepHtml(n, "lfmkey", "Get a free Last.fm API key", Boolean(s.lastfmKey || lastfmKey && lastfmReady),
    `<ol><li>Open <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">last.fm/api/account/create</a> (log in if asked).</li>
<li>Fill it in like this, then press <strong>Submit</strong>:<table class="kv"><tr><th>Contact email</th><td colspan="2">your own email address</td></tr>${FIELD("Application name", "GuildScribe Now Playing")}${FIELD("Application description", "Shows my current song on stream")}<tr><th>Callback URL</th><td colspan="2" class="muted">leave blank</td></tr><tr><th>Application homepage</th><td colspan="2" class="muted">leave blank</td></tr></table></li>
<li>Last.fm shows an <strong>API key</strong> and a <strong>Shared secret</strong>. You only need the <strong>API key</strong> — paste it in the next step. (Lost it? It's listed at <a href="https://www.last.fm/api/accounts" target="_blank" rel="noopener">last.fm/api/accounts</a>.)</li></ol>`);

  let guide = "";
  if (path === "spotify") {
    const keysSaved = Boolean(s.spotifyClientId && s.spotifyClientSecret);
    guide = [
      stepHtml(1, "app", "Create your Spotify app (free)", keysSaved,
        `<ol><li>Open the <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">Spotify Developer Dashboard</a> and log in with the Spotify account you play music on. Accept the developer terms if it asks.</li>
<li>Press <strong>Create app</strong> and fill it in like this:<table class="kv">${FIELD("App name", "GuildScribe Now Playing")}${FIELD("App description", "Shows my current song on stream")}<tr><th>Website</th><td colspan="2" class="muted">leave blank</td></tr>${FIELD("Redirect URIs", spotifyRedirectUri(), "— paste it, then press <strong>Add</strong>")}<tr><th>APIs used</th><td colspan="2">tick <strong>Web API</strong></td></tr></table></li>
<li>Tick the terms box and press <strong>Save</strong>.</li></ol>
<p class="muted small">The Redirect URI must match exactly — use the Copy button. If Spotify asks you to verify your email or shows a notice about developer access (it sometimes asks for Premium), do what it says before carrying on.</p>`),
      stepHtml(2, "users", "Let your own account use it", keysSaved,
        `<p>In your new app, open <strong>Settings → User Management</strong>, add your name and the <strong>email of your Spotify account</strong>, and save. New apps only let listed accounts connect — this is the only one yours needs.</p>`),
      stepHtml(3, "keys", "Paste your app's keys", keysSaved,
        `<p>In your app, open <strong>Settings → Basic Information</strong>. Copy the <strong>Client ID</strong>, then press <strong>View client secret</strong> and copy that too. They're checked with Spotify when you save, and the secret is never shown again.</p>
${keysSaved ? `<p class="ok-line">✓ Keys saved and accepted by Spotify (Client ID ${mask(s.spotifyClientId)}). ${btn("spotify_keys_clear", "Remove keys", "ghost", "Remove your Spotify keys? This also disconnects Spotify.")}</p><details><summary>Replace the keys</summary>` : ""}
<form method="post" action="/dashboard/music" class="grid2">${hidden}<input type="hidden" name="intent" value="spotify_keys">
<label>Client ID<input name="client_id" placeholder="32 letters and numbers" maxlength="40" required autocomplete="off" spellcheck="false"></label>
<label>Client secret<input name="client_secret" type="password" placeholder="32 letters and numbers" maxlength="40" required autocomplete="off"></label>
<button type="submit" class="ember">Check &amp; save keys</button></form>${keysSaved ? "</details>" : ""}
${!keysSaved && creds && !creds.own ? `<p class="muted small">This GuildScribe server also has a shared Spotify app, so you could skip to step 4 — but that only works if the server's owner added your Spotify account to it. Your own app always works.</p>` : ""}`),
      stepHtml(4, "connect", "Connect Spotify", spotifyConnected,
        spotifyConnected
          ? `<p class="ok-line">✓ Connected${s.spotifyUser ? ` as <strong>${escapeHtml(s.spotifyUser)}</strong>` : ""}. ${btn("spotify_disconnect", "Disconnect", "ghost", "Disconnect Spotify?")}</p>`
          : creds
          ? `<p>Press the button, sign in to Spotify if asked, and choose <strong>Agree</strong>. You'll come straight back here.</p><p><a class="btn ember" href="/dashboard/music/spotify?${qs}">Connect Spotify</a></p>
<p class="muted small">If Spotify shows <em>INVALID_CLIENT: Invalid redirect URI</em>, the Redirect URI in step 1 doesn't match — copy it again. If it says your account isn't registered for the app, redo step 2.</p>`
          : `<p class="muted">Save your keys in step 3 first.</p>`, !creds),
      testStep(5, spotifyConnected),
      streamStep(6),
    ].join("");
  } else if (path === "apple") {
    guide = [
      stepHtml(1, "account", "Make a free Last.fm account", lastfmReady,
        `<p>Sign up at <a href="https://www.last.fm/join" target="_blank" rel="noopener">last.fm/join</a> (skip if you have one). Your username is the name in your profile link, <code>last.fm/user/&lt;name&gt;</code>.</p>`),
      stepHtml(2, "scrobbler", "Install a scrobbler for Apple Music", lastfmReady,
        `<p>A scrobbler is a small app that tells Last.fm what Apple Music is playing. Install one and log it in to your Last.fm account:</p>
<ul><li><strong>Mac:</strong> <em>Scrobbles for Last.fm</em> (free, Mac App Store) or <em>NepTunes</em>.</li>
<li><strong>Windows:</strong> <em>AMWin-RP</em> (free, on GitHub) — in its settings, turn on <strong>Last.fm scrobbling</strong> and log in.</li></ul>
<p class="muted small">Check it works: play a song, then open your Last.fm profile — it should say <em>Scrobbling now</em> at the top of your recent tracks. Keep the scrobbler running while you stream.</p>`),
      lastfmKeyStep(3),
      stepHtml(4, "lfm", "Enter your Last.fm details", lastfmReady, lastfmForm("apple")),
      testStep(5, lastfmReady),
      streamStep(6),
    ].join("");
  } else if (path === "spotifylastfm") {
    guide = [
      stepHtml(1, "account", "Make a free Last.fm account", lastfmReady,
        `<p>Sign up at <a href="https://www.last.fm/join" target="_blank" rel="noopener">last.fm/join</a> (skip if you have one). Your username is the name in your profile link, <code>last.fm/user/&lt;name&gt;</code>.</p>`),
      stepHtml(2, "link", "Link Spotify to Last.fm", lastfmReady,
        `<p>Open <a href="https://www.last.fm/settings/applications" target="_blank" rel="noopener">last.fm/settings/applications</a>, find <strong>Spotify Scrobbling</strong> and press <strong>Connect</strong>, then sign in to Spotify and agree. Nothing to install.</p>
<p class="muted small">Check it works: play a song on Spotify, then open your Last.fm profile — it should say <em>Scrobbling now</em>.</p>`),
      lastfmKeyStep(3),
      stepHtml(4, "lfm", "Enter your Last.fm details", lastfmReady, lastfmForm("spotifylastfm")),
      testStep(5, lastfmReady),
      streamStep(6),
    ].join("");
  }

  const otherSetup = path === "spotify" && lastfmReady
    ? `<p class="muted small">Last.fm is also set up (${escapeHtml(s.lastfmUser)}) — it shows whenever Spotify isn't playing.</p>`
    : path && path !== "spotify" && spotifyConnected
    ? `<p class="muted small">Spotify is also connected — it shows while it's playing, and Last.fm otherwise.</p>`
    : "";

  const body = `<header class="dash-top"><div><span class="pill">Stream · Now playing</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>Show the song you're playing on stream. Pick what you listen with and follow the steps — everything is set up right here, no help needed. Each step ticks off once it's done.</p>
<h2>1 · What do you listen with?</h2>${chooser}
${path ? `<h2>2 · Set it up</h2>${otherSetup}${guide}` : `<p class="note">Pick one above to see its steps.</p>`}
<script>
document.addEventListener("click",async e=>{const b=e.target.closest("button[data-copy]");if(!b)return;try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent="Copied!"}catch(_){b.textContent="Select & copy"}setTimeout(()=>{b.textContent="Copy"},1500)});
(function(){const t=document.getElementById("lt"),a=document.getElementById("la");if(!t)return;
  async function poll(){try{const r=await fetch("/overlay/nowplaying?channel=${encodeURIComponent(d.broadcasterId)}",{cache:"no-store"});const j=await r.json();const k=j&&j.track;
    const box=t.closest(".live");box.classList.toggle("on",!!(k&&k.playing));
    if(k&&k.playing){t.textContent="✓ "+k.title;a.textContent=k.artist+" · via "+(k.source==="spotify"?"Spotify":"Last.fm")}
    else if(k){t.textContent="Paused: "+k.title;a.textContent="Press play — the overlay hides while paused."}
    else{t.textContent="Nothing playing yet";a.textContent="Start a song and wait a few seconds."}}catch(_){}}
  poll();setInterval(poll,5000)})();
</script>`;

  return scrollDoc(`${name} — Now playing`, body, {
    width: 1000,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}
form.inline{display:inline;margin:0}form.inline button{padding:5px 12px;font-size:.78rem}
.paths{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:12px;margin:10px 0 6px}
.path{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border:1px solid var(--edge);border-radius:8px;background:#efe5c8;color:inherit;text-decoration:none}
.path b{font-size:1.1rem}.path span{font-size:.9rem;color:var(--ink-3)}.path.on{border:2px solid var(--seal);background:#f6ecd0;box-shadow:0 3px 10px #6b44182b}
.step{position:relative;margin:14px 0;padding:14px 18px 10px 58px;border:1px solid var(--edge);border-radius:8px;background:#efe5c8b0}
.step h3{margin:0 0 6px;font-size:1.1rem}.step .num{position:absolute;left:14px;top:12px;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;background:var(--seal);color:#fff8ee}
.step.done{background:#e3ebd2b0}.step.done .num{background:var(--ok)}.step.locked{opacity:.6}
.step ol,.step ul{margin:6px 0 8px;padding-left:1.3em}.step li{margin:4px 0}
table.kv{border-collapse:collapse;margin:8px 0;width:100%}table.kv th{text-align:left;font-weight:600;padding:5px 10px 5px 0;white-space:nowrap;vertical-align:top;width:1%}table.kv td{padding:5px 6px;vertical-align:top}table.kv td:last-child{width:1%}
table.kv code{word-break:break-all}button.copy{padding:3px 10px;font-size:.75rem}
form.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:10px;align-items:end;margin:10px 0}form.grid2 label{display:flex;flex-direction:column;gap:4px;font-weight:600;font-size:.9rem}form.grid2 input{padding:9px 12px;font-weight:400}
.ok-line{color:var(--ok);font-weight:600}.ok-line form{margin-left:6px}
.live{display:flex;gap:14px;align-items:center;padding:12px;border:1px dashed var(--edge);border-radius:8px;background:#f3ead0}.live.on{border-style:solid;border-color:var(--ok);background:#e3ebd2}
.live .noart{width:56px;height:56px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:28px;background:#3a2614;color:#e8c25a;flex:none}
details summary{cursor:pointer;margin:6px 0}`,
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

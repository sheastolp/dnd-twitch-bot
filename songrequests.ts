// GuildScribe — song requests: chat adds songs to the streamer's Spotify queue.
//
//   !sr <song name or Spotify link>   add a song (who may: the songs.who option)
//   !sr                               how to request, and the queue link
//   !song                             what's playing, and who asked for it
//   !queue                            the next few songs, and the queue link
//   !skip                             mods (or whoever requested the song playing): skip it
//   GET /songs?channel=<id|login>     public page: now playing and up next, with requesters
//
// Uses the channel's own Spotify connection from the 🎵 Now playing page
// (nowplaying.ts), which asks for the queue scopes; a connection made before
// those existed is asked to reconnect. Adding to the queue needs Spotify
// Premium and a device that's playing (or paused) — Spotify's own rules — and
// each answer in chat says which is missing. Spotify's queue can't have songs
// taken out again, so there's no !wrongsong: the requester (or a mod) can
// !skip it once it plays.
//
// Limits (dashboard Quick setup → Song requests → ⚙ Options): songs each
// viewer can have waiting (checked against Spotify's real queue, so it frees
// up as their songs play or get skipped), the longest song, the gap between
// one viewer's requests, and who may request. Dashboard switch "songrequests"
// (off by default); this module checks it itself, and a channel's own !sr,
// !song, !queue or !skip custom command wins (often imported from
// StreamElements or Nightbot).

import { sqlite } from "./sqlite.ts";
import { sendChatMessage } from "./twitch.ts";
import { getCustomCommand, isCommandGroupEnabled } from "./db.ts";
import { optNum, optWord } from "./channel_options.ts";
import { getNowPlaying, spotifyFetch, spotifyQueueAccess } from "./nowplaying.ts";
import { escapeHtml } from "./utils.ts";
import { PUBLIC_BASE_URL } from "./config.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

/** A request counts as "this viewer's" (for !skip, the queue page) this long. */
const REQUEST_MEMORY_MS = 6 * 60 * 60_000;
const QUEUE_CACHE_MS = 10_000;
const TRACK_ID_RE = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/;

type Track = { uri: string; title: string; artist: string; durationMs: number; url: string };

export async function ensureSongRequestTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS song_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, broadcaster_id TEXT NOT NULL, login TEXT NOT NULL, display TEXT NOT NULL,
      uri TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL, duration_ms INTEGER NOT NULL, requested_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute("CREATE INDEX IF NOT EXISTS song_requests_channel ON song_requests (broadcaster_id, requested_at)");
}

export async function purgeSongRequestData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM song_requests WHERE broadcaster_id = ?", [broadcasterId]);
  queueCache.delete(broadcasterId);
}

const fmtTime = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const label = (t: { title: string; artist: string }) => `${t.title} — ${t.artist}`;

// deno-lint-ignore no-explicit-any
const toTrack = (t: any): Track | null =>
  t?.uri && t.type === "track"
    ? {
      uri: String(t.uri),
      title: String(t.name ?? ""),
      artist: (t.artists ?? []).map((a: any) => a.name).join(", "),
      durationMs: Number(t.duration_ms ?? 0),
      url: String(t.external_urls?.spotify ?? ""),
    }
    : null;

/** Spotify's reason for a refused call, in words for chat. */
async function spotifyProblem(res: Response | null): Promise<string> {
  if (!res) return "GuildScribe lost its Spotify connection — the streamer can reconnect it on the dashboard's 🎵 Now playing page.";
  const body = await res.json().catch(() => null);
  const reason = String(body?.error?.reason ?? "");
  if (res.status === 404 || reason === "NO_ACTIVE_DEVICE") return "Spotify isn't open on any device right now — the streamer needs to start playing something first.";
  if (res.status === 403 || reason === "PREMIUM_REQUIRED") return "Spotify only lets Premium accounts take song requests.";
  if (res.status === 429) return "Spotify says we're asking too fast — try again in a minute.";
  return `Spotify didn't take that (${res.status}). Try again in a moment.`;
}

/** A Spotify link → that track; anything else → Spotify's best match for the words. */
async function findTrack(broadcasterId: string, query: string): Promise<{ track: Track } | { problem: string }> {
  const id = query.match(TRACK_ID_RE)?.[1];
  if (!id && /https?:\/\//i.test(query)) return { problem: "only Spotify songs can be requested — paste a Spotify track link, or just type the song name." };
  const res = id
    ? await spotifyFetch(broadcasterId, `/tracks/${id}?market=from_token`)
    : await spotifyFetch(broadcasterId, `/search?${new URLSearchParams({ q: query.slice(0, 200), type: "track", limit: "1", market: "from_token" })}`);
  if (!res || !res.ok) return { problem: await spotifyProblem(res) };
  const data = await res.json().catch(() => null);
  const track = toTrack(id ? data : data?.tracks?.items?.[0]);
  return track ? { track } : { problem: `Spotify found nothing for "${query.slice(0, 60)}". Try the artist and title, or a Spotify link.` };
}

type Queue = { current: Track | null; next: Track[] };
const queueCache = new Map<string, { at: number; queue: Queue }>();

/** The song playing and Spotify's up-next list (requests first, then whatever plays after). */
async function getQueue(broadcasterId: string, fresh = false): Promise<Queue | { problem: string }> {
  const hit = queueCache.get(broadcasterId);
  if (!fresh && hit && Date.now() - hit.at < QUEUE_CACHE_MS) return hit.queue;
  const res = await spotifyFetch(broadcasterId, "/me/player/queue");
  if (!res || !res.ok) return { problem: await spotifyProblem(res) };
  const data = await res.json().catch(() => null);
  const queue = { current: toTrack(data?.currently_playing), next: ((data?.queue ?? []) as unknown[]).map(toTrack).filter((t): t is Track => Boolean(t)) };
  queueCache.set(broadcasterId, { at: Date.now(), queue });
  if (queueCache.size > 300) queueCache.delete(queueCache.keys().next().value!);
  return queue;
}

/** Recent requests by track uri (the newest request wins), for "requested by". */
async function recentRequests(broadcasterId: string): Promise<Map<string, { login: string; display: string; at: number }>> {
  const res = await sqlite.execute(
    "SELECT uri, login, display, requested_at FROM song_requests WHERE broadcaster_id = ? AND requested_at > ? ORDER BY requested_at",
    [broadcasterId, Date.now() - REQUEST_MEMORY_MS],
  );
  return new Map((res.rows as any[]).map((r) => [String(r.uri), { login: String(r.login), display: String(r.display), at: Number(r.requested_at) }]));
}

const WHO_LABEL: Record<string, string> = { everyone: "everyone", subs: "subscribers, VIPs and mods", vips: "VIPs and mods", mods: "mods" };

/** Whether a chatter's badges meet the songs.who option. */
function allowed(who: string, badges: Array<{ set_id?: string }>, isModerator: boolean): boolean {
  if (isModerator || who === "everyone") return true;
  const sets = new Set(badges.map((b) => String(b?.set_id ?? "")));
  if (who === "mods") return false;
  if (who === "vips") return sets.has("vip");
  return sets.has("vip") || sets.has("subscriber") || sets.has("founder");
}

const queueLink = (channelKey: string) => `${PUBLIC_BASE_URL}/songs?channel=${encodeURIComponent(channelKey)}`;

export async function handleSongRequestCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  channelKey: string,
  isModerator: boolean,
  badges: Array<{ set_id?: string }>,
): Promise<boolean> {
  const match = chatMessage.trim().match(/^!(sr|songrequest|song|queue|songs|skip)(?:\s+([\s\S]*))?$/i);
  if (!match) return false;
  const word = match[1].toLowerCase();
  const [on, custom] = await Promise.all([isCommandGroupEnabled(broadcasterId, "songrequests"), getCustomCommand(broadcasterId, word)]);
  if (!on || custom) return false;
  const arg = (match[2] ?? "").trim();
  const reply = (text: string) => sendChatMessage(`@${display} ${text}`, broadcasterId);

  const access = await spotifyQueueAccess(broadcasterId);
  if (access !== "ok" && word !== "song") {
    await reply(access === "needs_reconnect"
      ? "🎵 song requests need one more Spotify permission — the streamer can reconnect Spotify on the dashboard's 🎵 Now playing page."
      : "🎵 song requests need Spotify connected on the dashboard's 🎵 Now playing page (Spotify, not Last.fm).");
    return true;
  }

  if (word === "song") {
    const np = await getNowPlaying(broadcasterId);
    if (!np || !np.playing) { await reply("🎵 nothing's playing right now."); return true; }
    const id = np.url.match(TRACK_ID_RE)?.[1];
    const by = id ? (await recentRequests(broadcasterId)).get(`spotify:track:${id}`) : undefined;
    await reply(`🎵 Now playing: ${label(np)}${by ? ` · requested by ${by.display}` : ""}${np.url ? ` ${np.url}` : ""}`);
    return true;
  }

  if (word === "queue" || word === "songs") {
    const q = await getQueue(broadcasterId);
    if ("problem" in q) { await reply(`🎵 ${q.problem}`); return true; }
    const asked = await recentRequests(broadcasterId);
    const next = q.next.slice(0, 3).map((t, i) => `${i + 1}. ${label(t)}${asked.has(t.uri) ? ` (${asked.get(t.uri)!.display})` : ""}`);
    await reply(`🎵 ${q.current ? `Now: ${label(q.current)}. ` : ""}${next.length ? `Up next: ${next.join(" · ")}. ` : "Nothing queued. "}Full queue: ${queueLink(channelKey)}`);
    return true;
  }

  if (word === "skip") {
    const q = await getQueue(broadcasterId, true);
    if ("problem" in q) { await reply(`🎵 ${q.problem}`); return true; }
    if (!q.current) { await reply("🎵 nothing's playing to skip."); return true; }
    const by = (await recentRequests(broadcasterId)).get(q.current.uri);
    if (!isModerator && by?.login !== chatter.toLowerCase()) {
      await reply("only mods (or whoever requested the song that's playing) can skip.");
      return true;
    }
    const res = await spotifyFetch(broadcasterId, "/me/player/next", { method: "POST" });
    if (!res || !res.ok) { await reply(`🎵 ${await spotifyProblem(res)}`); return true; }
    queueCache.delete(broadcasterId);
    await reply(`⏭ Skipped ${label(q.current)}.`);
    return true;
  }

  // !sr / !songrequest
  const [who, perViewer, maxSecs, gapSecs] = await Promise.all([
    optWord(broadcasterId, "songs.who"),
    optNum(broadcasterId, "songs.perViewer"),
    optNum(broadcasterId, "songs.maxLength"),
    optNum(broadcasterId, "songs.cooldown"),
  ]);
  if (!arg || /^(help|list)$/i.test(arg)) {
    await reply(`🎵 request a song with !sr <song name or Spotify link> (${WHO_LABEL[who] ?? "everyone"}; up to ${perViewer} waiting each). !song for what's playing, !queue for what's next: ${queueLink(channelKey)}`);
    return true;
  }
  if (!allowed(who, badges, isModerator)) {
    await reply(`song requests are open to ${WHO_LABEL[who] ?? who} only right now.`);
    return true;
  }
  const login = chatter.toLowerCase();
  if (!isModerator && gapSecs > 0) {
    const last = await sqlite.execute("SELECT MAX(requested_at) AS at FROM song_requests WHERE broadcaster_id = ? AND login = ?", [broadcasterId, login]);
    const wait = Math.ceil((Number(last.rows[0]?.at ?? 0) + gapSecs * 1000 - Date.now()) / 1000);
    if (wait > 0) { await reply(`🎵 one request at a time — you can ask again in ${wait >= 60 ? `${Math.ceil(wait / 60)} min` : `${wait}s`}.`); return true; }
  }

  const found = await findTrack(broadcasterId, arg);
  if ("problem" in found) { await reply(`🎵 ${found.problem}`); return true; }
  const track = found.track;
  if (!isModerator && maxSecs > 0 && track.durationMs > maxSecs * 1000) {
    await reply(`🎵 ${label(track)} is ${fmtTime(track.durationMs)} — songs can be up to ${fmtTime(maxSecs * 1000)} here.`);
    return true;
  }

  const q = await getQueue(broadcasterId, true);
  if ("problem" in q) { await reply(`🎵 ${q.problem}`); return true; }
  if (q.current?.uri === track.uri || q.next.some((t) => t.uri === track.uri)) {
    await reply(`🎵 ${label(track)} is ${q.current?.uri === track.uri ? "playing right now" : "already in the queue"}.`);
    return true;
  }
  if (!isModerator) {
    const mine = await sqlite.execute(
      "SELECT uri FROM song_requests WHERE broadcaster_id = ? AND login = ? AND requested_at > ?",
      [broadcasterId, login, Date.now() - REQUEST_MEMORY_MS],
    );
    const waiting = new Set(q.next.map((t) => t.uri));
    const count = (mine.rows as any[]).filter((r) => waiting.has(String(r.uri))).length;
    if (count >= perViewer) {
      await reply(`🎵 you already have ${count} song${count === 1 ? "" : "s"} waiting — request another once one has played.`);
      return true;
    }
  }

  const res = await spotifyFetch(broadcasterId, `/me/player/queue?${new URLSearchParams({ uri: track.uri })}`, { method: "POST" });
  if (!res || !res.ok) { await reply(`🎵 ${await spotifyProblem(res)}`); return true; }
  queueCache.delete(broadcasterId);
  await sqlite.execute(
    "INSERT INTO song_requests (broadcaster_id, login, display, uri, title, artist, duration_ms, requested_at) VALUES (?,?,?,?,?,?,?,?)",
    [broadcasterId, login, display, track.uri, track.title.slice(0, 200), track.artist.slice(0, 200), track.durationMs, Date.now()],
  );
  await sqlite.execute("DELETE FROM song_requests WHERE broadcaster_id = ? AND requested_at < ?", [broadcasterId, Date.now() - REQUEST_MEMORY_MS]);
  await reply(`🎵 added ${label(track)} (${fmtTime(track.durationMs)}) to the queue.`);
  return true;
}

// ── The public queue page (/songs) ──────────────────────────────────────────

export async function renderSongQueuePage(channel: { id: string; name: string }): Promise<{ status: number; html: string }> {
  const name = escapeHtml(channel.name);
  const shell = (body: string) => scrollDoc(`${channel.name} — Song queue`, body, {
    width: 760,
    css: `${LEDGER_CSS}.np{display:flex;gap:14px;align-items:center;padding:14px 16px;border:1px solid var(--edge);border-radius:8px;background:#efe5c8}
.np .k{font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)}.np b{font-size:1.2rem}
ol.q{padding-left:1.6em;margin:10px 0}ol.q li{padding:7px 0;border-bottom:1px solid var(--rule)}ol.q .by{color:var(--seal);font-weight:600}
.muted{color:var(--ink-3)}.small{font-size:.86rem}`,
  });
  if (!(await isCommandGroupEnabled(channel.id, "songrequests"))) {
    return { status: 404, html: shell(`<h1>${name}</h1><p>Song requests are switched off for this channel.</p>`) };
  }
  if ((await spotifyQueueAccess(channel.id)) !== "ok") {
    return { status: 200, html: shell(`<h1>${name} — Song queue</h1><p class="muted">The queue isn't available right now: this channel's Spotify isn't connected for song requests.</p>`) };
  }
  const q = await getQueue(channel.id);
  const asked = await recentRequests(channel.id);
  const by = (t: Track) => asked.has(t.uri) ? ` <span class="by">· ${escapeHtml(asked.get(t.uri)!.display)}</span>` : "";
  const song = (t: Track) => `${t.url ? `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.title)}</a>` : escapeHtml(t.title)} — ${escapeHtml(t.artist)} <span class="muted small">${fmtTime(t.durationMs)}</span>`;
  const body = "problem" in q
    ? `<p class="muted">${escapeHtml(q.problem)}</p>`
    : `${q.current ? `<div class="np"><div><div class="k">♪ Now playing</div><b>${song(q.current)}</b>${by(q.current)}</div></div>` : `<p class="muted">Nothing's playing right now.</p>`}
<h2>Up next</h2>${q.next.length ? `<ol class="q">${q.next.slice(0, 20).map((t) => `<li>${song(t)}${by(t)}</li>`).join("")}</ol>` : `<p class="muted">Nothing queued.</p>`}
<p class="muted small">Songs with a name after them were requested in chat. After the requests, Spotify carries on with the streamer's own playlist.</p>`;
  return {
    status: 200,
    html: shell(`<script>setTimeout(()=>location.reload(),20000)</script><span class="pill">Song requests</span><h1>${name} — Song queue</h1>
<p>Request a song in ${name}'s chat with <code>!sr &lt;song name or Spotify link&gt;</code>.</p>${body}`),
  };
}

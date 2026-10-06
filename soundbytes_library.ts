// GuildScribe — Sound Bytes beyond the eleven built-in sounds: a channel's own
// sounds, picked from online sound repositories or added as a file.
//
//   Online repositories    searched from /dashboard/sounds: Openverse (its
//                          index of Creative Commons audio — Freesound,
//                          Wikimedia Commons, ccMixter, Jamendo), narrowed to
//                          one source if wanted, and Freesound's own API when
//                          the server has FREESOUND_API_KEY set. A pick is
//                          linked (played straight from the repository) or
//                          copied here, with its credit kept for CC BY.
//   Your own file          a file from the streamer's computer (uploaded) and/or
//                          a link to one online (copied here, or just linked).
//
// Copies live in Val Town blob storage (val-scoped, key soundbytes:<channel>:…),
// which is small on the free plan (10 MB for the whole account), so a copy is
// capped at MAX_SOUND_BYTES and a channel keeps at most MAX_STORED_SOUNDS of
// them; linked sounds cost no storage. Every file — upload or download — is
// checked to really be audio (by its first bytes, not its name).
//
// Custom sounds play exactly like the built-in ones: !sound <name> posts
// "🔊 <name> …", and the overlay (soundbytes.ts) plays the file for at most
// MAX_PLAY_SECONDS. GET /overlay/soundfile serves a stored copy; GET
// /overlay/sounds lists a channel's sounds for an overlay that was already
// open when one was added.

import { blob } from "https://esm.town/v/std/blob/main.ts";
import { sqlite } from "./sqlite.ts";

export type CustomSound = {
  name: string; // what chat types: !sound <name>
  title: string;
  icon: string;
  source: "upload" | "link" | "library";
  url: string; // where it came from (the file for a linked sound)
  blobKey: string; // "" when linked
  mime: string;
  bytes: number;
  credit: string;
  pageUrl: string;
  createdAt: number;
};

export const MAX_SOUND_BYTES = 1_000_000;
export const MAX_STORED_SOUNDS = 8;
export const MAX_CUSTOM_SOUNDS = 30;
export const MAX_PLAY_SECONDS = 15;
const FETCH_TIMEOUT_MS = 15_000;

/** Lowercase letters, numbers, - and _: the overlay's tag only matches those. */
export const sanitizeSoundName = (raw: string) => raw.trim().toLowerCase().replace(/^!|^🔊\s*/, "").replace(/\s+/g, "-");
export const validSoundName = (name: string) => /^[a-z0-9_-]{2,25}$/.test(name);

export async function ensureCustomSoundTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS soundbyte_custom (
      broadcaster_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT, icon TEXT, source TEXT,
      url TEXT, blob_key TEXT, mime TEXT, bytes INTEGER, credit TEXT, page_url TEXT, created_at INTEGER,
      PRIMARY KEY (broadcaster_id, name)
    )`,
  );
}

const rowToSound = (r: any): CustomSound => ({
  name: String(r.name),
  title: String(r.title || r.name),
  icon: String(r.icon || "🔊"),
  source: (["upload", "link", "library"].includes(String(r.source)) ? String(r.source) : "link") as CustomSound["source"],
  url: String(r.url ?? ""),
  blobKey: String(r.blob_key ?? ""),
  mime: String(r.mime ?? ""),
  bytes: Number(r.bytes ?? 0),
  credit: String(r.credit ?? ""),
  pageUrl: String(r.page_url ?? ""),
  createdAt: Number(r.created_at ?? 0),
});

export async function listCustomSounds(broadcasterId: string): Promise<CustomSound[]> {
  try {
    const res = await sqlite.execute("SELECT * FROM soundbyte_custom WHERE broadcaster_id = ? ORDER BY name", [broadcasterId]);
    return res.rows.map(rowToSound);
  } catch (_) {
    return []; // table not made yet: no custom sounds
  }
}

export async function getCustomSound(broadcasterId: string, name: string): Promise<CustomSound | null> {
  if (!validSoundName(name)) return null;
  try {
    const res = await sqlite.execute("SELECT * FROM soundbyte_custom WHERE broadcaster_id = ? AND name = ?", [broadcasterId, name]);
    return res.rows[0] ? rowToSound(res.rows[0]) : null;
  } catch (_) {
    return null;
  }
}

/** Where the overlay plays a sound from: the stored copy, or the linked file. */
export function customSoundSrc(broadcasterId: string, s: CustomSound): string {
  return s.blobKey
    ? `/overlay/soundfile?channel=${encodeURIComponent(broadcasterId)}&name=${encodeURIComponent(s.name)}&v=${s.createdAt}`
    : s.url;
}

export async function deleteCustomSound(broadcasterId: string, name: string): Promise<boolean> {
  const s = await getCustomSound(broadcasterId, name);
  if (!s) return false;
  await sqlite.execute("DELETE FROM soundbyte_custom WHERE broadcaster_id = ? AND name = ?", [broadcasterId, name]);
  if (s.blobKey) await blob.delete(s.blobKey).catch(() => {});
  return true;
}

export async function purgeCustomSounds(broadcasterId: string) {
  for (const s of await listCustomSounds(broadcasterId)) {
    if (s.blobKey) await blob.delete(s.blobKey).catch(() => {});
  }
  await sqlite.execute("DELETE FROM soundbyte_custom WHERE broadcaster_id = ?", [broadcasterId]).catch(() => {});
}

/** GET /overlay/soundfile — a stored copy, for the overlay's <audio>. Public like the overlay itself. */
export async function serveCustomSoundFile(broadcasterId: string, name: string): Promise<Response> {
  const s = await getCustomSound(broadcasterId, name);
  if (!s) return new Response("No such sound.", { status: 404 });
  if (!s.blobKey) return new Response(null, { status: 302, headers: { Location: s.url } });
  try {
    const res = await blob.get(s.blobKey);
    return new Response(res.body, {
      headers: {
        "Content-Type": s.mime || "application/octet-stream",
        "Cache-Control": "public, max-age=86400", // the URL carries ?v=<created_at>, so a replaced sound gets a new one
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (_) {
    return new Response("Sound file missing.", { status: 404 });
  }
}

// ── Checking files ──────────────────────────────────────────────────────────

/** The audio type of a file from its first bytes, or "" when it isn't audio we can play. */
export function sniffAudio(b: Uint8Array): string {
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length < 12) return "";
  if (at(0, "ID3")) return "audio/mpeg";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    // MPEG frame sync: layer bits 00 are ADTS AAC, anything else MP3.
    return (b[1] & 0x06) === 0 ? "audio/aac" : "audio/mpeg";
  }
  if (at(0, "OggS")) return "audio/ogg";
  if (at(0, "RIFF") && at(8, "WAVE")) return "audio/wav";
  if (at(0, "fLaC")) return "audio/flac";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  if (at(4, "ftyp")) return "audio/mp4";
  return "";
}

/** Only public http(s) addresses: no logins in the URL, no local or private hosts. */
export function checkPublicUrl(raw: string): URL | string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch (_) {
    return "That link isn't a valid web address.";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Links must start with https:// (or http://).";
  if (u.username || u.password) return "Links can't carry a username or password.";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
    /^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host) ||
    !host.includes(".") && !host.includes(":");
  if (privateHost) return "That link points to a private address.";
  return u;
}

/** Reads a response body, stopping (and failing) once it passes `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, max + 1);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, headers: { "User-Agent": "GuildScribe Sound Bytes", ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(t);
  }
}

/** Downloads an online sound in full (for a copy). */
async function downloadAudio(url: URL): Promise<{ bytes: Uint8Array; mime: string } | string> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url.href);
  } catch (_) {
    return "Couldn't reach that link (it took too long or refused the connection).";
  }
  const final = checkPublicUrl(res.url || url.href);
  if (typeof final === "string") return final;
  if (!res.ok) return `That link answered ${res.status} — is it a direct link to the file?`;
  const bytes = await readCapped(res, MAX_SOUND_BYTES);
  if (!bytes) return `That file is over ${Math.round(MAX_SOUND_BYTES / 1000)} KB — trim it, or add it as a link instead of a copy.`;
  const mime = sniffAudio(bytes);
  if (!mime) return "That link isn't an audio file (mp3, ogg, wav, m4a, flac or webm). Use the direct link to the file, not the page it's on.";
  return { bytes, mime };
}

/** Peeks at a linked sound's first bytes to make sure it's audio. */
async function probeAudio(url: URL): Promise<{ mime: string } | string> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url.href, { headers: { Range: "bytes=0-4095" } });
  } catch (_) {
    return "Couldn't reach that link (it took too long or refused the connection).";
  }
  const final = checkPublicUrl(res.url || url.href);
  if (typeof final === "string") return final;
  if (!res.ok) return `That link answered ${res.status} — is it a direct link to the file?`;
  let head = new Uint8Array();
  if (res.body) {
    const reader = res.body.getReader();
    const { value } = await reader.read();
    head = value ?? head;
    await reader.cancel().catch(() => {});
  }
  const mime = sniffAudio(head);
  if (!mime) return "That link isn't an audio file (mp3, ogg, wav, m4a, flac or webm). Use the direct link to the file, not the page it's on.";
  return { mime };
}

// ── Adding ──────────────────────────────────────────────────────────────────

export type AddSoundInput = {
  name: string;
  title?: string;
  icon?: string;
  file?: File | null; // from the streamer's computer
  url?: string; // online: copied when `copy`, else linked
  copy?: boolean;
  fromLibrary?: boolean;
  credit?: string;
  pageUrl?: string;
};

/** Adds (or, with `replace`, replaces) a channel's sound. A file wins over a
 * link when both are given; the link is then kept as where the file came from. */
export async function addCustomSound(
  broadcasterId: string,
  input: AddSoundInput,
  isTaken: (name: string) => boolean,
  replace = false,
): Promise<{ ok: true; sound: CustomSound } | { ok: false; error: string }> {
  const name = sanitizeSoundName(input.name);
  if (!validSoundName(name)) return { ok: false, error: "Sound names are 2-25 characters: letters, numbers, - or _ (it's what chat types after !sound)." };
  if (isTaken(name)) return { ok: false, error: `"${name}" is already a built-in sound or a !sound word — pick another name.` };
  const existing = await listCustomSounds(broadcasterId);
  const old = existing.find((s) => s.name === name);
  if (old && !replace) return { ok: false, error: `You already have a sound called "${name}". Delete it first, or tick "Replace".` };
  if (!old && existing.length >= MAX_CUSTOM_SOUNDS) return { ok: false, error: `That's the limit of ${MAX_CUSTOM_SOUNDS} sounds — delete one first.` };

  const file = input.file && input.file.size > 0 ? input.file : null;
  const rawUrl = (input.url ?? "").trim();
  if (!file && !rawUrl) return { ok: false, error: "Choose a file from your computer, paste a link to one online, or both." };
  let url: URL | null = null;
  if (rawUrl) {
    const u = checkPublicUrl(rawUrl);
    if (typeof u === "string") return { ok: false, error: u };
    url = u;
  }

  let bytes: Uint8Array | null = null;
  let mime = "";
  let source: CustomSound["source"] = input.fromLibrary ? "library" : "link";
  if (file) {
    if (file.size > MAX_SOUND_BYTES) return { ok: false, error: `That file is ${Math.round(file.size / 1000)} KB — the limit is ${Math.round(MAX_SOUND_BYTES / 1000)} KB. Trim it or save it as a lower-quality mp3.` };
    bytes = new Uint8Array(await file.arrayBuffer());
    mime = sniffAudio(bytes);
    if (!mime) return { ok: false, error: `"${file.name}" isn't an audio file we can play (mp3, ogg, wav, m4a, flac or webm).` };
    source = "upload";
  } else if (url && input.copy) {
    const got = await downloadAudio(url);
    if (typeof got === "string") return { ok: false, error: got };
    ({ bytes, mime } = got);
  } else if (url) {
    const got = await probeAudio(url);
    if (typeof got === "string") return { ok: false, error: got };
    mime = got.mime;
  }

  let blobKey = "";
  if (bytes) {
    const stored = existing.filter((s) => s.blobKey && s.name !== name).length;
    if (stored >= MAX_STORED_SOUNDS) {
      return { ok: false, error: `You already keep ${MAX_STORED_SOUNDS} sound files here, the most there's room for. Delete one, or add this one as a link.` };
    }
    blobKey = `soundbytes:${broadcasterId}:${name}:${crypto.randomUUID().slice(0, 8)}`;
    try {
      await blob.set(blobKey, bytes);
    } catch (e) {
      console.error("soundbytes blob.set failed", e);
      return { ok: false, error: "Couldn't save the file (storage may be full). Try adding it as a link instead." };
    }
  }

  const fileTitle = file ? file.name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").trim() : "";
  const sound: CustomSound = {
    name,
    title: (input.title ?? "").trim().slice(0, 60) || fileTitle.slice(0, 60) || name,
    icon: [...(input.icon ?? "").trim()].slice(0, 4).join("") || "🔊",
    source,
    url: url ? url.href : "",
    blobKey,
    mime,
    bytes: bytes?.length ?? 0,
    credit: (input.credit ?? "").trim().slice(0, 300),
    pageUrl: (() => {
      const p = input.pageUrl ? checkPublicUrl(input.pageUrl) : "";
      return typeof p === "string" ? "" : p.href;
    })(),
    createdAt: Date.now(),
  };
  await sqlite.execute(
    `INSERT INTO soundbyte_custom (broadcaster_id, name, title, icon, source, url, blob_key, mime, bytes, credit, page_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(broadcaster_id, name) DO UPDATE SET title = excluded.title, icon = excluded.icon, source = excluded.source,
       url = excluded.url, blob_key = excluded.blob_key, mime = excluded.mime, bytes = excluded.bytes, credit = excluded.credit,
       page_url = excluded.page_url, created_at = excluded.created_at`,
    [broadcasterId, name, sound.title, sound.icon, sound.source, sound.url, sound.blobKey, sound.mime, sound.bytes, sound.credit, sound.pageUrl, sound.createdAt],
  );
  if (old?.blobKey && old.blobKey !== blobKey) await blob.delete(old.blobKey).catch(() => {});
  return { ok: true, sound };
}

// ── Online repositories ─────────────────────────────────────────────────────

export type SoundRepository = { id: string; label: string; blurb: string; site: string };
export type LibraryHit = {
  repo: string;
  title: string;
  creator: string;
  license: string;
  credit: string;
  fileUrl: string;
  pageUrl: string;
  seconds: number;
};

const freesoundKey = () => Deno.env.get("FREESOUND_API_KEY") ?? "";

/** The repositories the dashboard can search. Freesound's own API joins when the server has a key. */
export function soundRepositories(): SoundRepository[] {
  const repos: SoundRepository[] = [
    { id: "openverse", label: "Openverse — every source", blurb: "Creative Commons sound effects from Freesound, Wikimedia Commons, ccMixter and Jamendo in one search.", site: "https://openverse.org/audio" },
    { id: "freesound", label: "Freesound", blurb: "The biggest library of free sound effects, recorded and shared by its community.", site: "https://freesound.org" },
    { id: "wikimedia", label: "Wikimedia Commons", blurb: "Free sounds and recordings from the Wikipedia family.", site: "https://commons.wikimedia.org/wiki/Category:Audio_files" },
    { id: "ccmixter", label: "ccMixter", blurb: "Short music clips, loops and stingers.", site: "https://ccmixter.org" },
  ];
  if (freesoundKey()) {
    repos.splice(1, 1, { id: "freesound", label: "Freesound", blurb: "The biggest library of free sound effects — searched with Freesound's own API, so its whole catalog.", site: "https://freesound.org" });
  }
  return repos;
}

const OPENVERSE_SOURCE: Record<string, string> = { freesound: "freesound", wikimedia: "wikimedia_audio", ccmixter: "ccmixter" };
const REPO_NAME: Record<string, string> = { freesound: "Freesound", wikimedia_audio: "Wikimedia Commons", ccmixter: "ccMixter", jamendo: "Jamendo" };

function licenseLabel(license: string, version: string): string {
  const l = license.toLowerCase();
  if (l === "cc0") return "CC0";
  if (l === "pdm") return "Public domain";
  return `CC ${l.toUpperCase()}${version ? ` ${version}` : ""}`;
}

function creditLine(title: string, creator: string, license: string, repo: string): string {
  return `"${title}"${creator ? ` by ${creator}` : ""} (${repo}, ${license})`;
}

const searchCache = new Map<string, { at: number; hits: LibraryHit[] }>();
const SEARCH_TTL_MS = 10 * 60_000;

/** Short sounds matching `query` in one repository (at most 12). */
export async function searchSoundLibrary(repo: string, query: string): Promise<{ hits: LibraryHit[] } | { error: string }> {
  const q = query.trim().slice(0, 80);
  if (!q) return { hits: [] };
  const cacheKey = `${repo}\n${q.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return { hits: cached.hits };
  try {
    const hits = repo === "freesound" && freesoundKey() ? await searchFreesound(q) : await searchOpenverse(q, OPENVERSE_SOURCE[repo]);
    searchCache.set(cacheKey, { at: Date.now(), hits });
    if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value!);
    return { hits };
  } catch (e) {
    console.error("sound library search failed", repo, e);
    return { error: String(e).includes("429") ? "The sound library is busy (too many searches) — try again in a minute." : "Couldn't reach the sound library just now — try again in a moment." };
  }
}

async function searchOpenverse(q: string, source?: string): Promise<LibraryHit[]> {
  const params = new URLSearchParams({ q, page_size: "12", length: "shortest", mature: "false" });
  if (source) params.set("source", source);
  const res = await fetchWithTimeout(`https://api.openverse.org/v1/audio/?${params}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`openverse ${res.status}`);
  const data: any = await res.json();
  return (Array.isArray(data?.results) ? data.results : [])
    .filter((r: any) => typeof r?.url === "string" && /^https:\/\//.test(r.url))
    .map((r: any): LibraryHit => {
      const repoName = REPO_NAME[String(r.source ?? r.provider)] ?? String(r.source ?? "Openverse");
      const title = String(r.title || "Untitled").slice(0, 80);
      const creator = String(r.creator ?? "").slice(0, 60);
      const license = licenseLabel(String(r.license ?? ""), String(r.license_version ?? ""));
      return {
        repo: repoName,
        title,
        creator,
        license,
        credit: creditLine(title, creator, license, repoName),
        fileUrl: r.url,
        pageUrl: String(r.foreign_landing_url || r.detail_url || ""),
        seconds: Math.round(Number(r.duration ?? 0) / 100) / 10,
      };
    });
}

async function searchFreesound(q: string): Promise<LibraryHit[]> {
  const params = new URLSearchParams({
    query: q,
    page_size: "12",
    filter: "duration:[0 TO 20]",
    fields: "id,name,username,license,duration,previews,url",
    token: freesoundKey(),
  });
  const res = await fetchWithTimeout(`https://freesound.org/apiv2/search/text/?${params}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`freesound ${res.status}`);
  const data: any = await res.json();
  return (Array.isArray(data?.results) ? data.results : [])
    .filter((r: any) => typeof r?.previews?.["preview-hq-mp3"] === "string")
    .map((r: any): LibraryHit => {
      // Freesound gives licenses as deed URLs: .../licenses/by/4.0/, .../publicdomain/zero/1.0/
      const lic = String(r.license ?? "");
      const m = lic.match(/licenses\/([a-z-]+)\/([\d.]+)/i);
      const license = /publicdomain\/zero/i.test(lic) ? "CC0" : m ? licenseLabel(m[1], m[2]) : "CC";
      const title = String(r.name || "Untitled").slice(0, 80);
      const creator = String(r.username ?? "").slice(0, 60);
      return {
        repo: "Freesound",
        title,
        creator,
        license,
        credit: creditLine(title, creator, license, "Freesound"),
        fileUrl: r.previews["preview-hq-mp3"],
        pageUrl: String(r.url ?? ""),
        seconds: Math.round(Number(r.duration ?? 0) * 10) / 10,
      };
    });
}

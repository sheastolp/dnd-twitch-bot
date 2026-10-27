// GuildScribe — !steam: chat rolls a random game from the streamer's Steam library.
//
//   !steam                                         anyone: picks a random game
//   !steam link <profile link or ID> · !steam unlink   mods: link the channel's Steam account from chat
//   !steam family [add <profile> | remove <name, profile or all>]   mods: Steam Family members whose games join in
//   GET  /dashboard/steam · POST /dashboard/steam  Steam ID, Web API key, uploader key, games to leave out (dashboard key + mod login; dashboard.ts)
//   POST /steam/installed                          the uploader sends the installed list here (JSON, channel + uploader key)
//   GET  /steam/uploader.ts                        the uploader script itself (tools/steam_upload.ts)
//
// The no-setup route: a streamer links their Steam profile (dashboard, or
// !steam link in chat) and !steam rolls from their owned games through the
// Web API's GetOwnedGames — with the server-wide STEAM_API_KEY, so they need
// no key of their own (a channel's own key, if they add one, wins).
// The Web API never sees what's installed — that only lives on the gaming PC,
// in Steam's libraryfolders.vdf and each library's appmanifest_*.acf files —
// so a streamer who wants installed games only runs a small uploader there
// (tools/steam_upload.ts) that posts the installed list with their own
// uploader key. Either half works alone, and the pick uses the best of what's set up:
//   • installed list + owned games → the installed games the account owns
//     (drops Steamworks redistributables and other installed bits that aren't
//     games); if nothing overlaps (all family-shared, say) the installed list
//   • installed list only          → the installed list, minus Steam's own tools
//   • owned games only             → every owned game, installed or not
// Steam Families: Steam has no keyed Web API for a family's shared library
// (only the Steam client sees it), so family members' profiles are linked
// too and their owned games join the owned pool. That can include games a
// member keeps out of sharing; installed family games are kept by the
// installed ∩ owned filter as long as some member owns them.
// The streamer's "leave out" list (e.g. OBS, Wallpaper Engine) applies to all.
//
// Dashboard switch "steam" (off by default). A channel's own !steam custom
// command wins. The Web API key never leaves the server (the page shows it
// masked), and owned-game lists are cached per channel for OWNED_CACHE_MS.

import { sqlite } from "./sqlite.ts";
import { sendChatMessage, timingSafeEqual } from "./twitch.ts";
import { getCustomCommand, isCommandGroupEnabled } from "./db.ts";
import { escapeHtml } from "./utils.ts";
import { PUBLIC_BASE_URL } from "./config.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

const OWNED_CACHE_MS = 60 * 60_000;
const PICK_COOLDOWN_MS = 5_000;
const MAX_GAMES = 3000;
const MAX_NAME = 120;
const MAX_SKIP = 1000;
const MAX_FAMILY = 5; // a Steam Family is up to 6 accounts: the streamer and 5 others
const KEY_RE = /^[0-9A-F]{32}$/i; // Steam Web API keys are 32 hex characters
const STEAMID_RE = /^7656119\d{10}$/;
/** Installed things that aren't games: Steam's own runtimes and redistributables. */
const STEAM_TOOLS_RE = /^(Steamworks Common Redistributables|Steamworks SDK Redist|Steam Linux Runtime|Proton|SteamVR)\b/i;

type Game = { appid: number; name: string };
/** A Steam Family member whose owned games join the pool (name: their Steam display name when added). */
type FamilyMember = { id: string; name: string };
type SteamSettings = { steamId: string; apiKey: string; uploadKey: string; skip: string; family: FamilyMember[] };

export async function ensureSteamTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS steam_settings (
      broadcaster_id TEXT PRIMARY KEY, steam_id TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '',
      upload_key TEXT NOT NULL DEFAULT '', skip TEXT NOT NULL DEFAULT '', family TEXT NOT NULL DEFAULT '[]', updated_at INTEGER
    )`,
  );
  // Tables created before family existed.
  try {
    await sqlite.execute(`ALTER TABLE steam_settings ADD COLUMN family TEXT NOT NULL DEFAULT '[]'`);
  } catch (_) {
    /* column already exists */
  }
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS steam_installed (
      broadcaster_id TEXT PRIMARY KEY, games TEXT NOT NULL DEFAULT '[]', uploaded_at INTEGER NOT NULL
    )`,
  );
}

export async function purgeSteamData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM steam_settings WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM steam_installed WHERE broadcaster_id = ?", [broadcasterId]);
}

async function getSettings(broadcasterId: string): Promise<SteamSettings> {
  const r = (await sqlite.execute("SELECT steam_id, api_key, upload_key, skip, family FROM steam_settings WHERE broadcaster_id = ?", [broadcasterId])).rows[0] as any;
  let family: FamilyMember[] = [];
  try {
    family = (JSON.parse(String(r?.family ?? "[]")) as any[])
      .map((m) => ({ id: String(m?.id ?? ""), name: String(m?.name ?? "").slice(0, 40) }))
      .filter((m) => STEAMID_RE.test(m.id));
  } catch (_) { /* corrupt JSON — no family */ }
  return { steamId: String(r?.steam_id ?? ""), apiKey: String(r?.api_key ?? ""), uploadKey: String(r?.upload_key ?? ""), skip: String(r?.skip ?? ""), family };
}

async function saveSettings(broadcasterId: string, s: SteamSettings) {
  await sqlite.execute(
    `INSERT INTO steam_settings (broadcaster_id, steam_id, api_key, upload_key, skip, family, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET steam_id = excluded.steam_id, api_key = excluded.api_key,
       upload_key = excluded.upload_key, skip = excluded.skip, family = excluded.family, updated_at = excluded.updated_at`,
    [broadcasterId, s.steamId, s.apiKey, s.uploadKey, s.skip, JSON.stringify(s.family), Date.now()],
  );
}

async function getInstalled(broadcasterId: string): Promise<{ games: Game[]; uploadedAt: number } | null> {
  const r = (await sqlite.execute("SELECT games, uploaded_at FROM steam_installed WHERE broadcaster_id = ?", [broadcasterId])).rows[0] as any;
  if (!r) return null;
  try {
    return { games: cleanGames(JSON.parse(String(r.games))), uploadedAt: Number(r.uploaded_at) };
  } catch (_) {
    return null; // corrupt JSON — as if nothing was uploaded
  }
}

/** Untrusted game lists (uploads, Steam replies) → valid, de-duplicated entries. */
function cleanGames(raw: unknown): Game[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: Game[] = [];
  for (const g of raw.slice(0, MAX_GAMES)) {
    const appid = Number((g as any)?.appid);
    const name = String((g as any)?.name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    if (!Number.isSafeInteger(appid) || appid <= 0 || !name || seen.has(appid)) continue;
    seen.add(appid);
    out.push({ appid, name });
  }
  return out;
}

/** The channel's own Web API key, else the server-wide STEAM_API_KEY. */
const apiKeyFor = (s: SteamSettings) => s.apiKey || Deno.env.get("STEAM_API_KEY") || "";
const skipNames = (skip: string) => new Set(skip.split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean));
const mask = (v: string) => (v ? `••••${v.slice(-4)}` : "");
const newUploadKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
export const steamUploaderUrl = () => `${PUBLIC_BASE_URL}/steam/uploader.ts`;

// ── Steam Web API ───────────────────────────────────────────────────────────

/** Owned games by SteamID64 (the streamer and each family member are cached separately). */
const ownedCache = new Map<string, { at: number; games: Game[] }>();

/** Owned games, or why Steam wouldn't say. "private" = the profile hides its game details. */
async function fetchOwnedGames(steamId: string, apiKey: string): Promise<{ games: Game[] } | { error: "key" | "private" | "down" }> {
  const qs = new URLSearchParams({ key: apiKey, steamid: steamId, include_appinfo: "1", include_played_free_games: "1", format: "json" });
  try {
    const res = await fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?${qs}`, { signal: AbortSignal.timeout(8_000) });
    if (res.status === 401 || res.status === 403) return { error: "key" };
    if (!res.ok) return { error: "down" };
    const body = await res.json();
    if (!Array.isArray(body?.response?.games)) return { error: "private" }; // Steam answers {} for a private library
    return { games: cleanGames(body.response.games) };
  } catch (_) {
    return { error: "down" };
  }
}

/** One account's owned games through the cache, or null when Steam won't say (private, or down with nothing cached). */
async function ownedGamesOf(steamId: string, apiKey: string): Promise<Game[] | null> {
  const hit = ownedCache.get(steamId);
  if (hit && Date.now() - hit.at < OWNED_CACHE_MS) return hit.games;
  const got = await fetchOwnedGames(steamId, apiKey);
  if ("error" in got) return hit?.games ?? null; // Steam hiccup: keep using the last list we had
  ownedCache.set(steamId, { at: Date.now(), games: got.games });
  return got.games;
}

/** Each linked account (the streamer, then family) with its owned games; games is null for one Steam won't share. */
async function libraries(s: SteamSettings): Promise<Array<{ id: string; games: Game[] | null }>> {
  const apiKey = apiKeyFor(s);
  if (!apiKey) return [];
  const ids = [s.steamId, ...s.family.map((m) => m.id)].filter(Boolean);
  return await Promise.all(ids.map(async (id) => ({ id, games: await ownedGamesOf(id, apiKey) })));
}

/** Owned games across the streamer and their family (each game once), or null with nothing linked. */
async function ownedGamesFor(s: SteamSettings): Promise<Game[] | null> {
  const libs = await libraries(s);
  if (!libs.length) return null;
  const all = new Map<number, Game>();
  for (const lib of libs) for (const g of lib.games ?? []) if (!all.has(g.appid)) all.set(g.appid, g);
  return [...all.values()];
}

/** A Steam account's display name, or "" (GetPlayerSummaries; used when adding a family member). */
async function personaName(steamId: string, apiKey: string): Promise<string> {
  try {
    const qs = new URLSearchParams({ key: apiKey, steamids: steamId });
    const res = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?${qs}`, { signal: AbortSignal.timeout(8_000) });
    const body = await res.json();
    return String(body?.response?.players?.[0]?.personaname ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  } catch (_) {
    return "";
  }
}

/** A typed Steam ID, profile link or custom URL name → a SteamID64, or why not. */
async function resolveSteamId(raw: string, apiKey: string): Promise<{ steamId: string } | { error: string }> {
  const text = raw.trim();
  const profiles = text.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profiles || STEAMID_RE.test(text)) {
    const id = profiles ? profiles[1] : text;
    return STEAMID_RE.test(id) ? { steamId: id } : { error: `"${text.slice(0, 60)}" isn't a Steam ID.` };
  }
  const vanity = (text.match(/steamcommunity\.com\/id\/([^/?#]+)/i)?.[1] ?? text).trim();
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(vanity)) return { error: `"${text.slice(0, 60)}" isn't a Steam ID or profile link.` };
  try {
    const qs = new URLSearchParams({ key: apiKey, vanityurl: vanity });
    const res = await fetch(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?${qs}`, { signal: AbortSignal.timeout(8_000) });
    if (res.status === 401 || res.status === 403) return { error: "Steam didn't accept that Web API key." };
    const body = await res.json();
    if (body?.response?.success === 1 && STEAMID_RE.test(String(body.response.steamid))) return { steamId: String(body.response.steamid) };
    return { error: `Steam has no profile at steamcommunity.com/id/${vanity}.` };
  } catch (_) {
    return { error: "Couldn't reach Steam just now. Try again in a minute." };
  }
}

// ── Picking ─────────────────────────────────────────────────────────────────

/** The pool !steam picks from, and what it's made of ("installed" / "owned" / "family library"). */
async function gamePool(broadcasterId: string): Promise<{ games: Game[]; kind: "installed" | "owned" | "family library" } | null> {
  const s = await getSettings(broadcasterId);
  const [installed, owned] = await Promise.all([getInstalled(broadcasterId), ownedGamesFor(s)]);
  const skip = skipNames(s.skip);
  const keep = (g: Game) => !skip.has(g.name.toLowerCase());
  if (installed?.games.length) {
    let games = installed.games.filter((g) => !STEAM_TOOLS_RE.test(g.name));
    if (owned?.length) {
      const ownedIds = new Set(owned.map((g) => g.appid));
      const both = games.filter((g) => ownedIds.has(g.appid));
      if (both.length) games = both;
    }
    return { games: games.filter(keep), kind: "installed" };
  }
  if (owned) return { games: owned.filter(keep), kind: s.family.length ? "family library" : "owned" };
  return null;
}

// ── Family members ──────────────────────────────────────────────────────────

/** Adds a family member's profile, once Steam shows their games. */
async function addFamilyMember(broadcasterId: string, profile: string): Promise<{ ok: boolean; message: string }> {
  const s = await getSettings(broadcasterId);
  const apiKey = apiKeyFor(s);
  if (!apiKey) return { ok: false, message: "Link your own Steam account first (with your Web API key on the dashboard's 🎮 Steam picker page)." };
  if (s.family.length >= MAX_FAMILY) return { ok: false, message: `That's already ${MAX_FAMILY} family members, the most a Steam Family can have besides you.` };
  const id = await resolveSteamId(profile, apiKey);
  if ("error" in id) return { ok: false, message: id.error };
  if (id.steamId === s.steamId) return { ok: false, message: "That's the channel's own Steam account — it's already in." };
  if (s.family.some((m) => m.id === id.steamId)) return { ok: false, message: "They're already in the family." };
  const owned = await fetchOwnedGames(id.steamId, apiKey);
  if ("error" in owned) {
    return {
      ok: false,
      message: owned.error === "private"
        ? "Steam won't share their games. They need Edit Profile → Privacy Settings → \"Game details\" set to Public."
        : "Couldn't reach Steam just now. Try again in a minute.",
    };
  }
  const name = (await personaName(id.steamId, apiKey)) || id.steamId;
  await saveSettings(broadcasterId, { ...s, family: [...s.family, { id: id.steamId, name }] });
  ownedCache.set(id.steamId, { at: Date.now(), games: owned.games });
  return { ok: true, message: `Added ${name} to the family (${owned.games.length} games).` };
}

/** Removes a family member by name, profile link or Steam ID; "all" clears the family. */
async function removeFamilyMember(broadcasterId: string, who: string): Promise<{ ok: boolean; message: string }> {
  const s = await getSettings(broadcasterId);
  const text = who.trim();
  if (/^all$/i.test(text)) {
    await saveSettings(broadcasterId, { ...s, family: [] });
    return { ok: true, message: "Removed everyone from the family." };
  }
  let member = s.family.find((m) => m.id === text || m.name.toLowerCase() === text.toLowerCase());
  if (!member && apiKeyFor(s)) {
    const id = await resolveSteamId(text, apiKeyFor(s));
    if (!("error" in id)) member = s.family.find((m) => m.id === id.steamId);
  }
  if (!member) return { ok: false, message: `"${text.slice(0, 40)}" isn't in the family.` };
  await saveSettings(broadcasterId, { ...s, family: s.family.filter((m) => m.id !== member.id) });
  return { ok: true, message: `Removed ${member.name} from the family.` };
}

const lastPick = new Map<string, number>();

export async function handleSteamCommand(chatMessage: string, display: string, broadcasterId: string, channelName: string, isModerator: boolean): Promise<boolean> {
  const match = chatMessage.trim().match(/^!steam(?:\s+(link|unlink|family)\b\s*(.*))?$/i);
  if (!match) return false;
  const [on, custom] = await Promise.all([isCommandGroupEnabled(broadcasterId, "steam"), getCustomCommand(broadcasterId, "steam")]);
  if (custom) return false;
  const sub = match[1]?.toLowerCase();
  if (sub) {
    // Mods set it up from chat, even while !steam is still switched off.
    if (!isModerator) return true;
    if (sub === "family") {
      const [verb, ...rest] = match[2].split(/\s+/);
      const who = rest.join(" ");
      let reply: string;
      if (/^add$/i.test(verb) && who) reply = (await addFamilyMember(broadcasterId, who)).message;
      else if (/^(remove|rm|del)$/i.test(verb) && who) reply = (await removeFamilyMember(broadcasterId, who)).message;
      else {
        const s = await getSettings(broadcasterId);
        const list = s.family.length ? `Family: ${s.family.map((m) => m.name).join(", ")}.` : "No family members yet.";
        reply = `${list} Mods: !steam family add <Steam profile link> · !steam family remove <name or link | all>`;
      }
      await sendChatMessage(`@${display} ${reply}`, broadcasterId);
      return true;
    }
    if (sub === "unlink") {
      const s = await getSettings(broadcasterId);
      await saveSettings(broadcasterId, { ...s, steamId: "", apiKey: "" });
      await sendChatMessage(`@${display} Unlinked the Steam account.`, broadcasterId);
      return true;
    }
    if (!match[2]) {
      await sendChatMessage(`@${display} Usage: !steam link <Steam profile link or ID>, e.g. !steam link steamcommunity.com/id/yourname`, broadcasterId);
      return true;
    }
    const result = await linkSteamAccount(broadcasterId, match[2]);
    const next = result.ok && !on ? " Turn it on with !feature steam on." : result.ok ? " Chat can roll one with !steam." : "";
    await sendChatMessage(`@${display} ${result.message}${next}`, broadcasterId);
    return true;
  }
  if (!on) return false;
  if (Date.now() - (lastPick.get(broadcasterId) ?? 0) < PICK_COOLDOWN_MS) return true; // one roll at a time; extra !steams in a burst are ignored
  lastPick.set(broadcasterId, Date.now());
  const pool = await gamePool(broadcasterId);
  if (!pool) {
    await sendChatMessage(`@${display} ${channelName} hasn't linked a Steam account yet. A mod can type !steam link <Steam profile link>.`, broadcasterId);
    return true;
  }
  if (!pool.games.length) {
    await sendChatMessage(`@${display} The dice found no ${pool.kind} games to choose from.`, broadcasterId);
    return true;
  }
  const game = pool.games[Math.floor(Math.random() * pool.games.length)];
  const of = pool.games.length === 1 ? "the only" : `1 of ${pool.games.length}`;
  await sendChatMessage(`@${display} 🎲 The dice have spoken: ${game.name}! (${of} ${pool.kind} game${pool.games.length === 1 ? "" : "s"}) https://store.steampowered.com/app/${game.appid}`, broadcasterId);
  return true;
}

// ── Uploader endpoint ───────────────────────────────────────────────────────

/** POST /steam/installed — { channel, key, games: [{ appid, name }] } from tools/steam_upload.ts. */
export async function handleSteamUpload(req: Request): Promise<Response> {
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  let body: any;
  try {
    body = await req.json();
  } catch (_) {
    return reply(400, { ok: false, error: "Send JSON." });
  }
  const channel = String(body?.channel ?? "");
  const key = String(body?.key ?? "");
  if (!/^\d{1,20}$/.test(channel) || !key) return reply(400, { ok: false, error: "Missing channel or key." });
  const s = await getSettings(channel);
  if (!s.uploadKey || !timingSafeEqual(s.uploadKey, key)) return reply(403, { ok: false, error: "That uploader key isn't right. Copy the command from the dashboard's 🎮 Steam picker page again." });
  const games = cleanGames(body?.games);
  await sqlite.execute(
    `INSERT INTO steam_installed (broadcaster_id, games, uploaded_at) VALUES (?,?,?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET games = excluded.games, uploaded_at = excluded.uploaded_at`,
    [channel, JSON.stringify(games), Date.now()],
  );
  return reply(200, { ok: true, saved: games.length });
}

// ── Dashboard page (auth is done by the caller; see dashboard.ts) ──────────

export async function applySteamForm(broadcasterId: string, form: FormData): Promise<{ ok: boolean; message: string }> {
  const s = await getSettings(broadcasterId);
  const intent = String(form.get("intent") ?? "");
  if (intent === "uploader_key") {
    await saveSettings(broadcasterId, { ...s, uploadKey: newUploadKey() });
    return { ok: true, message: s.uploadKey ? "New uploader key made. The old one stops working: copy the new command below onto your gaming PC." : "Uploader key made. Copy the command below onto your gaming PC." };
  }
  if (intent === "installed_clear") {
    await sqlite.execute("DELETE FROM steam_installed WHERE broadcaster_id = ?", [broadcasterId]);
    return { ok: true, message: "Forgot the installed list." };
  }
  if (intent === "api_clear") {
    await saveSettings(broadcasterId, { ...s, steamId: "", apiKey: "" });
    return { ok: true, message: "Unlinked your Steam account." };
  }
  if (intent === "skip") {
    const skip = String(form.get("skip") ?? "").split(/\r?\n/).map((l) => l.trim().slice(0, MAX_NAME)).filter(Boolean).join("\n").slice(0, MAX_SKIP * 10);
    await saveSettings(broadcasterId, { ...s, skip });
    const n = skip ? skip.split("\n").length : 0;
    return { ok: true, message: n ? `Saved — ${n} game${n === 1 ? "" : "s"} left out.` : "Saved — nothing left out." };
  }
  if (intent === "family_add") return await addFamilyMember(broadcasterId, String(form.get("member") ?? ""));
  if (intent === "family_remove") return await removeFamilyMember(broadcasterId, String(form.get("member") ?? ""));
  if (intent === "api") return await linkSteamAccount(broadcasterId, String(form.get("steam_id") ?? "") || s.steamId, String(form.get("api_key") ?? ""));
  return { ok: false, message: "Unknown action." };
}

/** Links a Steam profile (and optionally the channel's own Web API key), checked with Steam first. */
async function linkSteamAccount(broadcasterId: string, profile: string, typedKey = ""): Promise<{ ok: boolean; message: string }> {
  const s = await getSettings(broadcasterId);
  const ownKey = typedKey.trim() || s.apiKey;
  const apiKey = ownKey || apiKeyFor(s);
  if (!apiKey) return { ok: false, message: "This GuildScribe has no Steam Web API key of its own, so add yours (free, from steamcommunity.com/dev/apikey) on the dashboard's 🎮 Steam picker page." };
  if (!KEY_RE.test(apiKey)) return { ok: false, message: "A Steam Web API key is 32 letters and numbers, from steamcommunity.com/dev/apikey." };
  const id = await resolveSteamId(profile, apiKey);
  if ("error" in id) return { ok: false, message: id.error };
  const owned = await fetchOwnedGames(id.steamId, apiKey);
  if ("error" in owned) {
    return {
      ok: false,
      message: owned.error === "key"
        ? "Steam didn't accept that Web API key."
        : owned.error === "private"
        ? "Steam won't share that account's games. On Steam: Edit Profile → Privacy Settings → set \"Game details\" to Public, then try again."
        : "Couldn't reach Steam just now. Try again in a minute.",
    };
  }
  await saveSettings(broadcasterId, { ...s, steamId: id.steamId, apiKey: ownKey.toUpperCase() }); // the server-wide key is never copied into a channel
  ownedCache.set(id.steamId, { at: Date.now(), games: owned.games });
  return { ok: true, message: `Linked — Steam lists ${owned.games.length} owned game${owned.games.length === 1 ? "" : "s"}.` };
}

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

export async function renderSteamDashboardPage(d: { broadcasterId: string; broadcasterName: string; key: string; notice?: string; error?: string }): Promise<string> {
  const [s, installed, on] = await Promise.all([getSettings(d.broadcasterId), getInstalled(d.broadcasterId), isCommandGroupEnabled(d.broadcasterId, "steam")]);
  const libs = await libraries(s);
  const own = libs.find((l) => l.id === s.steamId)?.games ?? null;
  const owned = libs.length ? await ownedGamesFor(s) : null;
  const pool = await gamePool(d.broadcasterId);
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);
  const serverKey = Boolean(Deno.env.get("STEAM_API_KEY"));
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const btn = (intent: string, label: string, cls: string, confirm = "") =>
    `<form method="post" action="/dashboard/steam" class="inline"${confirm ? ` onsubmit="return confirm('${confirm}')"` : ""}>${hidden}<input type="hidden" name="intent" value="${intent}"><button type="submit" class="${cls}">${label}</button></form>`;
  const btnWith = (intent: string, field: string, value: string, label: string, cls: string) =>
    `<form method="post" action="/dashboard/steam" class="inline">${hidden}<input type="hidden" name="intent" value="${intent}"><input type="hidden" name="${field}" value="${escapeHtml(value)}"><button type="submit" class="${cls}">${label}</button></form>`;
  const command = s.uploadKey
    ? `deno run --allow-read --allow-net ${steamUploaderUrl()} --channel ${d.broadcasterId} --key ${s.uploadKey} --every 30`
    : "";
  const status = pool
    ? `<p class="ok-line">✓ <code>!steam</code> picks from ${pool.games.length} ${pool.kind} game${pool.games.length === 1 ? "" : "s"}${pool.kind === "installed" && owned?.length ? ` (the installed games ${s.family.length ? "your family owns" : "your account owns"})` : ""}.</p>`
    : `<p class="note">Nothing to pick from yet — set up either step below.</p>`;
  const body = `<header class="dash-top"><div><span class="pill">Stream · Steam picker</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>Can't decide what to play? Chat types <code>!steam</code> and GuildScribe rolls a random game from your Steam library. ${serverKey ? "All it needs is your Steam profile link" : "It needs your Steam profile link and a free Steam Web API key"}. ${serverKey ? `A mod can even do that from chat: <code>!steam link steamcommunity.com/id/yourname</code>.` : ""}</p>
${on ? "" : `<p class="note"><code>!steam</code> is off. Turn on "Steam picker" on the dashboard (or type <code>!feature steam on</code>).</p>`}
${status}

<h2>1 · Your Steam profile</h2>
<p>Paste your profile link (or your 17-digit Steam ID). Your profile's <strong>Game details</strong> must be Public: on Steam, Edit Profile → Privacy Settings.${serverKey ? "" : ` Get a free Web API key at <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener">steamcommunity.com/dev/apikey</a> (any domain name will do).`}</p>
${s.steamId ? `<p class="ok-line">✓ Steam account <a href="https://steamcommunity.com/profiles/${escapeHtml(s.steamId)}" target="_blank" rel="noopener">${escapeHtml(s.steamId)}</a>${s.apiKey ? ` with your key ${mask(s.apiKey)}` : ""}${own ? ` — ${own.length} owned games` : ""}. ${btn("api_clear", "Unlink", "ghost", "Unlink your Steam account?")}</p>` : ""}
<form method="post" action="/dashboard/steam" class="grid2">${hidden}<input type="hidden" name="intent" value="api">
<label>Steam profile link or ID<input name="steam_id" value="${escapeHtml(s.steamId)}" maxlength="100" placeholder="steamcommunity.com/id/yourname" required autocomplete="off" spellcheck="false"></label>
<label>Web API key${serverKey ? ` <span class="muted small">(optional)</span>` : ""}<input name="api_key" placeholder="${s.apiKey ? `saved (${mask(s.apiKey)}) — leave blank to keep` : serverKey ? "not needed — GuildScribe has one" : "32 letters and numbers"}" maxlength="40" ${s.apiKey || serverKey ? "" : "required"} autocomplete="off" spellcheck="false"></label>
<p><button type="submit" class="ember">Save and check with Steam</button></p></form>

<h2>2 · Family library <span class="muted small">(optional)</span></h2>
<p>In a Steam Family? Add the other members' profiles and <code>!steam</code> rolls from everyone's games together. Steam doesn't let outside apps read a family's shared library, so this goes by what each member owns: their <strong>Game details</strong> must be Public too, and a game they've kept out of sharing (or one that can't be shared) can still come up. Mods can do this in chat too: <code>!steam family add &lt;profile link&gt;</code>.</p>
${s.family.length ? `<ul class="family">${s.family.map((m) => {
    const games = libs.find((l) => l.id === m.id)?.games;
    return `<li><a href="https://steamcommunity.com/profiles/${escapeHtml(m.id)}" target="_blank" rel="noopener">${escapeHtml(m.name)}</a> <span class="muted small">${games ? `${games.length} games` : "games hidden — their Game details aren't Public"}</span> ${btnWith("family_remove", "member", m.id, "Remove", "ghost")}</li>`;
  }).join("")}</ul>${owned ? `<p class="muted small">${owned.length} different games across the family.</p>` : ""}` : ""}
${s.family.length < MAX_FAMILY ? `<form method="post" action="/dashboard/steam" class="grid2">${hidden}<input type="hidden" name="intent" value="family_add">
<label>Family member's profile link or ID<input name="member" maxlength="100" placeholder="steamcommunity.com/id/theirname" required autocomplete="off" spellcheck="false"></label>
<p><button type="submit" class="ember">Add to family</button></p></form>` : ""}

<h2>3 · Only installed games <span class="muted small">(optional)</span></h2>
<p>Steam only tells the internet which games you <em>own</em>, so <code>!steam</code> can roll one you'd have to download first. Which games are <em>installed</em> only lives on your gaming PC. To pick from those, run a small script there: it reads Steam's install list (<code>libraryfolders.vdf</code> and each library's <code>appmanifest_*.acf</code>) and sends just the game names and IDs here. It needs <a href="https://deno.com" target="_blank" rel="noopener">Deno</a> on that PC.</p>
${installed ? `<p class="ok-line">✓ ${installed.games.length} installed game${installed.games.length === 1 ? "" : "s"}, last sent ${ago(installed.uploadedAt)}. ${btn("installed_clear", "Forget list", "ghost", "Forget the installed list?")}</p>` : ""}
${command
    ? `<p>Run this on your gaming PC (in PowerShell or a terminal). With <code>--every 30</code> it keeps running and re-sends every 30 minutes; leave that off to send once. Keep the key private — anyone with it can replace your list.</p>
<pre class="cmd">${escapeHtml(command)}</pre>
<p class="muted small">Steam installed somewhere unusual? Add <code>--steam "D:\\Steam"</code>. To start it with Windows, put the command in a shortcut in your Startup folder (Win+R → <code>shell:startup</code>).</p>
<p>${btn("uploader_key", "Make a new key", "ghost", "Make a new uploader key? The old command stops working.")}</p>`
    : `<p>${btn("uploader_key", "Get my uploader command", "ember")}</p>`}

<h2>Leave out</h2>
<p class="muted small">Installed or owned things that aren't for playing on stream (Wallpaper Engine, a PNGTuber app, a game you've sworn off). One name per line, exactly as Steam shows it.</p>
<form method="post" action="/dashboard/steam">${hidden}<input type="hidden" name="intent" value="skip">
<textarea name="skip" rows="4" placeholder="Wallpaper Engine&#10;PNGTuber Plus">${escapeHtml(s.skip)}</textarea>
<p><button type="submit" class="ember">Save</button></p></form>`;
  return scrollDoc(`${d.broadcasterName} — Steam picker`, body, {
    width: 860,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}
.grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin:10px 0}.grid2 label{display:flex;flex-direction:column;gap:4px;font-weight:600;font-size:.9rem}.grid2 input{padding:9px 12px;font-weight:400;min-width:0}.grid2 p{grid-column:1/-1;margin:0}
form.inline{display:inline}ul.family{padding-left:20px}ul.family li{margin:6px 0}textarea{width:100%;padding:9px 12px;font:inherit}pre.cmd{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px 14px;background:#f3ead0;border:1px solid var(--edge);border-radius:6px;font-size:.85rem}
.ok-line{color:var(--ok);font-weight:600;overflow-wrap:anywhere}.muted{color:var(--ink-3)}.small{font-size:.86rem}
@media (max-width:560px){.grid2{grid-template-columns:1fr}}`,
  });
}

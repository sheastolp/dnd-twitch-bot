// !stats — the streamer's stats for whichever game the dashboard picked
// (game_stats_page.ts, /dashboard/stats). Warframe is the default and is
// read live from Warframe's public profile endpoint by account ID; the other
// games (The Division 2, Baldur's Gate 3 and any custom ones) have no public
// stats API, so their line is whatever the streamer typed on the dashboard.
//
//   !stats          → the game the dashboard has selected
//   !stats <game>   → a specific game (warframe/wf, div2, bg3, or a custom name)
//
// Warframe profiles are cached per account so a busy chat costs at most one
// request every WF_CACHE_MS (failures are cached too: the endpoint IP-blocks
// clients that hammer it with bad IDs).

import { sqlite } from "./sqlite.ts";
import { sendChatMessage } from "./twitch.ts";
import { getCustomCommand } from "./db.ts";

const WF_CACHE_MS = 10 * 60_000;
const WF_FAIL_CACHE_MS = 2 * 60_000;
const WF_TIMEOUT_MS = 6000;
export const STATS_LINE_MAX = 400;
export const CUSTOM_GAMES_MAX = 12;

export type GameDef = { key: string; name: string; emoji: string; aliases: string[] };

export const BUILTIN_GAMES: GameDef[] = [
  { key: "warframe", name: "Warframe", emoji: "🟦", aliases: ["warframe", "wf"] },
  { key: "div2", name: "The Division 2", emoji: "🟠", aliases: ["div2", "division", "division2", "thedivision2", "td2"] },
  { key: "bg3", name: "Baldur's Gate 3", emoji: "🐉", aliases: ["bg3", "baldursgate", "baldursgate3", "baldurs"] },
];
export const DEFAULT_GAME = "warframe";

/** Warframe's profile host per platform. */
export const WF_PLATFORMS: Record<string, { label: string; host: string }> = {
  pc: { label: "PC", host: "api.warframe.com" },
  ps: { label: "PlayStation", host: "api-ps4.warframe.com" },
  xbox: { label: "Xbox", host: "api-xb1.warframe.com" },
  switch: { label: "Nintendo Switch", host: "api-swi.warframe.com" },
  ios: { label: "iOS", host: "api-mob.warframe.com" },
  android: { label: "Android", host: "api-and.warframe.com" },
};

export async function ensureGameStatsTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS game_stats_settings (
      broadcaster_id TEXT PRIMARY KEY, active_game TEXT NOT NULL, wf_account TEXT, wf_platform TEXT, updated_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS game_stats_lines (
      broadcaster_id TEXT NOT NULL, game_key TEXT NOT NULL, name TEXT NOT NULL, line TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, game_key)
    )`,
  );
}

/** Wipes the channel's game stats — !dndbot leave purge. */
export async function purgeGameStatsData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM game_stats_settings WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM game_stats_lines WHERE broadcaster_id = ?", [broadcasterId]);
}

// ── Settings & lines ──

export type GameStatsSettings = { activeGame: string; wfAccount: string; wfPlatform: string };
export type GameLine = { key: string; name: string; line: string };

export async function getGameStatsSettings(broadcasterId: string): Promise<GameStatsSettings> {
  const res = await sqlite.execute("SELECT active_game, wf_account, wf_platform FROM game_stats_settings WHERE broadcaster_id = ?", [broadcasterId]);
  const r = (res.rows as any[])[0];
  return {
    activeGame: r ? String(r.active_game) : DEFAULT_GAME,
    wfAccount: r?.wf_account ? String(r.wf_account) : "",
    wfPlatform: r?.wf_platform && WF_PLATFORMS[String(r.wf_platform)] ? String(r.wf_platform) : "pc",
  };
}

export async function saveGameStatsSettings(broadcasterId: string, patch: Partial<GameStatsSettings>) {
  const s = { ...(await getGameStatsSettings(broadcasterId)), ...patch };
  await sqlite.execute(
    "INSERT OR REPLACE INTO game_stats_settings (broadcaster_id, active_game, wf_account, wf_platform, updated_at) VALUES (?,?,?,?,?)",
    [broadcasterId, s.activeGame, s.wfAccount || null, s.wfPlatform, Date.now()],
  );
}

/** Every typed line (built-in games' and custom games'), keyed by game. */
export async function listGameLines(broadcasterId: string): Promise<Map<string, GameLine>> {
  const res = await sqlite.execute("SELECT game_key, name, line FROM game_stats_lines WHERE broadcaster_id = ? ORDER BY updated_at", [broadcasterId]);
  return new Map((res.rows as any[]).map((r) => [String(r.game_key), { key: String(r.game_key), name: String(r.name), line: String(r.line) }]));
}

export async function setGameLine(broadcasterId: string, key: string, name: string, line: string) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO game_stats_lines (broadcaster_id, game_key, name, line, updated_at) VALUES (?,?,?,?,?)",
    [broadcasterId, key, name, line, Date.now()],
  );
}

export async function removeGameLine(broadcasterId: string, key: string) {
  await sqlite.execute("DELETE FROM game_stats_lines WHERE broadcaster_id = ? AND game_key = ?", [broadcasterId, key]);
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Key for a custom game's name ("Elden Ring" → "c_eldenring"). */
export const customGameKey = (name: string) => `c_${squash(name).slice(0, 30)}`;
export const isCustomKey = (key: string) => key.startsWith("c_");

/** All games the channel can show: the built-ins plus its custom ones. */
export function channelGames(lines: Map<string, GameLine>): GameDef[] {
  const custom = [...lines.values()].filter((l) => isCustomKey(l.key)).map((l) => ({ key: l.key, name: l.name, emoji: "🎮", aliases: [squash(l.name)] }));
  return [...BUILTIN_GAMES, ...custom];
}

function findGame(games: GameDef[], word: string): GameDef | undefined {
  const w = squash(word);
  if (!w) return undefined;
  return games.find((g) => g.key === w || g.aliases.includes(w)) ?? games.find((g) => squash(g.name).startsWith(w));
}

// ── Warframe profile ──

export const isWfAccountId = (s: string) => /^[0-9a-f]{24}$/i.test(s);

export type WfProfile = { name: string; mr: number; hours: number; missions: number; kills: number; clan: string };
type WfResult = { ok: true; profile: WfProfile } | { ok: false; error: string };

const wfCache = new Map<string, { at: number; ttl: number; result: WfResult }>();

/** The streamer's Warframe profile (cached). Never throws. */
export async function fetchWarframeProfile(accountId: string, platform: string): Promise<WfResult> {
  const cacheKey = `${platform}:${accountId}`;
  const hit = wfCache.get(cacheKey);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.result;
  const host = (WF_PLATFORMS[platform] ?? WF_PLATFORMS.pc).host;
  let result: WfResult;
  try {
    const res = await fetch(`https://${host}/cdn/getProfileViewingData.php?playerId=${encodeURIComponent(accountId)}`, { signal: AbortSignal.timeout(WF_TIMEOUT_MS) });
    const text = await res.text();
    if (res.status === 409 || /could not find/i.test(text)) result = { ok: false, error: "Warframe couldn't find that account ID" };
    else if (!res.ok || !text) result = { ok: false, error: `Warframe's profile service answered ${res.status}` };
    else result = { ok: true, profile: parseWarframeProfile(JSON.parse(text)) };
  } catch (e) {
    result = { ok: false, error: e instanceof DOMException && e.name === "TimeoutError" ? "Warframe's profile service timed out" : "Warframe's profile service couldn't be read" };
  }
  wfCache.set(cacheKey, { at: Date.now(), ttl: result.ok ? WF_CACHE_MS : WF_FAIL_CACHE_MS, result });
  if (wfCache.size > 500) wfCache.delete(wfCache.keys().next().value!);
  return result;
}

export function parseWarframeProfile(data: any): WfProfile {
  const p = data?.Results?.[0] ?? {};
  const s = data?.Stats ?? {};
  const kills = Array.isArray(s.Enemies) ? s.Enemies.reduce((n: number, e: any) => n + (Number(e?.kills) || 0), 0) : 0;
  return {
    // Display names end in a private-use platform glyph; drop it.
    name: String(p.DisplayName ?? "Tenno").replace(/[-]/g, "").trim() || "Tenno",
    mr: Number(p.PlayerLevel ?? s.PlayerLevel) || 0,
    hours: Math.round((Number(s.TimePlayedSec) || 0) / 3600),
    missions: Number(s.MissionsCompleted) || 0,
    kills,
    clan: String(p.GuildName ?? s.GuildName ?? "").replace(/#\d+$/, "").trim(),
  };
}

const big = (n: number) => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${+(n / 1e3).toFixed(1)}k` : n.toLocaleString("en-US");
const mrLabel = (mr: number) => (mr > 30 ? `Legendary ${mr - 30}` : `MR ${mr}`);

export function formatWarframeProfile(p: WfProfile): string {
  return [`${p.name} · ${mrLabel(p.mr)}`, `${big(p.hours)}h played`, `${big(p.missions)} missions`, `${big(p.kills)} kills`, p.clan ? `Clan ${p.clan}` : ""]
    .filter(Boolean).join(" · ");
}

// ── The reply ──

/** The !stats text for one game, without the @mention. */
export async function statsText(broadcasterId: string, gameKey: string, settings?: GameStatsSettings, lines?: Map<string, GameLine>): Promise<string> {
  const [s, l] = await Promise.all([settings ?? getGameStatsSettings(broadcasterId), lines ?? listGameLines(broadcasterId)]);
  const game = channelGames(l).find((g) => g.key === gameKey) ?? BUILTIN_GAMES[0];
  const typed = l.get(game.key)?.line ?? "";
  const head = `${game.emoji} ${game.name}`;
  if (game.key === "warframe") {
    if (!s.wfAccount) return typed ? `${head}: ${typed}` : `${head} stats aren't set up yet — a mod can add the Warframe account ID on the dashboard.`;
    const r = await fetchWarframeProfile(s.wfAccount, s.wfPlatform);
    if (!r.ok) return typed ? `${head}: ${typed}` : `${head} stats are unavailable right now (${r.error}).`;
    return `${head}: ${formatWarframeProfile(r.profile)}${typed ? ` | ${typed}` : ""}`;
  }
  return typed ? `${head}: ${typed}` : `${head} stats haven't been filled in yet — a mod can add them on the dashboard.`;
}

export async function handleGameStatsCommand(chatMessage: string, display: string, broadcasterId: string): Promise<boolean> {
  const m = chatMessage.trim().match(/^!stats(?:\s+(.+))?$/i);
  if (!m) return false;
  // A channel's own !stats command wins.
  const custom = await getCustomCommand(broadcasterId, "stats");
  if (custom && Number(custom.enabled ?? 1) === 1) return false;

  const [settings, lines] = await Promise.all([getGameStatsSettings(broadcasterId), listGameLines(broadcasterId)]);
  const games = channelGames(lines);
  let key = settings.activeGame;
  if (m[1]) {
    const game = findGame(games, m[1]);
    if (!game) {
      await sendChatMessage(`@${display} No stats for "${m[1].trim().slice(0, 30)}". Try: ${games.map((g) => `!stats ${g.aliases[0]}`).join(", ")}`, broadcasterId);
      return true;
    }
    key = game.key;
  }
  await sendChatMessage(`@${display} ${await statsText(broadcasterId, key, settings, lines)}`, broadcasterId);
  return true;
}

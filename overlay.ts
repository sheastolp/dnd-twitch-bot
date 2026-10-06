// GuildScribe — OBS overlays. Transparent browser-source pages that show a
// channel's live game state (raid boss, the fight under way, giveaway, the
// peddler's stall, swear jar) and running summaries (coin leaderboard,
// natural 1/20 roll call, the guild's top adventurers).
//
//   GET /overlays?channel=<id|login>                 setup page: every overlay URL + live previews
//   GET /overlay?channel=<id|login>&panel=<name>     one overlay (the OBS browser source)
//   GET /overlay?channel=<id|login>&panel=theme      the whole stream layout in one source (overlay_theme.ts);
//                                                    &scene=game|brb|chat picks the layout (overlay_scenes.ts)
//   GET /overlay/data?channel=<id|login>&panels=a,b  the JSON the overlay polls
//   GET /overlay/title?channel=<id|login>            the stream's current title and live state (the theme's
//                                                    subtitle and live gem poll it; &title=0 skips the title)
//   GET /overlay?channel=<id|login>&panel=idle       The Endless Delve, the idle game chat plays (idle.ts)
//   GET /overlay/idle?channel=<id|login>             its list of the channel's heroes (class, level)
//   GET /overlay/nowplaying?channel=<id|login>       the song playing now (nowplaying.ts); panel=music shows it
//   GET /overlay?channel=<id|login>&panel=sounds     Sound Bytes: plays the sound effects chat fires with !sound (soundbytes.ts)
//
// Same trust model as /roster and /bestiary: public, read-only, and only for
// connected channels. Nothing here is private — activity logs are never
// exposed. Each panel respects the channel's dashboard switches, so a feature
// that's switched off never shows up on stream. `!overlays` (mod) posts the
// setup link in chat.

import { scrollDoc } from "./scroll_theme.ts";
import { sqlite } from "./sqlite.ts";
import { getBroadcaster, getBroadcasterByLogin, getCommandGroupToggles, isCommandGroupEnabled, getDuel, getMonsterDuel, getPartyDuel, getPartyMonsterDuel, isMerchantEnabled, getMerchantListing, listChannelCharacters } from "./db.ts";
import { isPointsEnabled, getTopBalances } from "./points_db.ts";
import { getDiceLeaderboard } from "./social_db.ts";
import { getRaidRosterStatus } from "./raid.ts";
import { getJarTotal } from "./swearjar.ts";
import { lookupViewerNames } from "./mentions.ts";
import { formatCoins } from "./coins.ts";
import { formatRaceName } from "./utils.ts";
import { DUEL_IDLE_TIMEOUT_MS } from "./combat_shared.ts";
import { renderThemePage } from "./overlay_theme.ts";
import { getDelveOptions, getIdleHeroes, renderIdlePage } from "./idle.ts";
import { getChannelBotLogins } from "./channel_bots.ts";
import { getNowPlaying, renderNowPlayingOverlay } from "./nowplaying.ts";
import { renderSoundBytesOverlay } from "./soundbytes.ts";
import { getRecentBattles, type BattleEntry } from "./battle_log.ts";
import { getSavingThrowTally, type SaveTally } from "./savingthrows.ts";
import { renderOverlayPage, renderOverlayIndexPage, OVERLAY_PANELS } from "./overlay_page.ts";
import { PUBLIC_BASE_URL } from "./config.ts";
import { env, getAppToken, getChannelInfo } from "./twitch.ts";

/** Panels that fetch their own slice of data; "status", "all" and "rotate" combine these. */
export const DATA_PANELS = ["raid", "battle", "giveaway", "merchant", "jar", "gold", "dice", "guild", "saves"] as const;
type DataPanel = typeof DATA_PANELS[number];

const DICE_WINDOWS: Record<string, number> = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };
/** A closed giveaway's winners stay on screen this long after the draw. */
const GIVEAWAY_WINNER_SHOW_MS = 10 * 60_000;

type Combatant = { name: string; hp: number; hpMax: number; turn: boolean; down: boolean };
type Fight = { kind: string; title: string; sides: Array<{ label: string; combatants: Combatant[] }> };

export type OverlayData = {
  channel: { id: string; name: string; live: boolean };
  updatedAt: number;
  raid?: Awaited<ReturnType<typeof getRaidRosterStatus>>;
  battle?: Fight[];
  /** Finished fights from the last RECENT_WINDOW_MS, newest first (battle_log.ts). */
  recent?: Array<BattleEntry & { at: number }>;
  giveaway?: { prize: string; cost: string; maxTickets: number; open: boolean; entrants: number; tickets: number; winners: string[] } | null;
  merchant?: { merchant: string; item: string; price: string; postedAt: number } | null;
  jar?: { total: number; text: string } | null;
  gold?: Array<{ name: string; balance: number; text: string }> | null;
  dice?: { window: string; nat20: Array<{ name: string; count: number }>; nat1: Array<{ name: string; count: number }> } | null;
  guild?: { characters: number; parties: number; top: Array<{ name: string; level: number; race: string; cls: string; hp: number; hpMax: number }> } | null;
  /** This stream's saving throws tally (savingthrows.ts), drawn by the theme's brb and chat scenes. */
  saves?: SaveTally | null;
};

async function resolveChannel(param: string | null) {
  if (!param) return null;
  const clean = param.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,25}$/.test(clean)) return null;
  const b: any = /^\d+$/.test(clean) ? await getBroadcaster(clean) : await getBroadcasterByLogin(clean.toLowerCase());
  if (!b || Number(b.connected) !== 1) return null;
  return {
    id: String(b.broadcaster_id),
    login: String(b.login ?? ""),
    name: String(b.display_name || b.login || "This channel"),
    live: Number(b.is_live) === 1,
  };
}

// The theme's title is the channel's name as Twitch has it *now* (the stored
// display_name is from when the channel connected, so a rename or a change of
// capitals wouldn't show). Cached per isolate; a changed name is saved back.
const NAME_TTL_MS = 10 * 60_000;
const nameCache = new Map<string, { at: number; login: string; name: string }>();

async function liveChannelName(channel: { id: string; login: string; name: string }): Promise<{ login: string; name: string }> {
  const hit = nameCache.get(channel.id);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit;
  let login = channel.login, name = channel.name;
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(channel.id)}`, {
      headers: { Authorization: `Bearer ${await getAppToken()}`, "Client-Id": env("TWITCH_CLIENT_ID") },
      signal: AbortSignal.timeout(3000),
    });
    const user = res.ok ? (await res.json())?.data?.[0] : null;
    if (user?.login) {
      login = String(user.login);
      name = String(user.display_name || user.login);
      if (login !== channel.login || name !== channel.name) {
        await sqlite.execute("UPDATE broadcasters SET login = ?, display_name = ? WHERE broadcaster_id = ?", [login, name, channel.id]).catch(() => {});
      }
    }
  } catch (_) { /* Twitch unreachable — fall back to the stored name */ }
  const out = { at: Date.now(), login, name };
  nameCache.set(channel.id, out);
  return out;
}

// The theme's subtitle is the stream title. It changes mid-stream, so the
// theme page polls /overlay/title; a per-isolate cache keeps every open
// source to one Helix call a minute. On a failed lookup the last known title
// stays up rather than blanking.
const STREAM_TITLE_TTL_MS = 60_000;
const streamTitleCache = new Map<string, { at: number; title: string }>();

async function liveStreamTitle(channelId: string): Promise<string> {
  const hit = streamTitleCache.get(channelId);
  if (hit && Date.now() - hit.at < STREAM_TITLE_TTL_MS) return hit.title;
  const info = await getChannelInfo(channelId);
  const title = info ? info.title.trim() : hit?.title ?? "";
  streamTitleCache.set(channelId, { at: Date.now(), title });
  return title;
}

// The battle tracker's "Recent battles": most fights are auto-resolved in one
// message, so without these the tracker would sit empty nearly all stream.
const RECENT_LIMIT = 5;
const RECENT_WINDOW_MS = 45 * 60_000;

const fresh = (row: any) => row && Date.now() - Number(row.updated_at ?? 0) <= DUEL_IDLE_TIMEOUT_MS;

/** Every fight under way in the channel, with HP for each side. */
async function loadFights(channelId: string): Promise<Fight[]> {
  const [duel, hunt, partyDuel, partyHunt]: any[] = await Promise.all([
    getDuel(channelId),
    getMonsterDuel(channelId),
    getPartyDuel(channelId),
    getPartyMonsterDuel(channelId),
  ]);
  const players = new Set<string>();
  if (fresh(duel)) [duel.challenger, duel.defender].forEach((n: string) => players.add(String(n)));
  if (fresh(hunt)) players.add(String(hunt.player));
  if (fresh(partyDuel)) [...partyDuel.challenger_members, ...partyDuel.defender_members].forEach((n: string) => players.add(String(n)));
  if (fresh(partyHunt)) partyHunt.members.forEach((n: string) => players.add(String(n)));
  if (!players.size) return [];

  // Max HP (and display names) for everyone on the field, in two queries.
  const list = [...players].map((p) => p.toLowerCase());
  const [maxRes, names] = await Promise.all([
    sqlite.execute(
      `SELECT username, hp_max, hp_current FROM characters WHERE broadcaster_id = ? AND username IN (${list.map(() => "?").join(",")})`,
      [channelId, ...list],
    ),
    lookupViewerNames(channelId, list).catch(() => new Map<string, string>()),
  ]);
  const sheet = new Map<string, { max: number; cur: number }>(
    (maxRes.rows as any[]).map((r) => [String(r.username).toLowerCase(), { max: Number(r.hp_max), cur: Number(r.hp_current) }]),
  );
  const who = (u: string) => names.get(String(u).toLowerCase()) ?? String(u);
  const person = (u: string, hp: number | undefined, turn: boolean): Combatant => {
    const s = sheet.get(String(u).toLowerCase());
    const cur = Number(hp ?? s?.cur ?? 0);
    const max = Math.max(1, s?.max ?? cur);
    return { name: who(u), hp: Math.max(0, cur), hpMax: Math.max(max, cur), turn, down: cur <= 0 };
  };
  const monster = (r: any, turn: boolean): Combatant => ({
    name: `${r.monster_name} (CR ${r.monster_cr})`,
    hp: Math.max(0, Number(r.monster_hp)),
    hpMax: Math.max(1, Number(r.monster_hp_max)),
    turn,
    down: Number(r.monster_hp) <= 0,
  });

  const fights: Fight[] = [];
  if (fresh(duel)) {
    const turn = String(duel.current_turn ?? "").toLowerCase();
    fights.push({
      kind: "duel",
      title: "⚔️ Arena duel",
      sides: [
        { label: who(duel.challenger), combatants: [person(duel.challenger, duel.challenger_hp, turn === String(duel.challenger).toLowerCase())] },
        { label: who(duel.defender), combatants: [person(duel.defender, duel.defender_hp, turn === String(duel.defender).toLowerCase())] },
      ],
    });
  }
  if (fresh(hunt)) {
    const monsterTurn = String(hunt.current_turn ?? "").toLowerCase() !== String(hunt.player).toLowerCase();
    fights.push({
      kind: "hunt",
      title: "🐉 Monster hunt",
      sides: [
        { label: who(hunt.player), combatants: [person(hunt.player, hunt.player_hp ?? undefined, !monsterTurn)] },
        { label: String(hunt.monster_name), combatants: [monster(hunt, monsterTurn)] },
      ],
    });
  }
  if (fresh(partyDuel)) {
    const side = (members: string[], hp: Record<string, number>, isCurrent: boolean) =>
      members.map((m, i) => person(m, hp[m] ?? 0, isCurrent && i === partyDuel.current_index));
    const challengerTurn = String(partyDuel.current_side) === "challenger";
    fights.push({
      kind: "partyduel",
      title: "🛡️ Party duel",
      sides: [
        { label: String(partyDuel.challenger_party), combatants: side(partyDuel.challenger_members, partyDuel.challenger_hp, challengerTurn) },
        { label: String(partyDuel.defender_party), combatants: side(partyDuel.defender_members, partyDuel.defender_hp, !challengerTurn) },
      ],
    });
  }
  if (fresh(partyHunt)) {
    const members: string[] = partyHunt.members;
    fights.push({
      kind: "partyhunt",
      title: "🏹 Party hunt",
      sides: [
        {
          label: String(partyHunt.party_name),
          combatants: members.map((m, i) => person(m, partyHunt.member_hp[m] ?? 0, i === partyHunt.current_index)),
        },
        // The monster strikes back after each hero, so it never holds the turn.
        { label: String(partyHunt.monster_name), combatants: [monster(partyHunt, false)] },
      ],
    });
  }
  return fights;
}

async function loadGiveaway(channelId: string): Promise<OverlayData["giveaway"]> {
  const res = await sqlite.execute(
    `SELECT g.prize, g.cost, g.max_tickets, g.status, g.winners, g.closed_at,
       (SELECT COUNT(*) FROM giveaway_entries e WHERE e.broadcaster_id = g.broadcaster_id) AS entrants,
       (SELECT COALESCE(SUM(tickets),0) FROM giveaway_entries e WHERE e.broadcaster_id = g.broadcaster_id) AS tickets
     FROM giveaways g WHERE g.broadcaster_id = ?`,
    [channelId],
  );
  const r: any = res.rows[0];
  if (!r) return null;
  const open = String(r.status) === "open";
  // A finished giveaway lingers only long enough to show off its winners.
  if (!open && Date.now() - Number(r.closed_at ?? 0) > GIVEAWAY_WINNER_SHOW_MS) return null;
  let winners: string[] = [];
  try {
    winners = (JSON.parse(String(r.winners ?? "[]")) as unknown[]).map(String);
  } catch (_) { /* corrupt JSON — no winners */ }
  if (winners.length) {
    const names = await lookupViewerNames(channelId, winners).catch(() => new Map<string, string>());
    winners = winners.map((w) => names.get(w.toLowerCase()) ?? w);
  }
  return {
    prize: String(r.prize),
    cost: Number(r.cost) > 0 ? formatCoins(Number(r.cost)) : "free",
    maxTickets: Number(r.max_tickets),
    open,
    entrants: Number(r.entrants ?? 0),
    tickets: Number(r.tickets ?? 0),
    winners,
  };
}

async function loadGuild(channelId: string, limit: number): Promise<OverlayData["guild"]> {
  const [counts, top] = await Promise.all([
    sqlite.execute(
      `SELECT (SELECT COUNT(*) FROM characters WHERE broadcaster_id = ?) AS characters,
              (SELECT COUNT(*) FROM parties WHERE broadcaster_id = ?) AS parties`,
      [channelId, channelId],
    ),
    listChannelCharacters(channelId, limit),
  ]);
  const names = await lookupViewerNames(channelId, top.map((c) => c.username)).catch(() => new Map<string, string>());
  return {
    characters: Number(counts.rows[0]?.characters ?? 0),
    parties: Number(counts.rows[0]?.parties ?? 0),
    top: top.map((c) => ({
      name: names.get(c.username.toLowerCase()) ?? c.username,
      level: c.level,
      race: formatRaceName(c.race, c.subrace),
      cls: c.cls,
      hp: c.hpCurrent,
      hpMax: c.hpMax,
    })),
  };
}

/** Gathers the requested panels' data for one channel. A panel whose feature
 * is switched off comes back null (the overlay hides it). */
export async function getOverlayData(
  channel: { id: string; name: string; live: boolean },
  panels: Set<DataPanel>,
  opts: { window: string; limit: number },
): Promise<OverlayData> {
  const id = channel.id;
  const [toggles, goldOn, marketOn] = await Promise.all([
    getCommandGroupToggles(id),
    panels.has("gold") || panels.has("giveaway") ? isPointsEnabled(id) : Promise.resolve(false),
    panels.has("merchant") ? isMerchantEnabled(id) : Promise.resolve(false),
  ]);
  const on = (group: string) => toggles[group] !== false;
  const out: OverlayData = { channel, updatedAt: Date.now() };
  const jobs: Promise<void>[] = [];
  const job = (p: DataPanel, run: () => Promise<void>) => {
    if (panels.has(p)) jobs.push(run().catch((e) => { console.error(`overlay ${p}`, e); }));
  };

  job("raid", async () => { out.raid = on("raid") ? await getRaidRosterStatus(id) : null; });
  job("battle", async () => {
    [out.battle, out.recent] = await Promise.all([loadFights(id), getRecentBattles(id, RECENT_LIMIT, RECENT_WINDOW_MS)]);
  });
  job("giveaway", async () => { out.giveaway = on("giveaways") ? await loadGiveaway(id) : null; });
  job("merchant", async () => {
    const l = marketOn ? await getMerchantListing(id) : null;
    out.merchant = l ? { merchant: String(l.merchantName ?? ""), item: String(l.itemDesc ?? ""), price: String(l.priceText ?? ""), postedAt: l.postedAt } : null;
  });
  job("jar", async () => {
    if (!on("jar")) { out.jar = null; return; }
    const total = await getJarTotal(id);
    out.jar = { total, text: formatCoins(total) };
  });
  job("gold", async () => {
    if (!goldOn || !on("leaderboard")) { out.gold = null; return; }
    out.gold = (await getTopBalances(id, opts.limit)).map((r) => ({ name: r.displayName || r.username, balance: r.balance, text: formatCoins(r.balance) }));
  });
  job("dice", async () => {
    if (!on("rollcall")) { out.dice = null; return; }
    const since = Date.now() - (DICE_WINDOWS[opts.window] ?? DICE_WINDOWS.day);
    const [n20, n1] = await Promise.all([
      getDiceLeaderboard(id, "nat20", since, opts.limit),
      getDiceLeaderboard(id, "nat1", since, opts.limit),
    ]);
    const map = (rows: typeof n20) => rows.map((r) => ({ name: r.displayName || r.username, count: r.count }));
    out.dice = { window: opts.window, nat20: map(n20), nat1: map(n1) };
  });
  job("guild", async () => { out.guild = await loadGuild(id, opts.limit); });
  job("saves", async () => { out.saves = on("rollchecks") ? await getSavingThrowTally(id) : null; });

  await Promise.all(jobs);
  return out;
}

/** Which data panels a display panel needs. */
export function dataPanelsFor(panel: string): DataPanel[] {
  // The battle tracker leads with the raid boss summary (overlay_page.ts).
  if (panel === "battle") return ["battle", "raid"];
  if ((DATA_PANELS as readonly string[]).includes(panel)) return [panel as DataPanel];
  if (panel === "status") return ["raid", "battle", "giveaway", "merchant", "jar"];
  // all, rotate — the saving throws tally is only drawn by the theme.
  return DATA_PANELS.filter((p) => p !== "saves");
}

// Several OBS sources (one per panel, plus the theme's embedded status strip
// and Battle Tracker) poll every few seconds; a short per-isolate cache, and sharing
// one in-flight load between identical requests, keep that from multiplying
// SQLite reads.
const CACHE_MS = 4_000;
const cache = new Map<string, { at: number; data: OverlayData }>();
const inflight = new Map<string, Promise<OverlayData>>();

function parsePanels(raw: string | null): Set<DataPanel> {
  const wanted = (raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const picked = wanted.length ? wanted.flatMap((p) => dataPanelsFor(p)) : dataPanelsFor("all");
  return new Set(picked);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });

/** Overlay routes; null when the path isn't one of them. */
export async function handleOverlayRoute(req: Request, url: URL, path: string): Promise<Response | null> {
  if (req.method !== "GET" || !(path === "/overlay" || path === "/overlays" || path === "/overlay/data" || path === "/overlay/title" || path === "/overlay/idle" || path === "/overlay/nowplaying")) return null;
  const channel = await resolveChannel(url.searchParams.get("channel"));

  if (path === "/overlay/title") {
    if (!channel) return json({ ok: false, error: "Unknown or disconnected channel." }, 404);
    const [title, idle] = await Promise.all([
      url.searchParams.get("title") === "0" ? undefined : liveStreamTitle(channel.id),
      isCommandGroupEnabled(channel.id, "delve"), // the theme drops/restores The Endless Delve with the dashboard switch
    ]);
    return json({ ok: true, live: channel.live, title, idle });
  }

  if (path === "/overlay/nowplaying") {
    if (!channel) return json({ ok: false, error: "Unknown or disconnected channel." }, 404);
    return json({ ok: true, track: await getNowPlaying(channel.id) });
  }

  if (path === "/overlay/idle") {
    if (!channel) return json({ ok: false, error: "Unknown or disconnected channel." }, 404);
    return json({ ok: true, heroes: await getIdleHeroes(channel.id) });
  }

  if (path === "/overlay/data") {
    if (!channel) return json({ ok: false, error: "Unknown or disconnected channel." }, 404);
    const panels = parsePanels(url.searchParams.get("panels"));
    const window = DICE_WINDOWS[url.searchParams.get("window") ?? ""] ? String(url.searchParams.get("window")) : "day";
    const limit = Math.max(1, Math.min(10, Number(url.searchParams.get("limit")) || 5));
    const key = `${channel.id}|${[...panels].sort().join(",")}|${window}|${limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return json({ ok: true, ...hit.data, channel });
    let load = inflight.get(key);
    if (!load) {
      load = getOverlayData(channel, panels, { window, limit }).finally(() => inflight.delete(key));
      inflight.set(key, load);
    }
    const data = await load;
    cache.set(key, { at: Date.now(), data });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return json({ ok: true, ...data });
  }

  const html = (body: string, status = 200) =>
    new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  if (!channel) {
    return html(
      scrollDoc("Overlay unavailable", `<h1>Overlay unavailable</h1><p>Add <code>?channel=&lt;your Twitch login&gt;</code> to the URL. The channel must be connected to GuildScribe.</p>`, { width: 600 }),
      404,
    );
  }
  const channelKey = channel.login || channel.id;
  if (path === "/overlays") return html(renderOverlayIndexPage(channel.name, channelKey, channel.id, PUBLIC_BASE_URL));
  const panel = (url.searchParams.get("panel") ?? "all").toLowerCase();
  if (panel === "theme") {
    const scene = (url.searchParams.get("scene") ?? "game").toLowerCase();
    // The stream title subtitle is only on the brb and chat scenes.
    const withSub = scene === "brb" || scene === "chat";
    const [live, streamTitle] = await Promise.all([liveChannelName(channel), withSub ? liveStreamTitle(channel.id) : ""]);
    const idle = await isCommandGroupEnabled(channel.id, "delve");
    return html(renderThemePage(channelKey, live.login, live.name, scene, streamTitle, channel.live, idle));
  }
  if (panel === "music") return html(renderNowPlayingOverlay(channelKey));
  if (panel === "idle" && !(await isCommandGroupEnabled(channel.id, "delve"))) {
    // Switched off on the dashboard: an empty, transparent source that checks back every minute.
    return html(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>The Endless Delve (off)</title><style>html,body{background:transparent;margin:0}</style></head><body></body></html>`);
  }
  if (panel === "sounds") {
    if (!(await isCommandGroupEnabled(channel.id, "soundbytes"))) {
      // Switched off on the dashboard: an empty, transparent source that checks back every minute.
      return html(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>Sound Bytes (off)</title><style>html,body{background:transparent;margin:0}</style></head><body></body></html>`);
    }
    const live = await liveChannelName(channel);
    let botId = "";
    try { botId = env("TWITCH_BOT_ID"); } catch (_) { /* unset: nothing can be recognized as GuildScribe, so nothing plays */ }
    return html(renderSoundBytesOverlay(channelKey, live.login, botId, url.searchParams.get("always") === "1"));
  }
  if (panel === "idle") {
    const live = await liveChannelName(channel);
    let botId = "";
    try { botId = env("TWITCH_BOT_ID"); } catch (_) { /* unset: the bot's own lines just count as a chatter */ }
    const channelBots = await getChannelBotLogins(channel.id).catch(() => new Set<string>());
    return html(renderIdlePage(channelKey, live.login, live.name, botId, channelBots, await getDelveOptions(channel.id)));
  }
  if (!(panel in OVERLAY_PANELS)) return html(`Unknown panel. Try one of: ${Object.keys(OVERLAY_PANELS).join(", ")}.`, 400);
  return html(renderOverlayPage(channelKey, panel));
}

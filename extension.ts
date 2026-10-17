// GuildScribe — Twitch Extension backend (EBS). The extension's panel and
// video overlay (extension/ — uploaded to Twitch's CDN as a zip, not served
// from here) poll this route with the JWT the Twitch helper hands them:
//
//   GET /ext/state     Authorization: Bearer <extension JWT>
//
// The JWT is verified with the extension's shared secret (TWITCH_EXT_SECRET,
// base64, from the Developer Console → Extension → Settings → Extension
// Secrets). It names the channel, so a viewer can only ever see the channel
// they're watching. When the viewer has shared their identity (user_id in the
// JWT) the reply also carries their own hero, gold and party; otherwise just
// the channel's live state (raid boss, fights, leaderboards) — the same
// things /overlay/data already serves publicly. Switched-off features come
// back null, as on the OBS overlays.

import { sqlite } from "./sqlite.ts";
import { getBroadcaster, getCommandGroupToggles, rowToCharacter } from "./db.ts";
import { getBalance, isPointsEnabled } from "./points_db.ts";
import { getOverlayData, type OverlayData } from "./overlay.ts";
import { lookupViewerNames } from "./mentions.ts";
import { formatCoins } from "./coins.ts";
import { formatRaceName, heroAc, modifier } from "./utils.ts";
import { XP_THRESHOLDS } from "./characters.ts";
import { env, getAppToken } from "./twitch.ts";

type ExtClaims = { channel_id: string; opaque_user_id: string; user_id?: string; role: string; exp: number };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });

const b64urlToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

let hmacKey: Promise<CryptoKey> | null = null;
function extKey(): Promise<CryptoKey> {
  hmacKey ??= crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(env("TWITCH_EXT_SECRET")), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return hmacKey;
}

/** The claims of a valid, unexpired extension JWT (HS256), else null. */
async function verifyExtJwt(token: string): Promise<ExtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    if (header.alg !== "HS256") return null;
    const ok = await crypto.subtle.verify("HMAC", await extKey(), b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (!claims.channel_id || Number(claims.exp) * 1000 < Date.now()) return null;
    return { ...claims, channel_id: String(claims.channel_id), user_id: claims.user_id ? String(claims.user_id) : undefined };
  } catch (_) {
    return null;
  }
}

// user_id → login (characters and balances are keyed by login). Logins rarely
// change, so an hour per isolate keeps Helix calls to one per viewer.
const LOGIN_TTL_MS = 60 * 60_000;
const loginCache = new Map<string, { at: number; login: string; name: string }>();

async function loginFor(userId: string): Promise<{ login: string; name: string } | null> {
  const hit = loginCache.get(userId);
  if (hit && Date.now() - hit.at < LOGIN_TTL_MS) return hit;
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${await getAppToken()}`, "Client-Id": env("TWITCH_CLIENT_ID") },
      signal: AbortSignal.timeout(3000),
    });
    const user = res.ok ? (await res.json())?.data?.[0] : null;
    if (!user?.login) return hit ?? null;
    const out = { at: Date.now(), login: String(user.login).toLowerCase(), name: String(user.display_name || user.login) };
    loginCache.set(userId, out);
    if (loginCache.size > 5000) loginCache.delete(loginCache.keys().next().value!);
    return out;
  } catch (_) {
    return hit ?? null;
  }
}

async function loadViewer(channelId: string, userId: string) {
  const who = await loginFor(userId);
  if (!who) return { shared: true, name: null, character: null, gold: null, party: null };
  const [charRes, goldOn, toggles, partyRes] = await Promise.all([
    // Not getCharacter(): looking at the panel shouldn't count as character activity.
    sqlite.execute("SELECT * FROM characters WHERE broadcaster_id = ? AND username = ?", [channelId, who.login]),
    isPointsEnabled(channelId),
    getCommandGroupToggles(channelId),
    sqlite.execute("SELECT party_name FROM party_members WHERE broadcaster_id = ? AND username = ? LIMIT 1", [channelId, who.login]),
  ]);
  const c = charRes.rows.length ? rowToCharacter(charRes.rows[0]) : null;
  const bal = goldOn ? await getBalance(channelId, who.login) : null;

  let party: Record<string, unknown> | null = null;
  const partyName = partyRes.rows.length ? String((partyRes.rows[0] as any).party_name) : "";
  if (partyName && toggles["party"] !== false) {
    const members = await sqlite.execute(
      `SELECT m.username, c.level, c.class, c.hp_current, c.hp_max FROM party_members m
         LEFT JOIN characters c ON c.broadcaster_id = m.broadcaster_id AND c.username = m.username
        WHERE m.broadcaster_id = ? AND m.party_name = ? ORDER BY m.joined_at ASC`,
      [channelId, partyName],
    );
    const names = await lookupViewerNames(channelId, members.rows.map((r: any) => String(r.username))).catch(() => new Map<string, string>());
    party = {
      name: partyName,
      members: (members.rows as any[]).map((r) => ({
        name: names.get(String(r.username)) ?? String(r.username),
        you: String(r.username) === who.login,
        level: r.level == null ? null : Number(r.level),
        cls: r.class == null ? null : String(r.class),
        hp: Number(r.hp_current ?? 0),
        hpMax: Number(r.hp_max ?? 0),
      })),
    };
  }

  let character: Record<string, unknown> | null = null;
  if (c) {
    const next = XP_THRESHOLDS[c.level] ?? null;
    character = {
      level: c.level,
      race: formatRaceName(c.race, c.subrace),
      cls: c.cls,
      hp: c.hpCurrent,
      hpMax: c.hpMax,
      ac: heroAc(c, 10).ac,
      speed: c.speed,
      xp: c.xp,
      xpFloor: XP_THRESHOLDS[c.level - 1] ?? 0,
      xpNext: next,
      scores: Object.fromEntries(Object.entries(c.scores).map(([k, v]) => [k, { score: Number(v), mod: modifier(Number(v)) }])),
      items: c.items.slice(0, 12),
      spells: c.spells.slice(0, 12),
    };
  }
  return {
    shared: true,
    name: bal?.displayName || who.name,
    character,
    gold: bal ? { text: formatCoins(bal.balance), rank: bal.rank } : goldOn ? { text: formatCoins(0), rank: null } : null,
    party,
  };
}

// Every viewer polls; one shared channel snapshot per few seconds (and one
// in-flight load) keeps a busy channel to a handful of SQLite reads.
const CHANNEL_CACHE_MS = 5_000;
const channelCache = new Map<string, { at: number; data: OverlayData }>();
const channelInflight = new Map<string, Promise<OverlayData>>();

function channelState(channel: { id: string; name: string; live: boolean }): Promise<OverlayData> {
  const hit = channelCache.get(channel.id);
  if (hit && Date.now() - hit.at < CHANNEL_CACHE_MS) return Promise.resolve(hit.data);
  let load = channelInflight.get(channel.id);
  if (!load) {
    load = getOverlayData(channel, new Set(["raid", "battle", "giveaway", "gold", "guild"] as const), { window: "day", limit: 5 })
      .then((data) => {
        channelCache.set(channel.id, { at: Date.now(), data });
        if (channelCache.size > 500) channelCache.delete(channelCache.keys().next().value!);
        return data;
      })
      .finally(() => channelInflight.delete(channel.id));
    channelInflight.set(channel.id, load);
  }
  return load;
}

const VIEWER_CACHE_MS = 10_000;
const viewerCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof loadViewer>> }>();

async function viewerState(channelId: string, userId: string) {
  const key = `${channelId}|${userId}`;
  const hit = viewerCache.get(key);
  if (hit && Date.now() - hit.at < VIEWER_CACHE_MS) return hit.data;
  const data = await loadViewer(channelId, userId);
  viewerCache.set(key, { at: Date.now(), data });
  if (viewerCache.size > 5000) viewerCache.delete(viewerCache.keys().next().value!);
  return data;
}

/** Extension routes; null when the path isn't one of them. */
export async function handleExtensionRoute(req: Request, path: string): Promise<Response | null> {
  if (path !== "/ext/state") return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: "GET only." }, 405);
  if (!Deno.env.get("TWITCH_EXT_SECRET")) return json({ ok: false, error: "The extension isn't set up on this server (TWITCH_EXT_SECRET)." }, 503);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const claims = token ? await verifyExtJwt(token) : null;
  if (!claims) return json({ ok: false, error: "Invalid or expired extension token." }, 401);

  const b: any = await getBroadcaster(claims.channel_id);
  if (!b || Number(b.connected) !== 1) return json({ ok: true, connected: false });
  const channel = { id: claims.channel_id, name: String(b.display_name || b.login || "This channel"), live: Number(b.is_live) === 1 };

  try {
    const [state, viewer] = await Promise.all([
      channelState(channel),
      claims.user_id ? viewerState(channel.id, claims.user_id) : Promise.resolve({ shared: false }),
    ]);
    return json({
      ok: true,
      connected: true,
      role: claims.role,
      channel,
      viewer,
      raid: state.raid ?? null,
      battle: state.battle ?? [],
      recent: (state.recent ?? []).slice(0, 5),
      giveaway: state.giveaway ?? null,
      gold: state.gold ?? null,
      guild: state.guild ?? null,
    });
  } catch (e) {
    console.error("ext state", e);
    return json({ ok: false, error: "GuildScribe couldn't load this channel right now." }, 500);
  }
}

// GuildScribe's half of the live link with the Grand Orrery (orrery.ts has
// the other half: the bot reading the Orrery).
//
//   GET  /api/orrery          the hall as it stands right now, for the Orrery
//                             page (tavernworks.dev/orrery/): the adventurers
//                             on its parchments, their companies, the beasts
//                             the hall has learned, and what the bot last read
//                             from the Orrery. Public, CORS open, cached a
//                             minute.
//   POST /api/orrery/refresh  re-read the Orrery now (the Orrery's publish
//                             calls this). Harmless to anyone: it only makes
//                             the bot re-read public files, at most every 30s.
//
// Which channels: the ones that switched on the public showcase (the same
// opt-in as /api/channels), plus any logins in ORRERY_FEED_CHANNELS
// (comma-separated). Each viewer is one adventurer, at their highest level
// across those channels, under their nickname when they have one, the way
// the Orrery's canon writes them.

import { sqlite } from "./sqlite.ts";
import { listChannelCharacters, listChannelParties } from "./db.ts";
import { listNicknames } from "./mentions.ts";
import { getChannelRoster } from "./bestiary.ts";
import { orreryStatus, refreshOrreryNow } from "./orrery.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const CACHE_MS = 60_000;

export interface FeedAdventurer {
  name: string;
  viewer: string;
  race: string;
  cls: string;
  level: number;
  rank: string;
  companies: string[];
  channel: string;
}

/** The hall's rank for a parchment at this level (as in the Orrery's canon). */
export function rankFor(level: number): string {
  return level >= 11 ? "Veteran" : level >= 6 ? "Seasoned" : level >= 3 ? "Journeyman" : "Novice";
}

async function feedChannels(): Promise<Array<{ id: string; login: string }>> {
  const extra = (Deno.env.get("ORRERY_FEED_CHANNELS") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const res = await sqlite.execute(
    `SELECT b.broadcaster_id, b.login FROM broadcasters b
     WHERE b.connected = 1
       AND NOT EXISTS (SELECT 1 FROM channel_blocks k WHERE k.broadcaster_id = b.broadcaster_id)
       AND (EXISTS (SELECT 1 FROM command_toggles t WHERE t.broadcaster_id = b.broadcaster_id AND t.group_name = 'showcase' AND t.enabled = 1)
            OR lower(b.login) IN (${extra.map(() => "?").join(",") || "''"}))`,
    extra,
  );
  return (res.rows as any[]).filter((r) => r.login).map((r) => ({ id: String(r.broadcaster_id), login: String(r.login) }));
}

async function buildFeed() {
  const channels = await feedChannels();
  const best = new Map<string, FeedAdventurer>();
  const companies: Array<{ name: string; members: string[]; channel: string }> = [];
  const learned = new Map<string, { name: string; cr: string; channel: string }>();
  for (const ch of channels) {
    const [chars, parties, nicks, roster] = await Promise.all([
      listChannelCharacters(ch.id, 1000),
      listChannelParties(ch.id),
      listNicknames(ch.id),
      getChannelRoster(ch.id).catch(() => []),
    ]);
    const nick = new Map(nicks.map((n) => [n.username.toLowerCase(), n.nickname]));
    const nameOf = (u: string) => nick.get(u.toLowerCase()) || u;
    const partiesOf = new Map<string, string[]>();
    for (const p of parties) {
      companies.push({ name: p.party_name, members: p.members.map(nameOf), channel: ch.login });
      for (const m of p.members) partiesOf.set(m.toLowerCase(), [...(partiesOf.get(m.toLowerCase()) ?? []), p.party_name]);
    }
    for (const c of chars) {
      const key = c.username.toLowerCase();
      const have = best.get(key);
      if (have && have.level >= c.level) continue;
      best.set(key, {
        name: nameOf(c.username),
        viewer: c.username,
        race: [c.subrace, c.race].filter(Boolean).join(" "),
        cls: c.cls,
        level: c.level,
        rank: rankFor(c.level),
        companies: partiesOf.get(key) ?? [],
        channel: ch.login,
      });
    }
    for (const m of roster) {
      if (m.learned && !learned.has(m.name.toLowerCase())) learned.set(m.name.toLowerCase(), { name: m.name, cr: String(m.cr ?? ""), channel: ch.login });
    }
  }
  const adventurers = [...best.values()].sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
  return {
    service: "GuildScribe",
    updatedAt: new Date().toISOString(),
    channels: channels.map((c) => c.login),
    orrery: orreryStatus(),
    adventurers,
    companies,
    learned: [...learned.values()],
  };
}

let cached: { at: number; body: string } | null = null;
let building: Promise<string> | null = null;

async function feedBody(): Promise<string> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.body;
  building ??= buildFeed()
    .then((f) => { const body = JSON.stringify(f); cached = { at: Date.now(), body }; return body; })
    .finally(() => { building = null; });
  return await building;
}

/** /api/orrery and /api/orrery/refresh, or null for any other path. */
export async function handleOrreryFeedRoute(req: Request, path: string): Promise<Response | null> {
  if (path !== "/api/orrery" && path !== "/api/orrery/refresh") return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "Access-Control-Max-Age": "86400" } });
  const json = (body: string, status = 200, cache = "no-store") =>
    new Response(body, { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache } });
  if (path === "/api/orrery/refresh") {
    if (req.method !== "POST") return json(JSON.stringify({ ok: false, error: "POST only" }), 405);
    const ran = await refreshOrreryNow();
    cached = null; // the next feed carries the fresh read
    return json(JSON.stringify({ ok: true, ran, orrery: orreryStatus() }));
  }
  if (req.method !== "GET") return json(JSON.stringify({ ok: false, error: "GET only" }), 405);
  try {
    return json(await feedBody(), 200, "public, max-age=60");
  } catch (e) {
    console.error("Orrery feed failed", e);
    return json(JSON.stringify({ service: "GuildScribe", error: "feed unavailable", orrery: orreryStatus() }), 503);
  }
}

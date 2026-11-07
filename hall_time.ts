// The hall's time, for the Grand Orrery: what hour it is in the Kingdom's
// capital, and what each of GuildScribe's adventurers is doing right now.
//
// GuildScribe already keeps time: an autohunt trip runs on a clock, the
// hunting cooldown is the hero's rest between hunts (the dashboard calls it
// "Rest between monster hunts"), a classic fight stays open until someone
// finishes it, and every command a viewer types is the hero turning up at
// the hall. This module reads those clocks and says, in the Orrery's terms,
// where each hero is:
//
//   fighting    a classic fight under way (a duel in the arena, a monster
//               or a party hunt in the wood)
//   hunting     out on an !autohunt trip, in the hunting grounds that fit
//               their level, until the trip ends
//   short rest  catching their breath: the hunting cooldown is running, so
//               GuildScribe won't let them hunt yet either
//   in the hall seen at the hall in the last HALL_TIME_ABOUT_MIN (30) minutes
//   long rest   not seen for a while: resting (asleep, in the capital's
//               night)
//   away        not seen at the hall for HALL_TIME_AWAY_DAYS (14) days
//
// The capital's clock follows real time in HALL_TIMEZONE (default US
// Eastern, where GuildScribe's channels stream): dawn, morning, midday,
// afternoon, dusk, evening or night, and the season. The Orrery has no
// calendar of its own yet, so this is only the hour and the season, nothing
// named.
//
// orrery_feed.ts sends both with GET /api/orrery, and the Orrery Explorer
// shows them on the roster and tells its lore-keeper.

import { sqlite } from "./sqlite.ts";
import { homeOf, huntingGroundFor, placeNameFor } from "./orrery.ts";

const TZ = Deno.env.get("HALL_TIMEZONE") || "America/New_York";
const ABOUT_MS = Math.max(1, Number(Deno.env.get("HALL_TIME_ABOUT_MIN") ?? "30")) * 60_000;
const AWAY_MS = Math.max(1, Number(Deno.env.get("HALL_TIME_AWAY_DAYS") ?? "14")) * 86_400_000;
// A classic fight nobody has touched in this long is forfeited (combat_shared.ts).
const FIGHT_IDLE_MS = Math.max(60_000, Number(Deno.env.get("DUEL_IDLE_TIMEOUT_MS") ?? "600000"));

export type DayPart = "dawn" | "morning" | "midday" | "afternoon" | "dusk" | "evening" | "night";
export type Season = "winter" | "spring" | "summer" | "autumn";

export interface HallClock {
  at: string;
  timezone: string;
  /** The capital's hour, 0–23. */
  hour: number;
  part: DayPart;
  season: Season;
  /** "early" | "mid" | "late" in the season. */
  seasonPart: "early" | "mid" | "late";
  /** "Late autumn, evening in the capital." */
  text: string;
}

export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 7) return "dawn";
  if (hour >= 7 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "midday";
  if (hour >= 14 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 19) return "dusk";
  if (hour >= 19 && hour < 23) return "evening";
  return "night";
}

/** The season for a month (1–12), northern reckoning: Dec–Feb is winter. */
export function seasonOf(month: number): { season: Season; seasonPart: "early" | "mid" | "late" } {
  const seasons: Season[] = ["winter", "spring", "summer", "autumn"];
  const i = Math.floor((month % 12) / 3); // Dec=0, Jan=0, Feb=0, Mar=1…
  const pos = (month % 12) % 3;
  return { season: seasons[i], seasonPart: (["early", "mid", "late"] as const)[pos] };
}

export function hallClock(now = Date.now(), tz = TZ): HallClock {
  let hour: number, month: number;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23", month: "numeric" }).formatToParts(new Date(now));
    hour = Number(parts.find((p) => p.type === "hour")?.value) % 24;
    month = Number(parts.find((p) => p.type === "month")?.value);
  } catch {
    const d = new Date(now);
    hour = d.getUTCHours();
    month = d.getUTCMonth() + 1;
    tz = "UTC";
  }
  const part = dayPart(hour);
  const { season, seasonPart } = seasonOf(month);
  const seasonText = seasonPart !== "mid" ? `${seasonPart[0].toUpperCase()}${seasonPart.slice(1)} ${season}`
    : season === "winter" || season === "summer" ? `Mid${season}` : `Mid-${season}`;
  return {
    at: new Date(now).toISOString(),
    timezone: tz,
    hour,
    part,
    season,
    seasonPart,
    text: `${seasonText}, ${part} in the capital.`,
  };
}

export type DoingKind = "fighting" | "hunting" | "short rest" | "in the hall" | "long rest" | "away";

export interface Doing {
  kind: DoingKind;
  /** One plain line: "Out hunting in the Monster Wood's western edge, 3 bouts so far (2 won)." */
  text: string;
  /** Where they are, when the Orrery names it. */
  place: string | null;
  /** When this started (ISO), when known. */
  since: string | null;
  /** When it ends (ISO): the trip's end, or when the rest is over. */
  until: string | null;
}

/** What GuildScribe knows about one hero right now. All times are ms. */
export interface HeroClocks {
  username: string;
  level: number;
  /** An !autohunt trip under way. */
  trip?: { startedAt: number; endsAt: number; bouts: number; wins: number; losses: number } | null;
  /** A classic fight under way. */
  fight?: { kind: "duel" | "monster" | "partyhunt" | "partyduel"; foe: string; party?: string; updatedAt: number } | null;
  /** The last hunt they started (the hunting cooldown's stamp). */
  lastHuntAt?: number | null;
  /** The hunting cooldown, ms (0 = off). */
  cooldownMs?: number;
  /** The last time they used a command at the hall. */
  lastSeenAt?: number | null;
}

const iso = (n: number | null | undefined) => n ? new Date(n).toISOString() : null;
const placePhrase = (name: string) => `${/road/i.test(name) ? "on" : "in"} ${name.replace(/^The\b/, "the")}`;
const withArticle = (name: string) => /^(the|a|an)\s/i.test(name) ? name : `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;

/** What a hero is doing, from GuildScribe's clocks (pure; tested). */
export function doingFor(h: HeroClocks, now = Date.now(), clock: HallClock = hallClock(now)): Doing {
  const fight = h.fight && now - h.fight.updatedAt < FIGHT_IDLE_MS ? h.fight : null;
  if (fight) {
    if (fight.kind === "duel" || fight.kind === "partyduel") {
      const arena = placeNameFor("duels");
      const vs = fight.kind === "partyduel" ? `${fight.party ? `with ${fight.party} ` : ""}against ${fight.foe}` : `against ${fight.foe}`;
      return { kind: "fighting", text: `Dueling ${vs}${arena ? ` ${placePhrase(arena)}` : ""}.`, place: arena, since: null, until: null };
    }
    const place = homeOf(fight.foe) ?? huntingGroundFor(h.level, h.username);
    const who = fight.kind === "partyhunt" && fight.party ? ` with ${fight.party}` : "";
    return { kind: "fighting", text: `Fighting ${withArticle(fight.foe)}${who}${place ? ` ${placePhrase(place)}` : ""}.`, place, since: null, until: null };
  }
  if (h.trip && h.trip.endsAt > now) {
    const place = huntingGroundFor(h.level, h.username);
    const tally = h.trip.bouts ? `, ${h.trip.bouts} bout${h.trip.bouts === 1 ? "" : "s"} so far (${h.trip.wins} won)` : "";
    return { kind: "hunting", text: `Out hunting${place ? ` ${placePhrase(place)}` : ""}${tally}.`, place, since: iso(h.trip.startedAt), until: iso(h.trip.endsAt) };
  }
  const cd = h.cooldownMs ?? 0;
  if (h.lastHuntAt && cd > 0 && h.lastHuntAt + cd > now) {
    return { kind: "short rest", text: "Catching their breath after a hunt, back at the hall.", place: null, since: iso(h.lastHuntAt), until: iso(h.lastHuntAt + cd) };
  }
  const seen = Math.max(h.lastSeenAt ?? 0, h.lastHuntAt ?? 0, h.trip?.endsAt && h.trip.endsAt <= now ? h.trip.endsAt : 0);
  if (seen && now - seen < ABOUT_MS) {
    return { kind: "in the hall", text: "About the hall.", place: null, since: iso(seen), until: null };
  }
  if (seen && now - seen < AWAY_MS) {
    const asleep = clock.part === "night" || (clock.part === "evening" && clock.hour >= 22);
    return { kind: "long rest", text: asleep ? "Asleep: it's night in the capital." : "Resting between bounties.", place: null, since: iso(seen), until: null };
  }
  return { kind: "away", text: "Not seen at the hall lately.", place: null, since: iso(seen || null), until: null };
}

// ---------------------------------------------------------------------------
// Reading the clocks (one channel at a time)
// ---------------------------------------------------------------------------

const safe = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
  try { return await run(); } catch { return fallback; }
};
const list = (raw: unknown): string[] => {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : [];
  } catch {
    return [];
  }
};

/** Every hero's clocks in one channel, keyed by lowercase username. Missing
 * tables (a feature never used) just mean nothing to report. */
export async function channelClocks(broadcasterId: string, now = Date.now()) {
  const trips = new Map<string, NonNullable<HeroClocks["trip"]>>();
  const fights = new Map<string, NonNullable<HeroClocks["fight"]>>();
  const hunts = new Map<string, number>();
  const seen = new Map<string, number>();
  const rows = async (sql: string, args: unknown[] = [broadcasterId]) => safe(async () => (await sqlite.execute(sql, args as any)).rows as any[], [] as any[]);

  for (const r of await rows("SELECT username, started_at, ends_at, bouts, wins, losses FROM autohunt_sessions WHERE broadcaster_id = ?")) {
    trips.set(String(r.username).toLowerCase(), { startedAt: Number(r.started_at), endsAt: Number(r.ends_at), bouts: Number(r.bouts), wins: Number(r.wins), losses: Number(r.losses) });
  }
  for (const r of await rows("SELECT challenger, defender, updated_at FROM duels WHERE broadcaster_id = ? AND active = 1")) {
    const at = Number(r.updated_at);
    fights.set(String(r.challenger).toLowerCase(), { kind: "duel", foe: String(r.defender), updatedAt: at });
    fights.set(String(r.defender).toLowerCase(), { kind: "duel", foe: String(r.challenger), updatedAt: at });
  }
  for (const r of await rows("SELECT player, monster_name, updated_at FROM monster_duels WHERE broadcaster_id = ? AND active = 1")) {
    fights.set(String(r.player).toLowerCase(), { kind: "monster", foe: String(r.monster_name), updatedAt: Number(r.updated_at) });
  }
  for (const r of await rows("SELECT party_name, members, monster_name, updated_at FROM party_monster_duels WHERE broadcaster_id = ? AND active = 1")) {
    for (const m of list(r.members)) fights.set(m, { kind: "partyhunt", foe: String(r.monster_name), party: String(r.party_name), updatedAt: Number(r.updated_at) });
  }
  for (const r of await rows("SELECT challenger_party, defender_party, challenger_members, defender_members, updated_at FROM party_duels WHERE broadcaster_id = ? AND active = 1")) {
    const at = Number(r.updated_at);
    for (const m of list(r.challenger_members)) fights.set(m, { kind: "partyduel", foe: String(r.defender_party), party: String(r.challenger_party), updatedAt: at });
    for (const m of list(r.defender_members)) fights.set(m, { kind: "partyduel", foe: String(r.challenger_party), party: String(r.defender_party), updatedAt: at });
  }
  for (const r of await rows("SELECT username, last_hunt_at FROM hunt_cooldowns WHERE broadcaster_id = ?")) {
    hunts.set(String(r.username).toLowerCase(), Number(r.last_hunt_at));
  }
  for (const r of await rows("SELECT lower(username) AS u, MAX(created_at) AS at FROM activity_logs WHERE broadcaster_id = ? GROUP BY lower(username)")) {
    seen.set(String(r.u), Number(r.at));
  }
  const cdRows = await rows("SELECT cooldown_seconds FROM hunt_settings WHERE broadcaster_id = ?");
  const defaultCd = Math.min(3600, Math.max(0, Math.floor(Number(Deno.env.get("HUNT_COOLDOWN_SECONDS") ?? "120")) || 0));
  const cooldownMs = (cdRows.length ? Number(cdRows[0].cooldown_seconds) : defaultCd) * 1000;

  return (username: string, level: number): HeroClocks => {
    const u = username.toLowerCase();
    return { username: u, level, trip: trips.get(u) ?? null, fight: fights.get(u) ?? null, lastHuntAt: hunts.get(u) ?? null, cooldownMs, lastSeenAt: seen.get(u) ?? null };
  };
}

/** Which of two states to show for a viewer in two channels: the busier one. */
const RANK: Record<DoingKind, number> = { fighting: 5, hunting: 4, "short rest": 3, "in the hall": 2, "long rest": 1, away: 0 };
export function busier(a: Doing, b: Doing): Doing {
  if (RANK[a.kind] !== RANK[b.kind]) return RANK[a.kind] > RANK[b.kind] ? a : b;
  return (Date.parse(a.since ?? "") || 0) >= (Date.parse(b.since ?? "") || 0) ? a : b;
}

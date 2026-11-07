// Tests for hall_time.ts: the capital's clock and what each hero is doing.
// deno test -A hall_time_test.ts

import { assertEquals, assertMatch } from "jsr:@std/assert@1";

Deno.env.set("ORRERY", "off");
Deno.env.set("ORRERY_NO_TIMER", "1");
const dir = Deno.makeTempDirSync();
Deno.env.set("DB_PATH", `${dir.replaceAll("\\", "/")}/test.sqlite`);
const { busier, dayPart, doingFor, hallClock, seasonOf } = await import("./hall_time.ts");
const { setOrreryForTest } = await import("./orrery.ts");

const MIN = 60_000;
const now = Date.parse("2026-11-07T01:30:00Z"); // 8:30 PM in New York
const evening = hallClock(now, "America/New_York");
const night = hallClock(Date.parse("2026-11-07T06:00:00Z"), "America/New_York"); // 1 AM

setOrreryForTest({
  places: [
    { name: "GuildScribe's arena", where: "", uses: ["duels"], levels: null, lines: [] },
    { name: "The Kingdom's roads", where: "", uses: ["hunts"], levels: [1, 4], lines: [] },
    { name: "The goblin lands", where: "", uses: ["hunts"], levels: [6, 14], lines: [] },
  ],
  creatures: [],
});

Deno.test("the capital's clock", () => {
  assertEquals([0, 5, 8, 12, 15, 18, 20, 23].map(dayPart), ["night", "dawn", "morning", "midday", "afternoon", "dusk", "evening", "night"]);
  assertEquals(seasonOf(12), { season: "winter", seasonPart: "early" });
  assertEquals(seasonOf(1), { season: "winter", seasonPart: "mid" });
  assertEquals(seasonOf(11), { season: "autumn", seasonPart: "late" });
  assertEquals([evening.hour, evening.part, evening.season], [20, "evening", "autumn"]);
  assertEquals(evening.text, "Late autumn, evening in the capital.");
  assertEquals(hallClock(Date.parse("2026-01-15T17:00:00Z"), "America/New_York").text, "Midwinter, midday in the capital.");
  assertEquals(hallClock(now, "Not/AZone").timezone, "UTC");
});

Deno.test("out on an autohunt: hunting, in grounds that fit the level", () => {
  const d = doingFor({ username: "paco", level: 9, trip: { startedAt: now - 10 * MIN, endsAt: now + 50 * MIN, bouts: 2, wins: 1, losses: 1 }, lastHuntAt: now - 4 * MIN, cooldownMs: 2 * MIN }, now, evening);
  assertEquals(d.kind, "hunting");
  assertEquals(d.place, "The goblin lands");
  assertEquals(d.text, "Out hunting in the goblin lands, 2 bouts so far (1 won).");
  assertEquals(d.until, new Date(now + 50 * MIN).toISOString());
  assertEquals(doingFor({ username: "newbie", level: 2, trip: { startedAt: now, endsAt: now + MIN, bouts: 0, wins: 0, losses: 0 } }, now, evening).text, "Out hunting on the Kingdom's roads.");
});

Deno.test("a fight under way beats everything; an abandoned one doesn't count", () => {
  const duel = doingFor({ username: "a", level: 3, fight: { kind: "duel", foe: "bob", updatedAt: now - MIN }, trip: { startedAt: now, endsAt: now + MIN, bouts: 0, wins: 0, losses: 0 } }, now, evening);
  assertEquals([duel.kind, duel.text], ["fighting", "Dueling against bob in GuildScribe's arena."]);
  const hunt = doingFor({ username: "a", level: 3, fight: { kind: "partyhunt", foe: "Owlbear", party: "Crew", updatedAt: now - MIN } }, now, evening);
  assertEquals(hunt.text, "Fighting an Owlbear with Crew on the Kingdom's roads.");
  assertEquals(doingFor({ username: "a", level: 3, fight: { kind: "monster", foe: "Ogre", updatedAt: now - 60 * MIN } }, now, evening).kind, "away");
});

Deno.test("resting: a short rest while the hunting cooldown runs, a long rest after", () => {
  const short = doingFor({ username: "a", level: 3, lastHuntAt: now - MIN, cooldownMs: 5 * MIN, lastSeenAt: now - MIN }, now, evening);
  assertEquals(short.kind, "short rest");
  assertEquals(short.until, new Date(now + 4 * MIN).toISOString());
  // Cooldown off: no rest, they're just about.
  assertEquals(doingFor({ username: "a", level: 3, lastHuntAt: now - MIN, cooldownMs: 0 }, now, evening).kind, "in the hall");
  const long = doingFor({ username: "a", level: 3, lastSeenAt: now - 3 * 3_600_000 }, now, evening);
  assertEquals([long.kind, long.text], ["long rest", "Resting between bounties."]);
  assertMatch(doingFor({ username: "a", level: 3, lastSeenAt: now - 3 * 3_600_000 }, now, night).text, /^Asleep/);
  assertEquals(doingFor({ username: "a", level: 3, lastSeenAt: now - 30 * 86_400_000 }, now, evening).kind, "away");
  assertEquals(doingFor({ username: "a", level: 3 }, now, evening).kind, "away");
});

Deno.test("a viewer in two channels shows the busier one", () => {
  const rest = doingFor({ username: "a", level: 3, lastSeenAt: now - 3 * 3_600_000 }, now, evening);
  const hunt = doingFor({ username: "a", level: 3, trip: { startedAt: now, endsAt: now + MIN, bouts: 0, wins: 0, losses: 0 } }, now, evening);
  assertEquals(busier(rest, hunt).kind, "hunting");
  assertEquals(busier(hunt, rest).kind, "hunting");
});

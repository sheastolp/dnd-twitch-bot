// Tests for the Orrery feed (orrery_feed.ts): ranks, which channels and
// viewers it shares, and the routes, against a throwaway database.
// deno test -A orrery_feed_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";

// A throwaway database, set before sqlite.ts opens the real one, and no
// reads of the real Orrery from a test.
const dir = Deno.makeTempDirSync();
Deno.env.set("DB_PATH", `${dir.replaceAll("\\", "/")}/test.sqlite`);
Deno.env.set("ORRERY", "off");
Deno.env.set("ORRERY_NO_TIMER", "1");
const { handleOrreryFeedRoute, rankFor } = await import("./orrery_feed.ts");
const { ensureTables } = await import("./db_schema.ts");
const { ensureBestiaryTables } = await import("./bestiary.ts");
const { ensureViewerNameTables } = await import("./mentions.ts");
const { sqlite } = await import("./sqlite.ts");

Deno.test("ranks follow the hall's levels", () => {
  assertEquals([1, 2, 3, 5, 6, 10, 11, 20].map(rankFor), ["Novice", "Novice", "Journeyman", "Journeyman", "Seasoned", "Seasoned", "Veteran", "Veteran"]);
});

Deno.test("the feed shares showcase channels only, one adventurer per viewer", async () => {
  await ensureTables();
  await ensureBestiaryTables();
  await ensureViewerNameTables();
  const t = Date.now();
  await sqlite.execute("INSERT INTO broadcasters (broadcaster_id, login, display_name, connected, is_live) VALUES ('1','shown','Shown',1,0), ('2','alsoshown','AlsoShown',1,0), ('3','private','Private',1,0)", []);
  await sqlite.execute("INSERT INTO command_toggles (broadcaster_id, group_name, enabled, updated_at) VALUES ('1','showcase',1,?), ('2','showcase',1,?)", [t, t]);
  const ch = (b: string, u: string, race: string, sub: string | null, cls: string, level: number) =>
    sqlite.execute(
      "INSERT INTO characters (broadcaster_id, username, race, subrace, class, level, xp, str, dex, con, int, wis, cha, speed, hp_max, hp_current, proficiency, traits, spells, items, feats, abilities) VALUES (?,?,?,?,?,?,0,10,10,10,10,10,10,30,10,10,2,'[]','[]','[]','[]','[]')",
      [b, u, race, sub, cls, level],
    );
  await ch("1", "paco", "dwarf", "mountain", "barbarian", 12);
  await ch("2", "paco", "dwarf", "mountain", "barbarian", 4); // the same viewer, lower elsewhere
  await ch("1", "newbie", "human", null, "wizard", 2);
  await ch("3", "secret", "elf", "high", "monk", 9); // a channel that didn't opt in
  await sqlite.execute("INSERT INTO viewer_nicknames (broadcaster_id, username, nickname) VALUES ('1','paco','nobody')", []);
  await sqlite.execute("INSERT INTO parties (broadcaster_id, party_name, owner, created_at) VALUES ('1','No Trolls Here','paco',?)", [t]);
  await sqlite.execute("INSERT INTO party_members (broadcaster_id, party_name, username, joined_at) VALUES ('1','No Trolls Here','paco',?)", [t]);

  const res = await handleOrreryFeedRoute(new Request("http://x/api/orrery"), "/api/orrery");
  assert(res);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  const feed = await res.json();
  assertEquals(feed.channels.sort(), ["alsoshown", "shown"]);
  assertEquals(feed.adventurers.map((a: any) => [a.name, a.viewer, a.level, a.rank, a.companies]), [
    ["nobody", "paco", 12, "Veteran", ["No Trolls Here"]],
    ["newbie", "newbie", 2, "Novice", []],
  ]);
  assertEquals(feed.adventurers[0].race, "mountain dwarf");
  assertEquals(feed.companies, [{ name: "No Trolls Here", members: ["nobody"], channel: "shown" }]);
  assertEquals(feed.orrery.enabled, false);
});

Deno.test("the feed's routes: preflight, refresh is POST only, other paths pass", async () => {
  const pre = await handleOrreryFeedRoute(new Request("http://x/api/orrery", { method: "OPTIONS" }), "/api/orrery");
  assertEquals(pre?.status, 204);
  const get = await handleOrreryFeedRoute(new Request("http://x/api/orrery/refresh"), "/api/orrery/refresh");
  assertEquals(get?.status, 405);
  await get?.body?.cancel();
  const post = await handleOrreryFeedRoute(new Request("http://x/api/orrery/refresh", { method: "POST" }), "/api/orrery/refresh");
  assertEquals((await post!.json()).ran, false); // reading is off in tests
  assertEquals(await handleOrreryFeedRoute(new Request("http://x/roster"), "/roster"), null);
});

import { assertEquals } from "jsr:@std/assert@1";
import { setCommandGroupEnabled } from "./db.ts";
import { ensureTables } from "./db_schema.ts";
import { ensureChannelOptionTables, setOptionValue } from "./channel_options.ts";
import { headpatLine, maybeHeadpat, mentionsHeadpat, resetHeadpatCooldowns } from "./headpats.ts";

Deno.test("mentionsHeadpat", () => {
  for (const t of ["headpat pls", "HEADPATS", "give him a head pat", "head-pat", "pat pat", "*pats*", "* pat *", "headpatting time"]) assertEquals(mentionsHeadpat(t), true, t);
  for (const t of ["pattern", "pat the dog", "spatula", "patpat", "headphones", "!headpat"]) assertEquals(mentionsHeadpat(t), t === "!headpat", t);
});

Deno.test("headpatLine names both", () => {
  for (let i = 0; i < 20; i++) {
    const l = headpatLine("Viewer", "Streamer");
    assertEquals(l.includes("Viewer") && l.includes("Streamer") && l.startsWith("🫳"), true);
  }
});

Deno.test("maybeHeadpat: switch, avatar, chance (no chat sent in these cases)", async () => {
  await ensureTables();
  await ensureChannelOptionTables();
  resetHeadpatCooldowns();
  // Switch off: nothing.
  assertEquals(await maybeHeadpat("headpat", "V", "hp1", "S", 0), false);
  await setCommandGroupEnabled("hp1", "headpats", true);
  // Avatar on stream: nothing, even on a sure roll.
  await setOptionValue("hp1", "avatar.onStream", "on");
  assertEquals(await maybeHeadpat("headpat", "V", "hp1", "S", 0), false);
  await setOptionValue("hp1", "avatar.onStream", null);
  // Roll above the 33% chance: nothing. Not a headpat: nothing.
  assertEquals(await maybeHeadpat("headpat", "V", "hp1", "S", 0.9), false);
  assertEquals(await maybeHeadpat("hello", "V", "hp1", "S", 0), false);
});

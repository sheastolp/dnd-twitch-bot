// Tests for sound alerts (soundalerts.ts): file checks, which clip a cheer
// plays, and uploads/plays against a throwaway database.
// deno test -A soundalerts_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";

// A throwaway database, set before sqlite.ts opens the real one.
const dir = Deno.makeTempDirSync();
Deno.env.set("DB_PATH", `${dir.replaceAll("\\", "/")}/test.sqlite`);
const { applySoundAlertsForm, clipForCheer, ensureSoundAlertTables, getClipAudio, getSoundPlaysAfter, listClips, renderSoundAlertsOverlay, sniffAudio } = await import("./soundalerts.ts");
const { ensureTables } = await import("./db_schema.ts");
type SoundClip = Awaited<ReturnType<typeof listClips>>[number];

const bytes = (...parts: Array<string | number[]>) =>
  new Uint8Array([...parts.flatMap((p) => typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p), ...new Array(16).fill(0)]);
const MP3 = bytes("ID3", [4, 0]);

Deno.test("audio files are known by their first bytes", () => {
  assertEquals(sniffAudio(MP3), "audio/mpeg");
  assertEquals(sniffAudio(bytes([0xff, 0xfb, 0x90])), "audio/mpeg");
  assertEquals(sniffAudio(bytes("OggS")), "audio/ogg");
  assertEquals(sniffAudio(bytes("RIFF", [0, 0, 0, 0], "WAVE")), "audio/wav");
  assertEquals(sniffAudio(bytes([0x1a, 0x45, 0xdf, 0xa3])), "audio/webm");
  assertEquals(sniffAudio(bytes([0, 0, 0, 0x20], "ftypM4A ")), "audio/mp4");
  assertEquals(sniffAudio(bytes("<html><script>")), null);
  assertEquals(sniffAudio(bytes("RIFF", [0, 0, 0, 0], "AVI ")), null);
  assertEquals(sniffAudio(new Uint8Array([0x49, 0x44, 0x33])), null); // too short
});

const clip = (name: string, bits: number): SoundClip => ({ id: bits, name, title: name, volume: 100, price: 0, chat: "everyone", reward: "", bits, size: 1, plays: 0 });

Deno.test("a cheer plays the clip it names, if its bits cover it", () => {
  const clips = [clip("airhorn", 100), clip("bruh", 50), clip("free", 0)];
  assertEquals(clipForCheer(clips, 100, "Cheer100 airhorn")?.name, "airhorn");
  assertEquals(clipForCheer(clips, 500, "cheer500 BRUH lol")?.name, "bruh");
  assertEquals(clipForCheer(clips, 50, "Cheer50 airhorn"), null); // not enough bits
  assertEquals(clipForCheer(clips, 100, "Cheer100 free"), null); // not playable by bits
  assertEquals(clipForCheer(clips, 100, "Cheer100 !airhorn")?.name, "airhorn");
});

Deno.test("an unnamed cheer plays the one clip set to exactly its bits", () => {
  assertEquals(clipForCheer([clip("airhorn", 100), clip("bruh", 50)], 50, "Cheer50 gg")?.name, "bruh");
  assertEquals(clipForCheer([clip("airhorn", 100), clip("bruh", 50)], 75, "Cheer75"), null);
  assertEquals(clipForCheer([clip("airhorn", 100), clip("bruh", 50)], 50, "Cheer50 airhorn"), null); // named one it can't pay for
  assertEquals(clipForCheer([clip("a1", 100), clip("b1", 100)], 100, "Cheer100"), null); // ambiguous
});

Deno.test("the overlay is its own page: polls its plays, no Sound Bytes", () => {
  const page = renderSoundAlertsOverlay("</script><b>", false);
  assert(page.includes("/overlay/soundalerts?channel="));
  assert(!page.includes("SoundSynth") && !page.includes("irc-ws"), "doesn't listen to chat or synthesize tavern sounds");
  assert(!page.includes('"</script>'), "the channel can't close the script tag");
});

const form = (fields: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

Deno.test("uploads: checked, named, and served back", async () => {
  await ensureTables();
  await ensureSoundAlertTables();
  const ch = "1001";
  const base = { intent: "upload", volume: "80", chat: "everyone", price: "", reward: "", bits: "" };
  const fake = await applySoundAlertsForm(ch, form({ ...base, file: new File([bytes("<html>")], "x.mp3") }));
  assert(!fake.ok);
  const huge = await applySoundAlertsForm(ch, form({ ...base, file: new File([new Uint8Array(1024 * 1024 + 1)], "big.mp3") }));
  assert(!huge.ok);
  const reserved = await applySoundAlertsForm(ch, form({ ...base, name: "cooldown", file: new File([MP3], "a.mp3") }));
  assert(!reserved.ok, "one of !sfx's own words is refused");

  const ok = await applySoundAlertsForm(ch, form({ ...base, price: "2 gp", reward: "Air  Horn", file: new File([MP3], "Air Horn!.mp3") }));
  assert(ok.ok, ok.message);
  const [c] = await listClips(ch);
  assertEquals(c.name, "air-horn"); // from the file name
  assertEquals(c.price, 200);
  assertEquals(c.reward, "Air Horn");
  assertEquals((await getClipAudio(ch, c.id))?.mime, "audio/mpeg");
  assertEquals(await getClipAudio("2002", c.id), null, "another channel can't fetch it");

  const dupe = await applySoundAlertsForm(ch, form({ ...base, name: "other", reward: "air horn", file: new File([MP3], "b.mp3") }));
  assert(!dupe.ok, "one reward plays one clip");

  const saved = await applySoundAlertsForm(ch, form({ intent: "save", id: String(c.id), title: "AIR HORN", volume: "50", chat: "none", price: "", reward: "", bits: "100" }));
  assert(saved.ok, saved.message);
  assertEquals((await listClips(ch))[0].bits, 100);

  // The overlay's first poll learns the newest id; a test play then shows up after it.
  const first = await getSoundPlaysAfter(ch, -1);
  assertEquals(first.plays.length, 0);
  assert((await applySoundAlertsForm(ch, form({ intent: "test", id: String(c.id) }))).ok);
  const next = await getSoundPlaysAfter(ch, first.last);
  assertEquals(next.plays.length, 1);
  assertEquals(next.plays[0].title, "AIR HORN");
  assertEquals(next.plays[0].volume, 50);

  assert((await applySoundAlertsForm(ch, form({ intent: "delete", id: String(c.id) }))).ok);
  assertEquals((await listClips(ch)).length, 0);
  assertEquals((await getSoundPlaysAfter(ch, first.last)).plays.length, 0, "a deleted clip's plays are skipped");
});

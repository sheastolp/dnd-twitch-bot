import { assertEquals } from "jsr:@std/assert@1";
import { sqlite } from "./sqlite.ts";
import { applyClipsForm, clipPostLine, ensureClipReviewTables, handleClipReviewChat, listClips, renderClipsPage } from "./clips_review.ts";

async function seed(id: string, at: number, title = "") {
  await sqlite.execute(
    "INSERT OR REPLACE INTO clip_reviews (clip_id, broadcaster_id, clipper, title, edit_url, created_at, status) VALUES (?, 'b1', 'Viewer', ?, ?, ?, 'pending')",
    [id, title, `https://clips.twitch.tv/${id}/edit`, at],
  );
}

Deno.test("clip review: page, skip, chat commands", async () => {
  await ensureClipReviewTables();
  await seed("ClipOne", Date.now() - 60_000, "Big <fail>");
  await seed("ClipTwo", Date.now() - 5_000);
  const html = await renderClipsPage({ broadcasterId: "b1", broadcasterName: "Tester", key: "k", reviewOn: true });
  assertEquals(html.includes("Big &lt;fail&gt;"), true);
  assertEquals(html.includes("https://clips.twitch.tv/ClipOne/edit"), true);
  assertEquals(html.includes("clips.twitch.tv/embed?clip=ClipTwo"), true);

  // A viewer's "!clip post" is just a clip titled "post".
  assertEquals(await handleClipReviewChat("post", "viewer", "b1", false), null);
  assertEquals(await handleClipReviewChat("funny moment", "mod", "b1", true), null);
  // !clip skip drops the newest waiting clip.
  assertEquals((await handleClipReviewChat("skip", "Mod", "b1", true))?.includes("won't be posted"), true);
  const after = await listClips("b1");
  assertEquals(after.find((c) => c.clipId === "ClipTwo")?.status, "skipped");
  assertEquals(after.find((c) => c.clipId === "ClipOne")?.status, "pending");

  // The page's "Don't post" button.
  const f = new FormData();
  f.set("intent", "skip");
  f.set("clip", "ClipOne");
  assertEquals((await applyClipsForm("b1", f, async () => {})).ok, true);
  assertEquals((await handleClipReviewChat("skip", "Mod", "b1", true))?.includes("no clip waiting"), true);

  // Another channel can't act on this one's clip.
  const g = new FormData();
  g.set("intent", "post");
  g.set("clip", "ClipOne");
  assertEquals((await applyClipsForm("other", g, async () => {})).ok, false);

  // Review on/off goes through the callback.
  let set: boolean | null = null;
  const h = new FormData();
  h.set("intent", "review-on");
  await applyClipsForm("b1", h, async (on) => { set = on; });
  assertEquals(set, true);
});

Deno.test("clipPostLine", () => {
  assertEquals(clipPostLine("Bob", "Nice", "Abc"), "🎬 Bob clipped it — “Nice”: https://clips.twitch.tv/Abc");
  assertEquals(clipPostLine("Bob", "", "Abc"), "🎬 Bob clipped it: https://clips.twitch.tv/Abc");
});

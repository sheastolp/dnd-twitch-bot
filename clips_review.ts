// Clip review for !clip (clips.ts): with the channel's clips.review option on,
// a finished clip isn't posted straight away. It's held here, the streamer is
// whispered Twitch's own edit link (trim it, rename it — Twitch has no API for
// editing a clip, so the editing happens on Twitch's clip editor) plus a link
// to the dashboard's 🎬 Clips page, and it's only posted once someone says so:
//
//   /dashboard/clips   (dashboard key + mod login) — each held clip with a
//                      preview, "Edit on Twitch", "Post to chat", "Don't post"
//   !clip post         (mod) — posts the newest held clip
//   !clip skip         (mod) — drops the newest held clip without posting
//   !clip review on|off|status (mod; status for anyone) — the option itself
//
// Posting reads the clip back from Twitch first, so a title changed in the
// editor is the one chat sees. "Don't post" can't delete the clip itself
// (Twitch has no endpoint for that); it stays on the channel's Clips page on
// Twitch, where the streamer can delete it. Held clips are kept 7 days.

import { sqlite } from "./sqlite.ts";
import { getOrCreateDashboardKey } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";
import { sendWhisperParts } from "./whisper.ts";
import { helix } from "./stream_guard.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";
import { PUBLIC_ORIGIN } from "./config.ts";

const KEEP_MS = 7 * 24 * 60 * 60_000;

export type HeldClip = {
  clipId: string;
  broadcasterId: string;
  clipper: string;
  title: string;
  editUrl: string;
  createdAt: number;
  status: "pending" | "posted" | "skipped";
  decidedAt: number | null;
};

export async function ensureClipReviewTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS clip_reviews (
      clip_id TEXT PRIMARY KEY,
      broadcaster_id TEXT NOT NULL,
      clipper TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      edit_url TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_at INTEGER
    )`,
  );
}

export async function purgeClipReviewData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM clip_reviews WHERE broadcaster_id = ?", [broadcasterId]);
}

const toClip = (r: any): HeldClip => ({
  clipId: String(r.clip_id),
  broadcasterId: String(r.broadcaster_id),
  clipper: String(r.clipper),
  title: String(r.title ?? ""),
  editUrl: String(r.edit_url ?? ""),
  createdAt: Number(r.created_at),
  status: (["pending", "posted", "skipped"].includes(String(r.status)) ? String(r.status) : "pending") as HeldClip["status"],
  decidedAt: r.decided_at == null ? null : Number(r.decided_at),
});

/** The channel's clips from the last 7 days, newest first. */
export async function listClips(broadcasterId: string): Promise<HeldClip[]> {
  await sqlite.execute("DELETE FROM clip_reviews WHERE created_at < ?", [Date.now() - KEEP_MS]);
  const { rows } = await sqlite.execute(
    "SELECT * FROM clip_reviews WHERE broadcaster_id = ? ORDER BY created_at DESC LIMIT 50",
    [broadcasterId],
  );
  return (rows as any[]).map(toClip);
}

async function getClip(broadcasterId: string, clipId: string): Promise<HeldClip | null> {
  const { rows } = await sqlite.execute("SELECT * FROM clip_reviews WHERE broadcaster_id = ? AND clip_id = ?", [broadcasterId, clipId]);
  return rows.length ? toClip((rows as any[])[0]) : null;
}

async function newestPending(broadcasterId: string): Promise<HeldClip | null> {
  const { rows } = await sqlite.execute(
    "SELECT * FROM clip_reviews WHERE broadcaster_id = ? AND status = 'pending' AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
    [broadcasterId, Date.now() - KEEP_MS],
  );
  return rows.length ? toClip((rows as any[])[0]) : null;
}

/** The clips page link for the streamer (it carries the dashboard key). */
export async function clipsPageUrl(broadcasterId: string): Promise<string> {
  const key = await getOrCreateDashboardKey(broadcasterId);
  return `${PUBLIC_ORIGIN}/dashboard/clips?channel=${encodeURIComponent(broadcasterId)}&key=${encodeURIComponent(key)}`;
}

/** clips.ts: a finished clip, held for review instead of posted. */
export async function holdClip(c: { broadcasterId: string; clipId: string; clipper: string; title: string; editUrl: string }): Promise<void> {
  await sqlite.execute(
    `INSERT OR REPLACE INTO clip_reviews (clip_id, broadcaster_id, clipper, title, edit_url, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [c.clipId, c.broadcasterId, c.clipper, c.title, c.editUrl || `https://clips.twitch.tv/${c.clipId}/edit`, Date.now()],
  );
  await sendChatMessage(`🎬 ${c.clipper} clipped it! The streamer will give it a quick edit before it's shared.`, c.broadcasterId);
  // The streamer's own Twitch user id is the channel id.
  const page = await clipsPageUrl(c.broadcasterId).catch(() => "");
  await sendWhisperParts(c.broadcasterId, [
    `🎬 New clip by ${c.clipper}${c.title ? ` — “${c.title}”` : ""}. Edit it on Twitch: ${c.editUrl || `https://clips.twitch.tv/${c.clipId}/edit`}${page ? ` — then post it (or don't) from ${page}` : " — then a mod types !clip post to share it"}`,
  ]).catch(() => false);
}

/** The clip's current title on Twitch (after any edits), or the saved one. */
async function currentTitle(c: HeldClip): Promise<string> {
  const g = await helix("GET", `/clips?id=${encodeURIComponent(c.clipId)}`, null);
  const t = g.ok ? g.data?.data?.[0]?.title : undefined;
  return typeof t === "string" ? t : c.title;
}

/** The chat line for a clip being shared. */
export function clipPostLine(clipper: string, title: string, clipId: string): string {
  return `🎬 ${clipper} clipped it${title ? ` — “${title}”` : ""}: https://clips.twitch.tv/${clipId}`;
}

async function decide(c: HeldClip, status: "posted" | "skipped") {
  await sqlite.execute("UPDATE clip_reviews SET status = ?, decided_at = ? WHERE clip_id = ?", [status, Date.now(), c.clipId]);
}

/** Posts a held clip to chat with its current title. */
export async function postClip(c: HeldClip): Promise<string> {
  const title = await currentTitle(c);
  await sendChatMessage(clipPostLine(c.clipper, title, c.clipId), c.broadcasterId);
  if (title !== c.title) await sqlite.execute("UPDATE clip_reviews SET title = ? WHERE clip_id = ?", [title, c.clipId]);
  await decide(c, "posted");
  return title;
}

/** !clip post / !clip skip (mods). Returns the reply, or null if it isn't one. */
export async function handleClipReviewChat(arg: string, display: string, broadcasterId: string, isModerator: boolean): Promise<string | null> {
  const a = arg.trim().toLowerCase();
  if (a !== "post" && a !== "skip") return null;
  if (!isModerator) return null; // a viewer's "!clip post" is just a clip titled "post"
  const c = await newestPending(broadcasterId);
  if (!c) return `@${display} there's no clip waiting to be posted.`;
  if (a === "post") {
    await postClip(c);
    return "";
  }
  await decide(c, "skipped");
  return `@${display} 🎬 Okay, ${c.clipper}'s clip won't be posted.`;
}

// ── Dashboard page (/dashboard/clips) ──

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

export async function renderClipsPage(d: { broadcasterId: string; broadcasterName: string; key: string; reviewOn: boolean; notice?: string; error?: string }): Promise<string> {
  const clips = await listClips(d.broadcasterId);
  const pending = clips.filter((c) => c.status === "pending");
  const done = clips.filter((c) => c.status !== "pending");
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const parent = new URL(PUBLIC_ORIGIN).hostname;
  const name = escapeHtml(d.broadcasterName);
  const now = Date.now();

  const card = (c: HeldClip) => `<div class="clip card">
    <iframe src="https://clips.twitch.tv/embed?clip=${encodeURIComponent(c.clipId)}&parent=${encodeURIComponent(parent)}&autoplay=false" allowfullscreen loading="lazy" title="Clip preview"></iframe>
    <div class="clip-body">
      <p class="clip-title"><strong>${c.title ? escapeHtml(c.title) : "<span class=\"muted\">(no title)</span>"}</strong></p>
      <p class="muted small">by ${escapeHtml(c.clipper)} · ${ago(now - c.createdAt)}</p>
      <div class="clip-actions">
        <a class="btn ghost" href="${escapeHtml(c.editUrl)}" target="_blank" rel="noopener">✂️ Edit on Twitch ↗</a>
        <form method="post" action="/dashboard/clips" class="inline">${hidden}<input type="hidden" name="clip" value="${escapeHtml(c.clipId)}"><button type="submit" name="intent" value="post" class="ember">📣 Post to chat</button></form>
        <form method="post" action="/dashboard/clips" class="inline">${hidden}<input type="hidden" name="clip" value="${escapeHtml(c.clipId)}"><button type="submit" name="intent" value="skip" class="ghost">Don't post</button></form>
      </div>
      <p class="muted small">Trim it or change the title on Twitch's editor, save there, then come back and post it — chat gets the title as it is on Twitch then.</p>
    </div>
  </div>`;

  const doneRows = done.map((c) =>
    `<tr><td><a href="https://clips.twitch.tv/${encodeURIComponent(c.clipId)}" target="_blank" rel="noopener">${c.title ? escapeHtml(c.title) : "(no title)"}</a></td><td>${escapeHtml(c.clipper)}</td><td>${c.status === "posted" ? "📣 posted" : "not posted"}</td><td class="num small">${ago(now - (c.decidedAt ?? c.createdAt))}</td>` +
    `<td class="num">${c.status === "skipped" ? `<form method="post" action="/dashboard/clips" class="inline">${hidden}<input type="hidden" name="clip" value="${escapeHtml(c.clipId)}"><button type="submit" name="intent" value="post" class="ghost">Post it after all</button></form>` : ""}</td></tr>`
  ).join("");

  const body = `<header class="dash-top"><div><span class="pill">Clips · Review</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>${d.reviewOn
    ? `<strong>Review is on:</strong> clips made with <code>!clip</code> wait here instead of going straight to chat. You're whispered each one's edit link.`
    : `<strong>Review is off:</strong> <code>!clip</code> posts clips to chat as soon as Twitch finishes them.`}</p>
<form method="post" action="/dashboard/clips" class="controls">${hidden}<button type="submit" name="intent" value="${d.reviewOn ? "review-off" : "review-on"}" class="${d.reviewOn ? "ghost" : "ember"}">${d.reviewOn ? "Turn review off (post clips straight away)" : "Turn review on (edit clips before they're posted)"}</button></form>
<h2>Waiting to be posted</h2>
${pending.length ? `<div class="clips">${pending.map(card).join("")}</div>` : `<p class="note">No clips waiting.${d.reviewOn ? " New ones show up here as soon as Twitch finishes them." : ""}</p>`}
${done.length ? `<h2>Recent</h2><div class="table-wrap"><table><thead><tr><th>Clip</th><th>By</th><th>What happened</th><th class="num">When</th><th></th></tr></thead><tbody>${doneRows}</tbody></table></div><p class="muted small">"Not posted" clips still exist on Twitch (it has no way for bots to delete them) — delete one from your channel's Clips page on Twitch if you like. Clips drop off this page after 7 days.</p>` : ""}
<div class="card" style="margin-top:22px"><p class="muted small" style="margin:0">Chat (mods): <code>!clip post</code> posts the newest waiting clip · <code>!clip skip</code> drops it · <code>!clip review on|off</code></p></div>`;

  return scrollDoc(`${d.broadcasterName} — Clips`, body, {
    width: 1100,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}form.inline{display:inline;margin:0}.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:12px 0}.clips{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:16px;margin:12px 0}.clip{padding:0;overflow:hidden}.clip iframe{display:block;width:100%;aspect-ratio:16/9;border:0;background:#000}.clip-body{padding:12px 14px}.clip-title{margin:0 0 4px}.clip-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 6px}`,
  });
}

/** The dashboard form: post / skip a clip, or switch review on/off. */
export async function applyClipsForm(broadcasterId: string, form: FormData, setReview: (on: boolean) => Promise<void>): Promise<{ ok: boolean; message: string }> {
  const intent = String(form.get("intent") ?? "");
  if (intent === "review-on" || intent === "review-off") {
    await setReview(intent === "review-on");
    return { ok: true, message: intent === "review-on" ? "Review is on: new clips wait here for you." : "Review is off: clips post to chat straight away." };
  }
  const c = await getClip(broadcasterId, String(form.get("clip") ?? ""));
  if (!c) return { ok: false, message: "That clip isn't here any more." };
  if (intent === "post") {
    const title = await postClip(c);
    return { ok: true, message: `Posted to chat${title ? `: “${title}”` : ""}.` };
  }
  if (intent === "skip") {
    await decide(c, "skipped");
    return { ok: true, message: "Okay, that clip won't be posted." };
  }
  return { ok: false, message: "Nothing changed." };
}

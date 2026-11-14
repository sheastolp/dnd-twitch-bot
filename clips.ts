// GuildScribe — !clip [title] (Sery_Bot-style): anyone in chat clips the last
// 30 seconds of the live stream; !clip15 / !clip20 / !clip45 / !clip60 pick
// the length. Uses Helix Create Clip with the broadcaster's
// token (clips:edit), waits for Twitch to finish it, then posts the link.
// Dashboard group "clips". One clip per channel every CHANNEL_COOLDOWN_MS,
// and per chatter every USER_COOLDOWN_MS.
//
// With the clips.review option on, a finished clip is held for the streamer
// to edit on Twitch and post from the dashboard's 🎬 Clips page or with
// !clip post (clips_review.ts) instead of being posted straight away.
//   !clip review on|off   (mod) the option; !clip review (anyone) says which
//   !clip post / !clip skip (mod) the newest held clip

import { getBroadcaster, getCustomCommand } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";
import { getScopedToken, helix, reconnectHint } from "./stream_guard.ts";
import { optWord, setOptionValue } from "./channel_options.ts";
import { clipPostLine, handleClipReviewChat, holdClip } from "./clips_review.ts";

export const CLIP_SCOPE = "clips:edit";
const CHANNEL_COOLDOWN_MS = 30_000;
const USER_COOLDOWN_MS = 2 * 60_000;
const lastChannel = new Map<string, number>();
const lastUser = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function handleClipCommand(chatMessage: string, chatter: string, display: string, broadcasterId: string, isModerator: boolean, baseUrl: string): Promise<boolean> {
  const m = chatMessage.trim().match(/^!clip(15|20|30|45|60)?(?:\s+(.+))?$/i);
  if (!m) return false;
  if (await getCustomCommand(broadcasterId, `clip${m[1] ?? ""}`)) return false; // the channel's own command wins
  const duration = m[1] ? Number(m[1]) : 30;

  // Review: !clip review [on|off], !clip post, !clip skip (bare !clip only).
  if (!m[1] && m[2]) {
    const rv = m[2].trim().match(/^review(?:\s+(on|off|status))?$/i);
    if (rv) {
      const action = (rv[1] ?? "status").toLowerCase();
      if (action === "status" || !isModerator) {
        const on = (await optWord(broadcasterId, "clips.review")) === "on";
        await sendChatMessage(`@${display} 🎬 Clip review is ${on ? "on — clips wait for the streamer to edit and post them" : "off — clips post straight away"}.${isModerator ? ` Switch it with !clip review ${on ? "off" : "on"}.` : ""}`, broadcasterId);
        return true;
      }
      await setOptionValue(broadcasterId, "clips.review", action === "on" ? "on" : null);
      await sendChatMessage(`@${display} 🎬 Clip review is now ${action === "on" ? "on — new clips wait for the streamer to edit them on Twitch and post them (dashboard → 🎬 Clips, or !clip post)" : "off — clips post straight away"}.`, broadcasterId);
      return true;
    }
    const reply = await handleClipReviewChat(m[2], display, broadcasterId, isModerator);
    if (reply !== null) {
      if (reply) await sendChatMessage(reply, broadcasterId);
      return true;
    }
  }

  const b = await getBroadcaster(broadcasterId);
  if (!b || Number(b.is_live) !== 1) {
    await sendChatMessage(`@${display} the stream isn't live, so there's nothing to clip.`, broadcasterId);
    return true;
  }
  const now = Date.now();
  const userKey = `${broadcasterId}:${chatter}`;
  if (!isModerator && now - (lastUser.get(userKey) ?? 0) < USER_COOLDOWN_MS) return true;
  if (now - (lastChannel.get(broadcasterId) ?? 0) < CHANNEL_COOLDOWN_MS) {
    await sendChatMessage(`@${display} a clip was just made — give it a few seconds.`, broadcasterId);
    return true;
  }
  const t = await getScopedToken(broadcasterId, CLIP_SCOPE);
  if ("problem" in t) {
    await sendChatMessage(`@${display} I can't make clips yet — ${reconnectHint(baseUrl)}.`, broadcasterId);
    return true;
  }
  lastChannel.set(broadcasterId, now);
  lastUser.set(userKey, now);
  const title = (m[2] ?? "").trim().slice(0, 100);
  const create = (withTitle: boolean) => {
    const p = new URLSearchParams({ broadcaster_id: broadcasterId, duration: String(duration) });
    if (withTitle && title) p.set("title", title);
    return helix("POST", `/clips?${p}`, t.token);
  };
  let r = await create(true);
  if (!r.ok && r.status === 400 && title) r = await create(false); // e.g. the title didn't pass AutoMod
  const id = String(r.data?.data?.[0]?.id ?? "");
  const editUrl = String(r.data?.data?.[0]?.edit_url ?? "");
  if (!r.ok || !id) {
    await sendChatMessage(`@${display} Twitch couldn't make that clip${r.status === 400 ? " (this category may not allow clips)" : ""}.`, broadcasterId);
    return true;
  }
  // Creating a clip takes a moment; Twitch says to give up after ~60 s.
  for (const wait of [5000, 5000, 10_000, 15_000]) {
    await sleep(wait);
    const g = await helix("GET", `/clips?id=${encodeURIComponent(id)}`, null);
    if (g.ok && g.data?.data?.length) {
      if ((await optWord(broadcasterId, "clips.review")) === "on") {
        await holdClip({ broadcasterId, clipId: id, clipper: display, title: String(g.data.data[0].title ?? title), editUrl });
      } else {
        await sendChatMessage(clipPostLine(display, title, id), broadcasterId);
      }
      return true;
    }
  }
  await sendChatMessage(`@${display} Twitch didn't finish that clip — try again in a moment.`, broadcasterId);
  return true;
}

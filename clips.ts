// GuildScribe — !clip [title] (Sery_Bot-style): anyone in chat clips the last
// 30 seconds of the live stream; !clip15 / !clip20 / !clip45 / !clip60 pick
// the length. Uses Helix Create Clip with the broadcaster's
// token (clips:edit), waits for Twitch to finish it, then posts the link.
// Dashboard group "clips". One clip per channel every CHANNEL_COOLDOWN_MS,
// and per chatter every USER_COOLDOWN_MS.

import { getBroadcaster, getCustomCommand } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";
import { getScopedToken, helix, reconnectHint } from "./stream_guard.ts";

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
  if (!r.ok || !id) {
    await sendChatMessage(`@${display} Twitch couldn't make that clip${r.status === 400 ? " (this category may not allow clips)" : ""}.`, broadcasterId);
    return true;
  }
  // Creating a clip takes a moment; Twitch says to give up after ~60 s.
  for (const wait of [5000, 5000, 10_000, 15_000]) {
    await sleep(wait);
    const g = await helix("GET", `/clips?id=${encodeURIComponent(id)}`, null);
    if (g.ok && g.data?.data?.length) {
      await sendChatMessage(`🎬 ${display} clipped it${title ? ` — “${title}”` : ""}: https://clips.twitch.tv/${id}`, broadcasterId);
      return true;
    }
  }
  await sendChatMessage(`@${display} Twitch didn't finish that clip — try again in a moment.`, broadcasterId);
  return true;
}

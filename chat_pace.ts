// How busy each channel's chat is right now: viewers' messages in the last
// minute, for the "auto" bot-replies mode (whisperme.ts) — answer in chat
// at a normal pace (replies.quietBelow to replies.busyAt messages a minute),
// by whisper while chat is quieter than that or busier. Bots' messages (GuildScribe's own replies included) and commands
// sent by whisper don't count. Kept in memory: the always-on process sees
// every chat message, and after a restart the count simply starts over.

export const PACE_WINDOW_MS = 60_000;
const MAX_KEPT = 1000; // per channel; far past any threshold

const recent = new Map<string, number[]>();

function prune(list: number[], now: number) {
  let i = 0;
  while (i < list.length && now - list[i] > PACE_WINDOW_MS) i++;
  if (i) list.splice(0, i);
  if (list.length > MAX_KEPT) list.splice(0, list.length - MAX_KEPT);
}

/** Counts one viewer chat message in this channel. */
export function noteChatMessage(broadcasterId: string, now = Date.now()) {
  if (!broadcasterId) return;
  const list = recent.get(broadcasterId) ?? [];
  list.push(now);
  prune(list, now);
  recent.set(broadcasterId, list);
}

/** Viewer messages in this channel's chat in the last minute. */
export function chatPace(broadcasterId: string, now = Date.now()): number {
  const list = recent.get(broadcasterId);
  if (!list) return 0;
  prune(list, now);
  if (!list.length) recent.delete(broadcasterId);
  return list.length;
}

/** Auto mode's call for a chat this busy: whisper while it's "quiet" (fewer
 * than quietBelow messages a minute) or "busy" (more than busyAt); null =
 * answer in chat. */
export function autoWhisperReason(pace: number, quietBelow: number, busyAt: number): "quiet" | "busy" | null {
  if (pace > busyAt) return "busy";
  if (pace < quietBelow) return "quiet";
  return null;
}

// Headpats: when chat mentions a headpat ("headpat", "head pat", "pat pat",
// "*pats*"), GuildScribe now and then answers with one of its own —
// headpats.chance of the time (default 33%), at most once every
// headpats.cooldown (default 2 min) per channel. !headpat [@someone] always
// answers (still inside the cooldown). Off by default: dashboard switch
// "headpats" (Quick setup card, or !feature headpats on).
//
// Only while the streamer's avatar (PNGtuber / VTuber model) is NOT on
// stream — GuildScribe can't see OBS, so mods say when it is:
//   !avatar on    the avatar is on stream: no headpats
//   !avatar off   it's off stream: headpats are back
//   !avatar       (anyone) which it is
// Kept in the avatar.onStream option (also on the dashboard), so it stays
// put across streams and bot restarts until a mod changes it.
//
// A channel's own custom command of the same name (!headpat, !avatar) wins.

import { sendChatMessage } from "./twitch.ts";
import { isCommandGroupEnabled } from "./db.ts";
import { getCustomCommand } from "./db_custom.ts";
import { optNum, optWord, setOptionValue } from "./channel_options.ts";
import { pick } from "./utils.ts";

const lastPat = new Map<string, number>();

/** Whether plain chat is asking for / talking about a headpat. */
export function mentionsHeadpat(text: string): boolean {
  const t = text.toLowerCase();
  return /\bhead\s*-?\s*pats?\b|\bheadpatt?(?:ing|ed|s)?\b|\bpat\s+pat\b|\*\s*pats?\s*\*/.test(t);
}

const LINES = [
  (from: string, to: string) => `🫳 ${from} reaches over and gives ${to} a gentle headpat. *pat pat*`,
  (from: string, to: string) => `🫳 *pat pat pat* — ${to} has been headpatted by ${from}. Very good streamer energy.`,
  (from: string, to: string) => `🫳 ${from} casts Headpat on ${to}. It's super effective!`,
  (from: string, to: string) => `🫳 The guild approves: ${from} gives ${to} a well-earned headpat.`,
  (from: string, to: string) => `🫳 ${to} receives one (1) headpat from ${from}. *pat*`,
];

/** The headpat line: `from` pats `to`. */
export function headpatLine(from: string, to: string): string {
  return pick(LINES)(from, to);
}

async function avatarOnStream(broadcasterId: string): Promise<boolean> {
  return (await optWord(broadcasterId, "avatar.onStream")) === "on";
}

/** !headpat [@someone] and !avatar [on|off]. Returns true when handled. */
export async function handleHeadpatCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  broadcasterName: string,
  isModerator: boolean,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!(headpat|headpats|avatar)(?:\s+(.*))?$/i);
  if (!m) return false;
  const word = m[1].toLowerCase();
  const arg = (m[2] ?? "").trim();
  const [on, custom] = await Promise.all([isCommandGroupEnabled(broadcasterId, "headpats"), getCustomCommand(broadcasterId, word)]);
  if (!on || custom) return false;

  if (word === "avatar") {
    const a = arg.toLowerCase();
    if ((a === "on" || a === "off") && isModerator) {
      await setOptionValue(broadcasterId, "avatar.onStream", a === "on" ? "on" : null);
      await sendChatMessage(
        a === "on"
          ? `@${display} 🎭 Avatar's on stream — headpats are paused until a mod types !avatar off.`
          : `@${display} 🫳 Avatar's off stream — headpats are back on the menu.`,
        broadcasterId,
      );
      return true;
    }
    const isOn = await avatarOnStream(broadcasterId);
    await sendChatMessage(
      `@${display} ${isOn ? "🎭 The avatar is on stream, so no headpats right now." : "🫳 No avatar on stream — headpats are allowed."}${isModerator ? ` Mods: !avatar ${isOn ? "off" : "on"}.` : ""}`,
      broadcasterId,
    );
    return true;
  }

  // !headpat [@someone]
  if (await avatarOnStream(broadcasterId)) {
    await sendChatMessage(`@${display} 🎭 No headpats while the avatar's on stream — try again when it's off.`, broadcasterId);
    return true;
  }
  const now = Date.now();
  if (now - (lastPat.get(broadcasterId) ?? 0) < (await optNum(broadcasterId, "headpats.cooldown")) * 1000) return true;
  lastPat.set(broadcasterId, now);
  const target = arg.match(/^@?([A-Za-z0-9_]{2,25})\b/)?.[1];
  await sendChatMessage(headpatLine(display, target ? `@${target}` : broadcasterName), broadcasterId);
  return true;
}

/** Plain chat that mentions a headpat: sometimes answered. Returns true if it posted. */
export async function maybeHeadpat(chatMessage: string, display: string, broadcasterId: string, broadcasterName: string, roll = Math.random()): Promise<boolean> {
  if (chatMessage.startsWith("!") || !mentionsHeadpat(chatMessage)) return false;
  if (!(await isCommandGroupEnabled(broadcasterId, "headpats"))) return false;
  if (await avatarOnStream(broadcasterId)) return false;
  const now = Date.now();
  if (now - (lastPat.get(broadcasterId) ?? 0) < (await optNum(broadcasterId, "headpats.cooldown")) * 1000) return false;
  if (roll * 100 >= (await optNum(broadcasterId, "headpats.chance"))) return false;
  lastPat.set(broadcasterId, now);
  await sendChatMessage(headpatLine(display, broadcasterName), broadcasterId);
  return true;
}

/** Tests: forget the cooldowns. */
export function resetHeadpatCooldowns() {
  lastPat.clear();
}

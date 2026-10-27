// !whisperme [on|off|auto|status]: a viewer's own choice of where the bot answers
// their !commands — by whisper (a private message only they see; handy on
// the mobile app, where a busy chat buries the bot's answer) or in chat.
// Bare !whisperme flips between the two; auto drops the choice again. Kept per viewer across all channels
// (whisper_prefs, whisper.ts), and beats the channel's setting either way.
// Everyone who hasn't picked follows the channel's replies.mode (dashboard
// Bot replies card, or a mod's !whisperall auto/on/off in chat): "auto" (the
// default) answers in chat while it's quiet and by whisper once chat is busy
// (replies.busyAt viewer messages in the last minute, chat_pace.ts);
// "whisper" and "chat" always do that. Those viewers get a one-time note
// with their first whisper saying why (WHISPER_INTRO).
//
// Only replies addressed to the viewer ("@Name …") are whispered; anything
// meant for the whole chat (fight results, giveaways, the finished !newchar
// hero…) is still posted there.

import { sendChatMessage } from "./twitch.ts";
import { optNum, optWord, saveOptionsFromForm } from "./channel_options.ts";
import { chatPace } from "./chat_pace.ts";
import { explainWhisperFailure, sendWhisperPartsDetailed, setWhisperPref, setWhisperReplies, type WhisperIntro, whisperMode, whisperPref } from "./whisper.ts";

/** Whether the channel's own setting whispers replies right now: "whisper",
 * or "auto" while chat is busy. Never throws. */
async function channelWhispers(broadcasterId: string): Promise<{ mode: string; on: boolean; busy: boolean }> {
  const mode = await optWord(broadcasterId, "replies.mode");
  const busy = mode === "auto" && chatPace(broadcasterId) >= await optNum(broadcasterId, "replies.busyAt");
  return { mode, on: mode === "whisper" || busy, busy };
}

/** Whether replies to this chatter's command go by whisper: their own
 * !whisperme choice, else the channel's replies.mode. intro: why, when
 * whispered by the channel alone (see WHISPER_INTRO). Never throws. */
export async function wantsWhisperReplies(broadcasterId: string, userId: string): Promise<{ on: boolean; intro?: WhisperIntro }> {
  if (!userId) return { on: false };
  const [mine, channel] = await Promise.all([whisperPref(userId), channelWhispers(broadcasterId)]);
  if (mine) return { on: mine === "whisper" };
  return { on: channel.on, intro: channel.on ? (channel.busy ? "busy" : "channel") : undefined };
}

/** !whisperall [auto|on|off|status] (mods): the channel-wide replies.mode,
 * same as the dashboard's Bot replies card. */
export async function handleWhisperAllCommand(chatMessage: string, display: string, broadcasterId: string, isModerator: boolean): Promise<boolean> {
  const m = chatMessage.trim().match(/^!whisperall(?:\s+(auto|on|off|status))?$/i);
  if (!m) return false;
  const arg = (m[1] ?? "status").toLowerCase();
  if (arg !== "status" && !isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can change where replies go.`, broadcasterId);
    return true;
  }
  if (arg !== "status") {
    const form = new FormData();
    form.set("opt_replies.mode", arg === "on" ? "whisper" : arg === "off" ? "chat" : ""); // blank = default (auto)
    await saveOptionsFromForm(broadcasterId, form);
  }
  const mode = await optWord(broadcasterId, "replies.mode");
  const busyAt = await optNum(broadcasterId, "replies.busyAt");
  const now = arg === "status" ? "" : "now ";
  // Not addressed to anyone, so it posts in chat even in whisper mode.
  await sendChatMessage(
    mode === "whisper"
      ? `📜 The bot ${now}answers your !commands by whisper here — a private message only you see, so chat stays readable (anything for the whole chat still posts). Rather have yours in chat? !whisperme off. Mods: !whisperall auto or off to switch back.`
      : mode === "chat"
      ? `📜 The bot ${now}answers !commands in chat here. Want yours by whisper (a private message only you see)? !whisperme on.${isModerator ? " Mods: !whisperall auto whispers only while chat is busy, !whisperall on always." : ""}`
      : `📜 The bot ${now}answers !commands in chat while it's quiet, and by whisper (a private message only you see) once chat gets busy — ${busyAt}+ messages a minute. Pick for yourself with !whisperme on or off.${isModerator ? " Mods: !whisperall on/off for always whisper/chat." : ""}`,
    broadcasterId,
  );
  return true;
}

export async function handleWhisperMeCommand(chatMessage: string, chatterId: string, display: string, broadcasterId: string): Promise<boolean> {
  const m = chatMessage.trim().match(/^!whisperme(?:\s+(on|off|auto|status))?$/i);
  if (!m) return false;
  const [mine, channel] = await Promise.all([whisperPref(chatterId), channelWhispers(broadcasterId)]);
  const now = mine ? mine === "whisper" : channel.on;
  // Bare !whisperme flips it.
  const arg = (m[1] ?? (now ? "off" : "on")).toLowerCase();

  if (arg === "status") {
    const why = mine ? "your choice" : channel.mode === "auto" ? `this channel's auto setting: by whisper only while chat is busy, and it's ${channel.busy ? "busy" : "quiet"} right now` : "this channel's setting";
    await sendChatMessage(
      now
        ? `@${display} Your replies come by whisper (a private message only you see) — ${why}. !whisperme off to get them in chat.`
        : `@${display} Your replies are posted in chat — ${why}. !whisperme on to get them by whisper instead, a private message only you see.`,
      broadcasterId,
    );
    return true;
  }

  if (arg === "auto") {
    await setWhisperPref(chatterId, null);
    await sendChatMessage(
      `@${display} Got it — your replies follow this channel's setting again` +
        (channel.mode === "auto" ? ": in chat while it's quiet, by whisper when chat's busy." : channel.mode === "whisper" ? " (by whisper here)." : " (in chat here)."),
      broadcasterId,
    );
    return true;
  }

  if (arg === "off") {
    await setWhisperPref(chatterId, "chat");
    // Answer this one in chat already — unless the command came by whisper.
    if (whisperMode() === true) setWhisperReplies(false);
    await sendChatMessage(`@${display} Got it — I'll answer your !commands in chat, in every channel. !whisperme on to switch back to whispers.`, broadcasterId);
    return true;
  }

  // "on": send a whisper first so a viewer who can't receive them finds out
  // now, not by missing every reply.
  const r = await sendWhisperPartsDetailed(chatterId, [
    "📜 Whisper replies on — I'll answer your !commands here, in a private message only you see, instead of in chat. You can also whisper me commands right here (e.g. roll d20). !whisperme off to go back to chat.",
  ]);
  if (!r.ok) {
    await sendChatMessage(`@${display} I couldn't whisper you, so your replies stay in chat: ${explainWhisperFailure(r)}.`, broadcasterId);
    return true;
  }
  await setWhisperPref(chatterId, "whisper");
  return true;
}

// !whisperme [on|off]: a viewer's own choice to get every reply to their
// !commands by whisper instead of in chat — handy on the mobile app, where
// a busy chat buries the bot's answer. Kept per viewer across all channels
// (whisper_prefs, whisper.ts). A channel can also whisper every viewer's
// replies with the dashboard option replies.mode (Bot replies card).
//
// Only replies addressed to the viewer ("@Name …") are whispered; anything
// meant for the whole chat (fight results, giveaways, the finished !newchar
// hero…) is still posted there.

import { sendChatMessage } from "./twitch.ts";
import { optWord } from "./channel_options.ts";
import { explainWhisperFailure, prefersWhisperReplies, sendWhisperPartsDetailed, setWhisperPref, setWhisperReplies, whisperMode } from "./whisper.ts";

/** Whether replies to this chatter's command go by whisper: their own
 * !whisperme choice, or the channel's replies.mode. Never throws. */
export async function wantsWhisperReplies(broadcasterId: string, userId: string): Promise<boolean> {
  if (!userId) return false;
  const [mine, channel] = await Promise.all([prefersWhisperReplies(userId), optWord(broadcasterId, "replies.mode")]);
  return mine || channel === "whisper";
}

export async function handleWhisperMeCommand(chatMessage: string, chatterId: string, display: string, broadcasterId: string): Promise<boolean> {
  const m = chatMessage.trim().match(/^!whisperme(?:\s+(on|off|status))?$/i);
  if (!m) return false;
  const arg = (m[1] ?? "").toLowerCase();
  const channelWide = (await optWord(broadcasterId, "replies.mode")) === "whisper";
  const now = await prefersWhisperReplies(chatterId);

  if (arg === "status" || (arg === "" && now)) {
    await sendChatMessage(
      `@${display} Whisper replies are ${now ? "on — !whisperme off to get them in chat" : "off — !whisperme on to get your replies by whisper"}.` +
        (channelWide ? " (This channel whispers everyone's replies anyway.)" : ""),
      broadcasterId,
    );
    return true;
  }

  if (arg === "off") {
    await setWhisperPref(chatterId, false);
    // Answer this one in chat already — unless the command came by whisper.
    if (!channelWide && whisperMode() === true) setWhisperReplies(false);
    await sendChatMessage(
      `@${display} Whisper replies off — I'll answer you in chat.` + (channelWide ? " (This channel whispers everyone's replies, so you'll still get whispers here.)" : ""),
      broadcasterId,
    );
    return true;
  }

  // "on" (or bare !whisperme while off): send a whisper first so a viewer
  // who can't receive them finds out now, not by missing every reply.
  const r = await sendWhisperPartsDetailed(chatterId, [
    "📜 Whisper replies on — I'll answer your !commands here instead of in chat. You can also whisper me commands right here (e.g. roll d20). !whisperme off to stop.",
  ]);
  if (!r.ok) {
    await sendChatMessage(`@${display} I couldn't whisper you, so whisper replies stay off: ${explainWhisperFailure(r)}.`, broadcasterId);
    return true;
  }
  await setWhisperPref(chatterId, true);
  return true;
}

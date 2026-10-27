// !whisperme [on|off|status]: a viewer's own choice of where the bot answers
// their !commands — by whisper (a private message only they see; handy on
// the mobile app, where a busy chat buries the bot's answer) or in chat.
// Bare !whisperme flips between the two. Kept per viewer across all channels
// (whisper_prefs, whisper.ts), and beats the channel's setting either way.
// A channel whispers everyone who hasn't picked with the dashboard option
// replies.mode (Bot replies card), or a mod's !whisperall on/off in chat;
// those viewers get a one-time note with their first whisper saying why
// (WHISPER_INTRO).
//
// Only replies addressed to the viewer ("@Name …") are whispered; anything
// meant for the whole chat (fight results, giveaways, the finished !newchar
// hero…) is still posted there.

import { sendChatMessage } from "./twitch.ts";
import { optWord, saveOptionsFromForm } from "./channel_options.ts";
import { explainWhisperFailure, sendWhisperPartsDetailed, setWhisperPref, setWhisperReplies, whisperMode, whisperPref } from "./whisper.ts";

/** Whether replies to this chatter's command go by whisper: their own
 * !whisperme choice, else the channel's replies.mode. intro: whispered by the
 * channel's setting alone (see WHISPER_INTRO). Never throws. */
export async function wantsWhisperReplies(broadcasterId: string, userId: string): Promise<{ on: boolean; intro: boolean }> {
  if (!userId) return { on: false, intro: false };
  const [mine, channel] = await Promise.all([whisperPref(userId), optWord(broadcasterId, "replies.mode")]);
  if (mine) return { on: mine === "whisper", intro: false };
  return { on: channel === "whisper", intro: channel === "whisper" };
}

/** !whisperall [on|off|status] (mods): the channel-wide replies.mode, same
 * as the dashboard's Bot replies card. */
export async function handleWhisperAllCommand(chatMessage: string, display: string, broadcasterId: string, isModerator: boolean): Promise<boolean> {
  const m = chatMessage.trim().match(/^!whisperall(?:\s+(on|off|status))?$/i);
  if (!m) return false;
  const arg = (m[1] ?? "status").toLowerCase();
  if (arg !== "status" && !isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can change where replies go.`, broadcasterId);
    return true;
  }
  if (arg !== "status") {
    const form = new FormData();
    form.set("opt_replies.mode", arg === "on" ? "whisper" : ""); // blank = default (chat)
    await saveOptionsFromForm(broadcasterId, form);
  }
  const on = (await optWord(broadcasterId, "replies.mode")) === "whisper";
  const now = arg === "status" ? "" : "now ";
  // Not addressed to anyone, so it posts in chat even in whisper mode.
  await sendChatMessage(
    on
      ? `📜 The bot ${now}answers your !commands by whisper here — a private message only you see, so chat stays readable (anything for the whole chat still posts). Rather have yours in chat? !whisperme off. Mods: !whisperall off to switch back.`
      : `📜 The bot ${now}answers !commands in chat here. Want yours by whisper (a private message only you see)? !whisperme on.${isModerator ? " Mods: !whisperall on whispers everyone's." : ""}`,
    broadcasterId,
  );
  return true;
}

export async function handleWhisperMeCommand(chatMessage: string, chatterId: string, display: string, broadcasterId: string): Promise<boolean> {
  const m = chatMessage.trim().match(/^!whisperme(?:\s+(on|off|status))?$/i);
  if (!m) return false;
  const channelWide = (await optWord(broadcasterId, "replies.mode")) === "whisper";
  const mine = await whisperPref(chatterId);
  const now = mine ? mine === "whisper" : channelWide;
  // Bare !whisperme flips it.
  const arg = (m[1] ?? (now ? "off" : "on")).toLowerCase();

  if (arg === "status") {
    const why = mine ? "your choice" : "this channel's setting";
    await sendChatMessage(
      now
        ? `@${display} Your replies come by whisper (a private message only you see) — ${why}. !whisperme off to get them in chat.`
        : `@${display} Your replies are posted in chat — ${why}. !whisperme on to get them by whisper instead, a private message only you see.`,
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

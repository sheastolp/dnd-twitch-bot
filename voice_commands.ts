// Voice chat commands: the streamer says "join" or "rally" on stream and
// GuildScribe types !join / !rally in chat AS the streamer (chat_as.ts), so
// it counts for them.
//
//   "join" / "let's join" / "bang join"          → !join (another bot's or game's command)
//   "rally" / "let's rally" / "rally up" /
//   "sound the war horn"                          → !rally (raid.ts: GuildScribe handles it
//                                                   like any other !rally from the streamer)
//
// A trigger has to be said on its own — a whole sentence of the transcript —
// so "join the discord" or "thanks for joining" never fire. Each is off by
// default (options voice.join, voice.rally); mods switch them with
// !voice join on|off and !voice rally on|off. !rally by voice also needs the
// raid quest on. stream_listen.ts hears them (maybeVoiceCommand) while the
// channel is live. Voice Pokéball throws (pokeball.ts) are listed here too
// (!voice ball on|off is the same as !ball voice on|off).

import { sendChatMessage } from "./twitch.ts";
import { isCommandGroupEnabled } from "./db.ts";
import { optWord, setOptionValue } from "./channel_options.ts";
import { CHAT_AS_SCOPE, chatAsProblem, sendAsStreamer } from "./chat_as.ts";
import { voiceThrowsOn } from "./pokeball.ts";

/** The same command at most this often per channel (one breath can be heard twice, and Twitch drops repeats). */
const COMMAND_COOLDOWN_MS = 30_000;

// What may come before the word: "!" read out, or "let's".
const LEAD = String.raw`(?:(?:bang|exclamation(?: point| mark)?|command|hashtag) )?(?:(?:okay|ok|alright|lets|let us) )*`;

export type VoiceCommand = {
  key: "join" | "rally";
  option: string;
  command: string;
  /** Matches one sentence, normalized (lowercase, letters and spaces). */
  re: RegExp;
  /** The command group it needs on, if any. */
  group?: string;
  said: string;
};

export const VOICE_COMMANDS: VoiceCommand[] = [
  {
    key: "join", option: "voice.join", command: "!join", said: `"join"`,
    re: new RegExp(String.raw`^${LEAD}join(?: in| up| it)?(?: join)*$`),
  },
  {
    key: "rally", option: "voice.rally", command: "!rally", said: `"rally"`, group: "raid",
    re: new RegExp(String.raw`^(?:${LEAD}rally(?: up| the troops)?(?: rally)*|${LEAD}sound the (?:war )?horn)$`),
  },
];

/** The voice command in a transcribed line, or null. */
export function heardVoiceCommand(text: string): VoiceCommand | null {
  const sentences = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’‘`]/g, "")
    .split(/[.!?;,:\n…]+/)
    .map((s) => s.replace(/[^a-z]+/g, " ").trim())
    .filter(Boolean);
  for (const s of sentences) {
    const hit = VOICE_COMMANDS.find((c) => c.re.test(s));
    if (hit) return hit;
  }
  return null;
}

/** Whether this command is switched on (and its feature is). */
async function commandOn(broadcasterId: string, c: VoiceCommand): Promise<boolean> {
  if ((await optWord(broadcasterId, c.option)) !== "on") return false;
  return !c.group || (await isCommandGroupEnabled(broadcasterId, c.group));
}

/** Whether GuildScribe should listen to this channel for voice commands. */
export async function wantsVoiceCommands(broadcasterId: string): Promise<boolean> {
  for (const c of VOICE_COMMANDS) if (await commandOn(broadcasterId, c)) return true;
  return false;
}

const lastSent = new Map<string, number>();

/**
 * Called by stream_listen.ts for each line the streamer said. Sends the
 * command as the streamer when the line is a trigger that's switched on.
 * Returns what happened, for the listen log, or null when the line isn't a
 * trigger (or it's off). Never throws.
 */
export async function maybeVoiceCommand(broadcasterId: string, text: string): Promise<{ sent: boolean; log: string } | null> {
  try {
    const c = heardVoiceCommand(text);
    if (!c || !(await commandOn(broadcasterId, c))) return null;
    const k = `${broadcasterId}:${c.key}`;
    const now = Date.now();
    if (now - (lastSent.get(k) ?? 0) < COMMAND_COOLDOWN_MS) {
      return { sent: false, log: `heard ${c.said} again within ${COMMAND_COOLDOWN_MS / 1000}s — ${c.command} not sent.` };
    }
    lastSent.set(k, now);
    const sent = await sendAsStreamer(broadcasterId, c.command, `🎙 I heard the streamer say ${c.said}, but I can't type ${c.command} as them yet.`);
    if (sent === "sent") return { sent: true, log: `heard ${c.said} — sent ${c.command} as the streamer.` };
    lastSent.delete(k);
    return {
      sent: false,
      log: sent === "no-permission"
        ? `heard ${c.said}, but there's no ${CHAT_AS_SCOPE} permission — reconnect on /connect.`
        : `Twitch refused ${c.command}.`,
    };
  } catch (e) {
    return { sent: false, log: `voice command failed: ${(e as Error).message}` };
  }
}

/** !voice [status] | !voice join|rally|ball on|off. */
export async function handleVoiceCommand(chatMessage: string, display: string, broadcasterId: string, isModerator: boolean): Promise<boolean> {
  const m = chatMessage.trim().match(/^!voice(?:\s+(join|rally|ball|pokeball|throw|throws)(?:\s+(on|off|status))?|\s+status)?\s*$/i);
  if (!m) return false;
  const say = (text: string) => sendChatMessage(`@${display} ${text}`, broadcasterId);
  const which = (m[1] ?? "").toLowerCase();
  const action = (m[2] ?? "status").toLowerCase();

  if (!which || action === "status") {
    const [join, rally, raidOn, ball, scope] = await Promise.all([
      optWord(broadcasterId, "voice.join"),
      optWord(broadcasterId, "voice.rally"),
      isCommandGroupEnabled(broadcasterId, "raid"),
      voiceThrowsOn(broadcasterId),
      chatAsProblem(broadcasterId),
    ]);
    const parts = [
      `"join" → !join ${join === "on" ? "on" : "off"}`,
      `"rally" → !rally ${rally === "on" ? (raidOn ? "on" : "on (but the raid quest is off)") : "off"}`,
      `"throw a great ball" → !pokecatch ${ball ? "on" : "off"}`,
    ];
    const anyOn = join === "on" || rally === "on" || ball;
    await say(`🎙 Voice commands (said on stream, typed as the streamer): ${parts.join(" · ")}.${anyOn && scope ? ` Heads-up: ${scope}.` : ""}${isModerator ? " Mods: !voice join|rally|ball on|off." : ""}`);
    return true;
  }
  if (!isModerator) {
    await say("only the broadcaster or a moderator can switch voice commands on or off.");
    return true;
  }
  const on = action === "on";
  if (which === "join" || which === "rally") {
    const c = VOICE_COMMANDS.find((x) => x.key === which)!;
    // "off" is the default, so off just drops the channel's own value.
    await setOptionValue(broadcasterId, c.option, on ? "on" : null);
    const notes: string[] = [];
    if (on && c.group && !(await isCommandGroupEnabled(broadcasterId, c.group))) notes.push("the raid quest is off (!feature raid on)");
    const scope = on ? await chatAsProblem(broadcasterId) : null;
    if (scope) notes.push(scope);
    await say(on
      ? `🎙 Voice ${c.command} on — when the streamer says ${c.said} on stream, I'll type ${c.command} as them (starts within a minute while live).${notes.length ? ` Heads-up: ${notes.join("; and ")}.` : ""}`
      : `🎙 Voice ${c.command} off.`);
    return true;
  }
  // ball / pokeball / throw(s): voice Pokéball throws.
  await setOptionValue(broadcasterId, "pokeball.listen", on ? "on" : null);
  await say(on
    ? `🎙 Voice Pokéball throws on — see !ball voice for what's still needed.`
    : "🎙 Voice Pokéball throws off.");
  return true;
}

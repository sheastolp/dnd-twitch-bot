// The chronicle — occasionally the scribe overhears something in chat worth
// setting down for posterity, quotes it back, and wraps it in a bit of D&D
// flavor. Off by default per channel; toggled with !chronicle.
//
// Unlike the goodnight/trigger passives (which fire on a specific pattern),
// this is a random dice roll against every qualifying plain chat message —
// gated by a per-channel enable flag, a minimum-content filter, a minimum
// amount of chat activity since the last quote, and a cooldown so it can't
// fire twice in quick succession. Bot accounts (Nightbot, StreamElements,
// GuildScribe itself, anything isBotAccount recognizes) always count toward
// that activity minimum — they're real messages scrolling through chat —
// but are never eligible to be the one quoted; recordChronicleBotMessage is
// the entry point for those, kept separate from maybeChronicleQuote so a bot
// message can never reach the roll/quote logic at all.

import {
  bumpChronicleMessageCount,
  checkChronicleCooldown,
  isChronicleEnabled,
  resetChronicleMessageCount,
  setChronicleEnabled,
} from "./db.ts";
import { sendChatMessage } from "./twitch.ts";
import { compactText, pick } from "./utils.ts";

// Odds that any single qualifying message gets chronicled. Kept low — this
// is an occasional flourish, not a running commentary.
const QUOTE_CHANCE_PERCENT = Math.min(100, Math.max(0, Number(Deno.env.get("CHRONICLE_QUOTE_CHANCE_PERCENT") ?? "3")));

// Minimum gap between chronicle quotes in a given channel, regardless of how
// many messages roll a hit in between.
const COOLDOWN_MS = Math.max(30_000, Number(Deno.env.get("CHRONICLE_COOLDOWN_MS") ?? "600000"));

// Minimum number of chat messages (any account, bots included) that must
// have passed since the last quote before another can fire — keeps a quiet
// channel from getting quoted just because enough wall-clock time elapsed.
const MIN_MESSAGES_BETWEEN_QUOTES = Math.max(0, Math.floor(Number(Deno.env.get("CHRONICLE_MIN_MESSAGES") ?? "15")));

const MIN_QUOTE_LENGTH = 8;
const MAX_QUOTE_LENGTH = 140;

// Flavor lines. Each is a function of (quote, name) so the same line never
// reads twice the same way in a row.
const CHRONICLE_LINES: Array<(quote: string, name: string) => string> = [
  (q, n) => `📜 The scribe leans in and inks it into the record: "${q}" — spoken by @${n}, for posterity.`,
  (q, n) => `🔮 A wandering oracle overhears @${n} say "${q}" and nods gravely, as if it means something.`,
  (q, n) => `🍺 Overheard at the tavern: "${q}" — @${n}. The bard is already working it into a verse.`,
  (q, n) => `📖 Chronicle entry: @${n} declared, "${q}." The guild will remember.`,
  (q, n) => `🕯️ By candlelight, the archivist copies down @${n}'s words: "${q}"`,
  (q, n) => `🎲 Fate itself pauses to consider @${n}'s claim: "${q}"`,
  (q, n) => `🧙 A passing sage mutters "curious" after hearing @${n} say: "${q}"`,
  (q, n) => `⚔️ Carved into the guild hall wall for all time: "${q}" — @${n}`,
  (q, n) => `🦉 A familiar swoops down and memorizes @${n}'s words: "${q}"`,
  (q, n) => `📯 Town crier's bulletin: @${n} was heard saying "${q}." Make of it what you will.`,
  (q, n) => `🗝️ The Vault of Quotes accepts a new entry, courtesy of @${n}: "${q}"`,
  (q, n) => `🌌 Written in the stars tonight: "${q}" — as spoken by @${n}`,
  (q, n) => `🏺 An ancient urn, when uncorked, echoes @${n}'s words: "${q}"`,
  (q, n) => `🧵 The Fates weave this into the tapestry: "${q}" — @${n}`,
  (q, n) => `📜 Prophecy fulfilled? @${n} said "${q}" and the clerics are already arguing about it.`,
  (q, n) => `🕮 Filed in the guild archive under "Things @${n} Said": "${q}"`,
  (q, n) => `🗿 Carved into an ancient monolith, presumably by @${n}: "${q}"`,
  (q, n) => `🔔 The bell tower rings once — someone important has spoken. @${n}: "${q}"`,
  (q, n) => `🏰 Posted on the guild notice board: "${q}" — @${n}`,
  (q, n) => `📚 A dusty tome falls open to a fresh page: "${q}" — @${n}`,
  (q, n) => `🍷 The innkeeper raises a glass to @${n}'s words: "${q}"`,
  (q, n) => `🧭 Even the compass spins a little at @${n}'s declaration: "${q}"`,
  (q, n) => `⛩️ A shrine bell chimes, unprompted, right after @${n} says: "${q}"`,
];

/** True if the message is worth rolling for — long enough to be interesting,
 * not a link, not just emote spam. */
function isQuotable(message: string): boolean {
  const text = message.trim();
  if (text.length < MIN_QUOTE_LENGTH) return false;
  if (/https?:\/\/|www\./i.test(text)) return false;
  // Require at least a couple of real words, not just one emote/keysmash.
  if (text.split(/\s+/).filter(Boolean).length < 2) return false;
  return true;
}

function truncateQuote(message: string): string {
  const clean = compactText(message, MAX_QUOTE_LENGTH);
  return clean.length < message.trim().length ? `${clean}…` : clean;
}

/** Rolls the dice for a plain chat message and, on a hit, quotes it back
 * with a D&D-flavored reply. No-op (and no DB writes) unless the channel has
 * chronicle enabled. Every call that reaches this function counts as a real
 * (non-bot) chat message and bumps the activity counter, even on a miss —
 * bot messages must never reach this function; call recordChronicleBotMessage
 * for those instead. Returns true if a quote was posted. */
export async function maybeChronicleQuote(
  chatMessage: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  if (!(await isChronicleEnabled(broadcasterId))) return false;

  const messageCount = await bumpChronicleMessageCount(broadcasterId);
  if (messageCount < MIN_MESSAGES_BETWEEN_QUOTES) return false;

  if (!isQuotable(chatMessage)) return false;
  if (Math.random() * 100 >= QUOTE_CHANCE_PERCENT) return false;
  if (!(await checkChronicleCooldown(broadcasterId, COOLDOWN_MS))) return false;

  const quote = truncateQuote(chatMessage);
  const line = pick(CHRONICLE_LINES)(quote, display);
  await sendChatMessage(line, broadcasterId);
  await resetChronicleMessageCount(broadcasterId);
  return true;
}

/** Counts a bot account's message toward the chronicle's activity minimum
 * without ever considering it for quoting. Cheap no-op when chronicle isn't
 * enabled for the channel, so it's safe to call unconditionally for every
 * bot message the bot ever sees. */
export async function recordChronicleBotMessage(broadcasterId: string): Promise<void> {
  if (!(await isChronicleEnabled(broadcasterId))) return;
  await bumpChronicleMessageCount(broadcasterId);
}

/** Handles !chronicle on | off | status. Returns true if the message matched. */
export async function handleChronicleCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const match = chatMessage.trim().match(/^!chronicle\s+(on|off|status)$/i);
  if (!match) return false;
  const action = match[1].toLowerCase();

  if (action === "status") {
    const enabled = await isChronicleEnabled(broadcasterId);
    await sendChatMessage(
      `@${display} The chronicle is currently ${
        enabled ? "listening — it may quote chat back at random" : "silent in this channel"
      }. Toggle with !chronicle on or !chronicle off (mod only).`,
      broadcasterId,
    );
    return true;
  }

  if (!isModerator) {
    await sendChatMessage(
      `@${display} only the broadcaster or a moderator can toggle the chronicle.`,
      broadcasterId,
    );
    return true;
  }

  const enabled = action === "on";
  await setChronicleEnabled(broadcasterId, enabled);
  await sendChatMessage(
    enabled
      ? `@${display} The scribe sharpens a quill — chat may now be quoted back at random, D&D flavor included.`
      : `@${display} The scribe sets the quill down. Chat will no longer be randomly quoted.`,
    broadcasterId,
  );
  return true;
}

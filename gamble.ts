// !gamble <amount> — Dragon's Dice: wager gold against the dragon.
//
//   !gamble <amount>         stake it, then the bot asks which die to throw
//   d4 | d6 | d8 | d10 | d12 | d20
//                            the follow-up reply (plain chat, "!gamble d6"
//                            works too) — within PICK_WINDOW_MS
//   !gamble <amount> <die>   skip the question
//   !gamble cancel           drop a wager that's waiting for its die
//
// <amount> is any coin amount !gold understands ("50", "5sp", "1gp 2sp") or
// "all". No minimum or maximum: the only rule is that you hold some gold and
// at least the stake. You and the dragon each throw the die you picked; the
// higher roll wins and a tie goes to the dragon. Small dice tie more often,
// so they pay more (DICE below) — every die keeps a small house edge, so the
// tables soak up gold rather than print it.
//
// GAMBLE_COOLDOWN_MS between throws per chatter, stamped when the dice land.
// Needs the gold system on (isPointsEnabled) — silent otherwise, like !rob
// and !bribe. Dashboard switch: gamble ("Dragon's Dice (!gamble)"), off by
// default like every group; !feature gamble on/off/status flips it from chat.
// The stake is only taken when the dice are thrown (trySpend), so a wager
// left waiting costs nothing.

import { formatCoins, parseCoins } from "./coins.ts";
import { adjustBalance, getBalance, isPointsEnabled, trySpend } from "./points_db.ts";
import { sendChatMessage } from "./twitch.ts";
import { pick } from "./utils.ts";

export const GAMBLE_COOLDOWN_MS = 30_000;
/** How long a wager waits for its die before it's dropped. */
export const PICK_WINDOW_MS = 60_000;

/** Profit on a win, as a multiple of the stake. Opposed dN with ties to the
 * house wins (N-1)/2N of the time, so these keep the return just under 95%. */
export const DICE: Record<number, number> = { 4: 1.5, 6: 1.25, 8: 1.15, 10: 1.1, 12: 1.05, 20: 1 };
const DIE_LIST = Object.keys(DICE).map(Number);

const pending = new Map<string, { stake: number | "all"; at: number }>();
const lastThrow = new Map<string, number>();
const keyOf = (broadcasterId: string, chatter: string) => `${broadcasterId}:${chatter.toLowerCase()}`;

/** "d6", "D20", "!d6", "6" → 6 when it's one of the tables' dice. */
export function parseDie(raw: string): number | null {
  const m = raw.trim().toLowerCase().match(/^!?d?(\d{1,2})$/);
  const n = m ? Number(m[1]) : NaN;
  return n in DICE ? n : null;
}

/** The winnings on a won throw: the stake times the die's payout, at least 1 cp. */
export function winnings(stake: number, die: number): number {
  return Math.max(1, Math.floor(stake * DICE[die]));
}

const payoutText = (die: number) => (DICE[die] === 1 ? "even money" : `${DICE[die]}x`);
const DIE_MENU = DIE_LIST.map((d) => `d${d} (${payoutText(d)})`).join(", ");

const BROKE_LINES: Array<(name: string) => string> = [
  (n) => `🐉 The dragon sniffs @${n}'s empty purse and snorts a puff of smoke. "Come back when you jingle." Chat with the channel to earn some gold, then try again!`,
  (n) => `🐉 @${n} sits down at Dragon's Dice with nothing but lint. The dragon doesn't play for lint. Keep chatting in the channel to earn some gold, then come back!`,
  (n) => `🐉 "No gold, no game," rumbles the dragon, curling around its hoard. @${n}, chat with the channel a while to fill your purse, then try your luck again.`,
];

const WIN_LINES: Array<(name: string, you: number, it: number, die: number, won: string) => string> = [
  (n, y, i, d, w) => `🎲 @${n} throws the d${d}: ${y} against the dragon's ${i}! The dragon grumbles and slides over ${w}.`,
  (n, y, i, d, w) => `🎲 ${y} beats ${i}! The dragon glares at its d${d} like it betrayed it, and @${n} scoops up ${w}.`,
  (n, y, i, d, w) => `🎲 @${n} rolls ${y}, the dragon only ${i}. "Beginner's luck," it hisses, coughing up ${w}.`,
];

const LOSE_LINES: Array<(name: string, you: number, it: number, die: number, lost: string) => string> = [
  (n, y, i, d, l) => `🐉 @${n} throws ${y} on the d${d}, the dragon throws ${i}. ${l} vanishes into the hoard.`,
  (n, y, i, d, l) => `🐉 The dragon's ${i} beats @${n}'s ${y}. It rakes the ${l} onto its pile without even looking up.`,
  (n, y, i, d, l) => `🐉 @${n} rolls ${y}, the dragon rolls ${i} and laughs a little smoke. Goodbye, ${l}.`,
];

const TIE_LINES: Array<(name: string, roll: number, lost: string) => string> = [
  (n, r, l) => `🐉 Both dice show ${r}! "Ties go to the house," the dragon purrs, and @${n}'s ${l} joins the hoard.`,
  (n, r, l) => `🐉 ${r} and ${r} — a tie, and the dragon's table, the dragon's rules. @${n} loses ${l}.`,
];

const roll = (die: number) => 1 + Math.floor(Math.random() * die);

/** Handles !gamble. Returns true if the message matched. */
export async function handleGambleCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!gamble(?:\s+(.*))?$/i);
  if (!m) return false;
  if (!(await isPointsEnabled(broadcasterId))) return true;
  const key = keyOf(broadcasterId, chatter);
  const args = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);

  if (!args.length) {
    await sendChatMessage(
      `@${display} 🐉 Dragon's Dice: !gamble <amount> (or all), then pick your die — ${DIE_MENU}. Higher roll wins, ties go to the dragon.`,
      broadcasterId,
    );
    return true;
  }
  if (args[0].toLowerCase() === "cancel") {
    if (pending.delete(key)) await sendChatMessage(`@${display} you pick your gold back up and leave the dragon's table.`, broadcasterId);
    return true;
  }

  // "!gamble d6" answers a wager that's waiting for its die.
  const waiting = livePending(key);
  if (waiting && args.length === 1 && parseDie(args[0])) {
    pending.delete(key);
    await throwDice(waiting.stake, parseDie(args[0])!, chatter, display, broadcasterId);
    return true;
  }

  const die = args.length > 1 ? parseDie(args[args.length - 1]) : null;
  const amountText = (die ? args.slice(0, -1) : args).join(" ");
  const stake = amountText.toLowerCase() === "all" ? "all" : parseCoins(amountText);
  if (stake === null || stake === 0) {
    await sendChatMessage(`@${display} how much are you putting down? Try !gamble 50, !gamble 5sp, !gamble 1gp or !gamble all.`, broadcasterId);
    return true;
  }

  const wait = cooldownLeftMs(key);
  if (wait > 0) {
    await sendChatMessage(`@${display} the dragon is still counting its winnings — try again in ${Math.ceil(wait / 1000)}s.`, broadcasterId);
    return true;
  }
  if (!(await canCover(stake, chatter, display, broadcasterId))) return true;

  if (die) {
    pending.delete(key);
    await throwDice(stake, die, chatter, display, broadcasterId);
    return true;
  }
  pending.set(key, { stake, at: Date.now() });
  const shown = stake === "all" ? "your whole purse" : formatCoins(stake);
  await sendChatMessage(
    `🐉 @${display} puts ${shown} on the dragon's table. Pick your die: ${DIE_MENU}. Small dice tie more, and ties go to the dragon. Type your die within ${PICK_WINDOW_MS / 1000}s.`,
    broadcasterId,
  );
  return true;
}

/** The follow-up reply ("d6") to a wager waiting for its die. Plain chat only;
 * returns true if the message was that reply. */
export async function handleGamblePick(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const key = keyOf(broadcasterId, chatter);
  const waiting = livePending(key);
  if (!waiting) return false;
  const die = parseDie(chatMessage);
  if (!die) return false;
  pending.delete(key);
  if (!(await isPointsEnabled(broadcasterId))) return true;
  await throwDice(waiting.stake, die, chatter, display, broadcasterId);
  return true;
}

/** Whether `chatter` has a wager waiting for its die (in memory, no DB). */
export const gambleWaiting = (broadcasterId: string, chatter: string) => livePending(keyOf(broadcasterId, chatter)) !== null;

function livePending(key: string) {
  const p = pending.get(key);
  if (p && Date.now() - p.at > PICK_WINDOW_MS) pending.delete(key);
  return pending.get(key) ?? null;
}

function cooldownLeftMs(key: string, now = Date.now()): number {
  return Math.max(0, (lastThrow.get(key) ?? 0) + GAMBLE_COOLDOWN_MS - now);
}

/** Rejects (with a nudge to go chat) when the purse is empty or short of the stake. */
async function canCover(stake: number | "all", chatter: string, display: string, broadcasterId: string): Promise<boolean> {
  const balance = (await getBalance(broadcasterId, chatter))?.balance ?? 0;
  if (balance <= 0) {
    await sendChatMessage(pick(BROKE_LINES)(display), broadcasterId);
    return false;
  }
  if (stake !== "all" && stake > balance) {
    await sendChatMessage(
      `🐉 @${display} you only have ${formatCoins(balance)} — not enough to cover ${formatCoins(stake)}. Bet less, or keep chatting in the channel to earn more gold and try again!`,
      broadcasterId,
    );
    return false;
  }
  return true;
}

async function throwDice(stake: number | "all", die: number, chatter: string, display: string, broadcasterId: string) {
  const key = keyOf(broadcasterId, chatter);
  const wait = cooldownLeftMs(key);
  if (wait > 0) {
    await sendChatMessage(`@${display} the dragon is still counting its winnings — try again in ${Math.ceil(wait / 1000)}s.`, broadcasterId);
    return;
  }
  // The purse may have changed while the die was being picked: re-check, then take the stake atomically.
  if (!(await canCover(stake, chatter, display, broadcasterId))) return;
  const amount = stake === "all" ? ((await getBalance(broadcasterId, chatter))?.balance ?? 0) : stake;
  if (amount <= 0 || !(await trySpend(broadcasterId, chatter, amount))) {
    await sendChatMessage(pick(BROKE_LINES)(display), broadcasterId);
    return;
  }
  lastThrow.set(key, Date.now());

  const you = roll(die), it = roll(die);
  if (you > it) {
    const won = winnings(amount, die);
    const left = await adjustBalance(broadcasterId, chatter, display, amount + won);
    await sendChatMessage(`${pick(WIN_LINES)(display, you, it, die, formatCoins(won))} (${formatCoins(left)} now)`, broadcasterId);
    return;
  }
  const left = (await getBalance(broadcasterId, chatter))?.balance ?? 0;
  const line = you === it ? pick(TIE_LINES)(display, you, formatCoins(amount)) : pick(LOSE_LINES)(display, you, it, die, formatCoins(amount));
  await sendChatMessage(`${line} (${formatCoins(left)} left)`, broadcasterId);
}

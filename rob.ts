// !rob @player — pick a pocket, and their character fights yours for it.
//
// The robber's saved character and the target's saved character are put
// through exactly the same auto-resolved duel as !dndduel @user (the shared
// resolvePlayerDuel engine in combat.ts). There is no accept step: a robbery
// isn't a polite challenge, but it is a fair fight: a coin flip decides who
// swings first. When the duel ends, the LOSER hands the WINNER a
// random single-digit percentage (1-9%) of the loser's own coin, at least
// 1 cp. So a botched robbery is expensive: if the robber loses, the robber
// pays the target.
//
//   !rob @player
//
// Rules:
//   - Needs coin switched on (!gold on, the default) — silent otherwise, like
//     the rest of the coin commands. Also part of the dashboard's "Arena &
//     company" command group (see COMMAND_GROUPS in utils.ts), so it can be
//     switched off there without touching coin.
//   - Both players need a saved character (!createchar / !newchar / !bg3).
//   - Both players must actually carry coin (no risk, no robbery).
//   - A robber waits ROB_COOLDOWN_SECONDS between robberies (default 300) and
//     a target is left alone for ROB_PROTECT_SECONDS after being targeted
//     (default 600), win or lose, so nobody gets dogpiled.
//   - Characters are not hurt and gain no XP — only coin changes hands.
//   - A target wearing a channel-point robbery shield (redemptions.ts) can't
//     be robbed until it expires; the robber's cooldown isn't spent.

import { getCharacter } from "./db.ts";
import { resolvePlayerDuel } from "./combat.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import { formatCoins } from "./coins.ts";
import { fightSummary } from "./whisper.ts";
import { robShieldRemainingMs } from "./redemptions.ts";
import {
  getBalance,
  isPointsEnabled,
  robberWaitMs,
  stampRobbery,
  transferPoints,
  victimProtectedMs,
} from "./points_db.ts";

const ROB_COOLDOWN_MS = Math.max(10, Math.floor(Number(Deno.env.get("ROB_COOLDOWN_SECONDS") ?? "300")) || 300) * 1000;
const ROB_PROTECT_MS = Math.max(0, Math.floor(Number(Deno.env.get("ROB_PROTECT_SECONDS") ?? "600")) || 0) * 1000;

export const MIN_ROB_PERCENT = 1;
export const MAX_ROB_PERCENT = 9;

const USERNAME_RE = /^[a-z0-9_]{1,25}$/;

/** A random whole percent from 1 to 9 inclusive (always a single digit). */
export function rollRobPercent(rng: () => number = Math.random): number {
  return MIN_ROB_PERCENT + Math.floor(rng() * (MAX_ROB_PERCENT - MIN_ROB_PERCENT + 1));
}

/** The coin taken: `percent` of the loser's balance, rounded down but never
 * less than 1 cp and never more than they hold. 0 if they hold nothing. */
export function robAmount(loserBalance: number, percent: number): number {
  if (loserBalance <= 0) return 0;
  return Math.min(loserBalance, Math.max(1, Math.floor((loserBalance * percent) / 100)));
}

function waitText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

/** Handles !rob. Returns true if it consumed the message. */
export async function handleRobCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const match = chatMessage.trim().match(/^!rob(?:\s+(.*))?$/i);
  if (!match) return false;

  // Coin off: silent no-op, same as !gold / !giveaway.
  if (!(await isPointsEnabled(broadcasterId))) return true;

  const robber = chatter.toLowerCase();
  const arg = (match[1] ?? "").trim();
  const target = arg.replace(/^@/, "").toLowerCase();
  if (!arg || !/^@?\S+$/.test(arg) || !USERNAME_RE.test(target)) {
    await sendChatMessage(`@${display} usage: !rob @player — your characters duel, and the loser pays the winner a 1-9% cut of their coin.`, broadcasterId);
    return true;
  }
  if (target === robber) {
    await sendChatMessage(`@${display} you can't rob yourself — the guild watch is tempted to arrest you anyway.`, broadcasterId);
    return true;
  }

  const [robberChar, targetChar] = await Promise.all([
    getCharacter(robber, broadcasterId),
    getCharacter(target, broadcasterId),
  ]);
  if (!robberChar) {
    await sendChatMessage(`@${display} you need a saved character before you can rob anyone — try !createchar.`, broadcasterId);
    return true;
  }
  if (!targetChar) {
    await sendChatMessage(`@${display} ${target} has no saved character to fight back with, so there's nobody to rob.`, broadcasterId);
    return true;
  }

  const [robberPurse, targetPurse] = await Promise.all([
    getBalance(broadcasterId, robber),
    getBalance(broadcasterId, target),
  ]);
  if (!robberPurse || robberPurse.balance <= 0) {
    await sendChatMessage(`@${display} your own purse is empty — no risk, no robbery. Chat while the stream is live to earn copper.`, broadcasterId);
    return true;
  }
  if (!targetPurse || targetPurse.balance <= 0) {
    await sendChatMessage(`@${display} ${target}'s pockets are empty — nothing worth stealing.`, broadcasterId);
    return true;
  }

  const myWait = await robberWaitMs(broadcasterId, robber, ROB_COOLDOWN_MS);
  if (myWait > 0) {
    await sendChatMessage(`@${display} lie low for ${waitText(myWait)} before your next robbery.`, broadcasterId);
    return true;
  }
  const theirShield = ROB_PROTECT_MS > 0 ? await victimProtectedMs(broadcasterId, target, ROB_PROTECT_MS) : 0;
  if (theirShield > 0) {
    await sendChatMessage(`@${display} ${targetPurse.displayName} was just targeted and is watching their purse — try again in ${waitText(theirShield)}.`, broadcasterId);
    return true;
  }

  // A channel-point robbery shield (redemptions.ts) beats everything below.
  const wardMs = await robShieldRemainingMs(broadcasterId, target);
  if (wardMs > 0) {
    await sendChatMessage(`@${display} ${targetPurse.displayName} is under a robbery shield for another ${waitText(wardMs)} — no luck.`, broadcasterId);
    return true;
  }

  // Start the clocks before the fight so a burst of messages can't stack.
  await stampRobbery(broadcasterId, robber, target);

  // The engine gives the first swing to whoever is passed first, and level-1
  // fights are short, so going first is a real edge (measured over random
  // character pairs: the robber won ~58% when always first, ~50% with a coin
  // flip). Flip for initiative so a robbery is a fair fight.
  const robberStrikesFirst = Math.random() < 0.5;
  const result = robberStrikesFirst
    ? resolvePlayerDuel(robber, target, robberChar, targetChar)
    : resolvePlayerDuel(target, robber, targetChar, robberChar);
  const robberWon = result.winner === robber;
  const winner = robberWon ? robber : target;
  const loser = robberWon ? target : robber;
  const winnerName = robberWon ? display : targetPurse.displayName;
  const loserName = robberWon ? targetPurse.displayName : display;

  // Re-read the loser's purse now: it may have changed during the fight.
  const loserNow = (await getBalance(broadcasterId, loser))?.balance ?? 0;
  const percent = rollRobPercent();
  const amount = robAmount(loserNow, percent);
  let outcome: string;
  let loot = "";
  if (amount <= 0 || (await transferPoints(broadcasterId, loser, winner, winnerName, amount)) !== "ok") {
    outcome = `${loserName} has nothing left to lose — the winner leaves empty-handed.`;
  } else {
    loot = `${winnerName} +${formatCoins(amount)}`;
    outcome = robberWon
      ? `💰 @${display} slips away with ${percent}% of ${loserName}'s purse: ${formatCoins(amount)}!`
      : `🛡️ @${display} is caught red-handed! ${winnerName} claims ${percent}% of their purse as a fine: ${formatCoins(amount)}.`;
  }

  const lunge = `🗡️ @${display} lunges at ${targetPurse.displayName} from the shadows!`;
  await sendChatMessages(`${lunge} ${result.log} ${outcome}`, broadcasterId, {
    detail: `${lunge} ${result.fullLog} ${outcome}`,
    names: [robber, target, display, targetPurse.displayName],
    summary: fightSummary({
      fighter: display,
      enemy: targetPurse.displayName,
      outcome: robberWon ? `${display} gets away with it!` : `${display} is caught — ${targetPurse.displayName} wins.`,
      loot,
    }),
  });
  return true;
}

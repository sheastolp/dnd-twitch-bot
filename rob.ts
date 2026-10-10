// !rob @player — pick a pocket, and their character fights yours for it.
//
// The robber's saved character and the target's saved character are put
// through exactly the same auto-resolved duel as !dndduel @user (the shared
// resolvePlayerDuel engine in combat.ts). There is no accept step: a robbery
// isn't a polite challenge, but it is a fair fight: initiative (d20 + DEX)
// decides who swings first. When the duel ends, the LOSER hands the WINNER a
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
//   - Heat: every attempt is remembered for rob.heat (default 2h). Before the
//     duel the target gets a chance to spot the robber coming — robHeat()
//     below: +15% per earlier attempt by this robber on this target, +5% per
//     other robbery this robber tried, +5% per time anyone else went after
//     this target, capped at 75%. Spotted means caught: no fight, the robber
//     pays the target the usual 1-9% fine. So the more you rob (above all the
//     same person) and the more a target has been robbed, the worse your odds.
//   - Characters are not hurt and gain no XP — only coin changes hands.
//   - A target wearing a channel-point robbery shield (redemptions.ts) can't
//     be robbed until it expires; the robber's cooldown isn't spent.
//   - Targeting GuildScribe itself (TWITCH_BOT_LOGIN, default guildscribebot)
//     never starts a fight: the bot deflects, mocks the would-be robber and
//     moves a 1-9% cut of THEIR purse (at least 1 cp) into the swear jar.
//     No character needed, no cooldown spent — every attempt costs.

import { getCharacter } from "./db.ts";
import { resolvePlayerDuel } from "./combat.ts";
import { recordBattle } from "./battle_log.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import { formatCoins } from "./coins.ts";
import { fightSummary, hpLeft } from "./whisper.ts";
import { robShieldRemainingMs } from "./redemptions.ts";
import {
  getBalance,
  isPointsEnabled,
  recordRobAttempt,
  robberWaitMs,
  robHeatCounts,
  stampRobbery,
  transferPoints,
  trySpend,
  victimProtectedMs,
} from "./points_db.ts";
import { optNum } from "./channel_options.ts";
import { adjustJar } from "./swearjar.ts";
import { pick } from "./utils.ts";

// The robbery cooldown and the victim's shield are per-channel options (channel_options.ts:
// rob.cooldown, rob.protect), defaulting to ROB_COOLDOWN_SECONDS / ROB_PROTECT_SECONDS.

export const MIN_ROB_PERCENT = 1;
export const MAX_ROB_PERCENT = 9;

/** Heat (spot chance, %) added per earlier attempt in the window. */
export const HEAT_PER_REPEAT = 15;
export const HEAT_PER_ROBBERY = 5;
export const HEAT_PER_TARGETED = 5;
export const MAX_HEAT = 75;

/** The % chance the target spots the robber before any fight, from recent
 * attempts (robHeatCounts in points_db.ts). */
export function robHeat(c: { pair: number; robber: number; victim: number }): number {
  return Math.min(MAX_HEAT, c.pair * HEAT_PER_REPEAT + c.robber * HEAT_PER_ROBBERY + c.victim * HEAT_PER_TARGETED);
}

/** Why the heat is what it is, for the "spotted" line. */
function heatReasons(c: { pair: number; robber: number; victim: number }, robberName: string, targetName: string): string {
  const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
  const out: string[] = [];
  if (c.pair) out.push(`${robberName} already tried ${targetName} ${times(c.pair)}`);
  if (c.robber) out.push(`${robberName} has hit ${times(c.robber)} elsewhere`);
  if (c.victim) out.push(`${targetName} has been targeted ${times(c.victim)} by others`);
  return out.join(", ");
}

const SPOTTED: ((robber: string, target: string) => string)[] = [
  (r, t) => `👀 ${t} has been expecting this — they turn around before @${r} gets close and grab them by the collar!`,
  (r, t) => `🔔 The whole street knows @${r}'s face by now. ${t} spots them a mile off and calls the watch!`,
  (r, t) => `🪤 ${t} left a decoy purse out as bait, and @${r} walked right into it.`,
  (r, t) => `🕯️ @${r} creeps up on ${t}… who was sitting up waiting, cudgel in hand.`,
];

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

/** GuildScribe's own Twitch login, so `!rob @GuildScribeBot` can be caught. */
export function botLogin(): string {
  return (Deno.env.get("TWITCH_BOT_LOGIN") ?? "guildscribebot").trim().replace(/^@/, "").toLowerCase();
}

const BOT_DEFLECTIONS: ((name: string, coin: string) => string)[] = [
  (n, c) => `🪶 @${n} reaches for the Scribe's purse and grabs an inkwell instead. The Scribe sighs, notes "attempted theft of a narrator" in the chronicle, and drops ${c} of ${n}'s coin in the swear jar for the trouble.`,
  (n, c) => `📜 @${n} tries to rob the one who writes the story. The Scribe simply writes "${n} trips over their own feet" — and so it was. ${c} spills from their purse into the swear jar.`,
  (n, c) => `🛡️ @${n} lunges at GuildScribe and is parried by a quill. A quill. ${c} of their coin goes in the swear jar as a fine for sheer embarrassment.`,
  (n, c) => `🎲 @${n} rolls to rob the Scribe… natural 1. The whole tavern saw that. ${c} is confiscated and rattles into the swear jar.`,
  (n, c) => `👻 @${n} picks the Scribe's pocket and finds only a note: "Nice try." Their own purse is ${c} lighter — the swear jar thanks them for their donation.`,
];

const BOT_DEFLECTIONS_BROKE = [
  (n: string) => `🪶 @${n} tries to rob the Scribe and gets parried by a quill. The Scribe would fine you, but your purse is as empty as your plan.`,
  (n: string) => `🎲 @${n} rolls to rob GuildScribe… natural 1. The swear jar wanted a cut, but you're too broke to even fine.`,
];

/** `!rob @GuildScribeBot`: mock the robber and fine a 1-9% cut of their
 * purse into the swear jar. */
async function deflectBotRobbery(robber: string, display: string, broadcasterId: string): Promise<void> {
  const purse = (await getBalance(broadcasterId, robber))?.balance ?? 0;
  const amount = robAmount(purse, rollRobPercent());
  if (amount <= 0 || !(await trySpend(broadcasterId, robber, amount))) {
    await sendChatMessage(pick(BOT_DEFLECTIONS_BROKE)(display), broadcasterId);
    return;
  }
  const total = await adjustJar(broadcasterId, amount);
  await sendChatMessage(`${pick(BOT_DEFLECTIONS)(display, formatCoins(amount))} (Jar: ${formatCoins(total)})`, broadcasterId);
}

/** The target saw the robber coming (heat): no duel, the robber pays the
 * usual 1-9% fine straight to the target. */
async function robberSpotted(
  broadcasterId: string,
  robber: string,
  display: string,
  target: string,
  targetName: string,
  heat: number,
  reasons: string,
): Promise<void> {
  const purse = (await getBalance(broadcasterId, robber))?.balance ?? 0;
  const percent = rollRobPercent();
  const amount = robAmount(purse, percent);
  const paid = amount > 0 && (await transferPoints(broadcasterId, robber, target, targetName, amount)) === "ok";
  const fine = paid
    ? `${targetName} takes ${percent}% of their purse as a fine: ${formatCoins(amount)}.`
    : `Their purse is too empty to fine.`;
  await recordBattle(broadcasterId, {
    kind: "rob",
    side: targetName,
    foe: display,
    outcome: "win",
    note: paid ? `+${formatCoins(amount)} (spotted)` : "spotted",
  });
  await sendChatMessage(
    `${pick(SPOTTED)(display, targetName)} ${fine} 🔥 Heat ${heat}%: ${reasons}.`,
    broadcasterId,
  );
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
  if (target === botLogin()) {
    await deflectBotRobbery(robber, display, broadcasterId);
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

  const [ROB_COOLDOWN_MS, ROB_PROTECT_MS] = (await Promise.all([optNum(broadcasterId, "rob.cooldown"), optNum(broadcasterId, "rob.protect")])).map((s) => s * 1000);
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

  // Heat from earlier attempts, counted before this one is logged.
  const heatMs = (await optNum(broadcasterId, "rob.heat")) * 1000;
  const counts = await robHeatCounts(broadcasterId, robber, target, heatMs);
  const heat = robHeat(counts);

  // Start the clocks before the fight so a burst of messages can't stack.
  await stampRobbery(broadcasterId, robber, target);
  if (heatMs > 0) await recordRobAttempt(broadcasterId, robber, target);

  if (heat > 0 && Math.random() * 100 < heat) {
    await robberSpotted(broadcasterId, robber, display, target, targetPurse.displayName, heat, heatReasons(counts, display, targetPurse.displayName));
    return true;
  }

  // The engine rolls initiative (d20 + DEX) for the first swing, and a dead
  // heat (same total, same DEX) goes to whoever is passed first. Level-1
  // fights are short, so going first is a real edge: flip for that slot so
  // the robber never wins the tie by default.
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

  await recordBattle(broadcasterId, {
    kind: "rob",
    side: winnerName,
    foe: loserName,
    outcome: "win",
    note: loot ? `+${formatCoins(amount)}` : undefined,
  });
  const lunge = `🗡️ @${display} lunges at ${targetPurse.displayName} from the shadows!`;
  await sendChatMessages(`${lunge} ${result.log} ${outcome}`, broadcasterId, {
    detail: `${lunge} ${result.fullLog} ${outcome}`,
    names: [robber, target, display, targetPurse.displayName],
    summary: fightSummary({
      fighter: display,
      enemy: targetPurse.displayName,
      outcome: robberWon ? `${display} gets away with it!` : `${display} is caught — ${targetPurse.displayName} wins.`,
      hp: hpLeft([
        [display, result.hp[robber], robberChar.hpMax],
        [targetPurse.displayName, result.hp[target], targetChar.hpMax],
      ]),
      loot,
    }),
  });
  return true;
}

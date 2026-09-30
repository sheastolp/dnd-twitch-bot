// Gold (points), the gold leaderboard, and giveaways.
//
// Viewers earn COPPER just by chatting while the stream is live, spend coin
// on tickets in mod-run giveaways and on wares haggled from the market
// peddler (haggle.ts), and can gift coin to each other. ON by default per
// channel; a mod can switch it off with !gold off or the web dashboard.
//
// Balances are one integer of copper (see coins.ts): 10 cp = 1 sp, 10 sp =
// 1 gp. Everything is shown as "1 gp 2 sp 3 cp". Amounts you type accept
// units: 50 (bare = copper), 5sp, 1gp, "1 gp 2 sp 3 cp".
//
// The currency is "gold" rather than "points", and the leaderboard is
// `!gold top` rather than `!leaderboard`, on purpose: !points and
// !leaderboard are the names StreamElements and other bots already own
// (that collision is why the dice leaderboard became !rollcall).
//
//   !gold                          your balance and rank
//   !gold @user                    someone else's balance
//   !gold top [N]  /  !goldboard   richest adventurers (default 5, max 10)
//   !gold give @user <amount>      gift some of your coin (e.g. 5sp)
//   !gold add|remove|set @user <amount>   (mod) adjust a balance
//   !gold on|off|status            (mod for on/off) toggle the whole system
//
//   !giveaway [status]             what's up for grabs
//   !giveaway enter [tickets]      buy in (free giveaways: one entry each)
//   !giveaway start [cost=<amount>] [max=N] <prize>   (mod)
//   !giveaway draw | reroll | cancel           (mod)
//
// Earning: copper for one message per viewer per cooldown window, only while
// the channel is live. Tunable with POINTS_PER_MESSAGE (copper) and
// POINTS_EARN_COOLDOWN_SECONDS.

import { sendChatMessage } from "./twitch.ts";
import { pick } from "./utils.ts";
import { formatCoins, MAX_COPPER, parseCoins } from "./coins.ts";
import {
  addEntryTickets,
  adjustBalance,
  awardChatPoints,
  cancelGiveaway,
  drawGiveawayWinner,
  getBalance,
  getEntry,
  getGiveaway,
  getGiveawayTotals,
  getTopBalances,
  isPointsEnabled,
  setBalance,
  setPointsEnabled,
  startGiveaway,
  transferPoints,
  trySpend,
} from "./points_db.ts";

/** Copper earned per qualifying chat message. */
const POINTS_PER_MESSAGE = Math.min(1000, Math.max(1, Math.floor(Number(Deno.env.get("POINTS_PER_MESSAGE") ?? "1")) || 1));
const EARN_COOLDOWN_MS = Math.max(10, Math.floor(Number(Deno.env.get("POINTS_EARN_COOLDOWN_SECONDS") ?? "60")) || 60) * 1000;

const MAX_PRIZE_LENGTH = 120;
const DEFAULT_MAX_TICKETS = 10;
const MAX_TICKETS_CAP = 100;
const DEFAULT_LEADERBOARD = 5;
const MAX_LEADERBOARD = 10;

const USERNAME_RE = /^[a-z0-9_]{1,25}$/;

// Winner announcements. Each is a function of (winner, prize) so the prize
// can land mid-sentence. Keep ≥ 20 unique, D&D-themed entries.
export const GIVEAWAY_WINNER_LINES: Array<(name: string, prize: string) => string> = [
  (n, p) => `🎲 The dice of fate tumble and land on @${n}! The hoard yields: ${p}`,
  (n, p) => `📜 By decree of the guild, @${n} claims the spoils: ${p}`,
  (n, p) => `🐉 The dragon stirs, yawns, and slides ${p} across the cavern floor to @${n}.`,
  (n, p) => `🧙 A wizard snaps his fingers — ${p} appears in @${n}'s pack with a puff of smoke!`,
  (n, p) => `⚔️ Hail, @${n}! You've bested every rival for the prize: ${p}`,
  (n, p) => `🍺 The tavern erupts as the innkeeper announces the winner: @${n}! Enjoy ${p}`,
  (n, p) => `🗝️ The vault door swings open and ${p} is yours, @${n}!`,
  (n, p) => `🔮 The crystal ball clears and shows one name: @${n}. Your prize: ${p}`,
  (n, p) => `📯 Hear ye, hear ye! The town crier proclaims @${n} the victor — ${p} awaits!`,
  (n, p) => `🦉 A messenger owl drops a sealed scroll on @${n}'s shoulder: you've won ${p}`,
  (n, p) => `👑 The crown of fortune passes to @${n}, along with ${p}`,
  (n, p) => `🎰 Natural 20! The roll crowns @${n} and the treasure ${p} is theirs.`,
  (n, p) => `🏰 The lord of the keep raises a goblet to @${n} and bestows ${p}`,
  (n, p) => `🌟 A comet streaks overhead — an omen! @${n} is the chosen one. Claim ${p}`,
  (n, p) => `🧝 The elven council has deliberated, and @${n} is granted ${p}`,
  (n, p) => `🪙 A mimic coughs up a shiny surprise: ${p} — and it's meant for @${n}!`,
  (n, p) => `🛡️ The paladin steps aside as @${n} strides forward to accept ${p}`,
  (n, p) => `🍀 A four-leaf clover sprouts at @${n}'s feet, and with it arrives ${p}`,
  (n, p) => `🕯️ The oracle's candle gutters out, leaving only one name in the smoke: @${n}. Prize: ${p}`,
  (n, p) => `🏹 The arrow of destiny strikes true — @${n}! ${p} is yours to keep.`,
  (n, p) => `🐲 A baby dragon hiccups and ${p} tumbles out, landing right in front of @${n}!`,
  (n, p) => `🎻 The bard strikes up a victory tune for @${n}, winner of ${p}`,
  (n, p) => `🧪 The alchemist's cauldron bubbles, fizzes, and produces ${p} for @${n}!`,
  (n, p) => `⛺ Around the campfire, the party cheers: @${n} has won ${p}`,
];

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function cleanUsername(raw: string): string | null {
  const name = raw.trim().replace(/^@/, "").toLowerCase();
  return USERNAME_RE.test(name) ? name : null;
}

/** A positive typed amount ("50", "5sp", "1 gp 2 sp") in copper. */
function parseAmount(raw: string): number | null {
  const n = parseCoins(raw);
  return n !== null && n > 0 ? n : null;
}

const coin = formatCoins;

// ── Passive earning (called from main.ts for plain chat messages) ──

/** Grants gold for an ordinary chat message. Safe to call for every
 * non-command message from a real (non-bot) viewer while the stream is
 * live — does nothing when the system is off or the viewer is cooling down. */
export async function maybeAwardChatPoints(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
): Promise<void> {
  if (chatMessage.trim().length < 2) return;
  if (!(await isPointsEnabled(broadcasterId))) return;
  await awardChatPoints(broadcasterId, chatter, display, POINTS_PER_MESSAGE, EARN_COOLDOWN_MS);
}

// ── Command router ──

/** Handles !gold, !goldboard and !giveaway. Returns true if it consumed the
 * message. The on/off/status subcommands work even while the system is off
 * (so a mod can turn it on); everything else is a silent no-op when off. */
export async function handlePointsCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const text = chatMessage.trim();
  const goldMatch = text.match(/^!(gold|goldboard)(?:\s+(.*))?$/i);
  const giveawayMatch = text.match(/^!giveaway(?:\s+(.*))?$/i);
  if (!goldMatch && !giveawayMatch) return false;

  if (goldMatch) {
    const isBoard = goldMatch[1].toLowerCase() === "goldboard";
    const args = (goldMatch[2] ?? "").trim();

    if (!isBoard) {
      const toggle = args.match(/^(on|off|status)$/i);
      if (toggle) return await handleToggle(toggle[1].toLowerCase(), display, broadcasterId, isModerator);
    }
    if (!(await isPointsEnabled(broadcasterId))) return true;

    if (isBoard) return await showLeaderboard(args, display, broadcasterId);
    return await handleGold(args, chatter, display, broadcasterId, isModerator);
  }

  if (!(await isPointsEnabled(broadcasterId))) return true;
  return await handleGiveaway((giveawayMatch![1] ?? "").trim(), chatter, display, broadcasterId, isModerator);
}

async function handleToggle(action: string, display: string, broadcasterId: string, isModerator: boolean): Promise<boolean> {
  if (action === "status") {
    const enabled = await isPointsEnabled(broadcasterId);
    await sendChatMessage(
      `@${display} Gold & giveaways are ${
        enabled ? `open — chat while the stream is live to earn coin, then try !gold, !gold top, !giveaway, or !haggle` : "closed in this channel"
      }. Toggle with !gold on or !gold off (mod only).`,
      broadcasterId,
    );
    return true;
  }
  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can toggle gold & giveaways.`, broadcasterId);
    return true;
  }
  const enabled = action === "on";
  await setPointsEnabled(broadcasterId, enabled);
  await sendChatMessage(
    enabled
      ? `@${display} The guild treasury is open! Adventurers now earn copper by chatting while live — check yours with !gold, see the richest with !gold top.`
      : `@${display} The treasury doors are barred. No more coin will be earned, gold commands are paused, and !haggle is back to just banter (balances are kept).`,
    broadcasterId,
  );
  return true;
}

async function showLeaderboard(args: string, display: string, broadcasterId: string): Promise<boolean> {
  const n = args.match(/^(\d{1,2})$/);
  const limit = n ? Math.min(MAX_LEADERBOARD, Math.max(1, Number(n[1]))) : DEFAULT_LEADERBOARD;
  const top = await getTopBalances(broadcasterId, limit);
  if (!top.length) {
    await sendChatMessage(`@${display} The treasury is empty — chat while the stream is live to earn copper!`, broadcasterId);
    return true;
  }
  const medals = ["🥇", "🥈", "🥉"];
  const rows = top.map((e, i) => `${medals[i] ?? `${i + 1}.`} ${e.displayName} — ${coin(e.balance)}`).join(" | ");
  await sendChatMessage(`💰 Richest adventurers: ${rows}`, broadcasterId);
  return true;
}

async function handleGold(
  args: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  // !gold  — own balance
  if (!args) return await showBalance(chatter, display, broadcasterId, true);

  // !gold top [N]
  const top = args.match(/^top(?:\s+(.*))?$/i);
  if (top) return await showLeaderboard((top[1] ?? "").trim(), display, broadcasterId);

  // !gold @user
  if (/^@\S+$/.test(args)) {
    const target = cleanUsername(args);
    if (!target) {
      await sendChatMessage(`@${display} that doesn't look like a valid username.`, broadcasterId);
      return true;
    }
    return await showBalance(target, target, broadcasterId, target === chatter.toLowerCase());
  }

  // !gold give @user N
  const give = args.match(/^give\s+(\S+)\s+(.+)$/i);
  if (give) {
    const target = cleanUsername(give[1]);
    const amount = parseAmount(give[2]);
    if (!target || !amount) {
      await sendChatMessage(`@${display} usage: !gold give @user <amount>`, broadcasterId);
      return true;
    }
    if (target === chatter.toLowerCase()) {
      await sendChatMessage(`@${display} you can't give coin to yourself — the treasurer is watching.`, broadcasterId);
      return true;
    }
    const result = await transferPoints(broadcasterId, chatter, target, target, amount);
    await sendChatMessage(
      result === "ok"
        ? `@${display} hands ${coin(amount)} to @${target}. How generous!`
        : `@${display} your purse doesn't hold that much. Check with !gold.`,
      broadcasterId,
    );
    return true;
  }

  // !gold add|remove|set @user N  (mod)
  const adjust = args.match(/^(add|remove|set)\s+(\S+)\s+(.+)$/i);
  if (adjust) {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can adjust coin.`, broadcasterId);
      return true;
    }
    const op = adjust[1].toLowerCase();
    const target = cleanUsername(adjust[2]);
    // "set" may legitimately be 0; add/remove must be positive.
    const amount = op === "set" ? parseCoins(adjust[3]) : parseAmount(adjust[3]);
    if (!target || amount === null) {
      await sendChatMessage(`@${display} usage: !gold ${op} @user <amount>`, broadcasterId);
      return true;
    }
    const balance = op === "add"
      ? await adjustBalance(broadcasterId, target, target, amount)
      : op === "remove"
      ? await adjustBalance(broadcasterId, target, target, -amount)
      : await setBalance(broadcasterId, target, target, amount);
    await sendChatMessage(`@${display} @${target} now holds ${coin(balance)}.`, broadcasterId);
    return true;
  }

  await sendChatMessage(
    `@${display} coin: !gold | !gold @user | !gold top | !gold give @user <amount, e.g. 5sp>${
      isModerator ? " | !gold add/remove/set @user <amount> | !gold on/off" : ""
    }`,
    broadcasterId,
  );
  return true;
}

async function showBalance(username: string, label: string, broadcasterId: string, self: boolean): Promise<boolean> {
  const row = await getBalance(broadcasterId, username);
  const name = row?.displayName ?? label;
  if (!row) {
    await sendChatMessage(
      self
        ? `@${name} your purse is empty — chat while the stream is live to earn copper!`
        : `${name} hasn't earned any coin here yet.`,
      broadcasterId,
    );
    return true;
  }
  await sendChatMessage(
    self
      ? `@${name} you carry ${coin(row.balance)} — #${row.rank} in the guild.`
      : `${name} carries ${coin(row.balance)} — #${row.rank} in the guild.`,
    broadcasterId,
  );
  return true;
}

// ── Giveaways ──

async function handleGiveaway(
  args: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const sub = args.match(/^(\w+)(?:\s+(.*))?$/);
  const action = (sub?.[1] ?? "status").toLowerCase();
  const rest = (sub?.[2] ?? "").trim();

  const modOnly = ["start", "draw", "reroll", "cancel"];
  if (modOnly.includes(action) && !isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can ${action} a giveaway.`, broadcasterId);
    return true;
  }

  switch (action) {
    case "status":
      return await giveawayStatus(display, broadcasterId);
    case "enter":
      return await giveawayEnter(rest, chatter, display, broadcasterId);
    case "start":
      return await giveawayStart(rest, chatter, display, broadcasterId);
    case "draw":
      return await giveawayDraw(display, broadcasterId, false);
    case "reroll":
      return await giveawayDraw(display, broadcasterId, true);
    case "cancel": {
      const giveaway = await getGiveaway(broadcasterId);
      if (!giveaway) {
        await sendChatMessage(`@${display} there's no giveaway to cancel.`, broadcasterId);
        return true;
      }
      const refunded = await cancelGiveaway(broadcasterId);
      await sendChatMessage(
        `@${display} The giveaway for "${giveaway.prize}" has been called off.${
          refunded ? ` ${fmt(refunded)} entrant${refunded === 1 ? " was" : "s were"} refunded in full.` : ""
        }`,
        broadcasterId,
      );
      return true;
    }
    default:
      await sendChatMessage(
        `@${display} giveaway: !giveaway | !giveaway enter [tickets]${
          isModerator ? " | !giveaway start [cost=<amount>] [max=N] <prize> | !giveaway draw | !giveaway reroll | !giveaway cancel" : ""
        }`,
        broadcasterId,
      );
      return true;
  }
}

async function giveawayStatus(display: string, broadcasterId: string): Promise<boolean> {
  const giveaway = await getGiveaway(broadcasterId);
  if (!giveaway) {
    await sendChatMessage(`@${display} no giveaway is running right now.`, broadcasterId);
    return true;
  }
  if (giveaway.status === "closed") {
    await sendChatMessage(
      `@${display} The last giveaway ("${giveaway.prize}") has ended${
        giveaway.winners.length ? ` — won by @${giveaway.winners[giveaway.winners.length - 1]}` : ""
      }.`,
      broadcasterId,
    );
    return true;
  }
  const totals = await getGiveawayTotals(broadcasterId);
  const how = giveaway.cost > 0
    ? `${coin(giveaway.cost)} per ticket, up to ${giveaway.maxTickets} each — !giveaway enter [tickets]`
    : `free to enter — !giveaway enter`;
  await sendChatMessage(
    `🎁 Giveaway: ${giveaway.prize} | ${how} | ${fmt(totals.entrants)} entrant${totals.entrants === 1 ? "" : "s"}, ${fmt(totals.tickets)} ticket${totals.tickets === 1 ? "" : "s"}`,
    broadcasterId,
  );
  return true;
}

async function giveawayStart(rest: string, chatter: string, display: string, broadcasterId: string): Promise<boolean> {
  const existing = await getGiveaway(broadcasterId);
  if (existing?.status === "open") {
    await sendChatMessage(
      `@${display} "${existing.prize}" is still running — !giveaway draw to pick a winner or !giveaway cancel to call it off.`,
      broadcasterId,
    );
    return true;
  }

  // Leading key=value options (cost=, max=), then the rest is the prize.
  let cost = 0;
  let maxTickets: number | null = null;
  const tokens = rest.split(/\s+/).filter(Boolean);
  while (tokens.length) {
    const opt = tokens[0].match(/^(cost|max)=(\S+)$/i);
    if (!opt) break;
    if (opt[1].toLowerCase() === "cost") {
      // Typed without spaces: cost=50 (copper), cost=5sp, cost=1gp, cost=1g5s
      const parsed = parseCoins(opt[2]);
      if (parsed === null) {
        await sendChatMessage(`@${display} couldn't read that cost — try cost=50 (copper), cost=5sp, or cost=1gp.`, broadcasterId);
        return true;
      }
      cost = parsed;
    } else {
      maxTickets = /^\d{1,9}$/.test(opt[2]) ? Number(opt[2]) : null;
    }
    tokens.shift();
  }
  const prize = tokens.join(" ").slice(0, MAX_PRIZE_LENGTH).trim();
  if (!prize) {
    await sendChatMessage(
      `@${display} usage: !giveaway start [cost=<amount>] [max=N] <prize> — e.g. !giveaway start cost=5sp max=5 Steam key (amounts: 50 = copper, 5sp, 1gp)`,
      broadcasterId,
    );
    return true;
  }
  if (cost > MAX_COPPER) cost = MAX_COPPER;
  // Free giveaways are one entry per viewer; paid ones default to a cap.
  const tickets = cost === 0 ? 1 : Math.min(MAX_TICKETS_CAP, Math.max(1, maxTickets ?? DEFAULT_MAX_TICKETS));

  await startGiveaway(broadcasterId, prize, cost, tickets, chatter);
  await sendChatMessage(
    `🎁 GIVEAWAY: ${prize}! ${
      cost > 0
        ? `Tickets cost ${coin(cost)} each (max ${tickets} per person) — type !giveaway enter [tickets]`
        : `Free to enter — type !giveaway enter`
    }`,
    broadcasterId,
  );
  return true;
}

async function giveawayEnter(rest: string, chatter: string, display: string, broadcasterId: string): Promise<boolean> {
  const giveaway = await getGiveaway(broadcasterId);
  if (!giveaway || giveaway.status !== "open") {
    await sendChatMessage(`@${display} there's no giveaway open for entries right now.`, broadcasterId);
    return true;
  }
  let wanted = 1;
  if (rest) {
    const n = rest.match(/^(\d{1,3})$/);
    if (!n || Number(n[1]) < 1) {
      await sendChatMessage(`@${display} usage: !giveaway enter [tickets]`, broadcasterId);
      return true;
    }
    wanted = Number(n[1]);
  }

  const have = await getEntry(broadcasterId, chatter);
  const room = giveaway.maxTickets - have;
  if (room <= 0) {
    await sendChatMessage(
      giveaway.maxTickets === 1
        ? `@${display} you're already entered — good luck!`
        : `@${display} you already hold the maximum of ${giveaway.maxTickets} tickets.`,
      broadcasterId,
    );
    return true;
  }
  const buying = Math.min(wanted, room);

  if (giveaway.cost > 0) {
    const total = giveaway.cost * buying;
    if (!(await trySpend(broadcasterId, chatter, total))) {
      await sendChatMessage(
        `@${display} ${buying} ticket${buying === 1 ? "" : "s"} cost${buying === 1 ? "s" : ""} ${coin(total)} — check your purse with !gold.`,
        broadcasterId,
      );
      return true;
    }
  }
  await addEntryTickets(broadcasterId, chatter, display, buying);
  await sendChatMessage(
    `@${display} you're in! ${have + buying} ticket${have + buying === 1 ? "" : "s"} for "${giveaway.prize}"${
      giveaway.cost > 0 ? ` (spent ${coin(giveaway.cost * buying)})` : ""
    }${buying < wanted ? ` — capped at ${giveaway.maxTickets}` : ""}. Good luck!`,
    broadcasterId,
  );
  return true;
}

async function giveawayDraw(display: string, broadcasterId: string, reroll: boolean): Promise<boolean> {
  const giveaway = await getGiveaway(broadcasterId);
  if (!giveaway) {
    await sendChatMessage(`@${display} there's no giveaway to draw.`, broadcasterId);
    return true;
  }
  if (reroll && giveaway.status === "open") {
    await sendChatMessage(`@${display} nothing to reroll yet — use !giveaway draw first.`, broadcasterId);
    return true;
  }
  if (!reroll && giveaway.status === "closed") {
    await sendChatMessage(`@${display} that giveaway already has a winner — use !giveaway reroll to draw again.`, broadcasterId);
    return true;
  }
  const winner = await drawGiveawayWinner(broadcasterId);
  if (!winner) {
    await sendChatMessage(
      reroll
        ? `@${display} nobody else is left in the pool to reroll.`
        : `@${display} nobody entered "${giveaway.prize}" — it stays open. !giveaway cancel to call it off.`,
      broadcasterId,
    );
    return true;
  }
  await sendChatMessage(pick(GIVEAWAY_WINNER_LINES)(winner.displayName, giveaway.prize), broadcasterId);
  return true;
}

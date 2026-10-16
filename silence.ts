// !silence @user — pay SILENCE_COST from your purse to have the bot time
// someone out for SILENCE_SECONDS. The coin is taken up front (atomically,
// so two !silence at once can't overspend) and refunded if Twitch refuses
// the timeout — the target is a mod, already banned, or the channel hasn't
// granted the ban scope (the same token and scope auto-ban uses; see
// autoban.ts getBanToken).
//
// Needs the gold system on (isPointsEnabled); silent no-op otherwise, like
// !bribe and !rob. Dashboard switch: silence ("Silencing (!silence)").

import { getBanToken } from "./autoban.ts";
import { COPPER_PER_GOLD, formatCoins } from "./coins.ts";
import { recordMonitorEvent } from "./db.ts";
import { adjustBalance, getBalance, isPointsEnabled, trySpend } from "./points_db.ts";
import { banChatUser, getUserIdByLogin, sendChatMessage } from "./twitch.ts";
import { pick } from "./utils.ts";

/** Price of one silence, in copper (50 gp). */
export const SILENCE_COST = 50 * COPPER_PER_GOLD;
/** How long the target is timed out. */
export const SILENCE_SECONDS = 5 * 60;

const SILENCE_LINES: Array<(name: string, target: string, cost: string) => string> = [
  (n, t, c) => `🤐 @${n} pays a hedge wizard ${c} to cast Silence on @${t}. Not a peep for 5 minutes.`,
  (n, t, c) => `🤐 @${n} slips the bard ${c} to drown out @${t} with a lute solo. @${t} is muted for 5 minutes.`,
  (n, t, c) => `🤐 For ${c}, the tavern keeper stuffs a rag in @${t}'s mouth on @${n}'s behalf. Back in 5 minutes.`,
  (n, t, c) => `🤐 @${n} hires a mime for ${c}. The mime traps @${t} in an invisible box for 5 minutes.`,
];

/** Handles !silence @user. Returns true if the message matched. */
export async function handleSilenceCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!silence(?:\s+@?(\S+))?/i);
  if (!m) return false;
  if (!(await isPointsEnabled(broadcasterId))) return true;
  const say = (text: string) => sendChatMessage(`@${display} ${text}`, broadcasterId);
  const cost = formatCoins(SILENCE_COST);

  const target = (m[1] ?? "").toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(target)) {
    await say(`usage: !silence @user — pay ${cost} to time someone out for 5 minutes.`);
    return true;
  }
  if (target === chatter.toLowerCase()) {
    await say("you can just stop typing, you know. No charge.");
    return true;
  }

  const balance = (await getBalance(broadcasterId, chatter))?.balance ?? 0;
  if (balance < SILENCE_COST) {
    await say(`a silence costs ${cost} — you only have ${formatCoins(balance)}.`);
    return true;
  }

  const targetId = await getUserIdByLogin(target);
  if (!targetId) {
    await say(`I can't find anyone called ${target}.`);
    return true;
  }
  if (targetId === broadcasterId) {
    await say("nobody silences the streamer. Nice try.");
    return true;
  }

  const auth = await getBanToken(broadcasterId);
  if ("problem" in auth) {
    await say("I'm not allowed to time people out here yet — the broadcaster needs to reconnect the bot and grant ban permission. No coin taken.");
    return true;
  }

  if (!(await trySpend(broadcasterId, chatter, SILENCE_COST))) {
    await say(`a silence costs ${cost} and your purse is short.`);
    return true;
  }

  const result = await banChatUser(auth.token, broadcasterId, broadcasterId, targetId, `Silenced by ${display} for ${cost} (!silence)`, SILENCE_SECONDS);
  if (!result.ok) {
    await adjustBalance(broadcasterId, chatter, display, SILENCE_COST);
    await recordMonitorEvent("silence_failed", `${broadcasterId}: ${target} — ${result.status} ${result.message}`);
    await say(`the spell fizzled — @${target} can't be silenced (mods and the already-banned are immune). Your ${cost} is refunded.`);
    return true;
  }

  const left = (await getBalance(broadcasterId, chatter))?.balance ?? 0;
  await sendChatMessage(`${pick(SILENCE_LINES)(display, target, cost)} (${formatCoins(left)} left)`, broadcasterId);
  return true;
}

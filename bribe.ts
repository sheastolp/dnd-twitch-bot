// !bribe [anything] — offer someone a bribe. It never works. Whoever you
// bribe (guard, peddler, the DM, the streamer…) pockets a large share of
// your purse — BRIBE_MIN_PCT to BRIBE_MAX_PCT of it — and laughs at you.
// You get nothing for it. The coin is simply gone.
//
// Needs the gold system on (isPointsEnabled); silent no-op otherwise, like
// !rob and !gold. A chatter with an empty purse is mocked for that instead.
// Dashboard switch: bribe ("Bribing (!bribe)").

import { formatCoins } from "./coins.ts";
import { adjustBalance, getBalance, isPointsEnabled } from "./points_db.ts";
import { sendChatMessage } from "./twitch.ts";
import { pick } from "./utils.ts";

/** Share of the purse a bribe takes, in percent. */
const BRIBE_MIN_PCT = 50;
const BRIBE_MAX_PCT = 90;

const BRIBE_LINES: Array<(name: string, amount: string, target: string) => string> = [
  (n, a, t) => `💰 @${n} slides ${a} to ${t}. ${t} bites the coin, pockets it, and walks off whistling. That's it. That's the whole deal.`,
  (n, a, t) => `💰 ${t} accepts @${n}'s ${a} with a warm smile… then forgets they ever met. Bribery: 0, @${n}: also 0.`,
  (n, a, t) => `💰 @${n} offers ${a} to ${t}. "How generous!" ${t} says, and does absolutely nothing in return.`,
  (n, a, t) => `💰 ${t} counts @${n}'s ${a} twice, laughs so hard they cry, and buys the whole tavern a round. @${n} isn't invited.`,
  (n, a, t) => `💰 @${n} tries to bribe ${t} with ${a}. ${t} takes it "as a processing fee". Your request has been processed. Denied.`,
  (n, a, t) => `💰 ${a} vanishes from @${n}'s purse into ${t}'s pocket. Somewhere a bard is already writing a song about how gullible @${n} is.`,
  (n, a, t) => `💰 @${n} whispers "for your trouble" and hands ${t} ${a}. ${t}: "What trouble?" and leaves. Nobody is surprised but @${n}.`,
  (n, a, t) => `💰 ${t} pats @${n} on the head, takes ${a}, and says "maybe next time, champ." There is no next time. There's never a next time.`,
];

const BROKE_LINES: Array<(name: string, target: string) => string> = [
  (n, t) => `🪙 @${n} tries to bribe ${t} with an empty purse. ${t} drops a copper in it out of pity, then takes it back.`,
  (n, t) => `🪙 @${n} offers ${t} a bribe of… lint. ${t} is insulted on a spiritual level.`,
  (n, t) => `🪙 @${n} pats their pockets for a bribe and finds nothing but moths. ${t} laughs them out of the room.`,
];

const DEFAULT_TARGETS = ["the town guard", "the guard captain", "the dungeon master", "a suspiciously friendly goblin", "the tax collector"];

/** Handles !bribe [target]. Returns true if the message matched. */
export async function handleBribeCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!bribe(?:\s+(.*))?$/i);
  if (!m) return false;
  if (!(await isPointsEnabled(broadcasterId))) return true;

  const target = cleanTarget(m[1]) || pick(DEFAULT_TARGETS);
  const purse = await getBalance(broadcasterId, chatter);
  const balance = purse?.balance ?? 0;
  if (balance <= 0) {
    await sendChatMessage(pick(BROKE_LINES)(display, target), broadcasterId);
    return true;
  }

  const pct = BRIBE_MIN_PCT + Math.random() * (BRIBE_MAX_PCT - BRIBE_MIN_PCT);
  const taken = Math.max(1, Math.floor((balance * pct) / 100));
  const left = await adjustBalance(broadcasterId, chatter, display, -taken);
  await sendChatMessage(
    `${pick(BRIBE_LINES)(display, formatCoins(taken), target)} (${formatCoins(left)} left)`,
    broadcasterId,
  );
  return true;
}

/** "the guard with 5gp please" -> "the guard"; "@user" -> "@user". Keeps it short and chat-safe. */
function cleanTarget(raw: string | undefined): string {
  const t = (raw ?? "")
    .replace(/\s+(?:with|for)\s+.*$/i, "")
    .replace(/[^\p{L}\p{N}@_' -]/gu, "")
    .trim()
    .slice(0, 40)
    .trim();
  return t;
}

// !oracle <question> — like !roll's fate verdict (see utils.ts rollFate),
// but instead of a YES/NO the "answer" is a randomly-chosen recent chatter.
//
//   !oracle <question>   anyone — e.g. !oracle who should stream next?
//
// The chatter pool comes from activity_logs (people who've used a bot
// command recently in this channel — see getRecentChatters in db.ts), not a
// live Twitch chatters-list call, so this needs no new OAuth scope and no
// re-auth for existing connected channels.

import { sendChatMessage } from "./twitch.ts";
import { getRecentChatters } from "./db.ts";
import { rollOracle } from "./utils.ts";

const MIN_QUESTION_LEN = 2;

export async function handleOracleCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const match = chatMessage.match(/^!oracle(?:\s+([\s\S]+))?$/i);
  if (!match) return false;

  const question = (match[1] ?? "").trim();
  if (question.length < MIN_QUESTION_LEN) {
    await sendChatMessage(`@${display} ask the oracle something, e.g. !oracle who should stream next?`, broadcasterId);
    return true;
  }

  // Recently-active chatters, most-recent first; the asker themselves is a
  // fair pick too (they're part of "recent chatters"), so no self-exclusion.
  // A DB hiccup here falls back to the asker rather than going silent — a
  // Twitch command should always say *something* back.
  let pool: string[] = [];
  try {
    pool = await getRecentChatters(broadcasterId, 50);
  } catch (e) {
    console.error("getRecentChatters failed", e);
    pool = [chatter];
  }
  if (pool.length === 0) {
    await sendChatMessage(
      `@${display} the oracle is silent — no chatters have stirred yet in this channel.`,
      broadcasterId,
    );
    return true;
  }

  const chosen = pool[Math.floor(Math.random() * pool.length)];
  await sendChatMessage(`@${display} ${rollOracle(question, chosen)}`, broadcasterId);
  return true;
}

// !nick — battle-log nicknames (see "Short names for battle logs" in mentions.ts).
//
//   !nick @user <nickname>   (mod/broadcaster) set how battle logs name them
//   !nick remove @user       (mod/broadcaster) go back to the automatic short name
//   !nick list               (everyone) every nickname set in this channel
//   !nick                    (everyone) your own nickname, if one is set
//
// A nickname is 2-12 letters, digits, "_" or "-", no spaces. It only affects
// bare names inside battle logs; "@name" tags are untouched.

import { listNicknames, lookupNicknames, removeNickname, setNickname } from "./mentions.ts";
import { sendChatMessage } from "./twitch.ts";

const COMMAND_RE = /^!nick(?:\s+(.*))?$/i;
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const NICK_RE = /^[\p{L}\p{N}_-]{2,12}$/u;
const MAX_LISTED = 12;

export async function handleNickCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const m = chatMessage.trim().match(COMMAND_RE);
  if (!m) return false;
  const say = (text: string) => sendChatMessage(`@${display} ${text}`, broadcasterId);
  const args = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const usage = "usage: !nick @user <nickname> | !nick remove @user | !nick list (setting and removing are mod-only)";

  try {
    if (!args.length) {
      const mine = (await lookupNicknames(broadcasterId, [chatter])).get(chatter.toLowerCase());
      await say(mine ? `battle logs call you ${mine}.` : "no nickname is set for you — the scribes shorten your name on their own. A mod can set one with !nick @you <nickname>.");
      return true;
    }

    if (args[0].toLowerCase() === "list") {
      const all = await listNicknames(broadcasterId);
      if (!all.length) {
        await say("no battle-log nicknames are set in this channel.");
      } else {
        const shown = all.slice(0, MAX_LISTED).map((n) => `${n.username} → ${n.nickname}`).join(", ");
        await say(`battle-log nicknames: ${shown}${all.length > MAX_LISTED ? ` …and ${all.length - MAX_LISTED} more` : ""}`);
      }
      return true;
    }

    if (!isModerator) {
      await say("only the broadcaster or a moderator can set battle-log nicknames.");
      return true;
    }

    const isRemove = /^(remove|clear|reset|delete)$/i.test(args[0]);
    const target = (isRemove ? args[1] ?? "" : args[0]).replace(/^@/, "").toLowerCase();
    if (!target || !LOGIN_RE.test(target)) {
      await say(usage);
      return true;
    }

    if (isRemove) {
      await say((await removeNickname(broadcasterId, target)) ? `${target}'s nickname is gone — battle logs will shorten their name automatically.` : `${target} has no nickname set.`);
      return true;
    }

    const nick = args[1] ?? "";
    if (!NICK_RE.test(nick) || args.length > 2) {
      await say(`a nickname must be one word of 2-12 letters or digits. ${usage}`);
      return true;
    }
    await setNickname(broadcasterId, target, nick);
    await say(`battle logs will now call ${target} "${nick}".`);
  } catch (e) {
    console.error("!nick failed", e);
    await say("the scribes dropped their quills — try !nick again in a moment.");
  }
  return true;
}

// !nick — viewer nicknames. Every viewer is given a fantasy nickname the
// first time they chat (ensureNickname in mentions.ts); the bot's chat
// replies call them by it instead of their name.
//
//   !nick @user <nickname>   (mod/broadcaster) choose their nickname
//   !nick remove @user       (mod/broadcaster) drop it; they get a fresh random one
//   !nick list               (everyone) every nickname in this channel
//   !nick                    (everyone) your own nickname
//
// A nickname is 2-12 letters, digits, "_" or "-", no spaces. "@name" tags
// keep the real name so they still ping.

import { ensureNickname, listNicknames, removeNickname, setNickname } from "./mentions.ts";
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
  const say = (text: string, keepNames = false) => sendChatMessage(`@${display} ${text}`, broadcasterId, [], { keepNames });
  const args = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const usage = "usage: !nick @user <nickname> | !nick remove @user | !nick list (setting and removing are mod-only)";

  try {
    if (!args.length) {
      await say(`the scribes call you ${await ensureNickname(broadcasterId, chatter)}. A mod can change it with !nick @you <nickname>.`);
      return true;
    }

    if (args[0].toLowerCase() === "list") {
      const all = await listNicknames(broadcasterId);
      if (!all.length) {
        await say("no nicknames are set in this channel yet.");
      } else {
        const shown = all.slice(0, MAX_LISTED).map((n) => `${n.username} → ${n.nickname}`).join(", ");
        await say(`nicknames: ${shown}${all.length > MAX_LISTED ? ` …and ${all.length - MAX_LISTED} more` : ""}`, true);
      }
      return true;
    }

    if (!isModerator) {
      await say("only the broadcaster or a moderator can set nicknames.");
      return true;
    }

    const isRemove = /^(remove|clear|reset|delete)$/i.test(args[0]);
    const target = (isRemove ? args[1] ?? "" : args[0]).replace(/^@/, "").toLowerCase();
    if (!target || !LOGIN_RE.test(target)) {
      await say(usage);
      return true;
    }

    if (isRemove) {
      await say((await removeNickname(broadcasterId, target)) ? `@${target}'s nickname is gone — the scribes will give them a new one.` : `@${target} has no nickname set.`);
      return true;
    }

    const nick = args[1] ?? "";
    if (!NICK_RE.test(nick) || args.length > 2) {
      await say(`a nickname must be one word of 2-12 letters or digits. ${usage}`);
      return true;
    }
    await setNickname(broadcasterId, target, nick);
    await say(`the scribes will now call @${target} "${nick}".`);
  } catch (e) {
    console.error("!nick failed", e);
    await say("the scribes dropped their quills — try !nick again in a moment.");
  }
  return true;
}

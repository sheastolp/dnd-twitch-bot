// !nick — viewer nicknames. Every viewer is given a fantasy nickname the
// first time they chat (ensureNickname in mentions.ts); the bot's chat
// replies call them by it instead of their name.
//
//   !nick <nickname>         (everyone) choose your own nickname
//   !nick remove             (everyone) drop yours; you get a fresh random one
//   !nick @user <nickname>   (mod/broadcaster) choose someone else's nickname
//   !nick remove @user       (mod/broadcaster) drop theirs
//   !nick list               (everyone) every nickname in this channel
//   !nick                    (everyone) your own nickname
//
// A nickname is 2-12 letters, digits, "_" or "-", no spaces, and can't be
// someone else's nickname or name. "@name" tags keep the real name so they
// still ping.

import { ensureNickname, getChannelNicknames, listNicknames, removeNickname, setNickname } from "./mentions.ts";
import { sendChatMessage } from "./twitch.ts";

const COMMAND_RE = /^!nick(?:\s+(.*))?$/i;
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const NICK_RE = /^[\p{L}\p{N}_-]{2,12}$/u;
const MAX_LISTED = 12;

/** True if `nick` is already another viewer's nickname or login in this channel. */
async function nickTaken(broadcasterId: string, target: string, nick: string): Promise<boolean> {
  const wanted = nick.toLowerCase();
  for (const [login, other] of await getChannelNicknames(broadcasterId)) {
    if (login === target) continue;
    if (login === wanted || other.toLowerCase() === wanted) return true;
  }
  return false;
}

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
  const usage = "usage: !nick <nickname> | !nick remove | !nick list (mods: !nick @user <nickname> | !nick remove @user)";
  const self = chatter.toLowerCase();

  try {
    if (!args.length) {
      await say(`the scribes call you ${await ensureNickname(broadcasterId, chatter)}. Pick your own with !nick <nickname>.`);
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

    // "!nick <nickname>" and "!nick remove" (no @user) are about the chatter.
    const isRemove = /^(remove|clear|reset|delete)$/i.test(args[0]);
    const named = isRemove ? args[1] : args[0].startsWith("@") ? args[0] : undefined;
    const target = named === undefined ? self : named.replace(/^@/, "").toLowerCase();
    const nick = isRemove ? "" : named === undefined ? args[0] : args[1] ?? "";
    const extra = args.length > (isRemove || named !== undefined ? 2 : 1);
    if (!target || !LOGIN_RE.test(target) || (isRemove && extra)) {
      await say(usage);
      return true;
    }

    if (target !== self && !isModerator) {
      await say("only the broadcaster or a moderator can change someone else's nickname. Pick your own with !nick <nickname>.");
      return true;
    }

    if (isRemove) {
      if (target === self) {
        await removeNickname(broadcasterId, target);
        await say(`the scribes have a fresh name for you: ${await ensureNickname(broadcasterId, chatter)}.`);
      } else {
        await say((await removeNickname(broadcasterId, target)) ? `@${target}'s nickname is gone — the scribes will give them a new one.` : `@${target} has no nickname set.`);
      }
      return true;
    }

    if (!NICK_RE.test(nick) || extra) {
      await say(`a nickname must be one word of 2-12 letters or digits. ${usage}`);
      return true;
    }
    if (await nickTaken(broadcasterId, target, nick)) {
      await say(`"${nick}" is already taken by another adventurer — pick something else.`);
      return true;
    }
    await setNickname(broadcasterId, target, nick);
    await say(target === self ? `the scribes will now call you "${nick}".` : `the scribes will now call @${target} "${nick}".`);
  } catch (e) {
    console.error("!nick failed", e);
    await say("the scribes dropped their quills — try !nick again in a moment.");
  }
  return true;
}

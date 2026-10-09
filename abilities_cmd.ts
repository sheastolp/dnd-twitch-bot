// !abilities [@user] — what a saved character can do in a fight: their
// attack numbers, every class ability and racial trait from
// combat_abilities.ts (with uses per fight), and the next ability they
// unlock by levelling. Read-only. Dashboard switch: charcreate
// ("Create and view", with !char).

import { abilitySummary } from "./combat_abilities.ts";
import { getCharacter } from "./db.ts";
import { sendChatMessages } from "./twitch.ts";
import { formatRaceName } from "./utils.ts";

/** Handles !abilities [@user]. Returns true if the message matched. */
export async function handleAbilitiesCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!abilities(?:\s+@?(\S+))?\s*$/i);
  if (!m) return false;
  const target = m[1] ? m[1].toLowerCase().replace(/[,:]+$/, "") : chatter;
  const self = target === chatter;
  const c = await getCharacter(target, broadcasterId);
  if (!c) {
    await sendChatMessages(
      self ? `@${display} you don't have a character yet — !createchar or !newchar to make one.` : `@${display} @${target} doesn't have a character in this channel.`,
      broadcasterId,
    );
    return true;
  }
  const s = abilitySummary(c);
  const who = self ? "your" : `@${target}'s`;
  await sendChatMessages(
    `⚔️ @${display} ${who} Lv ${c.level} ${formatRaceName(c.race, c.subrace)} ${c.cls}: ${s.attack}. ` +
      `Abilities: ${s.abilities.length ? s.abilities.join(" · ") : "none yet"}.` +
      (s.next ? ` Next: ${s.next}.` : ""),
    broadcasterId,
  );
  return true;
}

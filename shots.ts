// The shot counter — how many shots (the drinking kind) the streamer has
// taken this stream. Mods pour, everyone can look, and the OBS "Shots taken"
// overlay (overlay.ts, panel=shots) shows the running count.
//
//   !shot                 add one shot (mod/broadcaster)
//   !shot +N / !shot -N   add or take away N (mod)
//   !shot undo            take the last one back (mod)
//   !shot set N           set the count (mod)
//   !shot reset           back to 0 (mod)
//   !shots                this stream's count (anyone)
//
// A non-mod's !shot just answers with the count, so viewers can't pad it.
// The count starts over at 0 whenever a new stream goes live
// (stream_status.ts), but not on a reconnect inside the grace period.
// Off until the "shots" switch is turned on (dashboard Quick setup or
// Command groups). What's counted — "shot" by default, or e.g. "drink" or
// "sip" — is the shots.word option, set only on the dashboard (Quick setup →
// Shot counter → ⚙ Options), and the commands follow it: "drink" makes them
// !drink / !drinks, and !shot / !shots then fall through like any unknown
// word. Because the words can change, this module checks its own switch
// (the group lists no command words), and a channel's own custom command of
// the same name wins, as with !sound. The dashboard refuses a word that
// would clash with a built-in command (shotWordProblem).

import { sqlite } from "./sqlite.ts";
import { sendChatMessage } from "./twitch.ts";
import { pick } from "./utils.ts";
import { optWord } from "./channel_options.ts";
import { getCustomCommand } from "./db_custom.ts";
import { isCommandGroupEnabled } from "./db.ts";
import { COMMAND_GROUPS } from "./commandgroups.ts";
import { RESERVED_NAMES } from "./customcommands.ts";

export const MAX_SHOTS = 999;

export async function ensureShotTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS shot_counter (
      broadcaster_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    )`,
  );
}

export async function getShotCount(broadcasterId: string): Promise<number> {
  const res = await sqlite.execute("SELECT count FROM shot_counter WHERE broadcaster_id = ?", [broadcasterId]);
  return Number(res.rows[0]?.count ?? 0);
}

/** Adds `delta` (negative to take away), kept within 0..MAX_SHOTS. Returns the new count. */
export async function adjustShots(broadcasterId: string, delta: number): Promise<number> {
  await sqlite.execute(
    `INSERT INTO shot_counter (broadcaster_id, count, updated_at)
     VALUES (?, MIN(?, MAX(0, ?)), ?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET
       count = MIN(?, MAX(0, count + ?)),
       updated_at = excluded.updated_at`,
    [broadcasterId, MAX_SHOTS, delta, Date.now(), MAX_SHOTS, delta],
  );
  return getShotCount(broadcasterId);
}

export async function setShots(broadcasterId: string, count: number): Promise<number> {
  const n = Math.min(MAX_SHOTS, Math.max(0, Math.floor(count)));
  await sqlite.execute(
    `INSERT INTO shot_counter (broadcaster_id, count, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`,
    [broadcasterId, n, Date.now()],
  );
  return n;
}

/** stream.online (stream_status.ts): a new stream starts at 0. */
export async function resetShotsForNewStream(broadcasterId: string): Promise<void> {
  await setShots(broadcasterId, 0).catch(() => {});
}

export async function purgeShotData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM shot_counter WHERE broadcaster_id = ?", [broadcasterId]);
}

/** "shot" → "shots", "glass" → "glasses", "whiskey" → "whiskeys", "brandy" → "brandies". */
export function pluralWord(word: string): string {
  if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

// Built-in command words not already in RESERVED_NAMES or a COMMAND_GROUPS
// entry (modules that check their own switch, steward tools, …). A counted
// word or its plural can't be any of these.
const OTHER_BUILT_INS = [
  "jar", "fine", "hunt", "ledger", "bounties", "quests", "shop", "merchant", "buy", "inv", "sell", "drop", "purse", "hoard",
  "sound", "sounds", "quote", "quotes", "so", "shoutout", "chatreader", "overlays", "rally", "npc", "chronicle", "market",
  "haggle", "gear", "ball", "pokecatch", "automod", "permit", "boon", "botcheck", "hateraid", "followbots", "removebots",
  "onlinenotif", "onlinecheck", "offlinelock", "raidguard", "shield", "monster", "clip", "stats", "delve", "dndbot",
];

/** Why a word can't be the counted word (dashboard check), or null if it's fine. */
export function shotWordProblem(word: string): string | null {
  for (const w of [word, pluralWord(word)]) {
    if (RESERVED_NAMES.has(w) || OTHER_BUILT_INS.includes(w) || Object.values(COMMAND_GROUPS).some((g) => g.commands.includes(w))) {
      return `!${w} is already a GuildScribe command — pick another word.`;
    }
  }
  return null;
}

/** The channel's counted word (shots.word), singular and plural. */
export async function shotWords(broadcasterId: string): Promise<{ one: string; many: string }> {
  const one = await optWord(broadcasterId, "shots.word");
  return { one, many: pluralWord(one) };
}

type Words = { one: string; many: string };
const count = (n: number, w: Words) => `${n} ${n === 1 ? w.one : w.many}`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const POUR_LINES = [
  (n: number, w: Words) => `🥃 Down the hatch! That's ${count(n, w)} this stream.`,
  (n: number, w: Words) => `🥃 The barkeep pours another — ${count(n, w)} and counting.`,
  (n: number, w: Words) => `🥃 Bottoms up! ${capital(w.one)} #${n} of the night.`,
  (n: number, w: Words) => `🥃 A toast to the guild! ${count(n, w)} so far.`,
];

/** Handles !shot / !shots; returns true when the message was one of them. */
export async function handleShotCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!([a-z0-9]{2,25})(?:\s+(.*))?$/i);
  if (!m) return false;
  const word = m[1].toLowerCase();
  const w = await shotWords(broadcasterId);
  if (word !== w.one && word !== w.many) return false;
  // Switched off, or the channel has its own command of that name: fall through to it.
  const [on, custom] = await Promise.all([
    isCommandGroupEnabled(broadcasterId, "shots"),
    getCustomCommand(broadcasterId, word),
  ]);
  if (!on || custom) return false;
  const arg = (m[2] ?? "").trim().toLowerCase();

  if (word === w.many || !isModerator) {
    const n = await getShotCount(broadcasterId);
    const tail = word === w.one && !isModerator ? ` (only the broadcaster or a moderator can add a ${w.one})` : "";
    await sendChatMessage(`@${display} 🥃 ${count(n, w)} taken this stream.${tail}`, broadcasterId);
    return true;
  }

  if (!arg) {
    await sendChatMessage(pick(POUR_LINES)(await adjustShots(broadcasterId, 1), w), broadcasterId);
    return true;
  }
  if (arg === "undo") {
    const n = await adjustShots(broadcasterId, -1);
    await sendChatMessage(`@${display} 🥃 Took one back — ${count(n, w)} this stream.`, broadcasterId);
    return true;
  }
  if (arg === "reset") {
    await setShots(broadcasterId, 0);
    await sendChatMessage(`@${display} 🥃 ${capital(w.one)} counter reset to 0.`, broadcasterId);
    return true;
  }
  const delta = arg.match(/^([+-])\s*(\d{1,3})$/);
  if (delta) {
    const n = await adjustShots(broadcasterId, (delta[1] === "-" ? -1 : 1) * Number(delta[2]));
    await sendChatMessage(`@${display} 🥃 ${count(n, w)} this stream.`, broadcasterId);
    return true;
  }
  const set = arg.match(/^set\s+(\d{1,3})$/);
  if (set) {
    const n = await setShots(broadcasterId, Number(set[1]));
    await sendChatMessage(`@${display} 🥃 ${capital(w.one)} counter set to ${n}.`, broadcasterId);
    return true;
  }
  const c = `!${w.one}`;
  await sendChatMessage(`@${display} usage: ${c} | ${c} +N / -N | ${c} undo | ${c} set N | ${c} reset | !${w.many}`, broadcasterId);
  return true;
}

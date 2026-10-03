// The Swear Jar.
//
// A per-channel jar of coin. Chatters who swear pay into it automatically, and
// anyone can check (or tweak) the total with !jar. The jar uses the same
// currency as the gold system (see coins.ts): every amount here is an integer
// number of COPPER, shown as "1 gp 2 sp 3 cp".
//
//   !jar                 what's in the jar
//   !jar +<amount>       add to the jar by hand (anyone)        e.g. !jar +8, !jar +5sp
//   !jar +<amount> @user fine someone (mod only): moves that much of THEIR
//                        gold into the jar (whatever they can afford)
//   !jar -<amount>       take from the jar by hand (mod only)   e.g. !jar -8
//
// !jar deliberately has NO cooldown (main.ts exempts it from the per-user
// command rate limit).
//
// Auto-collection: maybeChargeSwearJar() is called by main.ts for every plain
// (non-"!") chat message. Each swear word costs the chatter SWEAR_COST_COPPER
// (2 cp by default) out of their gold balance, moved into the jar, and the bot
// announces it. If the chatter can't afford the full fee they pay whatever
// they have; a chatter with an empty purse pays nothing (and the bot stays
// quiet rather than spamming chat). Needs the gold system on (!gold on).
//
// Detection is word-based (see countSwearWords), so innocent words that
// merely contain a swear ("class", "assassin", "Scunthorpe") are never hit.
// Edit SWEAR_BASES below to tune the list (it includes UK/Irish slang such as
// "bloody", "bugger", "wanker" and "bollocks" — delete any you don't want charged).

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { sendChatMessage } from "./twitch.ts";
import { pick } from "./utils.ts";
import { formatCoins, MAX_COPPER, parseCoins } from "./coins.ts";
import { getBalance, isPointsEnabled, trySpend } from "./points_db.ts";

/** Copper charged per swear word. */
export const SWEAR_COST_COPPER = Math.min(
  1000,
  Math.max(1, Math.floor(Number(Deno.env.get("SWEAR_COST_COPPER") ?? "2")) || 2),
);

/** At most this many swear words are charged per message, so one rant can't
 * drain someone's whole purse. */
export const MAX_SWEARS_PER_MESSAGE = 5;

// ── Persistence ──

export async function ensureSwearJarTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS swear_jar (
      broadcaster_id TEXT PRIMARY KEY,
      total INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    )`,
  );
}

export async function getJarTotal(broadcasterId: string): Promise<number> {
  const res = await sqlite.execute("SELECT total FROM swear_jar WHERE broadcaster_id = ?", [broadcasterId]);
  return Number(res.rows[0]?.total ?? 0);
}

/** Adds (or, with a negative delta, removes) copper. The jar never goes below
 * 0 or above MAX_COPPER. Returns the new total. */
export async function adjustJar(broadcasterId: string, delta: number): Promise<number> {
  await sqlite.execute(
    `INSERT INTO swear_jar (broadcaster_id, total, updated_at)
     VALUES (?, MIN(?, MAX(0, ?)), ?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET
       total = MIN(?, MAX(0, total + ?)),
       updated_at = excluded.updated_at`,
    [broadcasterId, MAX_COPPER, delta, Date.now(), MAX_COPPER, delta],
  );
  return await getJarTotal(broadcasterId);
}

/** `!dndbot leave purge`: forget the channel's jar. */
export async function purgeSwearJarData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM swear_jar WHERE broadcaster_id = ?", [broadcasterId]);
}

// ── Detection ──

// Base words. Matching is on whole words only, with the optional prefixes and
// suffixes below, so "shit" also catches "shits", "shitty", "bullshit",
// "shithead" and "dipshit", but not "shiitake".
const SWEAR_BASES = [
  "fuck", "shit", "bitch", "bastard", "asshole", "ass", "arse", "arsehole", "dick", "cunt", "piss",
  "damn", "dammit", "damnit", "whore", "slut", "prick", "twat", "wanker", "bollocks", "douche",
  "douchebag", "pussy", "motherfucker", "fuk", "fck", "fack",
  // UK / Irish slang
  "bloody", "bugger", "sod", "sodding", "shite", "gobshite", "bollock", "bollox", "wank", "tosser", "tosspot",
  "knobhead", "knobend", "bellend", "arsewipe", "pillock", "plonker", "wazzock", "minger", "minging", "munter",
  "berk", "feck", "feckin", "spaff",
];
const SWEAR_PREFIXES = ["mother", "bull", "dumb", "jack", "god", "bat", "ape", "horse", "chicken", "dip"];
const SWEAR_SUFFIXES = [
  "s", "es", "ed", "er", "ers", "ing", "in", "y", "ty", "head", "heads", "hole", "holes", "face", "faces",
  "wit", "wits", "it", "ery",
];

const SWEAR_RE = new RegExp(
  `^(?:${SWEAR_PREFIXES.join("|")})?(?:${SWEAR_BASES.join("|")})(?:${SWEAR_SUFFIXES.join("|")})?$`,
);

// Common letter swaps people use to dodge filters: sh1t, f@ck, $hit, a$$.
const LEET: Record<string, string> = { "@": "a", "$": "s", "0": "o", "1": "i", "3": "e", "5": "s" };

function normalizeToken(token: string): string {
  // Leave pure numbers alone ("100"), only de-leet tokens containing a letter.
  if (!/[a-z]/.test(token)) return "";
  return token.replace(/[@$0135]/g, (c) => LEET[c] ?? c).replace(/[^a-z]/g, "");
}

function isSwear(word: string): boolean {
  if (!word) return false;
  if (SWEAR_RE.test(word)) return true;
  // Stretched-out versions: "fuuuuck" -> "fuck", "assss" -> "ass".
  const squeezed2 = word.replace(/(.)\1{2,}/g, "$1$1");
  if (squeezed2 !== word && SWEAR_RE.test(squeezed2)) return true;
  const squeezed1 = word.replace(/(.)\1{2,}/g, "$1");
  return squeezed1 !== word && SWEAR_RE.test(squeezed1);
}

/** How many swear words a chat message contains (uncapped). */
export function countSwearWords(message: string): number {
  let count = 0;
  for (const raw of message.toLowerCase().split(/[^a-z0-9@$]+/)) {
    if (isSwear(normalizeToken(raw))) count++;
  }
  return count;
}

// ── Auto-collection (called by main.ts for plain chat) ──

const PAID_LINES: Array<(name: string, paid: string, jar: string) => string> = [
  (n, p, j) => `🫙 @${n} had to pay the swear jar ${p}! The jar now holds ${j}.`,
  (n, p, j) => `🫙 Foul tongue detected! @${n} drops ${p} into the swear jar (jar: ${j}).`,
  (n, p, j) => `🫙 The guild's swear jar jingles — @${n} pays ${p}. Total: ${j}.`,
  (n, p, j) => `🫙 @${n} cursed in the guild hall and pays ${p} to the swear jar. It holds ${j} now.`,
  (n, p, j) => `🫙 Mind your tongue, @${n}! That's ${p} into the swear jar (jar: ${j}).`,
];

/** Charges the chatter if their message contains swear words. Safe to call for
 * every plain, non-bot chat message: silent no-op when the gold system is off,
 * there's no swearing, or the chatter has no coin. Returns true if coin moved. */
export async function maybeChargeSwearJar(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const swears = Math.min(MAX_SWEARS_PER_MESSAGE, countSwearWords(chatMessage));
  if (swears === 0) return false;
  if (!(await isPointsEnabled(broadcasterId))) return false;

  const owed = swears * SWEAR_COST_COPPER;
  const bal = await getBalance(broadcasterId, chatter);
  const pay = Math.min(owed, bal?.balance ?? 0);
  if (pay <= 0) return false;
  // trySpend is atomic (only succeeds if they still have it), so two rapid
  // messages can't take the same copper twice.
  if (!(await trySpend(broadcasterId, chatter, pay))) return false;

  const total = await adjustJar(broadcasterId, pay);
  await sendChatMessage(pick(PAID_LINES)(display, formatCoins(pay), formatCoins(total)), broadcasterId);
  return true;
}

// ── !jar command ──

/** Handles !jar. Returns true if it consumed the message. */
export async function handleJarCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!jar(?:\s+(.*))?$/i);
  if (!m) return false;
  const args = (m[1] ?? "").trim();

  if (!args) {
    const total = await getJarTotal(broadcasterId);
    await sendChatMessage(`🫙 @${display} The swear jar holds ${formatCoins(total)}.`, broadcasterId);
    return true;
  }

  const adj = args.match(/^([+-])\s*(.+)$/);
  // "+<amount> <target>": the amount may itself contain spaces ("1gp 2sp"), so
  // try the whole remainder as an amount first, then peel off a trailing name.
  let amount: number | null = null;
  let target: string | null = null;
  if (adj) {
    amount = parseCoins(adj[2]);
    if (amount === null && adj[1] === "+") {
      const t = adj[2].match(/^(.+?)\s+@?([a-z0-9_]{1,25})$/i);
      if (t) {
        amount = parseCoins(t[1]);
        if (amount !== null) target = t[2].toLowerCase();
      }
    }
  }
  if (!adj || amount === null || amount <= 0) {
    await sendChatMessage(
      `@${display} Usage: !jar (see the total) | !jar +8 (add 8 cp) | !jar +8 @user (mod: fine them 8 cp) | !jar -8 (mod only). Units work too: 5sp, 1gp.`,
      broadcasterId,
    );
    return true;
  }

  if (target) {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can fine someone into the swear jar.`, broadcasterId);
      return true;
    }
    const bal = await getBalance(broadcasterId, target);
    const pay = Math.min(amount, bal?.balance ?? 0);
    if (pay <= 0 || !(await trySpend(broadcasterId, target, pay))) {
      await sendChatMessage(`🫙 @${display} ${bal?.displayName ?? target} has no coin to put in the swear jar.`, broadcasterId);
      return true;
    }
    const total = await adjustJar(broadcasterId, pay);
    await sendChatMessage(
      `🫙 @${bal?.displayName ?? target} was fined ${formatCoins(pay)} for the swear jar by @${display}. It now holds ${formatCoins(total)}.`,
      broadcasterId,
    );
    return true;
  }

  if (adj[1] === "-") {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can take coin out of the swear jar.`, broadcasterId);
      return true;
    }
    const before = await getJarTotal(broadcasterId);
    const total = await adjustJar(broadcasterId, -amount);
    await sendChatMessage(
      `🫙 @${display} took ${formatCoins(before - total)} out of the swear jar. It now holds ${formatCoins(total)}.`,
      broadcasterId,
    );
    return true;
  }

  const total = await adjustJar(broadcasterId, amount);
  await sendChatMessage(
    `🫙 @${display} added ${formatCoins(amount)} to the swear jar. It now holds ${formatCoins(total)}.`,
    broadcasterId,
  );
  return true;
}

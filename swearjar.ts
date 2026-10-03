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
//   !jar giveaway        give the WHOLE jar to a random recent chatter (mod
//                        only, at most once every 7 days per channel)
//   !fine                fine the streamer one swear word (anyone)
//
// !jar and !fine deliberately have NO cooldown (main.ts exempts them from the
// per-user command rate limit).
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
import { adjustBalance, getBalance, isPointsEnabled, trySpend } from "./points_db.ts";
import { getBroadcaster } from "./db.ts";

/** Copper charged per swear word. */
export const SWEAR_COST_COPPER = Math.min(
  1000,
  Math.max(1, Math.floor(Number(Deno.env.get("SWEAR_COST_COPPER") ?? "2")) || 2),
);

/** At most this many swear words are charged per message, so one rant can't
 * drain someone's whole purse. */
export const MAX_SWEARS_PER_MESSAGE = 5;

/** The jar can be given away at most once per this long, per channel. */
export const GIVEAWAY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** Who can win a giveaway: anyone who has earned chat coin (i.e. chatted while
 * live) within this window. */
const GIVEAWAY_POOL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// ── Persistence ──

export async function ensureSwearJarTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS swear_jar (
      broadcaster_id TEXT PRIMARY KEY,
      total INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    )`,
  );
  // One row per channel: when the jar was last given away (drives the
  // once-per-7-days limit), to whom, and how much.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS swear_jar_giveaways (
      broadcaster_id TEXT PRIMARY KEY,
      last_at INTEGER NOT NULL DEFAULT 0,
      winner TEXT,
      amount INTEGER NOT NULL DEFAULT 0
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
  for (const table of ["swear_jar", "swear_jar_giveaways"]) {
    await sqlite.execute(`DELETE FROM ${table} WHERE broadcaster_id = ?`, [broadcasterId]);
  }
}

async function getLastGiveawayAt(broadcasterId: string): Promise<number> {
  const res = await sqlite.execute("SELECT last_at FROM swear_jar_giveaways WHERE broadcaster_id = ?", [broadcasterId]);
  return Number(res.rows[0]?.last_at ?? 0);
}

/** Atomically starts a giveaway: succeeds only if the last one was at least
 * GIVEAWAY_COOLDOWN_MS ago, so two mods typing the command at once can't both
 * pay out. Returns the previous timestamp on success (to restore if the
 * giveaway then can't complete), or null if it's still on cooldown. */
async function claimGiveaway(broadcasterId: string, winner: string, now: number): Promise<number | null> {
  await sqlite.execute("INSERT OR IGNORE INTO swear_jar_giveaways (broadcaster_id, last_at) VALUES (?, 0)", [broadcasterId]);
  const prev = await getLastGiveawayAt(broadcasterId);
  const res = await sqlite.execute(
    "UPDATE swear_jar_giveaways SET last_at = ?, winner = ?, amount = 0 WHERE broadcaster_id = ? AND last_at <= ?",
    [now, winner, broadcasterId, now - GIVEAWAY_COOLDOWN_MS],
  );
  const affected = (res as any).rowsAffected;
  if (typeof affected === "number") return affected > 0 ? prev : null;
  return (await getLastGiveawayAt(broadcasterId)) === now ? prev : null;
}

async function releaseGiveaway(broadcasterId: string, prev: number) {
  await sqlite.execute("UPDATE swear_jar_giveaways SET last_at = ?, winner = NULL, amount = 0 WHERE broadcaster_id = ?", [prev, broadcasterId]);
}

/** A random chatter from the last week (anyone who earned chat coin), never the
 * streamer. Null if nobody qualifies. */
async function pickGiveawayWinner(broadcasterId: string, excludeLogin: string): Promise<{ username: string; displayName: string } | null> {
  const res = await sqlite.execute(
    "SELECT username, display_name FROM points_balances WHERE broadcaster_id = ? AND last_earn_at >= ? AND username <> ?",
    [broadcasterId, Date.now() - GIVEAWAY_POOL_WINDOW_MS, excludeLogin.toLowerCase()],
  );
  if (!res.rows.length) return null;
  const row: any = res.rows[Math.floor(Math.random() * res.rows.length)];
  return { username: String(row.username), displayName: String(row.display_name || row.username) };
}

function formatWait(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
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
  "berk", "feck", "feckin",
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

const FINE_LINES: Array<(by: string, streamer: string, paid: string, jar: string) => string> = [
  (by, st, p, j) => `🫙 @${by} fined the streamer! ${st} pays ${p} into the swear jar (jar: ${j}).`,
  (by, st, p, j) => `🫙 The guild finds ${st} guilty on @${by}'s word — ${p} into the swear jar. It holds ${j} now.`,
  (by, st, p, j) => `🫙 @${by} caught ${st} with a foul tongue! ${p} goes in the jar (total: ${j}).`,
];

const GIVEAWAY_LINES: Array<(winner: string, amount: string, by: string) => string> = [
  (w, a, by) => `🎉 @${by} tips the swear jar upside down — @${w} wins ${a}!`,
  (w, a, by) => `🎉 The swear jar overflows! @${w} is awarded the whole ${a} (poured out by @${by}).`,
  (w, a, by) => `🎉 Fortune smiles on @${w}: the jar's entire ${a} is theirs!`,
];

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
  const m = chatMessage.trim().match(/^!(jar|fine)(?:\s+(.*))?$/i);
  if (!m) return false;
  const args = (m[2] ?? "").trim();

  if (m[1].toLowerCase() === "fine") return await handleFine(display, broadcasterId);

  if (/^giveaway$/i.test(args)) return await handleGiveaway(display, broadcasterId, isModerator);

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
      `@${display} Usage: !jar (see the total) | !jar +8 (add 8 cp) | !jar +8 @user (mod: fine them 8 cp) | !jar -8 (mod only) | !jar giveaway (mod only) | !fine (fine the streamer). Units work too: 5sp, 1gp.`,
      broadcasterId,
    );
    return true;
  }

  if (target) {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can fine someone into the swear jar.`, broadcasterId);
      return true;
    }
    if (!(await isPointsEnabled(broadcasterId))) return true; // moves gold: silent while gold is off
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

// ── !fine ──

/** Anyone can fine the streamer one swear word's worth (SWEAR_COST_COPPER) of
 * the streamer's gold into the jar. No cooldown. Silent while gold is off. */
async function handleFine(display: string, broadcasterId: string): Promise<boolean> {
  if (!(await isPointsEnabled(broadcasterId))) return true;
  const row = await getBroadcaster(broadcasterId);
  const login = String(row?.login ?? "").toLowerCase();
  if (!login) return true;
  const streamer = String(row?.display_name || login);

  const bal = await getBalance(broadcasterId, login);
  const pay = Math.min(SWEAR_COST_COPPER, bal?.balance ?? 0);
  if (pay <= 0 || !(await trySpend(broadcasterId, login, pay))) {
    await sendChatMessage(`🫙 @${display} ${streamer} has no coin to put in the swear jar.`, broadcasterId);
    return true;
  }
  const total = await adjustJar(broadcasterId, pay);
  await sendChatMessage(pick(FINE_LINES)(display, streamer, formatCoins(pay), formatCoins(total)), broadcasterId);
  return true;
}

// ── !jar giveaway ──

/** Mod/broadcaster only: pays the whole jar out to a random recent chatter's
 * gold and empties the jar. At most once per GIVEAWAY_COOLDOWN_MS (7 days)
 * per channel; an empty jar or an empty pool doesn't use up the week. */
async function handleGiveaway(display: string, broadcasterId: string, isModerator: boolean): Promise<boolean> {
  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can give away the swear jar.`, broadcasterId);
    return true;
  }
  if (!(await isPointsEnabled(broadcasterId))) return true;

  const now = Date.now();
  const wait = (await getLastGiveawayAt(broadcasterId)) + GIVEAWAY_COOLDOWN_MS - now;
  if (wait > 0) {
    await sendChatMessage(`🫙 @${display} The swear jar was already given away this week — next giveaway in ${formatWait(wait)}.`, broadcasterId);
    return true;
  }
  if ((await getJarTotal(broadcasterId)) <= 0) {
    await sendChatMessage(`🫙 @${display} The swear jar is empty — nothing to give away yet.`, broadcasterId);
    return true;
  }

  const row = await getBroadcaster(broadcasterId);
  const winner = await pickGiveawayWinner(broadcasterId, String(row?.login ?? ""));
  if (!winner) {
    await sendChatMessage(`🫙 @${display} No one has chatted recently enough to win — try again once chat has been active.`, broadcasterId);
    return true;
  }

  const prev = await claimGiveaway(broadcasterId, winner.username, now);
  if (prev === null) {
    await sendChatMessage(`🫙 @${display} The swear jar was already given away this week.`, broadcasterId);
    return true;
  }
  const amount = await getJarTotal(broadcasterId);
  if (amount <= 0) {
    await releaseGiveaway(broadcasterId, prev);
    await sendChatMessage(`🫙 @${display} The swear jar is empty — nothing to give away yet.`, broadcasterId);
    return true;
  }
  await adjustJar(broadcasterId, -amount);
  await adjustBalance(broadcasterId, winner.username, winner.displayName, amount);
  await sqlite.execute("UPDATE swear_jar_giveaways SET amount = ? WHERE broadcaster_id = ?", [amount, broadcasterId]);
  await sendChatMessage(pick(GIVEAWAY_LINES)(winner.displayName, formatCoins(amount), display), broadcasterId);
  return true;
}

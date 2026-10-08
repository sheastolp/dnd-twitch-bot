// The Swear Jar.
//
// A per-channel jar of coin. Chatters who swear pay into it automatically, and
// anyone can check (or tweak) the total with !jar. The jar uses the same
// currency as the gold system (see coins.ts): every amount here is an integer
// number of COPPER, shown as "1 gp 2 sp 3 cp".
//
//   !jar                 what's in the jar, and when it was last given away
//   !jar +<amount>       add to the jar by hand (anyone)        e.g. !jar +8, !jar +5sp
//   !jar +<amount> @user fine someone (mod only): moves that much of THEIR
//                        gold into the jar (whatever they can afford)
//   !jar -<amount>       take from the jar by hand (mod only)   e.g. !jar -8
//   !jar giveaway        give the WHOLE jar to a random recent chatter (mod
//                        only, at most once every 7 days per channel)
//   !jar give @user      give the WHOLE jar to a chosen chatter (mod only, no
//                        weekly limit; it still counts as the week's giveaway)
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
// Channel points: redemptions.ts links rewards to the jar through !boon
// (claim the jar, gift it to someone, or fine the streamer). It calls the
// exported giveJarTo() and fineStreamer() below, so a redemption behaves
// exactly like the chat command it mirrors.
//
// Learning: the jar teaches itself new swear words per channel (see "Learning"
// below). Unknown words that keep turning up right next to swearing, from
// several different chatters, and almost never anywhere else, are promoted to
// "learned" and start charging. Mods can undo a bad guess with !jar forget
// <word> and see what's been learned with !jar words.
//
// Detection is word-based (see countSwearWords), so innocent words that
// merely contain a swear ("class", "assassin", "Scunthorpe") are never hit.
// Edit SWEAR_BASES below to tune the list (it includes UK/Irish slang such as
// "bloody", "bugger", "wanker" and "bollocks" — delete any you don't want charged).

import { sqlite } from "./sqlite.ts";
import { sendChatMessage } from "./twitch.ts";
import { pick } from "./utils.ts";
import { formatCoins, MAX_COPPER, parseCoins } from "./coins.ts";
import { adjustBalance, getBalance, isPointsEnabled, trySpend } from "./points_db.ts";
import { getBroadcaster } from "./db.ts";
import { isChannelBot } from "./channel_bots.ts";
import { optNum } from "./channel_options.ts";

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
  // Learned vocabulary, per channel. status: 'candidate' (being watched),
  // 'learned' (charges like a built-in word) or 'blocked' (a mod said no).
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS swear_words (
      broadcaster_id TEXT NOT NULL,
      word TEXT NOT NULL,
      swear_msgs INTEGER NOT NULL DEFAULT 0,
      total_msgs INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'candidate',
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (broadcaster_id, word)
    )`,
  );
  // Which distinct chatters have used a candidate next to swearing.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS swear_word_users (
      broadcaster_id TEXT NOT NULL,
      word TEXT NOT NULL,
      username TEXT NOT NULL,
      PRIMARY KEY (broadcaster_id, word, username)
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
  for (const table of ["swear_jar", "swear_jar_giveaways", "swear_words", "swear_word_users"]) {
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

/** Why giveJarTo() paid nothing. */
export type JarGiveFailure = "gold-off" | "empty";

/** Pays the WHOLE jar into `username`'s gold and empties it. No weekly limit
 * (the caller decided who gets it), but it is recorded as the latest
 * giveaway, so !jar shows it and the random !jar giveaway waits its week.
 * Returns the copper paid, or why nothing moved. */
export async function giveJarTo(
  broadcasterId: string,
  username: string,
  displayName: string,
): Promise<{ amount: number } | { failure: JarGiveFailure }> {
  if (!(await isPointsEnabled(broadcasterId))) return { failure: "gold-off" };
  const amount = await getJarTotal(broadcasterId);
  if (amount <= 0) return { failure: "empty" };
  // Take exactly what we read, and only if it's still there, so two gives at
  // once can't both pay out; a swear landing in between stays in the jar.
  const res = await sqlite.execute(
    "UPDATE swear_jar SET total = total - ?, updated_at = ? WHERE broadcaster_id = ? AND total >= ?",
    [amount, Date.now(), broadcasterId, amount],
  );
  const affected = (res as any).rowsAffected;
  if (typeof affected === "number" && affected === 0) return { failure: "empty" };
  const paid = amount;
  await adjustBalance(broadcasterId, username, displayName, paid);
  await sqlite.execute(
    `INSERT INTO swear_jar_giveaways (broadcaster_id, last_at, winner, amount) VALUES (?, ?, ?, ?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET last_at = excluded.last_at, winner = excluded.winner, amount = excluded.amount`,
    [broadcasterId, Date.now(), username.toLowerCase(), paid],
  );
  return { amount: paid };
}

/** Moves up to `amount` copper of the streamer's gold into the jar (whatever
 * they can afford). Shared by !fine and the "jarfine" channel-point reward.
 * Null if gold is off or there's no connected streamer; paid 0 if broke. */
export async function fineStreamer(
  broadcasterId: string,
  amount: number,
): Promise<{ streamer: string; paid: number; total: number } | null> {
  if (!(await isPointsEnabled(broadcasterId))) return null;
  const row = await getBroadcaster(broadcasterId);
  const login = String(row?.login ?? "").toLowerCase();
  if (!login) return null;
  const streamer = String(row?.display_name || login);
  const bal = await getBalance(broadcasterId, login);
  const pay = Math.min(amount, bal?.balance ?? 0);
  if (pay <= 0 || !(await trySpend(broadcasterId, login, pay))) return { streamer, paid: 0, total: await getJarTotal(broadcasterId) };
  return { streamer, paid: pay, total: await adjustJar(broadcasterId, pay) };
}

/** Flavor for a jar handed to someone on purpose (a mod's !jar give, or a
 * channel-point reward). {by} is who handed it over. */
export const GIFT_LINES: Array<(winner: string, amount: string, by: string) => string> = [
  (w, a, by) => `🎉 @${by} hands the whole swear jar to @${w} — ${a} of hard-earned profanity!`,
  (w, a, by) => `🎉 By decree of @${by}, the swear jar's ${a} is poured into @${w}'s purse!`,
  (w, a, by) => `🎉 @${by} slides the swear jar across the tavern table. @${w} pockets ${a}!`,
  (w, a, by) => `🎉 The guild treasurer, at @${by}'s word, counts out ${a} from the swear jar for @${w}.`,
];

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

// ── Learning ──
//
// A word is only ever learned from evidence in plain chat, never guessed from
// spelling alone:
//   * it must sit within LEARN_WINDOW words of a swear (built-in or already
//     learned) — "this fucking zorbag" nominates "zorbag";
//   * from then on every message containing it is counted, so a normal word
//     ("awesome", "idiot") that also gets used cleanly sinks its own ratio;
//   * it is learned once it has LEARN_MIN_HITS swear-adjacent uses by
//     LEARN_MIN_USERS different chatters AND at least LEARN_MIN_RATIO of all
//     its uses since nomination were swear-adjacent.
// Emote-looking tokens (KEKW, PogChamp), very common words, links and
// numbers are never nominated. A mod can veto any word with !jar forget.

const LEARN_WINDOW = 2;
const LEARN_MIN_HITS = 5;
const LEARN_MIN_USERS = 3;
const LEARN_MIN_RATIO = 0.6;
const MAX_CANDIDATES = 400;
const MAX_NOMINATIONS_PER_MESSAGE = 4;
const CANDIDATE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const WORD_CACHE_TTL_MS = 60_000;

const STOPWORDS = new Set((
  "the and for are but not you all any can had her was one our out day get has him his how man new now old see two way " +
  "who boy did its let put say she too use that with have this will your from they know want been good much some time " +
  "very when come here just like long make many over such take than them well were what then there their about would " +
  "these other which could first after again where those being still every great think going really right while never " +
  "should because people little always before thing things stuff game games play played playing stream chat guys yeah " +
  "okay lol lmao haha nice cool wait hmm yes nope also even only more most into onto ever gonna wanna gotta"
).split(/\s+/));

type WordStatus = "candidate" | "learned" | "blocked";
interface WordCache { at: number; words: Map<string, WordStatus> }
const wordCaches = new Map<string, WordCache>();

async function loadWords(broadcasterId: string): Promise<Map<string, WordStatus>> {
  const hit = wordCaches.get(broadcasterId);
  if (hit && Date.now() - hit.at < WORD_CACHE_TTL_MS) return hit.words;
  const res = await sqlite.execute("SELECT word, status FROM swear_words WHERE broadcaster_id = ?", [broadcasterId]);
  const words = new Map<string, WordStatus>();
  for (const r of res.rows as any[]) words.set(String(r.word), String(r.status) as WordStatus);
  wordCaches.set(broadcasterId, { at: Date.now(), words });
  return words;
}

function invalidateWords(broadcasterId: string) {
  wordCaches.delete(broadcasterId);
}

/** The forms a stretched-out word could take: "fuuuck" -> itself, "fuuck", "fuck". */
function wordForms(word: string): string[] {
  const forms = [word];
  const s2 = word.replace(/(.)\1{2,}/g, "$1$1");
  if (s2 !== word) forms.push(s2);
  const s1 = word.replace(/(.)\1{2,}/g, "$1");
  if (s1 !== word) forms.push(s1);
  return forms;
}

interface Tok { word: string; learnedHit: boolean; known: boolean; eligible: boolean }

function tokenize(message: string, words: Map<string, WordStatus>): Tok[] {
  const out: Tok[] = [];
  for (const raw of message.split(/[^A-Za-z0-9@$]+/)) {
    if (!raw) continue;
    const word = normalizeToken(raw.toLowerCase());
    const mixedCase = /[a-z]/.test(raw) && /[A-Z]/.test(raw.slice(1)); // PogChamp, xQcOW
    const allCaps = raw.length > 1 && raw === raw.toUpperCase() && /[A-Z]/.test(raw); // KEKW, LUL
    const forms = wordForms(word);
    out.push({
      word: forms[forms.length - 1],
      known: isSwear(word),
      learnedHit: !!word && forms.some((f) => words.get(f) === "learned"),
      eligible: /^[a-z]{3,20}$/.test(word) && !/[@$]/.test(raw) && !mixedCase && !allCaps && !STOPWORDS.has(word),
    });
  }
  return out;
}

/** Updates the channel's vocabulary from one plain message. Learned words show
 * up in the next message's detection. */
async function observeMessage(
  toks: Tok[],
  chatMessage: string,
  chatter: string,
  broadcasterId: string,
  words: Map<string, WordStatus>,
): Promise<void> {
  const swearAt: number[] = [];
  toks.forEach((t, i) => { if (t.known || t.learnedHit) swearAt.push(i); });
  const nearSwear = (i: number) => swearAt.some((j) => Math.abs(i - j) <= LEARN_WINDOW);
  const hasLink = /https?:\/\/|www\./i.test(chatMessage);
  const now = Date.now();

  const adjacent = new Set<string>(); // swear-adjacent uses of candidates / new nominees
  const present = new Set<string>(); // every candidate that appears at all
  let nominations = 0;
  toks.forEach((t, i) => {
    if (!t.eligible || t.known || t.learnedHit) return;
    const status = words.get(t.word);
    if (status === "blocked" || status === "learned") return;
    const near = swearAt.length > 0 && !hasLink && nearSwear(i);
    if (status === "candidate") {
      present.add(t.word);
      if (near) adjacent.add(t.word);
    } else if (near && nominations < MAX_NOMINATIONS_PER_MESSAGE) {
      nominations++;
      adjacent.add(t.word);
      present.add(t.word);
    }
  });
  if (!present.size) return;

  const candidateCount = [...words.values()].filter((v) => v === "candidate").length;
  const touchedHits: string[] = [];
  for (const word of present) {
    const isNew = !words.has(word);
    if (isNew && candidateCount + 1 > MAX_CANDIDATES) continue;
    const hit = adjacent.has(word) ? 1 : 0;
    await sqlite.execute(
      `INSERT INTO swear_words (broadcaster_id, word, swear_msgs, total_msgs, status, updated_at)
       VALUES (?, ?, ?, 1, 'candidate', ?)
       ON CONFLICT(broadcaster_id, word) DO UPDATE SET
         swear_msgs = swear_msgs + excluded.swear_msgs,
         total_msgs = total_msgs + 1,
         updated_at = excluded.updated_at
       WHERE status = 'candidate'`,
      [broadcasterId, word, hit, now],
    );
    if (isNew) words.set(word, "candidate");
    if (hit) {
      await sqlite.execute(
        "INSERT OR IGNORE INTO swear_word_users (broadcaster_id, word, username) VALUES (?, ?, ?)",
        [broadcasterId, word, chatter.toLowerCase()],
      );
      touchedHits.push(word);
    }
  }

  let promoted = false;
  for (const word of touchedHits) {
    const row = (await sqlite.execute(
      `SELECT w.swear_msgs AS hits, w.total_msgs AS total,
              (SELECT COUNT(*) FROM swear_word_users u WHERE u.broadcaster_id = w.broadcaster_id AND u.word = w.word) AS users
       FROM swear_words w WHERE w.broadcaster_id = ? AND w.word = ? AND w.status = 'candidate'`,
      [broadcasterId, word],
    )).rows[0] as any;
    if (!row) continue;
    const hits = Number(row.hits), total = Number(row.total), users = Number(row.users);
    if (hits >= LEARN_MIN_HITS && users >= LEARN_MIN_USERS && total > 0 && hits / total >= LEARN_MIN_RATIO) {
      await sqlite.execute(
        "UPDATE swear_words SET status = 'learned', updated_at = ? WHERE broadcaster_id = ? AND word = ? AND status = 'candidate'",
        [now, broadcasterId, word],
      );
      words.set(word, "learned");
      promoted = true;
    }
  }
  if (promoted) invalidateWords(broadcasterId);

  // Housekeeping (1 message in 40): drop stale candidates and their evidence.
  if (Math.random() < 1 / 40) {
    const cutoff = now - CANDIDATE_TTL_MS;
    await sqlite.execute(
      `DELETE FROM swear_word_users WHERE broadcaster_id = ? AND word IN
         (SELECT word FROM swear_words WHERE broadcaster_id = ? AND status = 'candidate' AND updated_at < ?)`,
      [broadcasterId, broadcasterId, cutoff],
    );
    await sqlite.execute("DELETE FROM swear_words WHERE broadcaster_id = ? AND status = 'candidate' AND updated_at < ?", [broadcasterId, cutoff]);
    invalidateWords(broadcasterId);
  }
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

/** Charges the chatter if their message contains swear words (built-in or
 * learned for this channel), and learns from the message. Safe to call for
 * every plain, non-bot chat message: silent no-op when the gold system is off,
 * there's no swearing, or the chatter has no coin. Returns true if coin moved. */
export async function maybeChargeSwearJar(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  let words = new Map<string, WordStatus>();
  let toks: Tok[];
  try {
    words = await loadWords(broadcasterId);
    toks = tokenize(chatMessage, words);
    // Learning runs even while gold is off or the chatter is broke.
    await observeMessage(toks, chatMessage, chatter, broadcasterId, words);
  } catch (e) {
    console.error("swear jar learning failed", e); // never let learning break charging
    toks = tokenize(chatMessage, words);
  }
  const hits = toks.filter((t) => t.known || t.learnedHit);
  const swears = Math.min(MAX_SWEARS_PER_MESSAGE, hits.length);
  if (swears === 0) return false;
  if (!(await isPointsEnabled(broadcasterId))) return false;

  const owed = swears * await optNum(broadcasterId, "jar.cost");
  const bal = await getBalance(broadcasterId, chatter);
  const pay = Math.min(owed, bal?.balance ?? 0);
  if (pay <= 0) return false;
  // trySpend is atomic (only succeeds if they still have it), so two rapid
  // messages can't take the same copper twice.
  if (!(await trySpend(broadcasterId, chatter, pay))) return false;

  const total = await adjustJar(broadcasterId, pay);
  // Name any learned words that were charged so mods can see (and veto) them.
  const learnedWords = [...new Set(hits.filter((t) => !t.known && t.learnedHit).map((t) => t.word))];
  const note = learnedWords.length ? ` (learned word: ${learnedWords.slice(0, 3).join(", ")} — mods: !jar forget <word>)` : "";
  await sendChatMessage(pick(PAID_LINES)(display, formatCoins(pay), formatCoins(total)) + note, broadcasterId);
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
  const give = args.match(/^give(?:\s+(\S+))?$/i);
  if (give) return await handleGive(give[1] ?? "", display, broadcasterId, isModerator);
  if (/^words$/i.test(args)) return await handleWords(display, broadcasterId, isModerator);
  const forget = args.match(/^forget\s+(\S+)$/i);
  if (forget) return await handleForget(forget[1], display, broadcasterId, isModerator);

  if (!args) {
    const total = await getJarTotal(broadcasterId);
    const res = await sqlite.execute("SELECT last_at, winner, amount FROM swear_jar_giveaways WHERE broadcaster_id = ?", [broadcasterId]);
    const last: any = res.rows[0];
    const lastAt = Number(last?.last_at ?? 0);
    const lastNote = lastAt > 0
      ? ` Last giveaway was ${formatWait(Date.now() - lastAt)} ago${last?.winner ? ` — @${last.winner} won ${formatCoins(Number(last.amount ?? 0))}` : ""}.`
      : " It has never been given away.";
    await sendChatMessage(`🫙 @${display} The swear jar holds ${formatCoins(total)}.${lastNote}`, broadcasterId);
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
      `@${display} Usage: !jar (see the total) | !jar +8 (add 8 cp) | !jar +8 @user (mod: fine them 8 cp) | !jar -8 (mod only) | !jar giveaway / !jar give @user (mod only) | !jar words / !jar forget <word> (mod: learned words) | !fine (fine the streamer). Units work too: 5sp, 1gp.`,
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
  const res = await fineStreamer(broadcasterId, await optNum(broadcasterId, "jar.cost"));
  if (!res) return true;
  if (res.paid <= 0) {
    await sendChatMessage(`🫙 @${display} ${res.streamer} has no coin to put in the swear jar.`, broadcasterId);
    return true;
  }
  await sendChatMessage(pick(FINE_LINES)(display, res.streamer, formatCoins(res.paid), formatCoins(res.total)), broadcasterId);
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

// ── !jar give @user ──

/** Mod/broadcaster only: pays the whole jar to a chosen chatter. The target
 * must have a purse here already (has chatted), so a typo can't send the jar
 * into the void, and bots can't receive it. */
async function handleGive(rawTarget: string, display: string, broadcasterId: string, isModerator: boolean): Promise<boolean> {
  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can give away the swear jar.`, broadcasterId);
    return true;
  }
  if (!(await isPointsEnabled(broadcasterId))) return true;
  const target = rawTarget.replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(target)) {
    await sendChatMessage(`@${display} Usage: !jar give @user`, broadcasterId);
    return true;
  }
  if (await isChannelBot(broadcasterId, target, "", Deno.env.get("TWITCH_BOT_ID") ?? "")) {
    await sendChatMessage(`🫙 @${display} bots don't get the swear jar.`, broadcasterId);
    return true;
  }
  const bal = await getBalance(broadcasterId, target);
  if (!bal) {
    await sendChatMessage(`🫙 @${display} ${target} has no purse here yet — they need to have chatted first.`, broadcasterId);
    return true;
  }
  const res = await giveJarTo(broadcasterId, target, bal.displayName || target);
  if ("failure" in res) {
    if (res.failure === "empty") await sendChatMessage(`🫙 @${display} The swear jar is empty — nothing to give away yet.`, broadcasterId);
    return true;
  }
  await sendChatMessage(pick(GIFT_LINES)(bal.displayName || target, formatCoins(res.amount), display), broadcasterId);
  return true;
}

// ── !jar words / !jar forget (mod tools for the learned vocabulary) ──

async function handleWords(display: string, broadcasterId: string, isModerator: boolean): Promise<boolean> {
  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can see the learned words.`, broadcasterId);
    return true;
  }
  const res = await sqlite.execute(
    "SELECT word FROM swear_words WHERE broadcaster_id = ? AND status = 'learned' ORDER BY updated_at DESC LIMIT 20",
    [broadcasterId],
  );
  const list = (res.rows as any[]).map((r) => String(r.word));
  await sendChatMessage(
    list.length
      ? `🫙 @${display} Words the jar has learned here: ${list.join(", ")}. Remove one with !jar forget <word>.`
      : `🫙 @${display} The jar hasn't learned any new words in this channel yet.`,
    broadcasterId,
  );
  return true;
}

async function handleForget(rawWord: string, display: string, broadcasterId: string, isModerator: boolean): Promise<boolean> {
  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can make the jar forget a word.`, broadcasterId);
    return true;
  }
  const word = wordForms(normalizeToken(rawWord.toLowerCase())).pop() ?? "";
  if (!/^[a-z]{2,25}$/.test(word)) {
    await sendChatMessage(`@${display} Usage: !jar forget <word>`, broadcasterId);
    return true;
  }
  if (isSwear(word)) {
    await sendChatMessage(`@${display} "${word}" is a built-in word, so it can't be forgotten (it's in swearjar.ts).`, broadcasterId);
    return true;
  }
  // 'blocked' keeps it from ever being nominated again.
  await sqlite.execute(
    `INSERT INTO swear_words (broadcaster_id, word, swear_msgs, total_msgs, status, updated_at)
     VALUES (?, ?, 0, 0, 'blocked', ?)
     ON CONFLICT(broadcaster_id, word) DO UPDATE SET status = 'blocked', updated_at = excluded.updated_at`,
    [broadcasterId, word, Date.now()],
  );
  await sqlite.execute("DELETE FROM swear_word_users WHERE broadcaster_id = ? AND word = ?", [broadcasterId, word]);
  invalidateWords(broadcasterId);
  await sendChatMessage(`🫙 @${display} The jar has forgotten "${word}" and won't learn it again here.`, broadcasterId);
  return true;
}

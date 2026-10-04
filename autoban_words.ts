// Per-channel auto-ban word list, ignore list and spam learning for
// autoban.ts. Own module (and own tables) so autoban.ts stays small.
//
//   autoban_words    phrases that trigger a ban. Each has a source
//                    (default | manual | learned) and a status:
//                      active   — enforced
//                      pending  — learned but not yet trusted; not enforced
//                      off      — disabled / rejected; also stops it being
//                                 re-learned
//   autoban_ignored  logins auto-ban never touches (and never learns from)
//   autoban_learn    per-channel learning mode: auto | suggest | off
//
// Matching runs on a normalized copy of the message (case, accents,
// zero-width/invisible characters, fullwidth and "fancy" Unicode letters,
// spaced-out or spelled-out domains — "grow . com", "grow dot com" and
// "grow(.)com" all become "grow.com"). Each plain phrase is then compiled
// into a loose pattern that also catches the usual spelling dodges:
//   look-alikes   v1ewers, f0ll0wers, $ub$, víewers, Cyrillic/Greek letters,
//                 Al viewers (l for I), rn for m, vv for w, ph for f, |< for k
//   stretched     viiieeewers, folllowers
//   broken up     v.i.e.w.e.r.s, f o l l o w e r s, view_ers, aiviewers
// It still has to stand as whole words, so "aint" never matches "ai".
//
// Regex entries. A phrase written as /pattern/ (optionally /pattern/flags) is
// a regular expression instead, always case-insensitive, tested against the
// normalized message and its look-alike-folded form. It's checked when saved:
// it must compile, must not match an empty or everyday message, and must not
// nest repeats like (a+)+ or use back-references, which could stall the bot.
//
// Learning. Spam bots rotate their wording and usernames but keep their
// domain and their pitch, so two signals feed the list:
//   1. When a message is banned, any domain in it (minus common real sites)
//      is learned as an active phrase straight away — strong evidence.
//   2. A non-mod message that scores as promo spam on its own (a domain,
//      "viewers"/"followers", "grow your stream", ...) is recorded as a
//      pending suggestion — keyed by its domain, or by the whole normalized
//      message when there is none. In "auto" mode it becomes active once
//      LEARN_PROMOTE_CHATTERS different chatters have sent it (one person
//      tripping the heuristic isn't a campaign; the same pitch from several
//      fresh accounts is). In "suggest" mode it waits for a mod to approve
//      it on the dashboard page.

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

export type WordSource = "default" | "manual" | "learned";
export type WordStatus = "active" | "pending" | "off";
export type LearnMode = "auto" | "suggest" | "off";

export interface AutoBanWord {
  id: number;
  phrase: string;
  source: WordSource;
  status: WordStatus;
  hits: number;
  lastHitAt: number | null;
  sightings: number;
  example: string;
  createdAt: number;
}

export const DEFAULT_PHRASES = ["ai viewers"];
export const MAX_PHRASES = 300;
export const MAX_PHRASE_LEN = 200;
// Learned whole-message patterns are cut to this length.
const MAX_PITCH_LEN = 120;
const MIN_PHRASE_LEN = 3;
export const LEARN_PROMOTE_CHATTERS = 2;
const MAX_EXAMPLE_LEN = 200;
// A whole-message pattern shorter than this is too generic to learn.
const MIN_LEARNED_MESSAGE_LEN = 20;

// Domains people share legitimately; never learned as spam.
const SAFE_DOMAINS = new Set([
  "twitch.tv", "clips.twitch.tv", "youtube.com", "youtu.be", "discord.gg", "discord.com", "twitter.com", "x.com",
  "instagram.com", "tiktok.com", "reddit.com", "github.com", "google.com", "wikipedia.org", "dndbeyond.com",
  "imgur.com", "streamelements.com", "streamlabs.com", "ko-fi.com", "patreon.com", "throne.com", "amazon.com",
  "steampowered.com", "store.steampowered.com", "val.run", "guildscribe.val.run",
]);

// ── Normalization ──

// One-character look-alikes, folded by fold() (used by the ban history and
// for regex entries). Ambiguous ones pick the likelier letter.
const LOOKALIKES: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "@": "a", "$": "s", "!": "i", "|": "i",
  "€": "e", "£": "l", "¢": "c", "ß": "b", "ø": "o",
  // Cyrillic
  "а": "a", "в": "b", "е": "e", "ё": "e", "з": "e", "к": "k", "м": "m", "н": "h", "һ": "h", "о": "o", "р": "p", "с": "c", "т": "t",
  "у": "y", "х": "x", "і": "i", "ї": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ү": "y", "ӏ": "l", "г": "r", "п": "n", "ш": "w",
  // Greek
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
  "ω": "w", "μ": "u", "σ": "o",
  // Small capitals (NFKD leaves these alone)
  "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ғ": "f", "ɢ": "g", "ʜ": "h", "ɪ": "i", "ᴊ": "j", "ᴋ": "k", "ʟ": "l",
  "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ǫ": "q", "ʀ": "r", "ꜱ": "s", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y",
  "ᴢ": "z",
};
const classEscape = (c: string) => c.replace(/[\\\]^-]/g, "\\$&");
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKES).map(classEscape).join("")}]`, "g");

// Invisible characters spammers wedge into words: zero-width and joiner
// marks, soft hyphen, combining marks (after NFKD this strips accents too),
// bidi controls, word joiners, Hangul fillers, variation selectors, tags.
const INVISIBLE_RE = /[­͏̀-ͯ؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]|\udb40[\udc00-\udc7f]/g;

/** Lowercase, strip invisible/combining marks, collapse whitespace and
 * rejoin obfuscated domains. Digits are kept (domains and real words use
 * them); lookalikes are folded only in the separate `folded` form. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(INVISIBLE_RE, "")
    .toLowerCase()
    // "grow dot com", "grow (dot) com", "grow [.] com", "grow . com" → "grow.com".
    // A bare ". " is left alone so sentence breaks ("thanks all. com...") don't
    // turn into domains.
    .replace(/(?:\s*[\(\[\{]\s*(?:\.|dot)\s*[\)\]\}]\s*|\s+(?:\.|dot)\s+)(?=(?:com|net|org|io|gg|tv|xyz|shop|store|site|online|live|pro|top|ru|cc|info|biz|app|link|click)\b)/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

export function fold(text: string): string {
  return text.replace(LOOKALIKE_RE, (c) => LOOKALIKES[c] ?? c);
}

// ── Phrase → loose pattern ──

// What each letter may be written as: the letter itself, single-character
// look-alikes, and a few multi-character ones. i and l share 1 | ! (and each
// other: "Al viewers").
const LETTER_FORMS: Record<string, { chars: string; seqs?: string[] }> = {
  a: { chars: "a4@аαᴀ", seqs: ["/\\"] },
  b: { chars: "b86вßβʙ", seqs: ["|3"] },
  c: { chars: "c(<¢сᴄ" },
  d: { chars: "dԁᴅ", seqs: ["|)"] },
  e: { chars: "e3€еёзεᴇ" },
  f: { chars: "fƒғ", seqs: ["ph"] },
  g: { chars: "g96ɢ" },
  h: { chars: "h#нһʜ", seqs: ["|-|"] },
  i: { chars: "i1!|lіїιɪ" },
  j: { chars: "jјᴊ" },
  k: { chars: "kкκᴋ", seqs: ["|<"] },
  l: { chars: "l1|!iӏʟ£" },
  m: { chars: "mмᴍ", seqs: ["rn", "|v|"] },
  n: { chars: "nпηɴ", seqs: ["|\\|"] },
  o: { chars: "o0оοσᴏø°", seqs: ["()"] },
  p: { chars: "pрρᴘ" },
  q: { chars: "qǫ" },
  r: { chars: "rгʀ" },
  s: { chars: "s5$ѕꜱ" },
  t: { chars: "t7+тτᴛ" },
  u: { chars: "uυμᴜ" },
  v: { chars: "vνᴠ", seqs: ["\\/"] },
  w: { chars: "wшωᴡ", seqs: ["vv", "\\/\\/"] },
  x: { chars: "xхχ×" },
  y: { chars: "yуүʏ" },
  z: { chars: "z2ᴢ" },
};
// Up to two junk characters between the letters of a word ("v.i.e.w", "f o l").
const IN_WORD_GAP = 2;
// Up to four (or none) between words, or for punctuation in the phrase
// ("ai viewers" ↔ "aiviewers", "grow.com" ↔ "grow com").
const BETWEEN_GAP = 4;
const WORD_CHAR = /[\p{L}\p{N}]/u;

export interface LoosePattern {
  units: Array<{ chars: string; seqs: string[] }>; // one per phrase letter; each may repeat
  gaps: number[]; // junk allowed after units[k]
}

/** Compiles a plain phrase into letter units: look-alikes, stretched letters,
 * junk between letters, flexible gaps between words. */
export function loosePattern(phrase: string): LoosePattern {
  const units: LoosePattern["units"] = [];
  const gaps: number[] = [];
  for (const tok of phrase.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}]+/gu) ?? []) {
    if (!WORD_CHAR.test(tok)) {
      if (units.length) gaps[units.length - 1] = BETWEEN_GAP;
      continue;
    }
    for (const ch of tok) {
      if (units.length && gaps[units.length - 1] == null) gaps[units.length - 1] = IN_WORD_GAP;
      const f = LETTER_FORMS[ch];
      units.push({ chars: f ? f.chars : ch, seqs: f?.seqs ?? [] });
    }
  }
  gaps.length = Math.max(0, units.length - 1);
  return { units, gaps };
}

/** Whether the text contains the pattern as whole words. Follows every
 * possible reading at once (a set of states per text position) instead of
 * backtracking, so it stays linear however the look-alikes overlap — a
 * chatter can't stall the bot with something like "1|!1|!1|!…". */
export function looseMatch(text: string, pat: LoosePattern): boolean {
  const U = pat.units.length;
  if (!U) return false;
  const chars = [...text];
  const n = chars.length;
  const isWord = (i: number) => i >= 0 && i < n && WORD_CHAR.test(chars[i]);
  // States: 2k = needs unit k; 2k+1 = has matched unit k at least once;
  // 2U + 8k + j = in the gap after unit k, j junk characters skipped.
  const at: Array<Set<number>> = Array.from({ length: n + 1 }, () => new Set());
  const push = (i: number, st: number) => {
    if (at[i].has(st)) return;
    at[i].add(st);
    if (st < 2 * U) {
      if (st % 2 === 1 && st >> 1 < U - 1) push(i, 2 * U + 8 * (st >> 1)); // move on to the gap
    } else push(i, 2 * (((st - 2 * U) >> 3) + 1)); // the gap may end here
  };
  for (let i = 0; i <= n; i++) {
    if (i < n && !isWord(i - 1)) push(i, 0);
    for (const st of at[i]) {
      if (st < 2 * U) {
        const k = st >> 1;
        if (st % 2 === 1 && k === U - 1 && !isWord(i)) return true;
        if (i >= n) continue;
        const u = pat.units[k];
        if (u.chars.includes(chars[i])) push(i + 1, 2 * k + 1);
        for (const seq of u.seqs) {
          if (i + seq.length <= n && chars.slice(i, i + seq.length).join("") === seq) push(i + seq.length, 2 * k + 1);
        }
      } else if (i < n && !isWord(i) && ((st - 2 * U) & 7) < pat.gaps[(st - 2 * U) >> 3]) {
        push(i + 1, st + 1);
      }
    }
    at[i].clear();
  }
  return false;
}

// ── Regex entries ──

const REGEX_ENTRY_RE = /^\/(.+)\/([a-z]*)$/s;
export const isRegexEntry = (phrase: string) => REGEX_ENTRY_RE.test(phrase);

// Everyday chat a regex entry must leave alone.
const BENIGN_SAMPLES = [
  "", "a", "hi", "gg", "lol", "ok", "hello everyone", "hey chat how is everyone doing today",
  "nice roll!", "that was a great stream, thanks", "!char", "!roll d20", "can i join the party?",
  "what game is this", "good night all <3",
];

/** Compiles a /pattern/flags entry, or says why it's unusable. */
function compileRegexEntry(phrase: string): RegExp | string {
  const m = phrase.match(REGEX_ENTRY_RE);
  if (!m) return "A regex is written between slashes, like /v[i1]ewers?/.";
  const [, src, rawFlags] = m;
  if (/[^imsu]/.test(rawFlags)) return "Regex flags can only be i, m, s or u.";
  // Nested repeats like (a+)+ or (\w*)* can take forever on some messages.
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,)/.test(src)) {
    return "That regex repeats a repeat, like (a+)+, which could stall the bot. Simplify it.";
  }
  if (/\\[1-9]|\\k</.test(src.replace(/\\\\/g, ""))) return "Back-references aren't allowed in auto-ban regexes.";
  let re: RegExp;
  try {
    re = new RegExp(src, [...new Set(rawFlags + "i")].join(""));
  } catch (e) {
    return `That regex doesn't compile: ${(e as Error).message}`;
  }
  const hit = BENIGN_SAMPLES.find((t) => re.test(t));
  if (hit !== undefined) return `That regex is too broad: it matches ${hit ? `"${hit}"` : "an empty message"}.`;
  return re;
}

/** Normalizes a mod-entered phrase the same way messages are, so "AI  Viewers"
 * and "ai viewers" are one entry. A /regex/ entry is kept as typed, once it
 * passes the safety checks. */
export function checkPhrase(raw: string): { phrase: string } | { error: string } {
  const trimmed = String(raw ?? "").trim();
  if (/^\/.+\/[a-z]*$/s.test(trimmed)) {
    if (trimmed.length > MAX_PHRASE_LEN) return { error: `A regex can be at most ${MAX_PHRASE_LEN} characters.` };
    const re = compileRegexEntry(trimmed);
    return typeof re === "string" ? { error: re } : { phrase: trimmed };
  }
  const p = normalizeText(trimmed).slice(0, MAX_PHRASE_LEN).trim();
  if (p.length < MIN_PHRASE_LEN) return { error: `A phrase needs at least ${MIN_PHRASE_LEN} characters.` };
  return { phrase: p };
}

export function sanitizePhrase(raw: string): string | null {
  const r = checkPhrase(raw);
  return "phrase" in r ? r.phrase : null;
}

// Compiled matchers, shared across channels (the same phrases recur).
type Matcher = (normalized: string, folded: string) => boolean;
const matcherCache = new Map<string, Matcher | null>();

function matcherFor(phrase: string): Matcher | null {
  let m = matcherCache.get(phrase);
  if (m !== undefined) return m;
  if (isRegexEntry(phrase)) {
    const re = compileRegexEntry(phrase);
    m = typeof re === "string" ? null : (n, f) => re.test(n) || re.test(f);
  } else {
    const pat = loosePattern(phrase);
    m = (n) => looseMatch(n, pat);
  }
  if (matcherCache.size > 2000) matcherCache.clear();
  matcherCache.set(phrase, m);
  return m;
}

/** Whether the (already normalized) message trips the phrase. */
export function phraseMatches(normalized: string, phrase: string, folded = fold(normalized)): boolean {
  const m = matcherFor(phrase);
  return m ? m(normalized, folded) : false;
}

// ── Spam heuristic (used only for learning, never to ban on its own) ──

const DOMAIN_RE = /\b([a-z0-9][a-z0-9-]{1,40}(?:\.[a-z0-9-]{1,40})*\.(?:com|net|org|io|gg|tv|xyz|shop|store|site|online|live|pro|top|ru|cc|info|biz|app|link|click))\b/g;

const PROMO_SIGNALS: RegExp[] = [
  /\bviewers?\b/, /\bfollowers?\b/, /\bviewbots?\b/, /\bsubscribers?\b/, /\bprimes?\b/,
  /\b(?:grow|boost|promote|upgrade|level up)\s+(?:your|ur|the)\s+(?:stream|channel|account)\b/,
  /\b(?:for|to)\s+(?:your|ur)\s+(?:stream|channel)\b/, /\bbecome (?:famous|popular)\b/, /\bget famous\b/,
  /\bcheap\b/, /\bbest (?:viewers|followers|prices?)\b/, /\bremove (?:the )?spaces?\b/, /\bcheck (?:it )?out\b/,
  /\bdm me\b/, /\bfree (?:trial|viewers|followers)\b/, /\bbuy\b/, /\bpromo(?:tion)?\b/,
];

export function extractDomains(normalized: string): string[] {
  const out = new Set<string>();
  for (const m of normalized.matchAll(DOMAIN_RE)) {
    const d = m[1].replace(/^www\./, "");
    if (!SAFE_DOMAINS.has(d) && ![...SAFE_DOMAINS].some((s) => d.endsWith(`.${s}`))) out.add(d);
  }
  return [...out];
}

/** Score of how much a message reads like a promo-bot pitch. */
export function spamScore(normalized: string): { score: number; domains: string[] } {
  const domains = extractDomains(normalized);
  const folded = fold(normalized);
  let score = domains.length ? 2 : 0;
  let promo = 0;
  for (const re of PROMO_SIGNALS) if (re.test(folded)) promo++;
  score += Math.min(promo, 3);
  return { score, domains };
}
const LEARN_THRESHOLD = 3;

// ── Persistence ──

export async function ensureAutoBanWordTables() {
  await sqlite.batch([
    `CREATE TABLE IF NOT EXISTS autoban_words (
      id INTEGER PRIMARY KEY AUTOINCREMENT, broadcaster_id TEXT NOT NULL, phrase TEXT NOT NULL,
      source TEXT NOT NULL, status TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER,
      seen_by TEXT NOT NULL DEFAULT '', example TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      UNIQUE (broadcaster_id, phrase)
    )`,
    `CREATE TABLE IF NOT EXISTS autoban_ignored (
      broadcaster_id TEXT NOT NULL, login TEXT NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, login)
    )`,
    `CREATE TABLE IF NOT EXISTS autoban_learn (
      broadcaster_id TEXT PRIMARY KEY, mode TEXT NOT NULL, seeded INTEGER NOT NULL DEFAULT 0
    )`,
  ]);
}

export async function purgeAutoBanWordData(broadcasterId: string) {
  await sqlite.batch([
    { sql: "DELETE FROM autoban_words WHERE broadcaster_id = ?", args: [broadcasterId] },
    { sql: "DELETE FROM autoban_ignored WHERE broadcaster_id = ?", args: [broadcasterId] },
    { sql: "DELETE FROM autoban_learn WHERE broadcaster_id = ?", args: [broadcasterId] },
  ]);
  stateCache.delete(broadcasterId);
}

function rowToWord(r: any): AutoBanWord {
  const seenBy = String(r.seen_by ?? "").split(",").filter(Boolean);
  return {
    id: Number(r.id),
    phrase: String(r.phrase),
    source: String(r.source) as WordSource,
    status: String(r.status) as WordStatus,
    hits: Number(r.hits ?? 0),
    lastHitAt: r.last_hit_at == null ? null : Number(r.last_hit_at),
    sightings: seenBy.length,
    example: String(r.example ?? ""),
    createdAt: Number(r.created_at),
  };
}

/** Seeds the default phrases the first time a channel's list is read, so
 * "ai viewers" shows up on the page and can be edited or removed like any
 * other entry. */
async function ensureSeeded(broadcasterId: string): Promise<LearnMode> {
  const res = await sqlite.execute("SELECT mode, seeded FROM autoban_learn WHERE broadcaster_id = ?", [broadcasterId]);
  if (res.rows.length && Number(res.rows[0].seeded) === 1) return String(res.rows[0].mode) as LearnMode;
  const mode = (res.rows.length ? String(res.rows[0].mode) : "auto") as LearnMode;
  const now = Date.now();
  await sqlite.batch([
    ...DEFAULT_PHRASES.map((p) => ({
      sql: "INSERT OR IGNORE INTO autoban_words (broadcaster_id, phrase, source, status, created_at) VALUES (?,?,?,?,?)",
      args: [broadcasterId, p, "default", "active", now],
    })),
    { sql: "INSERT OR REPLACE INTO autoban_learn (broadcaster_id, mode, seeded) VALUES (?,?,1)", args: [broadcasterId, mode] },
  ]);
  return mode;
}

export async function listWords(broadcasterId: string): Promise<AutoBanWord[]> {
  await ensureSeeded(broadcasterId);
  const res = await sqlite.execute(
    "SELECT * FROM autoban_words WHERE broadcaster_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, hits DESC, created_at DESC",
    [broadcasterId],
  );
  return res.rows.map(rowToWord);
}

export async function listIgnoredUsers(broadcasterId: string): Promise<Array<{ login: string; addedAt: number }>> {
  const res = await sqlite.execute("SELECT login, added_at FROM autoban_ignored WHERE broadcaster_id = ? ORDER BY login", [broadcasterId]);
  return res.rows.map((r: any) => ({ login: String(r.login), addedAt: Number(r.added_at) }));
}

export async function getLearnMode(broadcasterId: string): Promise<LearnMode> {
  return await ensureSeeded(broadcasterId);
}

// ── Edits (dashboard page / chat) ──

export type EditResult = { ok: true; message: string } | { ok: false; error: string };

export async function addWord(broadcasterId: string, raw: string): Promise<EditResult> {
  const checked = checkPhrase(raw);
  if ("error" in checked) return { ok: false, error: checked.error };
  const phrase = checked.phrase;
  await ensureSeeded(broadcasterId);
  const count = await sqlite.execute("SELECT COUNT(*) AS n FROM autoban_words WHERE broadcaster_id = ?", [broadcasterId]);
  const existing = await sqlite.execute("SELECT id FROM autoban_words WHERE broadcaster_id = ? AND phrase = ?", [broadcasterId, phrase]);
  if (existing.rows.length) {
    await sqlite.execute("UPDATE autoban_words SET status = 'active' WHERE id = ?", [existing.rows[0].id]);
    stateCache.delete(broadcasterId);
    return { ok: true, message: `"${phrase}" was already on the list — it's active now.` };
  }
  if (Number(count.rows[0]?.n ?? 0) >= MAX_PHRASES) return { ok: false, error: `The list is full (${MAX_PHRASES}). Delete some first.` };
  await sqlite.execute(
    "INSERT INTO autoban_words (broadcaster_id, phrase, source, status, created_at) VALUES (?,?,?,?,?)",
    [broadcasterId, phrase, "manual", "active", Date.now()],
  );
  stateCache.delete(broadcasterId);
  return { ok: true, message: `Added "${phrase}".` };
}

export async function editWord(broadcasterId: string, id: number, raw: string): Promise<EditResult> {
  const checked = checkPhrase(raw);
  if ("error" in checked) return { ok: false, error: checked.error };
  const phrase = checked.phrase;
  const clash = await sqlite.execute("SELECT id FROM autoban_words WHERE broadcaster_id = ? AND phrase = ? AND id != ?", [broadcasterId, phrase, id]);
  if (clash.rows.length) return { ok: false, error: `"${phrase}" is already on the list.` };
  const res = await sqlite.execute("UPDATE autoban_words SET phrase = ? WHERE broadcaster_id = ? AND id = ?", [phrase, broadcasterId, id]);
  stateCache.delete(broadcasterId);
  return res.rowsAffected ? { ok: true, message: `Saved "${phrase}".` } : { ok: false, error: "That entry no longer exists." };
}

export async function setWordStatus(broadcasterId: string, id: number, status: WordStatus): Promise<EditResult> {
  const res = await sqlite.execute("UPDATE autoban_words SET status = ? WHERE broadcaster_id = ? AND id = ?", [status, broadcasterId, id]);
  stateCache.delete(broadcasterId);
  if (!res.rowsAffected) return { ok: false, error: "That entry no longer exists." };
  return { ok: true, message: status === "active" ? "Entry is active — matching messages are banned." : status === "off" ? "Entry switched off (and won't be re-learned)." : "Entry moved back to suggestions." };
}

export async function deleteWord(broadcasterId: string, id: number): Promise<EditResult> {
  const res = await sqlite.execute("DELETE FROM autoban_words WHERE broadcaster_id = ? AND id = ?", [broadcasterId, id]);
  stateCache.delete(broadcasterId);
  return res.rowsAffected ? { ok: true, message: "Entry deleted. If it was learned, it can be learned again." } : { ok: false, error: "That entry no longer exists." };
}

export function sanitizeLogin(raw: string): string | null {
  const login = String(raw ?? "").trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(login) ? login : null;
}

export async function setUserIgnored(broadcasterId: string, rawLogin: string, ignored: boolean): Promise<EditResult> {
  const login = sanitizeLogin(rawLogin);
  if (!login) return { ok: false, error: "That isn't a valid Twitch username." };
  if (ignored) {
    await sqlite.execute("INSERT OR REPLACE INTO autoban_ignored (broadcaster_id, login, added_at) VALUES (?,?,?)", [broadcasterId, login, Date.now()]);
  } else {
    await sqlite.execute("DELETE FROM autoban_ignored WHERE broadcaster_id = ? AND login = ?", [broadcasterId, login]);
  }
  stateCache.delete(broadcasterId);
  return { ok: true, message: ignored ? `${login} is ignored — auto-ban will never touch them.` : `${login} is no longer ignored.` };
}

export async function setLearnMode(broadcasterId: string, mode: LearnMode): Promise<EditResult> {
  await ensureSeeded(broadcasterId);
  await sqlite.execute("UPDATE autoban_learn SET mode = ? WHERE broadcaster_id = ?", [mode, broadcasterId]);
  stateCache.delete(broadcasterId);
  return {
    ok: true,
    message: mode === "auto"
      ? "Learning is automatic: spam seen from several chatters starts being banned on its own."
      : mode === "suggest"
      ? "Learning is suggest-only: new spam patterns wait for a mod to approve them."
      : "Learning is off.",
  };
}

// ── Chat-path state (cached briefly; every chat message reads it) ──

interface ChannelState {
  active: Array<{ id: number; phrase: string }>;
  ignored: Set<string>;
  mode: LearnMode;
  loadedAt: number;
}
const STATE_TTL_MS = 30_000;
const stateCache = new Map<string, ChannelState>();

async function loadState(broadcasterId: string): Promise<ChannelState> {
  const hit = stateCache.get(broadcasterId);
  if (hit && Date.now() - hit.loadedAt < STATE_TTL_MS) return hit;
  const mode = await ensureSeeded(broadcasterId);
  const [words, ignored] = await Promise.all([
    sqlite.execute("SELECT id, phrase, status FROM autoban_words WHERE broadcaster_id = ?", [broadcasterId]),
    sqlite.execute("SELECT login FROM autoban_ignored WHERE broadcaster_id = ?", [broadcasterId]),
  ]);
  const state: ChannelState = {
    active: words.rows.filter((r: any) => r.status === "active").map((r: any) => ({ id: Number(r.id), phrase: String(r.phrase) })),
    ignored: new Set(ignored.rows.map((r: any) => String(r.login))),
    mode,
    loadedAt: Date.now(),
  };
  stateCache.set(broadcasterId, state);
  return state;
}

/** The learning mode, from the chat-path cache. */
export async function currentLearnMode(broadcasterId: string): Promise<LearnMode> {
  return (await loadState(broadcasterId)).mode;
}

export async function isUserIgnored(broadcasterId: string, login: string): Promise<boolean> {
  return (await loadState(broadcasterId)).ignored.has(login.toLowerCase());
}

/** The active phrase this message trips, if any. */
export async function findMatch(broadcasterId: string, chatMessage: string): Promise<{ id: number; phrase: string } | null> {
  const state = await loadState(broadcasterId);
  if (!state.active.length) return null;
  const normalized = normalizeText(chatMessage);
  const folded = fold(normalized);
  return state.active.find((w) => phraseMatches(normalized, w.phrase, folded)) ?? null;
}

export async function recordHit(broadcasterId: string, id: number) {
  await sqlite.execute("UPDATE autoban_words SET hits = hits + 1, last_hit_at = ? WHERE broadcaster_id = ? AND id = ?", [Date.now(), broadcasterId, id]);
}

/** After a ban: learn the message's domains as active phrases. */
export async function learnFromBannedMessage(broadcasterId: string, chatMessage: string, chatterId: string) {
  const state = await loadState(broadcasterId);
  if (state.mode === "off") return;
  const normalized = normalizeText(chatMessage);
  for (const domain of extractDomains(normalized)) {
    await upsertLearned(broadcasterId, domain, chatMessage, chatterId, "active");
  }
}

/** For a message that wasn't banned: if it reads like promo spam, record it
 * as a learned suggestion (and promote it once enough chatters send it). */
export async function learnFromMessage(broadcasterId: string, chatMessage: string, chatterId: string) {
  const normalized = normalizeText(chatMessage);
  const { score, domains } = spamScore(normalized);
  if (score < LEARN_THRESHOLD) return;
  const state = await loadState(broadcasterId);
  if (state.mode === "off") return;
  // Without a domain, the pitch itself is the key — minus @mentions, which
  // bots vary per target.
  const pitch = normalized.replace(/@\w+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_PITCH_LEN);
  const keys = domains.length ? domains : pitch.length >= MIN_LEARNED_MESSAGE_LEN ? [pitch] : [];
  for (const key of keys) await upsertLearned(broadcasterId, key, chatMessage, chatterId, "pending");
}

/** A message that matched the ban history in suggest-only mode: queue its
 * domains (or the pitch itself) as pending suggestions for a mod to review,
 * whatever its spam score. */
export async function suggestFromHistory(broadcasterId: string, chatMessage: string, chatterId: string) {
  const normalized = normalizeText(chatMessage);
  const domains = extractDomains(normalized);
  const pitch = normalized.replace(/@\w+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_PITCH_LEN);
  const keys = domains.length ? domains : pitch.length >= MIN_LEARNED_MESSAGE_LEN ? [pitch] : [];
  for (const key of keys) await upsertLearned(broadcasterId, key, chatMessage, chatterId, "pending");
}

async function upsertLearned(broadcasterId: string, phrase: string, example: string, chatterId: string, initial: WordStatus) {
  const res = await sqlite.execute("SELECT id, status, seen_by FROM autoban_words WHERE broadcaster_id = ? AND phrase = ?", [broadcasterId, phrase]);
  const ex = example.slice(0, MAX_EXAMPLE_LEN);
  if (!res.rows.length) {
    const count = await sqlite.execute("SELECT COUNT(*) AS n FROM autoban_words WHERE broadcaster_id = ?", [broadcasterId]);
    if (Number(count.rows[0]?.n ?? 0) >= MAX_PHRASES) return;
    await sqlite.execute(
      "INSERT OR IGNORE INTO autoban_words (broadcaster_id, phrase, source, status, seen_by, example, created_at) VALUES (?,?,?,?,?,?,?)",
      [broadcasterId, phrase, "learned", initial, chatterId, ex, Date.now()],
    );
    stateCache.delete(broadcasterId);
    return;
  }
  const row = res.rows[0];
  if (String(row.status) !== "pending") return; // active already, or a mod switched it off
  const seen = new Set(String(row.seen_by ?? "").split(",").filter(Boolean));
  seen.add(chatterId);
  const seenBy = [...seen].slice(-10).join(",");
  const mode = (await loadState(broadcasterId)).mode;
  const promote = initial === "active" || (mode === "auto" && seen.size >= LEARN_PROMOTE_CHATTERS);
  await sqlite.execute("UPDATE autoban_words SET seen_by = ?, example = ?, status = ? WHERE id = ?", [
    seenBy,
    ex,
    promote ? "active" : "pending",
    row.id,
  ]);
  if (promote) stateCache.delete(broadcasterId);
}

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
// Matching runs on a normalized copy of the message so the usual evasions
// collapse to one form: case, zero-width characters, a few look-alike
// letters, and spaced-out or spelled-out domains ("grow . com",
// "grow dot com", "grow(.)com" all become "grow.com").
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
export const MAX_PHRASE_LEN = 120;
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

const LOOKALIKES: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", // Cyrillic
};

/** Lowercase, strip zero-width/combining marks, collapse whitespace and
 * rejoin obfuscated domains. Digits are kept (domains and real words use
 * them); lookalikes are folded only in the separate `folded` form. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u200b-\u200f\u2060\ufeff]/g, "")
    .toLowerCase()
    // "grow dot com", "grow (dot) com", "grow [.] com", "grow . com" → "grow.com".
    // A bare ". " is left alone so sentence breaks ("thanks all. com...") don't
    // turn into domains.
    .replace(/(?:\s*[\(\[\{]\s*(?:\.|dot)\s*[\)\]\}]\s*|\s+(?:\.|dot)\s+)(?=(?:com|net|org|io|gg|tv|xyz|shop|store|site|online|live|pro|top|ru|cc|info|biz|app|link|click)\b)/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function fold(text: string): string {
  return text.replace(/[013457@$аеорсухі]/g, (c) => LOOKALIKES[c] ?? c);
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalizes a mod-entered phrase the same way messages are, so "AI  Viewers"
 * and "ai viewers" are one entry. Null if unusable. */
export function sanitizePhrase(raw: string): string | null {
  const p = normalizeText(String(raw ?? "")).slice(0, MAX_PHRASE_LEN).trim();
  if (p.length < MIN_PHRASE_LEN) return null;
  return p;
}

/** Whether the (already normalized) message contains the phrase as whole
 * words — checked against the plain and lookalike-folded forms. */
function phraseMatches(normalized: string, phrase: string): boolean {
  const re = (p: string) => new RegExp(`(?:^|[^a-z0-9])${escapeRe(p).replace(/ /g, "\\s*")}(?:$|[^a-z0-9])`);
  return re(phrase).test(normalized) || re(fold(phrase)).test(fold(normalized));
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
  const phrase = sanitizePhrase(raw);
  if (!phrase) return { ok: false, error: `A phrase needs at least ${MIN_PHRASE_LEN} characters.` };
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
  const phrase = sanitizePhrase(raw);
  if (!phrase) return { ok: false, error: `A phrase needs at least ${MIN_PHRASE_LEN} characters.` };
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

export async function isUserIgnored(broadcasterId: string, login: string): Promise<boolean> {
  return (await loadState(broadcasterId)).ignored.has(login.toLowerCase());
}

/** The active phrase this message trips, if any. */
export async function findMatch(broadcasterId: string, chatMessage: string): Promise<{ id: number; phrase: string } | null> {
  const state = await loadState(broadcasterId);
  if (!state.active.length) return null;
  const normalized = normalizeText(chatMessage);
  return state.active.find((w) => phraseMatches(normalized, w.phrase)) ?? null;
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
  const pitch = normalized.replace(/@\w+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_PHRASE_LEN);
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

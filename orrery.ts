// GuildScribe and the Grand Orrery: the bot's lore comes from the Orrery.
//
// The Grand Orrery (github.com/sheastolp/grand-orrery) is the universe
// GuildScribe's hall lives in: the Kingdom's capital, the Scribe, the
// peddlers, the arena, the Monster Wood. This module reads two of its files
// and its database live from GitHub and hands the rest of the bot what it
// needs:
//
//   lore.md      the condensed, decided lore (the same file the Wake in
//                Verrowen narrator reads). AI replies (the Scribe's @-tag
//                replies, the peddlers' !haggle, !npc characters) get the
//                parts that matter to them.
//   bestiary.md  GuildScribe's bestiary: the places fights happen (the arena
//                for duels, the market for !rob, hunting grounds by hero
//                level, the deep woods for raids), their flavor lines, and
//                Verrowen's own creatures with stat lines, which join every
//                channel's huntable roster.
//   the database who's who: the peddlers who work the stall (!stall,
//                !haggle, Hunt & Hoard) and each character's one line, which
//                a peddler's !haggle replies play to. It's the Orrery's
//                people as records (built from its roster.md, secrets taken
//                out), read with the Orrery's own client (ORRERY_CLIENT), so
//                the bot never parses the roster itself. The bot's own name
//                lists are only a fallback until the first good read.
//
// The Orrery is the source: when a name or a line changes there, the bot
// follows on its next check. Don't change universe content here first.
//
// Only decided lore reaches the bot: lore.md holds nothing else, and in
// bestiary.md only sections tagged "(Your idea)" (or "(DM lore)") count.
// Pitches wait on the Orrery's review page, as they do for the narrator.
//
// Settings (env):
//   ORRERY=off                 don't read the Orrery at all (fights and AI
//                              replies work exactly as before)
//   ORRERY_BRANCH=main         the branch to read (review shows what's
//                              waiting; main is the live Orrery)
//   ORRERY_RAW_BASE=…          default https://raw.githubusercontent.com/sheastolp/grand-orrery/
//   ORRERY_REFRESH_MIN=5       how often to check it for changes
//   ORRERY_REPO=sheastolp/grand-orrery   the repo, for finding the branch's
//                              newest commit (GitHub's API; a 304 "nothing
//                              changed" doesn't count against its limit)
//   ORRERY_GITHUB_TOKEN=…      optional, for a higher API limit
//
// Each check asks GitHub which commit the branch is on, and only when it
// moved reads the files at that exact commit, so a re-read right after a
// publish never gets the raw server's few-minutes-old copy. If the API
// can't be reached, it falls back to reading the branch's files directly.
// The database is checked the same way (the client asks which build the
// Orrery's data branch is on) on every check, even when the branch itself
// hasn't moved, since its build lands a minute after the publish.
//
// It stays current on its own: a timer re-reads it every few minutes even
// when nobody is fighting or chatting, and POST /api/orrery/refresh (which
// the Orrery's publish calls) re-reads it at once. GET /api/orrery
// (orrery_feed.ts) sends the other way: the hall's live adventurers,
// companies and learned beasts, which the Orrery page shows, plus
// orreryStatus() below, so the Orrery can see what GuildScribe last read.
//
// Everything here is best-effort: if GitHub can't be reached, the last good
// copy is kept, and before the first good read every getter returns nothing,
// so a fight or a reply never waits on or fails because of the Orrery.

import type { SoloMonster } from "./data.ts";
// The Orrery's client, pinned to a commit of grand-orrery: bump it to take a
// newer client. (The Discord bot's sync copies only ./ imports, so this URL
// reaches it unchanged.)
import { Orrery } from "https://cdn.jsdelivr.net/gh/sheastolp/grand-orrery@ebfa1a03d215e17cfbde0f05e9ba47c11c7879e2/client/orrery.js";

const ENABLED = (Deno.env.get("ORRERY") ?? "on").toLowerCase() !== "off";
const BRANCH = Deno.env.get("ORRERY_BRANCH") || "main";
const RAW_BASE = (Deno.env.get("ORRERY_RAW_BASE") || "https://raw.githubusercontent.com/sheastolp/grand-orrery/").replace(/\/?$/, "/");
const REFRESH_MS = Math.max(1, Number(Deno.env.get("ORRERY_REFRESH_MIN") ?? "5")) * 60_000;
// After a failed read, try again sooner than a full refresh.
const RETRY_MS = 2 * 60_000;
const REPO = Deno.env.get("ORRERY_REPO") || "sheastolp/grand-orrery";
const GH_TOKEN = Deno.env.get("ORRERY_GITHUB_TOKEN") || "";
const FETCH_TIMEOUT_MS = 8_000;

export type PlaceUse = "hunts" | "duels" | "robberies" | "raids";

export interface OrreryPlace {
  name: string;
  where: string;
  uses: PlaceUse[];
  levels: [number, number] | null;
  lines: string[];
}

export interface OrreryCreature {
  name: string;
  icon: string;
  place: string;
  /** Stat block in the bot's one-swing format, when the entry has a Stats line. */
  stats: SoloMonster | null;
  /** The bot's own monsters that count as this creature. */
  aliases: string[];
  does: string;
  story: string;
}

export interface OrreryBestiary {
  places: OrreryPlace[];
  creatures: OrreryCreature[];
}

export interface OrreryPerson {
  name: string;
  /** The ### heading it's listed under ("The Kingdom: GuildScribe", …). */
  group: string;
  /** Race, sex (and age) as the roster gives them. */
  race: string;
  role: string;
  /** "In a line" — never the Secret column. */
  line: string;
}

export interface OrreryRoster {
  people: OrreryPerson[];
  /** The peddlers by where they work, in roster order. */
  peddlers: { capital: string[]; road: string[] };
}

/** One record from the Orrery's database (entities.public.json): the fields
 * this bot uses. See grand-orrery's README, "The database". */
export interface OrreryEntity {
  id: string;
  type: string;
  name: string;
  /** For a person: the ### heading they're listed under. */
  section?: string;
  /** For a person: the table they're in, e.g. "The road peddlers". */
  group?: string;
  world?: string;
  kind?: string;
  race?: string;
  sex?: string;
  age?: number | string;
  role?: string;
  line?: string;
}

export interface OrreryLore {
  /** lore.md's LABEL: text lines, keyed by label (WORLD, BEYOND, …). */
  sections: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Parsing (pure, tested in orrery_test.ts)
// ---------------------------------------------------------------------------

const DECIDED = /\((?:Your idea|DM lore)\)\s*$/i;
const TAG = /\s*\((?:Your idea|DM lore|Pitch|Not decided yet)\)\s*$/i;

function crToValue(cr: string): number {
  const m = cr.match(/^(\d+)\s*\/\s*(\d+)$/);
  return m ? Number(m[1]) / Number(m[2]) : Number(cr);
}

/** "CR 2 · AC 13 · HP 45 · +5 to hit · 1d10+3" → a SoloMonster, or null.
 * Damage is one die (d4–d20) plus a bonus, like the rest of the roster; a
 * count of dice is folded into one die with the same average. */
export function parseStats(name: string, text: string): SoloMonster | null {
  const cr = text.match(/\bCR\s*(\d+(?:\s*\/\s*\d+)?)/i);
  const ac = text.match(/\bAC\s*(\d+)/i);
  const hp = text.match(/\bHP\s*(\d+)/i);
  const hit = text.match(/\+\s*(\d+)\s*to\s*hit/i);
  const dmg = text.match(/(\d*)\s*d\s*(\d+)\s*(?:\+\s*(\d+))?/i);
  if (!cr || !ac || !hp || !hit || !dmg) return null;
  const crText = cr[1].replace(/\s+/g, "");
  const crValue = crToValue(crText);
  if (!Number.isFinite(crValue)) return null;
  const count = Math.max(1, Number(dmg[1] || 1));
  const sides = Number(dmg[2]);
  let bonus = Number(dmg[3] || 0);
  let die = sides;
  if (count > 1) {
    // Same average from one die: count × (sides+1)/2 + bonus.
    const avg = count * (sides + 1) / 2 + bonus;
    die = Math.min(20, Math.max(4, sides * count));
    bonus = Math.max(0, Math.round(avg - (die + 1) / 2));
  }
  return { name, cr: crText, crValue, ac: Number(ac[1]), hp: Number(hp[1]), attack: Number(hit[1]), die, bonus };
}

function parseLevels(text: string): [number, number] | null {
  const m = text.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
  if (m) return [Math.min(Number(m[1]), Number(m[2])), Math.max(Number(m[1]), Number(m[2]))];
  const one = text.match(/(\d+)/);
  return one ? [Number(one[1]), Number(one[1])] : null;
}

const USES: PlaceUse[] = ["hunts", "duels", "robberies", "raids"];

/** Parse bestiary.md, keeping only decided places and the decided creatures
 * inside them. */
export function parseBestiary(md: string): OrreryBestiary {
  const places: OrreryPlace[] = [];
  const creatures: OrreryCreature[] = [];
  let place: OrreryPlace | null = null;
  let creature: (OrreryCreature & { statsText?: string }) | null = null;
  let inLines = false;

  const finishCreature = () => {
    if (creature && place) {
      creature.stats = creature.statsText ? parseStats(creature.name, creature.statsText) : null;
      delete creature.statsText;
      if (creature.stats || creature.aliases.length) creatures.push(creature);
    }
    creature = null;
  };

  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const h = line.match(/^(#{2,4})\s+(.*)$/);
    if (h) {
      inLines = false;
      if (h[1].length <= 3) {
        finishCreature();
        // A ## starts a place; a ### (a type grouping) keeps the place.
        if (h[1].length === 2) {
          place = DECIDED.test(h[2])
            ? { name: h[2].replace(TAG, "").trim(), where: "", uses: [], levels: null, lines: [] }
            : null;
          if (place) places.push(place);
        }
      } else {
        finishCreature();
        if (place && DECIDED.test(h[2])) {
          const title = h[2].replace(TAG, "").trim();
          const icon = title.match(/^(\p{Extended_Pictographic}️?)\s*/u);
          creature = {
            name: (icon ? title.slice(icon[0].length) : title).trim(),
            icon: icon ? icon[1] : "",
            place: place.name,
            stats: null,
            aliases: [],
            does: "",
            story: "",
          };
        }
      }
      continue;
    }
    const sub = line.match(/^\s{2,}[-*]\s+(.*)$/);
    if (sub && inLines && place && !creature) {
      place.lines.push(sub[1].trim());
      continue;
    }
    const b = line.match(/^[-*]\s+\*\*([^*:]+):?\*\*:?\s*(.*)$/);
    if (!b) continue;
    const key = b[1].trim().toLowerCase();
    const val = b[2].trim();
    inLines = false;
    if (creature) {
      if (key === "stats") creature.statsText = val.replace(/`/g, "");
      else if (key === "in guildscribe") creature.aliases = val.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
      else if (key === "does") creature.does = val;
      else if (key === "story") creature.story = val;
    } else if (place) {
      if (key === "where") place.where = val;
      else if (key === "for") place.uses = USES.filter((u) => new RegExp(`\\b${u}\\b`, "i").test(val));
      else if (key === "levels") place.levels = parseLevels(val);
      else if (key === "lines") inLines = true;
    }
  }
  finishCreature();
  return { places, creatures };
}

/** lore.md's "LABEL: text" lines. */
export function parseLore(md: string): OrreryLore {
  const sections: Record<string, string> = {};
  for (const line of md.replace(/\r/g, "").split("\n")) {
    const m = line.match(/^([A-Z][A-Z ()'&,.-]{1,60}?):\s+(.+)$/);
    if (m) sections[m[1].trim()] = (sections[m[1].trim()] ? sections[m[1].trim()] + " " : "") + m[2].trim();
  }
  return { sections };
}

const plain = (s: unknown) => String(s ?? "").replace(/\*+/g, "").trim();
const SEX: Record<string, string> = { male: "M", female: "F" };

/** The Orrery's people from its database records: everyone's name, group,
 * race, role and line (the public records carry no secrets, and none is
 * read here either), and the two peddler lists ("The capital peddlers" /
 * "The road peddlers"), in roster order. */
export function rosterFromEntities(entities: OrreryEntity[]): OrreryRoster {
  const people: OrreryPerson[] = [];
  const peddlers = { capital: [] as string[], road: [] as string[] };
  const worlds = new Map(entities.filter((e) => e.type === "world").map((e) => [e.id, e.name]));
  for (const e of entities) {
    // GuildScribe's adventurers are viewers' characters, not the Orrery's people.
    if (e.type !== "person" || e.kind === "adventurer" || !e.name) continue;
    const name = plain(e.name);
    const race = [e.race, e.sex ? SEX[e.sex] ?? e.sex : "", e.age].map(plain).filter(Boolean).join(", ");
    const group = e.section || (e.world ? worlds.get(e.world) ?? "" : "");
    people.push({ name, group, race, role: plain(e.role), line: plain(e.line) });
    const list = (e.group ?? "").match(/^The (capital|road) peddlers$/i);
    if (list) peddlers[list[1].toLowerCase() as "capital" | "road"].push(name);
  }
  return { people, peddlers };
}

// Secrets the chat bots shouldn't blurt out, even though they're decided.
const SECRET = /Lodestone|Murrow|secret|hides|doesn't know|isn't looking/i;
// A sentence that starts like this is about whoever the last one was about.
const CONTINUES = /^(?:He|She|They|It|Its|His|Her|Their|A tinkerer)\b/

/** Sentences of `text` that mention any of `words`, in order, within `max`
 * characters. A sentence that carries on from the one before ("He …") is
 * kept only with it, and secrets are left out. */
export function sentencesAbout(text: string, words: RegExp, max: number): string {
  const out: string[] = [];
  let len = 0;
  let lastKept = false;
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    const keep = (CONTINUES.test(s) ? lastKept : words.test(s)) && !SECRET.test(s);
    lastKept = keep;
    if (!keep) continue;
    if (len + s.length + 1 > max) break;
    out.push(s);
    len += s.length + 1;
  }
  return out.join(" ");
}

// ---------------------------------------------------------------------------
// The live copy
// ---------------------------------------------------------------------------

let bestiary: OrreryBestiary = { places: [], creatures: [] };
let lore: OrreryLore = { sections: {} };
let roster: OrreryRoster = { people: [], peddlers: { capital: [], road: [] } };
let loadedAt = 0;
let nextTryAt = 0;
let loading: Promise<void> | null = null;
// Per file: its ETag (for the "changed?" check), when its text last changed,
// and the last error, for orreryStatus().
const etags = new Map<string, string>();
const changedAt = new Map<string, number>();
const errors = new Map<string, string>();
// The commit the copy was read at, and the API's ETag for the branch head.
let sha = "";
let headTag = "";

/** The branch's newest commit, or null when it's the one we already have
 * ("" when the API couldn't say, so the caller reads the branch directly). */
async function branchHead(): Promise<string | null> {
  const headers: Record<string, string> = { Accept: "application/vnd.github.sha", "User-Agent": "GuildScribe" };
  if (headTag && sha) headers["If-None-Match"] = headTag;
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 304) { await res.body?.cancel(); return null; }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
    const head = (await res.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("not a commit");
    headTag = res.headers.get("etag") || "";
    return head === sha ? null : head;
  } catch (e) {
    errors.set("head", String(e));
    return "";
  }
}

/** The file's text (at commit `at`, or the branch's newest), or null when
 * it hasn't changed since the last read. */
async function fetchText(file: string, at = ""): Promise<string | null> {
  const headers: Record<string, string> = {};
  const tag = etags.get(file);
  if (tag) headers["If-None-Match"] = tag;
  const res = await fetch(`${RAW_BASE}${at || BRANCH}/${file}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 304) {
    await res.body?.cancel();
    return null;
  }
  if (res.status === 404) {
    // Not on this branch (yet): an empty file, not a failure.
    await res.body?.cancel();
    etags.delete(file);
    errors.set(file, `not on ${BRANCH} yet`);
    return "";
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  const etag = res.headers.get("etag");
  if (etag) etags.set(file, etag);
  changedAt.set(file, Date.now());
  return await res.text();
}

// The Orrery's database: its people, read with the Orrery's own client. The
// client is made on the first read (so a test that never reads makes no
// request) and refreshed only from load(), so there's one schedule.
const DB_FILE = "entities.public.json";
let db: Orrery | null = null;
/** fetch with this module's timeout and User-Agent, for the client. */
const timedFetch = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { "User-Agent": "GuildScribe", ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

/** Read the database if it has a new build. True when it was read fine. */
async function loadDatabase(): Promise<boolean> {
  let fresh: boolean;
  if (!db) {
    db = new Orrery({ repo: REPO, branch: BRANCH, refreshMinutes: 0, githubToken: GH_TOKEN || null, fetch: timedFetch });
    fresh = await db.ready();
  } else {
    fresh = await db.refresh();
  }
  if (fresh) {
    roster = rosterFromEntities(db.list());
    changedAt.set(DB_FILE, Date.now());
  }
  if (db.lastError) {
    errors.set(DB_FILE, db.lastError);
    console.error(`Orrery: ${DB_FILE} read failed`, db.lastError);
    return false;
  }
  errors.delete(DB_FILE);
  return true;
}

async function load(): Promise<void> {
  // The database first, and every time: its build lands a minute after a
  // publish, when the branch below has usually stopped moving.
  const [dbOk, head] = await Promise.all([loadDatabase(), branchHead()]);
  if (head === null) {
    // Nothing new on the branch since the last good read.
    errors.delete("head");
    loadedAt = Date.now();
    nextTryAt = Date.now() + (dbOk ? REFRESH_MS : RETRY_MS);
    return;
  }
  if (head) errors.delete("head");
  const files = ["bestiary.md", "lore.md"] as const;
  const results = await Promise.allSettled(files.map((f) => fetchText(f, head)));
  const allOk = results.every((r) => r.status === "fulfilled");
  if (head && allOk) sha = head;
  let ok = dbOk;
  results.forEach((r, i) => {
    const file = files[i];
    if (r.status === "rejected") {
      errors.set(file, String(r.reason));
      console.error(`Orrery: ${file} read failed`, String(r.reason));
      return;
    }
    ok = true;
    if (r.value) errors.delete(file);
    if (r.value === null) return;
    if (file === "bestiary.md") bestiary = parseBestiary(r.value);
    else lore = parseLore(r.value);
  });
  if (ok) loadedAt = Date.now();
  nextTryAt = Date.now() + (allOk && dbOk ? REFRESH_MS : RETRY_MS);
}

/** Start a refresh if the copy is stale. Never throws, never blocks. */
function refreshSoon(): Promise<void> {
  if (!ENABLED) return Promise.resolve();
  if (!loading && Date.now() >= nextTryAt) {
    loading = load().catch((e) => console.error("Orrery: read failed", e)).finally(() => { loading = null; });
  }
  return loading ?? Promise.resolve();
}

// Re-read on a timer too, so the Orrery's changes reach the bot even while
// nobody is using it. unrefTimer keeps the timer from holding a test (or a
// shutdown) open.
if (ENABLED && !Deno.env.get("ORRERY_NO_TIMER")) {
  const t = setInterval(() => { refreshSoon(); }, 60_000);
  try { Deno.unrefTimer(t); } catch { /* older Deno */ }
}

let lastForcedAt = 0;
/** Re-read the Orrery now (the Orrery's publish asks for this). At most
 * once every 30 seconds; returns false when it was asked too recently. */
export async function refreshOrreryNow(): Promise<boolean> {
  if (!ENABLED) return false;
  if (Date.now() - lastForcedAt < 30_000) return false;
  lastForcedAt = Date.now();
  if (loading) await loading;
  nextTryAt = 0;
  await refreshSoon();
  return true;
}

/** What the bot last read from the Orrery, for GET /api/orrery. */
export function orreryStatus() {
  const iso = (n: number | undefined) => n ? new Date(n).toISOString() : null;
  return {
    enabled: ENABLED,
    branch: BRANCH,
    commit: sha || null,
    checkedAt: iso(loadedAt),
    nextCheckAt: iso(nextTryAt),
    refreshMinutes: REFRESH_MS / 60_000,
    files: Object.fromEntries(["lore.md", "bestiary.md", DB_FILE].map((f) => [f, { changedAt: iso(changedAt.get(f)), error: errors.get(f) ?? null }])),
    headError: errors.get("head") ?? null,
    // The database build the people came from: the grand-orrery commit it
    // was built from, and when.
    database: db?.meta ? { commit: db.meta.commit ?? null, built: db.meta.built ?? null } : null,
    lore: Object.keys(lore.sections).length,
    places: bestiary.places.length,
    creatures: bestiary.creatures.length,
    people: roster.people.length,
    peddlers: roster.peddlers.capital.length + roster.peddlers.road.length,
  };
}

/** Wait (at most `ms`) for the first read, so the first fight after a
 * restart already has the Orrery's places and creatures. */
export async function ensureOrrery(ms = 3_000): Promise<void> {
  const p = refreshSoon();
  if (loadedAt) return;
  await Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
}

/** For tests: replace the live copy. */
export function setOrreryForTest(b: OrreryBestiary, l: OrreryLore = { sections: {} }, r?: OrreryRoster) {
  bestiary = b;
  lore = l;
  if (r) roster = r;
  loadedAt = Date.now();
  nextTryAt = Number.MAX_SAFE_INTEGER;
}

function pickOne<T>(items: T[]): T | undefined {
  return items.length ? items[Math.floor(Math.random() * items.length)] : undefined;
}

const keyOf = (s: string) => s.trim().toLowerCase();

// ---------------------------------------------------------------------------
// What the rest of the bot asks for
// ---------------------------------------------------------------------------

/** The Orrery's peddlers: "capital" (the market-square stall), "road" (the
 * Wandering Clerk's road), or "all". Empty before the first good read, so
 * callers keep their own list as a fallback. */
export function orreryPeddlers(where: "capital" | "road" | "all" = "all"): string[] {
  refreshSoon();
  const p = roster.peddlers;
  return where === "all" ? [...p.capital, ...p.road] : [...p[where]];
}

/** Someone from the Orrery's roster, by name (case-insensitive). */
export function orreryPerson(name: string): OrreryPerson | undefined {
  refreshSoon();
  const k = keyOf(name);
  return roster.people.find((p) => keyOf(p.name) === k);
}

/** A prompt sentence on who `name` is in the Orrery, or "". */
export function orreryPersonLine(name: string): string {
  const p = orreryPerson(name);
  if (!p || !p.line) return "";
  const who = [p.race, p.role].filter(Boolean).join(", ");
  return `In the Grand Orrery, ${p.name}${who ? ` (${who})` : ""}: ${p.line} Play to this.`;
}

/** Verrowen's huntable creatures (decided, with a stat line). */
export function orreryBeasts(): SoloMonster[] {
  refreshSoon();
  return bestiary.creatures.filter((c) => c.stats).map((c) => ({ ...c.stats! }));
}

/** The Orrery creature a bot monster is, by its own name or an alias. */
export function orreryCreature(monsterName: string): OrreryCreature | undefined {
  refreshSoon();
  const k = keyOf(monsterName);
  return bestiary.creatures.find((c) => keyOf(c.name) === k || c.aliases.some((a) => keyOf(a) === k));
}

export interface FightPlace {
  name: string;
  line: string;
}

function asFightPlace(p: OrreryPlace | undefined): FightPlace | null {
  if (!p) return null;
  return { name: p.name, line: pickOne(p.lines) ?? "" };
}

/** Where a fight against `monsterName` happens: the creature's own place
 * if it's one of Verrowen's, otherwise a place for `use` whose levels fit
 * `level` (or any place for `use`, nearest levels first). Null when the
 * Orrery has nothing for it. */
export function placeForMonster(monsterName: string, level: number, use: "hunts" | "raids" = "hunts"): FightPlace | null {
  refreshSoon();
  const own = orreryCreature(monsterName);
  if (own) {
    const p = bestiary.places.find((pl) => pl.name === own.place);
    if (p) return asFightPlace(p);
  }
  const candidates = bestiary.places.filter((p) => p.uses.includes(use));
  if (!candidates.length) return null;
  const fits = candidates.filter((p) => !p.levels || (level >= p.levels[0] && level <= p.levels[1]));
  if (fits.length) return asFightPlace(pickOne(fits));
  const dist = (p: OrreryPlace) => !p.levels ? 0 : level < p.levels[0] ? p.levels[0] - level : level - p.levels[1];
  return asFightPlace([...candidates].sort((a, b) => dist(a) - dist(b))[0]);
}

/** Where a duel or a robbery happens. */
export function placeFor(use: "duels" | "robberies"): FightPlace | null {
  refreshSoon();
  return asFightPlace(pickOne(bestiary.places.filter((p) => p.uses.includes(use))));
}

/** The name of the place a hero of `level` is hunting in, for the Orrery's
 * view of the hall (hall_time.ts). Unlike placeForMonster it doesn't pick
 * at random: `seed` (the hero) keeps the same hero in the same grounds for
 * the whole trip. Null when the Orrery has no hunting grounds. */
export function huntingGroundFor(level: number, seed: string): string | null {
  refreshSoon();
  const candidates = bestiary.places.filter((p) => p.uses.includes("hunts"));
  if (!candidates.length) return null;
  const fits = candidates.filter((p) => !p.levels || (level >= p.levels[0] && level <= p.levels[1]));
  const dist = (p: OrreryPlace) => !p.levels ? 0 : level < p.levels[0] ? p.levels[0] - level : level - p.levels[1];
  const pool = fits.length ? fits : [[...candidates].sort((a, b) => dist(a) - dist(b))[0]];
  let h = 0;
  for (const c of seed.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return pool[h % pool.length].name;
}

/** The first place the Orrery lists for `use` (the arena for duels), or null. */
export function placeNameFor(use: PlaceUse): string | null {
  refreshSoon();
  return bestiary.places.find((p) => p.uses.includes(use))?.name ?? null;
}

/** Where a creature lives, when it's one of Verrowen's own. */
export function homeOf(monsterName: string): string | null {
  return orreryCreature(monsterName)?.place ?? null;
}

/** "📍 Place — line" for a fight message, or "" when the Orrery has none. */
export function placeText(p: FightPlace | null): string {
  if (!p) return "";
  return p.line ? `📍 ${p.line}` : `📍 ${p.name}.`;
}

export type LoreFor = "scribe" | "peddler" | "npc";

const GUILD_WORDS = /GuildScribe|Scribe|guildscribe|adventurer|bount|arena|parchment|compan|Archives|draft|census/;
const PEDDLER_WORDS = /peddler|market|stall|Wandering Clerk|relic|merchant|Woodland Road|GuildScribe is/;
const WORLD_WORDS = /Monster Wood|corrupt Kingdom|GuildScribe is|blight|goblin|Woodland Road|divination/i;

/** A block of decided Orrery lore for an AI prompt, sized for small models,
 * or "" when there's none. */
export function orreryLoreFor(who: LoreFor, max = 1600): string {
  refreshSoon();
  const s = lore.sections;
  if (!Object.keys(s).length) return "";
  const parts: string[] = [];
  const add = (text: string | undefined) => { if (text) parts.push(text); };
  add(s["WORLD"] && sentencesAbout(s["WORLD"], /./, 240));
  add(s["TONE"]);
  add(s["MAGIC"] && sentencesAbout(s["MAGIC"], /./, 160));
  const beyond = s["BEYOND"] || "";
  const used = parts.join(" ").length;
  const room = Math.max(200, max - used);
  if (who === "scribe") add(sentencesAbout(beyond, GUILD_WORDS, room));
  else if (who === "peddler") add(sentencesAbout(beyond, PEDDLER_WORDS, room));
  else add(sentencesAbout(beyond, WORLD_WORDS, room));
  const text = parts.join(" ").slice(0, max);
  return text;
}

/** The sentence to add to a system prompt: the lore, and how to use it. */
export function orreryPromptLine(who: LoreFor, max = 1600): string {
  const text = orreryLoreFor(who, max);
  if (!text) return "";
  return `The world you live in is Verrowen, from the Grand Orrery. Draw on this lore when it fits, never contradict it, and don't recite it: ${text}`;
}

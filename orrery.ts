// GuildScribe and the Grand Orrery: the bot's lore comes from the Orrery.
//
// The Grand Orrery (github.com/sheastolp/grand-orrery) is the universe
// GuildScribe's hall lives in: the Kingdom's capital, the Scribe, the
// peddlers, the arena, the Monster Wood. Everything the bot knows of it comes
// from the Orrery's database: one record per thing, compiled from the
// Orrery's documents by its build and read with the Orrery's own client
// (ORRERY_CLIENT), the same way every Tavernworks app reads it. The bot never
// reads or parses the documents itself. From the database it takes:
//
//   lore         the narrator's lore lines (lore.md), the same ones Wake in
//                Verrowen's narrator reads. AI replies (the Scribe's @-tag
//                replies, the peddlers' !haggle, !npc characters) get the
//                parts that matter to them.
//   places and   GuildScribe's bestiary (bestiary.md): where fights happen
//   creatures    (the arena for duels, the market for !rob, hunting grounds
//                by hero level, the deep woods for raids), their flavor lines,
//                and Verrowen's own creatures with stat lines, which join
//                every channel's huntable roster.
//   items        the Orrery's items (resources.md). Every decided one with a
//                **Sold:** line is stock for the peddlers' stall (merchant.ts,
//                the hoard stall), at that price and bonus (gear.ts).
//   people       who's who (roster.md): the peddlers who work the stall
//                (!stall, !haggle, Hunt & Hoard) and each character's one
//                line, which a peddler's !haggle replies play to. The public
//                records carry no secrets.
//
// The bot's own lists are only a fallback until the first good read.
//
// The Orrery is the source: when a name, a line, a beast or a ware changes
// there, the bot follows on its next check. Don't change universe content
// here first.
//
// Only canon reaches the bot: records with status "decided" (Your idea) or
// "dm-lore". Pitches wait on the Orrery's review page, as they do for the
// narrator.
//
// Settings (env):
//   ORRERY=off                 don't read the Orrery at all (fights and AI
//                              replies work exactly as before)
//   ORRERY_BRANCH=main         the branch's database to read (review shows
//                              what's waiting; main is the live Orrery)
//   ORRERY_REFRESH_MIN=5       how often to check it for a new build
//   ORRERY_REPO=sheastolp/grand-orrery   the repo whose data branch holds it
//   ORRERY_GITHUB_TOKEN=…      optional, for a higher API limit
//
// Each check asks GitHub which build the Orrery's data branch is on (a 304
// "nothing changed" doesn't count against the API limit) and only reads it
// when it moved, at that exact commit, so a re-read right after a publish
// never gets a stale copy.
//
// It stays current on its own: a timer re-reads it every few minutes even
// when nobody is using the bot, and POST /api/orrery/refresh re-reads it at
// once: the Orrery's build calls it as soon as a new database is live, and
// the Orrery page's Reload button calls it too. GET /api/orrery
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
import { Orrery } from "https://cdn.jsdelivr.net/gh/sheastolp/grand-orrery@d36189e0b485d1db062b57d3182b5d6f3091654a/client/orrery.js";

const ENABLED = (Deno.env.get("ORRERY") ?? "on").toLowerCase() !== "off";
const BRANCH = Deno.env.get("ORRERY_BRANCH") || "main";
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
  status?: string;
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
  /** An item's or creature's icon. */
  icon?: string;
  /** For an item: its ## category in resources.md ("Peddlers' wares" …). */
  category?: string;
  /** For a creature: the id of the place it's found in. */
  place?: string;
  /** For a place: what happens there ("hunts", "duels" …). */
  uses?: string[];
  /** For a place: its flavor lines. */
  lines?: string[];
  /** For a lore line: the text after its label, and its place in lore.md. */
  text?: string;
  order?: number;
  /** "- **Field:** value" bullets, keyed by the field in snake_case. */
  fields?: Record<string, string | string[]>;
}

/** A ware for the stall: a decided item with a **Sold:** line. Shaped like
 * gear.ts's MerchantItem, so the stall can sell it as it is. */
export interface OrreryWare {
  /** The item's name, which is also what goes on the buyer's sheet. */
  name: string;
  icon: string;
  /** The **Pitch:** line (or the item's name, lowercased, without one). */
  desc: string;
  price: string;
  effect: { scores?: Partial<Record<"STR" | "DEX" | "CON" | "INT" | "WIS" | "CHA", number>>; hp?: number; speed?: number };
  /** "· relic" on the Sold line: a rare find, not the usual stock. */
  relic: boolean;
}

export interface OrreryLore {
  /** lore.md's LABEL: text lines, keyed by label (WORLD, BEYOND, …). */
  sections: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Reading the database's records (pure, tested in orrery_test.ts)
// ---------------------------------------------------------------------------

/** Canon: a decided record, or the DM's lore. Pitches and open ideas aren't. */
const isCanon = (e: OrreryEntity) => e.status === "decided" || e.status === "dm-lore";
const field = (e: OrreryEntity, k: string) => {
  const v = e.fields?.[k];
  return (Array.isArray(v) ? v.join(", ") : String(v ?? "")).trim();
};

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

/** The bestiary from the database: the decided places fights happen, and the
 * decided creatures in them (those with a stat line, or that some of the
 * bot's own monsters count as). A creature in a pitched place stays out. */
export function bestiaryFromEntities(entities: OrreryEntity[]): OrreryBestiary {
  const places: OrreryPlace[] = [];
  const byId = new Map<string, OrreryPlace>();
  for (const e of entities) {
    if (e.type !== "place" || !isCanon(e)) continue;
    const forText = [field(e, "for"), ...(e.uses ?? [])].join(", ");
    const p: OrreryPlace = {
      name: e.name,
      where: field(e, "where"),
      uses: USES.filter((u) => new RegExp(`\\b${u}\\b`, "i").test(forText)),
      levels: parseLevels(field(e, "levels")),
      lines: [...(e.lines ?? [])],
    };
    places.push(p);
    byId.set(e.id, p);
  }
  const creatures: OrreryCreature[] = [];
  for (const e of entities) {
    if (e.type !== "creature" || !isCanon(e)) continue;
    const place = e.place ? byId.get(e.place) : undefined;
    if (!place) continue;
    const statsText = field(e, "stats").replace(/`/g, "");
    const c: OrreryCreature = {
      name: e.name,
      icon: e.icon ?? "",
      place: place.name,
      stats: statsText ? parseStats(e.name, statsText) : null,
      aliases: field(e, "in_guildscribe").split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean),
      does: field(e, "does"),
      story: field(e, "story"),
    };
    if (c.stats || c.aliases.length) creatures.push(c);
  }
  return { places, creatures };
}

/** The narrator's lore lines, keyed by label (WORLD, BEYOND, …), in order. */
export function loreFromEntities(entities: OrreryEntity[]): OrreryLore {
  const sections: Record<string, string> = {};
  const lines = entities.filter((e) => e.type === "lore" && e.text).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const l of lines) {
    const k = l.name.trim();
    sections[k] = (sections[k] ? sections[k] + " " : "") + String(l.text).trim();
  }
  return { sections };
}

const PRICE = /^\d+\s*(?:gold|silver|copper)(?:\s+\d+\s*(?:gold|silver|copper))*$/i;

/** "3 copper · +1 CON" / "90 gold · +2 CON, +5 max HP · relic" → its
 * price, bonus and whether it's a relic, or null without a price. */
export function parseSold(text: string): Pick<OrreryWare, "price" | "effect" | "relic"> | null {
  let price = "";
  let relic = false;
  const effect: OrreryWare["effect"] = {};
  for (const part of text.replace(/`/g, "").split(/\s*[·|]\s*/)) {
    const p = part.trim();
    if (!p) continue;
    if (!price && PRICE.test(p)) { price = p.replace(/\s+/g, " "); continue; }
    if (/^(?:rare\s+)?relic$/i.test(p)) { relic = true; continue; }
    for (const m of p.matchAll(/\+\s*(\d+)\s*(STR|DEX|CON|INT|WIS|CHA)\b/gi)) {
      const a = m[2].toUpperCase() as "STR" | "DEX" | "CON" | "INT" | "WIS" | "CHA";
      const scores = effect.scores ??= {};
      scores[a] = (scores[a] ?? 0) + Number(m[1]);
    }
    const hp = p.match(/\+\s*(\d+)\s*max\s*HP/i);
    if (hp) effect.hp = (effect.hp ?? 0) + Number(hp[1]);
    const sp = p.match(/\+\s*(\d+)\s*ft\.?\s*speed/i);
    if (sp) effect.speed = (effect.speed ?? 0) + Number(sp[1]);
  }
  return price ? { price, effect, relic } : null;
}

/** The stall's stock from the database: decided items with a **Sold:** line,
 * once per name and per pitch (a listing is matched by its pitch). */
export function waresFromEntities(entities: OrreryEntity[]): OrreryWare[] {
  const names = new Set<string>(), pitches = new Set<string>();
  const out: OrreryWare[] = [];
  for (const e of entities) {
    if (e.type !== "item" || !isCanon(e)) continue;
    const sold = parseSold(field(e, "sold"));
    if (!sold) continue;
    const w: OrreryWare = { name: e.name.trim(), icon: e.icon ?? "", desc: field(e, "pitch") || e.name.trim().toLowerCase(), ...sold };
    const n = w.name.toLowerCase(), d = w.desc.toLowerCase();
    if (!w.name || names.has(n) || pitches.has(d)) continue;
    names.add(n);
    pitches.add(d);
    out.push(w);
  }
  return out;
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
let wares: OrreryWare[] = [];
let loadedAt = 0;
let changedAt = 0;
let nextTryAt = 0;
let loading: Promise<void> | null = null;
let lastError: string | null = null;

// The Orrery's database, read with the Orrery's own client. The client is
// made on the first read (so a test that never reads makes no request) and
// refreshed only from load(), so there's one schedule.
const DB_FILE = "entities.public.json";
let db: Orrery | null = null;
/** fetch with this module's timeout and User-Agent, for the client. */
const timedFetch = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { "User-Agent": "GuildScribe", ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

/** Everything the bot uses, from the database's records. */
function useEntities(entities: OrreryEntity[]) {
  roster = rosterFromEntities(entities);
  bestiary = bestiaryFromEntities(entities);
  lore = loreFromEntities(entities);
  wares = waresFromEntities(entities);
}

async function load(): Promise<void> {
  let fresh: boolean;
  if (!db) {
    db = new Orrery({ repo: REPO, branch: BRANCH, refreshMinutes: 0, githubToken: GH_TOKEN || null, fetch: timedFetch });
    fresh = await db.ready();
  } else {
    fresh = await db.refresh();
  }
  if (fresh) {
    useEntities(db.list() as OrreryEntity[]);
    changedAt = Date.now();
  }
  lastError = db.lastError;
  if (lastError) console.error(`Orrery: ${DB_FILE} read failed`, lastError);
  // A failed check keeps the last good copy and tries again sooner.
  if (db.lastRead) loadedAt = db.lastRead.getTime();
  nextTryAt = Date.now() + (lastError ? RETRY_MS : REFRESH_MS);
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
/** Re-read the Orrery now (the Orrery's build asks for this once a new
 * database is live). At most once every 30 seconds; returns false when it
 * was asked too recently. */
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
  // A time far past any real one (the tests' "never") is null, not a throw.
  const iso = (n: number | undefined) => n && n < 8.64e15 ? new Date(n).toISOString() : null;
  return {
    enabled: ENABLED,
    branch: BRANCH,
    // The grand-orrery commit the database was built from.
    commit: db?.meta?.commit ?? null,
    checkedAt: iso(loadedAt),
    nextCheckAt: iso(nextTryAt),
    refreshMinutes: REFRESH_MS / 60_000,
    files: { [DB_FILE]: { changedAt: iso(changedAt), error: lastError } },
    headError: null,
    database: db?.meta ? { commit: db.meta.commit ?? null, built: db.meta.built ?? null } : null,
    lore: Object.keys(lore.sections).length,
    places: bestiary.places.length,
    creatures: bestiary.creatures.length,
    people: roster.people.length,
    peddlers: roster.peddlers.capital.length + roster.peddlers.road.length,
    wares: wares.filter((w) => !w.relic).length,
    relics: wares.filter((w) => w.relic).length,
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
export function setOrreryForTest(b: OrreryBestiary, l: OrreryLore = { sections: {} }, r?: OrreryRoster, w?: OrreryWare[]) {
  bestiary = b;
  lore = l;
  if (r) roster = r;
  if (w) wares = w;
  loadedAt = Date.now();
  nextTryAt = Number.MAX_SAFE_INTEGER;
}

/** For tests: use these database records, as a read would. */
export function setOrreryEntitiesForTest(entities: OrreryEntity[]) {
  useEntities(entities);
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

/** The peddlers' stall stock: the Orrery's decided items with a **Sold:**
 * line, or [] before the first read or when it has none. */
export function orreryWares(): OrreryWare[] {
  refreshSoon();
  return wares;
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

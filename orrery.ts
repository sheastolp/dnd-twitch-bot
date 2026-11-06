// GuildScribe and the Grand Orrery: the bot's lore comes from the Orrery.
//
// The Grand Orrery (github.com/sheastolp/grand-orrery) is the universe
// GuildScribe's hall lives in: the Kingdom's capital, the Scribe, the
// peddlers, the arena, the Monster Wood. This module reads two of its files
// live from GitHub and hands the rest of the bot what it needs:
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
//   ORRERY_REFRESH_MIN=30      how often to re-read it
//
// Everything here is best-effort: if GitHub can't be reached, the last good
// copy is kept, and before the first good read every getter returns nothing,
// so a fight or a reply never waits on or fails because of the Orrery.

import type { SoloMonster } from "./data.ts";

const ENABLED = (Deno.env.get("ORRERY") ?? "on").toLowerCase() !== "off";
const BRANCH = Deno.env.get("ORRERY_BRANCH") || "main";
const RAW_BASE = (Deno.env.get("ORRERY_RAW_BASE") || "https://raw.githubusercontent.com/sheastolp/grand-orrery/").replace(/\/?$/, "/");
const REFRESH_MS = Math.max(1, Number(Deno.env.get("ORRERY_REFRESH_MIN") ?? "30")) * 60_000;
// After a failed read, try again sooner than a full refresh.
const RETRY_MS = 2 * 60_000;
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
let loadedAt = 0;
let nextTryAt = 0;
let loading: Promise<void> | null = null;

async function fetchText(file: string): Promise<string> {
  const res = await fetch(`${RAW_BASE}${BRANCH}/${file}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.text();
}

async function load(): Promise<void> {
  const [b, l] = await Promise.allSettled([fetchText("bestiary.md"), fetchText("lore.md")]);
  let ok = false;
  if (b.status === "fulfilled") { bestiary = parseBestiary(b.value); ok = true; }
  else console.error("Orrery: bestiary.md read failed", String(b.reason));
  if (l.status === "fulfilled") { lore = parseLore(l.value); ok = true; }
  else console.error("Orrery: lore.md read failed", String(l.reason));
  if (ok) loadedAt = Date.now();
  nextTryAt = Date.now() + (b.status === "fulfilled" && l.status === "fulfilled" ? REFRESH_MS : RETRY_MS);
}

/** Start a refresh if the copy is stale. Never throws, never blocks. */
function refreshSoon(): Promise<void> {
  if (!ENABLED) return Promise.resolve();
  if (!loading && Date.now() >= nextTryAt) {
    loading = load().catch((e) => console.error("Orrery: read failed", e)).finally(() => { loading = null; });
  }
  return loading ?? Promise.resolve();
}

/** Wait (at most `ms`) for the first read, so the first fight after a
 * restart already has the Orrery's places and creatures. */
export async function ensureOrrery(ms = 3_000): Promise<void> {
  const p = refreshSoon();
  if (loadedAt) return;
  await Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
}

/** For tests: replace the live copy. */
export function setOrreryForTest(b: OrreryBestiary, l: OrreryLore = { sections: {} }) {
  bestiary = b;
  lore = l;
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

// Tom Clancy's The Division 2 companion — !div2, !div2build, !div2loot,
// !div2mission, !div2lookup
//
// Standalone, like bg3.ts/bg3lookup.ts: no DB, no external API. Generators
// roll from the pools in division2data.ts and the lookup searches its
// hand-curated knowledgebase. Every reply is one chat message.

import {
  DIV2_BRAND_POOL,
  DIV2_CATEGORY_ALIASES,
  DIV2_CATEGORY_LABELS,
  DIV2_EXOTIC_POOL,
  DIV2_GEARSET_POOL,
  DIV2_KNOWLEDGEBASE,
  DIV2_SKILL_VARIANTS,
  DIV2_SPECS,
  DIV2_WEAPON_CLASSES,
  type Div2Category,
  type Div2Entry,
} from "./division2data.ts";
import { compactText, pick } from "./utils.ts";

/** Picks `n` distinct entries from `list` (fewer if the list is shorter). */
function pickDistinct<T>(list: readonly T[], n: number): T[] {
  const pool = [...list];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

// ---------------------------------------------------------------------------
// !div2 — the module's command list
// ---------------------------------------------------------------------------

export function div2Index(display: string): string {
  return `@${display} 🟠 Division 2 companion: !div2build (random agent build) | !div2loot (open a drop) | !div2mission (pick tonight's activity + a challenge) | !div2lookup <name> (gear sets, brands, exotics, skills, specs, factions, places, modes — e.g. !div2lookup striker)`;
}

// ---------------------------------------------------------------------------
// !div2build — random agent build
// ---------------------------------------------------------------------------

const DIV2_BUILD_FOCUS = [
  { core: "🔴 Weapon Damage", label: "red DPS" },
  { core: "🔵 Armor", label: "blue tank" },
  { core: "🟡 Skill Tier", label: "yellow skill" },
];

const DIV2_BUILD_HOOKS = [
  "ISAC already disapproves.",
  "Perfect for a Heroic run, says nobody who tried it.",
  "Commit to it for one whole mission. No swapping.",
  "The Black Tusk will never see it coming. Mostly because it's weird.",
  "Theorycrafters hate this one simple trick.",
  "Run it in the Dark Zone and report back. If you extract.",
  "Optimal? No. Fun? Absolutely.",
  "Manny Ortega signed off on this. He was distracted.",
];

/** Rolls a random Division 2 agent build, formatted as one chat message. */
export function rollDiv2Build(display: string): string {
  const spec = pick(DIV2_SPECS);
  const [primary, secondary] = pickDistinct(DIV2_WEAPON_CLASSES, 2);
  const focus = pick(DIV2_BUILD_FOCUS);
  // Half the time a 4-piece gear set, otherwise a brand-set mix.
  const gear = Math.random() < 0.5
    ? `${pick(DIV2_GEARSET_POOL)} 4pc`
    : `${pickDistinct(DIV2_BRAND_POOL, 2).join(" + ")} brand mix`;
  const exotic = pick(DIV2_EXOTIC_POOL);
  const skills = pickDistinct(Object.keys(DIV2_SKILL_VARIANTS), 2)
    .map((s) => `${pick(DIV2_SKILL_VARIANTS[s])} ${s}`)
    .join(" + ");
  return `@${display} 🟠 Agent build (${focus.label}): ${spec.name} (${spec.weapon}) | Primary: ${primary} · Secondary: ${secondary} | Gear: ${gear}, ${focus.core} cores, exotic: ${exotic} | Skills: ${skills}. ${pick(DIV2_BUILD_HOOKS)}`;
}

// ---------------------------------------------------------------------------
// !div2loot — open a drop, Division 2 rarity tiers
// ---------------------------------------------------------------------------

type Div2Rarity = "Superior" | "High-End" | "Named" | "Gear Set" | "Exotic";

const DIV2_RARITY_ICON: Record<Div2Rarity, string> = {
  Superior: "🟣",
  "High-End": "🟡",
  Named: "🟡✨",
  "Gear Set": "🟢",
  Exotic: "🟠",
};

const DIV2_SLOTS = ["Mask", "Backpack", "Chest", "Gloves", "Holster", "Kneepads"];

const DIV2_LOOT_FLAVOR: Record<Div2Rarity, string[]> = {
  Superior: ["Straight to the deconstruct pile.", "ISAC: 'Item recalibration not recommended.'", "Purple. In this economy?"],
  "High-End": ["Rolled… fine. Off to the recalibration station.", "Decent attributes, wrong talent. Classic.", "Checking for a god roll… nope, but close."],
  Named: ["A named piece with its perfect talent — that's a keeper.", "Named item! Save it for the library.", "Shiny yellow with a perfect talent. Nice."],
  "Gear Set": ["One piece closer to the 4pc.", "Green! Now for the other three.", "The set bonus is calling."],
  Exotic: ["The orange beam. The legendary orange beam.", "Chat, we're so back.", "That's a clip for the highlight reel."],
};

// Weighted so exotics stay exciting: Superior 25% / High-End 40% / Named 13% / Gear Set 17% / Exotic 5%.
function rollDiv2Rarity(): Div2Rarity {
  const roll = Math.random() * 100;
  if (roll < 25) return "Superior";
  if (roll < 65) return "High-End";
  if (roll < 78) return "Named";
  if (roll < 95) return "Gear Set";
  return "Exotic";
}

/** Rolls a random loot drop with a Division 2 rarity tier, formatted as one chat message. */
export function rollDiv2Loot(display: string): string {
  const rarity = rollDiv2Rarity();
  let item: string;
  if (rarity === "Exotic") item = pick(DIV2_EXOTIC_POOL);
  else if (rarity === "Gear Set") item = `${pick(DIV2_GEARSET_POOL)} ${pick(DIV2_SLOTS)}`;
  else if (rarity === "Named") item = `named ${pick(DIV2_SLOTS).toLowerCase()} (perfect talent)`;
  else item = `${pick(DIV2_BRAND_POOL)} ${pick(DIV2_SLOTS)}`;
  return `@${display} 📦 Loot drop: ${DIV2_RARITY_ICON[rarity]} [${rarity}] ${item} — ${pick(DIV2_LOOT_FLAVOR[rarity])}`;
}

// ---------------------------------------------------------------------------
// !div2mission — what to play tonight, plus a self-imposed challenge
// ---------------------------------------------------------------------------

const DIV2_ACTIVITIES = [
  "a Stronghold (Capitol Building, Tidal Basin, Roosevelt Island or District Union Arena)",
  "the Grand Washington Hotel mission",
  "a Dark Zone run — extract or it didn't happen",
  "Countdown at Camp White Oak",
  "ten floors of The Summit",
  "a Descent run",
  "this week's Manhunt target",
  "Conflict — Domination",
  "a Lower Manhattan mission in Warlords of New York",
  "a Brooklyn mission",
  "control points — take three back from the factions",
  "a raid attempt: Dark Hours or Iron Horse",
  "bounties around D.C.",
];

const DIV2_DIFFICULTIES = ["Normal", "Hard", "Challenging", "Heroic", "Legendary"];

const DIV2_CHALLENGES = [
  "Pistols only.",
  "No armor kits — skills and cover are your healing.",
  "Signature weapon whenever it's loaded.",
  "Shotguns and marksman rifles only.",
  "No skills allowed.",
  "Everything you pick up, you equip. Everything.",
  "Chat picks your primary weapon.",
  "Every death costs the streamer a push-up.",
  "Blind fire only around corners. It's tactical.",
  "No challenge. Just vibes and headshots.",
];

/** Rolls tonight's activity, difficulty and challenge, formatted as one chat message. */
export function rollDiv2Mission(display: string): string {
  return `@${display} 🗺️ Tonight's op: ${pick(DIV2_ACTIVITIES)} on ${pick(DIV2_DIFFICULTIES)}. Challenge: ${pick(DIV2_CHALLENGES)}`;
}

// ---------------------------------------------------------------------------
// !div2lookup — knowledgebase search
// ---------------------------------------------------------------------------

function comparable(value: string): string {
  return value.toLowerCase().replace(/['’]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
}

/** Public Division wiki search link for chat — no scraping, just a jump-off point. */
export function div2WikiLink(name: string): string {
  return `https://thedivision.fandom.com/wiki/Special:Search?query=${encodeURIComponent(name)}`;
}

/**
 * Splits "!div2lookup <query>" into an optional leading category keyword and
 * the remaining search text, e.g. "exotic eagle bearer" -> category "exotic",
 * query "eagle bearer". Falls back to an unfiltered search otherwise.
 */
export function parseDiv2LookupQuery(raw: string): { category: Div2Category | null; query: string } {
  const trimmed = raw.trim();
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace > 0) {
    const resolved = DIV2_CATEGORY_ALIASES[trimmed.slice(0, firstSpace).toLowerCase()];
    if (resolved) return { category: resolved, query: trimmed.slice(firstSpace + 1).trim() };
  }
  return { category: null, query: trimmed };
}

/** Finds the best matching knowledgebase entry for a chat query, optionally scoped to one category. */
export function findDiv2Entry(query: string, category: Div2Category | null = null): Div2Entry | null {
  if (!query || query.length > 60) return null;
  const wanted = comparable(query);
  if (!wanted) return null;
  const pool = category ? DIV2_KNOWLEDGEBASE.filter((e) => e.category === category) : DIV2_KNOWLEDGEBASE;
  const names = (e: Div2Entry) => [e.name, ...(e.aliases ?? [])].map(comparable);

  const exact = pool.find((e) => names(e).includes(wanted));
  if (exact) return exact;
  // Partial matches need 3+ characters so "a" doesn't hit the first entry.
  if (wanted.length < 3) return null;
  return pool.find((e) => names(e).some((n) => n.includes(wanted) || wanted.includes(n))) ?? null;
}

/** Formats a knowledgebase entry as a single chat-ready string. */
export function formatDiv2Entry(entry: Div2Entry): string {
  return `🔗 ${div2WikiLink(entry.name)} | [${DIV2_CATEGORY_LABELS[entry.category]}] ${entry.name}: ${compactText(entry.summary, 400)}`;
}

/** Comma-separated list of recognized category keywords, for usage text. */
export function div2CategoryList(): string {
  return Object.keys(DIV2_CATEGORY_LABELS).join(", ");
}

/** Full chat reply for `!div2lookup <raw>`. */
export function div2LookupReply(display: string, raw: string): string {
  if (!raw) {
    return `@${display} Usage: !div2lookup <name>, e.g. !div2lookup striker or !div2lookup eagle bearer. Narrow by category with !div2lookup <category> <name> (e.g. !div2lookup skill turret). Categories: ${div2CategoryList()}`;
  }
  const { category, query } = parseDiv2LookupQuery(raw);
  const entry = findDiv2Entry(query, category);
  return entry
    ? `@${display} ${formatDiv2Entry(entry)}`
    : `@${display} couldn't find "${query}" in the Division 2 knowledgebase. Try e.g. !div2lookup heartbreaker, !div2lookup black tusk, or !div2lookup spec gunner`;
}

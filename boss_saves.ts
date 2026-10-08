// GuildScribe — the bot's own saving throw modifiers for !save <stat>. The bot
// rolls as this stream's raid boss (raid.ts), adding the boss's save bonus for
// that ability. Where the bonuses come from, best first:
//   1. BOSS_SAVES below: the official stat blocks of the core bestiary's raid
//      bosses, most of which (Beholder, Strahd, Death Knight, …) aren't in
//      the free SRD API.
//   2. The SRD API (dnd5eapi.co) — covers monsters the channel's bestiary
//      learned from !monster: proficient saves from the stat block,
//      otherwise the ability modifier. Cached per monster.
//   3. An estimate from the boss's CR and attack bonus, so a boss nobody can
//      look up still saves like a monster of its level.
// With no raid boss posted the bot rolls a plain d20 (+0).
//
// Never throws — a missing stat block must not break a roll.

import { getRaidQuest } from "./raid.ts";
import { lookup5e } from "./lookups.ts";
import { modifier } from "./utils.ts";
import type { Ability } from "./types.ts";

export type BossSaves = { name: string; mods: Record<Ability, number>; estimated: boolean };

/** [STR, DEX, CON, INT, WIS, CHA] save bonuses from the official stat blocks. */
const BOSS_SAVES: Record<string, [number, number, number, number, number, number]> = {
  // CR 13–17, the default raid pool (RAID_MIN_CR 13).
  "beholder": [0, 2, 4, 8, 7, 8],
  "xanathar": [0, 2, 4, 8, 7, 8],
  "adult white dragon": [6, 5, 11, -1, 6, 6],
  "adult brass dragon": [6, 5, 10, 2, 6, 8],
  "vampire lord": [4, 9, 4, 3, 7, 9],
  "nalfeshnee": [5, 0, 11, 9, 6, 7],
  "storm giant": [14, 2, 10, 3, 9, 9],
  "death tyrant": [5, 2, 7, 9, 7, 9],
  "adult black dragon": [6, 7, 10, 2, 6, 8],
  "adult copper dragon": [6, 6, 10, 4, 7, 8],
  "elder brain": [2, 0, 5, 10, 9, 12],
  "ice devil": [5, 7, 9, 4, 7, 9],
  "adult green dragon": [6, 6, 10, 4, 7, 8],
  "adult bronze dragon": [7, 5, 11, 3, 7, 9],
  "strahd von zarovich": [4, 9, 4, 5, 7, 9],
  "mummy lord": [4, 0, 8, 5, 9, 8],
  "adult blue dragon": [7, 5, 11, 3, 7, 9],
  "adult silver dragon": [8, 5, 12, 3, 6, 10],
  "marilith": [9, 5, 10, 4, 8, 10],
  "adult red dragon": [8, 6, 13, 3, 7, 11],
  "adult gold dragon": [8, 8, 13, 3, 8, 13],
  "dragon turtle": [7, 6, 11, 0, 7, 1],
  "death knight": [5, 6, 5, 1, 9, 10],
};

const ABILITIES: Ability[] = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];
const SCORE_FIELDS: Record<Ability, string> = {
  STR: "strength",
  DEX: "dexterity",
  CON: "constitution",
  INT: "intelligence",
  WIS: "wisdom",
  CHA: "charisma",
};

const key = (name: string) => name.toLowerCase().replace(/\s*\(.*?\)\s*/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/** API stat blocks by monster key; null when the API had no such monster. */
const apiCache = new Map<string, Promise<Record<Ability, number> | null>>();

async function fetchSaveMods(name: string): Promise<Record<Ability, number> | null> {
  const data = await lookup5e("monster", name);
  // Only trust an exact name match: the API's fuzzy fallback can land on a
  // different monster ("Vampire Lord" → "Vampire Spawn").
  if (!data || typeof data.strength !== "number" || key(String(data.name ?? "")) !== key(name)) return null;
  const mods = {} as Record<Ability, number>;
  for (const ability of ABILITIES) {
    const prof = (data.proficiencies ?? []).find((p: any) => p?.proficiency?.index === `saving-throw-${ability.toLowerCase()}`);
    mods[ability] = typeof prof?.value === "number" ? prof.value : modifier(Number(data[SCORE_FIELDS[ability]] ?? 10));
  }
  return mods;
}

function apiSaveMods(name: string): Promise<Record<Ability, number> | null> {
  const k = key(name);
  let pending = apiCache.get(k);
  if (!pending) {
    pending = fetchSaveMods(name);
    apiCache.set(k, pending);
    // A failed fetch (API down) is retried next time rather than cached.
    pending.catch(() => apiCache.delete(k));
  }
  return pending;
}

/** 5e proficiency bonus for a CR like "13" or "1/2". */
function profForCr(cr: string): number {
  const [a, b] = String(cr).split("/").map(Number);
  const value = b ? a / b : a || 0;
  return 2 + Math.floor(Math.max(0, Math.ceil(value) - 1) / 4);
}

/** A boss nobody can look up: its attack bonus minus proficiency is its main
 * (physical) ability modifier; it's proficient in CON and WIS like most big
 * monsters, and its mental scores trail its physical ones. */
function estimateSaveMods(cr: string, attack: number): Record<Ability, number> {
  const prof = profForCr(cr);
  const main = Math.max(0, Math.min(10, attack - prof));
  const mental = Math.floor(main / 2);
  return { STR: main, DEX: mental, CON: main + prof, INT: mental, WIS: mental + prof, CHA: mental };
}

/** This stream's raid boss and its save bonuses, or null to roll a plain d20. */
export async function getBossSaves(broadcasterId: string): Promise<BossSaves | null> {
  try {
    const quest = await getRaidQuest(broadcasterId);
    const name = quest?.monster_name;
    if (!quest || !name) return null;
    const table = BOSS_SAVES[key(name)];
    if (table) return { name, mods: Object.fromEntries(ABILITIES.map((a, i) => [a, table[i]])) as Record<Ability, number>, estimated: false };
    const fromApi = await apiSaveMods(name).catch(() => null);
    if (fromApi) return { name, mods: fromApi, estimated: false };
    return { name, mods: estimateSaveMods(quest.monster_cr, quest.monster_attack), estimated: true };
  } catch (e) {
    console.error("getBossSaves failed", e);
    return null;
  }
}

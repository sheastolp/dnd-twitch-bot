// GuildScribe — the bot's own saving throw modifiers for !save <stat>. The bot
// rolls as this stream's raid boss (raid.ts): its SRD stat block's save bonus
// for that ability (proficient saves from the stat block, otherwise the
// ability modifier). With no raid boss posted, or a boss the SRD API doesn't
// know, the bot rolls a plain d20 (+0).
//
// Never throws — a missing stat block must not break a roll.

import { getRaidQuest } from "./raid.ts";
import { lookup5e } from "./lookups.ts";
import { modifier } from "./utils.ts";
import type { Ability } from "./types.ts";

export type BossSaves = { name: string; mods: Record<Ability, number> };

const SCORE_FIELDS: Record<Ability, string> = {
  STR: "strength",
  DEX: "dexterity",
  CON: "constitution",
  INT: "intelligence",
  WIS: "wisdom",
  CHA: "charisma",
};

/** Stat blocks by monster name; null when the API had no such monster. */
const cache = new Map<string, Promise<Record<Ability, number> | null>>();

async function fetchSaveMods(name: string): Promise<Record<Ability, number> | null> {
  const data = await lookup5e("monster", name);
  if (!data || typeof data.strength !== "number") return null;
  const mods = {} as Record<Ability, number>;
  for (const [ability, field] of Object.entries(SCORE_FIELDS) as [Ability, string][]) {
    const prof = (data.proficiencies ?? []).find((p: any) => p?.proficiency?.index === `saving-throw-${ability.toLowerCase()}`);
    mods[ability] = typeof prof?.value === "number" ? prof.value : modifier(Number(data[field] ?? 10));
  }
  return mods;
}

/** This stream's raid boss and its save bonuses, or null to roll a plain d20. */
export async function getBossSaves(broadcasterId: string): Promise<BossSaves | null> {
  try {
    const quest = await getRaidQuest(broadcasterId);
    const name = quest?.monster_name;
    if (!name) return null;
    let pending = cache.get(name);
    if (!pending) {
      pending = fetchSaveMods(name);
      cache.set(name, pending);
      // A failed fetch (API down) is retried next time rather than cached.
      pending.catch(() => cache.delete(name));
    }
    const mods = await pending;
    return mods ? { name, mods } : null;
  } catch (e) {
    console.error("getBossSaves failed", e);
    return null;
  }
}

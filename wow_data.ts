// World of Warcraft (Classic + Forever) data for WoW characters (wow_chars.ts).
//
// Static and hand-curated, like bg3data.ts: no API. Classic and WoW: Forever
// are one roster — the 2004 race/class table plus Forever's additions (the
// Skyborne, and the six new pairings: Human Hunter, Dwarf Shaman, Gnome
// Priest, Orc Mage, Undead Paladin, Troll Warlock).
//
// A WoW character is still a 5e character underneath: it's saved with a 5e
// class (WOW_CLASSES[x].dnd) so fights, XP, loot and every other system run
// unchanged, and keeps its WoW identity in Character.wow. Race names are
// free-form strings in the bot (the BG3 roster already relies on that), so
// the WoW race is saved as-is; its 5e mechanics come from the traits below
// (combat_abilities.ts reads "Relentless Endurance", "Savage Attacks" …).

import type { Ability } from "./types.ts";

export type WowFaction = "Alliance" | "Horde";
export const WOW_FACTIONS: WowFaction[] = ["Alliance", "Horde"];
export const FACTION_ICON: Record<WowFaction, string> = { Alliance: "🦁", Horde: "🐺" };

export type WowClassName =
  | "Warrior" | "Paladin" | "Hunter" | "Rogue" | "Priest"
  | "Shaman" | "Mage" | "Warlock" | "Druid";

export interface WowClass {
  /** The 5e class that does the fighting. */
  dnd: string;
  icon: string;
  /** One line of chat flavor. */
  blurb: string;
}

export const WOW_CLASSES: Record<WowClassName, WowClass> = {
  Warrior: { dnd: "Fighter", icon: "⚔️", blurb: "plate, rage and a very big weapon" },
  Paladin: { dnd: "Paladin", icon: "🔨", blurb: "a holy warrior of the Light" },
  Hunter: { dnd: "Ranger", icon: "🏹", blurb: "bow, beast and a feign death or two" },
  Rogue: { dnd: "Rogue", icon: "🗡️", blurb: "stealth, poisons and a backstab" },
  Priest: { dnd: "Cleric", icon: "✨", blurb: "Light to heal, Shadow to harm" },
  // Tempest flavor: mail, lightning and totems, a healer who hits things.
  Shaman: { dnd: "Cleric", icon: "⚡", blurb: "totems, lightning and the elements" },
  Mage: { dnd: "Wizard", icon: "🔥", blurb: "frostbolts, fireballs and free water" },
  Warlock: { dnd: "Warlock", icon: "💀", blurb: "demons, curses and soul shards" },
  Druid: { dnd: "Druid", icon: "🐻", blurb: "bear, cat, healer or moonkin" },
};

export interface WowRace {
  name: string;
  faction: WowFaction;
  /** Skyborne only: the faction's branch (High Order / Windshaper). */
  branch?: string;
  /** Plays this race's classes (Classic, plus Forever's new pairings). */
  classes: WowClassName[];
  /** Forever's new pairings for this race, called out in chat. */
  foreverClasses?: WowClassName[];
  bonuses: Partial<Record<Ability, number>>;
  speed: number;
  /** WoW racials first (flavor), then any 5e trait that does something in a fight. */
  traits: string[];
  /** Only in WoW: Forever. */
  forever?: boolean;
}

/** Skyborne appear once per faction, with that faction's classes and racial. */
export const WOW_RACES: WowRace[] = [
  // ── Alliance ──
  {
    name: "Human",
    faction: "Alliance",
    classes: ["Warrior", "Paladin", "Rogue", "Priest", "Mage", "Warlock", "Hunter"],
    foreverClasses: ["Hunter"],
    bonuses: { STR: 1, DEX: 1, CON: 1, INT: 1, WIS: 1, CHA: 1 },
    speed: 30,
    traits: ["The Human Spirit", "Diplomacy", "Sword Specialization", "Perception"],
  },
  {
    name: "Dwarf",
    faction: "Alliance",
    classes: ["Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Shaman"],
    foreverClasses: ["Shaman"],
    bonuses: { CON: 2, STR: 1 },
    speed: 25,
    traits: ["Stoneform", "Gun Specialization", "Treasure Finding", "Frost Resistance", "Darkvision", "Dwarven Resilience"],
  },
  {
    name: "Night Elf",
    faction: "Alliance",
    classes: ["Warrior", "Hunter", "Rogue", "Priest", "Druid"],
    bonuses: { DEX: 2, WIS: 1 },
    speed: 35,
    traits: ["Shadowmeld", "Quickness", "Wisp Spirit", "Nature Resistance", "Darkvision"],
  },
  {
    name: "Gnome",
    faction: "Alliance",
    classes: ["Warrior", "Rogue", "Mage", "Warlock", "Priest"],
    foreverClasses: ["Priest"],
    bonuses: { INT: 2, DEX: 1 },
    speed: 25,
    // Escape Artist: slipping free is the gnome's luck.
    traits: ["Escape Artist", "Expansive Mind", "Engineering Specialist", "Arcane Resistance", "Darkvision", "Lucky"],
  },
  {
    name: "Skyborne",
    branch: "High Order",
    faction: "Alliance",
    classes: ["Druid", "Hunter", "Mage", "Rogue", "Warrior"],
    bonuses: { DEX: 2, INT: 1 },
    speed: 30,
    traits: ["Walk on Air", "Wind Blessed", "Elemental Insight", "Read Ley Line"],
    forever: true,
  },
  // ── Horde ──
  {
    name: "Orc",
    faction: "Horde",
    classes: ["Warrior", "Hunter", "Rogue", "Shaman", "Warlock", "Mage"],
    foreverClasses: ["Mage"],
    bonuses: { STR: 2, CON: 1 },
    speed: 30,
    // Blood Fury: an orc's crits hit harder.
    traits: ["Blood Fury", "Hardiness", "Command", "Axe Specialization", "Darkvision", "Savage Attacks"],
  },
  {
    name: "Undead",
    faction: "Horde",
    classes: ["Warrior", "Rogue", "Priest", "Mage", "Warlock", "Paladin"],
    foreverClasses: ["Paladin"],
    bonuses: { CON: 1, INT: 1, WIS: 1 },
    speed: 30,
    traits: ["Will of the Forsaken", "Cannibalize", "Underwater Breathing", "Shadow Resistance", "Darkvision"],
  },
  {
    name: "Tauren",
    faction: "Horde",
    classes: ["Warrior", "Hunter", "Shaman", "Druid"],
    bonuses: { STR: 2, CON: 1 },
    speed: 30,
    // Endurance: a tauren shrugs off the blow that should have dropped them.
    traits: ["War Stomp", "Endurance", "Cultivation", "Nature Resistance", "Relentless Endurance"],
  },
  {
    name: "Troll",
    faction: "Horde",
    classes: ["Warrior", "Hunter", "Rogue", "Priest", "Shaman", "Mage", "Warlock"],
    foreverClasses: ["Warlock"],
    bonuses: { DEX: 2, CON: 1 },
    speed: 30,
    traits: ["Berserking", "Regeneration", "Beast Slaying", "Throwing Specialization", "Darkvision"],
  },
  {
    name: "Skyborne",
    branch: "Windshaper",
    faction: "Horde",
    classes: ["Druid", "Hunter", "Rogue", "Shaman", "Warrior"],
    bonuses: { DEX: 2, WIS: 1 },
    speed: 35,
    traits: ["Walk on Air", "Wind Blessed", "Elemental Insight", "Skysight"],
    forever: true,
  },
];

/** The races a faction can pick, in table order. */
export function racesFor(faction: WowFaction): WowRace[] {
  return WOW_RACES.filter((r) => r.faction === faction);
}

/** A race as one faction plays it (Skyborne differ by faction). */
export function wowRace(name: string, faction: WowFaction): WowRace | null {
  return WOW_RACES.find((r) => r.name === name && r.faction === faction) ?? null;
}

/** Every faction a race can join. */
export function factionsFor(name: string): WowFaction[] {
  return WOW_RACES.filter((r) => r.name === name).map((r) => r.faction);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** Loose race name match: "night elf", "nightelf", "ne", "forsaken", "skyborne elf". */
export function findWowRaceName(input: string): string | null {
  const aliases: Record<string, string> = {
    ne: "Night Elf", nelf: "Night Elf", nightelves: "Night Elf", forsaken: "Undead", ud: "Undead",
    skyborneelf: "Skyborne", skyborneelves: "Skyborne", skyborn: "Skyborne",
    highorder: "Skyborne", windshaper: "Skyborne", gnomes: "Gnome", dwarves: "Dwarf", humans: "Human",
    orcs: "Orc", trolls: "Troll", taurens: "Tauren",
  };
  const raw = norm(input);
  if (!raw) return null;
  if (aliases[raw]) return aliases[raw];
  return WOW_RACES.find((r) => norm(r.name) === raw)?.name ?? null;
}

/** "High Order" / "Windshaper" in the input picks the Skyborne's faction. */
export function factionHint(input: string): WowFaction | null {
  const n = norm(input);
  if (n.includes("highorder")) return "Alliance";
  if (n.includes("windshaper")) return "Horde";
  return null;
}

/** Loose class match: "warrior", "lock", "pally", "sham". */
export function findWowClass(input: string): WowClassName | null {
  const n = norm(input);
  const aliases: Record<string, WowClassName> = {
    warr: "Warrior", pally: "Paladin", pal: "Paladin", pala: "Paladin", hunt: "Hunter",
    rog: "Rogue", sham: "Shaman", shammy: "Shaman", lock: "Warlock", dru: "Druid",
  };
  if (aliases[n]) return aliases[n];
  return (Object.keys(WOW_CLASSES) as WowClassName[]).find((c) => norm(c) === n) ?? null;
}

export function findWowFaction(input: string): WowFaction | null {
  const n = norm(input);
  if (n === "alliance" || n === "ally" || n === "a") return "Alliance";
  if (n === "horde" || n === "h") return "Horde";
  return null;
}

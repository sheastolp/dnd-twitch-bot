// GuildScribe — the Azeroth bestiary: World of Warcraft (Classic + Forever)
// monsters and dungeon bosses for !hunt, party hunts, autohunts and the Clerk.
//
// Each entry is a WoW name, its WoW level, where it lives and what kind of
// foe it is; the 5e stat block is worked out from those (azerothStatBlock):
//   - WoW levels 1–60 map onto hero levels 1–20 (level ÷ 3), and the CR is
//     the one pickMonsterForLevel aims a hero of that level at, (hero+1)/4.
//     Dungeon bosses sit well above that (×1.5 +½), so they turn up at random
//     only for strong heroes and are mostly hunted by name (!hunt hogger).
//   - AC/HP/to-hit/damage are the core table's median for that CR (worked
//     out from SOLO_MONSTERS; see CR_BASE), nudged by kind (beasts are quick
//     and soft, brutes hit hard, casters hit harder and break easier …).
// Hand-written like the BG3 and Division 2 data: names only, no art or text.
// Forever's dungeons use the bosses most guides agree on; where its bosses
// aren't settled yet, a dungeon gets a plain foe named after it.
//
// The channel switch `wowmonsters` (World of Warcraft, on by default) adds
// them to the roster (bestiary.ts getChannelRoster); a WoW hero's random hunt
// is usually one of them (summonMonster's `azeroth`).

import type { SoloMonster } from "./data.ts";

export type AzerothKind = "beast" | "humanoid" | "brute" | "caster" | "undead" | "elemental" | "dragonkin" | "construct";

export interface AzerothInfo {
  /** Where it's found: a zone, or a dungeon's name. */
  zone: string;
  /** Its level in WoW. */
  level: number;
  kind: AzerothKind;
  /** A dungeon boss (or a named rare elite out in the world). */
  boss?: boolean;
  /** A dungeon (zone is the dungeon's name). */
  dungeon?: boolean;
  /** New in WoW: Forever. */
  forever?: boolean;
}

type Entry = [name: string, level: number, zone: string, kind: AzerothKind, flags?: "boss" | "dungeon" | "dungeon boss" | "forever dungeon" | "forever dungeon boss"];

/** name, WoW level, zone, kind, flags. Low levels first, then dungeons. */
const ENTRIES: Entry[] = [
  // ── Starting zones (1–10) ──
  ["Kobold Vermin", 2, "Elwynn Forest", "humanoid"],
  ["Young Wolf", 2, "Elwynn Forest", "beast"],
  ["Defias Thug", 5, "Elwynn Forest", "humanoid"],
  ["Murloc Forager", 9, "Elwynn Forest", "humanoid"],
  ["Rockjaw Trogg", 4, "Dun Morogh", "brute"],
  ["Frostmane Troll Whelp", 5, "Dun Morogh", "humanoid"],
  ["Leper Gnome", 7, "Dun Morogh", "humanoid"],
  ["Webwood Spider", 5, "Teldrassil", "beast"],
  ["Gnarlpine Ursa", 7, "Teldrassil", "brute"],
  ["Mottled Boar", 2, "Durotar", "beast"],
  ["Vile Familiar", 3, "Durotar", "caster"],
  ["Burning Blade Cultist", 6, "Durotar", "caster"],
  ["Plainstrider", 4, "Mulgore", "beast"],
  ["Palemane Tanner", 7, "Mulgore", "humanoid"],
  ["Rattlecage Skeleton", 3, "Tirisfal Glades", "undead"],
  ["Scarlet Convert", 5, "Tirisfal Glades", "humanoid"],
  ["Hogger", 11, "Elwynn Forest", "brute", "boss"],
  // ── 10–20 ──
  ["Riverpaw Gnoll", 12, "Westfall", "humanoid"],
  ["Harvest Golem", 13, "Westfall", "construct"],
  ["Defias Pillager", 14, "Westfall", "caster"],
  ["Razormane Quilboar", 10, "The Barrens", "humanoid"],
  ["Zhevra Runner", 13, "The Barrens", "beast"],
  ["Savannah Prowler", 14, "The Barrens", "beast"],
  ["Kolkar Centaur", 15, "The Barrens", "humanoid"],
  ["Redridge Mongrel", 16, "Redridge Mountains", "humanoid"],
  ["Blackrock Grunt", 18, "Redridge Mountains", "brute"],
  ["Mosshide Gnoll", 20, "Wetlands", "humanoid"],
  // ── 20–40 ──
  ["Skeletal Warrior", 23, "Duskwood", "undead"],
  ["Nightbane Worgen", 25, "Duskwood", "brute"],
  ["Syndicate Rogue", 26, "Hillsbrad Foothills", "humanoid"],
  ["Witherbark Troll", 30, "Arathi Highlands", "humanoid"],
  ["Stranglethorn Tiger", 31, "Stranglethorn Vale", "beast"],
  ["Bloodscalp Headhunter", 33, "Stranglethorn Vale", "humanoid"],
  ["Stitches", 35, "Duskwood", "undead", "boss"],
  ["Venture Co. Enforcer", 36, "Stranglethorn Vale", "humanoid"],
  ["Dark Iron Dwarf", 40, "Badlands", "humanoid"],
  ["King Bangalash", 43, "Stranglethorn Vale", "beast", "boss"],
  // ── 40–60 ──
  ["Wastewander Bandit", 43, "Tanaris", "humanoid"],
  ["Sandfury Axe Thrower", 45, "Tanaris", "humanoid"],
  ["Thaurissan Spy", 45, "Searing Gorge", "humanoid"],
  ["Inferno Elemental", 48, "Searing Gorge", "elemental"],
  ["Ravasaur", 52, "Un'Goro Crater", "beast"],
  ["Gorishi Wasp", 52, "Un'Goro Crater", "beast"],
  ["Plaguebat", 54, "Eastern Plaguelands", "undead"],
  ["Winterfall Ursa", 55, "Winterspring", "brute"],
  ["Black Dragonspawn", 55, "Burning Steppes", "dragonkin"],
  ["Devilsaur", 55, "Un'Goro Crater", "brute"],
  ["Scourge Champion", 58, "Eastern Plaguelands", "undead"],
  ["Twilight Geolord", 60, "Silithus", "caster"],
  // ── Classic dungeons ──
  ["Taragaman the Hungerer", 16, "Ragefire Chasm", "caster", "dungeon boss"],
  ["Rhahk'Zor", 19, "The Deadmines", "brute", "dungeon boss"],
  ["Mr. Smite", 20, "The Deadmines", "brute", "dungeon boss"],
  ["Edwin VanCleef", 21, "The Deadmines", "humanoid", "dungeon boss"],
  ["Lady Anacondra", 20, "Wailing Caverns", "caster", "dungeon boss"],
  ["Mutanus the Devourer", 22, "Wailing Caverns", "brute", "dungeon boss"],
  ["Baron Silverlaine", 24, "Shadowfang Keep", "undead", "dungeon boss"],
  ["Archmage Arugal", 26, "Shadowfang Keep", "caster", "dungeon boss"],
  ["Aku'mai", 29, "Blackfathom Deeps", "beast", "dungeon boss"],
  ["Bazil Thredd", 29, "The Stockade", "humanoid", "dungeon boss"],
  ["Charlga Razorflank", 33, "Razorfen Kraul", "caster", "dungeon boss"],
  ["Mekgineer Thermaplugg", 34, "Gnomeregan", "construct", "dungeon boss"],
  ["Herod", 40, "Scarlet Monastery", "brute", "dungeon boss"],
  ["Amnennar the Coldbringer", 41, "Razorfen Downs", "undead", "dungeon boss"],
  ["Scarlet Commander Mograine", 42, "Scarlet Monastery", "humanoid", "dungeon boss"],
  ["High Inquisitor Whitemane", 42, "Scarlet Monastery", "caster", "dungeon boss"],
  ["Archaedas", 47, "Uldaman", "construct", "dungeon boss"],
  ["Chief Ukorz Sandscalp", 48, "Zul'Farrak", "humanoid", "dungeon boss"],
  ["Princess Theradras", 51, "Maraudon", "elemental", "dungeon boss"],
  ["Shade of Eranikus", 55, "The Temple of Atal'Hakkar", "dragonkin", "dungeon boss"],
  ["Emperor Dagran Thaurissan", 59, "Blackrock Depths", "caster", "dungeon boss"],
  ["King Gordok", 60, "Dire Maul", "brute", "dungeon boss"],
  ["Overlord Wyrmthalak", 60, "Lower Blackrock Spire", "brute", "dungeon boss"],
  ["Darkmaster Gandling", 60, "Scholomance", "caster", "dungeon boss"],
  ["Baron Rivendare", 60, "Stratholme", "undead", "dungeon boss"],
  ["General Drakkisath", 60, "Upper Blackrock Spire", "dragonkin", "dungeon boss"],
  // ── WoW: Forever dungeons ──
  ["Faldrim Anvilmar", 14, "Hall of Thanes", "humanoid", "forever dungeon boss"],
  ["Durgen Dirgehammer", 17, "Hall of Thanes", "brute", "forever dungeon boss"],
  ["Witherfang", 16, "Ruins of Lordaeron", "undead", "forever dungeon boss"],
  ["Viktor the Vile", 19, "Ruins of Lordaeron", "caster", "forever dungeon boss"],
  ["Saltspine", 25, "Excavation Site: Wetlands", "beast", "forever dungeon boss"],
  ["Relic Guardian", 28, "Excavation Site: Wetlands", "construct", "forever dungeon boss"],
  ["Renegade Kirin Tor Magus", 31, "City of Dalaran", "caster", "forever dungeon"],
  ["Drowned City Tidecaller", 37, "The Drowned City", "caster", "forever dungeon"],
  ["Slavecrusher Grox", 41, "Krol'dok Stronghold", "brute", "forever dungeon boss"],
  ["Overseer Mugg", 44, "Krol'dok Stronghold", "brute", "forever dungeon boss"],
  ["Overseer Wrex", 49, "Alcaz Prison", "humanoid", "forever dungeon boss"],
  ["Tidemistress Ca'zass", 52, "Alcaz Prison", "caster", "forever dungeon boss"],
  ["Blackmaw Ravager", 57, "Blackmaw Hold", "brute", "forever dungeon"],
  ["Shaper's Terrace Guardian", 59, "Shaper's Terrace", "construct", "forever dungeon"],
];

/** The core table's median stat block per CR (SOLO_MONSTERS, Nov 2026). */
const CR_BASE: Record<string, { ac: number; hp: number; attack: number; die: number; bonus: number }> = {
  "1/8": { ac: 14, hp: 9, attack: 3, die: 6, bonus: 1 },
  "1/4": { ac: 13, hp: 13, attack: 4, die: 6, bonus: 2 },
  "1/2": { ac: 13, hp: 16, attack: 4, die: 6, bonus: 2 },
  "1": { ac: 13, hp: 27, attack: 4, die: 6, bonus: 2 },
  "2": { ac: 13, hp: 45, attack: 4, die: 6, bonus: 2 },
  "3": { ac: 14, hp: 58, attack: 5, die: 8, bonus: 4 },
  "4": { ac: 13, hp: 76, attack: 5, die: 8, bonus: 3 },
  "5": { ac: 15, hp: 94, attack: 7, die: 8, bonus: 4 },
  "6": { ac: 15, hp: 110, attack: 7, die: 8, bonus: 4 },
  "7": { ac: 15, hp: 126, attack: 7, die: 8, bonus: 5 },
  "8": { ac: 15, hp: 136, attack: 8, die: 10, bonus: 6 },
  "9": { ac: 17, hp: 152, attack: 9, die: 10, bonus: 6 },
  "10": { ac: 17, hp: 161, attack: 9, die: 10, bonus: 5 },
};

const CR_STEPS: Array<[string, number]> = [
  ["1/8", 0.125], ["1/4", 0.25], ["1/2", 0.5],
  ...Array.from({ length: 10 }, (_, i) => [String(i + 1), i + 1] as [string, number]),
];

/** The highest CR step at or below `x` (never below 1/8). */
function snapCr(x: number): [string, number] {
  let best = CR_STEPS[0];
  for (const s of CR_STEPS) if (s[1] <= x + 1e-9) best = s;
  return best;
}

/** What a kind does to the median block: [ac, hp ×, to-hit, die, damage]. */
const KIND: Record<AzerothKind, [number, number, number, number, number]> = {
  beast: [-1, 0.9, 0, 0, 0],
  humanoid: [0, 1, 0, 0, 0],
  brute: [-1, 1.2, 0, 2, 1],
  caster: [-1, 0.8, 1, 2, 0],
  undead: [0, 1.05, 0, 0, 0],
  elemental: [1, 1, 0, 0, 1],
  dragonkin: [2, 1.1, 1, 2, 1],
  construct: [3, 1, 0, 0, 0],
};

/** The 5e block for a WoW foe of `level` and `kind`. */
export function azerothStatBlock(name: string, level: number, kind: AzerothKind, boss: boolean): SoloMonster {
  // Below level 3, the first critters stay under the CR a level-1 hero aims at.
  const hero = Math.max(0.5, Math.min(20, level / 3));
  const target = (hero + 1) / 4;
  const [cr, crValue] = snapCr(boss ? target * 1.5 + 0.5 : target);
  const b = CR_BASE[cr];
  const [ac, hpX, hit, die, dmg] = KIND[kind];
  return {
    name,
    cr,
    crValue,
    ac: Math.max(10, b.ac + ac + (boss ? 1 : 0)),
    hp: Math.max(6, Math.round(b.hp * hpX * (boss ? 1.1 : 1))),
    attack: b.attack + hit,
    die: Math.min(12, b.die + die),
    bonus: b.bonus + dmg,
  };
}

export const AZEROTH_INFO = new Map<string, AzerothInfo>();
export const AZEROTH_MONSTERS: SoloMonster[] = ENTRIES.map(([name, level, zone, kind, flags = ""]) => {
  const boss = /boss/.test(flags);
  AZEROTH_INFO.set(name.toLowerCase(), {
    zone, level, kind, boss: boss || undefined,
    dungeon: /dungeon/.test(flags) || undefined,
    forever: /forever/.test(flags) || undefined,
  });
  return azerothStatBlock(name, level, kind, boss);
});

export function azerothInfo(name: string): AzerothInfo | null {
  return AZEROTH_INFO.get(String(name).toLowerCase()) ?? null;
}

/** "Elwynn Forest", "the Deadmines (dungeon)", "Hall of Thanes (Forever dungeon)". */
export function azerothWhere(info: AzerothInfo): string {
  const place = info.zone.replace(/^The /, "the ");
  return info.dungeon ? `${place} (${info.forever ? "Forever " : ""}dungeon)` : place;
}

/** The line a fight opens with, where the Orrery would give a place. */
export function azerothPlaceLine(name: string): { name: string; line: string } | null {
  const info = azerothInfo(name);
  if (!info) return null;
  const lvl = `WoW level ${info.level}${info.boss ? (info.dungeon ? " boss" : " rare elite") : ""}`;
  const line = info.dungeon
    ? `Deep in ${info.zone.replace(/^The /, "the ")}${info.forever ? " (WoW: Forever)" : ""} — ${lvl}.`
    : `Out in ${info.zone.replace(/^The /, "the ")} — ${lvl}.`;
  return { name: info.zone, line };
}

const normPlace = (s: string) => s.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");

/** !azeroth [dungeon|zone|bosses] — one chat message about the Azeroth bestiary. */
export function azerothReply(arg: string): string {
  const q = normPlace(arg.trim());
  const byZone = new Map<string, { names: string[]; info: AzerothInfo }>();
  for (const [name] of ENTRIES) {
    const info = azerothInfo(name)!;
    const z = byZone.get(info.zone) ?? { names: [], info };
    z.names.push(name);
    byZone.set(info.zone, z);
  }
  if (!q) {
    const dungeons = [...byZone.values()].filter((z) => z.info.dungeon).length;
    return `🌍 Azeroth bestiary: ${AZEROTH_MONSTERS.length} WoW Classic + Forever foes from ${byZone.size - dungeons} zones and ${dungeons} dungeons. ` +
      `WoW heroes (!wowchar) meet them most on a random !hunt; anyone can hunt one by name (!hunt hogger). ` +
      `!azeroth dungeons, !azeroth forever, or !azeroth <zone or dungeon>.`;
  }
  if (q === "dungeons" || q === "dungeon" || q === "bosses") {
    const list = [...byZone.entries()].filter(([, z]) => z.info.dungeon && !z.info.forever)
      .map(([zone, z]) => `${zone.replace(/^The /, "")} (${Math.min(...z.names.map((n) => azerothInfo(n)!.level))}+)`);
    return `🏰 Classic dungeons: ${list.join(", ")}. !azeroth <dungeon> for its bosses; !azeroth forever for Forever's.`;
  }
  if (q === "forever") {
    const list = [...byZone.entries()].filter(([, z]) => z.info.forever)
      .map(([zone, z]) => `${zone.replace(/^The /, "")} (${Math.min(...z.names.map((n) => azerothInfo(n)!.level))}+)`);
    return `✨ WoW: Forever dungeons: ${list.join(", ")}. !azeroth <dungeon> for who's inside.`;
  }
  const hit = [...byZone.entries()].find(([zone]) => normPlace(zone) === q) ??
    [...byZone.entries()].find(([zone]) => normPlace(zone).includes(q));
  if (!hit) return `no zone or dungeon "${arg.trim()}" in the Azeroth bestiary. Try !azeroth dungeons or !azeroth forever.`;
  const [zone, z] = hit;
  const foes = z.names.map((n) => {
    const m = AZEROTH_MONSTERS.find((x) => x.name === n)!;
    return `${n} (WoW ${azerothInfo(n)!.level}, CR ${m.cr})`;
  });
  return `${z.info.dungeon ? "🏰" : "🌲"} ${zone}${z.info.forever ? " (WoW: Forever)" : ""}: ${foes.join(", ")}. Hunt one: !hunt ${z.names[z.names.length - 1].toLowerCase()}`;
}

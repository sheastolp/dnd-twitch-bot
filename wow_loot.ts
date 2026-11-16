// GuildScribe — World of Warcraft loot: a WoW hero's kill drops an item in
// Classic's quality colors, next to the usual coin.
//
//   ⚫ Poor   vendor trash, sold on the spot for a few copper (the coin is real)
//   ⚪ Common  cloth, ore, leather, water
//   🟢 Uncommon  "<gear> of the <Bear|Eagle|Monkey…>"
//   🔵 Rare / 🟣 Epic  the boss's own: "[Onyxia's Signet]"
//   🟠 Legendary  raid bosses only, and rarely: Thunderfury, Sulfuras, Atiesh
//
// The drop table follows what fell: wildlife and ordinary monsters mostly drop
// gray and white, dungeon bosses and named rares green and blue, raid and
// world bosses (wow_monsters.ts) blue and purple. Items are trophies for chat:
// nothing goes on the sheet and nothing changes a fight; only gray junk turns
// into coin (and only while coin can be earned, like every drop — loot.ts).
// Autohunts drop one per bout won (awardWowDrop; the report names the best,
// bestDropIn). D&D heroes get their usual loot only. A party hunt's one drop, and a raid's
// two, go by a Need roll among the WoW heroes who were there.

import { getCharacter } from "./db.ts";
import { xpForMonsterCr } from "./characters.ts";
import { adjustBalance, canEarnGold } from "./points_db.ts";
import { formatCoins } from "./coins.ts";
import { azerothInfo } from "./wow_monsters.ts";

export type Quality = "Poor" | "Common" | "Uncommon" | "Rare" | "Epic" | "Legendary";
export const QUALITY_ICON: Record<Quality, string> = {
  Poor: "⚫", Common: "⚪", Uncommon: "🟢", Rare: "🔵", Epic: "🟣", Legendary: "🟠",
};

type Source = "normal" | "boss" | "raid";
const TABLES: Record<Source, Array<[Quality, number]>> = {
  normal: [["Poor", 55], ["Common", 30], ["Uncommon", 14], ["Rare", 1]],
  boss: [["Uncommon", 55], ["Rare", 42], ["Epic", 3]],
  raid: [["Rare", 30], ["Epic", 68], ["Legendary", 2]],
};

const POOR = [
  "Tattered Cloth Vest", "Broken Fang", "Chipped Claw", "Cracked Buckler", "Frayed Belt", "Torn Leather Boots",
  "Bent Shortsword", "Worn Chain Leggings", "Ruined Pelt", "Rusty Hatchet", "Murky Ichor", "Splintered Club",
];
const COMMON = [
  "Linen Cloth", "Wool Cloth", "Silk Cloth", "Runecloth", "Light Leather", "Heavy Leather", "Copper Ore", "Iron Ore",
  "Rough Stone", "Refreshing Spring Water", "Tough Jerky", "Coarse Thread",
];
const GEAR = [
  "Chain Gloves", "Leather Belt", "Cloth Robe", "Scale Bracers", "Plate Helm", "Longsword", "Battle Staff",
  "Recurve Bow", "Mail Boots", "Studded Cloak", "War Axe", "Silk Mantle",
];
const SUFFIX = ["the Bear", "the Eagle", "the Monkey", "the Tiger", "the Owl", "the Whale", "the Wolf", "the Falcon", "the Gorilla", "the Boar"];
const BOSS_GEAR = ["Signet", "Mantle", "Warblade", "Greatstaff", "Crown", "Breastplate", "Talisman", "Gauntlets", "Girdle", "Spaulders"];
const LEGENDARY_DEFAULT = "Thunderfury, Blessed Blade of the Windseeker";
const LEGENDARY_BY_BOSS: Record<string, string> = {
  ragnaros: "Sulfuras, Hand of Ragnaros",
  "kel'thuzad": "Atiesh, Greatstaff of the Guardian",
};

export type WowDrop = { quality: Quality; item: string; vendorCopper: number };

/** What kind of loot table a monster rolls on. */
export function lootSource(monsterName: string, crValue = 0): Source {
  const info = azerothInfo(monsterName);
  if (info?.raid || info?.worldBoss) return "raid";
  if (info?.boss) return "boss";
  // Not from Azeroth: the top of the bestiary is boss loot, raid-quest bosses raid loot.
  if (!info && crValue >= 13) return "raid";
  if (!info && crValue >= 8) return "boss";
  return "normal";
}

/** "1/2" → 0.5, "13" → 13. */
const crNumber = (cr: string) => {
  const [a, b] = String(cr).split("/").map(Number);
  return b ? a / b : a || 0;
};

const possessive = (name: string) => {
  const n = name.replace(/^The /, "the ");
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
};

/** One drop from `monsterName` (CR `cr`). Pure, given `rng`. */
export function rollWowDrop(monsterName: string, cr: string, crValue = 0, rng: () => number = Math.random): WowDrop {
  const v = crValue || crNumber(cr);
  const table = TABLES[lootSource(monsterName, v)];
  let r = rng() * table.reduce((t, [, w]) => t + w, 0);
  let quality: Quality = table[table.length - 1][0];
  for (const [q, w] of table) {
    r -= w;
    if (r <= 0) {
      quality = q;
      break;
    }
  }
  const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
  const boss = possessive(monsterName.charAt(0).toUpperCase() + monsterName.slice(1));
  switch (quality) {
    case "Poor":
      return { quality, item: pick(POOR), vendorCopper: Math.max(1, Math.ceil(xpForMonsterCr(cr) / 40)) };
    case "Common":
      return { quality, item: pick(COMMON), vendorCopper: 0 };
    case "Uncommon":
      return { quality, item: `${pick(GEAR)} of ${pick(SUFFIX)}`, vendorCopper: 0 };
    case "Rare":
      return { quality, item: `${boss} ${pick(GEAR)}`, vendorCopper: 0 };
    case "Epic":
      return { quality, item: `${boss} ${pick(BOSS_GEAR)}`, vendorCopper: 0 };
    case "Legendary":
      return { quality, item: LEGENDARY_BY_BOSS[monsterName.toLowerCase()] ?? LEGENDARY_DEFAULT, vendorCopper: 0 };
  }
}

/** "🟣 [Onyxia's Signet] (Epic)" */
export function dropText(d: WowDrop): string {
  return `${QUALITY_ICON[d.quality]} [${d.item}]${d.quality === "Legendary" ? " — LEGENDARY!" : ` (${d.quality})`}`;
}

/** Sells gray junk to a vendor for its owner. The coin paid, or 0. */
async function vendor(broadcasterId: string, user: string, d: WowDrop): Promise<number> {
  if (d.quality !== "Poor" || d.vendorCopper <= 0) return 0;
  try {
    if (!(await canEarnGold(broadcasterId))) return 0;
    await adjustBalance(broadcasterId, user, user, d.vendorCopper);
    return d.vendorCopper;
  } catch {
    return 0;
  }
}

const sold = (copper: number) => (copper ? `, vendored +${formatCoins(copper)}` : "");

/** Rolls one drop for `user` (a WoW hero — the caller checks) and vendors it
 * if it's junk. Autohunts use this per bout. */
export async function awardWowDrop(
  broadcasterId: string,
  user: string,
  monsterName: string,
  cr: string,
  crValue = 0,
): Promise<{ drop: WowDrop; copper: number }> {
  const drop = rollWowDrop(monsterName, cr, crValue);
  return { drop, copper: await vendor(broadcasterId, user, drop) };
}

const RANK: Quality[] = ["Poor", "Common", "Uncommon", "Rare", "Epic", "Legendary"];
const ICON_QUALITY = new Map(Object.entries(QUALITY_ICON).map(([q, i]) => [i, q as Quality]));

/** The best drop named anywhere in `text` (bout lines, a trip log), as
 * dropText shows it; "" when there is none. */
export function bestDropIn(text: string): string {
  let best: { q: Quality; item: string } | null = null;
  for (const m of String(text).matchAll(/(⚫|⚪|🟢|🔵|🟣|🟠) \[([^\]]+)\]/gu)) {
    const q = ICON_QUALITY.get(m[1]);
    if (q && (!best || RANK.indexOf(q) > RANK.indexOf(best.q))) best = { q, item: m[2] };
  }
  return best ? dropText({ quality: best.q, item: best.item, vendorCopper: 0 }) : "";
}

/** A solo kill: " 🎁 Loot: 🟢 [Chain Gloves of the Bear] (Uncommon)." for a
 * WoW hero, "" for anyone else. Never throws. */
export async function wowLootNote(broadcasterId: string, user: string, monsterName: string, cr: string, crValue = 0): Promise<string> {
  try {
    const c = await getCharacter(user, broadcasterId);
    if (!c?.wow) return "";
    const d = rollWowDrop(monsterName, cr, crValue);
    return ` 🎁 Loot: ${dropText(d)}${sold(await vendor(broadcasterId, user, d))}.`;
  } catch {
    return "";
  }
}

/** A group kill: `drops` items, each to the winner of a Need roll (d100)
 * among the WoW heroes in `members`. "" when none of them is one. */
export async function wowGroupLootNote(
  broadcasterId: string,
  members: string[],
  monsterName: string,
  cr: string,
  crValue = 0,
  drops = 1,
): Promise<string> {
  try {
    const wow: string[] = [];
    for (const m of members) if ((await getCharacter(m, broadcasterId))?.wow) wow.push(m);
    if (!wow.length) return "";
    const lines: string[] = [];
    for (let i = 0; i < drops; i++) {
      const d = rollWowDrop(monsterName, cr, crValue);
      const rolls = wow.map((u) => ({ u, r: 1 + Math.floor(Math.random() * 100) }));
      const best = rolls.reduce((a, b) => (b.r > a.r ? b : a));
      const need = wow.length > 1 ? ` — ${best.u} wins the Need roll (${best.r})` : ` — ${best.u}`;
      lines.push(`${dropText(d)}${need}${sold(await vendor(broadcasterId, best.u, d))}`);
    }
    return ` 🎁 Loot: ${lines.join("; ")}.`;
  } catch {
    return "";
  }
}

// Peddler gear — the open-stall merchant's wares (merchant.ts) as real items
// that land on a buyer's character sheet.
//
// Every item the peddler can list lives here with a short sheet name and a
// small, permanent EFFECT. When a viewer buys one with coin (a successful
// !haggle deal, haggle.ts), applyGear() bakes the effect into their saved
// character and adds a line to Character.items, e.g.
//   "Lucky rabbit's foot (+1 DEX)"
// Because the bonus is written straight into the character's scores / max HP
// / speed, every existing system picks it up with no extra wiring: !char,
// the character page, !roll checks and saves, duels, hunts, raids and !rob.
//
// Rules:
//   - Owning a second copy of the same item does nothing, so the buyer is
//     stopped before they pay twice (ownsGear).
//   - Ability scores still cap at 20, like everywhere else in the bot. Any
//     point that can't fit becomes +2 max HP instead, so a purchase is never
//     wasted.
//   - CON gear also raises max HP the way a CON increase does in 5e (the new
//     modifier counts once per level).
//   - Max-HP gear survives level changes: characters.ts adds gearHpBonus()
//     back on whenever it recomputes max HP. The bonus is read from the
//     "+N max HP" text in each item line, so the sheet is the source of truth.

import type { Ability, Character } from "./types.ts";
import { modifier } from "./utils.ts";

export interface GearEffect {
  scores?: Partial<Record<Ability, number>>;
  hp?: number;
  speed?: number;
}

export interface MerchantItem {
  /** Short name written on the character sheet. */
  name: string;
  /** The peddler's pitch for it — also the key a listing is matched by. */
  desc: string;
  price: string;
  effect: GearEffect;
}

// Cheap, secondhand, unmistakably D&D-flavored goods — nothing a wealthy
// merchant would bother stocking. Small bonuses to match the small prices.
export const MERCHANT_ITEMS: MerchantItem[] = [
  { name: "Dented tin flask", desc: "a dented tin flask that swears it once held dragon's-breath brandy", price: "3 copper", effect: { scores: { CON: 1 } } },
  { name: "Warding chalk", desc: "a bundle of chalk sticks for warding sigils, mostly unbroken", price: "2 copper", effect: { scores: { WIS: 1 } } },
  { name: "Lucky rabbit's foot", desc: "one (1) lucky rabbit's foot, still faintly twitching", price: "5 copper", effect: { scores: { DEX: 1 } } },
  { name: "Cracked scrying mirror", desc: "a cracked scrying mirror that only ever shows yesterday", price: "1 silver", effect: { scores: { INT: 1 } } },
  { name: "Moth-eaten cloak", desc: "a moth-eaten cloak that almost passes for 'mysterious'", price: "4 copper", effect: { scores: { CHA: 1 } } },
  { name: "Goblin-rated rope", desc: "a coil of rope, guaranteed to hold at least one goblin", price: "6 copper", effect: { scores: { STR: 1 } } },
  { name: "Pickled owlbear whiskers", desc: "a jar of pickled owlbear whiskers (for luck, allegedly)", price: "8 copper", effect: { scores: { CON: 1 } } },
  { name: "Blue-flame candle", desc: "a half-melted candle that burns a suspicious shade of blue", price: "1 copper", effect: { scores: { INT: 1 } } },
  { name: "Badly loaded dice", desc: "a set of loaded dice, badly loaded — they just roll off the table", price: "2 copper", effect: { scores: { CHA: 1 } } },
  { name: "Rusty holy symbol", desc: "a rusty holy symbol of a god nobody quite remembers anymore", price: "3 copper", effect: { scores: { WIS: 1 } } },
  { name: "Whittled wooden dagger", desc: "a whittled wooden dagger, purely for show — please don't stab anyone", price: "1 copper", effect: { scores: { CHA: 1 } } },
  { name: "Questionable trail rations", desc: "a satchel of trail rations that are 'mostly' still rations", price: "5 copper", effect: { hp: 2 } },
  { name: "Single fine boot", desc: "a single boot, left foot, very fine make", price: "2 copper", effect: { speed: 5 } },
  { name: "Maybe-enchanted river water", desc: "a vial of river water that 'might' be enchanted", price: "4 copper", effect: { hp: 2 } },
  { name: "Scorched spellbook page", desc: "a scorched spellbook page with half a fireball recipe on it", price: "7 copper", effect: { scores: { INT: 1 } } },
  { name: "Tavern-seeking compass", desc: "a tarnished brass compass that always points toward the nearest tavern", price: "3 copper", effect: { scores: { WIS: 1 } } },
  { name: "'Gnomish gemstones'", desc: "a sack of glass beads, sold in good faith as 'gnomish gemstones'", price: "6 copper", effect: { scores: { CHA: 1 } } },
  { name: "Patchwork healer's kit", desc: "a patchwork healer's kit missing only the important bits", price: "9 copper", effect: { hp: 3 } },
  { name: "Wish-granting cricket", desc: "a caged cricket claimed to grant wishes if fed enough", price: "2 copper", effect: { scores: { WIS: 1 } } },
  { name: "Hand-me-down shield", desc: "a hand-me-down shield, already dented — someone else did the work for you", price: "1 silver 2 copper", effect: { hp: 4 } },
  { name: "Glowing string", desc: "a coil of faintly glowing string, source unknown, no refunds", price: "5 copper", effect: { scores: { DEX: 1 } } },
  { name: "'Dragon' scales", desc: "a stack of 'authentic' dragon scales (dyed lizard, don't tell anyone)", price: "4 copper", effect: { scores: { CON: 1 } } },
];

// Rare, mostly-forgotten legendary relics. The peddler found them in a
// bottomless sack and has no idea what they are, so they're priced like
// curiosities — a steal for anyone who recognizes them. Prices stay in plain
// "<n> gold" form so coins.ts's parseFirstPrice (and !haggle) can read them.
// Bigger bonuses than the junk, as befits a relic.
export const LEGENDARY_ITEMS: MerchantItem[] = [
  { name: "Apparatus of Kwalish", desc: "the Apparatus of Kwalish, a lobster-shaped iron submersible, 'only slightly rusted shut'", price: "90 gold", effect: { scores: { CON: 2 }, hp: 5 } },
  { name: "Iron Flask", desc: "an Iron Flask etched with sigils, humming faintly and rattling whenever you look away", price: "75 gold", effect: { scores: { WIS: 2 } } },
  { name: "Cubic Gate", desc: "a Cubic Gate, a small stone cube with six faces, each one a door to somewhere else", price: "120 gold", effect: { scores: { INT: 2 }, speed: 10 } },
  { name: "Ring of Three Wishes", desc: "the Ring of Three Wishes — the peddler swears it has 'at least two left'", price: "150 gold", effect: { scores: { CHA: 2, WIS: 1 }, hp: 5 } },
  { name: "Fragarach", desc: "Fragarach, the Sword of Answering, which sulks in its sheath until someone lies to it", price: "110 gold", effect: { scores: { STR: 2 }, hp: 5 } },
  { name: "Anstruth Harp", desc: "an Anstruth Harp, a bardic instrument of a lost college, still tuned to a forgotten song", price: "85 gold", effect: { scores: { CHA: 2 } } },
  { name: "Talisman of Pure Good", desc: "a Talisman of Pure Good that glows warmly and makes the nearby chickens behave", price: "95 gold", effect: { scores: { WIS: 2 }, hp: 5 } },
  { name: "Talisman of Ultimate Evil", desc: "a Talisman of Ultimate Evil, kept in a lead-lined pickle jar for everyone's safety", price: "40 gold", effect: { scores: { CHA: 2 } } },
  { name: "Mirror of Life Trapping", desc: "a Mirror of Life Trapping with a crack down one side and a distinct sense of being watched", price: "70 gold", effect: { scores: { INT: 2 } } },
  { name: "Cloak of Invisibility", desc: "the Cloak of Invisibility, 'sold as seen' (nobody has seen it yet)", price: "100 gold", effect: { scores: { DEX: 2 }, hp: 5 } },
  { name: "Robe of the Archmagi", desc: "the Robe of the Archmagi, patched at the elbows and reeking of ozone", price: "130 gold", effect: { scores: { INT: 2 }, hp: 8 } },
  { name: "Orb of Dragonkind", desc: "an Orb of Dragonkind that goes cold whenever a dragon is within a thousand miles", price: "140 gold", effect: { scores: { CHA: 2 }, hp: 8 } },
  { name: "Rod of Seven Parts (6/7)", desc: "the Rod of Seven Parts — six of seven, the peddler is 'still looking for the last one'", price: "60 gold", effect: { scores: { WIS: 2 } } },
  { name: "Staff of the Magi", desc: "the Staff of the Magi, a splintered old staff that crackles whenever it hears the word 'counterspell'", price: "125 gold", effect: { scores: { INT: 2 }, hp: 8 } },
  { name: "Plate Armor of Etherealness", desc: "a Plate Armor of Etherealness that vanishes entirely, the peddler warns, 'if you get excited'", price: "115 gold", effect: { hp: 15 } },
  { name: "Sword of Kas", desc: "the Sword of Kas, a pitch-black blade that whispers rude things about its former owner", price: "80 gold", effect: { scores: { STR: 2 } } },
  { name: "Luck Blade", desc: "a Luck Blade with a sheepish grin and exactly one wish remaining", price: "105 gold", effect: { scores: { DEX: 2 }, hp: 5 } },
  { name: "Ioun Stone of Mastery", desc: "an Ioun Stone of Mastery spinning lazily in the air above the table, bothering no one", price: "65 gold", effect: { scores: { INT: 1, WIS: 1 } } },
  { name: "Hammer of Thunderbolts", desc: "the Hammer of Thunderbolts, a dwarven masterwork the peddler mistook for a 'really good doorstop'", price: "135 gold", effect: { scores: { STR: 2 }, hp: 8 } },
  { name: "Scroll of Protection from Everything", desc: "the Scroll of Protection from Everything, written in a language that only exists in dreams", price: "55 gold", effect: { hp: 12 } },
];

const ABILITY_ORDER: Ability[] = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];
const SCORE_CAP = 20;
/** Max HP granted per ability point that can't fit under the cap. */
const HP_PER_CAPPED_POINT = 2;

/** "+1 DEX, +5 max HP, +5 ft speed" — what an effect does. */
export function effectText(e: GearEffect): string {
  const parts: string[] = [];
  for (const a of ABILITY_ORDER) {
    const n = e.scores?.[a];
    if (n) parts.push(`+${n} ${a}`);
  }
  if (e.hp) parts.push(`+${e.hp} max HP`);
  if (e.speed) parts.push(`+${e.speed} ft speed`);
  return parts.join(", ");
}

const norm = (s: string) => s.trim().toLowerCase();

/** The catalog entry for a listing's item description (null for anything
 * not in the catalog, e.g. a listing posted before an item was renamed). */
export function findMerchantItem(itemDesc: string): MerchantItem | null {
  const d = norm(itemDesc);
  return [...MERCHANT_ITEMS, ...LEGENDARY_ITEMS].find((i) => norm(i.desc) === d) ?? null;
}

/** True if the character's sheet already carries this item. */
export function ownsGear(c: Pick<Character, "items">, item: MerchantItem): boolean {
  const n = norm(item.name);
  return (c.items ?? []).some((line) => {
    const l = norm(line);
    return l === n || l.startsWith(`${n} (`);
  });
}

/** Total max-HP bonus from gear, read from the "+N max HP" in each item
 * line. characters.ts adds this back whenever a level change recomputes
 * max HP from scratch. */
export function gearHpBonus(c: Pick<Character, "items">): number {
  let total = 0;
  for (const line of c.items ?? []) {
    const m = String(line).match(/\+(\d+) max HP/i);
    if (m) total += Number(m[1]);
  }
  return total;
}

/** Bakes an item's effect into the character (mutates `c`) and writes the
 * item onto the sheet. Returns the effect actually applied — which can
 * differ from the catalog when a score was already at the cap — and a
 * short "DEX 14→15" summary of what changed. Caller saves the character. */
export function applyGear(c: Character, item: MerchantItem): { applied: GearEffect; changes: string } {
  const applied: GearEffect = {};
  const changes: string[] = [];
  let extraHp = 0;

  const oldConMod = modifier(c.scores.CON);
  for (const a of ABILITY_ORDER) {
    const want = item.effect.scores?.[a] ?? 0;
    if (!want) continue;
    const before = c.scores[a];
    const after = Math.min(SCORE_CAP, before + want);
    const gained = after - before;
    if (gained > 0) {
      c.scores[a] = after;
      (applied.scores ??= {})[a] = gained;
      changes.push(`${a} ${before}→${after}`);
    }
    extraHp += (want - gained) * HP_PER_CAPPED_POINT;
  }

  // A CON increase raises max HP retroactively: the new modifier counts once
  // per level (same formula characters.ts uses when leveling).
  const conHp = (modifier(c.scores.CON) - oldConMod) * Math.max(1, c.level);
  const gearHp = (item.effect.hp ?? 0) + extraHp;
  if (gearHp) applied.hp = gearHp;
  if (conHp + gearHp) {
    const before = c.hpMax;
    c.hpMax = Math.max(1, c.hpMax + conHp + gearHp);
    c.hpCurrent = Math.max(0, Math.min(c.hpMax, c.hpCurrent + (c.hpMax - before)));
    changes.push(`max HP ${before}→${c.hpMax}`);
  }

  if (item.effect.speed) {
    const before = c.speed;
    c.speed += item.effect.speed;
    applied.speed = item.effect.speed;
    changes.push(`speed ${before}→${c.speed}ft`);
  }

  const text = effectText(applied);
  c.items = [...(c.items ?? []), text ? `${item.name} (${text})` : item.name];
  return { applied, changes: changes.join(", ") };
}

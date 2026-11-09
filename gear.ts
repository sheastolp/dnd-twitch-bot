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
import { orreryWares } from "./orrery.ts";

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
  /** A rare relic rather than the usual junk. */
  relic?: boolean;
}

// The stall's stock comes from the Grand Orrery and nowhere else: every
// decided entry in its resources.md with a **Sold:** line (orrery.ts's
// orreryWares). A new item added there turns up at the stall on its own. The
// bot keeps no list of wares of its own; orrery.ts keeps the Orrery's last
// good copy between restarts.

export interface MerchantStock {
  /** The usual junk. */
  wares: MerchantItem[];
  /** Rare relics (may be empty). */
  relics: MerchantItem[];
  /** False only when the Orrery has never been read here (then it's empty). */
  fromOrrery: boolean;
}

/** What the peddlers can put on the stall right now: the Orrery's wares
 * (empty if the Orrery has never been read here). */
export function merchantStock(): MerchantStock {
  const live: MerchantItem[] = orreryWares().map((w) => ({ name: w.name, desc: w.desc, price: w.price, effect: w.effect, relic: w.relic }));
  const wares = live.filter((i) => !i.relic);
  if (!wares.length) return { wares: [], relics: [], fromOrrery: false };
  return { wares, relics: live.filter((i) => i.relic), fromOrrery: true };
}

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

/** The catalog entry for a listing's item description, from the Orrery's
 * stock (null if the Orrery no longer sells it). */
export function findMerchantItem(itemDesc: string): MerchantItem | null {
  const d = norm(itemDesc);
  const { wares, relics } = merchantStock();
  return [...wares, ...relics].find((i) => norm(i.desc) === d) ?? null;
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

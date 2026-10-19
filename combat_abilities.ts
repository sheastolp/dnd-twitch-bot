// Class features and racial traits in combat. Every fight — auto-resolved
// duels, !rob, solo hunts, autohunt, Hunt and Hoard, party hunts, party
// duels, raids, and the classic turn-by-turn modes — swings through
// heroTurn/monsterTurn here, so a hero's kit works the same everywhere.
//
// A Kit is one hero's abilities for one fight: what they always have (Extra
// Attack, Sneak Attack, Rage...) plus the uses left of what they can only do
// a few times (Second Wind, Divine Smite, Shield...). Classic turn-by-turn
// fights keep no state between commands, so they get a `stateless` kit:
// the always-on features only.
//
// Simplified for a one-swing-at-a-time chat engine, and tuned so every
// class lands within ~±15 points of the bestiary's designed win rate:
//   Barbarian  Rage: +2/+3/+4 damage (L1/9/16), 25% less damage taken;
//              Extra Attack L5; Brutal Critical L9 (+1 die on a crit, +2 L13, +3 L17)
//   Fighter    Second Wind (heal 1d10 + level once, under half HP);
//              Action Surge L2 (a second set of attacks in round 1);
//              Improved Critical L3 (crits on 19–20); Extra Attack L5/11/20 (2/3/4)
//   Paladin    Lay on Hands (2×level pool, under a third HP); Divine Smite L2
//              (+2d8 on a hit, 1–4 a fight); Extra Attack L5; Improved
//              Divine Smite L11 (+1d8 every hit)
//   Ranger     Hunter's Mark L2 (+1d6 every hit); Colossus Slayer L3 (+1d8 once
//              a turn on a wounded target); Extra Attack L5
//   Rogue      Sneak Attack (+1d6 per two levels, once a turn); Uncanny Dodge
//              L5 (halves the first hit in a round, proficiency-bonus times a fight)
//   Monk       Martial Arts (a bonus unarmed strike every turn, d4/d6/d8/d10
//              at L1/5/11/17); Flurry of Blows L2 (a second one, level ki a
//              fight); Extra Attack L5
//   Wizard     Fire Bolt (d10, 1–4 dice by level); Shield (+5 AC against a hit,
//              2 a fight, 3 from L5); Magic Missile (3d4 + 3, never misses) or,
//              from L5, Fireball (8d6 +1d6 per two levels, DEX save for half),
//              1–3 a fight
//   Sorcerer   Fire Bolt; Magic Missile / Fireball as the wizard; Quickened
//              Spell L3 (an extra cantrip in round 1, twice a fight from L10)
//   Warlock    Eldritch Blast (d10 beams, 1–4 by level, each its own attack,
//              + CHA from L2: Agonizing Blast); Hex (+1d6 every hit)
//   Cleric     Toll the Dead (d8, 1–4 dice); Healing Word (heals the most hurt
//              ally under half HP: (1 + level/4)d4 + WIS, 2–4 a fight);
//              Spiritual Weapon L3 (a bonus strike every turn, 1–3d8)
//   Druid      Produce Flame (d8, 1–4 dice); Healing Word (2–3 a fight);
//              Wild Shape L2 (a beast form soaks 5 + 2×level damage first)
//   Bard       Vicious Mockery-style cantrip (d8, 1–4 dice); Bardic
//              Inspiration (CHA mod uses, d6–d12: turns a near-miss by any ally
//              into a hit); Healing Word (1–2 a fight)
// Races: Halfling Lucky (reroll a natural 1), Half-Orc Relentless Endurance
// (once, drop to 1 HP instead of 0) and Savage Attacks (+1 die on a crit),
// Dragonborn Breath Weapon (round 1: 2d6–5d6, DEX save for half).
// Casters add their casting modifier to cantrip damage (a house rule, so a
// level-1 caster isn't out-damaged by every sword). Monsters' DEX save is
// half their attack bonus.
//
// Debuffs: every class also has a way to hinder its foe, chosen and used
// automatically (chooseHinder) — a rider on a hit, a spell cast in place of
// the turn's first attack, or a roar as the turn starts. The target saves
// against DC 8 + proficiency + the hero's fighting stat (monsters save at
// half their attack bonus, as against a breath weapon):
//   Barbarian  Intimidating Presence L3 (turn start: WIS save or frightened 2 turns, 1/fight)
//   Fighter    Battle Master maneuvers L3 (on a hit, +1d8 (1d10 L10): Trip Attack —
//              STR save or prone 1 turn; Menacing Attack — WIS save or
//              frightened 1 turn; 2 a fight, 3 L7, 4 L15)
//   Paladin    Wrathful Smite L2 (on a hit, +1d6: WIS save or frightened, 1–2 a fight)
//   Ranger     Ensnaring Strike L2 (on a hit: STR save or restrained, 1–2 a fight)
//   Rogue      Cunning Strike L5 (on a sneak attack, for 1d6 of it: Poison —
//              CON save or poisoned 2 turns; Trip — DEX save or prone 1 turn)
//   Monk       Stunning Strike L5 (on a hit, 1 ki: CON save or stunned 1 turn)
//   Wizard     Ray of Enfeeblement L3 (CON save or deals half damage);
//              Hold Monster L9 (WIS save or paralyzed); 1–2 a fight between them
//   Sorcerer   Blindness L3 (CON save or blinded, 1–2 a fight)
//   Warlock    Cause Fear (WIS save or frightened, 1–2 a fight)
//   Cleric     Bane (CHA save or −1d4 to its attacks for 10 turns, 1–2 a fight)
//   Druid      Entangle (STR save or restrained, 1–2 a fight)
//   Bard       Vicious Mockery (a hit leaves it rattled: disadvantage on its
//              next attack); Cutting Words L3 (spends an inspiration to take
//              the die off a foe's attack that would hit)
// The spells (Wrathful Smite and Ensnaring Strike included) last up to 10
// of the foe's turns, and it repeats the save at the start of each to shake
// them off. Frightened, poisoned and rattled foes attack at disadvantage; prone ones
// are attacked at advantage; restrained and blinded, both; stunned and
// paralyzed ones lose their turns and are attacked at advantage; enfeebled
// ones deal half damage. The chooser skips a foe nearly down (under a
// quarter HP) or already suffering the same thing, casts only at a foe at
// half HP or more with at least three of the hero's turns of damage left in
// it, and prefers what helps most: a stun, then fear/Bane/enfeeblement when
// the hero is hurt, then prone when allies can capitalize. Uses reset each
// fight; classic turn-by-turn fights get only the free ones (Cunning Strike,
// Vicious Mockery).

import type { Ability } from "./types.ts";
import { classes, draconicAncestry } from "./data.ts";
import { attackAbility, heroAc, modifier } from "./utils.ts";
import { type BattleLog, heroAcWhy, type Mods, rollDice, type Strike } from "./battle.ts";

const d = (sides: number) => 1 + Math.floor(Math.random() * sides);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Cantrip damage dice by level: 1, 2 at L5, 3 at L11, 4 at L17. */
const cantripDice = (level: number) => (level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1);

/** Fireball: 8d6 at L5, +1d6 per two levels after. */
const fireballDice = (level: number) => 8 + Math.floor((level - 5) / 2);
/** Wizard/Sorcerer leveled spells a fight. */
const bigSpellUses = (level: number) => (level >= 17 ? 3 : level >= 9 ? 2 : 1);
const bigSpellName = (level: number) =>
  `${level >= 5 ? `Fireball (${fireballDice(level)}d6` : "Magic Missile (3d4 + 3, never misses"}, ${bigSpellUses(level)}/fight)`;

const CANTRIP: Record<string, { die: number; name: string }> = {
  wizard: { die: 10, name: "Fire Bolt" },
  sorcerer: { die: 10, name: "Fire Bolt" },
  warlock: { die: 10, name: "Eldritch Blast" },
  cleric: { die: 8, name: "Toll the Dead" },
  druid: { die: 8, name: "Produce Flame" },
  bard: { die: 8, name: "Vicious Mockery" },
};

export interface Kit {
  cls: string;
  level: number;
  ability: Ability;
  mod: number;
  prof: number;
  /** Damage dice per hit: `dice` d `die`, plus `dmgMod` (usually the ability mod). */
  die: number;
  dice: number;
  dmgMod: number;
  /** Attack rolls per turn (Extra Attack, Eldritch Blast beams). */
  attacks: number;
  /** Lowest natural roll that crits (19 with Improved Critical). */
  critOn: number;
  /** Extra dice of the weapon's die on a crit (Brutal Critical, Savage Attacks). */
  critDice: number;
  /** Hunter's edge: +to-hit and +damage vs monsters. */
  edge: number;
  rage: number;
  sneak: number;
  uncanny: number;
  uncannyRound: number;
  martialDie: number;
  markName: string; // "mark" (Hunter's Mark) / "hex" — +1d6 a hit
  smiteDice: number;
  smites: number;
  improvedSmite: boolean;
  layOnHands: number;
  secondWind: boolean;
  actionSurge: boolean;
  quickened: number;
  shields: number;
  heals: number;
  healDice: number;
  inspiration: number;
  inspireDie: number;
  wildShape: number;
  lucky: boolean;
  relentless: boolean;
  breathDice: number;
  breathDc: number;
  /** "fire breath" etc. from the Dragonborn's ancestry, or plain "breath weapon". */
  breathName: string;
  /** Wizard/Sorcerer leveled spell: Magic Missile (L1–4) or Fireball (L5+). */
  bigSpells: number;
  /** Cleric Spiritual Weapon: a bonus strike every turn, this many d8. */
  spiritDice: number;
  /** Ranger Colossus Slayer: +1d8 once a turn on a wounded target. */
  colossus: boolean;
  /** Monk Flurry of Blows: ki for a second bonus strike, one a turn. */
  ki: number;
  /** Debuffs this hero can inflict, chosen by chooseHinder. */
  hinders: Hinder[];
  /** Uses left of the `cost: "uses"` hinders (superiority dice, spell slots). */
  hinderUses: number;
  /** Save DC against this hero's hinders. */
  hinderDc: number;
  /** Bard Cutting Words: spends inspiration against a foe's attack roll. */
  cuttingWords: boolean;
  /** Ability names, for the fight's stat lines. */
  names: string[];
}

/** What a condition does to the fighter suffering it. */
export interface DebuffEffect {
  /** Its attack rolls are at disadvantage. */
  disadvantage?: boolean;
  /** Attack rolls against it are at advantage. */
  exposed?: boolean;
  /** −1dN on its attack rolls (Bane). */
  penaltyDie?: number;
  /** Its attacks deal half damage. */
  halfDamage?: boolean;
  /** It loses its turns. */
  stunned?: boolean;
  /** Ends after its next attack roll. */
  once?: boolean;
}

/** A condition on a fighter, e.g. frightened for 2 of its turns. */
export interface Debuff extends DebuffEffect {
  name: string;
  by: string;
  /** Its own turns left; counted down from the turn after it first had one. */
  turns: number;
  seen?: boolean;
  /** A save it repeats at the start of each of those later turns to end it. */
  save?: Ability;
  dc?: number;
}

/** One way a hero hinders a foe. */
export interface Hinder {
  name: string;
  /** The condition it leaves, as in "the Goblin is frightened". */
  cond: string;
  /** A rider on a hit, a spell in place of the turn's first attack, or at
   * the start of the turn. */
  how: "rider" | "cast" | "start";
  /** What it spends: the kit's hinderUses, a ki point, or nothing. */
  cost: "uses" | "ki" | "free";
  /** The save that shakes it off; none: it lands with the hit. */
  save?: Ability;
  turns: number;
  /** Spells that last up to a minute: the target repeats the save each turn. */
  repeat?: boolean;
  effect: DebuffEffect;
  /** Extra damage on the hit: dice of sides (superiority die, Wrathful Smite). */
  bonus?: [number, number];
  /** Cunning Strike: rides a sneak attack and costs one of its d6s. */
  sneak?: boolean;
  /** Vicious Mockery: only on the cantrip, not a bonus strike. */
  cantrip?: boolean;
}

/** One side of a fight: a hero (with `c` and `kit`) or a monster. */
export interface Fighter {
  name: string;
  hp: number;
  max: number;
  ac: number;
  acWhy: string;
  c?: any;
  kit?: Kit;
  // Monsters: attack bonus and one damage die plus a bonus.
  attack?: number;
  die?: number;
  bonus?: number;
  /** DEX save bonus (against a Dragonborn's breath). */
  dexSave?: number;
  /** Solo hunts: once a fight, a d20 + CON at this DC leaves the hero on 1 HP. */
  fateDc?: number;
  fateUsed?: boolean;
  /** The side this fighter is on (for healing and inspiring allies). */
  team?: Fighter[];
  /** Conditions it suffers (combat_abilities debuffs). */
  debuffs?: Debuff[];
  /** The last round it started a turn in (a monster may attack several times a round). */
  turnRound?: number;
}

/** Builds a hero's kit. `stateless`: classic turn-by-turn fights, which keep
 * no state between commands — always-on features only. `minDie`: a fight's
 * weapon die floor (heroes swing a d10 against monsters). `edge`: hunter's
 * edge vs monsters. */
export function makeKit(c: any, opts: { stateless?: boolean; minDie?: number; edge?: number } = {}): Kit {
  const cls = String(c.cls ?? "").trim().toLowerCase();
  const level = Math.max(1, Math.min(20, Math.floor(Number(c.level) || 1)));
  const prof = Number(c.proficiency ?? 2);
  const ability = attackAbility(c);
  const mod = modifier(Number(c.scores?.[ability] ?? 10));
  const sc = (a: Ability) => modifier(Number(c.scores?.[a] ?? 10));
  const traits: string[] = (c.traits ?? []).map((t: string) => String(t).toLowerCase());
  const has = (t: string) => traits.includes(t);
  const limited = (n: number) => (opts.stateless ? 0 : n);
  const names: string[] = [];
  const cantrip = CANTRIP[cls];
  const k: Kit = {
    cls, level, ability, mod, prof,
    die: cantrip ? cantrip.die : Math.max(8, opts.minDie ?? 8),
    dice: cantrip && cls !== "warlock" ? cantripDice(level) : 1,
    dmgMod: cls === "warlock" && level < 2 ? 0 : mod,
    attacks: 1, critOn: 20, critDice: 0, edge: opts.edge ?? 0,
    rage: 0, sneak: 0, uncanny: 0, uncannyRound: 0, martialDie: 0, markName: "",
    smiteDice: 0, smites: 0, improvedSmite: false, layOnHands: 0,
    secondWind: false, actionSurge: false, quickened: 0, shields: 0,
    heals: 0, healDice: 0, inspiration: 0, inspireDie: 0, wildShape: 0,
    lucky: false, relentless: false, breathDice: 0, breathDc: 0, breathName: "breath weapon", bigSpells: 0, spiritDice: 0, colossus: false, ki: 0,
    hinders: [], hinderUses: 0, hinderDc: 8 + prof + mod, cuttingWords: false, names,
  };
  const dc = `DC ${k.hinderDc}`;
  /** A class debuff with `uses` a fight (shared with any others of the class). */
  const hinder = (h: Hinder, name: string, uses = 0) => {
    k.hinders.push(h);
    if (uses) k.hinderUses = limited(uses);
    names.push(name);
  };
  const slots = (level9: number) => (level >= level9 ? 2 : 1);
  if (cantrip) names.push(`${cantrip.name} (${cls === "warlock" ? `${cantripDice(level)} beam${cantripDice(level) > 1 ? "s" : ""}` : `${k.dice}d${k.die}`})`);
  const extraAttack = level >= 5 && ["barbarian", "fighter", "paladin", "ranger", "monk"].includes(cls);
  switch (cls) {
    case "barbarian":
      k.rage = level >= 16 ? 4 : level >= 9 ? 3 : 2;
      names.push(`Rage (+${k.rage} damage, 25% less taken)`);
      if (level >= 9) {
        k.critDice += level >= 17 ? 3 : level >= 13 ? 2 : 1;
        names.push(`Brutal Critical (+${k.critDice} crit ${k.critDice > 1 ? "dice" : "die"})`);
      }
      if (level >= 3) {
        hinder(
          { name: "Intimidating Presence", cond: "frightened", how: "start", cost: "uses", save: "WIS", turns: 2, effect: { disadvantage: true } },
          `Intimidating Presence (frightened, ${dc}, 1/fight)`, 1,
        );
      }
      break;
    case "fighter":
      k.secondWind = !opts.stateless;
      names.push(`Second Wind (1d10 + ${level} HP, 1/fight)`);
      if (level >= 2) {
        k.actionSurge = !opts.stateless;
        names.push("Action Surge (1/fight)");
      }
      if (level >= 3) {
        k.critOn = 19;
        names.push("Improved Critical (19–20)");
        const sup = level >= 10 ? 10 : 8;
        const dice = level >= 15 ? 4 : level >= 7 ? 3 : 2;
        k.hinders.push(
          { name: "Trip Attack", cond: "prone", how: "rider", cost: "uses", save: "STR", turns: 1, effect: { exposed: true }, bonus: [1, sup] },
          { name: "Menacing Attack", cond: "frightened", how: "rider", cost: "uses", save: "WIS", turns: 1, effect: { disadvantage: true }, bonus: [1, sup] },
        );
        k.hinderUses = limited(dice);
        names.push(`Trip/Menacing Attack (+1d${sup}, prone or frightened, ${dc}, ${dice}/fight)`);
      }
      break;
    case "paladin":
      k.layOnHands = limited(2 * level);
      names.push(`Lay on Hands (${2 * level} HP/fight)`);
      if (level >= 2) {
        k.smiteDice = 2;
        const smites = level >= 13 ? 4 : level >= 9 ? 3 : level >= 5 ? 2 : 1;
        k.smites = limited(smites);
        names.push(`Divine Smite (+${k.smiteDice}d8, ${smites}/fight)`);
        hinder(
          { name: "Wrathful Smite", cond: "frightened", how: "rider", cost: "uses", save: "WIS", turns: 10, repeat: true, effect: { disadvantage: true }, bonus: [1, 6] },
          `Wrathful Smite (+1d6, frightened, ${dc}, ${slots(9)}/fight)`, slots(9),
        );
      }
      if (level >= 11) {
        k.improvedSmite = true;
        names.push("Improved Divine Smite (+1d8)");
      }
      break;
    case "ranger":
      if (level >= 2) {
        k.markName = "mark";
        names.push("Hunter's Mark (+1d6)");
        hinder(
          { name: "Ensnaring Strike", cond: "restrained", how: "rider", cost: "uses", save: "STR", turns: 10, repeat: true, effect: { disadvantage: true, exposed: true } },
          `Ensnaring Strike (restrained, ${dc}, ${slots(9)}/fight)`, slots(9),
        );
      }
      if (level >= 3) {
        k.colossus = true;
        names.push("Colossus Slayer (+1d8 on the wounded)");
      }
      break;
    case "rogue":
      k.sneak = Math.ceil(level / 2);
      names.push(`Sneak Attack (${k.sneak}d6)`);
      if (level >= 5) {
        k.uncanny = limited(prof);
        names.push(`Uncanny Dodge (${prof}/fight)`);
        k.hinders.push(
          { name: "Poison", cond: "poisoned", how: "rider", cost: "free", save: "CON", turns: 2, effect: { disadvantage: true }, sneak: true },
          { name: "Trip", cond: "prone", how: "rider", cost: "free", save: "DEX", turns: 1, effect: { exposed: true }, sneak: true },
        );
        names.push(`Cunning Strike (poison or trip for 1d6 of sneak, ${dc})`);
      }
      break;
    case "monk":
      k.martialDie = level >= 17 ? 10 : level >= 11 ? 8 : level >= 5 ? 6 : 4;
      names.push(`Martial Arts (bonus strike 1d${k.martialDie})`);
      if (level >= 2) {
        k.ki = limited(level);
        names.push(`Flurry of Blows (${level}/fight)`);
      }
      if (level >= 5) {
        hinder(
          { name: "Stunning Strike", cond: "stunned", how: "rider", cost: "ki", save: "CON", turns: 1, effect: { stunned: true, exposed: true } },
          `Stunning Strike (1 ki, ${dc})`,
        );
      }
      break;
    case "wizard":
      k.shields = limited(level >= 5 ? 3 : 2);
      names.push(`Shield (+5 AC, ${level >= 5 ? 3 : 2}/fight)`);
      k.bigSpells = limited(bigSpellUses(level));
      names.push(bigSpellName(level));
      if (level >= 3) {
        hinder(
          { name: "Ray of Enfeeblement", cond: "enfeebled", how: "cast", cost: "uses", save: "CON", turns: 10, repeat: true, effect: { halfDamage: true } },
          `Ray of Enfeeblement (half damage, ${dc}, ${slots(9)}/fight)`, slots(9),
        );
      }
      if (level >= 9) {
        hinder(
          { name: "Hold Monster", cond: "paralyzed", how: "cast", cost: "uses", save: "WIS", turns: 10, repeat: true, effect: { stunned: true, exposed: true } },
          "Hold Monster (paralyzed, shares Ray's uses)",
        );
      }
      break;
    case "sorcerer":
      k.bigSpells = limited(bigSpellUses(level));
      names.push(bigSpellName(level));
      if (level >= 3) {
        k.quickened = limited(level >= 10 ? 2 : 1);
        names.push(`Quickened Spell (${level >= 10 ? 2 : 1}/fight)`);
        hinder(
          { name: "Blindness", cond: "blinded", how: "cast", cost: "uses", save: "CON", turns: 10, repeat: true, effect: { disadvantage: true, exposed: true } },
          `Blindness (blinded, ${dc}, ${slots(9)}/fight)`, slots(9),
        );
      }
      break;
    case "warlock":
      k.attacks = cantripDice(level);
      k.markName = "hex";
      names.push("Hex (+1d6)");
      if (level >= 2) names.push("Agonizing Blast (+CHA)");
      hinder(
        { name: "Cause Fear", cond: "frightened", how: "cast", cost: "uses", save: "WIS", turns: 10, repeat: true, effect: { disadvantage: true } },
        `Cause Fear (frightened, ${dc}, ${slots(11)}/fight)`, slots(11),
      );
      break;
    case "cleric":
      k.heals = limited(level >= 9 ? 4 : level >= 3 ? 3 : 2);
      k.healDice = 1 + Math.floor(level / 4);
      names.push(`Healing Word (${k.healDice}d4 + WIS, ${level >= 9 ? 4 : level >= 3 ? 3 : 2}/fight)`);
      if (level >= 3) {
        k.spiritDice = level >= 15 ? 3 : level >= 9 ? 2 : 1;
        names.push(`Spiritual Weapon (${k.spiritDice}d8)`);
      }
      hinder(
        { name: "Bane", cond: "baned", how: "cast", cost: "uses", save: "CHA", turns: 10, effect: { penaltyDie: 4 } },
        `Bane (−1d4 to its attacks, ${dc}, ${slots(9)}/fight)`, slots(9),
      );
      break;
    case "druid":
      k.heals = limited(level >= 9 ? 3 : 2);
      k.healDice = 1 + Math.floor(level / 4);
      names.push(`Healing Word (${k.healDice}d4 + WIS, ${level >= 9 ? 3 : 2}/fight)`);
      if (level >= 2) {
        k.wildShape = limited(5 + 2 * level);
        names.push(`Wild Shape (${5 + 2 * level} HP beast form, 1/fight)`);
      }
      hinder(
        { name: "Entangle", cond: "restrained", how: "cast", cost: "uses", save: "STR", turns: 10, repeat: true, effect: { disadvantage: true, exposed: true } },
        `Entangle (restrained, ${dc}, ${slots(9)}/fight)`, slots(9),
      );
      break;
    case "bard":
      k.inspiration = limited(Math.max(1, sc("CHA")));
      k.inspireDie = level >= 15 ? 12 : level >= 10 ? 10 : level >= 5 ? 8 : 6;
      names.push(`Bardic Inspiration (d${k.inspireDie}, ${Math.max(1, sc("CHA"))}/fight)`);
      k.heals = limited(level >= 9 ? 2 : 1);
      k.healDice = 1 + Math.floor(level / 4);
      names.push(`Healing Word (${k.healDice}d4 + CHA, ${level >= 9 ? 2 : 1}/fight)`);
      // The cantrip itself: no name of its own, it's already on the list.
      k.hinders.push({ name: "Vicious Mockery", cond: "rattled", how: "rider", cost: "free", turns: 1, effect: { disadvantage: true, once: true }, cantrip: true });
      names[0] = names[0].replace(/\)$/, ", rattles: disadvantage on its next attack)");
      if (level >= 3) {
        k.cuttingWords = !opts.stateless;
        names.push("Cutting Words (inspiration off a foe's attack)");
      }
      break;
  }
  if (extraAttack) {
    k.attacks = cls === "fighter" ? (level >= 20 ? 4 : level >= 11 ? 3 : 2) : 2;
    names.push(`Extra Attack (×${k.attacks})`);
  }
  if (has("lucky")) {
    k.lucky = true;
    names.push("Lucky (reroll natural 1s)");
  }
  if (has("relentless endurance")) {
    k.relentless = !opts.stateless;
    names.push("Relentless Endurance (1/fight)");
  }
  if (has("savage attacks")) {
    k.critDice += 1;
    names.push("Savage Attacks (+1 crit die)");
  }
  if (has("breath weapon") && !opts.stateless) {
    k.breathDice = level >= 16 ? 5 : level >= 11 ? 4 : level >= 6 ? 3 : 2;
    k.breathDc = 8 + sc("CON") + prof;
    const element = draconicAncestry[String(c.subrace ?? "").trim()];
    if (element) k.breathName = `${element} breath`;
    names.push(`Breath Weapon (${element ? `${element}, ` : ""}${k.breathDice}d6, DC ${k.breathDc}, 1/fight)`);
  }
  return k;
}

/** A hero ready to fight. `acBase` is 10 (PvP) or 11 (vs monsters). */
export function heroFighter(
  name: string,
  c: any,
  hp: number,
  acBase: number,
  opts: { stateless?: boolean; minDie?: number; edge?: number; fateDc?: number } = {},
): Fighter {
  const cls = String(c.cls ?? "");
  const saves: string[] = (classes as any)[cls]?.savingThrows ?? [];
  const dexSave = modifier(Number(c.scores?.DEX ?? 10)) + (saves.includes("DEX") ? Number(c.proficiency ?? 2) : 0);
  return {
    name, c, hp, max: Number(c.hpMax ?? hp), ac: heroAc(c, acBase).ac, acWhy: heroAcWhy(acBase, c),
    kit: makeKit(c, opts), dexSave, fateDc: opts.fateDc,
  };
}

/** A monster (bestiary entry or raid boss) ready to fight. */
export function monsterFighter(m: { name: string; ac: number; attack: number; die: number; bonus: number }, hp: number, max: number): Fighter {
  return {
    name: m.name, hp, max, ac: m.ac, acWhy: "stat block",
    attack: m.attack, die: m.die, bonus: m.bonus, dexSave: Math.floor(m.attack / 2),
  };
}

/** Puts fighters on one side, for Healing Word and Bardic Inspiration. */
export function team(...fighters: Fighter[]): Fighter[] {
  for (const f of fighters) f.team = fighters;
  return fighters;
}

/** "Abilities: Rage (+2 dmg, half damage taken), Extra Attack (×2)" — "" with none. */
export function kitLine(k: Kit | undefined): string {
  return k?.names.length ? ` Abilities: ${k.names.join(", ")}.` : "";
}

// ---------------------------------------------------------------------------
// Taking damage
// ---------------------------------------------------------------------------

/** Applies `raw` damage to `t`, through its defenses (Rage, Uncanny Dodge,
 * Wild Shape) and last stands (Relentless Endurance, fate). Returns the
 * damage taken and the notes to log after the blow. */
function takeHit(t: Fighter, raw: number, round: number): { taken: number; tags: string[]; after: string[]; shownHp: number } {
  const k = t.kit;
  const tags: string[] = [];
  const after: string[] = [];
  let dmg = raw;
  if (k?.rage && dmg > 1) {
    dmg -= Math.floor(dmg / 4);
    tags.push("rage: −25%");
  }
  if (k?.uncanny && k.uncannyRound !== round && dmg > 1) {
    k.uncanny--;
    k.uncannyRound = round;
    dmg = Math.floor(dmg / 2);
    tags.push("uncanny dodge: half");
  }
  if (k?.wildShape) {
    const soaked = Math.min(k.wildShape, dmg);
    k.wildShape -= soaked;
    dmg -= soaked;
    tags.push(k.wildShape ? `beast form soaks ${soaked}` : `beast form soaks ${soaked} and breaks`);
  }
  t.hp = Math.max(0, t.hp - dmg);
  const shownHp = t.hp;
  if (t.hp <= 0 && k?.relentless) {
    k.relentless = false;
    t.hp = 1;
    after.push(`🪓 ${t.name} refuses to fall — Relentless Endurance, 1 HP`);
  } else if (t.hp <= 0 && t.fateDc && !t.fateUsed) {
    t.fateUsed = true;
    const roll = d(20);
    const con = modifier(Number(t.c?.scores?.CON ?? 10));
    if (roll + con >= t.fateDc) {
      t.hp = 1;
      after.push(`✨ fate stays its hand — ${t.name === "you" ? "you are" : t.name + " is"} left at 1 HP`);
      after.push(`(Fate's roll, d20 ${roll} ${con < 0 ? "−" : "+"}${Math.abs(con)} CON = ${roll + con}, met DC ${t.fateDc}: once per fight, a blow that would drop the hero leaves them at 1 HP instead.)`);
    }
  }
  return { taken: dmg, tags, after, shownHp };
}

function record(battle: BattleLog, s: Strike, after: string[]) {
  battle.strike(s);
  // The first note is chat-worthy; any further ones (the fate roll's
  // working) belong on the detail page only.
  after.forEach((line, i) => (i === 0 ? battle.note(line) : battle.explain(line)));
}

// ---------------------------------------------------------------------------
// Debuffs
// ---------------------------------------------------------------------------

const signed = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n)}`;
const is = (f: Fighter) => (f.name === "you" ? "are" : "is");

/** A fighter's saving throw bonus: a hero's ability modifier (+ proficiency
 * in their class's saves); a monster's half its attack bonus for any save. */
function saveBonus(f: Fighter, ab: Ability): number {
  if (!f.c) return f.dexSave ?? 0;
  const saves: string[] = (classes as any)[String(f.c.cls ?? "")]?.savingThrows ?? [];
  return modifier(Number(f.c.scores?.[ab] ?? 10)) + (saves.includes(ab) ? Number(f.c.proficiency ?? 2) : 0);
}

/** Start of a fighter's turn — once a round, however many attacks a monster
 * makes: conditions that have run their course end. Returns true when it is
 * stunned or paralyzed and loses the turn. */
function startTurn(f: Fighter, battle: BattleLog, round: number): boolean {
  if (f.turnRound === round) return !!f.debuffs?.some((x) => x.stunned);
  f.turnRound = round;
  const kept: Debuff[] = [];
  for (const x of f.debuffs ?? []) {
    if (x.seen && x.save && x.dc) {
      const roll = d(20), bonus = saveBonus(f, x.save);
      if (roll + bonus >= x.dc) {
        battle.explain(`${f.name} ${x.save} save ${roll} ${signed(bonus)} = ${roll + bonus} vs DC ${x.dc} → no longer ${x.name}`);
        continue;
      }
    }
    if (x.seen && --x.turns <= 0) {
      battle.explain(`${f.name} ${is(f)} no longer ${x.name}`);
      continue;
    }
    x.seen = true;
    kept.push(x);
  }
  f.debuffs = kept;
  const stun = kept.find((x) => x.stunned);
  if (stun) battle.note(`😵 ${f.name} ${is(f)} ${stun.name} and ${f.name === "you" ? "lose" : "loses"} the turn`, false);
  return !!stun;
}

/** The d20 for an attack by `me` at `t`: advantage when `t` is prone,
 * restrained, blinded or stunned, disadvantage when `me` is frightened,
 * poisoned, rattled, restrained or blinded (the two cancel), and Bane's −1d4
 * onto `atk`. A rattled attacker's disadvantage is spent by the roll. */
function attackD20(me: Fighter, t: Fighter, tags: string[], atk: Mods): number {
  const mine = me.debuffs ?? [];
  const dis = mine.find((x) => x.disadvantage);
  const adv = t.debuffs?.find((x) => x.exposed);
  const a = d(20), b = d(20);
  let roll = a;
  if (adv && !dis) {
    roll = Math.max(a, b);
    tags.push(`advantage: ${adv.name}`);
  } else if (dis && !adv) {
    roll = Math.min(a, b);
    tags.push(`disadvantage: ${dis.name}`);
  }
  for (const x of mine) if (x.penaltyDie) atk.push([x.name, -d(x.penaltyDie)]);
  if (mine.some((x) => x.once)) me.debuffs = mine.filter((x) => !x.once);
  return roll;
}

/** Halves the damage of an enfeebled attacker. */
function weakened(me: Fighter, raw: number, tags: string[]): number {
  const x = me.debuffs?.find((y) => y.halfDamage);
  if (!x) return raw;
  tags.push(`${x.name}: half`);
  return Math.max(1, Math.floor(raw / 2));
}

/** Bard Cutting Words: a bard on `t`'s side spends an inspiration to take
 * the die off an attack roll that would hit `t`, when that could turn it.
 * Returns the new total. */
function cuttingWords(t: Fighter, total: number, atk: Mods, tags: string[]): number {
  const bard = (t.team ?? [t]).find((f) => f.hp > 0 && f.kit?.cuttingWords && f.kit.inspiration > 0 && total - t.ac < f.kit.inspireDie);
  if (!bard) return total;
  bard.kit!.inspiration--;
  const cut = d(bard.kit!.inspireDie);
  atk.push([`cutting words by ${bard.name}`, -cut]);
  tags.push(total - cut >= t.ac ? "cutting words, still" : "cutting words");
  return total - cut;
}

const canPay = (k: Kit, h: Hinder) => (h.cost === "uses" ? k.hinderUses > 0 : h.cost === "ki" ? k.ki > 0 : true);
function pay(k: Kit, h: Hinder, n = 1) {
  if (h.cost === "uses") k.hinderUses -= n;
  else if (h.cost === "ki") k.ki -= n;
}

/**
 * Picks the debuff `me` should use on `t` right now, of the kind `how`, or
 * none. Never on a foe under a quarter HP (just finish it) or already
 * helpless; spells only on a foe at half HP or more. Each option is scored
 * by what it adds that `t` doesn't already suffer: a stun most, fear,
 * Bane or enfeeblement more when `me` is hurt, and prone more for every
 * ally standing to take advantage of it.
 */
export function chooseHinder(me: Fighter, t: Fighter, how: Hinder["how"], ok: (h: Hinder) => boolean = () => true): Hinder | undefined {
  const k = me.kit;
  if (!k?.hinders.length || t.hp <= 0 || t.hp < t.max / 4) return undefined;
  // A spell costs an attack: only on a foe fresh and tough enough that the
  // fight will run long enough to repay it.
  const turnDamage = k.attacks * (k.dice * (k.die + 1) / 2 + k.dmgMod);
  if (how === "cast" && (t.hp < t.max / 2 || t.hp < 3 * turnDamage)) return undefined;
  const on = t.debuffs ?? [];
  if (on.some((x) => x.stunned)) return undefined;
  const hurt = me.hp <= me.max / 2;
  const allies = (me.team ?? [me]).filter((f) => f !== me && f.hp > 0).length;
  let best: Hinder | undefined;
  let bestScore = 0;
  for (const h of k.hinders) {
    if (h.how !== how || !canPay(k, h) || !ok(h) || on.some((x) => x.name === h.cond)) continue;
    const e = h.effect;
    let score = 0;
    if (e.stunned) score += 5;
    if (e.disadvantage && !on.some((x) => x.disadvantage)) score += (hurt ? 3 : 2) - (e.once ? 1 : 0);
    if (e.penaltyDie) score += hurt ? 3 : 2;
    if (e.halfDamage && !on.some((x) => x.halfDamage)) score += hurt ? 3 : 2;
    if (e.exposed && !on.some((x) => x.exposed)) score += 1 + allies;
    if (score > bestScore) [best, bestScore] = [h, score];
  }
  return best;
}

/** `t` saves against `h` from `me`, or suffers it. Returns a short tag
 * ("prone" / "resisted") and the save's working for the detail page. */
function inflict(me: Fighter, t: Fighter, h: Hinder): { landed: boolean; tag: string; detail?: string } {
  let detail: string | undefined;
  if (h.save) {
    const roll = d(20), bonus = saveBonus(t, h.save), dc = me.kit!.hinderDc;
    const saved = roll + bonus >= dc;
    detail = `${t.name} ${h.save} save vs ${h.name}: ${roll} ${signed(bonus)} = ${roll + bonus} vs DC ${dc} → ${saved ? "resisted" : h.cond}`;
    if (saved) return { landed: false, tag: `${h.name.toLowerCase()}: resisted`, detail };
  }
  const again = h.repeat && h.save ? { save: h.save, dc: me.kit!.hinderDc } : {};
  t.debuffs = [...(t.debuffs ?? []).filter((x) => x.name !== h.cond), { name: h.cond, by: me.name, turns: h.turns, ...again, ...h.effect }];
  return { landed: true, tag: `${h.name.toLowerCase()}: ${h.cond}`, detail };
}

/** A debuff spell or roar (not a rider on a hit), logged as its own line. */
function useHinder(me: Fighter, t: Fighter, h: Hinder, battle: BattleLog) {
  pay(me.kit!, h);
  const r = inflict(me, t, h);
  const verb = h.how === "cast" ? (me.name === "you" ? "cast" : "casts") : (me.name === "you" ? "use" : "uses");
  battle.note(`🌀 ${me.name} ${verb} ${h.name} — ${t.name} ${r.landed ? `${is(t)} ${h.cond}` : (t.name === "you" ? "resist" : "resists")}`, false);
  if (r.detail) battle.explain(r.detail);
}

// ---------------------------------------------------------------------------
// Swings
// ---------------------------------------------------------------------------

/** Picks the next target, or undefined when none is standing. */
export type Pick = () => Fighter | undefined;

/** What a hero has used up this turn. */
type Turn = { sneakUsed: boolean; colossusUsed?: boolean; hindered?: boolean };

/** One attack roll by a hero. Returns the strike as logged. */
function heroSwing(me: Fighter, t: Fighter, battle: BattleLog, round: number, turn: Turn, opts: { bonusStrike?: boolean } = {}): Strike {
  const k = me.kit!;
  const tags: string[] = opts.bonusStrike ? [k.martialDie ? "martial arts" : "spiritual weapon"] : [];
  const atk: Mods = [[k.ability, k.mod], ["prof", k.prof]];
  if (k.edge && t.attack !== undefined) atk.push(["edge", k.edge]);
  let roll = attackD20(me, t, tags, atk);
  if (roll === 1 && k.lucky) {
    roll = d(20);
    tags.push("lucky reroll");
  }
  let total = roll + sum(atk.map(([, v]) => v));
  const crit = roll >= k.critOn;
  let hit = crit || (roll !== 1 && total >= t.ac);
  // Bardic Inspiration from anyone on the team (this hero included).
  if (!hit && roll !== 1) {
    const bard = (me.team ?? [me]).find((f) => f.hp > 0 && f.kit?.inspiration && t.ac - total <= f.kit.inspireDie);
    if (bard) {
      const bonus = d(bard.kit!.inspireDie);
      bard.kit!.inspiration--;
      atk.push([`inspired by ${bard.name}`, bonus]);
      total += bonus;
      hit = total >= t.ac;
      tags.push(hit ? "inspired" : "inspired, still");
    }
  }
  if (hit && !crit) {
    total = cuttingWords(t, total, atk, tags);
    hit = total >= t.ac;
  }
  // Wizard's Shield: +5 AC as a reaction against a hit that it turns.
  if (hit && !crit && t.kit?.shields && total < t.ac + 5 && t.hp > 0) {
    t.kit.shields--;
    hit = false;
    tags.push(`${t.name} casts Shield`);
  }
  const hpBefore = t.hp;
  const base: Strike = {
    actor: me.name, target: t.name, hit, crit, fumble: roll === 1, roll, total, ac: t.ac,
    damage: 0, targetHp: t.hp, targetMax: t.max, acWhy: t.acWhy, atk, hpBefore,
  };
  if (!hit) {
    base.tag = tags.join(", ") || undefined;
    record(battle, base, []);
    return base;
  }
  const die = opts.bonusStrike ? (k.martialDie || 8) : k.die;
  const count = opts.bonusStrike ? (k.martialDie ? 1 : k.spiritDice) : k.dice;
  const rolls = rollDice(crit ? count * 2 + k.critDice : count, die);
  const dmgMods: Mods = [[k.ability, opts.bonusStrike ? k.mod : k.dmgMod]];
  if (k.edge && t.attack !== undefined) dmgMods.push(["edge", k.edge]);
  const extra = (label: string, n: number, sides: number) => {
    const r = sum(rollDice(crit ? n * 2 : n, sides));
    dmgMods.push([label, r]);
  };
  // One debuff riding a hit a turn (a maneuver, Stunning Strike, Cunning
  // Strike...), if the chooser thinks it worth it.
  const rider = turn.hindered ? undefined : chooseHinder(me, t, "rider", (h) =>
    (!h.sneak || (k.sneak > 1 && !turn.sneakUsed)) && !(h.cantrip && opts.bonusStrike));
  if (rider) {
    turn.hindered = true;
    pay(k, rider);
    if (rider.bonus) extra(`${rider.name.toLowerCase()} ${rider.bonus[0]}d${rider.bonus[1]}`, ...rider.bonus);
  }
  if (k.rage) dmgMods.push(["rage", k.rage]);
  if (k.sneak && !turn.sneakUsed) {
    turn.sneakUsed = true;
    const sneak = k.sneak - (rider?.sneak ? 1 : 0);
    extra(`sneak ${sneak}d6`, sneak, 6);
    tags.push("sneak attack");
  }
  if (k.markName) extra(`${k.markName} 1d6`, 1, 6);
  if (k.colossus && !turn.colossusUsed && t.hp < t.max) {
    turn.colossusUsed = true;
    extra("colossus 1d8", 1, 8);
  }
  if (k.smites > 0 && !opts.bonusStrike) {
    k.smites--;
    extra(`smite ${k.smiteDice}d8`, k.smiteDice, 8);
    tags.push("smite");
  }
  if (k.improvedSmite && !opts.bonusStrike) extra("radiant 1d8", 1, 8);
  const raw = weakened(me, Math.max(1, sum(rolls) + sum(dmgMods.map(([, v]) => v))), tags);
  const hit2 = takeHit(t, raw, round);
  tags.push(...hit2.tags);
  let detail: string | undefined;
  if (rider && t.hp > 0) {
    const r = inflict(me, t, rider);
    tags.push(r.tag);
    detail = r.detail;
  } else if (rider && !rider.bonus) {
    pay(k, rider, -1); // the blow dropped it: nothing spent
  }
  const s: Strike = {
    ...base, damage: hit2.taken, targetHp: hit2.shownHp, dmgDice: rolls, dmgDie: die, dmgMods,
    tag: tags.join(", ") || undefined,
  };
  record(battle, s, hit2.after);
  if (detail) battle.explain(detail);
  return s;
}

/** A DEX-save-for-half blast (Dragonborn breath, Fireball). */
function blast(me: Fighter, t: Fighter, battle: BattleLog, round: number, what: string, dice: number, dc: number): Strike {
  const save = d(20);
  const saveTotal = save + (t.dexSave ?? 0);
  const saved = saveTotal >= dc;
  const rolls = rollDice(dice, 6);
  const raw = Math.max(1, saved ? Math.floor(sum(rolls) / 2) : sum(rolls));
  const hpBefore = t.hp;
  const hit = takeHit(t, raw, round);
  const s: Strike = {
    actor: me.name, target: t.name, hit: true, crit: false, fumble: false, roll: save, total: saveTotal, ac: dc,
    damage: hit.taken, targetHp: hit.shownHp, targetMax: t.max, hpBefore, dmgDice: rolls, dmgDie: 6, dmgMods: [],
    tag: [...(saved ? ["saved: half"] : []), ...hit.tags].join(", ") || undefined,
    save: { dc, saved, what },
  };
  record(battle, s, hit.after);
  return s;
}

/** Magic Missile: three darts that never miss, 1d4 + 1 each. */
function missiles(me: Fighter, t: Fighter, battle: BattleLog, round: number): Strike {
  const rolls = rollDice(3, 4);
  const hpBefore = t.hp;
  const hit = takeHit(t, sum(rolls) + 3, round);
  const s: Strike = {
    actor: me.name, target: t.name, hit: true, crit: false, fumble: false, roll: 0, total: 0, ac: t.ac,
    damage: hit.taken, targetHp: hit.shownHp, targetMax: t.max, acWhy: t.acWhy, hpBefore,
    dmgDice: rolls, dmgDie: 4, dmgMods: [["darts", 3]], tag: ["magic missile", ...hit.tags].join(", "), auto: true,
  };
  record(battle, s, hit.after);
  return s;
}

/** Start-of-turn healing: Second Wind, Lay on Hands, Healing Word. */
function heal(me: Fighter, battle: BattleLog) {
  const k = me.kit!;
  const mend = (who: Fighter, amount: number, what: string) => {
    const before = who.hp;
    who.hp = Math.min(who.max, who.hp + amount);
    const by = who === me ? "" : ` by ${me.name}`;
    battle.note(`💚 ${who.name} ${what}${by} +${who.hp - before} (${who.hp}/${who.max})`, false);
  };
  if (k.secondWind && me.hp <= me.max / 2) {
    k.secondWind = false;
    mend(me, d(10) + k.level, "catches a Second Wind");
  }
  if (k.layOnHands > 0 && me.hp <= me.max / 3) {
    const amount = Math.min(k.layOnHands, me.max - me.hp);
    k.layOnHands -= amount;
    mend(me, amount, "lays on hands");
  }
  if (k.heals > 0) {
    const hurt = (me.team ?? [me])
      .filter((f) => f.hp > 0 && f.hp <= f.max / 2)
      .sort((a, b) => a.hp / a.max - b.hp / b.max)[0];
    if (hurt) {
      k.heals--;
      mend(hurt, Math.max(1, sum(rollDice(k.healDice, 4)) + k.mod), "is mended with a Healing Word");
    }
  }
}

/**
 * A hero's whole turn: healing, then every attack they get (Extra Attack,
 * Action Surge and Quickened Spell in round 1, the Breath Weapon on round
 * 1, a monk's bonus strike), each at whoever `pick` names. `round` is
 * 1-based. Returns the strikes made.
 */
export function heroTurn(me: Fighter, pick: Pick, battle: BattleLog, round: number): Strike[] {
  const k = me.kit!;
  const out: Strike[] = [];
  if (me.hp <= 0 || startTurn(me, battle, round)) return out;
  heal(me, battle);
  const turn: Turn = { sneakUsed: false };
  const first = pick();
  const roar = first && chooseHinder(me, first, "start");
  if (roar) useHinder(me, first, roar, battle);
  let swings = k.attacks;
  if (round === 1 && k.actionSurge) {
    k.actionSurge = false;
    swings += k.attacks;
    battle.note(`⚡ ${me.name} surges into action`, false);
  }
  if (round === 1 && k.quickened > 0) {
    k.quickened--;
    swings += k.attacks;
    battle.note(`⚡ ${me.name} quickens a spell`, false);
  }
  for (let i = 0; i < swings; i++) {
    const t = pick();
    if (!t) break;
    if (i === 0 && round === 1 && k.breathDice) {
      out.push(blast(me, t, battle, round, k.breathName, k.breathDice, k.breathDc));
      k.breathDice = 0;
      continue;
    }
    if (i === 0 && k.bigSpells > 0) {
      k.bigSpells--;
      out.push(
        k.level >= 5
          ? blast(me, t, battle, round, "fireball", fireballDice(k.level), 8 + k.mod + k.prof)
          : missiles(me, t, battle, round),
      );
      continue;
    }
    // A debuff spell takes the place of the turn's first attack.
    const spell = i === 0 ? chooseHinder(me, t, "cast") : undefined;
    if (spell) {
      useHinder(me, t, spell, battle);
      continue;
    }
    out.push(heroSwing(me, t, battle, round, turn));
  }
  if (k.martialDie || k.spiritDice) {
    const t = pick();
    if (t) out.push(heroSwing(me, t, battle, round, turn, { bonusStrike: true }));
  }
  if (k.ki > 0) {
    const t = pick();
    if (t) {
      k.ki--;
      out.push(heroSwing(me, t, battle, round, turn, { bonusStrike: true }));
    }
  }
  return out;
}

/** One monster attack at `t` (crits double the dice). Undefined when the
 * monster is stunned or paralyzed and loses its turn. */
export function monsterTurn(m: Fighter, t: Fighter, battle: BattleLog, round: number): Strike | undefined {
  if (startTurn(m, battle, round)) return undefined;
  const tags: string[] = [];
  const attack = Number(m.attack ?? 0);
  const atk: Mods = [["atk", attack]];
  const roll = attackD20(m, t, tags, atk);
  let total = roll + sum(atk.map(([, v]) => v));
  const crit = roll === 20;
  let hit = crit || (roll !== 1 && total >= t.ac);
  if (hit && !crit) {
    total = cuttingWords(t, total, atk, tags);
    hit = total >= t.ac;
  }
  if (hit && !crit && t.kit?.shields && total < t.ac + 5) {
    t.kit.shields--;
    hit = false;
    tags.push(`${t.name === "you" ? "you cast" : t.name + " casts"} Shield`);
  }
  const hpBefore = t.hp;
  const base: Strike = {
    actor: m.name, target: t.name, hit, crit, fumble: roll === 1, roll, total, ac: t.ac,
    damage: 0, targetHp: t.hp, targetMax: t.max, acWhy: t.acWhy, atk, hpBefore,
    tag: tags.join(", ") || undefined,
  };
  if (!hit) {
    record(battle, base, []);
    return base;
  }
  const rolls = rollDice(crit ? 2 : 1, Number(m.die ?? 6));
  const raw = weakened(m, Math.max(1, sum(rolls) + Number(m.bonus ?? 0)), tags);
  const h = takeHit(t, raw, round);
  const s: Strike = {
    ...base, damage: h.taken, targetHp: h.shownHp, dmgDice: rolls, dmgDie: Number(m.die ?? 6),
    dmgMods: [["bonus", Number(m.bonus ?? 0)]], tag: [...tags, ...h.tags].join(", ") || undefined,
  };
  record(battle, s, h.after);
  return s;
}

/** First standing fighter in a list, as a Pick. */
export const firstStanding = (fs: Fighter[]): Pick => () => fs.find((f) => f.hp > 0);

/** Classic turn-by-turn text for a set of strikes: "Bob attacks Goblin:
 * d20 14 + 5 = 19 vs AC 13 → hit for 9 (sneak attack) (Goblin 11/20 HP)". */
export function classicText(strikes: (Strike | undefined)[]): string {
  return strikes.filter((s): s is Strike => !!s).map((s) => {
    if (s.save) {
      return `${s.actor} uses ${s.save.what} on ${s.target}: DEX save ${s.total} vs DC ${s.save.dc} → ${s.save.saved ? "half" : "full"} ${s.damage} damage (${s.target} ${s.targetHp}/${s.targetMax} HP)`;
    }
    if (s.auto) return `${s.actor}'s magic missile hits ${s.target} for ${s.damage} (${s.target} ${s.targetHp}/${s.targetMax} HP)`;
    const tag = s.tag ? ` (${s.tag})` : "";
    const head = `${s.actor} attacks ${s.target}: d20 ${s.roll}${s.crit ? " CRITICAL" : ""} + ${s.total - s.roll} = ${s.total} vs AC ${s.ac}`;
    return s.hit
      ? `${head} → hit for ${s.damage}${tag} (${s.target} ${s.targetHp}/${s.targetMax} HP)`
      : `${head} → miss${tag}`;
  }).join("; ") + ".";
}

/** Ability name without its numbers: "Divine Smite (+2d8, 1/fight)" → "Divine Smite". */
const baseName = (n: string) => n.replace(/\s*\(.*\)$/, "");

/** For !abilities: a hero's attack line, their abilities, and the next one
 * they unlock by levelling (null at the top). */
export function abilitySummary(c: any): { attack: string; abilities: string[]; next: string | null } {
  const k = makeKit(c);
  const ac = heroAc(c, 10);
  const signed = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n)}`;
  const swings = k.attacks > 1 ? `${k.attacks}× ` : "";
  // Against monsters a weapon is a d10, the hunter's edge adds +1 to hit
  // and damage, and AC is on base 11 (simulateMonsterFight, raids).
  const vsMonsters = CANTRIP[k.cls] ? "" : `, 1d${Math.max(10, k.die)} vs monsters`;
  const attack = `${swings}d20 ${signed(k.mod + k.prof)} to hit (${k.ability} ${signed(k.mod)}, prof +${k.prof}), ` +
    `${k.dice}d${k.die}${k.dmgMod ? ` ${signed(k.dmgMod)}` : ""} damage${vsMonsters}, AC ${ac.ac} (${ac.ac + 1} vs monsters)`;
  const have = new Set(k.names.map(baseName));
  let next: string | null = null;
  for (let lv = k.level + 1; lv <= 20 && !next; lv++) {
    const gained = makeKit({ ...c, level: lv, proficiency: Math.floor((lv - 1) / 4) + 2 }).names.map(baseName).find((n) => !have.has(n));
    if (gained) next = `${gained} at Lv ${lv}`;
  }
  return { attack, abilities: k.names, next };
}

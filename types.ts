// Shared type definitions for GuildScribe

export type Ability = "STR" | "DEX" | "CON" | "INT" | "WIS" | "CHA";

export type Race = {
  subraces: string[];
  bonuses: Partial<Record<Ability, number>>;
  speed: number;
  traits: string[];
};

export type ClassData = {
  priority: Ability[];
  savingThrows: Ability[];
  hitDie: number;
  calling: string;
};

export type Character = {
  username: string;
  race: string;
  subrace: string | null;
  cls: string;
  level: number;
  xp: number;
  scores: Record<Ability, number>;
  speed: number;
  hpMax: number;
  hpCurrent: number;
  proficiency: number;
  traits: string[];
  spells: string[];
  items: string[];
  feats: string[];
  abilities: string[];
  /** A Druid's active !wildshape form (wildshape.ts), set by getCharacter. */
  wildForm?: WildForm;
};

/** One attack from a beast's stat block: +bonus to hit, dice d die + mod damage. */
export type BeastAttack = {
  name: string;
  bonus: number;
  dice: number;
  die: number;
  mod: number;
  type: string;
  /** Extra damage on every hit ("plus 7 (2d6) Poison damage"). */
  plus?: { dice: number; die: number; type: string };
};

/** A Wild Shape form as fights use it, fixed when the druid shifts. */
export type WildForm = {
  name: string;
  ac: number;
  tempHp: number;
  /** Circle of the Moon (Lunar Form at level 14). */
  moon: boolean;
  str: number;
  dex: number;
  con: number;
  /** One turn's attacks in order: Multiattack spelled out, else the best single attack. */
  attacks: BeastAttack[];
};

export type CreationSession = {
  broadcasterId: string;
  username: string;
  step: string;
  race?: string | null;
  subrace?: string | null;
  cls?: string | null;
  scores?: number[] | Record<Ability, number> | null;
  // BG3-flavored creation only (!bg3) — unused by the standard !newchar wizard.
  subclass?: string | null;
  background?: string | null;
  alignment?: string | null;
  hook?: string | null;
};

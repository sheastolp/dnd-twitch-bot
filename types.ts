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

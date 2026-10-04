// Hunt and Hoard — tunable tables (no logic). Ported from the standalone
// "Hunt & Hoard" bot (The Wandering Clerk) and fitted to GuildScribe's own
// entity lists: monsters come from the channel bestiary (bestiary.ts), gear
// from the peddler catalog (gear.ts), heroes from the character sheet, coin
// from the gold wallet (points_db.ts). Only what GuildScribe had no
// equivalent for lives here: healing potions, the stall's merchants and the
// item-lore lines.

export interface Potion {
  key: string;
  name: string;
  /** [dice, sides, flat] healing, e.g. [2, 4, 2] = 2d4+2. */
  heal: [number, number, number];
  /** Copper. Hunt & Hoard's gold prices ×3, matched to GuildScribe loot
   * (a CR 1 kill drops about 2 sp). */
  price: number;
  desc: string;
}

export const POTIONS: Potion[] = [
  { key: "travelers_tonic", name: "Traveler's Tonic", heal: [1, 4, 1], price: 15, desc: "restores 1d4+1 HP, better than nothing" },
  { key: "minor_potion", name: "Potion of Minor Healing", heal: [2, 4, 2], price: 25, desc: "restores 2d4+2 HP when drunk" },
  { key: "draught_of_vigor", name: "Draught of Vigor", heal: [3, 4, 3], price: 36, desc: "restores 3d4+3 HP, tastes faintly of cinnamon" },
  { key: "greater_potion", name: "Potion of Healing", heal: [4, 6, 4], price: 60, desc: "restores 4d6+4 HP when drunk" },
  { key: "superior_potion", name: "Superior Potion of Healing", heal: [6, 8, 6], price: 120, desc: "restores 6d8+6 HP when drunk" },
  { key: "elixir_of_vitality", name: "Elixir of Vitality", heal: [8, 10, 8], price: 195, desc: "restores 8d10+8 HP when drunk" },
];

export const MERCHANT_NAMES = [
  "Wobble", "Pruneface Yorik", "Tansy Ninefingers", "Old Corrin", "Tam Pockets", "Squint", "Nan Gullyfoot", "Kettle", "Sella Windrags",
];

/** {owner} = merchant, {item} = item name, {desc} = its pitch. */
export const LORE_TEMPLATES: Record<"potion" | "gear", string[]> = {
  potion: [
    "{owner} swears the {item} still smells faintly of the alchemist's cellar where it was brewed.",
    "{owner} won't say where the {item} came from, only that it works — mostly.",
    "According to {owner}, the {item} was mixed during a thunderstorm. Make of that what you will.",
    "{owner} keeps the {item} wrapped in cloth on the cart, just in case it's more fragile than it looks.",
    "{owner} has never actually watched the {item} get made, and has decided it's best not to ask.",
  ],
  gear: [
    "{owner} isn't entirely sure what the {item} does, only that it seemed worth hauling to market.",
    "{owner} claims the {item} is good luck. The Clerk's ledger shows no evidence either way.",
    "Nobody quite remembers where {owner} got the {item}. {owner} isn't telling.",
    "{owner} has caught themselves talking to the {item} more than once on the road. It has never answered.",
    "{owner} keeps dropping the price on the {item} just to see if anyone will bite.",
  ],
};

// ── Tuning ──

/** Offers on the stall at once. */
export const STALL_SLOTS = 3;
/** The whole stall turns over this often (checked lazily on the next look). */
export const STALL_REFRESH_MS = 20 * 60_000;
/** Share of stall slots that are potions; the rest is peddler gear. */
export const STALL_POTION_SHARE = 0.5;
/** Chance a gear slot holds a legendary relic instead of junk. */
export const STALL_LEGENDARY_CHANCE = 0.05;
/** Selling a potion back pays this share of its price. */
export const SELL_BACK_SHARE = 0.5;

export const BOARD_SLOTS = 3;
export const BOARD_REFRESH_MS = 30 * 60_000;
/** Bounties stay on the easy end of the bestiary so they're clearable in a stream. */
export const BOUNTY_MAX_CR = 3;
export const BOUNTY_POTION_CHANCE = 0.35;

/** Passive regen: this many HP every interval, caught up on the next command. */
export const REGEN_HP = 3;
export const REGEN_INTERVAL_MS = 15 * 60_000;
/** !rest heals to this share of max HP. */
export const REST_FRACTION = 0.8;
/** At or under this share of max HP the advisor says to heal first. */
export const LOW_HP_FRACTION = 0.3;
/** Most potions one hero can carry of each kind. */
export const MAX_POTION_STACK = 20;

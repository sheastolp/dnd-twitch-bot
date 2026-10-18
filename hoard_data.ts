// Hunt and Hoard — tunable tables (no logic). Ported from the standalone
// "Hunt & Hoard" bot (The Wandering Clerk) and fitted to GuildScribe's own
// entity lists: monsters come from the channel bestiary (bestiary.ts), gear
// from the peddler catalog (gear.ts), heroes from the character sheet, coin
// from the gold wallet (points_db.ts). Only what GuildScribe had no
// equivalent for lives here: the stall's merchants, the item-lore lines, and
// the potions players may still carry from when potions healed.

/** Potions are no longer sold or drunk (every fight starts at full HP);
 * these only name and price what old packs still hold, for !sell / !drop. */
export interface Potion {
  key: string;
  name: string;
  /** Copper. */
  price: number;
}

export const POTIONS: Potion[] = [
  { key: "travelers_tonic", name: "Traveler's Tonic", price: 15 },
  { key: "minor_potion", name: "Potion of Minor Healing", price: 25 },
  { key: "draught_of_vigor", name: "Draught of Vigor", price: 36 },
  { key: "greater_potion", name: "Potion of Healing", price: 60 },
  { key: "superior_potion", name: "Superior Potion of Healing", price: 120 },
  { key: "elixir_of_vitality", name: "Elixir of Vitality", price: 195 },
];

export const MERCHANT_NAMES = [
  "Wobble", "Pruneface Yorik", "Tansy Ninefingers", "Old Corrin", "Tam Pockets", "Squint", "Nan Gullyfoot", "Kettle", "Sella Windrags",
];

/** {owner} = merchant, {item} = item name, {desc} = its pitch. */
export const LORE_TEMPLATES: string[] = [
  "{owner} isn't entirely sure what the {item} does, only that it seemed worth hauling to market.",
  "{owner} claims the {item} is good luck. The Clerk's ledger shows no evidence either way.",
  "Nobody quite remembers where {owner} got the {item}. {owner} isn't telling.",
  "{owner} has caught themselves talking to the {item} more than once on the road. It has never answered.",
  "{owner} keeps dropping the price on the {item} just to see if anyone will bite.",
];

// ── Tuning ──

/** Offers on the stall at once. */
export const STALL_SLOTS = 3;
/** The whole stall turns over this often (checked lazily on the next look). */
export const STALL_REFRESH_MS = 20 * 60_000;
/** Chance a gear slot holds a legendary relic instead of junk. */
export const STALL_LEGENDARY_CHANCE = 0.05;
/** Selling an old potion back pays this share of its price. */
export const SELL_BACK_SHARE = 0.5;

export const BOARD_SLOTS = 3;
export const BOARD_REFRESH_MS = 30 * 60_000;
/** Bounties stay on the easy end of the bestiary so they're clearable in a stream. */
export const BOUNTY_MAX_CR = 3;

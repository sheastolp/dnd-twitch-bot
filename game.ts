// =============================================================================
//  game.ts   —   ⚙️ GITHUB REPO COPY (sheastolp/The-Wandering-Clerk)
//  Used by: commands.ts, twitch.ts (the live bot process)
//  This is the FULL, ACTIVE copy — combat, the merchant, quests, item
//  lore, passive HP regen, all of it. If you're editing game rules,
//  balance numbers, or Advisor hints, this is the file that matters.
//
//  A second copy of this filename lives in the separate Val Town project
//  (sheastolp's huntandhoardbot val) — that one is a trimmed-down,
//  storage-only subset (just enough for type-checking store.ts and
//  rolling default merchant/quest data on first run). The two are NOT
//  auto-synced; changes here don't propagate there and vice versa. If
//  you're not sure which one you're looking at, check this banner.
// =============================================================================
//  game.ts — all the stateless game math and rules. Nothing in here talks
//  to Twitch or SQLite; it only operates on the plain objects below.
// =============================================================================
import { races, classes, nameFirst, nameEpithet, xpThresholds, monsters, items, merchantNames, itemStoryTemplates, RaceDef, ClassDef, MonsterDef, ItemDef } from "./data.ts";

export type { MonsterDef } from "./data.ts";

export interface InventoryItem extends ItemDef { qty: number }

export interface Character {
  username: string;
  name: string;
  race: RaceDef;
  cls: ClassDef;
  hitDie: number;
  conMod: number;
  level: number;
  xp: number;
  gold: number;
  ac: number;
  hp: number;
  hpMax: number;
  inventory: InventoryItem[];
  equipped: { weapon: InventoryItem | null; armor: InventoryItem | null };
  createdAt: number;
  questProgress: Record<string, number>; // quest id -> kills logged toward it
  lastHealTickAt: number; // for passive regen — see Rules.applyPassiveHealing
}

export interface MerchantOffer { merchant: string; item: ItemDef; postedAt: number }

// -----------------------------------------------------------------------
// Util
// -----------------------------------------------------------------------
export const Util = {
  pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  },
  rollDie(sides: number): number {
    return 1 + Math.floor(Math.random() * sides);
  },
  rollDice(count: number, sides: number): number {
    let total = 0;
    for (let i = 0; i < count; i++) total += Util.rollDie(sides);
    return total;
  },
  clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
  },
  modifier(score: number): number {
    return Math.floor((score - 10) / 2);
  },
  sampleUnique<T>(arr: T[], count: number): T[] {
    if (arr.length <= count) return arr.slice();
    const pool = arr.slice();
    const out: T[] = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      out.push(pool[idx]);
      pool.splice(idx, 1);
    }
    return out;
  },
};

// -----------------------------------------------------------------------
// Rules — character math
// -----------------------------------------------------------------------
export const Rules = {
  PASSIVE_HEAL_INTERVAL_MS: 15 * 60 * 1000, // 15 minutes
  PASSIVE_HEAL_AMOUNT: 3,

  // Catch-up healing: called whenever a character is loaded (see
  // storeClient.ts), not on any timer of its own — so it heals correctly
  // for however much real time has actually passed since the last check,
  // even across gaps between bot runs. Returns true if any healing was
  // applied (i.e., the character needs to be saved).
  applyPassiveHealing(character: Character): boolean {
    if (!character.lastHealTickAt) {
      character.lastHealTickAt = Date.now(); // back-compat: no retroactive burst for old characters
      return false;
    }
    if (character.hp >= character.hpMax) {
      character.lastHealTickAt = Date.now(); // fully healed — no ticks to bank while topped up
      return false;
    }
    const elapsed = Date.now() - character.lastHealTickAt;
    const ticks = Math.floor(elapsed / Rules.PASSIVE_HEAL_INTERVAL_MS);
    if (ticks <= 0) return false;
    const healed = ticks * Rules.PASSIVE_HEAL_AMOUNT;
    character.hp = Util.clamp(character.hp + healed, 0, character.hpMax);
    character.lastHealTickAt += ticks * Rules.PASSIVE_HEAL_INTERVAL_MS; // keep leftover partial-interval progress
    return true;
  },

  rollRandomName(): string {
    return Util.pick(nameFirst) + " " + Util.pick(nameEpithet);
  },

  levelForXp(xp: number): number {
    let level = 1;
    for (let i = xpThresholds.length - 1; i >= 0; i--) {
      if (xp >= xpThresholds[i]) { level = i + 1; break; }
    }
    return Util.clamp(level, 1, 20);
  },

  maxHpForLevel(character: Pick<Character, "hitDie" | "conMod" | "level" | "race">): number {
    const perLevel = Math.max(1, Math.floor(character.hitDie / 2) + 1 + character.conMod);
    const base = Math.max(1, character.hitDie + character.conMod);
    return base + (character.level - 1) * perLevel + character.race.hpBonus * character.level;
  },

  createCharacter(username: string, name: string): Character {
    const race = Util.pick(races);
    const cls = Util.pick(classes);
    const conMod = Util.modifier(Util.rollDice(3, 6) + 5); // biased toward positive CON
    const character: Character = {
      username: username.trim().toLowerCase(),
      name,
      race,
      cls,
      hitDie: cls.hitDie,
      conMod,
      level: 1,
      xp: 0,
      gold: 10,
      ac: 10 + Math.max(0, conMod),
      inventory: [],
      equipped: { weapon: null, armor: null },
      createdAt: Date.now(),
      questProgress: {},
      lastHealTickAt: Date.now(),
      hp: 0,
      hpMax: 0,
    };
    character.hpMax = Rules.maxHpForLevel(character);
    character.hp = character.hpMax;
    return character;
  },

  attackBonusFor(character: Character): number {
    const base = character.cls.atkBonus + Math.floor(character.level / 3);
    const weaponBonus = character.equipped.weapon ? (character.equipped.weapon.atkBonus ?? 0) : 0;
    return base + weaponBonus;
  },

  armorClassFor(character: Character): number {
    const armorBonus = character.equipped.armor ? (character.equipped.armor.acBonus ?? 0) : 0;
    return character.ac + armorBonus;
  },

  sheetLine(character: Character): string {
    const hpBar = character.hp + "/" + character.hpMax + " HP";
    const weapon = character.equipped.weapon ? character.equipped.weapon.name : "bare fists";
    const armor = character.equipped.armor ? character.equipped.armor.name : "no armor";
    return character.name + " — Level " + character.level + " " + character.race.name + " " + character.cls.name +
      " | " + hpBar + " | AC " + Rules.armorClassFor(character) + " | XP " + character.xp + " | Gold " + character.gold +
      " | Wielding: " + weapon + " | Wearing: " + armor;
  },
};

// -----------------------------------------------------------------------
// Combat
// -----------------------------------------------------------------------
export interface HuntResult {
  monster: MonsterDef; won: boolean; log: string[];
  xpGained: number; goldGained: number; leveledTo: number | null;
  hpLeft: number; hpMax: number;
}

export const Combat = {
  pickMonsterForLevel(level: number): MonsterDef {
    const targetCr = Util.clamp((level + 1) / 4, 0.125, 20);
    const hardCeiling = Util.clamp(targetCr * 2 + 0.5, 1, 24);
    const pool = monsters.filter((m) => m.cr <= hardCeiling);
    const weights = pool.map((m) => {
      if (m.cr <= targetCr) return 3;
      if (m.cr <= targetCr * 1.15) return 1.2;
      return 0.4;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  },

  huntMonster(character: Character, forcedMonster?: MonsterDef): HuntResult {
    const monster = forcedMonster ?? Combat.pickMonsterForLevel(character.level);
    let monsterHp = monster.hp;
    let playerHp = character.hp;
    const atkBonus = Rules.attackBonusFor(character);
    const ac = Rules.armorClassFor(character);
    const log: string[] = [];
    let swings = 0;

    while (playerHp > 0 && monsterHp > 0 && swings < 40) {
      swings++;
      const pRoll = Util.rollDie(20);
      const pHit = pRoll === 20 || (pRoll !== 1 && pRoll + atkBonus >= monster.ac);
      if (pHit) {
        const dmg = Math.max(1, Util.rollDice(1, 8) + Math.floor(character.level / 2)) * (pRoll === 20 ? 2 : 1);
        monsterHp = Math.max(0, monsterHp - dmg);
        log.push("you hit for " + dmg);
      } else {
        log.push("you miss");
      }
      if (monsterHp <= 0) break;

      const mRoll = Util.rollDie(20);
      const mHit = mRoll === 20 || (mRoll !== 1 && mRoll + monster.atk >= ac);
      if (mHit) {
        const dmg = Math.max(1, Util.rollDice(monster.dmgDice, monster.dmgSides) + monster.dmgBonus);
        playerHp = Math.max(0, playerHp - dmg);
        log.push(monster.name + " hits you for " + dmg);
      } else {
        log.push(monster.name + " misses");
      }
    }

    const won = monsterHp <= 0 && playerHp > 0;
    character.hp = Math.max(1, playerHp); // never actually die — worst case, stagger away at 1 HP

    let xpGained = 0;
    let goldGained = 0;
    let leveledTo: number | null = null;

    if (won) {
      xpGained = monster.xp;
      goldGained = monster.goldMin + Math.floor(Math.random() * (monster.goldMax - monster.goldMin + 1));
      character.xp += xpGained;
      character.gold += goldGained;
      const newLevel = Rules.levelForXp(character.xp);
      if (newLevel > character.level) {
        character.level = newLevel;
        const oldMax = character.hpMax;
        character.hpMax = Rules.maxHpForLevel(character);
        character.hp = Util.clamp(character.hp + (character.hpMax - oldMax), 1, character.hpMax);
        leveledTo = newLevel;
      }
    } else {
      xpGained = 5 + character.level * 3;
      character.xp += xpGained;
    }

    return { monster, won, log, xpGained, goldGained, leveledTo, hpLeft: character.hp, hpMax: character.hpMax };
  },
};

// -----------------------------------------------------------------------
// MonsterLookup — used by !hunt <monster name> to target a specific
// monster instead of a random level-appropriate encounter.
// -----------------------------------------------------------------------
export const MonsterLookup = {
  find(needle: string): MonsterDef | undefined {
    const n = needle.trim().toLowerCase();
    return monsters.find((m) => m.name.toLowerCase() === n) ||
      monsters.find((m) => m.name.toLowerCase().indexOf(n) !== -1);
  },
};

// -----------------------------------------------------------------------
// ItemLookup — used by !item <name> to look up any item's full details
// by name (exact or partial), whether or not the caller owns it.
// -----------------------------------------------------------------------
export const ItemLookup = {
  find(needle: string): ItemDef | undefined {
    const n = needle.trim().toLowerCase();
    if (!n) return undefined;
    return items.find((i) => i.key.toLowerCase() === n) ||
      items.find((i) => i.name.toLowerCase() === n) ||
      items.find((i) => i.name.toLowerCase().indexOf(n) !== -1);
  },

  describe(itemDef: ItemDef): string {
    const bonus =
      itemDef.type === "weapon" ? "+" + (itemDef.atkBonus ?? 0) + " to hunt rolls" :
      itemDef.type === "armor" ? "+" + (itemDef.acBonus ?? 0) + " AC" :
      itemDef.type === "potion" && itemDef.heal ? "heals " + itemDef.heal[0] + "d" + itemDef.heal[1] + "+" + itemDef.heal[2] + " HP" :
      "no mechanical bonus, purely for flavor";
    return itemDef.name + " (" + itemDef.type + ") — " + bonus + " — " + itemDef.price + " gold — " + itemDef.desc;
  },
};

// -----------------------------------------------------------------------
// Inventory
// -----------------------------------------------------------------------
export const Inventory = {
  find(character: Character, needle: string): InventoryItem | undefined {
    const n = needle.trim().toLowerCase();
    return character.inventory.find((it) => it.key.toLowerCase() === n || it.name.toLowerCase().indexOf(n) !== -1);
  },
  add(character: Character, itemDef: ItemDef): void {
    const existing = character.inventory.find((it) => it.key === itemDef.key);
    if (existing) {
      existing.qty += 1;
    } else {
      character.inventory.push({ ...itemDef, qty: 1 });
    }
  },
  removeOne(character: Character, invItem: InventoryItem): void {
    invItem.qty -= 1;
    if (invItem.qty <= 0) {
      character.inventory = character.inventory.filter((it) => it !== invItem);
    }
  },
};

// -----------------------------------------------------------------------
// Merchant
// -----------------------------------------------------------------------
export const Merchant = {
  SLOT_COUNT: 3,
  AD_INTERVAL_MS: 8 * 60 * 1000, // 8 minutes
  AD_JITTER_MS: 4 * 60 * 1000, // up to +4 minutes extra

  rollOffer(): MerchantOffer {
    return { merchant: Util.pick(merchantNames), item: Util.pick(items), postedAt: Date.now() };
  },

  rollOffers(): MerchantOffer[] {
    const picked = Util.sampleUnique(items, Merchant.SLOT_COUNT);
    return picked.map((item) => ({ merchant: Util.pick(merchantNames), item, postedAt: Date.now() }));
  },

  pickAdOffer(currentOffers: MerchantOffer[] | null): MerchantOffer {
    if (currentOffers && currentOffers.length) return Util.pick(currentOffers);
    return Merchant.rollOffer();
  },

  formatAd(offer: MerchantOffer): string {
    return "🛒 " + offer.merchant + " is hawking " + offer.item.name + " (" + offer.item.desc + ") for " +
      offer.item.price + " gold! Say !merchant to see the full stall, or !buy to grab it.";
  },

  findOffer(offers: MerchantOffer[], needle: string): { offer: MerchantOffer; index: number } | null {
    const trimmed = needle.trim();
    const asNumber = parseInt(trimmed, 10);
    if (!isNaN(asNumber) && String(asNumber) === trimmed && asNumber >= 1 && asNumber <= offers.length) {
      return { offer: offers[asNumber - 1], index: asNumber - 1 };
    }
    const n = trimmed.toLowerCase();
    for (let i = 0; i < offers.length; i++) {
      if (offers[i].item.name.toLowerCase().indexOf(n) !== -1) return { offer: offers[i], index: i };
    }
    return null;
  },

  cheapestAffordable(offers: MerchantOffer[], gold: number): MerchantOffer | null {
    let best: MerchantOffer | null = null;
    offers.forEach((offer) => {
      if (offer.item.price <= gold && (!best || offer.item.price < best.item.price)) best = offer;
    });
    return best;
  },

  describeOffers(offers: MerchantOffer[]): string {
    return offers
      .map((offer, i) => "#" + (i + 1) + " " + offer.item.name + " (" + offer.item.desc + ") — " + offer.item.price + " gold [" + offer.merchant + "]")
      .join(" | ");
  },
};

// -----------------------------------------------------------------------
// Advisor — the "what should I do next" hint shared by nearly every command
// -----------------------------------------------------------------------
export const Advisor = {
  LOW_HP_FRACTION: 0.3,

  isLowHp(character: Character): boolean {
    return character.hp <= Math.max(1, Math.ceil(character.hpMax * Advisor.LOW_HP_FRACTION));
  },

  recommendNextAction(character: Character | null, offers: MerchantOffer[] | null): string {
    if (!character) return "Next: !enlist <name> (or !enlist random) to roll up a hero.";

    const potion = character.inventory.find((it) => it.type === "potion");

    if (character.hp <= 1) {
      return potion
        ? "Next: !use " + potion.name + " to patch yourself up, or !rest — you are barely standing."
        : "Next: !rest — you are barely standing.";
    }
    if (Advisor.isLowHp(character)) {
      return potion
        ? "Next: !use " + potion.name + " for a quick heal, or !rest to patch up before your next fight."
        : "Next: !rest to patch up before your next fight.";
    }

    const unequippedWeapon = character.inventory.find((it) =>
      it.type === "weapon" && (!character.equipped.weapon || (it.atkBonus ?? 0) > (character.equipped.weapon.atkBonus ?? 0)));
    if (unequippedWeapon) return "Next: !use " + unequippedWeapon.name + " — it beats what you have equipped.";

    const unequippedArmor = character.inventory.find((it) =>
      it.type === "armor" && (!character.equipped.armor || (it.acBonus ?? 0) > (character.equipped.armor.acBonus ?? 0)));
    if (unequippedArmor) return "Next: !use " + unequippedArmor.name + " — it beats what you have equipped.";

    const affordable = offers && Merchant.cheapestAffordable(offers, character.gold);
    if (affordable) {
      return "Next: !buy " + affordable.item.name + " — you can afford it (" + affordable.item.price + " gold) from " + affordable.merchant + ".";
    }
    return "Next: !hunt for more XP and gold, or !autohunt to chain fights automatically.";
  },
};

// -----------------------------------------------------------------------
// AutoHunt — timed autohunt sessions. A session fires one hunt roughly
// every HUNT_INTERVAL_MS, for up to durationMs, auto-resting instead of
// fighting whenever HP dips below the same "low HP" line Advisor already
// uses elsewhere. Sessions are persisted as a flat list (see
// storeClient.getAutohuntSessions/saveAutohuntSessions) rather than on
// the Character itself, so twitch.ts can discover all active sessions
// without a "list every character" API. Only one session per username
// at a time (enforced in commands.ts).
// -----------------------------------------------------------------------
export interface AutoHuntSession {
  username: string;
  channel: string;
  startedAt: number;
  endsAt: number;
  intervalMs: number;
  nextActionAt: number;
  hunts: number;
  wins: number;
  losses: number;
  totalXp: number;
  totalGold: number;
  levelsGained: number;
}

export const AutoHunt = {
  DEFAULT_DURATION_MS: 15 * 60 * 1000, // 15 minutes
  MIN_DURATION_MS: 5 * 60 * 1000,      // 5 minutes
  MAX_DURATION_MS: 2 * 60 * 60 * 1000, // 2 hours
  HUNT_INTERVAL_MS: 3 * 60 * 1000,     // a bout roughly every 3 minutes
  HEAL_RESTORE_FRACTION: 0.8,          // same target !rest uses

  // Parses "20m", "1h", "1h30m", or a bare number (minutes). Empty input
  // means "use the default". Returns null if the input can't be parsed
  // at all; otherwise clamps to [MIN_DURATION_MS, MAX_DURATION_MS].
  parseDuration(raw: string): number | null {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) return AutoHunt.DEFAULT_DURATION_MS;
    if (/^\d+$/.test(trimmed)) {
      return Util.clamp(parseInt(trimmed, 10) * 60 * 1000, AutoHunt.MIN_DURATION_MS, AutoHunt.MAX_DURATION_MS);
    }
    const match = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
    if (!match || (!match[1] && !match[2])) return null;
    const hours = parseInt(match[1] || "0", 10);
    const minutes = parseInt(match[2] || "0", 10);
    const ms = (hours * 60 + minutes) * 60 * 1000;
    if (ms <= 0) return null;
    return Util.clamp(ms, AutoHunt.MIN_DURATION_MS, AutoHunt.MAX_DURATION_MS);
  },

  formatDuration(ms: number): string {
    const totalMinutes = Math.max(1, Math.round(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours && minutes) return hours + "h" + minutes + "m";
    if (hours) return hours + "h";
    return minutes + "m";
  },

  start(character: Character, channel: string, durationMs: number): AutoHuntSession {
    const now = Date.now();
    return {
      username: character.username,
      channel,
      startedAt: now,
      endsAt: now + durationMs,
      intervalMs: AutoHunt.HUNT_INTERVAL_MS,
      nextActionAt: now, // fire the first bout right away
      hunts: 0, wins: 0, losses: 0, totalXp: 0, totalGold: 0, levelsGained: 0,
    };
  },

  isDue(session: AutoHuntSession): boolean {
    return Date.now() >= session.nextActionAt;
  },

  isExpired(session: AutoHuntSession): boolean {
    return Date.now() >= session.endsAt;
  },

  // One tick against a freshly-loaded character. Mutates both the
  // character and the session — caller saves both afterward. If HP is
  // low, this rests instead of fighting (and reports monsterWon: null,
  // so the caller knows not to touch quest progress this tick).
  tick(character: Character, session: AutoHuntSession): { message: string; leveledTo: number | null; monsterWon: string | null } {
    if (Advisor.isLowHp(character)) {
      const target = Math.min(character.hpMax, Math.ceil(character.hpMax * AutoHunt.HEAL_RESTORE_FRACTION));
      if (character.hp < target) {
        character.hp = target;
        session.nextActionAt = Date.now() + session.intervalMs;
        return {
          message: character.name + " breaks off to patch up, resting to " + character.hp + "/" + character.hpMax + " HP.",
          leveledTo: null, monsterWon: null,
        };
      }
    }
    const result = Combat.huntMonster(character);
    session.hunts++;
    session.totalXp += result.xpGained;
    session.totalGold += result.goldGained;
    if (result.won) session.wins++; else session.losses++;
    if (result.leveledTo) session.levelsGained++;
    session.nextActionAt = Date.now() + session.intervalMs;
    const highlight = result.log.slice(-3).join(", ");
    const outcome = result.won
      ? "felled a " + result.monster.name + " (" + highlight + ") — +" + result.xpGained + " XP, +" + result.goldGained + " gold."
      : "was bested by a " + result.monster.name + " (" + highlight + ") but logged +" + result.xpGained + " XP for the effort.";
    return {
      message: character.name + " " + outcome + " HP " + character.hp + "/" + character.hpMax + ".",
      leveledTo: result.leveledTo, monsterWon: result.won ? result.monster.name : null,
    };
  },

  summary(character: Character, session: AutoHuntSession, stopReason: string): string {
    const levelMsg = session.levelsGained
      ? " 🎉 leveled up " + session.levelsGained + " time" + (session.levelsGained === 1 ? "" : "s") + "!"
      : "";
    return character.name + " wraps the autohunt after " + AutoHunt.formatDuration(Date.now() - session.startedAt) + " (" +
      stopReason + "): " + session.hunts + " bout" + (session.hunts === 1 ? "" : "s") + " (" + session.wins + "W/" +
      session.losses + "L), +" + session.totalXp + " XP, +" + session.totalGold + " gold. HP " + character.hp + "/" +
      character.hpMax + "." + levelMsg;
  },
};

// -----------------------------------------------------------------------
// ItemLore — picks a random item currently on the merchant's stall and
// spins a short ambient story about it, for the periodic "item lore" chat
// event.
// -----------------------------------------------------------------------
export const ItemLore = {
  pickOffer(offers: MerchantOffer[]): MerchantOffer | null {
    if (!offers.length) return null;
    return Util.pick(offers);
  },

  story(offer: MerchantOffer): string {
    const templates = itemStoryTemplates[offer.item.type] || itemStoryTemplates["trinket"];
    const template = Util.pick(templates);
    return template
      .split("{owner}").join(offer.merchant)
      .split("{item}").join(offer.item.name)
      .split("{desc}").join(offer.item.desc);
  },
};

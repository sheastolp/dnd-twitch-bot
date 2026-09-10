// Baldur's Gate 3 flavored random character roll — !bg3roll
//
// Standalone generator: no DB, no external lookups. Produces a BG3-style
// race/subrace, class/subclass, background, alignment, a 27-point BG3-style
// point buy (base 8, cap 15, weighted toward the class's primary ability),
// and a one-line flavor hook, formatted as a single chat message.

import type { Ability, Character } from "./types.ts";
import { pick, modifier, formatRaceName, formatStatLine } from "./utils.ts";
import { classes } from "./data.ts";
import { getCreationSession, saveCreationSession, clearCreationSession, saveCharacter, getCharacter } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";

interface Bg3RaceEntry {
  name: string;
  subraces?: string[];
}

const BG3_RACES: Bg3RaceEntry[] = [
  { name: "Human" },
  { name: "Githyanki" },
  { name: "Half-Orc" },
  { name: "Elf", subraces: ["High Elf", "Wood Elf"] },
  { name: "Drow", subraces: ["Lolth-Sworn", "Seldarine"] },
  { name: "Half-Elf", subraces: ["High Half-Elf", "Wood Half-Elf", "Drow Half-Elf"] },
  { name: "Dwarf", subraces: ["Gold Dwarf", "Shield Dwarf"] },
  { name: "Halfling", subraces: ["Lightfoot", "Strongheart"] },
  { name: "Gnome", subraces: ["Forest Gnome", "Rock Gnome", "Deep Gnome"] },
  { name: "Tiefling", subraces: ["Asmodeus", "Mephistopheles", "Zariel"] },
  { name: "Dragonborn" },
];

interface Bg3ClassEntry {
  name: string;
  primaryAbility: Ability;
  subclasses: string[];
}

const BG3_CLASSES: Bg3ClassEntry[] = [
  { name: "Barbarian", primaryAbility: "STR", subclasses: ["Berserker", "Wildheart", "Wild Magic"] },
  { name: "Bard", primaryAbility: "CHA", subclasses: ["College of Lore", "College of Valour", "College of Swords"] },
  { name: "Cleric", primaryAbility: "WIS", subclasses: ["Life Domain", "Light Domain", "Trickery Domain", "War Domain"] },
  { name: "Druid", primaryAbility: "WIS", subclasses: ["Circle of the Land", "Circle of the Moon", "Circle of the Spores"] },
  { name: "Fighter", primaryAbility: "STR", subclasses: ["Champion", "Battle Master", "Eldritch Knight"] },
  { name: "Monk", primaryAbility: "DEX", subclasses: ["Way of the Open Hand", "Way of Shadow", "Way of the Four Elements"] },
  { name: "Paladin", primaryAbility: "STR", subclasses: ["Oath of Devotion", "Oath of the Ancients", "Oath of Vengeance"] },
  { name: "Ranger", primaryAbility: "DEX", subclasses: ["Hunter", "Beast Master", "Gloom Stalker"] },
  { name: "Rogue", primaryAbility: "DEX", subclasses: ["Thief", "Assassin", "Arcane Trickster"] },
  { name: "Sorcerer", primaryAbility: "CHA", subclasses: ["Draconic Bloodline", "Wild Magic", "Storm Sorcery"] },
  { name: "Warlock", primaryAbility: "CHA", subclasses: ["The Fiend", "The Great Old One", "The Archfey"] },
  {
    name: "Wizard",
    primaryAbility: "INT",
    subclasses: ["Abjuration", "Conjuration", "Divination", "Enchantment", "Evocation", "Illusion", "Necromancy", "Transmutation"],
  },
];

const BG3_BACKGROUNDS = [
  "Acolyte", "Charlatan", "Criminal", "Entertainer", "Folk Hero",
  "Guild Artisan", "Noble", "Outlander", "Sage", "Soldier", "Urchin",
  "Sailor", "Pirate", "Hermit", "Knight", "Spy",
  "Gladiator", "Investigator", "Mercenary Veteran", "Far Traveler",
];

const BG3_ALIGNMENTS = [
  "Lawful Good", "Neutral Good", "Chaotic Good",
  "Lawful Neutral", "True Neutral", "Chaotic Neutral",
  "Lawful Evil", "Neutral Evil", "Chaotic Evil",
];

const BG3_FLAVOR_HOOKS = [
  "Woke up on the Nautiloid with no memory of how they got there.",
  "Fled their homeland one step ahead of a bounty they never explained.",
  "Answered a job posting nailed to a tavern door in Baldur's Gate.",
  "Was cast out by their circle for reasons they still won't discuss.",
  "Owes a debt to someone in the Absolute's camp — and hasn't paid it.",
  "Followed a dream that led straight into a mind flayer ship.",
  "Was traveling to Baldur's Gate for entirely unrelated reasons.",
  "Lost a bet that ended with them on the wrong ship at the wrong time.",
  "Is hunting something — or someone — that slipped into the Sword Coast.",
  "Has a tadpole in their skull and increasingly fewer qualms about using it.",
  "Signed a mercenary contract that turned out to have very fine print.",
  "Was smuggled aboard as 'cargo' by a Guild agent with poor judgment.",
  "Followed rumors of a cure for something they'd rather not name.",
  "Got separated from their caravan during a Nautiloid raid.",
  "Was promised safe passage to Baldur's Gate — technically, this is that.",
  "Chased a bounty straight into the wrong ship's cargo hold.",
  "Woke up mid-abduction and decided to make the best of it.",
  "Was in the wrong tavern at the wrong time, as usual.",
  "Made a deal with something in the dark that's coming due sooner than expected.",
  "Just wanted to see the Sword Coast. This was not the plan.",
];

const ABILITIES: Ability[] = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];

// Standard 5e/BG3 point-buy cost table: base score 8, cap 15, budget 27.
const POINT_BUY_COST: Record<number, number> = {
  8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9,
};

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Spends the 27-point budget across six abilities, biased toward the
// class's primary ability (and a little toward CON) so the result reads
// like a build a player might actually pick rather than pure noise.
function rollPointBuyScores(primary: Ability): Record<Ability, number> {
  const scores = { STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 } as Record<Ability, number>;
  let budget = 27;

  const pool: Ability[] = [];
  for (const a of ABILITIES) {
    const weight = a === primary ? 4 : a === "CON" ? 2 : 1;
    for (let i = 0; i < weight; i++) pool.push(a);
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  let idx = 0;
  let stall = 0;
  while (budget > 0 && stall < 200) {
    const ability = pool[idx % pool.length];
    idx++;
    const next = scores[ability] + 1;
    if (next > 15) {
      stall++;
      continue;
    }
    const cost = POINT_BUY_COST[next] - POINT_BUY_COST[scores[ability]];
    if (cost <= budget) {
      scores[ability] = next;
      budget -= cost;
      stall = 0;
    } else {
      stall++;
    }
  }
  return scores;
}

/** Rolls a full BG3-flavored character and formats it as one chat message. */
export function rollBG3Character(display: string): string {
  const raceEntry = pick(BG3_RACES);
  const race = raceEntry.subraces ? `${pick(raceEntry.subraces)} ${raceEntry.name}` : raceEntry.name;

  const classEntry = pick(BG3_CLASSES);
  const subclass = pick(classEntry.subclasses);
  const background = pick(BG3_BACKGROUNDS);
  const alignment = pick(BG3_ALIGNMENTS);
  const hook = pick(BG3_FLAVOR_HOOKS);
  const scores = rollPointBuyScores(classEntry.primaryAbility);

  const statLine = ABILITIES.map((a) => {
    const mod = modifier(scores[a]);
    return `${a} ${scores[a]}(${mod >= 0 ? "+" : ""}${mod})`;
  }).join(" ");

  return (
    `@${display} 🎲 ${race} ${classEntry.name} (${subclass}) | ${background}, ${alignment} | ` +
    `${statLine} | ${hook}`
  );
}

// ---------------------------------------------------------------------------
// !bg3companion — "which BG3 companion are you?"
// ---------------------------------------------------------------------------

interface Bg3CompanionEntry {
  name: string;
  role: string;
  blurb: string;
  line: string;
}

const BG3_COMPANIONS: Bg3CompanionEntry[] = [
  { name: "Astarion", role: "Rogue // Vampire Spawn", blurb: "Two centuries of servitude, and he's making up for lost time.", line: "\"Ah, ah, ah — mind the fangs.\"" },
  { name: "Shadowheart", role: "Cleric of Shar", blurb: "Carries a relic she isn't allowed to look at, and a past she isn't ready to remember.", line: "\"I don't do 'chat.'\"" },
  { name: "Gale", role: "Wizard // Chosen of Mystra", blurb: "A brilliant mind with a magical bomb where his heart used to be.", line: "\"I once fell in love with a goddess. It went about as well as you'd expect.\"" },
  { name: "Wyll", role: "Warlock // Blade of the Frontiers", blurb: "A hero of Baldur's Gate with a devil-shaped debt still coming due.", line: "\"Monsters don't frighten me. Not anymore.\"" },
  { name: "Karlach", role: "Barbarian // Escaped from Avernus", blurb: "Ten years in Hell, and she still hugs like she means it.", line: "\"Got a soul furnace where my heart should be. Long story.\"" },
  { name: "Lae'zel", role: "Fighter // Githyanki Warrior", blurb: "Trained for war since birth, and deeply unimpressed by everyone she's met since.", line: "\"Weak creatures. All of you.\"" },
  { name: "Jaheira", role: "Druid // Harper", blurb: "Decades in the field, and no patience left for nonsense.", line: "\"I've buried better plans than this one.\"" },
  { name: "Minsc", role: "Ranger // Berserker", blurb: "Travels with a hamster named Boo, who is — in fact — a miniature giant space hamster.", line: "\"Evil, prepare to catch a boot with your face!\"" },
  { name: "Halsin", role: "Druid // Archdruid", blurb: "Spent a whole season as a bear rather than deal with people. Understandable, really.", line: "\"The wild has a way of putting things in perspective.\"" },
];

/** Rolls which BG3 companion you'd travel with, formatted as one chat message. */
export function rollBG3Companion(display: string): string {
  const c = pick(BG3_COMPANIONS);
  return `@${display} 🤝 You're rolling with ${c.name} (${c.role}) — ${c.blurb} ${c.line}`;
}

// ---------------------------------------------------------------------------
// !bg3origin — random canonical Origin Character for this run
// ---------------------------------------------------------------------------

interface Bg3OriginEntry {
  name: string;
  cls: string;
  hook: string;
}

const BG3_ORIGINS: Bg3OriginEntry[] = [
  { name: "Astarion", cls: "Rogue", hook: "a 200-year-old vampire spawn hiding two centuries of servitude under a lot of charm." },
  { name: "Shadowheart", cls: "Cleric", hook: "a Sharran agent carrying a relic she's forbidden to examine — and can't remember why that rule exists." },
  { name: "Gale", cls: "Wizard", hook: "a former Chosen of Mystra with a slowly detonating magical orb where his heart used to be." },
  { name: "Wyll", cls: "Warlock", hook: "Baldur's Gate's celebrated 'Blade of the Frontiers,' bound to a devil's contract he's desperate to escape." },
  { name: "Karlach", cls: "Barbarian", hook: "a tiefling who clawed her way out of a decade in Avernus and just wants a quiet life now." },
  { name: "Lae'zel", cls: "Fighter", hook: "a githyanki soldier stranded far from her creche, desperate to prove her loyalty and find a way home." },
  { name: "The Dark Urge", cls: "Custom Origin", hook: "an amnesiac with a violent past — and an even more violent voice in their head." },
];

/** Rolls a canonical Origin Character to play as this run, formatted as one chat message. */
export function rollBG3Origin(display: string): string {
  const o = pick(BG3_ORIGINS);
  return `@${display} 🎬 This run, you're playing... ${o.name} (${o.cls}) — ${o.hook}`;
}

// ---------------------------------------------------------------------------
// !bg3loot — random magic item drop, BG3-style rarity tiers
// ---------------------------------------------------------------------------

type Bg3Rarity = "Common" | "Uncommon" | "Rare" | "Very Rare" | "Legendary";

const BG3_RARITY_STARS: Record<Bg3Rarity, string> = {
  Common: "☆",
  Uncommon: "★☆☆☆",
  Rare: "★★☆☆",
  "Very Rare": "★★★☆",
  Legendary: "★★★★",
};

const BG3_RARITY_FLAVOR: Record<Bg3Rarity, string> = {
  Common: "Not glamorous, but it'll do.",
  Uncommon: "A solid find — worth the trip back to camp.",
  Rare: "Now that's a proper upgrade.",
  "Very Rare": "The kind of find bards write songs about.",
  Legendary: "Withers is going to want a word about this one.",
};

const BG3_LOOT_TABLE: Record<Bg3Rarity, string[]> = {
  Common: [
    "Traveler's Boots", "Potion of Healing", "Slightly Enchanted Dagger", "Torch of Unusual Reliability", "Bag of Almost-Fresh Rations",
    "Well-Worn Adventurer's Pack", "Chipped Shortsword", "Flask of Cheap Wine", "Patched Leather Vest", "Basic Alchemist's Fire",
    "Sturdy Walking Stick", "Bundle of Torches", "Simple Sling", "Waterskin of Questionable Origin", "Traveler's Rations (Slightly Stale)",
    "Plain Iron Dagger", "Faded Adventurer's Cloak", "Basic Camping Supplies", "Scroll of Minor Illusion", "Well-Used Grappling Hook",
  ],
  Uncommon: [
    "Boots of Striding", "Potion of Speed", "Ring of Protection", "Frayed Cloak of Displacement", "Callous Glow Ring",
    "Cloak of Protection", "Gloves of Missile Snaring", "Boots of the Fallen Angel", "Amulet of Misty Step", "Ring of Elemental Infusion",
    "Wand of Lesser Restoration", "Shield of Devotion", "Bracers of Defense", "Circlet of Blasting", "Necklace of Elemental Augmentation",
    "Boots of Aid and Comfort", "Gloves of Uninhibited Kushigo", "Ring of Minor Free Action", "Sparkle Hands Gloves", "Featherlight Boots",
  ],
  Rare: [
    "Adamantine Longsword", "Gloves of Dexterity", "Broodmother's Revenge", "Boots of Genial Striding", "Ring of Regeneration",
    "Sword of Justice", "Shield of the Vigilant Guardian", "Boots of Speed", "Gauntlets of Ogre Power", "Helm of Balduran",
    "Whispering Promise (Bow)", "Battle Axe of the Betrayer", "Blooded Gloves", "Robe of the Weave", "Ring of Absolute Force",
    "Sentinel Shield", "Cloak of the Weave", "Patched Yuan-ti Scale Mail", "Restrung Titanstring Bow", "Warped Headband of Intellect",
  ],
  "Very Rare": [
    "Fragment of Markoheshkir", "Titanstring Bow", "Helldusk Gloves", "Spellsparkler", "Yuan-ti Scale Mail",
    "Empowered Callous Glow Ring", "Adamantine Shield", "Ring of Elemental Fire", "Spear of Night", "Danger Boots",
    "Watcher's Robe", "Ring of Shocking Grasp", "Amulet of Branding", "Hellfire Halberd", "Reaper's Embrace",
    "Boots of Recovery", "Blood of the Dawn", "Tome of Forbidden Necromancy", "Duergar Waraxe", "Whip of Devotion",
  ],
  Legendary: [
    "The Duellist's Prerogative", "Bhaalist Armour", "Balduran's Giantslayer", "Unbroken Amulet of the Devout", "Sword of Chaos",
    "Duke's Ceremonial Blade", "The Absolute's Fang", "Crown of Karsus (Fragment)", "Netherstone Shard", "Bhaal's Cleaver",
    "Orphic Hammer", "Illithid Tadpole Circlet", "Balduran's Lost Trident", "Astral Prism (Replica)", "Mystra's Broken Staff",
    "The Emperor's Crown", "Ansur's Scale", "Gith Silver Sword", "Netherese Warhammer", "The Nine Hells' Key",
  ],
};

// Weighted so legendary drops stay rare: Common 40% / Uncommon 30% / Rare 18% / Very Rare 9% / Legendary 3%.
function rollBG3Rarity(): Bg3Rarity {
  const roll = Math.random() * 100;
  if (roll < 40) return "Common";
  if (roll < 70) return "Uncommon";
  if (roll < 88) return "Rare";
  if (roll < 97) return "Very Rare";
  return "Legendary";
}

/** Rolls a random loot drop with a BG3-style rarity tier, formatted as one chat message. */
export function rollBG3Loot(display: string): string {
  const rarity = rollBG3Rarity();
  const item = pick(BG3_LOOT_TABLE[rarity]);
  return `@${display} 🎁 Loot roll: [${rarity} ${BG3_RARITY_STARS[rarity]}] ${item} — ${BG3_RARITY_FLAVOR[rarity]}`;
}

// ---------------------------------------------------------------------------
// !bg3camp — random camp-night vignette
// ---------------------------------------------------------------------------

const BG3_CAMP_SCENES: Array<(companion: string) => string> = [
  (c) => `The fire crackles low. ${c} sits across from you, uncharacteristically quiet — like there's something on the tip of their tongue.`,
  (c) => `${c} challenges you to a drinking contest with Gale's suspiciously glowing wine. This will not end well for someone.`,
  (c) => `Scratch bounds over with a stick. ${c} watches, and for a second, looks almost at peace.`,
  (c) => `You catch ${c} muttering to themselves near the treeline. They stop the moment they notice you're there.`,
  (c) => `${c} pulls you aside after the watch rotation. "Can we talk? Somewhere... private."`,
  (c) => `Withers appears out of nowhere, says nothing, and vanishes again. ${c} doesn't even flinch anymore.`,
  (c) => `${c} is sharpening a blade that definitely doesn't need it. Something's bothering them.`,
  (c) => `The tadpole in your skull pulses. Across the fire, ${c} rubs their temple like they felt it too.`,
  (c) => `${c} offers to take first watch, then spends the whole night staring at the horizon instead of the treeline.`,
  (c) => `You wake to find your camp has been rearranged, again, and ${c} is whistling innocently nearby.`,
  (c) => `${c} is teaching Scratch a new trick. It is not going well, and everyone is delighted.`,
  (c) => `You find ${c} staring into the fire, lost in thought. They don't notice you sit down beside them.`,
  (c) => `${c} insists on cooking tonight. The results are... an experience.`,
  (c) => `A quiet argument breaks out near the supply crates. ${c} storms off to cool down.`,
  (c) => `${c} hums an old tune under their breath, unaware anyone's listening.`,
  (c) => `The camp is oddly peaceful tonight. ${c} even cracks a rare smile.`,
  (c) => `${c} asks if you trust them. The question hangs heavier than expected.`,
  (c) => `You find ${c} polishing gear that's already spotless. Nervous energy, maybe.`,
  (c) => `${c} tells a story from before the Nautiloid. It's more honest than usual.`,
  (c) => `Rain starts to fall. ${c} pulls their cloak tight and keeps watching the treeline anyway.`,
];

/** Rolls a random camp-night vignette featuring one of the companions. */
export function rollBG3Camp(display: string): string {
  const companion = pick(BG3_COMPANIONS).name;
  const scene = pick(BG3_CAMP_SCENES)(companion);
  return `@${display} 🔥 Camp, nightfall: ${scene}`;
}

// ---------------------------------------------------------------------------
// Interactive !bg3 creation: random race/class, player-chosen point buy
// ---------------------------------------------------------------------------
//
// Unlike !bg3roll/!bg3companion/!bg3origin/!bg3loot/!bg3camp (fully random,
// throwaway flavor rolls that print to chat and touch no saved data), !bg3
// randomizes only race and class, then hands ability-score allocation to the
// player under real BG3 point-buy rules (base 8, cap 15, 27-point budget),
// and saves the result as a normal Character — usable with !char, !roll,
// !hp, duels, etc. Session state is the same creation_sessions row used by
// !newchar, distinguished by a "bg3_" step prefix.

// Ability bonuses, speed, and traits for each BG3 base race. Kept separate
// from data.ts's SRD race table since BG3's roster (Githyanki, Drow as its
// own race, etc.) doesn't line up 1:1 with the SRD one. Character.race/
// subrace are plain strings with no lookup elsewhere in the bot once saved,
// so these flavor names are safe to persist directly.
interface Bg3RaceStats {
  bonuses: Partial<Record<Ability, number>>;
  speed: number;
  traits: string[];
}

const BG3_RACE_DATA: Record<string, Bg3RaceStats> = {
  Human: { bonuses: {}, speed: 30, traits: ["Versatile", "Civilized"] },
  Githyanki: { bonuses: { STR: 2, INT: 1 }, speed: 30, traits: ["Astral Knowledge", "Martial Prodigy", "Githyanki Psionics"] },
  "Half-Orc": { bonuses: { STR: 2, CON: 1 }, speed: 30, traits: ["Darkvision", "Relentless Endurance", "Savage Attacks"] },
  Elf: { bonuses: { DEX: 2 }, speed: 30, traits: ["Darkvision", "Fey Ancestry", "Trance"] },
  Drow: { bonuses: { DEX: 2, CHA: 1 }, speed: 30, traits: ["Superior Darkvision", "Drow Magic", "Sunlight Sensitivity"] },
  "Half-Elf": { bonuses: { CHA: 2 }, speed: 30, traits: ["Darkvision", "Fey Ancestry", "Skill Versatility"] },
  Dwarf: { bonuses: { CON: 2 }, speed: 30, traits: ["Darkvision", "Dwarven Resilience"] },
  Halfling: { bonuses: { DEX: 2 }, speed: 30, traits: ["Lucky", "Brave"] },
  Gnome: { bonuses: { INT: 2 }, speed: 30, traits: ["Darkvision", "Gnome Cunning"] },
  Tiefling: { bonuses: { CHA: 2, INT: 1 }, speed: 30, traits: ["Darkvision", "Hellish Resistance", "Infernal Legacy"] },
  Dragonborn: { bonuses: { STR: 2, CHA: 1 }, speed: 30, traits: ["Draconic Ancestry", "Breath Weapon", "Damage Resistance"] },
};

const BG3_SUBRACE_BONUSES: Record<string, Partial<Record<Ability, number>>> = {
  "High Elf": { INT: 1 },
  "Wood Elf": { WIS: 1 },
  "Lolth-Sworn": { CHA: 1 },
  Seldarine: { WIS: 1 },
  "High Half-Elf": { INT: 1 },
  "Wood Half-Elf": { WIS: 1 },
  "Drow Half-Elf": { CHA: 1 },
  "Gold Dwarf": { WIS: 1 },
  "Shield Dwarf": { STR: 1 },
  Lightfoot: { CHA: 1 },
  Strongheart: { CON: 1 },
  "Forest Gnome": { DEX: 1 },
  "Rock Gnome": { CON: 1 },
  "Deep Gnome": { DEX: 1 },
};

interface Bg3Loadout {
  race: string;
  subrace: string | null;
  cls: string;
  subclass: string;
  background: string;
  alignment: string;
  hook: string;
}

function rollBg3Loadout(): Bg3Loadout {
  const raceEntry = pick(BG3_RACES);
  const subrace = raceEntry.subraces ? pick(raceEntry.subraces) : null;
  const classEntry = pick(BG3_CLASSES);
  return {
    race: raceEntry.name,
    subrace,
    cls: classEntry.name,
    subclass: pick(classEntry.subclasses),
    background: pick(BG3_BACKGROUNDS),
    alignment: pick(BG3_ALIGNMENTS),
    hook: pick(BG3_FLAVOR_HOOKS),
  };
}

function bg3PointBuyPrompt(): string {
  return (
    "assign your BG3 point-buy scores — base 8, cap 15, 27-point budget (costs: 9=1 10=2 11=3 12=4 13=5 14=7 15=9) " +
    "— in order STR DEX CON INT WIS CHA. Reply !answer <STR> <DEX> <CON> <INT> <WIS> <CHA>, e.g. !answer 15 15 15 8 8 8. " +
    "Type !cancel to stop."
  );
}

/** Validates a raw "!answer ..." reply against BG3 point-buy rules. */
function parseBg3Scores(answer: string): Record<Ability, number> | { error: string } {
  const nums = answer.trim().split(/[ ,]+/).map(Number);
  if (nums.length !== 6 || nums.some((n) => !Number.isInteger(n))) {
    return { error: "Enter exactly 6 whole numbers in order STR DEX CON INT WIS CHA, e.g. !answer 15 15 15 8 8 8." };
  }
  if (nums.some((n) => n < 8 || n > 15)) {
    return { error: "Each score must be between 8 and 15 under BG3 point-buy rules." };
  }
  const cost = nums.reduce((sum, n) => sum + POINT_BUY_COST[n], 0);
  if (cost > 27) {
    return { error: `That spends ${cost} of your 27-point budget. Lower some scores and try again.` };
  }
  const scores = {} as Record<Ability, number>;
  ABILITIES.forEach((a, i) => (scores[a] = nums[i]));
  return scores;
}

function buildBg3Character(username: string, s: any): Character {
  const raceStats = BG3_RACE_DATA[s.race] ?? { bonuses: {}, speed: 30, traits: [] };
  const subraceBonus: Partial<Record<Ability, number>> = s.subrace ? BG3_SUBRACE_BONUSES[s.subrace] ?? {} : {};
  const bonuses = { ...raceStats.bonuses, ...subraceBonus };
  const base = s.scores as Record<Ability, number>;
  const scores = {} as Record<Ability, number>;
  for (const a of ABILITIES) scores[a] = Math.min(20, base[a] + (bonuses[a] ?? 0));

  // Class names match the SRD classes table 1:1, so hit die / saving throws
  // are reused from data.ts rather than duplicated here.
  const classData = classes[s.cls];
  const hpMax = Math.max(1, classData.hitDie + modifier(scores.CON));

  const traits = [...raceStats.traits, s.subclass, `Background: ${s.background}`, `Alignment: ${s.alignment}`, s.hook];

  return {
    username,
    race: s.race,
    subrace: s.subrace ?? null,
    cls: s.cls,
    level: 1,
    xp: 0,
    scores,
    speed: raceStats.speed,
    hpMax,
    hpCurrent: hpMax,
    proficiency: 2,
    traits,
    spells: [],
    items: [],
    feats: [],
    abilities: [],
  };
}

export async function handleBg3Command(
  username: string,
  display: string,
  broadcasterId: string,
  chatMessage: string,
  baseUrl: string,
): Promise<boolean> {
  if (chatMessage === "!bg3") {
    const loadout = rollBg3Loadout();
    await saveCreationSession(
      {
        username,
        step: "bg3_scores",
        race: loadout.race,
        subrace: loadout.subrace,
        cls: loadout.cls,
        subclass: loadout.subclass,
        background: loadout.background,
        alignment: loadout.alignment,
        hook: loadout.hook,
        scores: null,
      },
      broadcasterId,
    );
    await sendChatMessage(
      `@${display} 🎲 Rolled ${formatRaceName(loadout.race, loadout.subrace)} ${loadout.cls} (${loadout.subclass}), ` +
        `${loadout.background} · ${loadout.alignment}. Now ${bg3PointBuyPrompt()}`,
      broadcasterId,
    );
    return true;
  }

  if (!chatMessage.startsWith("!answer ")) return false;
  const s = await getCreationSession(username, broadcasterId);
  if (!s || !String(s.step).startsWith("bg3_")) return false;
  const answer = chatMessage.slice(8).trim();

  if (s.step === "bg3_scores") {
    const result = parseBg3Scores(answer);
    if ("error" in result) {
      await sendChatMessage(`@${display} ${result.error}`, broadcasterId);
      return true;
    }
    s.scores = result;
    s.step = "bg3_confirm";
    await saveCreationSession(s, broadcasterId);
    const preview = buildBg3Character(username, s);
    const existing = await getCharacter(username, broadcasterId);
    const warning = existing
      ? `⚠️ This will overwrite your active ${formatRaceName(existing.race, existing.subrace)} ${existing.cls} (Level ${existing.level}). `
      : "";
    const yesAction = existing ? "overwrite and save" : "save";
    await sendChatMessage(
      `@${display} ${warning}Confirm: level 1 ${formatRaceName(preview.race, preview.subrace)} ${preview.cls} (${s.subclass}), ` +
        `${s.background}, ${s.alignment} | ${formatStatLine(preview)}. Reply !answer yes to ${yesAction} or !answer no to restart.`,
      broadcasterId,
    );
    return true;
  }

  if (s.step === "bg3_confirm") {
    if (answer.toLowerCase() === "yes") {
      const c = buildBg3Character(username, s);
      await saveCharacter(c, broadcasterId);
      await clearCreationSession(username, broadcasterId);
      await sendChatMessage(
        `@${display} Character saved! ${formatRaceName(c.race, c.subrace)} ${c.cls} — ${formatStatLine(c)} — ${baseUrl}/?user=${username}`,
        broadcasterId,
      );
    } else if (answer.toLowerCase() === "no") {
      await clearCreationSession(username, broadcasterId);
      await sendChatMessage(`@${display} Character discarded. Start again with !bg3.`, broadcasterId);
    } else {
      await sendChatMessage(`@${display} Reply !answer yes to save or !answer no to discard.`, broadcasterId);
    }
    return true;
  }

  return false;
}

// Baldur's Gate 3 knowledgebase — static lore/reference data for !bg3lookup.
//
// This is flavor content (companions, origins, classes, races, locations,
// factions, deities, notable villains, and legendary items), not the D&D 5e
// SRD data in data.ts/lookups.ts. There's no public BG3 API to query, so
// entries are hand-curated and short enough to read well in Twitch chat.

export type Bg3Category =
  | "companion"
  | "origin"
  | "class"
  | "race"
  | "location"
  | "faction"
  | "deity"
  | "villain"
  | "item";

export interface Bg3Entry {
  name: string;
  category: Bg3Category;
  /** Extra search terms that should resolve to this entry. */
  aliases?: string[];
  summary: string;
}

export const BG3_CATEGORY_LABELS: Record<Bg3Category, string> = {
  companion: "Companion",
  origin: "Origin Character",
  class: "Class",
  race: "Race",
  location: "Location",
  faction: "Faction",
  deity: "Deity",
  villain: "Notable Villain",
  item: "Legendary Item",
};

/** Chat-friendly aliases/plurals that map to a canonical category key. */
export const BG3_CATEGORY_ALIASES: Record<string, Bg3Category> = {
  companion: "companion",
  companions: "companion",
  npc: "companion",
  origin: "origin",
  origins: "origin",
  class: "class",
  classes: "class",
  subclass: "class",
  race: "race",
  races: "race",
  subrace: "race",
  location: "location",
  locations: "location",
  place: "location",
  area: "location",
  faction: "faction",
  factions: "faction",
  group: "faction",
  deity: "deity",
  deities: "deity",
  god: "deity",
  goddess: "deity",
  villain: "villain",
  villains: "villain",
  boss: "villain",
  enemy: "villain",
  item: "item",
  items: "item",
  weapon: "item",
  loot: "item",
  legendary: "item",
};

export const BG3_KNOWLEDGEBASE: Bg3Entry[] = [
  // ── Companions (also playable Origin Characters unless noted) ──
  {
    name: "Astarion",
    category: "companion",
    aliases: ["astarion ancunin"],
    summary:
      "Rogue // Vampire Spawn, playable Origin Character. A 200-year-old vampire spawn who spent two centuries as a thrall to his sadistic vampire master, Cazador — and is done being anyone's meal.",
  },
  {
    name: "Shadowheart",
    category: "companion",
    aliases: ["shart"],
    summary:
      "Cleric of Shar, playable Origin Character. A secretive Sharran agent escorting a mysterious relic she's forbidden to examine, with memories the Shadow-Cursed Lands took from her.",
  },
  {
    name: "Gale",
    category: "companion",
    aliases: ["gale of waterdeep"],
    summary:
      "Wizard, playable Origin Character. A former Chosen of Mystra carrying a slowly detonating orb of annihilated Weave where his heart used to be — and a very high opinion of his own cooking.",
  },
  {
    name: "Wyll",
    category: "companion",
    aliases: ["the blade of the frontiers"],
    summary:
      "Warlock // Blade of the Frontiers, playable Origin Character. A celebrated Baldur's Gate monster-hunter bound by a pact to the devil Mizora, who's owed a debt he's desperate to escape.",
  },
  {
    name: "Karlach",
    category: "companion",
    aliases: ["karlach cliffgate"],
    summary:
      "Barbarian, playable Origin Character. A tiefling who spent a decade as a soldier in Zariel's army in Avernus with an infernal engine for a heart, and just wants a quiet life topside.",
  },
  {
    name: "Lae'zel",
    category: "companion",
    aliases: ["laezel", "lae zel"],
    summary:
      "Fighter, playable Origin Character. A githyanki warrior of Vlaakith's Creche K'liir, trained for war since birth and stranded far from her people after the nautiloid crash.",
  },
  {
    name: "Jaheira",
    category: "companion",
    summary:
      "Druid // Harper. A veteran Harper agent (returning from the Baldur's Gate series) investigating the cult from Last Light Inn, with decades of field experience and zero patience for nonsense.",
  },
  {
    name: "Minsc",
    category: "companion",
    aliases: ["minsc and boo", "boo"],
    summary:
      "Ranger // Berserker. A legendary (if somewhat scrambled) Baldurian hero, freed from centuries of statue imprisonment, who travels with his hamster Boo — a miniature giant space hamster.",
  },
  {
    name: "Halsin",
    category: "companion",
    aliases: ["halsin the archdruid"],
    summary:
      "Druid // Archdruid of the Emerald Grove. Found imprisoned in the goblin camp; a shapeshifter who spent a season as a bear rather than deal with people, and understandably so.",
  },
  {
    name: "Minthara",
    category: "companion",
    summary:
      "Paladin // Drow commander of the Absolute's goblin forces at the Emerald Grove. Recruitable only if the tiefling refugees and druids are sacrificed to the goblins in Act 1.",
  },

  // ── Origin (non-companion) ──
  {
    name: "The Dark Urge",
    category: "origin",
    aliases: ["dark urge", "durge"],
    summary:
      "A fully custom playable Origin Character: an amnesiac adventurer with a violent past, an unshakable murderous impulse, and a very personal connection to Bhaal, god of murder.",
  },

  // ── Classes ──
  {
    name: "Barbarian",
    category: "class",
    summary: "Rage-fueled melee class built around Rage, reckless attacks, and being nearly impossible to put down while raging.",
  },
  {
    name: "Bard",
    category: "class",
    summary: "Charisma-based support/skill class weaving Bardic Inspiration and versatile spellcasting with the best skill coverage in the game.",
  },
  {
    name: "Cleric",
    category: "class",
    summary: "Wisdom-based divine caster with a Domain (Life, Light, Trickery, War, Knowledge, Nature, Tempest) shaping their healing and combat spells.",
  },
  {
    name: "Druid",
    category: "class",
    summary: "Wisdom-based nature caster who can Wild Shape into beasts for extra HP pools and unique combat forms alongside spellcasting.",
  },
  {
    name: "Fighter",
    category: "class",
    summary: "Weapon-focused martial class with Action Surge and the most attacks per turn of any class at high level.",
  },
  {
    name: "Monk",
    category: "class",
    summary: "Dexterity/Wisdom unarmed-combat class spending Ki points on flurries of blows, stunning strikes, and mobility.",
  },
  {
    name: "Paladin",
    category: "class",
    summary: "Strength/Charisma martial class sworn to an Oath, blending melee combat with smite spells and auras of protection.",
  },
  {
    name: "Ranger",
    category: "class",
    summary: "Dexterity/Wisdom hybrid combining archery or dual-wielding with nature magic and (for Beast Master) an animal companion.",
  },
  {
    name: "Rogue",
    category: "class",
    summary: "Dexterity-based skill and burst-damage class built around Sneak Attack, Cunning Action, and being extremely hard to pin down.",
  },
  {
    name: "Sorcerer",
    category: "class",
    summary: "Charisma-based innate caster who spends Sorcery Points to Metamagic their spells — Quickened and Twinned Spell are signature tricks.",
  },
  {
    name: "Warlock",
    category: "class",
    summary: "Charisma-based caster with a small number of high-level slots that recharge on a short rest, powered by a pact with a patron (Fiend, Great Old One, Archfey).",
  },
  {
    name: "Wizard",
    category: "class",
    summary: "Intelligence-based caster with the largest spell list in the game, learned from a spellbook and specialized by School of Magic.",
  },

  // ── Races ──
  {
    name: "Human",
    category: "race",
    summary: "The baseline race: flexible ability bonuses and no strong mechanical leanings, common across every region of Faerûn.",
  },
  {
    name: "Elf",
    category: "race",
    aliases: ["high elf", "wood elf"],
    summary: "Long-lived, Dexterity-leaning race with Darkvision and Fey Ancestry (immune to magical sleep); High Elf and Wood Elf are the BG3 subraces.",
  },
  {
    name: "Drow",
    category: "race",
    aliases: ["dark elf", "lolth-sworn", "seldarine"],
    summary: "Underdark-dwelling elven subrace with Superior Darkvision and innate magic; BG3 splits them into Lolth-Sworn and Seldarine (Lolth-renouncing) drow.",
  },
  {
    name: "Half-Elf",
    category: "race",
    summary: "Charisma-leaning race with Fey Ancestry and Darkvision, blending human versatility with elven resilience; comes in High, Wood, and Drow half-elf flavors in BG3.",
  },
  {
    name: "Dwarf",
    category: "race",
    aliases: ["gold dwarf", "shield dwarf"],
    summary: "Hardy, Constitution-leaning race with Darkvision and resistance to poison; Gold Dwarf and Shield Dwarf are the BG3 subraces.",
  },
  {
    name: "Halfling",
    category: "race",
    aliases: ["lightfoot", "strongheart"],
    summary: "Small, lucky, Dexterity-leaning race that can reroll natural 1s (Lucky); Lightfoot and Strongheart are the BG3 subraces.",
  },
  {
    name: "Gnome",
    category: "race",
    aliases: ["forest gnome", "rock gnome", "deep gnome"],
    summary: "Small, Intelligence-leaning race with advantage on saves against magic; Forest, Rock, and Deep Gnome are the BG3 subraces.",
  },
  {
    name: "Half-Orc",
    category: "race",
    summary: "Strength-leaning race with Darkvision, Relentless Endurance (drop to 1 HP instead of 0 once per rest), and bonus critical damage.",
  },
  {
    name: "Githyanki",
    category: "race",
    summary: "Astral Plane warrior race raised from birth for combat under Vlaakith's rule; get free proficiency with several martial weapons and Astral Knowledge.",
  },
  {
    name: "Tiefling",
    category: "race",
    aliases: ["asmodeus tiefling", "mephistopheles tiefling", "zariel tiefling"],
    summary: "Fiend-descended race with Darkvision and fire resistance; BG3's three lineages (Asmodeus, Mephistopheles, Zariel) each grant different innate spells.",
  },
  {
    name: "Dragonborn",
    category: "race",
    summary: "Draconic-ancestry race with a breath weapon and damage resistance tied to their draconic ancestry (e.g. fire for red).",
  },

  // ── Locations (roughly Act order) ──
  {
    name: "The Nautiloid",
    category: "location",
    aliases: ["mind flayer ship", "the ship"],
    summary: "The mind flayer vessel the game opens on, mid-flight during a mind flayer coup — where the player is first infected with an Illithid tadpole.",
  },
  {
    name: "Emerald Grove",
    category: "location",
    aliases: ["the grove"],
    summary: "Act 1 druid grove sheltering tiefling refugees from Elturel, under siege by goblins working for the Absolute — the game's first major hub and moral fork.",
  },
  {
    name: "Blighted Village",
    category: "location",
    summary: "A ruined village in the Sunlit Wetlands full of undead and traps, notable for the Windmill (an early puzzle/boss area) near the goblin camp.",
  },
  {
    name: "Goblin Camp",
    category: "location",
    summary: "The goblin warband's Act 1 stronghold, led by three goblin bosses answering to Minthara — can be razed or used to infiltrate the Absolute's forces.",
  },
  {
    name: "Shattered Sanctum",
    category: "location",
    summary: "A ruined temple beneath/behind the goblin camp being used as a staging ground for the Absolute's cult, leading toward Grymforge.",
  },
  {
    name: "Grymforge",
    category: "location",
    summary: "A sunken dwarven forge city in the Underdark housing an adamantine forge — reforge gear here, and confront Nere and a duergar excavation crew.",
  },
  {
    name: "Underdark",
    category: "location",
    summary: "The vast subterranean region beneath the Sword Coast, home to myconids, duergar, drow, and the Absolute's Grymforge operation in Act 1.",
  },
  {
    name: "Last Light Inn",
    category: "location",
    summary: "The last warded refuge inside the Shadow-Cursed Lands in Act 2, run by Harpers and Jaheira, protected by the aasimar Isobel's light.",
  },
  {
    name: "Shadow-Cursed Lands",
    category: "location",
    aliases: ["shadowlands"],
    summary: "Act 2's cursed region blanketed in unnatural darkness by Ketheric Thorm, filled with shadow-corrupted creatures — traversing it safely requires a light source or resistance.",
  },
  {
    name: "Moonrise Towers",
    category: "location",
    summary: "Ketheric Thorm's fortress and the Cult of the Absolute's Act 2 stronghold in the Shadow-Cursed Lands, garrisoned by True Soul cultists.",
  },
  {
    name: "Gauntlet of Shar",
    category: "location",
    summary: "A trial-filled Sharran temple beneath Reithwin, tied to Shadowheart's past and Ketheric Thorm's bargain with the goddess Shar.",
  },
  {
    name: "Baldur's Gate",
    category: "location",
    aliases: ["the gate"],
    summary: "The great port city the game builds toward across Act 3, split into the Lower City, Rivington/Wyrm's Crossing, and Wyrm's Rock — the Absolute plot's final target.",
  },
  {
    name: "Rivington",
    category: "location",
    summary: "A refugee district just outside Baldur's Gate's walls, and the first area of Act 3 — home to the Elfsong Tavern's exterior and the Open Hand Temple.",
  },
  {
    name: "Wyrm's Crossing",
    category: "location",
    summary: "The massive bridge/district connecting Rivington to the Lower City of Baldur's Gate, dominated by the Steel Watch Foundry.",
  },
  {
    name: "Lower City",
    category: "location",
    summary: "The dense heart of Baldur's Gate in Act 3, full of guilds, patrician houses, and cult activity — where the endgame's political and combat threads converge.",
  },
  {
    name: "Elfsong Tavern",
    category: "location",
    summary: "A landmark Baldur's Gate tavern with a haunted upper floor, tied to several Act 3 companion and side-quest threads.",
  },
  {
    name: "House of Hope",
    category: "location",
    summary: "The cambion devil Raphael's extradimensional lair, reached via a hidden door in the Lower City — home to his archive and the game's biggest devil-bargain temptations.",
  },
  {
    name: "Iron Throne",
    category: "location",
    summary: "A repurposed Flaming Fist ship-turned-fortress in Act 3 tied to Gortash's Steel Watch project and one of the game's optional heist-style infiltrations.",
  },

  // ── Factions ──
  {
    name: "Cult of the Absolute",
    category: "faction",
    aliases: ["the absolute", "true souls"],
    summary: "The game's main antagonist faction, worshipping 'the Absolute' — an Elder Brain bound by the Netherbrain — and marking its favored agents as tadpole-immune 'True Souls'.",
  },
  {
    name: "Harpers",
    category: "faction",
    summary: "A secretive network of do-gooder agents opposing tyranny across Faerûn; Jaheira is a senior member, operating out of Last Light Inn in Act 2.",
  },
  {
    name: "Zhentarim",
    category: "faction",
    aliases: ["zhents"],
    summary: "A profit-driven mercenary and criminal network with a presence in every act, happy to work with anyone (including the player) for the right price.",
  },
  {
    name: "Flaming Fist",
    category: "faction",
    summary: "Baldur's Gate's powerful mercenary army/city guard, commanded by Duke Ravengard, and a major faction in the Act 3 political conflict.",
  },
  {
    name: "Steel Watch",
    category: "faction",
    summary: "Enver Gortash's army of magical automatons built to 'protect' Baldur's Gate in Act 3 — really a tool for seizing control of the city.",
  },

  // ── Deities ──
  {
    name: "Shar",
    category: "deity",
    summary: "Goddess of loss, darkness, and forgetting; Shadowheart's patron, and the power behind the curse over the Shadow-Cursed Lands.",
  },
  {
    name: "Selûne",
    category: "deity",
    summary: "Goddess of the moon and protector of the night sky; Shar's eternal rival, worshipped by several Act 2 allies at Last Light Inn.",
  },
  {
    name: "Mystra",
    category: "deity",
    summary: "Goddess of magic and the Weave; Gale is her former Chosen, and the source of the annihilating orb lodged in his chest.",
  },
  {
    name: "Bhaal",
    category: "deity",
    summary: "The Lord of Murder, a Dead Three god of assassination; father of the Dark Urge's murderous compulsions and patron of Orin the Red's cult.",
  },
  {
    name: "Bane",
    category: "deity",
    summary: "The Dead Three god of tyranny and domination; patron of Enver Gortash, the Act 3 antagonist seeking to rule Baldur's Gate through the Steel Watch.",
  },
  {
    name: "Myrkul",
    category: "deity",
    summary: "The Dead Three god of death and the dead; patron of Ketheric Thorm, whose bargain with Myrkul is central to the Act 2 plot.",
  },
  {
    name: "Lathander",
    category: "deity",
    summary: "God of dawn, birth, and renewal; associated with several side quests and the aasimar Isobel's protective light at Last Light Inn.",
  },

  // ── Notable Villains ──
  {
    name: "Ketheric Thorm",
    category: "villain",
    summary: "Act 2's central antagonist: a grieving general turned Chosen of Myrkul, ruling Moonrise Towers and the Shadow-Cursed Lands from behind an unnatural curse.",
  },
  {
    name: "Orin the Red",
    category: "villain",
    aliases: ["orin"],
    summary: "The shapeshifting Chosen of Bhaal leading the Cult of the Absolute's Act 3 murder-cult, and the Dark Urge's obsessive rival/sibling in blood.",
  },
  {
    name: "Enver Gortash",
    category: "villain",
    aliases: ["gortash"],
    summary: "The ambitious Chosen of Bane engineering his own rise to Archduke of Baldur's Gate in Act 3 with the Steel Watch army as his enforcers.",
  },
  {
    name: "Raphael",
    category: "villain",
    summary: "A cunning cambion devil running the House of Hope, offering tempting (and costly) bargains throughout Act 2 and 3 while pursuing the Crown of Karsus.",
  },
  {
    name: "Balthazar",
    category: "villain",
    summary: "An undead servant of Ketheric Thorm overseeing the Necromancy of Thay beneath the Gauntlet of Shar in Act 2.",
  },
  {
    name: "Viconia DeVir",
    category: "villain",
    summary: "A drow priestess of Shar (returning from the classic Baldur's Gate games) encountered serving Shar's interests in Act 2/3.",
  },

  // ── Legendary Items ──
  {
    name: "Nyrulna",
    category: "item",
    summary: "A legendary returning trident/hammer hybrid weapon tied to the game's late-game superboss content, wielded by a titan.",
  },
  {
    name: "Titanstring Bow",
    category: "item",
    summary: "A Very Rare longbow that lets a wielder add their Strength modifier to ranged attacks — a build-defining pick for Strength-based archers.",
  },
  {
    name: "Markoheshkir",
    category: "item",
    aliases: ["fragment of markoheshkir"],
    summary: "The legendary Staff of Karsus, granting free spellcasting and (in its Legendary form) letting a wizard cast any spell in their spellbook without a slot once per short rest.",
  },
  {
    name: "Bhaalist Armour",
    category: "item",
    summary: "Legendary armor granting bonus damage that scales with a killing streak — thematically tied to Bhaal, the god of murder.",
  },
  {
    name: "Helldusk Armour",
    category: "item",
    summary: "Very Rare heavy armor looted from Cazador's Palace granting fire resistance and a Wall of Fire spell — a signature endgame heavy-armor set piece.",
  },
  {
    name: "Balduran's Giantslayer",
    category: "item",
    summary: "A legendary greatsword once wielded by the legendary explorer Balduran, dealing bonus damage to Large-or-larger creatures.",
  },
  {
    name: "Sword of Chaos",
    category: "item",
    summary: "Orin the Red's signature legendary dagger/blade, tied to her Bhaalist murder-cult leadership in Act 3.",
  },
  {
    name: "Spellsparkler",
    category: "item",
    summary: "A Very Rare quarterstaff that empowers a caster's next spell after a cantrip lands, rewarding a cantrip-into-spell rotation.",
  },
  {
    name: "Duellist's Prerogative",
    category: "item",
    summary: "A legendary rapier granting an extra reaction attack of opportunity and bonus action attacks under the right conditions — a premier finesse-weapon pick.",
  },
];

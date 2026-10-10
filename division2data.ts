// Tom Clancy's The Division 2 knowledgebase — static reference data for
// !div2lookup, and the pools the !div2build / !div2loot / !div2mission
// generators in division2.ts draw from.
//
// Like bg3data.ts this is hand-curated flavor/reference content — there's no
// public Division 2 API to query. Summaries describe what a thing is for
// rather than exact talent numbers, which Massive retunes from season to
// season; the fandom wiki link on every lookup has the current values.

export type Div2Category =
  | "specialization"
  | "skill"
  | "gearset"
  | "brand"
  | "exotic"
  | "faction"
  | "character"
  | "location"
  | "mode";

export interface Div2Entry {
  name: string;
  category: Div2Category;
  /** Extra search terms that should resolve to this entry. */
  aliases?: string[];
  summary: string;
}

export const DIV2_CATEGORY_LABELS: Record<Div2Category, string> = {
  specialization: "Specialization",
  skill: "Skill",
  gearset: "Gear Set",
  brand: "Brand Set",
  exotic: "Exotic",
  faction: "Faction",
  character: "Character",
  location: "Location",
  mode: "Game Mode",
};

/** Chat-friendly aliases/plurals that map to a canonical category key. */
export const DIV2_CATEGORY_ALIASES: Record<string, Div2Category> = {
  spec: "specialization",
  specs: "specialization",
  specialization: "specialization",
  specializations: "specialization",
  skill: "skill",
  skills: "skill",
  gearset: "gearset",
  gearsets: "gearset",
  set: "gearset",
  sets: "gearset",
  brand: "brand",
  brands: "brand",
  exotic: "exotic",
  exotics: "exotic",
  faction: "faction",
  factions: "faction",
  enemy: "faction",
  enemies: "faction",
  character: "character",
  characters: "character",
  npc: "character",
  location: "location",
  locations: "location",
  place: "location",
  zone: "location",
  mode: "mode",
  modes: "mode",
  activity: "mode",
};

export const DIV2_KNOWLEDGEBASE: Div2Entry[] = [
  // ── Specializations ─────────────────────────────────────────────────────
  { name: "Survivalist", category: "specialization", aliases: ["crossbow"], summary: "Signature weapon: an explosive crossbow. Leans into status effects and survival — Survivalists hand out bleeds, extra armor kit value, and team healing bonuses. Comes with the Mender variant of the Seeker Mine." },
  { name: "Demolitionist", category: "specialization", aliases: ["demo", "m32", "grenade launcher"], summary: "Signature weapon: the M32A1 multi-grenade launcher. Built for explosive damage and crowd control, with the Artillery variant of the Turret." },
  { name: "Sharpshooter", category: "specialization", aliases: ["tac50", "tac-50"], summary: "Signature weapon: the TAC-50 .50-cal rifle. The long-range headshot specialist — stability, headshot damage, and the Sniper variant of the Turret." },
  { name: "Gunner", category: "specialization", aliases: ["minigun"], summary: "Signature weapon: the Minigun. A frontline tank who earns armor and ammo by staying in the fight, with the Banshee variant of the Pulse to confuse enemies." },
  { name: "Technician", category: "specialization", aliases: ["tech", "p-017", "launcher"], summary: "Signature weapon: the P-017 missile launcher. Every skill gets stronger — Technicians overcharge their gadgets and bring the Artificer variant of the Hive." },
  { name: "Firewall", category: "specialization", aliases: ["k8", "flamethrower"], summary: "Signature weapon: the K8-Jetstream flamethrower. A shield-and-shotgun bruiser who burns everything in front of them, with the Striker variant of the Shield." },

  // ── Skills ──────────────────────────────────────────────────────────────
  { name: "Turret", category: "skill", summary: "A deployable gun platform. Variants: Assault (auto-targets), Incinerator (flamethrower cone), and the specialization ones — Sniper (Sharpshooter, you pick the targets) and Artillery (Demolitionist, lobbed shells)." },
  { name: "Hive", category: "skill", summary: "Drops a nest of micro-drones. Variants: Reviver (picks up downed allies), Stinger (damages enemies), Booster (buffs allies), Restorer (repairs armor), and the Technician's Artificer." },
  { name: "Chem Launcher", category: "skill", aliases: ["chem"], summary: "A canister launcher. Variants: Reinforcer (repair cloud), Oxidizer (corrosive cloud), Riot Foam (pins enemies in place), and Firestarter (flammable gas — light it up)." },
  { name: "Firefly", category: "skill", summary: "A small drone that flies a path to tagged targets. Variants: Blinder (blinds), Burster (explosive), and Demolisher (destroys weak points and armor plating)." },
  { name: "Seeker Mine", category: "skill", aliases: ["seeker"], summary: "A rolling mine that hunts a target. Variants: Explosive, Airburst (fire), Cluster (splits into mini-seekers), and the Survivalist's Mender (heals allies)." },
  { name: "Drone", category: "skill", summary: "A flying helper. Variants: Striker (shoots), Defender (deflects incoming fire), Bombardier (bombing run), Fixer (repairs armor), and Tactician (marks enemies for the team)." },
  { name: "Shield", category: "skill", summary: "A ballistic shield you carry into the fight. Variants: Bulwark (full-body, sidearm only), Crusader (lets you use SMGs/pistols), Deflector (bounces bullets back), and the Firewall's Striker." },
  { name: "Pulse", category: "skill", summary: "Reveals and marks enemies. Variants: Scanner (area scan), Remote (place it), Jammer (shocks robots and disrupts skills), and the Gunner's Banshee (confuses enemies)." },
  { name: "Trap", category: "skill", summary: "Lays a cluster of proximity mines. Variants: Shock (stuns), Shrapnel (bleeds), and Repair (heals allies who walk through)." },
  { name: "Sticky Bomb", category: "skill", aliases: ["sticky"], summary: "A remote-detonated explosive. Variants: Explosive, Burn, and EMP." },
  { name: "Decoy", category: "skill", summary: "A holographic agent that draws enemy fire and aggro away from you and your team." },

  // ── Gear sets ───────────────────────────────────────────────────────────
  { name: "Striker's Battlegear", category: "gearset", aliases: ["striker", "strikers"], summary: "The red-build classic: every hit adds a stack of weapon damage, and the 4-piece talent lets the stacks climb high as long as you keep shooting. Miss too much and the stacks bleed away." },
  { name: "Heartbreaker", category: "gearset", summary: "Headshots pulse enemies, and hits on pulsed enemies stack bonus armor and damage — a tanky aggressive set that rewards staying on target." },
  { name: "Hunter's Fury", category: "gearset", aliases: ["hunters fury"], summary: "Close-range SMG/shotgun brawler set: big amplified damage to enemies near you, and kills disorient nearby enemies while restoring armor." },
  { name: "Negotiator's Dilemma", category: "gearset", aliases: ["negotiators", "nd"], summary: "Critical hits mark enemies; crits on one marked enemy deal bonus damage to every other marked enemy. A crowd-killer for crit builds." },
  { name: "Eclipse Protocol", category: "gearset", aliases: ["eclipse"], summary: "Status-effect set: killing a status-effected enemy spreads its effects to everyone nearby. Pairs with burn, bleed and blind skills." },
  { name: "Future Initiative", category: "gearset", aliases: ["fi"], summary: "Healer set: buffs repair skills, and while you and your allies are at full armor everyone hits harder." },
  { name: "Foundry Bulwark", category: "gearset", aliases: ["foundry"], summary: "Shield tank set: when your armor or shield takes damage, the other repairs — a near-unkillable frontline with Bulwark or Crusader shields." },
  { name: "Hard Wired", category: "gearset", aliases: ["hardwired"], summary: "Skill set built on the Feedback Loop talent: using a skill shortens the cooldown of the other one, so turrets and drones come back fast." },
  { name: "Ongoing Directive", category: "gearset", aliases: ["od"], summary: "Killing a status-effected enemy grants special hollow-point ammo for you and your group that deals extra damage and applies bleed." },
  { name: "True Patriot", category: "gearset", aliases: ["tp"], summary: "Support debuff set: your hits cycle Red, White and Blue debuffs on an enemy — damage taken, armor for your team, and more. A raid favorite." },
  { name: "Rigger", category: "gearset", summary: "Skill set built on Tinkerer stacks: using skills builds stacks that extend skill duration and speed up cooldowns." },
  { name: "Aces & Eights", category: "gearset", aliases: ["aces", "aces and eights"], summary: "Marksman set: hits flip cards in a 'Dead Man's Hand' — fill the hand and your next shot lands big bonus headshot damage." },
  { name: "System Corruption", category: "gearset", aliases: ["sc"], summary: "Armor-kit set: the lower your armor, the more you deal and the faster you regenerate. Built for daredevils living at red armor." },
  { name: "Tip of the Spear", category: "gearset", aliases: ["tots"], summary: "Signature-weapon set: buffs your specialization weapon and generates signature ammo as you fight." },
  { name: "Umbra Initiative", category: "gearset", aliases: ["umbra"], summary: "Cover-to-cover set: moving between cover builds crit chance and crit damage, rewarding aggressive repositioning." },

  // ── Brand sets ──────────────────────────────────────────────────────────
  { name: "Ceska Vyroba", category: "brand", aliases: ["ceska"], summary: "Offensive brand (red) focused on critical hit chance — a staple in crit builds." },
  { name: "Grupo Sombra", category: "brand", aliases: ["sombra"], summary: "Offensive brand (red) focused on critical hit damage." },
  { name: "Providence Defense", category: "brand", aliases: ["providence"], summary: "Offensive brand (red) built around headshot damage and crits — the go-to for marksman and rifle players." },
  { name: "Fenris Group", category: "brand", aliases: ["fenris"], summary: "Offensive brand (red) focused on assault rifle damage and reload speed." },
  { name: "Overlord Armaments", category: "brand", aliases: ["overlord"], summary: "Offensive brand (red) focused on rifle damage and accuracy." },
  { name: "Airaldi Holdings", category: "brand", aliases: ["airaldi"], summary: "Offensive brand (red) for marksman rifles, with headshot damage as you climb pieces." },
  { name: "Sokolov Concern", category: "brand", aliases: ["sokolov"], summary: "Offensive brand (red) focused on SMG damage and critical hits." },
  { name: "Petrov Defense Group", category: "brand", aliases: ["petrov"], summary: "Offensive brand (red) focused on LMG damage and handling." },
  { name: "Badger Tuff", category: "brand", aliases: ["badger"], summary: "Mixed brand focused on shotgun damage and armor — the close-quarters favorite." },
  { name: "Walker, Harris & Co.", category: "brand", aliases: ["walker harris", "walker"], summary: "Offensive brand (red) with flat weapon damage, plus damage to armor and health." },
  { name: "Gila Guard", category: "brand", aliases: ["gila"], summary: "Defensive brand (blue) built on total armor and armor regeneration." },
  { name: "Belstone Armory", category: "brand", aliases: ["belstone"], summary: "Defensive brand (blue) focused on armor regeneration and armor on kill." },
  { name: "Golden Bat", category: "brand", aliases: ["golden bat ltd"], summary: "Defensive brand (blue) with status-effect resistance and armor." },
  { name: "Richter & Kaiser", category: "brand", aliases: ["richter", "r&k"], summary: "Defensive brand (blue) built around incoming repairs and explosive resistance." },
  { name: "Wyvern Wear", category: "brand", aliases: ["wyvern"], summary: "Skill brand (yellow) focused on skill damage and status effects." },
  { name: "Hana-U Corporation", category: "brand", aliases: ["hana u", "hana-u"], summary: "Skill brand (yellow) focused on skill haste and skill damage." },
  { name: "Murakami Industries", category: "brand", aliases: ["murakami"], summary: "Skill brand (yellow) focused on skill duration and repair skills." },
  { name: "Alps Summit Armament", category: "brand", aliases: ["alps"], summary: "Skill brand (yellow) focused on skill duration and cooldown reduction." },
  { name: "Empress International", category: "brand", aliases: ["empress"], summary: "Skill brand (yellow) focused on skill health and skill efficiency." },
  { name: "China Light Industries", category: "brand", aliases: ["china light", "clic"], summary: "Skill brand (yellow) focused on explosive damage — pairs with Sticky Bombs and Seekers." },
  { name: "5.11 Tactical", category: "brand", aliases: ["511", "5.11"], summary: "Defensive brand (blue) with health and incoming repairs." },

  // ── Exotics ─────────────────────────────────────────────────────────────
  { name: "Eagle Bearer", category: "exotic", aliases: ["eagle"], summary: "Exotic assault rifle. Eagle's Strike: accurate shots build stacks of damage and lifesteal; a top-tier all-rounder, originally a raid drop." },
  { name: "Chameleon", category: "exotic", summary: "Exotic assault rifle. Adaptive Instincts: hitting enough headshots or body/leg shots in a row switches on a matching buff — headshot damage or weapon damage." },
  { name: "St. Elmo's Engine", category: "exotic", aliases: ["st elmo", "st elmos", "elmo"], summary: "Exotic assault rifle. Fires shock ammo periodically, shocking enemies it hits — great crowd control on a fast-firing AR." },
  { name: "Bullet King", category: "exotic", aliases: ["bk"], summary: "Exotic LMG that never needs to reload — just keep holding the trigger." },
  { name: "Pestilence", category: "exotic", summary: "Exotic LMG. Hits apply a Plague that ticks damage and spreads on kill — a status monster against crowds." },
  { name: "Regulus", category: "exotic", summary: "Exotic revolver. Headshot kills explode, damaging enemies around the target." },
  { name: "Liberty", category: "exotic", summary: "Exotic pistol with a patriotic theme and its own unique talent — a sidearm favorite. Check the wiki link for its current numbers." },
  { name: "Nemesis", category: "exotic", summary: "Exotic marksman rifle. Charge your shot for massive damage, and it marks targets for your team while you aim." },
  { name: "Sweet Dreams", category: "exotic", summary: "Exotic shotgun. Melee an enemy to put them to sleep — then follow up with a shotgun blast." },
  { name: "Lady Death", category: "exotic", summary: "Exotic SMG. Build 'Breathe Free' stacks by sprinting and moving; each shot spends a stack for bonus damage." },
  { name: "Chatterbox", category: "exotic", summary: "Exotic SMG. Rate of fire climbs the closer you are, and kills refill part of the magazine." },
  { name: "Diamondback", category: "exotic", summary: "Exotic lever-action rifle. One enemy gets marked at a time; hitting the marked target deals big Agonizing Bite damage." },
  { name: "The Bighorn", category: "exotic", aliases: ["bighorn"], summary: "Exotic rifle that switches between full-auto and a powerful scoped semi-auto mode." },
  { name: "Memento", category: "exotic", summary: "Exotic backpack. Kills drop trophies you can pick up for stacking weapon damage, skill efficiency and armor regen." },
  { name: "BTSU Datagloves", category: "exotic", aliases: ["btsu"], summary: "Exotic gloves for skill builds — overcharges your skills and keeps the cooldowns rolling." },
  { name: "Coyote's Mask", category: "exotic", aliases: ["coyote", "coyotes mask"], summary: "Exotic mask. Grants your group critical hit chance or critical hit damage depending on how far enemies are." },
  { name: "Acosta's Go-Bag", category: "exotic", aliases: ["acosta", "acostas"], summary: "Exotic backpack for skill builds that rewards chaining skills and grenades together." },
  { name: "Ninjabike Messenger Bag", category: "exotic", aliases: ["ninjabike", "ninja bike", "nmb"], summary: "Exotic backpack that counts as one extra piece of every brand set you're wearing — the brand-build enabler." },
  { name: "Vile", category: "exotic", summary: "Exotic mask. Status effects you apply also make the target bleed toxins." },
  { name: "Imperial Dynasty", category: "exotic", summary: "Exotic holster that periodically sets nearby enemies on fire." },
  { name: "Dodge City Gunslinger's Holster", category: "exotic", aliases: ["dodge city", "gunslinger"], summary: "Exotic holster. Swap to your pistol to fire a deadly quick-draw shot." },
  { name: "Tardigrade Armor System", category: "exotic", aliases: ["tardigrade"], summary: "Exotic chest. Using an armor kit shares bonus armor with your group — a raid support staple." },

  // ── Factions ────────────────────────────────────────────────────────────
  { name: "Hyenas", category: "faction", summary: "Loose gang of looters and thrill-seekers who run on chaos and cheap drugs. Fast, flanky, and the first enemy most agents meet in D.C." },
  { name: "Outcasts", category: "faction", summary: "Survivors once quarantined on Roosevelt Island, now fanatics bent on revenge — suicide bombers and fire-throwers." },
  { name: "True Sons", category: "faction", summary: "Former JTF and military turned would-be army, led by Antwon Ridgeway. Disciplined, entrenched, and fond of grenades." },
  { name: "Black Tusk", category: "faction", aliases: ["black tusk special unit", "bt"], summary: "A private military company with drones, robot dogs and warhounds. The endgame faction that invaded D.C. right after the campaign." },
  { name: "Cleaners", category: "faction", summary: "The flamethrower-wielding sanitation workers from New York, convinced fire is the only cure for the virus. Back in Warlords of New York." },
  { name: "Rikers", category: "faction", summary: "Escaped prisoners from Rikers Island. Brutal, loud, and back in Lower Manhattan for Warlords of New York." },
  { name: "Joint Task Force", category: "faction", aliases: ["jtf"], summary: "The civilian-military relief force the Division supports. They hold the White House and the settlements." },
  { name: "The Division", category: "faction", aliases: ["shd", "strategic homeland division"], summary: "Sleeper agents of the Strategic Homeland Division, activated when society collapses. That's you, agent." },

  // ── Characters ──────────────────────────────────────────────────────────
  { name: "Aaron Keener", category: "character", aliases: ["keener"], summary: "The first rogue Division agent and the big bad of Warlords of New York. Holed up in Lower Manhattan with his lieutenants and a modified strain of the virus." },
  { name: "Faye Lau", category: "character", aliases: ["faye"], summary: "Division agent and handler from the first game, back as a central figure in Warlords of New York." },
  { name: "Antwon Ridgeway", category: "character", aliases: ["ridgeway"], summary: "Former JTF commander who leads the True Sons in Washington, D.C." },
  { name: "Odessa Paulson", category: "character", aliases: ["odessa", "paulson"], summary: "Leader of the Theater settlement — an engineer keeping the lights on in downtown D.C." },
  { name: "Manny Ortega", category: "character", aliases: ["manny", "ortega"], summary: "Division operations lead at the White House. Hands out missions and the bad news." },
  { name: "Theo Parnell", category: "character", aliases: ["parnell"], summary: "One of Aaron Keener's four lieutenants in Warlords of New York, each holding a district of Lower Manhattan." },
  { name: "Javier Kestrel", category: "character", aliases: ["kestrel"], summary: "One of Aaron Keener's four lieutenants in Warlords of New York, each holding a district of Lower Manhattan." },
  { name: "Vivian Conley", category: "character", aliases: ["conley"], summary: "One of Aaron Keener's four lieutenants in Warlords of New York, each holding a district of Lower Manhattan." },
  { name: "James Dragov", category: "character", aliases: ["dragov"], summary: "One of Aaron Keener's four lieutenants in Warlords of New York, each holding a district of Lower Manhattan." },
  { name: "ISAC", category: "character", aliases: ["isaac"], summary: "Intelligent System Analytic Computer — the voice in every agent's ear. 'Rogue agent detected.'" },

  // ── Locations ───────────────────────────────────────────────────────────
  { name: "White House", category: "location", aliases: ["base of operations", "boo"], summary: "The Division's Base of Operations in Washington, D.C., where you upgrade your crafting, recruit specialists and pick up missions." },
  { name: "The Theater", category: "location", aliases: ["theater"], summary: "The first settlement you meet in D.C., run by Odessa Paulson and supplied by the Division." },
  { name: "The Campus", category: "location", aliases: ["campus"], summary: "A university settlement of students and scientists working on food and technology." },
  { name: "The Castle", category: "location", aliases: ["castle"], summary: "A fortified settlement on the edge of the city that the Division helps defend." },
  { name: "Dark Zone", category: "location", aliases: ["dz", "dz east", "dz south", "dz west"], summary: "Walled-off PvPvE zones (East, South and West in D.C.) where loot is contaminated and must be extracted by helicopter — and other agents can go rogue and take it." },
  { name: "Lower Manhattan", category: "location", aliases: ["new york", "nyc", "manhattan"], summary: "The Warlords of New York expansion area — four districts held by Keener's lieutenants." },
  { name: "Brooklyn", category: "location", summary: "The 'Battle for Brooklyn' DLC area — the return to the first game's starting borough." },
  { name: "Grand Washington Hotel", category: "location", aliases: ["grand washington"], summary: "One of the earliest story missions — a Hyena-held hotel and a fan-favorite run." },
  { name: "Capitol Building", category: "location", aliases: ["capitol"], summary: "A True Sons stronghold — one of the three endgame strongholds you clear at the end of the campaign." },
  { name: "Tidal Basin", category: "location", summary: "A Black Tusk stronghold on the water — the airfield-and-hangar endgame assault." },
  { name: "Roosevelt Island", category: "location", summary: "An Outcast stronghold and the quarantine island where their story began." },
  { name: "District Union Arena", category: "location", aliases: ["dua"], summary: "A Hyena stronghold in an old stadium — one of the campaign-ending strongholds." },
  { name: "Camp White Oak", category: "location", aliases: ["white oak"], summary: "The power plant where Countdown takes place." },

  // ── Game modes ──────────────────────────────────────────────────────────
  { name: "Raids", category: "mode", aliases: ["raid", "operation dark hours", "dark hours", "iron horse", "operation iron horse"], summary: "Eight-player endgame operations — Dark Hours (Washington National Airport) and Iron Horse (a steel foundry) — with mechanics-heavy bosses and exclusive exotics like the Eagle Bearer." },
  { name: "Conflict", category: "mode", aliases: ["pvp"], summary: "Organized 4v4 PvP — Skirmish and Domination on dedicated maps, with normalized gear." },
  { name: "The Summit", category: "mode", aliases: ["summit"], summary: "A 100-floor tower in New York — every floor a random objective, with targeted loot and bosses on the way to the top." },
  { name: "Countdown", category: "mode", summary: "A fast 8-player PvE mode at Camp White Oak: hit objectives, then extract before the 15-minute timer hits zero." },
  { name: "Descent", category: "mode", aliases: ["roguelite"], summary: "A roguelite mode: start with nothing, pick talents and gear between rooms, and see how deep you can go." },
  { name: "Strongholds", category: "mode", aliases: ["stronghold"], summary: "Long, boss-capped missions against an entrenched faction — the campaign's final three, plus Black Tusk's." },
  { name: "Manhunts", category: "mode", aliases: ["manhunt", "seasons", "season"], summary: "The seasonal story: hunt a list of targets week by week until you reach the final rogue at the top." },
];

// ── Generator pools (division2.ts) ────────────────────────────────────────

export interface Div2SpecRoll {
  name: string;
  weapon: string;
}

export const DIV2_SPECS: Div2SpecRoll[] = [
  { name: "Survivalist", weapon: "Explosive Crossbow" },
  { name: "Demolitionist", weapon: "M32A1 Grenade Launcher" },
  { name: "Sharpshooter", weapon: "TAC-50 Rifle" },
  { name: "Gunner", weapon: "Minigun" },
  { name: "Technician", weapon: "P-017 Missile Launcher" },
  { name: "Firewall", weapon: "K8-Jetstream Flamethrower" },
];

export const DIV2_WEAPON_CLASSES = ["Assault Rifle", "SMG", "LMG", "Rifle", "Marksman Rifle", "Shotgun"];

// Base variants only — the specialization variants (Sniper/Artillery Turret,
// Mender Seeker, Artificer Hive, Banshee Pulse, Striker Shield) need that spec.
export const DIV2_SKILL_VARIANTS: Record<string, string[]> = {
  Turret: ["Assault", "Incinerator"],
  Hive: ["Reviver", "Stinger", "Booster", "Restorer"],
  "Chem Launcher": ["Reinforcer", "Oxidizer", "Riot Foam", "Firestarter"],
  Firefly: ["Blinder", "Burster", "Demolisher"],
  "Seeker Mine": ["Explosive", "Airburst", "Cluster"],
  Drone: ["Striker", "Defender", "Bombardier", "Fixer", "Tactician"],
  Shield: ["Bulwark", "Crusader", "Deflector"],
  Pulse: ["Scanner", "Remote", "Jammer"],
  Trap: ["Shock", "Shrapnel", "Repair"],
  "Sticky Bomb": ["Explosive", "Burn", "EMP"],
};

export const DIV2_EXOTIC_POOL = DIV2_KNOWLEDGEBASE.filter((e) => e.category === "exotic").map((e) => e.name);
export const DIV2_GEARSET_POOL = DIV2_KNOWLEDGEBASE.filter((e) => e.category === "gearset").map((e) => e.name);
export const DIV2_BRAND_POOL = DIV2_KNOWLEDGEBASE.filter((e) => e.category === "brand").map((e) => e.name);

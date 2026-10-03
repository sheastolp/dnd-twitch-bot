// Chat flavor generators: !roll yes/no fate, !oracle, !hug and !shmash.
// Split out of utils.ts to keep every file well under Val Town's per-file
// size ceiling.

import { pick } from "./utils.ts";

// Yes/No fate questions, e.g. "!roll is enya going to die this time?" — a
// separate flavor pool from the dice puns above since these need to echo
// the asker's question back into a verdict rather than a roll total.
const FATE_YES: Array<(q: string) => string> = [
  (q) => `🎲 Natural 20! The fates favor a YES on "${q}"`,
  (q) => `📜 You cast Augury and receive a weal omen — YES, regarding "${q}"`,
  (q) => `🔮 The crystal ball clears... it shows YES for "${q}"`,
  (q) => `⚖️ The DM rolls behind the screen, smirks, and says YES to "${q}"`,
  (q) => `🃏 You draw from the Deck of Many Things: the Sun. YES — "${q}" comes to pass`,
  (q) => `👁️ The beholder's central eye blinks in approval: YES on "${q}"`,
  (q) => `✨ The bones fall in a favorable pattern. YES, so it is written — "${q}"`,
  (q) => `🗡️ Even a rogue with disadvantage nails this one. YES to "${q}"`,
  (q) => `🌟 The Bag of Holding produces exactly what's needed. YES on "${q}"`,
  (q) => `🐉 Even the dragon nods in approval. YES to "${q}"`,
  (q) => `📯 The horn of victory sounds. YES, regarding "${q}"`,
  (q) => `🍀 A stroke of adventurer's luck says YES to "${q}"`,
  (q) => `🧙 The wizard's crystal reveals a bright future. YES for "${q}"`,
  (q) => `⚔️ The blade hums with approval. YES to "${q}"`,
  (q) => `🕊️ A paladin's oath affirms it. YES on "${q}"`,
  (q) => `🎯 A natural bullseye of fate. YES, regarding "${q}"`,
  (q) => `🏰 The castle gates open wide. YES to "${q}"`,
  (q) => `🌕 The full moon favors bold choices. YES on "${q}"`,
  (q) => `📖 The tome of fate flips open to a golden page. YES for "${q}"`,
  (q) => `🔥 The campfire crackles in agreement. YES to "${q}"`,
];

const FATE_NO: Array<(q: string) => string> = [
  (q) => `💀 Natural 1! Critical fumble — the answer is NO on "${q}"`,
  (q) => `📜 Augury returns a woe omen. NO, regarding "${q}"`,
  (q) => `🔮 The crystal ball clouds over... NO for "${q}"`,
  (q) => `⚖️ The DM shakes their head slowly. NO to "${q}"`,
  (q) => `🃏 You draw from the Deck of Many Things: the Void. NO — "${q}" will not come to pass`,
  (q) => `👁️ The beholder's central eye narrows: NO on "${q}"`,
  (q) => `✨ The bones scatter unfavorably. NO, so it is written — "${q}"`,
  (q) => `🛡️ Even a paladin's Lay on Hands can't save this one. NO to "${q}"`,
  (q) => `🕳️ The trapdoor springs early. NO on "${q}"`,
  (q) => `🐍 The yuan-ti hisses in disapproval. NO to "${q}"`,
  (q) => `⛈️ A storm rolls in over the plan. NO, regarding "${q}"`,
  (q) => `🗿 The ancient statue's eyes stay cold. NO for "${q}"`,
  (q) => `🦴 The bone dice clatter to a stop, unfavorable. NO to "${q}"`,
  (q) => `🕯️ The candle gutters out. NO on "${q}"`,
  (q) => `🐺 The wolves howl a warning. NO to "${q}"`,
  (q) => `🏹 The arrow falls short of its mark. NO for "${q}"`,
  (q) => `🌑 The new moon offers no light on this one. NO for "${q}"`,
  (q) => `🧪 The potion fizzles instead of glowing. NO to "${q}"`,
  (q) => `⚰️ The crypt door stays sealed. NO, regarding "${q}"`,
  (q) => `🐀 Even the rats scurry away from this. NO on "${q}"`,
];

const MAX_FATE_QUESTION_LEN = 200;

/** A 50/50 D&D-flavored yes/no verdict for a chat-supplied question. */
export function rollFate(question: string): string {
  const q = question.trim();
  const displayQuestion = q.length > MAX_FATE_QUESTION_LEN ? q.slice(0, MAX_FATE_QUESTION_LEN) + "…" : q;
  const pool = Math.random() < 0.5 ? FATE_YES : FATE_NO;
  const flavor = pool[Math.floor(Math.random() * pool.length)];
  return flavor(displayQuestion);
}

// !oracle <question> — like !roll's fate verdict, but instead of YES/NO the
// "answer" is a randomly-chosen recent chatter's name. The pool of eligible
// names is supplied by the caller (see getRecentChatters in db.ts); this
// function only owns the flavor text around whichever name it's given.
const ORACLE_LINES: Array<(q: string, name: string) => string> = [
  (q, name) => `🔮 The crystal ball swirls and resolves into a face: @${name}, regarding "${q}"`,
  (q, name) => `📜 You cast Augury. The vision names @${name} for "${q}"`,
  (q, name) => `🎴 The Deck of Many Things turns up a familiar face: @${name}, on "${q}"`,
  (q, name) => `👁️ The beholder's central eye fixes on @${name} for "${q}"`,
  (q, name) => `✨ The bones scatter and spell out a name: @${name}, regarding "${q}"`,
  (q, name) => `🕯️ The candle's smoke curls into the shape of @${name} for "${q}"`,
  (q, name) => `🗿 The ancient statue's eyes swivel and lock onto @${name} for "${q}"`,
  (q, name) => `🐉 The dragon exhales a name on the wind: @${name}, on "${q}"`,
  (q, name) => `🧙 The wizard's crystal reveals @${name} at the heart of it — "${q}"`,
  (q, name) => `📯 The horn sounds, summoning @${name} forth for "${q}"`,
  (q, name) => `🌕 By the light of the full moon, @${name} is named for "${q}"`,
  (q, name) => `🍀 Fate's coin lands heads-up on @${name} for "${q}"`,
  (q, name) => `⚖️ The DM consults the notes behind the screen and points at @${name} for "${q}"`,
  (q, name) => `🔥 The campfire pops and sends a spark toward @${name} — "${q}"`,
  (q, name) => `🕊️ A raven circles the tavern and lands on @${name}'s shoulder for "${q}"`,
  (q, name) => `🧿 The rune stones fall into the shape of a name: @${name}, on "${q}"`,
  (q, name) => `⚔️ The blade points itself, unbidden, toward @${name} for "${q}"`,
  (q, name) => `🃏 The tarot reveals The Adventurer: @${name}, regarding "${q}"`,
  (q, name) => `🏰 The castle gates swing open before @${name} for "${q}"`,
  (q, name) => `🐺 The wolves howl a name into the night: @${name}, on "${q}"`,
  (q, name) => `🌟 The stars align and trace out @${name} for "${q}"`,
  (q, name) => `📖 The tome of fate flips open to a page bearing @${name}'s name — "${q}"`,
];

const MAX_ORACLE_QUESTION_LEN = 200;

/** Names a random recent chatter as the "answer" to a chat-supplied question. */
export function rollOracle(question: string, chatterName: string): string {
  const q = question.trim();
  const displayQuestion = q.length > MAX_ORACLE_QUESTION_LEN ? q.slice(0, MAX_ORACLE_QUESTION_LEN) + "…" : q;
  const flavor = pick(ORACLE_LINES);
  return flavor(displayQuestion, chatterName);
}

// !hug — an undocumented, purely warm/supportive command. No dice, no
// mechanics, no game state. Kept out of !dndbothelp and the guide on
// purpose (like !connections) so it stays a small, genuine gesture rather
// than a "feature" people grind or spam for a reaction.
const HUG_LINES: string[] = [
  "Even legendary heroes need a long rest sometimes.",
  "You've survived every encounter so far — that's a flawless record.",
  "No saving throw needed here, just take the hug.",
  "Every campaign has a slow chapter. This is yours, and that's okay.",
  "You don't have to roll for initiative on the hard days.",
  "The party's got your back, no matter your HP.",
  "Short rests count too — you don't have to be at full HP to keep going.",
  "You've got more allies in this world than you know.",
  "Even the mightiest paladin needs someone to lean on sometimes.",
  "This one's on the house — no Charisma check required.",
  "You're further into the story than you think, and it's a good one.",
  "The guild remembers you, even on your quiet days.",
  "You don't need a critical hit to be doing great.",
  "Rest here a while. The dungeon can wait.",
  "You're allowed to hand off the torch for a bit.",
  "Whatever today's encounter was, you're still standing.",
  "Small victories still go in the campaign log.",
  "You're not fighting this one alone.",
  "Take the inspiration point — you've earned it.",
  "However this chapter reads, you're the hero of it.",
];

/** A gentle, sincere hug — optionally directed at another chatter. */
export function rollHug(display: string, target?: string | null): string {
  const line = pick(HUG_LINES);
  return target
    ? `🤗 @${display} wraps @${target} in a warm hug. "${line}"`
    : `🤗 The guild wraps @${display} in a warm hug. "${line}"`;
}

// !shmash — a purely cosmetic, D&D-flavored "smash" between two chatters'
// characters. No dice, no HP, no game state — same spirit as !hug, just
// louder. main.ts resolves each side's descriptor (character race/class
// when they have one, plain username otherwise) and hands both strings to
// renderShmash below to fill into a random template.
const SHMASH_LINES: string[] = [
  "%ACTOR% winds up a haymaker and sends %TARGET% cartwheeling into the nearest wall!",
  "%ACTOR% bull-rushes %TARGET% clean off their feet and into a table of empty tankards!",
  "%ACTOR% swings low and %TARGET% goes down like a poorly built siege tower!",
  "%ACTOR% unleashes a Thunderwave that flattens %TARGET% against the tavern door!",
  "%ACTOR% grapples %TARGET% overhead and slams them down for a ruling of 'that's gotta hurt'!",
  "%ACTOR% cracks a shield square into %TARGET%, who folds like a bad hand of cards!",
  "%ACTOR% catches %TARGET% with a critical shove, sending them skidding across the flagstones!",
  "%ACTOR% drops an anvil-sized fist on %TARGET% straight out of a bar fight montage!",
  "%ACTOR% spins %TARGET% around by the collar and introduces them to the floor!",
  "%ACTOR% lands a spinning backhand that sends %TARGET% flying over the bar!",
  "%ACTOR% tackles %TARGET% through a stack of barrels like it's a heist movie!",
  "%ACTOR% delivers a textbook suplex on %TARGET% right in front of the whole guild!",
  "%ACTOR% smacks %TARGET% with the flat of a greatsword — no blood, just pride lost!",
  "%ACTOR% dropkicks %TARGET% clean off the stage mid-sentence!",
  "%ACTOR% catches %TARGET% off guard with a Booming Blade to the backside!",
  "%ACTOR% picks %TARGET% up like a sack of potatoes and yeets them into the moat!",
  "%ACTOR% clotheslines %TARGET% so hard the bards start composing a ballad about it!",
  "%ACTOR% rolls a natural 20 to bodyslam %TARGET% into next Tuesday!",
  "%ACTOR% pins %TARGET% with a full-nelson worthy of a legendary monster stat block!",
  "%ACTOR% sends %TARGET% skipping across the cobblestones like a flat stone on a pond!",
  "%ACTOR% headbutts %TARGET% so hard their initiative gets reset!",
  "%ACTOR% catapults %TARGET% out of the tavern with a well-timed Eldritch Blast!",
  "%ACTOR% wraps %TARGET% in a bear hug and just... squeezes until they tap out!",
];

// Comedic stand-ins when no target is given — smash something, anything.
const SHMASH_FALLBACK_TARGETS: string[] = [
  "a wandering goblin",
  "an unsuspecting mimic disguised as a chest",
  "a training dummy that had it coming",
  "a rowdy tavern patron",
  "a suspiciously talkative rat",
  "a stack of empty ale kegs",
  "the tavern's creaky front door",
  "a low-level bandit who picked the wrong fight",
  "a wild boar that wandered into camp",
  "an overconfident kobold",
  "a poorly-guarded merchant cart",
  "a haunted suit of armor",
  "a giant spider dangling from the rafters",
  "a stubborn mule blocking the road",
  "a cursed scarecrow",
  "an oversized tavern chandelier",
  "a rickety wooden bridge",
  "a skeleton that wouldn't stop rattling",
  "an angry swarm of pixies",
  "a slime that really shouldn't be touched",
  "a suit of enchanted armor gone rogue",
  "the blacksmith's anvil (bad idea)",
];

// Stand-ins for the rare "smash yourself" case, so the sentence doesn't just
// repeat the invoker's own name/character back at them.
const SHMASH_SELF_TARGETS: string[] = [
  "themselves",
  "their own reflection",
  "their own two feet",
  "their own bad luck",
  "their own dignity",
  "thin air, tripping in the process",
  "their own shadow",
  "the nearest mirror",
];

/**
 * Renders one random !shmash line. `actorDesc` and `targetDesc` are
 * pre-built descriptors (e.g. "@bob's Half-Orc Barbarian" or "@bob"); pass
 * `isSelf: true` to swap in a pronoun-friendly stand-in for the target
 * instead of repeating the actor's own descriptor, and omit `targetDesc`
 * entirely to smash a random comedic fallback target.
 */
export function renderShmash(
  actorDesc: string,
  targetDesc?: string | null,
  isSelf?: boolean,
): string {
  const target = isSelf ? pick(SHMASH_SELF_TARGETS) : targetDesc ?? pick(SHMASH_FALLBACK_TARGETS);
  const line = pick(SHMASH_LINES).replaceAll("%ACTOR%", actorDesc).replaceAll("%TARGET%", target);
  return `💥 ${line}`;
}

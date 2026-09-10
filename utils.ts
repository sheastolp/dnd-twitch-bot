// Pure helpers and small shared utilities

import type { Ability, Character } from "./types.ts";
import { abilityNames, abilityAliases, abilityFullNames, skillAbilities, knownBotAccounts } from "./data.ts";

export const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

export const modifier = (score: number) => Math.floor((score - 10) / 2);

export function rollStat() {
  const d = Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 6)).sort((a, b) => b - a);
  return d[0] + d[1] + d[2];
}

export function formatRaceName(race: string, subrace: string | null) {
  if (!subrace) return race.trim();
  const nr = race.trim().toLowerCase();
  const ns = subrace.trim().toLowerCase();
  return ns === nr || ns.endsWith(` ${nr}`) ? subrace.trim() : `${subrace.trim()} ${race.trim()}`;
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]!));
}

/** Minimal cookie parsing for the /dashboard login session — just enough to
 * read a single named cookie back out of a Request. */
export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Builds a Set-Cookie header value for the /dashboard session cookie.
 * HttpOnly + Secure + SameSite=Lax: not readable from JS, not sent on
 * cross-site requests (the main defense against a forged toggle POST), but
 * still attached on a normal top-level link/redirect from Twitch's login. */
export function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  attrs.push(maxAgeSeconds > 0 ? `Max-Age=${maxAgeSeconds}` : "Max-Age=0");
  return attrs.join("; ");
}

export function formatStatLine(c: Character) {
  return `Lv${c.level} XP ${c.xp ?? 0} | ${abilityNames
    .map((a) => `${a} ${c.scores[a]}(${modifier(c.scores[a]) >= 0 ? "+" : ""}${modifier(c.scores[a])})`)
    .join(" ")} | HP ${c.hpCurrent}/${c.hpMax} | Speed ${c.speed}ft | Prof +${c.proficiency}`;
}

export function duelNarration(stage: string) {
  const lines: Record<string, string[]> = {
    challenge: [
      "The arena gates swing open.",
      "The gauntlet has been thrown.",
      "Fate calls for a showdown.",
      "A challenge echoes through the tavern.",
      "The bards ready their instruments—this could be a good one.",
      "Steel is drawn before a word is spoken.",
      "The crowd senses blood in the air.",
      "A dare no adventurer could refuse.",
      "The dice are already whispering about this one.",
      "Someone just signed up for a legendary tale.",
      "The tavern falls silent, waiting.",
      "A rivalry is about to be settled the old-fashioned way.",
      "The DM reaches for the initiative tracker.",
      "Honor, glory, and bragging rights are on the line.",
      "The challenge horn sounds across the guild hall.",
      "Two adventurers, one arena, zero mercy.",
      "The gauntlet lands with a satisfying thud.",
      "A duel is declared, and the crowd gathers 'round.",
      "The stakes have been set—glory or the ground.",
      "Fate shuffles its deck for this one.",
    ],
    accept: [
      "The crowd roars—the duel is on.",
      "Steel meets destiny.",
      "The initiative gods have been consulted.",
      "Acceptance granted—may the bones favor the bold.",
      "The gauntlet is picked up without hesitation.",
      "Both sides square off beneath torchlight.",
      "The bard starts composing before the first swing.",
      "A nod, a grip on the hilt, and it begins.",
      "The tavern clears a space for the coming chaos.",
      "Challenge accepted—the dice are drawn.",
      "The arena gates seal shut behind them.",
      "No turning back now; the die is cast.",
      "Two hearts race to the same drumbeat.",
      "The DM smiles—always a bad sign.",
      "Weapons are drawn, and so is everyone's attention.",
      "The duel begins under a watchful moon.",
      "Fate nods its approval.",
      "The crowd chants for first blood.",
      "Initiative rolled, tension rising.",
      "The challenge is met in full.",
    ],
    decline: [
      "The challenge fades into the tavern gossip.",
      "Wisdom wins this round.",
      "The duel is postponed by fate.",
      "Discretion proves the better part of valor.",
      "The gauntlet is left lying in the dirt.",
      "A tactical retreat, disguised as good sense.",
      "The bard shrugs and writes a different song.",
      "Not every quest needs to be accepted.",
      "The crowd grumbles but respects the choice.",
      "Sometimes the wisest roll is walking away.",
      "The challenge is filed under 'maybe later.'",
      "Even heroes pick their battles.",
      "The arena stays quiet a little longer.",
      "A polite decline, sword still sheathed.",
      "The duel dissolves back into idle chatter.",
      "Better a live coward than a dead hero, some say.",
      "The gauntlet is returned, unthrown.",
      "The DM shrugs and moves the plot along.",
      "Peace prevails, for now.",
      "The tavern returns to its usual roar.",
    ],
    hit: [
      "A clean strike finds its mark.",
      "That hit had advantage from destiny.",
      "The dice have chosen violence.",
      "Steel sings true.",
      "A textbook strike, straight from the manual.",
      "The blade finds its mark without mercy.",
      "That connected with authority.",
      "A solid hit—the crowd cheers.",
      "The attack lands clean and true.",
      "Fortune favors the aim this time.",
      "The strike lands with a satisfying crunch.",
      "A well-placed hit, worthy of a bard's verse.",
      "The blow connects, no saving throw in sight.",
      "That's going straight into the campaign log.",
      "A precise, punishing hit.",
      "The attack roll clears the armor class with room to spare.",
      "Contact made—and it hurt.",
      "The strike lands like it was scripted.",
      "A hit worthy of a highlight reel.",
      "The dice roll high, and the blade follows through.",
    ],
    miss: [
      "The attack misses wide; the boots remain unharmed.",
      "The blade finds only air.",
      "The dice requested a dramatic near miss.",
      "A swing and a whiff.",
      "The attack sails past, dramatically unthreatening.",
      "Armor class wins this exchange.",
      "The strike goes wide, to the crowd's disappointment.",
      "That one's going in the blooper reel.",
      "A valiant effort, poorly aimed.",
      "The dice roll low, and the blow follows suit.",
      "The attack misses by the length of a goblin's nose.",
      "Nothing but air and bruised pride.",
      "The blade whistles past, missing entirely.",
      "A near miss, emphasis on the miss.",
      "The strike lands nowhere useful.",
      "Fortune looks away for this swing.",
      "The attack fumbles its footing.",
      "A miss so clean it's almost impressive.",
      "The blow glances off nothing at all.",
      "That roll needed a little more luck.",
    ],
    critical: [
      "A critical hit! The bards are taking notes.",
      "Natural twenty—legendary timing.",
      "The D20 of Fate has opened the vault.",
      "A critical strike worthy of legend.",
      "The crowd loses its collective mind.",
      "That's a nat 20 if there ever was one.",
      "Critical! Somewhere, a bard just found their next verse.",
      "The dice have crowned a champion—for this round.",
      "A perfect strike, straight out of a campaign highlight.",
      "The heavens themselves seem to approve of that roll.",
      "Critical hit! The dungeon master allows a dramatic pause.",
      "That roll belongs in the guild's hall of fame.",
      "A devastating critical—someone's taking damage rolls twice.",
      "The natural 20 gods have smiled upon this strike.",
      "Critical! Even the monster looks impressed.",
      "A flawless strike for the ages.",
      "The dice landed on legendary.",
      "That's the kind of hit sequels are made of.",
      "Critical success—roll for damage, roll for glory.",
      "The stars aligned for that swing.",
    ],
    defeat: [
      "A character falls, but the story continues.",
      "The HP bar has entered the underworld.",
      "A dramatic collapse worthy of the final act.",
      "Zero HP, maximum drama.",
      "The fallen adventurer earns a moment of respectful silence.",
      "Down, but the campaign marches on.",
      "A defeat worthy of its own tragic ballad.",
      "The dice were not merciful this time.",
      "The battlefield claims another combatant.",
      "A hard-fought loss, and a story for the tavern.",
      "The final blow lands, and the duel ends.",
      "Down goes the challenger—someone alert the healer.",
      "The HP counter hits zero with theatrical timing.",
      "A noble defeat, recorded in the guild log.",
      "The fight ends, one combatant left standing.",
      "The loser limps off to nurse their pride.",
      "That's a wipe—time to regroup at camp.",
      "The dice have spoken, and the answer was defeat.",
      "A fall worthy of the campaign's next flashback.",
      "The duel closes with one combatant down for the count.",
    ],
    victory: [
      "Victory belongs to the last character standing.",
      "The winner claims the tavern bragging rights.",
      "The campaign chronicle gains a new legend.",
      "Victory! The bards are already rehearsing.",
      "The guild hall erupts in cheers.",
      "A win worthy of its own chapter.",
      "The victor raises their weapon to a roaring crowd.",
      "Glory secured, one HP bar at a time.",
      "The champion stands, the dust settles.",
      "A hard-won victory, exactly the kind bards love.",
      "The dice crowned a winner tonight.",
      "Victory earned—the tavern's buying the next round.",
      "The last one standing takes the spoils.",
      "A triumphant finish worthy of the campaign log.",
      "The winner's name goes up on the guild board.",
      "Another legend added to the chronicle.",
      "The battle ends, and glory is claimed.",
      "Victory! Somewhere, a bard just got a new song idea.",
      "The champion emerges, battered but triumphant.",
      "The dust clears, and one hero remains.",
    ],
  };
  const pool = lines[stage] ?? lines.hit;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function combatStats(c: Character) {
  const ability = Math.max(c.scores.STR, c.scores.DEX);
  const mod = modifier(ability);
  return { attack: 10 + mod + c.proficiency, mod, die: 8 };
}

export function isBotAccount(username: string, userId: string, botUserId: string) {
  const normalized = username.toLowerCase();
  const configured = (Deno.env.get("BOT_USERNAMES") ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return (
    userId === botUserId ||
    knownBotAccounts.has(normalized) ||
    configured.includes(normalized) ||
    normalized.endsWith("bot")
  );
}

export function hasModeratorBadge(event: any) {
  const badges = [...(event?.badges ?? []), ...(event?.source_badges ?? [])];
  return badges.some((badge: any) => badge.set_id === "moderator" || badge.set_id === "broadcaster");
}

export type CheckKind =
  | { type: "save"; ability: Ability; label: string }
  | { type: "skill"; ability: Ability; label: string };

/**
 * Resolve chat input like "dex", "dexterity", or "stealth" to a saving-throw
 * ability or a skill (and its governing ability). Returns null for anything
 * that isn't a recognized ability/skill name (e.g. a dice expression).
 */
export function resolveCheckKind(input: string): CheckKind | null {
  const key = input.trim().toLowerCase();
  if (!key) return null;

  const ability = abilityAliases[key];
  if (ability) {
    return { type: "save", ability, label: `${abilityFullNames[ability]} Saving Throw` };
  }

  const collapsed = key.replace(/\s+/g, "");
  const skillEntry = Object.entries(skillAbilities).find(([name]) => name.replace(/\s+/g, "") === collapsed);
  if (skillEntry) {
    const [name, skillAbility] = skillEntry;
    const label = name
      .split(" ")
      .map((word, i) => (i > 0 && word === "of" ? word : word.charAt(0).toUpperCase() + word.slice(1)))
      .join(" ");
    return { type: "skill", ability: skillAbility, label: `${label} Check` };
  }

  return null;
}

export function rollDice(input = "1d20", customLabel?: string) {
  const expression = input.trim() || "1d20";
  const m = expression.match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  const n = +m[1],
    sides = +m[2],
    mod = m[3] ? +m[3] : 0;
  if (n > 100 || sides > 1000) return null;
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
  const rawTotal = rolls.reduce((a, b) => a + b, 0);
  const total = rawTotal + mod;
  const label = customLabel ?? (expression.toLowerCase() === "1d20" ? "D20 of Fate" : "Dice roll");
  const rawD20 = n === 1 && sides === 20 ? rolls[0] : null;
  const puns =
    rawD20 === 20
      ? [
          "Natural 20! The bards are already writing the song.",
          "Critical success! Even the dice wanted to be legendary.",
          "The gods have stamped this roll approved.",
          "A natural 20—today, the dungeon fears you.",
          "Fate has opened the treasure chest of victory.",
          "Nat 20! Somewhere, a DM sighs and adjusts the encounter.",
          "The dice rolled a max and immediately regretted nothing.",
          "A perfect roll, straight from the vault of legends.",
          "Natural 20—roll for damage, roll for glory.",
          "The universe itself cast Bless on this roll.",
          "That's a nat 20, framed and hung in the guild hall.",
          "Twenty out of twenty—the dice have no notes.",
          "A roll so good it should require a saving throw to believe.",
          "Natural 20! The crit fairy has visited.",
          "The d20 landed face-up and smug about it.",
          "A flawless roll worthy of its own campaign arc.",
          "Nat 20—even the monsters are taking notes.",
          "The dice rolled max and struck a pose.",
          "That's the kind of roll adventurers dream about.",
          "Natural 20! Somewhere, a bard grabs their lute.",
        ]
      : rawD20 === 1
        ? [
            "Natural 1! The floor wins this round.",
            "Critical fumble! Somewhere, a goblin just gained confidence.",
            "The dice have requested a short rest.",
            "A natural 1—excellent roleplay opportunity incoming.",
            "Fate rolled a banana peel under your boots.",
            "Nat 1—the DM is already smiling.",
            "The d20 rolled over and played dead.",
            "A critical fumble worthy of the blooper reel.",
            "That roll owes the party an apology.",
            "Natural 1! Even the mimics are laughing.",
            "The dice just cast Fumble on themselves.",
            "A one, a shrug, and a very awkward silence.",
            "The floor has never looked so inviting.",
            "Nat 1—time to check the fumble table.",
            "That's going straight into the tavern's blooper reel.",
            "The d20 chose chaos, and chaos chose you.",
            "A critical whiff for the ages.",
            "Natural 1! The goblins are taking notes for once.",
            "The dice tripped over their own pips.",
            "That roll just volunteered for a plot twist.",
          ]
        : total >= 17
          ? [
              "That roll arrived wearing a hero's cape.",
              "The adventure is leaning dramatically in your favor.",
              "Even the dungeon master raised an eyebrow at that one.",
              "A mighty swing of the fate hammer.",
              "The prophecy is looking unusually promising.",
              "That's a roll worth bragging about at camp.",
              "The dice are clearly rooting for you tonight.",
              "A strong roll, straight out of a highlight reel.",
              "Fortune favors the bold, and apparently you too.",
              "The stars aligned nicely for that one.",
              "That roll deserves its own toast at the tavern.",
              "A hearty result—the bards approve.",
              "The dice rolled high and struck a heroic pose.",
              "That's the kind of roll legends are built on.",
              "A confident roll, worthy of the front lines.",
              "The dungeon's odds just got a little worse.",
              "That roll practically glows with good fortune.",
              "A strong showing—the party's counting on more of these.",
              "The dice decided to be generous today.",
              "A roll fit for a chosen one.",
            ]
          : total <= 4
            ? [
                "That roll took a wrong turn at the tavern.",
                "The dungeon master is trying very hard not to smile.",
                "Fate has assigned you a side quest.",
                "The dice are demanding better snacks.",
                "That result has strong mimic-energy.",
                "The dice rolled low and immediately apologized.",
                "That's a roll better left out of the campaign log.",
                "A rough one—even the goblins felt bad.",
                "The dice seem to be having an off night.",
                "That roll wandered off the beaten path.",
                "A humble result, character-building at best.",
                "The dungeon's odds just got a little better.",
                "That roll needs a long rest and a pep talk.",
                "Not every roll can be legendary, apparently.",
                "The dice rolled low and hid behind the DM screen.",
                "A roll destined for the blooper reel.",
                "That result has 'try again' written all over it.",
                "The prophecy did not see that one coming, unfortunately.",
                "A roll that even the party's cleric can't fix.",
                "That's the kind of roll bards leave out of the song.",
              ]
            : [
                "Fate has spoken—no rerolling destiny.",
                "The dungeon master may now pretend this was planned.",
                "That roll wandered in from a side quest.",
                "Somewhere, a bard is composing a song about this.",
                "Your modifiers are doing the heavy lifting.",
                "The goblins are taking notes.",
                "The prophecy remains open.",
                "Fate rolled over and asked for advantage.",
                "The initiative order has noticed you.",
                "A perfectly serviceable bit of adventuring.",
                "The dice have offered a plot twist.",
                "The tavern is buying the next round.",
                "The campaign continues, one roll at a time.",
                "A solidly average result—the dungeon shrugs.",
                "The dice landed right in the middle of the story.",
                "Not legendary, not disastrous—just adventuring.",
                "The DM nods and moves the story along.",
                "A roll that keeps the plot moving forward.",
                "The party's chronicler notes it and carries on.",
                "That's a roll fit for a Tuesday quest.",
              ];
  const pun = puns[Math.floor(Math.random() * puns.length)];
  return `🎲 ${label}: ${expression} → [${rolls.join(", ")}]${mod ? (mod > 0 ? `+${mod}` : mod) : ""} = ${total}. ${pun}`;
}

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

// Auto thank-you for new and renewed Twitch subscriptions — see main.ts's
// EventSub handling for "channel.subscribe" / "channel.subscription.message".
const SUB_TIER_NAMES: Record<string, string> = {
  "1000": "Tier 1",
  "2000": "Tier 2",
  "3000": "Tier 3",
  Prime: "Prime",
};

function subTierLabel(tier?: string | null): string {
  if (!tier) return "";
  const label = SUB_TIER_NAMES[tier];
  return label ? ` (${label})` : "";
}

const NEW_SUB_LINES: Array<(name: string, tier: string) => string> = [
  (name, tier) => `⚔️ @${name} has sworn fealty to the guild${tier}! Welcome to the ranks, adventurer — may your rolls be ever favorable.`,
  (name, tier) => `📜 A new name is inked into the guild roster: @${name}${tier}. The hall is a little brighter for it.`,
  (name, tier) => `🛡️ @${name} raises the guild banner for the first time${tier}. Glory and good company await.`,
  (name, tier) => `🎲 @${name} has joined the party${tier}! Grab a seat by the fire — the story's better with you in it.`,
  (name, tier) => `🏰 The gates open for a new adventurer: welcome, @${name}${tier}. Here's to the campaign ahead.`,
  (name, tier) => `✨ @${name} takes up the guild's oath${tier}. May your natural 20s find you often.`,
  (name, tier) => `🗡️ @${name} draws their blade and joins the guild${tier}. The campaign just got more interesting.`,
  (name, tier) => `🍺 @${name} bellies up to the guild tavern for the first time${tier}. First round's on the house.`,
  (name, tier) => `📯 A horn sounds as @${name} enters the guild${tier}. Adventure awaits.`,
  (name, tier) => `🌟 @${name} rolls a natural 20 on their first appearance${tier}. Welcome to the guild!`,
  (name, tier) => `🗺️ @${name} unrolls their map and joins the guild's quest${tier}. Onward!`,
  (name, tier) => `🏹 @${name} nocks an arrow and signs the guild ledger${tier}. Glad to have you.`,
  (name, tier) => `🔮 The seer foresaw this: @${name} joins the guild${tier}.`,
  (name, tier) => `🛶 @${name} arrives by longship, ready to adventure${tier}. Welcome aboard.`,
  (name, tier) => `📚 @${name} adds their name to the guild's grand tome${tier}. Let the story begin.`,
  (name, tier) => `🕯️ A candle is lit in the guild hall for @${name}${tier}. Welcome, adventurer.`,
  (name, tier) => `⚡ @${name} crashes into the guild hall like a lightning bolt${tier}. Let's see what you've got.`,
  (name, tier) => `🐉 @${name} tames the guild dragon on day one${tier}. Bold start.`,
  (name, tier) => `🎻 The bard strikes up a welcome tune for @${name}${tier}.`,
  (name, tier) => `🧭 @${name}'s compass points straight to the guild${tier}. Glad you found us.`,
];

const RESUB_LINES: Array<(name: string, months: number, tier: string) => string> = [
  (name, months, tier) => `🔥 @${name} renews their pact with the guild${tier} — ${months} month${months === 1 ? "" : "s"} strong and still adventuring.`,
  (name, months, tier) => `📖 Another chapter for @${name}${tier}: ${months} month${months === 1 ? "" : "s"} in the guild, and the story keeps going.`,
  (name, months, tier) => `🛡️ @${name} re-ups their oath to the guild${tier} — ${months} month${months === 1 ? "" : "s"} of loyalty, and counting.`,
  (name, months, tier) => `🎉 @${name} has stuck with the guild for ${months} month${months === 1 ? "" : "s"}${tier}. That's a real friendship roll, not just a lucky one.`,
  (name, months, tier) => `⚔️ ${months} month${months === 1 ? "" : "s"} deep and @${name} is still here${tier} — the guild remembers its own.`,
  (name, months, tier) => `🏰 @${name} returns to the guild hall for month ${months}${tier}. The torches burn a little brighter.`,
  (name, months, tier) => `🗡️ @${name} re-forges their bond with the guild${tier} — ${months} month${months === 1 ? "" : "s"} and counting.`,
  (name, months, tier) => `📯 The horn sounds again for @${name}${tier}, marking ${months} month${months === 1 ? "" : "s"} of loyalty.`,
  (name, months, tier) => `🌟 @${name} levels up their guild membership to month ${months}${tier}. Still adventuring strong.`,
  (name, months, tier) => `🍻 @${name} raises a mug for ${months} month${months === 1 ? "" : "s"} in the guild${tier}. Cheers to the streak.`,
  (name, months, tier) => `📖 Chapter ${months} of @${name}'s guild saga begins${tier}. The story's far from over.`,
  (name, months, tier) => `🛡️ @${name}'s loyalty holds firm at ${months} month${months === 1 ? "" : "s"}${tier} — a shield wall of dedication.`,
  (name, months, tier) => `🔥 @${name} keeps the campfire burning for month ${months}${tier}. Glad you're still here.`,
  (name, months, tier) => `🗺️ @${name} marks another ${months} month${months === 1 ? "" : "s"} on the guild map${tier}. Onward, together.`,
  (name, months, tier) => `⚔️ @${name} re-swears the oath for month ${months}${tier}. The guild salutes you.`,
  (name, months, tier) => `🎲 @${name} rolls another month of loyalty (${months} total)${tier} — no natural 1 in sight.`,
  (name, months, tier) => `🏹 @${name} keeps their aim true after ${months} month${months === 1 ? "" : "s"} with the guild${tier}.`,
  (name, months, tier) => `🕯️ Another candle lit for @${name}'s month ${months}${tier} in the guild.`,
  (name, months, tier) => `🐉 @${name} has outlasted more dragons than most after ${months} month${months === 1 ? "" : "s"}${tier}.`,
  (name, months, tier) => `📜 The guild scribe adds another entry for @${name} — ${months} month${months === 1 ? "" : "s"} strong${tier}.`,
];

/** Thank-you for a brand-new subscription (channel.subscribe). */
export function rollNewSubThankYou(displayName: string, tier?: string | null): string {
  return pick(NEW_SUB_LINES)(displayName, subTierLabel(tier));
}

/** Thank-you for a renewed/resub with a shared message (channel.subscription.message). */
export function rollResubThankYou(displayName: string, months: number, tier?: string | null): string {
  const safeMonths = Number.isFinite(months) && months > 0 ? Math.floor(months) : 1;
  return pick(RESUB_LINES)(displayName, safeMonths, subTierLabel(tier));
}

const GIFT_SUB_LINES: Array<(name: string, count: number, tier: string) => string> = [
  (name, count, tier) => `🎁 @${name} just gifted ${count} membership${count === 1 ? "" : "s"} to the guild${tier}! A round of applause for the guild's newest patron of generosity.`,
  (name, count, tier) => `💰 @${name} paid ${count} adventurer${count === 1 ? "'s" : "s'"} way into the guild${tier}. That's the kind of coin a bard writes songs about.`,
  (name, count, tier) => `✨ @${name} sponsored ${count} new guild membership${count === 1 ? "" : "s"}${tier} — true guild patronage.`,
  (name, count, tier) => `🛡️ @${name} covered the guild dues for ${count} adventurer${count === 1 ? "" : "s"}${tier}. The hall remembers acts like this.`,
  (name, count, tier) => `🏹 @${name} fires off ${count} gifted membership${count === 1 ? "" : "s"}${tier} like a volley of goodwill.`,
  (name, count, tier) => `🌟 @${name} casts Mass Generosity, hitting ${count} lucky adventurer${count === 1 ? "" : "s"}${tier}.`,
  (name, count, tier) => `🍻 @${name} buys a round of guild memberships for ${count} adventurer${count === 1 ? "" : "s"}${tier}. Cheers all around!`,
  (name, count, tier) => `📯 @${name} sounds the horn of generosity, gifting ${count} membership${count === 1 ? "" : "s"}${tier}.`,
  (name, count, tier) => `🗝️ @${name} unlocks the guild gates for ${count} new adventurer${count === 1 ? "" : "s"}${tier}.`,
  (name, count, tier) => `🎁 @${name}'s Bag of Holding turns out to be full of gifted membership${count === 1 ? "" : "s"} (${count})${tier}.`,
  (name, count, tier) => `🐉 @${name} raids their own hoard to gift ${count} membership${count === 1 ? "" : "s"}${tier}. Legendary generosity.`,
  (name, count, tier) => `🛡️ @${name} shields ${count} adventurer${count === 1 ? "" : "s"} with a gifted membership${count === 1 ? "" : "s"}${tier}.`,
  (name, count, tier) => `📜 @${name}'s name goes down in the guild's Book of Generous Deeds for ${count} gift${count === 1 ? "" : "s"}${tier}.`,
  (name, count, tier) => `✨ @${name} sprinkles ${count} membership${count === 1 ? "" : "s"} across the guild like a Bless spell${tier}.`,
  (name, count, tier) => `🏰 @${name} throws open the guild doors for ${count} new adventurer${count === 1 ? "" : "s"}${tier}.`,
  (name, count, tier) => `🍀 @${name} shares their luck with ${count} fellow adventurer${count === 1 ? "" : "s"}${tier}.`,
  (name, count, tier) => `🔥 @${name} lights the way for ${count} new guild member${count === 1 ? "" : "s"}${tier}.`,
  (name, count, tier) => `🎻 The bards write a tune about @${name}'s ${count}-membership gift${count === 1 ? "" : "s"}${tier}.`,
  (name, count, tier) => `🗺️ @${name} charts a path into the guild for ${count} adventurer${count === 1 ? "" : "s"}${tier}.`,
  (name, count, tier) => `⚔️ @${name} arms ${count} new adventurer${count === 1 ? "" : "s"} with a guild membership${tier}. Well met!`,
];

const ANON_GIFT_SUB_LINES: Array<(count: number, tier: string) => string> = [
  (count, tier) => `🎁 A mysterious benefactor just gifted ${count} membership${count === 1 ? "" : "s"} to the guild${tier}, no name given. The guild thanks you all the same.`,
  (count, tier) => `💰 An anonymous patron paid the guild dues for ${count} adventurer${count === 1 ? "" : "s"}${tier}. Whoever you are — well met.`,
  (count, tier) => `🕶️ A hooded figure gifts ${count} membership${count === 1 ? "" : "s"}${tier} and vanishes into the crowd.`,
  (count, tier) => `🧙 An unseen wizard casts a gift of ${count} membership${count === 1 ? "" : "s"}${tier} and disappears in a puff of smoke.`,
  (count, tier) => `🌙 Under cover of night, someone gifts ${count} membership${count === 1 ? "" : "s"}${tier}. The guild bows to the shadows.`,
  (count, tier) => `🎭 A masked benefactor leaves ${count} gifted membership${count === 1 ? "" : "s"}${tier} at the guild door.`,
  (count, tier) => `🐦 A raven delivers ${count} gifted membership${count === 1 ? "" : "s"}${tier}, sender unknown.`,
  (count, tier) => `✨ A flash of unseen magic grants ${count} membership${count === 1 ? "" : "s"}${tier}. No name, just generosity.`,
  (count, tier) => `🗝️ Someone slips ${count} membership key${count === 1 ? "" : "s"}${tier} under the guild door and disappears.`,
  (count, tier) => `🕵️ A rogue in the shadows gifts ${count} membership${count === 1 ? "" : "s"}${tier} without leaving a trace.`,
  (count, tier) => `📜 An unsigned scroll grants ${count} adventurer${count === 1 ? "" : "s"} guild membership${tier}.`,
  (count, tier) => `🌫️ A mist rolls through the guild hall, leaving behind ${count} gifted membership${count === 1 ? "" : "s"}${tier}.`,
  (count, tier) => `🦉 A familiar drops off ${count} gifted membership${count === 1 ? "" : "s"}${tier} and flies away.`,
  (count, tier) => `🕯️ A single candle burns beside ${count} anonymous gift${count === 1 ? "" : "s"}${tier}. No name attached.`,
  (count, tier) => `🎁 ${count} membership${count === 1 ? "" : "s"}${tier} appear, gift-wrapped, with no card in sight.`,
  (count, tier) => `🐉 A hoard's worth of generosity funds ${count} membership${count === 1 ? "" : "s"}${tier}, courtesy of persons unknown.`,
  (count, tier) => `🌟 A shooting star grants ${count} membership${count === 1 ? "" : "s"}${tier} — anonymously, as shooting stars do.`,
  (count, tier) => `🛡️ An unnamed champion shields ${count} adventurer${count === 1 ? "" : "s"} with a gifted membership${tier}.`,
  (count, tier) => `🗿 An ancient statue seems to wink as ${count} gifted membership${count === 1 ? "" : "s"}${tier} appear.`,
  (count, tier) => `🍀 Fortune smiles, unnamed, granting ${count} membership${count === 1 ? "" : "s"}${tier}.`,
];

const GIFTED_WELCOME_LINES: Array<(name: string, tier: string) => string> = [
  (name, tier) => `🎁 @${name} joins the guild courtesy of a fellow adventurer's generosity${tier}. Welcome to the ranks — your gear's already paid for.`,
  (name, tier) => `⚔️ @${name} has been sponsored into the guild${tier}! Someone believed you belonged here — now go prove them right.`,
  (name, tier) => `📜 @${name}'s name goes on the roster, gifted by a guildmate${tier}. Welcome aboard.`,
  (name, tier) => `🎁 @${name} unwraps a guild membership${tier} they didn't even have to earn. Lucky adventurer.`,
  (name, tier) => `🛡️ @${name} enters the guild shielded by someone else's generosity${tier}. Make it count.`,
  (name, tier) => `🌟 @${name} arrives with a gifted membership in hand${tier} — someone believes in you.`,
  (name, tier) => `🍀 @${name}'s luck just leveled up with a gifted guild spot${tier}.`,
  (name, tier) => `🗺️ @${name} starts their journey with the guild, courtesy of a generous ally${tier}.`,
  (name, tier) => `🏰 The gates open for @${name}, gifted entry and all${tier}. Welcome home.`,
  (name, tier) => `🎻 A tune plays as @${name} steps in on someone else's coin${tier}. Enjoy the show.`,
  (name, tier) => `🕯️ A candle is lit for @${name}'s gifted arrival${tier}. Welcome to the guild.`,
  (name, tier) => `📯 The horn sounds for @${name}, sponsored into the ranks${tier}.`,
  (name, tier) => `🐉 @${name} rides in on someone else's generosity${tier}, dragon-scale luck included.`,
  (name, tier) => `⚔️ @${name} joins the ranks, gear paid for, glory still to be earned${tier}.`,
  (name, tier) => `🔥 @${name}'s guild membership was lit by another's kindness${tier}. Pass it on.`,
  (name, tier) => `🧙 A wizard's generosity conjures @${name} straight into the guild${tier}.`,
  (name, tier) => `🏹 @${name} joins the ranks, quiver full and dues already paid${tier}.`,
  (name, tier) => `📖 A new chapter opens for @${name}, gifted by a fellow adventurer${tier}.`,
  (name, tier) => `🎲 @${name} rolls into the guild on someone else's natural 20 of kindness${tier}.`,
  (name, tier) => `🌙 Under the guild's banner, @${name} arrives — gifted, welcomed, ready${tier}.`,
];

/** Thank-you for a gift-sub batch (channel.subscription.gift). Pass name=null for anonymous gifts. */
export function rollGiftSubThankYou(gifterName: string | null, count: number, tier?: string | null): string {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  return gifterName
    ? pick(GIFT_SUB_LINES)(gifterName, safeCount, subTierLabel(tier))
    : pick(ANON_GIFT_SUB_LINES)(safeCount, subTierLabel(tier));
}

/** Welcome for the recipient of a gifted sub (channel.subscribe with is_gift=true). */
export function rollGiftedSubWelcome(recipientName: string, tier?: string | null): string {
  return pick(GIFTED_WELCOME_LINES)(recipientName, subTierLabel(tier));
}

// Auto thank-you for incoming raids (channel.raid) — see main.ts's EventSub
// handling. "party" is a pre-formatted phrase (e.g. "12 adventurers") so
// each line can drop it in without every line re-deriving pluralization.
function raidPartyPhrase(viewers: number): string {
  const safe = Number.isFinite(viewers) && viewers > 0 ? Math.floor(viewers) : 0;
  return safe > 0 ? `${safe} adventurer${safe === 1 ? "" : "s"}` : "a band of fellow adventurers";
}

const RAID_LINES: Array<(name: string, party: string) => string> = [
  (name, party) => `🐺 @${name} leads a raiding party of ${party} into the guild hall! Welcome, raiders — grab a seat by the fire.`,
  (name, party) => `⚔️ @${name} crests the hill with ${party} at their back! The guild throws open its gates.`,
  (name, party) => `📯 A horn sounds — @${name} arrives with ${party}, ready to join the campaign.`,
  (name, party) => `🛡️ @${name} marches ${party} straight into the guild hall. Reinforcements have arrived!`,
  (name, party) => `🏰 The gates swing wide for @${name} and ${party} riding in behind them.`,
  (name, party) => `🎲 @${name} rolls in with ${party} — a natural 20 for guild morale.`,
  (name, party) => `🗺️ @${name} charts a course straight to the guild, bringing ${party} along for the ride.`,
  (name, party) => `🔥 The campfire grows bigger — @${name} and ${party} have joined the circle.`,
  (name, party) => `🐉 @${name} arrives like a dragon's hoard of goodwill, bringing ${party} with them.`,
  (name, party) => `🍻 @${name} and ${party} storm the tavern doors. First round's on the house!`,
  (name, party) => `📜 The guild scribe adds a new entry: @${name} raids in with ${party} at their side.`,
  (name, party) => `🌟 @${name} lights up the guild hall, ${party} in tow. Welcome, everyone!`,
  (name, party) => `🧭 @${name}'s compass points true — ${party} follow them straight into the guild.`,
  (name, party) => `🏹 @${name} leads ${party} over the ridge and into the guild's welcoming arms.`,
  (name, party) => `⚡ @${name} crashes the guild hall with ${party} — what an entrance!`,
  (name, party) => `🎻 The bards strike up a welcome tune for @${name} and the ${party} riding with them.`,
  (name, party) => `🛶 @${name} sails in with ${party}, ready to dock at the guild hall.`,
  (name, party) => `🕯️ New torches are lit for @${name} and ${party} joining the hall.`,
  (name, party) => `🌙 Under a banner held high, @${name} rides in with ${party}.`,
  (name, party) => `🐎 @${name} gallops in at the head of ${party}. The guild welcomes every one of you.`,
];

/** Thank-you for an incoming raid (channel.raid). */
export function rollRaidThankYou(raiderName: string, viewers: number): string {
  return pick(RAID_LINES)(raiderName, raidPartyPhrase(viewers));
}

// Matches "goodnight"-style chat messages so the bot can send off adventurers
// for the night. Word-boundary-wrapped (not anchored to the start), so it
// fires anywhere in the message — e.g. "ok chat, gnight!" or "that's it for
// me, good night everyone" — while still avoiding false hits inside unrelated
// words like "midnight", "tonight", "nightmare", or "knight".
const NIGHT = "(?:n(?:ight|ite))";
const GOODNIGHT_REGEX = new RegExp(
  `\\b(?:gn+|g['’]?n?${NIGHT}|good\\s*${NIGHT}|nighty\\s*${NIGHT}|${NIGHT}\\s*${NIGHT}|sleep\\s*tight)\\b`,
  "i",
);

export function isGoodnightMessage(message: string): boolean {
  return GOODNIGHT_REGEX.test(message.trim());
}

const GOODNIGHT_REPLIES = [
  (n: string) => `Rest well, @${n}! 🌙 May your dreams be free of goblins.`,
  (n: string) => `Goodnight, @${n}! The guild hall banks its fires — safe travels to the Land of Nod. 💤`,
  (n: string) => `Sleep tight, @${n}! A long rest restores HP *and* spell slots. 🛌`,
  (n: string) => `Farewell for now, @${n}! May you wake with advantage on tomorrow's rolls. ✨`,
  (n: string) => `🌜 Sweet dreams, @${n}! May no owlbear disturb your rest.`,
  (n: string) => `🛏️ Off to bed, @${n}? Even legends need their eight hours.`,
  (n: string) => `🌙 Goodnight, @${n}! The watch is set — sleep easy.`,
  (n: string) => `💤 Long rest initiated for @${n}. See you after the next dawn.`,
  (n: string) => `✨ Sleep well, @${n} — may your dreams roll nothing but natural 20s.`,
  (n: string) => `🏕️ Camp's set, @${n}. Rest up for tomorrow's adventure.`,
  (n: string) => `🌌 The stars watch over you tonight, @${n}. Goodnight!`,
  (n: string) => `🦉 The owls take the next watch, @${n}. Rest easy.`,
  (n: string) => `🕯️ The torches dim for the night, @${n}. Sleep well.`,
  (n: string) => `🐉 Even dragons need their sleep, @${n}. Goodnight!`,
  (n: string) => `📖 The chronicle pauses here, @${n}. Same time next session?`,
  (n: string) => `🛡️ Shields down, @${n} — time to rest.`,
  (n: string) => `🌠 May a shooting star bless your dreams, @${n}. Goodnight!`,
  (n: string) => `🍃 The wind carries you off to sleep, @${n}. Rest well.`,
  (n: string) => `🧝 Even the elves need their trance sometimes, @${n}. Goodnight!`,
  (n: string) => `🌒 Until next session, @${n}. Sleep tight, adventurer.`,
];

export function goodnightReply(display: string): string {
  const pick = GOODNIGHT_REPLIES[Math.floor(Math.random() * GOODNIGHT_REPLIES.length)];
  return pick(display);
}

export function compactText(value: unknown, max = 240) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/<[^>]+>/g, "")
    .trim()
    .slice(0, max);
}

export function splitChatMessage(text: string, max = 300) {
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf(" ", max);
    if (cut < 1) cut = max;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function firstAlive(members: string[], hp: Record<string, number>) {
  return members.findIndex((name) => Number(hp[name]) > 0);
}

export function logRowText(r: any) {
  return `${new Date(Number(r.created_at)).toISOString()} | @${r.username} | ${r.action} | ${r.detail}`;
}

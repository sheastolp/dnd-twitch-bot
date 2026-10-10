// The peddler is untouchable. Any attempt to attack, rob, mug, stab or
// shoplift from the open-stall merchant (merchant.ts / haggle.ts) fails —
// always, automatically, no dice — and the would-be assailant is mocked in
// chat for trying. Nothing is spent: no coin, no haggle attempt, no rob
// cooldown.
//
// Caught here, before anything else runs:
//   !haggle <pitch that threatens/attacks/robs the peddler>
//   !rob peddler | !rob merchant | !rob stall | !rob @<current peddler's name>
//   !stall rob | !stall attack | !stall steal ... (any !stall <violence>)
//   !dndduel peddler | !dndduel monster merchant ...
//   !attack / !steal / !mug / !shoplift ... aimed at the peddler/stall
// The haggle system prompt also tells the LLM to treat anything this misses
// the same way (NO DEAL + mockery), so a creative phrasing still gets nothing.

import { getMerchantListing, isMerchantEnabled } from "./db.ts";
import { sendChatMessages } from "./twitch.ts";

/** Words that point at the peddler or their stall/wares. */
const PEDDLER_WORDS = /\b(peddl[ae]rs?|merchants?|stalls?|shop(?:keep(?:er)?)?s?|vendors?|trader|hawker|wares?|stock|till|cash\s*box|coin\s*purse|apron)\b/i;

/** Words that mean violence, theft or intimidation. */
const ASSAULT_WORDS = new RegExp(
  "\\b(" + [
    "attack(?:s|ed|ing)?", "assault(?:s|ed|ing)?", "ambush(?:es|ed|ing)?",
    "rob(?:s|bed|bing)?", "mug(?:s|ged|ging)?", "steal(?:s|ing)?", "stole", "swipe[sd]?",
    "shoplift(?:s|ed|ing)?", "pickpocket(?:s|ed|ing)?", "pilfer(?:s|ed|ing)?", "plunder(?:s|ed|ing)?",
    "snatch(?:es|ed|ing)?", "grab(?:s|bed|bing)? (?:it and run|and run|the (?:till|purse|coins?|cash ?box|goods)|(?:his|her|their|your) (?:purse|coins?|till|wares?|goods))", "five[- ]finger discount",
    "stab(?:s|bed|bing)?", "slash(?:es|ed|ing)? (?:at|you|him|her|them|the (?:peddl[ae]r|merchant|stall|awning))", "punch(?:es|ed|ing)?", "smack(?:s|ed)?", "slap(?:s|ped)?",
    "shoot(?:s|ing)? (?:you|him|her|them|at|an? (?:arrow|bolt|crossbow))", "kill(?:s|ed|ing)?", "murder(?:s|ed|ing)?", "slay(?:s|ing)?", "behead(?:s|ed)?",
    "fireball(?:s|ed)?", "eldritch blast", "magic missile", "sneak attack", "smite[sd]?", "cast (?:fireball|hold person|sleep)",
    "strangle[sd]?", "choke[sd]?", "tackle[sd]?", "knock(?:s|ed)? (?:out|him|her|them)", "beat(?:s|ing)? (?:up|him|her|them)",
    "threaten(?:s|ed|ing)?", "intimidat(?:e|es|ed|ing|ion)", "hold (?:him|her|them|you) up", "stick ?up", "hands up",
    "your money or your life", "or (?:i|we)(?:'ll| will)? (?:kill|stab|hurt|burn|end)",
    "draw(?:s)? (?:my|a) (?:sword|dagger|blade|knife|bow|weapon)", "pull(?:s)? (?:a|my) (?:knife|dagger|sword|blade|weapon)",
    "at (?:sword|knife|dagger|blade)point", "burn (?:down|it|the)", "torch(?:es|ed)? the", "set fire",
  ].join("|") + ")\\b",
  "i",
);

/** Duel/rob/attack target words that can only mean the peddler. */
const PEDDLER_TARGET = /^@?(?:the\s+)?(peddl[ae]r|merchant|stall|shop(?:keep(?:er)?)?|vendor|trader|hawker|market)s?$/i;

/** True if a haggle pitch (or any free text) is an attack on, a threat
 * against, or a theft from the peddler. "five copper is robbery" is a pitch,
 * not a mugging, so bare figures of speech about price are let through. */
export function isAssaultOnPeddler(text: string): boolean {
  const t = text.toLowerCase();
  // Price grumbles: "that's robbery", "daylight robbery", "highway robbery",
  // "you're robbing me", "is a steal" — banter, not an attack.
  const cleaned = t
    .replace(/\b(?:is|that'?s|it'?s|this is|what|pure|daylight|highway|absolute|outright)\s+(?:an?\s+)?(?:robbery|theft|a steal|murder|criminal|highway robbery|daylight robbery)\b/g, " ")
    .replace(/\byou(?:'re| are) (?:robbing|killing|murdering|stealing from) me\b/g, " ")
    .replace(/\b(?:a|what a) steal\b/g, " ")
    .replace(/\bkill(?:ing)? (?:it|me)\b/g, " ")
    // "I'd kill for that", "steal of a deal", "let me steal it for 5 cp".
    .replace(/\b(?:i'?d|i would|would) kill for\b/g, " ")
    .replace(/\bsteal (?:of a deal|(?:it |this |that )?(?:for|at)\b)/g, " ");
  return ASSAULT_WORDS.test(cleaned);
}

/** True if a bare command target ("peddler", "@merchant", the current
 * peddler's full name) means the peddler. */
export function isPeddlerTarget(target: string, merchantName: string | null): boolean {
  const t = target.trim().replace(/^@/, "").toLowerCase();
  if (!t) return false;
  if (PEDDLER_TARGET.test(t)) return true;
  if (!merchantName) return false;
  const name = merchantName.toLowerCase();
  const squashed = name.replace(/[^a-z0-9]+/g, "");
  return t === squashed || t === name.replace(/\s+/g, "_");
}

const MOCKERY: Array<(who: string, peddler: string) => string> = [
  (who, p) => `@${who} lunges at ${p} — and trips over a crate of turnips. ${p} sells the turnip that tripped you back to you for 2 cp. Humiliating.`,
  (who, p) => `@${who} tries to rob ${p}. ${p} sighs, pats your head, and slips a "Kick Me" sign onto your back. You never even felt it. The square is laughing.`,
  (who, p) => `@${who} draws a weapon on ${p}. Nat 1. You drop it, it bounces, and ${p} catches it and hangs a price tag on it: "Slightly used, owner fled crying."`,
  (who, p) => `@${who} grabs for the goods. ${p} has survived forty years of goblins, taxmen and in-laws — you are bonked with a ladle and placed gently in a barrel.`,
  (who, p) => `@${who} reaches for the till. The till bites. Yes, the till. ${p}: "Mimic. Best security I ever bought. Very reasonable rates, actually."`,
  (who, p) => `@${who} tries a stick-up. ${p}'s pet goose has entered the chat. Witnesses describe the following ninety seconds as "a war crime" and "deserved."`,
  (who, p) => `@${who} cracks their knuckles menacingly at ${p}. Something pops. You spend the rest of the scene crying and ${p} sells you a splint.`,
  (who, p) => `@${who} casts Fireball at the stall. It fizzles into a sad little sparkler. ${p} roasts a marshmallow on it and says "thanks, mate."`,
  (who, p) => `@${who} sneaks up on ${p} with a Stealth roll of 3. You were wearing bells. Why were you wearing bells. ${p} now sells "Robber's Bells, as seen on @${who}."`,
  (who, p) => `@${who} demands ${p}'s money or their life. ${p} hands over their purse: one button, a moth and an IOU. The moth flies up your nose. You flee.`,
  (who, p) => `@${who} swings at ${p} and hits the stall's support pole. The awning folds over you like a taco. ${p} charges admission to see "the Market Burrito."`,
  (who, p) => `@${who} tries to shoplift from ${p} and somehow walks off with less coin than they came with. Nobody, including you, understands how.`,
  (who, p) => `@${who} attacks ${p}! The guild watch, the town guard, three nuns and a passing dragon all turn to stare. You pretend you were stretching. Nobody buys it.`,
  (who, p) => `@${who} tries to mug ${p}. ${p}: "Mate, I've been robbed by better. I've been robbed by a SQUIRREL. Better than you." The squirrel nods from the awning.`,
  (who, p) => `@${who} reaches for a dagger. ${p} was already holding it, polishing it, and has a price tag on it. "Ooh, interested in this one?"`,
  (who, p) => `@${who} rolls initiative against ${p}. You rolled a 2. ${p} didn't even roll — just sighed, and that was enough. You lose your turn, and your dignity.`,
  (who, p) => `@${who} tries to swipe a ware. Your hand is now stuck in a jar labeled "Stupid Prize." ${p} charges 1 cp to remove it, 2 cp to stop telling everyone.`,
  (who, p) => `@${who} threatens ${p}, who laughs so hard they have to sit down. Then they tell the whole market. Your new nickname is "Cutpurse-in-Training."`,
];

/** One random line mocking `who` for trying it on the peddler. */
export function peddlerMockery(who: string, peddler: string, rng: () => number = Math.random): string {
  const line = MOCKERY[Math.floor(rng() * MOCKERY.length)](who, peddler);
  return `🛡️ ${line}`;
}

/** Names the peddler: the one hawking now, or a stand-in when the stall is
 * closed (attacking an empty stall is still embarrassing). */
async function currentPeddler(broadcasterId: string): Promise<string> {
  try {
    if (!(await isMerchantEnabled(broadcasterId))) return "the old peddler";
    return (await getMerchantListing(broadcasterId))?.merchantName ?? "the old peddler";
  } catch {
    return "the old peddler";
  }
}

/** Sends the mockery for an attempted assault/robbery of the peddler. */
export async function mockPeddlerAssailant(display: string, broadcasterId: string, peddler?: string): Promise<void> {
  await sendChatMessages(peddlerMockery(display, peddler ?? (await currentPeddler(broadcasterId))), broadcasterId);
}

/** Catches peddler assaults that come in through commands other than
 * !haggle: !rob peddler, !stall rob, !dndduel peddler, !attack peddler, ...
 * Returns true (and mocks the chatter) if the message was one. */
export async function handlePeddlerAssault(
  chatMessage: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const msg = chatMessage.trim();
  const m = msg.match(/^!(\w+)(?:\s+([\s\S]*))?$/);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] ?? "").trim();

  // !stall <anything violent> — "!stall rob", "!stall attack", "!stall steal the sword".
  if (cmd === "stall") {
    if (!rest || !isAssaultOnPeddler(rest)) return false;
    await mockPeddlerAssailant(display, broadcasterId);
    return true;
  }

  // Commands whose first argument is a target.
  const targeted = ["rob", "dndduel", "attack", "steal", "mug", "stab", "shoplift", "pickpocket", "loot", "kill", "fight", "hit", "punch", "kick"];
  if (!targeted.includes(cmd) || !rest) return false;
  let args = rest;
  if (cmd === "dndduel") args = args.replace(/^(?:monster\s+)?(?:classic\s+)?/i, "");
  // "!rob @someone" / "!dndduel @someone" is always a real viewer, even one
  // who happens to be called @merchant — only bare words mean the peddler.
  if ((cmd === "rob" || cmd === "dndduel") && args.startsWith("@")) return false;
  const firstWord = args.split(/\s+/)[0];
  const listing = PEDDLER_TARGET.test(firstWord) ? null : await safeListing(broadcasterId);
  const name = listing?.merchantName ?? null;
  const lowerArgs = args.replace(/^@/, "").toLowerCase();
  const hitsName = name !== null && (lowerArgs === name.toLowerCase() || lowerArgs.startsWith(name.toLowerCase() + " "));
  if (!isPeddlerTarget(firstWord, name) && !hitsName && !(cmd !== "dndduel" && cmd !== "rob" && PEDDLER_WORDS.test(args))) return false;
  await mockPeddlerAssailant(display, broadcasterId, name ?? undefined);
  return true;
}

async function safeListing(broadcasterId: string) {
  try {
    if (!(await isMerchantEnabled(broadcasterId))) return null;
    return await getMerchantListing(broadcasterId);
  } catch {
    return null;
  }
}

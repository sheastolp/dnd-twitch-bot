// The open-stall merchant — a threadbare traveling peddler who periodically
// sets up shop in the market square and hawks a random, humble bit of
// D&D-flavored goods. Off by default per channel; toggled with !market.
//
// Posting is driven by merchant.cron.ts, which polls merchant_settings for
// channels that are due (see db.ts's getDueMerchantChannels). Interval
// randomization lives here so both the toggle command (first post) and the
// cron (every post after) reschedule the same way.

import { isMerchantEnabled, setMerchantEnabled } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";
import { pick } from "./utils.ts";

const MIN_INTERVAL_MINUTES = Math.max(5, Number(Deno.env.get("MERCHANT_MIN_INTERVAL_MINUTES") ?? "25"));
const MAX_INTERVAL_MINUTES = Math.max(MIN_INTERVAL_MINUTES, Number(Deno.env.get("MERCHANT_MAX_INTERVAL_MINUTES") ?? "60"));

/** Chance (0-1) that a roll turns up a rare legendary relic instead of the usual
 * junk. Override with MERCHANT_LEGENDARY_CHANCE; 0 disables relics entirely. */
const LEGENDARY_CHANCE = Math.min(1, Math.max(0, Number(Deno.env.get("MERCHANT_LEGENDARY_CHANCE") ?? "0.08")));

/** A fresh randomized gap (ms) until the merchant's next ad, per channel. */
export function randomMerchantIntervalMs(): number {
  const minMs = MIN_INTERVAL_MINUTES * 60_000;
  const maxMs = MAX_INTERVAL_MINUTES * 60_000;
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

// A different threadbare peddler each time — this is a traveling open stall,
// not a single recurring shopkeeper.
const MERCHANT_NAMES: string[] = [
  "Wobble",
  "Pruneface Yorik",
  "Tansy Ninefingers",
  "Bregga Stumpteeth",
  "Old Corrin",
  "Widow Hesk",
  "Tam Pockets",
  "Fenwick Loose-Coin",
  "Marda the Reformed Cutpurse",
  "Grithnall the Threadbare",
  "Squint",
  "Nan Gullyfoot",
  "Ossop the Unlucky",
  "Beren Halfcoat",
  "Ivy Scraptongue",
  "Doras Milkbeard",
  "Kettle",
  "Ruel Tinkpocket",
  "Sella Windrags",
  "Podge Ashborn",
  "Uther Nine-Debts",
];

// Scene-setting openers. Each is a function of the merchant's name so the
// same line never reads twice the same way in a row.
const MERCHANT_INTROS: Array<(name: string) => string> = [
  (name) => `${name} unrolls a threadbare blanket in the market square and calls out to passersby.`,
  (name) => `A modest stall creaks open as ${name} arranges a few sorry-looking wares.`,
  (name) => `${name} waves down the crowd from behind an upturned crate.`,
  (name) => `From a stall held together with string and hope, ${name} shouts over the market din.`,
  (name) => `${name} counts the coins in an otherwise empty pouch, then brightens as adventurers pass by.`,
  (name) => `A patched tarp flaps over ${name}'s corner of the market — business as usual.`,
  (name) => `${name} dusts off the one good item on the table and grins hopefully.`,
  (name) => `The market square gains one more voice as ${name} sets up shop between the baker and the tanner.`,
  (name) => `${name} leans on a wobbly table and clears their throat for the day's pitch.`,
  (name) => `A hand-lettered sign reading "HONEST GOODS (MOSTLY)" hangs crooked over ${name}'s stall.`,
  (name) => `${name} nudges a stray chicken off the merchandise before the crowd arrives.`,
  (name) => `Between two grander stalls, ${name} makes do with a barrel and a prayer.`,
  (name) => `${name} rings a cracked bell to announce the stall is, once again, open for business.`,
  (name) => `A patched umbrella shades ${name}'s wares from the midday sun — most of them, anyway.`,
  (name) => `${name} straightens a lopsided display and calls out with practiced optimism.`,
  (name) => `Coins jingle — just one or two — in ${name}'s apron as the stall opens.`,
  (name) => `${name} has set up shop again, same corner, same crate, same hopeful smile.`,
  (name) => `A modest banner (really just a dyed sack) marks ${name}'s stall in the square.`,
  (name) => `${name} waves an adventurer over before the competition can.`,
  (name) => `The smell of yesterday's stew clings to ${name}'s stall as the day's goods go on display.`,
  (name) => `${name} arranges the wares by "most impressive" first, "please just buy something" last.`,
];

interface MerchantItem {
  desc: string;
  price: string;
}

// Cheap, secondhand, unmistakably D&D-flavored goods — nothing a wealthy
// merchant would bother stocking.
const MERCHANT_ITEMS: MerchantItem[] = [
  { desc: "a dented tin flask that swears it once held dragon's-breath brandy", price: "3 copper" },
  { desc: "a bundle of chalk sticks for warding sigils, mostly unbroken", price: "2 copper" },
  { desc: "one (1) lucky rabbit's foot, still faintly twitching", price: "5 copper" },
  { desc: "a cracked scrying mirror that only ever shows yesterday", price: "1 silver" },
  { desc: "a moth-eaten cloak that almost passes for 'mysterious'", price: "4 copper" },
  { desc: "a coil of rope, guaranteed to hold at least one goblin", price: "6 copper" },
  { desc: "a jar of pickled owlbear whiskers (for luck, allegedly)", price: "8 copper" },
  { desc: "a half-melted candle that burns a suspicious shade of blue", price: "1 copper" },
  { desc: "a set of loaded dice, badly loaded — they just roll off the table", price: "2 copper" },
  { desc: "a rusty holy symbol of a god nobody quite remembers anymore", price: "3 copper" },
  { desc: "a whittled wooden dagger, purely for show — please don't stab anyone", price: "1 copper" },
  { desc: "a satchel of trail rations that are 'mostly' still rations", price: "5 copper" },
  { desc: "a single boot, left foot, very fine make", price: "2 copper" },
  { desc: "a vial of river water that 'might' be enchanted", price: "4 copper" },
  { desc: "a scorched spellbook page with half a fireball recipe on it", price: "7 copper" },
  { desc: "a tarnished brass compass that always points toward the nearest tavern", price: "3 copper" },
  { desc: "a sack of glass beads, sold in good faith as 'gnomish gemstones'", price: "6 copper" },
  { desc: "a patchwork healer's kit missing only the important bits", price: "9 copper" },
  { desc: "a caged cricket claimed to grant wishes if fed enough", price: "2 copper" },
  { desc: "a hand-me-down shield, already dented — someone else did the work for you", price: "1 silver 2 copper" },
  { desc: "a coil of faintly glowing string, source unknown, no refunds", price: "5 copper" },
  { desc: "a stack of 'authentic' dragon scales (dyed lizard, don't tell anyone)", price: "4 copper" },
];

// Self-deprecating, humble-peddler closing lines — the merchant is not
// wealthy, and knows it.
const MERCHANT_CLOSERS: string[] = [
  "Barely a profit in it, but a sale's a sale.",
  "Haggle if you must — there's a family of stirges to feed.",
  "No refunds. No guarantees. Mostly no regrets.",
  "Buy two and get a compliment thrown in, free of charge.",
  "It's not much, but it's honest work. Mostly.",
  "Coin now, questions later.",
  "Would charge more if anyone actually thought it was worth more.",
  "Every copper helps keep this stall standing another day.",
  "Guaranteed authentic, or at least authentically old.",
  "First to haggle gets a suspicious wink, free of charge.",
  "Trade accepted. Chickens, mostly.",
  "Sold worse for more before, so this one's a bargain, really.",
  "Buyer beware, seller broke.",
  "One copper off if you laugh at the jokes.",
  "The stall roof leaks, but the prices don't.",
  "Not much to look at, but neither is the merchant, and they get by.",
  "Consider it an investment in someone else's bad decisions.",
  "Happy to wrap it, if old newspaper doesn't offend.",
  "Money's money, even when it's mostly copper.",
  "Step lively — the town guard doesn't love where this cart is parked.",
  "A deal like this doesn't come around twice. Mostly because there was only one.",
  "Not a fortune to be made here, just enough for supper.",
];

// Rare, mostly-forgotten legendary relics. The peddler found them in a
// bottomless sack and has no idea what they are, so they're priced like
// curiosities — a steal for anyone who recognizes them. Prices stay in plain
// "<n> gold" form so coins.ts's parseFirstPrice (and !haggle) can read them.
const LEGENDARY_ITEMS: MerchantItem[] = [
  { desc: "the Apparatus of Kwalish, a lobster-shaped iron submersible, 'only slightly rusted shut'", price: "90 gold" },
  { desc: "an Iron Flask etched with sigils, humming faintly and rattling whenever you look away", price: "75 gold" },
  { desc: "a Cubic Gate, a small stone cube with six faces, each one a door to somewhere else", price: "120 gold" },
  { desc: "the Ring of Three Wishes — the peddler swears it has 'at least two left'", price: "150 gold" },
  { desc: "Fragarach, the Sword of Answering, which sulks in its sheath until someone lies to it", price: "110 gold" },
  { desc: "an Anstruth Harp, a bardic instrument of a lost college, still tuned to a forgotten song", price: "85 gold" },
  { desc: "a Talisman of Pure Good that glows warmly and makes the nearby chickens behave", price: "95 gold" },
  { desc: "a Talisman of Ultimate Evil, kept in a lead-lined pickle jar for everyone's safety", price: "40 gold" },
  { desc: "a Mirror of Life Trapping with a crack down one side and a distinct sense of being watched", price: "70 gold" },
  { desc: "the Cloak of Invisibility, 'sold as seen' (nobody has seen it yet)", price: "100 gold" },
  { desc: "the Robe of the Archmagi, patched at the elbows and reeking of ozone", price: "130 gold" },
  { desc: "an Orb of Dragonkind that goes cold whenever a dragon is within a thousand miles", price: "140 gold" },
  { desc: "the Rod of Seven Parts — six of seven, the peddler is 'still looking for the last one'", price: "60 gold" },
  { desc: "the Staff of the Magi, a splintered old staff that crackles whenever it hears the word 'counterspell'", price: "125 gold" },
  { desc: "a Plate Armor of Etherealness that vanishes entirely, the peddler warns, 'if you get excited'", price: "115 gold" },
  { desc: "the Sword of Kas, a pitch-black blade that whispers rude things about its former owner", price: "80 gold" },
  { desc: "a Luck Blade with a sheepish grin and exactly one wish remaining", price: "105 gold" },
  { desc: "an Ioun Stone of Mastery spinning lazily in the air above the table, bothering no one", price: "65 gold" },
  { desc: "the Hammer of Thunderbolts, a dwarven masterwork the peddler mistook for a 'really good doorstop'", price: "135 gold" },
  { desc: "the Scroll of Protection from Everything, written in a language that only exists in dreams", price: "55 gold" },
];

// The peddler has no clue what's on the table when a relic turns up — that is
// the whole joke — so the framing is a notch more breathless than the usual pitch.
const LEGENDARY_INTROS: Array<(name: string) => string> = [
  (name) => `✨ ${name} drags a strangely heavy sack onto the table and hisses, "Don't tell the guards where I got this."`,
  (name) => `✨ The air hums as ${name} unwraps something from an oily rag — the crowd goes quiet.`,
  (name) => `✨ ${name} squints at a dusty find and mutters, "Huh. Never seen THAT one before."`,
  (name) => `✨ Something at ${name}'s stall is glowing, and for once it's not the stew.`,
  (name) => `✨ ${name} pulls a relic out of a barrel of turnips and holds it aloft, unsure why everyone is staring.`,
  (name) => `✨ ${name} shoos a stray cat off a priceless-looking heirloom and gives a hopeful cough.`,
];

const LEGENDARY_CLOSERS: string[] = [
  "Rare find. Possibly cursed. Definitely not returnable.",
  "No idea what it does, but the dust says it's old.",
  "Priced to move before the previous owner shows up.",
  "Whatever it is, it was in my grandmother's cellar. Allegedly.",
  "The last three buyers all vanished in a bright light — good omen, I say.",
  "Handled with care, mostly. A few singed fingers, nothing serious.",
  "Legend says it's one of a kind. Legend also says a lot of things.",
  "Quick, before it starts whispering to the next customer.",
];

export interface MerchantOffer {
  merchantName: string;
  itemDesc: string;
  priceText: string;
  ad: string;
}

/** Rolls a full merchant offer — the peddler, the item, and the ready-to-post
 * ad text together — so a caller (merchant_cron.ts) can post the ad and
 * persist what's currently on offer (for !haggle, see haggle.ts) from the
 * same roll instead of them drifting apart. */
export function rollMerchantOffer(): MerchantOffer {
  const name = pick(MERCHANT_NAMES);
  // Occasionally the peddler stumbles onto a legendary relic instead of junk.
  if (Math.random() < LEGENDARY_CHANCE) {
    const relic = pick(LEGENDARY_ITEMS);
    return {
      merchantName: name,
      itemDesc: relic.desc,
      priceText: relic.price,
      ad: `🛒 ${pick(LEGENDARY_INTROS)(name)} Legendary find: ${relic.desc} — ${relic.price}. ${pick(LEGENDARY_CLOSERS)}`,
    };
  }
  const intro = pick(MERCHANT_INTROS)(name);
  const item = pick(MERCHANT_ITEMS);
  const closer = pick(MERCHANT_CLOSERS);
  return {
    merchantName: name,
    itemDesc: item.desc,
    priceText: item.price,
    ad: `🛒 ${intro} Today's find: ${item.desc} — ${item.price}. ${closer}`,
  };
}

/** One full merchant sales-pitch ad, ready to post to chat. */
export function generateMerchantAd(): string {
  return rollMerchantOffer().ad;
}

/** Handles !market on | off | status. Returns true if the message matched. */
export async function handleMerchantCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const match = chatMessage.trim().match(/^!market\s+(on|off|status)$/i);
  if (!match) return false;
  const action = match[1].toLowerCase();

  if (action === "status") {
    const enabled = await isMerchantEnabled(broadcasterId);
    await sendChatMessage(
      `@${display} The open-stall merchant is currently ${
        enabled ? "hawking wares in this channel" : "packed up and gone from this channel"
      }. Toggle with !market on or !market off (mod only).`,
      broadcasterId,
    );
    return true;
  }

  if (!isModerator) {
    await sendChatMessage(
      `@${display} only the broadcaster or a moderator can toggle the market stall.`,
      broadcasterId,
    );
    return true;
  }

  const enabled = action === "on";
  await setMerchantEnabled(broadcasterId, enabled, enabled ? Date.now() + randomMerchantIntervalMs() : null);
  await sendChatMessage(
    enabled
      ? `@${display} A threadbare peddler has claimed a corner of the market square and will drop by every so often with a sales pitch — small goods, smaller prices, no guild coin required.`
      : `@${display} The market stall has packed up and left this channel. Fewer bargains, but also fewer suspicious dice.`,
    broadcasterId,
  );
  return true;
}

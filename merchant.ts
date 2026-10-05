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
import { effectText, LEGENDARY_ITEMS, MERCHANT_ITEMS } from "./gear.ts";
import { optNum } from "./channel_options.ts";

const MIN_INTERVAL_MINUTES = Math.max(5, Number(Deno.env.get("MERCHANT_MIN_INTERVAL_MINUTES") ?? "25"));
const MAX_INTERVAL_MINUTES = Math.max(MIN_INTERVAL_MINUTES, Number(Deno.env.get("MERCHANT_MAX_INTERVAL_MINUTES") ?? "60"));

/** Chance (0-1) that a roll turns up a rare legendary relic instead of the usual
 * junk. Override with MERCHANT_LEGENDARY_CHANCE; 0 disables relics entirely.
 * Values above 1 are read as percentages ("8" = 8%), and the result is hard-capped
 * at LEGENDARY_CHANCE_MAX so a misconfigured env var can never make relics the
 * merchant's usual stock. */
const LEGENDARY_CHANCE_DEFAULT = 0.05;
const LEGENDARY_CHANCE_MAX = 0.2;
function resolveLegendaryChance(): number {
  const raw = Deno.env.get("MERCHANT_LEGENDARY_CHANCE");
  if (raw === undefined || raw.trim() === "") return LEGENDARY_CHANCE_DEFAULT;
  let n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return LEGENDARY_CHANCE_DEFAULT;
  if (n > 1) n = n / 100;
  return Math.min(LEGENDARY_CHANCE_MAX, n);
}
const LEGENDARY_CHANCE = resolveLegendaryChance();

/** A fresh randomized gap (ms) until the merchant's next ad. With a channel, its own
 * shortest/longest gaps (channel_options.ts: merchant.minGap/maxGap) are used. */
export async function randomMerchantIntervalMs(broadcasterId = ""): Promise<number> {
  const [minS, maxS] = broadcasterId
    ? await Promise.all([optNum(broadcasterId, "merchant.minGap"), optNum(broadcasterId, "merchant.maxGap")])
    : [MIN_INTERVAL_MINUTES * 60, MAX_INTERVAL_MINUTES * 60];
  const minMs = Math.min(minS, maxS) * 1000, maxMs = Math.max(minS, maxS) * 1000;
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

// The wares themselves (MERCHANT_ITEMS / LEGENDARY_ITEMS) live in gear.ts,
// with the stat bonus each one grants when bought (see haggle.ts).

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
      ad: `🛒 ${pick(LEGENDARY_INTROS)(name)} Legendary find: ${relic.desc} — ${relic.price} (🎒 ${effectText(relic.effect)}). ${pick(LEGENDARY_CLOSERS)}`,
    };
  }
  const intro = pick(MERCHANT_INTROS)(name);
  const item = pick(MERCHANT_ITEMS);
  const closer = pick(MERCHANT_CLOSERS);
  return {
    merchantName: name,
    itemDesc: item.desc,
    priceText: item.price,
    ad: `🛒 ${intro} Today's find: ${item.desc} — ${item.price} (🎒 ${effectText(item.effect)}). ${closer}`,
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
  await setMerchantEnabled(broadcasterId, enabled, enabled ? Date.now() + await randomMerchantIntervalMs(broadcasterId) : null);
  await sendChatMessage(
    enabled
      ? `@${display} A threadbare peddler has claimed a corner of the market square and will drop by every so often with a sales pitch — small goods, smaller prices, no guild coin required.`
      : `@${display} The market stall has packed up and left this channel. Fewer bargains, but also fewer suspicious dice.`,
    broadcasterId,
  );
  return true;
}

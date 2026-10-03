// Auto replies for Twitch events: sub/resub/gift thank-yous, incoming-raid
// thank-yous, and the plain-chat goodnight send-off.
// Split out of utils.ts to keep every file well under Val Town's per-file
// size ceiling.

import { pick } from "./utils.ts";

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
  `\\b(?:gn+|g['’]?n?${NIGHT}|good\\s*${NIGHT}|nighty\\s*${NIGHT}|${NIGHT}\\s*${NIGHT}|` +
    `sleep\\s*tight|bed\\s*time|off\\s*to\\s*bed|heading\\s*to\\s*bed|` +
    `hitting\\s*the\\s*(?:hay|sack)|time\\s*for\\s*bed|going\\s*to\\s*sleep|` +
    `sweet\\s*dreams|catch\\s*(?:you|ya)\\s*(?:tomorrow|later)|see\\s*you\\s*tomorrow|` +
    `logging\\s*off\\s*to\\s*(?:bed|sleep)|long\\s*rest)\\b`,
  "i",
);

export function isGoodnightMessage(message: string): boolean {
  return GOODNIGHT_REGEX.test(message.trim());
}

const GOODNIGHT_REPLIES = [
  `Rest well! 🌙 May your dreams be free of goblins.`,
  `Goodnight! The guild hall banks its fires — safe travels to the Land of Nod. 💤`,
  `Sleep tight! A long rest restores HP *and* spell slots. 🛌`,
  `Farewell for now! May you wake with advantage on tomorrow's rolls. ✨`,
  `🌜 Sweet dreams! May no owlbear disturb your rest.`,
  `🛏️ Off to bed? Even legends need their eight hours.`,
  `🌙 Goodnight! The watch is set — sleep easy.`,
  `💤 Long rest initiated. See you after the next dawn.`,
  `✨ Sleep well — may your dreams roll nothing but natural 20s.`,
  `🏕️ Camp's set. Rest up for tomorrow's adventure.`,
  `🌌 The stars watch over you tonight. Goodnight!`,
  `🦉 The owls take the next watch. Rest easy.`,
  `🕯️ The torches dim for the night. Sleep well.`,
  `🐉 Even dragons need their sleep. Goodnight!`,
  `📖 The chronicle pauses here. Same time next session?`,
  `🛡️ Shields down — time to rest.`,
  `🌠 May a shooting star bless your dreams. Goodnight!`,
  `🍃 The wind carries you off to sleep. Rest well.`,
  `🧝 Even the elves need their trance sometimes. Goodnight!`,
  `🌒 Until next session. Sleep tight, adventurer.`,
];

export function goodnightReply(): string {
  return GOODNIGHT_REPLIES[Math.floor(Math.random() * GOODNIGHT_REPLIES.length)];
}

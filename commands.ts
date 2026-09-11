// =============================================================================
//  commands.ts — one async function per player-facing command. Each takes
//  (username, display, args) and returns the reply string.
//  To add a new command: write the function here, then add one line to
//  COMMAND_DEFS at the bottom of twitch.ts.
// =============================================================================
import { Rules, Combat, Inventory, Merchant, Advisor, Util, Character, MonsterLookup, ItemLookup, AutoHunt } from "./game.ts";
import { QuestBoard } from "./quests.ts";
import * as Store from "./storeClient.ts";

const GUIDE_URL = "https://huntandhoardbot.val.run/commands";

// Checks the current quest board for a bounty on `monsterName`, logs
// `kills` toward it for this character, and auto turns it in (grants
// reward, rerolls that board slot) the moment it's met. Returns a message
// fragment to tack onto the hunt reply, or "" if no quest was touched.
export async function applyQuestProgress(c: Character, monsterName: string, kills: number): Promise<string> {
  if (kills <= 0) return "";
  const board = await Store.getQuestBoard();
  const found = QuestBoard.findByMonsterName(board, monsterName);
  if (!found) return "";

  const { quest, index } = found;
  const updated = (c.questProgress[quest.id] || 0) + kills;

  if (updated >= quest.targetCount) {
    c.gold += quest.goldReward;
    let rewardMsg = "+" + quest.goldReward + " gold";
    if (quest.itemReward) {
      Inventory.add(c, quest.itemReward);
      rewardMsg += " and a " + quest.itemReward.name;
    }
    delete c.questProgress[quest.id];
    board[index] = QuestBoard.rollQuest();
    await Store.saveQuestBoard(board);
    return " 📜 Bounty fulfilled! The Clerk unseals the coffer for the " + quest.monsterName + " contract — " + rewardMsg + ". A fresh posting goes up on the board.";
  }

  c.questProgress[quest.id] = updated;
  return " 📜 Bounty progress: " + quest.monsterName + " " + updated + "/" + quest.targetCount + ".";
}

export async function help(_username: string, display: string): Promise<string> {
  return "@" + display + " 📜 The Clerk keeps the full charter of commands sealed at this scroll: " + GUIDE_URL;
}

const LURK_LINES = [
  " slips into the shadows at the back of the guildhall, cloak drawn — still within earshot of the bounty board.",
  " takes a quiet seat in the corner booth, boots up on the table, one eye on the room.",
  " melts into the tavern crowd, nursing a drink and watching the door.",
  " retreats to the archive stacks to \"study,\" though the Clerk suspects a nap is more likely.",
  " posts up by the hearth, hood low, content to let the other adventurers take the spotlight.",
  " signs the guest ledger and disappears into the rafters like a proper rogue.",
  " leans against the back wall near the notice board, present but unbothered.",
  " ducks behind a stack of crates in the storeroom — technically still on guild grounds.",
  " curls up with the guild cat by the window and goes very, very still.",
  " steps into the scrying pool's reflection, watching from just out of frame.",
];

export async function lurk(_username: string, display: string): Promise<string> {
  const line = LURK_LINES[Math.floor(Math.random() * LURK_LINES.length)];
  return "@" + display + " 🥷" + line + " The Clerk marks you present in the ledger all the same.";
}

export async function start(username: string, display: string): Promise<string> {
  const c = await Store.getCharacter(username);
  if (!c) {
    return "@" + display + " Ah, a new face at the desk! The Clerk hasn't yet entered your name in the ledger — say !enlist <name> " +
      "(or !enlist random) to be sworn in, then !hunt or !autohunt to make your mark on the world. The full charter awaits at !help.";
  }
  const offers = await Store.getMerchantOffers();
  return "@" + display + " The ledger reads: " + Rules.sheetLine(c) + " " + Advisor.recommendNextAction(c, offers);
}

export async function createchar(username: string, display: string, args: string[]): Promise<string> {
  const existing = await Store.getCharacter(username);
  if (existing) {
    return "@" + display + " the ledger already bears your name — " + existing.name + ", Level " + existing.level +
      ". Only one entry per adventurer is permitted; say \"!discharge confirm\" to close that file before opening a new one.";
  }
  const raw = args.join(" ").trim();
  let name: string;
  if (!raw || raw.toLowerCase() === "random") {
    name = Rules.rollRandomName();
  } else if (raw.length > 24) {
    return "@" + display + " that name won't fit the ledger's margin (24 characters max). Try again, or say \"!enlist random\" and let the Clerk choose.";
  } else if (!/^[a-zA-Z' -]+$/.test(raw)) {
    return "@" + display + " the Clerk's quill only forms letters, spaces, apostrophes, and hyphens. Try again, or say \"!enlist random\".";
  } else {
    name = raw;
  }
  const character = Rules.createCharacter(username, name);
  await Store.saveCharacter(character);
  const offers = await Store.getMerchantOffers();
  return "@" + display + " the quill scratches across the ledger — " + character.name + " is sworn in as a Level 1 " +
    character.race.name + " " + character.cls.name + "! " + Rules.sheetLine(character) + ". " + Advisor.recommendNextAction(character, offers);
}

export async function character(username: string, display: string, args: string[]): Promise<string> {
  const targetArg = (args[0] || "").replace(/^@/, "").trim();

  if (!targetArg) {
    const c = await Store.getCharacter(username);
    if (!c) return "@" + display + " the ledger has no entry under your name yet. Say !enlist <name> or !enlist random to begin.";
    const offers = await Store.getMerchantOffers();
    return "@" + display + " The ledger reads: " + Rules.sheetLine(c) + " " + Advisor.recommendNextAction(c, offers);
  }

  // Looking up someone else's entry — targetArg is their Twitch username
  // (how records are keyed), not their in-game character name.
  const target = await Store.getCharacter(targetArg);
  if (!target) return "@" + display + " no ledger entry found for \"" + targetArg + "\".";
  return "@" + display + " " + target.name + "'s ledger entry: " + Rules.sheetLine(target);
}

export async function hunt(username: string, display: string, args: string[]): Promise<string> {
  const c = await Store.getCharacter(username);
  if (!c) return "@" + display + " the Clerk can't send an unlisted adventurer into the field — !enlist <name> or !enlist random first.";
  if (c.hp <= 1) {
    return "@" + display + " " + c.name + " can barely stand (" + c.hp + "/" + c.hpMax + " HP) — the Clerk insists on !rest (or a potion) before another bout.";
  }

  const targetName = args.join(" ").trim();
  let targetMonster = undefined as ReturnType<typeof MonsterLookup.find>;
  if (targetName) {
    targetMonster = MonsterLookup.find(targetName);
    if (!targetMonster) {
      return "@" + display + " no such quarry is known as \"" + targetName + "\". Check !quests for the board, or !hunt with no name and let fate pick your foe.";
    }
  }

  const result = Combat.huntMonster(c, targetMonster);
  const questMsg = result.won ? await applyQuestProgress(c, result.monster.name, 1) : "";
  await Store.saveCharacter(c);
  const offers = await Store.getMerchantOffers();
  const highlight = result.log.slice(-3).join(", ");
  const rec = Advisor.recommendNextAction(c, offers);
  if (result.won) {
    const levelMsg = result.leveledTo ? " 🎉 The bards will sing of it — leveled up to " + result.leveledTo + "!" : "";
    return "@" + display + " " + c.name + " crossed blades with a " + result.monster.name + " (" + highlight + ") and prevailed! +" +
      result.xpGained + " XP, +" + result.goldGained + " gold. HP " + result.hpLeft + "/" + result.hpMax + "." + levelMsg + questMsg + " " + rec;
  }
  return "@" + display + " " + c.name + " was overmatched by a " + result.monster.name + " (" + highlight +
    ") and beat a hasty retreat. +" + result.xpGained + " XP logged for the effort. HP " + result.hpLeft + "/" + result.hpMax + " — " + rec;
}

export async function autohunt(username: string, display: string, args: string[], channel: string): Promise<string> {
  const c = await Store.getCharacter(username);
  if (!c) return "@" + display + " the Clerk can't send an unlisted adventurer into the field — !enlist <name> or !enlist random first.";
  if (c.hp <= 1) {
    return "@" + display + " " + c.name + " can barely stand (" + c.hp + "/" + c.hpMax + " HP) — the Clerk insists on !rest (or a potion) before another bout.";
  }
  const sessions = await Store.getAutohuntSessions();
  if (sessions.some((s) => s.username === c.username)) {
    return "@" + display + " " + c.name + " is already out on an autohunt — say !autohuntstop to call it back early, or !autohuntstatus to check in.";
  }
  const raw = args.join(" ").trim();
  const durationMs = AutoHunt.parseDuration(raw);
  if (durationMs === null) {
    return "@" + display + " the Clerk doesn't follow that duration — try \"!autohunt 20m\", \"!autohunt 1h\", or just \"!autohunt\" for the default " +
      AutoHunt.formatDuration(AutoHunt.DEFAULT_DURATION_MS) + ".";
  }
  sessions.push(AutoHunt.start(c, channel, durationMs));
  await Store.saveAutohuntSessions(sessions);
  return "@" + display + " " + c.name + " heads out for " + AutoHunt.formatDuration(durationMs) +
    " of autohunting, resting up automatically if HP runs low. Say !autohuntstop to recall early, or !autohuntstatus to check in.";
}

export async function autohuntstop(username: string, display: string): Promise<string> {
  const sessions = await Store.getAutohuntSessions();
  const idx = sessions.findIndex((s) => s.username === username.toLowerCase());
  if (idx === -1) return "@" + display + " no autohunt is currently running for you.";
  const [session] = sessions.splice(idx, 1);
  await Store.saveAutohuntSessions(sessions);
  const c = await Store.getCharacter(username);
  return "@" + display + " " + (c ? AutoHunt.summary(c, session, "called back early") : "the Clerk recalls the party.");
}

export async function autohuntstatus(username: string, display: string): Promise<string> {
  const sessions = await Store.getAutohuntSessions();
  const session = sessions.find((s) => s.username === username.toLowerCase());
  if (!session) return "@" + display + " no autohunt is currently running for you. Say !autohunt <duration> to start one.";
  const remaining = Math.max(0, session.endsAt - Date.now());
  return "@" + display + " autohunt in progress: " + session.hunts + " bout" + (session.hunts === 1 ? "" : "s") + " so far (" +
    session.wins + "W/" + session.losses + "L), +" + session.totalXp + " XP, +" + session.totalGold + " gold, about " +
    AutoHunt.formatDuration(remaining) + " left.";
}

export async function rest(username: string, display: string): Promise<string> {
  const c = await Store.getCharacter(username);
  if (!c) return "@" + display + " the ledger has no entry under your name yet.";
  const offers = await Store.getMerchantOffers();
  const REST_RESTORE_FRACTION = 0.8; // resting patches you up, but doesn't fully heal you
  const target = Math.min(c.hpMax, Math.ceil(c.hpMax * REST_RESTORE_FRACTION));
  if (c.hp >= target) {
    return "@" + display + " " + c.name + " is already well-rested (" + c.hp + "/" + c.hpMax + ") — little more to gain from another sit by the fire. " +
      Advisor.recommendNextAction(c, offers);
  }
  c.hp = target;
  await Store.saveCharacter(c);
  return "@" + display + " " + c.name + " makes camp and recovers to " + c.hp + "/" + c.hpMax + " HP. " +
    Advisor.recommendNextAction(c, offers);
}

export async function quests(username: string, display: string): Promise<string> {
  const c = await Store.getCharacter(username);
  const board = await Store.getQuestBoard();
  const desc = QuestBoard.describeBoard(board, (q) => (c ? c.questProgress[q.id] || 0 : 0));
  const hint = c ? " Say !hunt <monster name> to take up a bounty, e.g. \"!hunt " + board[0].monsterName + "\"." :
    " Enlist with !enlist to start logging your progress against the board.";
  return "@" + display + " 📜 The bounty board reads: " + desc + "." + hint;
}

export async function merchant(_username: string, display: string): Promise<string> {
  const offers = await Store.getMerchantOffers();
  return "@" + display + " 🛒 Today's wares at the stall: " + Merchant.describeOffers(offers) +
    ". Say !buy <#|item name> to make a purchase, e.g. \"!buy 1\".";
}

export async function coinpurse(username: string, display: string): Promise<string> {
  const c = await Store.getCharacter(username);
  if (!c) return "@" + display + " you've no entry in the ledger, so no purse for the Clerk to check.";
  const offers = await Store.getMerchantOffers();
  const affordable = Merchant.cheapestAffordable(offers, c.gold);
  const purseLine = "@" + display + " " + c.name + "'s coinpurse holds " + c.gold + " gold.";
  if (affordable) {
    return purseLine + " Enough for " + affordable.item.name + " (" + affordable.item.price + " gold) at !merchant — !buy it.";
  }
  if (offers.length) {
    const cheapest = offers.reduce((a, b) => (a.item.price <= b.item.price ? a : b));
    const short = cheapest.item.price - c.gold;
    return purseLine + " Need " + short + " more gold for the cheapest ware on offer (" + cheapest.item.name + "). " +
      Advisor.recommendNextAction(c, offers);
  }
  return purseLine + " " + Advisor.recommendNextAction(c, offers);
}

export async function buy(username: string, display: string, args: string[]): Promise<string> {
  const c = await Store.getCharacter(username);
  if (!c) return "@" + display + " the Clerk can't send an unlisted adventurer into the field — !enlist <name> or !enlist random first.";
  const offers = await Store.getMerchantOffers();
  const needle = args.join(" ").trim();
  if (!needle) {
    return "@" + display + " buy which one? " + Merchant.describeOffers(offers) + " — try \"!buy 1\" or \"!buy <item name>\".";
  }
  const found = Merchant.findOffer(offers, needle);
  if (!found) {
    return "@" + display + " no ware on the stall matches \"" + needle + "\". Current stall: " + Merchant.describeOffers(offers);
  }
  const offer = found.offer;
  if (c.gold < offer.item.price) {
    return "@" + display + " " + offer.item.price + " gold is needed for the " + offer.item.name + ", but your purse holds only " +
      c.gold + ". The road (!hunt) pays better than standing still.";
  }
  c.gold -= offer.item.price;
  Inventory.add(c, offer.item);
  offers[found.index] = Merchant.rollOffer(); // only the purchased slot restocks
  await Store.saveCharacter(c);
  await Store.saveMerchantOffers(offers);
  return "@" + display + " " + offer.item.name + " changes hands — bought from " + offer.merchant + " for " + offer.item.price +
    " gold. Check !inventory, and !use it when the moment calls. The stall has a fresh offer in that slot. " + Advisor.recommendNextAction(c, offers);
}

export async function item(username: string, display: string, args: string[]): Promise<string> {
  const needle = args.join(" ").trim();

  if (needle) {
    const found = ItemLookup.find(needle);
    if (!found) {
      return "@" + display + " no such ware is known to the Clerk as \"" + needle + "\". Check !merchant for what's currently on the stall.";
    }
    return "@" + display + " " + ItemLookup.describe(found);
  }

  const c = await Store.getCharacter(username);
  if (!c) return "@" + display + " the ledger has no entry under your name yet. Try !item <name> to look something up directly.";
  const { weapon, armor } = c.equipped;
  if (!weapon && !armor) {
    return "@" + display + " bare fists and no armor — nothing on you for the Clerk to appraise. Try !item <name> to look something up directly.";
  }
  const parts: string[] = [];
  if (weapon) parts.push(ItemLookup.describe(weapon));
  if (armor) parts.push(ItemLookup.describe(armor));
  return "@" + display + " " + parts.join(" | ");
}

export async function inventory(username: string, display: string): Promise<string> {
  const c = await Store.getCharacter(username);
  if (!c) return "@" + display + " the ledger has no entry under your name yet.";
  if (!c.inventory.length) {
    return "@" + display + " " + c.name + "'s pack is empty. Try !merchant and !buy to fill it.";
  }
  const offers = await Store.getMerchantOffers();
  const list = c.inventory.map((it) => it.name + (it.qty > 1 ? " x" + it.qty : "")).join(", ");
  return "@" + display + " " + c.name + "'s pack holds: " + list + ". " + Advisor.recommendNextAction(c, offers);
}

export async function use(username: string, display: string, args: string[]): Promise<string> {
  const c = await Store.getCharacter(username);
  if (!c) return "@" + display + " the ledger has no entry under your name yet.";
  const needle = args.join(" ").trim();
  if (!needle) return "@" + display + " use what? Try !use <item name>, e.g. !use potion.";
  const invItem = Inventory.find(c, needle);
  if (!invItem) {
    const have = c.inventory.length ? c.inventory.map((it) => it.name).join(", ") : "(nothing)";
    return "@" + display + " nothing in your pack matches \"" + needle + "\". You carry: " + have;
  }

  let msg: string;
  if (invItem.type === "potion") {
    const heal = invItem.heal!;
    const healed = Util.rollDice(heal[0], heal[1]) + heal[2];
    c.hp = Util.clamp(c.hp + healed, 0, c.hpMax);
    Inventory.removeOne(c, invItem);
    msg = "@" + display + " " + c.name + " drinks down the " + invItem.name + " and recovers " + healed + " HP (" + c.hp + "/" + c.hpMax + ").";
  } else if (invItem.type === "weapon") {
    const previous = c.equipped.weapon;
    c.equipped.weapon = invItem;
    Inventory.removeOne(c, invItem);
    if (previous) Inventory.add(c, previous);
    msg = "@" + display + " " + c.name + " draws the " + invItem.name + " and takes up arms.";
  } else if (invItem.type === "armor") {
    const previous = c.equipped.armor;
    c.equipped.armor = invItem;
    Inventory.removeOne(c, invItem);
    if (previous) Inventory.add(c, previous);
    msg = "@" + display + " " + c.name + " straps on the " + invItem.name + ".";
  } else {
    msg = "@" + display + " the " + invItem.name + " is little more than a curiosity — nothing happens when you put it to use.";
  }
  await Store.saveCharacter(c);
  const offers = await Store.getMerchantOffers();
  return msg + " " + Advisor.recommendNextAction(c, offers);
}

export async function drop(username: string, display: string, args: string[]): Promise<string> {
  const c = await Store.getCharacter(username);
  if (!c) return "@" + display + " the ledger has no entry under your name yet.";
  const needle = args.join(" ").trim();
  if (!needle) return "@" + display + " drop what? Try !drop <item name>.";
  const invItem = Inventory.find(c, needle);
  if (!invItem) {
    const have = c.inventory.length ? c.inventory.map((it) => it.name).join(", ") : "(nothing)";
    return "@" + display + " nothing in your pack matches \"" + needle + "\". You carry: " + have;
  }
  Inventory.removeOne(c, invItem);
  await Store.saveCharacter(c);
  return "@" + display + " the " + invItem.name + " is left behind on the road.";
}

export async function sell(username: string, display: string, args: string[]): Promise<string> {
  const c = await Store.getCharacter(username);
  if (!c) return "@" + display + " the ledger has no entry under your name yet.";
  const needle = args.join(" ").trim();
  if (!needle) return "@" + display + " sell what? Try !sell <item name>.";
  const invItem = Inventory.find(c, needle);
  if (!invItem) {
    const have = c.inventory.length ? c.inventory.map((it) => it.name).join(", ") : "(nothing)";
    return "@" + display + " nothing in your pack matches \"" + needle + "\". You carry: " + have;
  }
  const sellPrice = Math.max(1, Math.floor(invItem.price / 2));
  Inventory.removeOne(c, invItem);
  c.gold += sellPrice;
  await Store.saveCharacter(c);
  const offers = await Store.getMerchantOffers();
  return "@" + display + " " + c.name + " sells the " + invItem.name + " back to the stall for " + sellPrice +
    " gold. " + Advisor.recommendNextAction(c, offers);
}

export async function resetchar(username: string, display: string, args: string[]): Promise<string> {
  const c = await Store.getCharacter(username);
  if (!c) return "@" + display + " there's no entry under your name for the Clerk to close.";
  if ((args[0] || "").toLowerCase() !== "confirm") {
    return "@" + display + " this will strike " + c.name + " from the ledger for good — say \"!discharge confirm\" if you're certain.";
  }
  await Store.deleteCharacter(username);
  return "@" + display + " the Clerk closes " + c.name + "'s file with a heavy seal. Say !enlist when you're ready to open a new one.";
}

export const Commands: Record<string, (username: string, display: string, args: string[], channel: string) => Promise<string>> = {
  help, start, createchar, character, hunt, autohunt, autohuntstop, autohuntstatus, rest, merchant,
  coinpurse, buy, inventory, item, use, drop, sell, resetchar, quests, lurk,
};

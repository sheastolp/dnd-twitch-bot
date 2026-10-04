// Hunt and Hoard — the Wandering Clerk's hunting-and-shopping game, ported
// from the standalone Hunt & Hoard bot as a GuildScribe module and rebuilt on
// GuildScribe's own systems:
//
//   heroes    the GuildScribe character sheet (!createchar) — no separate
//             !enlist. Level, XP, HP and gear are the sheet's.
//   monsters  the channel's live bestiary (bestiary.ts): level-scaled, adapted,
//             and every hunt teaches the monster like any other fight.
//   combat    simulateMonsterFight (battle.ts), the same engine as
//             !dndduel and !autohunt, gated by the channel's hunting cooldown.
//   rewards   awardMonsterXp + awardMonsterLoot (characters.ts / loot.ts),
//             paid into the gold wallet (points_db.ts).
//   gear      the peddler catalog (gear.ts): bought gear is baked onto the
//             sheet with applyGear, exactly like a !haggle purchase.
//
// What Hunt & Hoard adds on top:
//   - HP that carries between fights. While the module is open, EVERY monster
//     fight (!hunt, !dndduel solo/party hunts, !autohunt, raids) starts at the
//     hero's current HP and leaves them where it ended — never below 1 (see
//     hoard_combat.ts). Heal with !rest (to 80%), potions, or 3 HP every 15 min.
//   - A merchant stall: three offers of potions and peddler gear, turning
//     over every 20 minutes, bought with coin.
//   - A pack of potions: !inv, !use, !sell, !drop.
//   - A bounty board: three "slay N of X" postings drawn from the bestiary's
//     easy end. Every monster kill counts (creditBounty is called from the
//     solo/party duel, autohunt and raid code); whoever finishes one first is
//     paid and the posting is replaced.
//   - A "Next:" hint on most replies saying what to do next.
//
// Off by default per channel (!hoard on / the dashboard). While off, or if
// the channel has a custom command with the same name (e.g. its own !shop),
// these words fall through untouched.
//
//   !hoard [on|off|status]   your status + next step; mods switch the module
//   !hunt [monster]          hunt a random level-fit foe, or a named one
//   !rest                    recover to 80% HP
//   !bounties | !quests      the bounty board and your progress
//   !shop | !merchant [#|name]  the stall, or one ware's details and lore
//   !buy <#|name>            buy from the stall
//   !inv | !inventory        your potions and gear
//   !use <potion>            drink a potion
//   !sell <potion> | !drop <potion>
//   !purse | !coinpurse      your coin and what it can buy
//   !ledger [@user]          a hero's Hunt and Hoard sheet

import { getCharacter, getCustomCommand, isCommandGroupEnabled, saveCharacter } from "./db.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import { summonMonster, recordMonsterOutcome, tierTag } from "./bestiary.ts";
import { simulateMonsterFight } from "./battle.ts";
import { awardMonsterXp } from "./characters.ts";
import { awardMonsterLoot, lootSummary, soloLootNote } from "./loot.ts";
import { claimHunt } from "./huntcooldown.ts";
import { fightSummary, hpLeft } from "./whisper.ts";
import { duelNarration } from "./narration.ts";
import { withArticle } from "./combat_shared.ts";
import { applyGear, effectText, ownsGear } from "./gear.ts";
import { formatCoins } from "./coins.ts";
import { adjustBalance, getBalance, isPointsEnabled, trySpend } from "./points_db.ts";
import { combatStats, formatRaceName, pick } from "./utils.ts";
import type { Character } from "./types.ts";
import { isLowHp, loadHero } from "./hoard_combat.ts";
import {
  type Bounty,
  findPackPotion,
  findPotion,
  getBoard,
  getPlayer,
  getStall,
  type HoardPlayer,
  isHoardEnabled,
  resolveOffer,
  type ResolvedOffer,
  rerollBounty,
  rollOffer,
  savePlayer,
  saveStall,
  setHoardEnabled,
} from "./hoard_db.ts";
import {
  LORE_TEMPLATES,
  MAX_POTION_STACK,
  POTIONS,
  REST_FRACTION,
  SELL_BACK_SHARE,
} from "./hoard_data.ts";

/** Chat word → dashboard group (commandgroups.ts) that switches it. */
const WORD_GROUP: Record<string, string> = {
  hunt: "hoardhunt", rest: "hoardhunt", ledger: "hoardhunt",
  bounties: "hoardbounties", quests: "hoardbounties",
  shop: "hoardshop", merchant: "hoardshop", buy: "hoardshop", sell: "hoardshop", use: "hoardshop", drop: "hoardshop",
  inv: "hoardshop", inventory: "hoardshop", purse: "hoardshop", coinpurse: "hoardshop",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const rollHeal = ([n, sides, flat]: [number, number, number]) => {
  let total = flat;
  for (let i = 0; i < n; i++) total += 1 + Math.floor(Math.random() * sides);
  return total;
};

// ── The "Next:" hint ──

async function nextStep(broadcasterId: string, username: string, c: Character | null, p: HoardPlayer): Promise<string> {
  if (!c) return "Next: !createchar to roll up a hero.";
  const potion = findPackPotion(p, "");
  if (c.hpCurrent <= 1 || isLowHp(c)) {
    const how = c.hpCurrent <= 1 ? "you are barely standing" : "patch up before your next fight";
    return potion ? `Next: !use ${potion.name} or !rest — ${how}.` : `Next: !rest — ${how}.`;
  }
  if (await isPointsEnabled(broadcasterId)) {
    const [bal, stall] = await Promise.all([getBalance(broadcasterId, username), getStall(broadcasterId)]);
    const coin = bal?.balance ?? 0;
    const offers = stall.map(resolveOffer);
    const i = offers.findIndex((o) => o && o.price <= coin && (o.kind === "potion" ? !potion : !ownsGear(c, o.gear)));
    if (i >= 0) return `Next: !buy ${i + 1} — you can afford the ${offers[i]!.name} (${formatCoins(offers[i]!.price)}).`;
  }
  const board = await getBoard(broadcasterId);
  const open = board.find((b) => (p.progress[b.id] ?? 0) > 0) ?? board[0];
  return `Next: !hunt for XP and loot${open ? ` (bounty: !hunt ${open.monster})` : ""}, or !autohunt to chain fights.`;
}

// ── Bounties ──

function describeBounty(b: Bounty, progress: number): string {
  const reward = [formatCoins(b.reward)];
  const potion = b.potion ? POTIONS.find((x) => x.key === b.potion) : null;
  if (potion) reward.push(potion.name);
  return `Slay ${b.target} ${b.monster}${b.target === 1 ? "" : "s"} (CR ${b.cr}) ${Math.min(progress, b.target)}/${b.target} → ${reward.join(" + ")}`;
}

/**
 * Logs one kill of `monsterName` toward the board, paying out and reposting
 * the slot the moment a hero finishes it. Returns a short note for the reply
 * ("" when no bounty matched or the module is off). Also called by every
 * monster fight: combat_monster.ts, combat_partyduel.ts, autohunt.ts, raid.ts. `player` lets the caller save once.
 */
export async function creditBounty(
  broadcasterId: string,
  username: string,
  monsterName: string,
  player?: HoardPlayer,
): Promise<string> {
  if (!(await isHoardEnabled(broadcasterId)) || !(await isCommandGroupEnabled(broadcasterId, "hoardbounties"))) return "";
  const board = await getBoard(broadcasterId);
  const index = board.findIndex((b) => b.monster.toLowerCase() === monsterName.toLowerCase());
  if (index < 0) return "";
  const b = board[index];
  const p = player ?? (await getPlayer(broadcasterId, username));
  const kills = (p.progress[b.id] ?? 0) + 1;
  let note: string;
  if (kills >= b.target) {
    delete p.progress[b.id];
    const paid: string[] = [];
    if (await isPointsEnabled(broadcasterId)) {
      await adjustBalance(broadcasterId, username, username, b.reward);
      paid.push(formatCoins(b.reward));
    }
    const potion = b.potion ? POTIONS.find((x) => x.key === b.potion) : null;
    if (potion) {
      p.potions[potion.key] = Math.min(MAX_POTION_STACK, (p.potions[potion.key] ?? 0) + 1);
      paid.push(`a ${potion.name}`);
    }
    await rerollBounty(broadcasterId, board, index);
    note = ` 📜 Bounty fulfilled — the ${b.monster} contract pays ${paid.join(" and ") || "in glory"}! A fresh posting goes up.`;
  } else {
    p.progress[b.id] = kills;
    note = ` 📜 Bounty: ${b.monster} ${kills}/${b.target}.`;
  }
  if (!player) await savePlayer(broadcasterId, username, p);
  return note;
}

// ── Formatting ──

function offerLine(o: ResolvedOffer, i: number): string {
  const what = o.kind === "potion" ? o.potion.desc : effectText(o.gear.effect) + (o.legendary ? ", ★ legendary" : "");
  return `#${i + 1} ${o.name} (${what}) — ${formatCoins(o.price)} [${o.merchant}]`;
}

function lore(o: ResolvedOffer): string {
  return pick(LORE_TEMPLATES[o.kind]).split("{owner}").join(o.merchant).split("{item}").join(o.name).split("{desc}").join(o.pitch);
}

function sheetLine(c: Character, p: HoardPlayer, name: string, coin: number | null): string {
  const potions = Object.values(p.potions).reduce((a, b) => a + b, 0);
  const ac = 11 + combatStats(c).mod + c.proficiency;
  return `${name} — Lv ${c.level} ${formatRaceName(c.race, c.subrace)} ${c.cls} | ${c.hpCurrent}/${c.hpMax} HP | AC ${ac} | XP ${c.xp ?? 0}` +
    (coin !== null ? ` | 🪙 ${formatCoins(coin)}` : "") + ` | ${plural(potions, "potion")} | ${plural((c.items ?? []).length, "item")} on the sheet`;
}

function findOffer(offers: Array<ResolvedOffer | null>, needle: string): number {
  const t = needle.trim().replace(/^#/, "");
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= offers.length && offers[n - 1] ? n - 1 : -1;
  }
  const q = t.toLowerCase();
  return offers.findIndex((o) => o && o.name.toLowerCase().includes(q));
}

// ── Command handler ──

export async function handleHoardCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!([a-z]+)(?:\s+(.*))?$/i);
  if (!m) return false;
  const word = m[1].toLowerCase();
  const arg = (m[2] ?? "").trim();
  if (word !== "hoard" && !(word in WORD_GROUP)) return false;
  const say = (text: string) => sendChatMessage(`@${display} ${text}`, broadcasterId);

  // !hoard on|off|status always answers, so mods can switch it on.
  if (word === "hoard" && /^(on|off|status)$/i.test(arg)) {
    const action = arg.toLowerCase();
    if (action === "status") {
      const on = await isHoardEnabled(broadcasterId);
      await say(`⚔️💰 Hunt and Hoard is ${on ? "open — !hunt, !bounties, !shop and !hoard to see where you stand" : "closed in this channel"}.${isModerator ? ` Mods: !hoard ${on ? "off" : "on"}.` : ""}`);
    } else if (!isModerator) {
      await say("only the broadcaster or a moderator can open or close Hunt and Hoard.");
    } else {
      await setHoardEnabled(broadcasterId, action === "on");
      await say(action === "on"
        ? "⚔️💰 Hunt and Hoard is open! The Wandering Clerk posts bounties (!bounties) and the stall opens (!shop). Heroes: !hunt to begin, !hoard for your next step."
        : "Hunt and Hoard is closed. Heroes, potions and bounty progress are kept for next time.");
    }
    return true;
  }

  if (!(await isHoardEnabled(broadcasterId))) return false;
  if (word !== "hoard") {
    // A channel's own command with the same name wins.
    const custom = await getCustomCommand(broadcasterId, word);
    if (custom && Number(custom.enabled ?? 1) === 1) return false;
    if (!(await isCommandGroupEnabled(broadcasterId, WORD_GROUP[word]))) return false;
  }

  const { c, p } = await loadHero(broadcasterId, chatter);
  const noHero = "the Clerk can't find you in the ledger — roll up a hero with !createchar first.";
  const goldOn = await isPointsEnabled(broadcasterId);
  const goldOff = "the stall only deals in coin, and gold is switched off in this channel (a mod can turn it on with !gold on).";

  switch (word) {
    case "hoard": {
      if (!c) {
        await say(`⚔️💰 Welcome to Hunt and Hoard! Roll up a hero with !createchar, then !hunt monsters for XP and loot, fill bounties (!bounties) and spend it at the stall (!shop).`);
        return true;
      }
      const bal = goldOn ? (await getBalance(broadcasterId, chatter))?.balance ?? 0 : null;
      await say(`The ledger reads: ${sheetLine(c, p, display, bal)}. ${await nextStep(broadcasterId, chatter, c, p)}`);
      return true;
    }

    case "ledger": {
      const target = arg.replace(/^@/, "").toLowerCase();
      if (!target || target === chatter.toLowerCase()) {
        if (!c) return say(noHero).then(() => true);
        const bal = goldOn ? (await getBalance(broadcasterId, chatter))?.balance ?? 0 : null;
        await say(`${sheetLine(c, p, display, bal)}. ${await nextStep(broadcasterId, chatter, c, p)}`);
        return true;
      }
      if (!/^[a-z0-9_]{1,25}$/.test(target)) return say("usage: !ledger or !ledger @username").then(() => true);
      const other = await loadHero(broadcasterId, target);
      if (!other.c) return say(`no ledger entry for ${target}.`).then(() => true);
      const bal = goldOn ? (await getBalance(broadcasterId, target))?.balance ?? 0 : null;
      await say(`${target}'s ledger: ${sheetLine(other.c, other.p, target, bal)}.`);
      return true;
    }

    case "hunt": {
      if (!c) return say(noHero).then(() => true);
      if (c.hpCurrent <= 1) {
        await say(`your hero can barely stand (${c.hpCurrent}/${c.hpMax} HP) — the Clerk insists on !rest or a potion (!use) before another bout.`);
        return true;
      }
      const monster = await summonMonster(broadcasterId, c.level, arg || null);
      if (!monster) {
        await say(`no quarry known as "${arg}". Check !bounties for the board, !bestiary for every huntable monster, or !hunt with no name and let fate pick.`);
        return true;
      }
      if (!(await claimHunt(broadcasterId, [chatter], display, { self: chatter }))) return true;

      const startHp = c.hpCurrent;
      const fight = simulateMonsterFight(c, chatter, monster, { startHp });
      const learnNote = await recordMonsterOutcome(broadcasterId, monster.name, fight.won, c.level);
      // HP carries over, but nobody dies on a hunt: worst case, 1 HP.
      c.hpCurrent = Math.max(1, fight.playerHp);
      await saveCharacter(c, broadcasterId);

      let rewards = "";
      let loot = "";
      let bounty = "";
      if (fight.won) {
        const xp = await awardMonsterXp(chatter, monster.cr, broadcasterId);
        if (xp) rewards += ` +${xp.gained} XP${xp.leveledTo ? ` — 🎉 leveled up to ${xp.leveledTo}!` : ""}`;
        const paid = await awardMonsterLoot([chatter], monster.cr, broadcasterId);
        rewards += soloLootNote(paid);
        loot = lootSummary(paid);
        bounty = await creditBounty(broadcasterId, chatter, monster.name, p);
        await savePlayer(broadcasterId, chatter, p);
      }
      // awardMonsterXp re-saves the sheet (a level-up raises max/current HP).
      const after = (await getCharacter(chatter, broadcasterId)) ?? c;
      const shownLog = fight.battle.render();
      const outcome = fight.won
        ? `${display} prevails! ${duelNarration("victory")}${rewards}${bounty}`
        : `${monster.name} wins — ${display} staggers away at 1 HP. ${duelNarration("defeat")}`;
      const msg = `@${display} ⚔️ The Clerk sends you after ${withArticle(monster.name)} (CR ${monster.cr}${tierTag(monster.tier)}, AC ${monster.ac}, HP ${monster.hp}). ` +
        `${shownLog} — ${outcome} HP ${after.hpCurrent}/${after.hpMax}.${learnNote} ${await nextStep(broadcasterId, chatter, after, p)}`;
      await sendChatMessages(msg, broadcasterId, {
        detail: msg.replace(shownLog, fight.battle.renderDetailed()),
        names: [chatter],
        summary: fightSummary({
          fighter: display,
          enemy: monster.name,
          outcome: fight.won ? `${display} wins!` : `${monster.name} wins.`,
          hp: hpLeft([[display, after.hpCurrent, after.hpMax], [monster.name, fight.monsterHp, monster.hp]]),
          loot,
        }) + bounty,
      });
      return true;
    }

    case "rest": {
      if (!c) return say(noHero).then(() => true);
      const target = Math.min(c.hpMax, Math.ceil(c.hpMax * REST_FRACTION));
      if (c.hpCurrent >= target) {
        await say(`your hero is already well-rested (${c.hpCurrent}/${c.hpMax} HP). ${await nextStep(broadcasterId, chatter, c, p)}`);
        return true;
      }
      c.hpCurrent = target;
      await saveCharacter(c, broadcasterId);
      await say(`🏕️ you make camp and recover to ${c.hpCurrent}/${c.hpMax} HP. ${await nextStep(broadcasterId, chatter, c, p)}`);
      return true;
    }

    case "bounties":
    case "quests": {
      const board = await getBoard(broadcasterId);
      const list = board.map((b, i) => `#${i + 1} ${describeBounty(b, p.progress[b.id] ?? 0)}`).join(" | ");
      await say(`📜 The bounty board reads: ${list}. ${c ? `Take one on with !hunt <monster>, e.g. !hunt ${board[0].monster}.` : "Roll up a hero with !createchar to start logging kills."}`);
      return true;
    }

    case "shop":
    case "merchant": {
      const offers = (await getStall(broadcasterId)).map(resolveOffer);
      if (arg) {
        const i = findOffer(offers, arg);
        if (i >= 0) {
          const o = offers[i]!;
          const effect = o.kind === "potion" ? o.potion.desc : `${effectText(o.gear.effect)}, permanent once bought`;
          await say(`🛒 ${o.name} — ${effect} — ${formatCoins(o.price)}. 📖 ${lore(o)} !buy ${i + 1} to take it.`);
          return true;
        }
        const potion = findPotion(arg);
        if (potion) {
          await say(`${potion.name} — ${potion.desc} — ${formatCoins(potion.price)} when the stall has one. Not on offer right now.`);
          return true;
        }
        await say(`nothing on the stall matches "${arg}". !shop to see today's wares.`);
        return true;
      }
      const list = offers.map((o, i) => (o ? offerLine(o, i) : `#${i + 1} (sold out)`)).join(" | ");
      await say(`🛒 Today's wares: ${list}. !buy <#> to purchase, !shop <#> for details.${goldOn ? "" : " (Gold is off in this channel, so the stall can't sell.)"}`);
      return true;
    }

    case "buy": {
      const stall = await getStall(broadcasterId);
      const offers = stall.map(resolveOffer);
      if (!arg) return say(`buy which one? ${offers.map((o, i) => (o ? offerLine(o, i) : "")).filter(Boolean).join(" | ")}`).then(() => true);
      if (!goldOn) return say(goldOff).then(() => true);
      const i = findOffer(offers, arg);
      if (i < 0) return say(`no ware on the stall matches "${arg}". !shop to see what's on offer.`).then(() => true);
      const o = offers[i]!;
      if (o.kind === "gear") {
        if (!c) return say(`gear goes on a character sheet — ${noHero}`).then(() => true);
        if (ownsGear(c, o.gear)) return say(`you already carry the ${o.name}; a second one would do nothing.`).then(() => true);
      } else if ((p.potions[o.potion.key] ?? 0) >= MAX_POTION_STACK) {
        return say(`your pack can't hold more than ${MAX_POTION_STACK} of those.`).then(() => true);
      }
      if (!(await trySpend(broadcasterId, chatter, o.price))) {
        const have = (await getBalance(broadcasterId, chatter))?.balance ?? 0;
        await say(`the ${o.name} costs ${formatCoins(o.price)} and your purse holds ${formatCoins(have)}. !hunt pays better than standing still.`);
        return true;
      }
      let detail: string;
      if (o.kind === "gear") {
        const { applied, changes } = applyGear(c!, o.gear);
        await saveCharacter(c!, broadcasterId);
        detail = `It's on your sheet now: ${effectText(applied) || "a fine curio"}${changes ? ` (${changes})` : ""}.`;
      } else {
        p.potions[o.potion.key] = (p.potions[o.potion.key] ?? 0) + 1;
        await savePlayer(broadcasterId, chatter, p);
        detail = `Into the pack it goes — !use ${o.potion.name} when you need it.`;
      }
      stall[i] = rollOffer(stall.filter((_, j) => j !== i));
      await saveStall(broadcasterId, stall);
      await say(`🛒 the ${o.name} changes hands — bought from ${o.merchant} for ${formatCoins(o.price)}. ${detail} A fresh ware fills the slot. ${await nextStep(broadcasterId, chatter, c, p)}`);
      return true;
    }

    case "inv":
    case "inventory": {
      if (!c) return say(noHero).then(() => true);
      const potions = POTIONS.filter((x) => p.potions[x.key]).map((x) => `${x.name}${p.potions[x.key] > 1 ? ` x${p.potions[x.key]}` : ""}`);
      const gear = (c.items ?? []).length;
      await say(`🎒 Potions: ${potions.length ? potions.join(", ") : "none"}. Gear: ${plural(gear, "item")} on your sheet, always in effect (!gear to list it). ${await nextStep(broadcasterId, chatter, c, p)}`);
      return true;
    }

    case "use":
    case "sell":
    case "drop": {
      if (!c) return say(noHero).then(() => true);
      const potion = findPackPotion(p, arg);
      if (!potion) {
        const gearHit = arg && (c.items ?? []).some((line) => line.toLowerCase().includes(arg.toLowerCase()));
        const have = POTIONS.filter((x) => p.potions[x.key]).map((x) => x.name).join(", ") || "no potions";
        await say(gearHit
          ? "gear is bound to your character sheet and always in effect — it can't be used up, sold or dropped."
          : `${arg ? `nothing in your pack matches "${arg}".` : `${word} which potion?`} You carry: ${have}.`);
        return true;
      }
      if (word === "sell" && !goldOn) return say(goldOff).then(() => true);
      p.potions[potion.key] -= 1;
      if (word === "use") {
        const healed = rollHeal(potion.heal);
        const before = c.hpCurrent;
        c.hpCurrent = Math.min(c.hpMax, c.hpCurrent + healed);
        await Promise.all([saveCharacter(c, broadcasterId), savePlayer(broadcasterId, chatter, p)]);
        await say(`🧪 you drink the ${potion.name} and recover ${c.hpCurrent - before} HP (${c.hpCurrent}/${c.hpMax}). ${await nextStep(broadcasterId, chatter, c, p)}`);
      } else if (word === "sell") {
        const price = Math.max(1, Math.floor(potion.price * SELL_BACK_SHARE));
        await savePlayer(broadcasterId, chatter, p);
        await adjustBalance(broadcasterId, chatter, display, price);
        await say(`you sell the ${potion.name} back to the stall for ${formatCoins(price)}.`);
      } else {
        await savePlayer(broadcasterId, chatter, p);
        await say(`the ${potion.name} is left behind on the road.`);
      }
      return true;
    }

    case "purse":
    case "coinpurse": {
      if (!goldOn) return say("gold is switched off in this channel, so there's no purse to check.").then(() => true);
      const coin = (await getBalance(broadcasterId, chatter))?.balance ?? 0;
      const offers = (await getStall(broadcasterId)).map(resolveOffer).filter((o): o is ResolvedOffer => !!o);
      const cheapest = [...offers].sort((a, b) => a.price - b.price)[0];
      const afford = offers.filter((o) => o.price <= coin).sort((a, b) => a.price - b.price)[0];
      const tail = afford
        ? ` Enough for the ${afford.name} (${formatCoins(afford.price)}) — !buy it.`
        : cheapest ? ` ${formatCoins(cheapest.price - coin)} short of the cheapest ware (${cheapest.name}).` : "";
      await say(`💰 your purse holds ${formatCoins(coin)}.${tail}`);
      return true;
    }
  }
  return false;
}

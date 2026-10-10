// GuildScribe — the built-in chat commands handled directly rather than by a
// feature module. Split out of main.ts to keep files well under Val Town's
// per-file size ceiling.

import { getCharacter, saveCharacter, adjustHp, backupCharacter, loadBackup, resetCharacter, getConnections, getRecentLogs, checkGoodnightCooldown, saveCreationSession, isCommandGroupEnabled, listCustomTriggers } from "./db.ts";
import { recordDiceRollEvent, getDiceLeaderboard, getDiceStatsForUser, isChronicleEnabled } from "./social_db.ts";
import { maybeChronicleQuote } from "./chronicle.ts";
import { isNpcChatterActive, maybeNpcChatter } from "./npcs.ts";
import { handleCustomCommandInvocation, handleTriggerMatch } from "./customcommands.ts";
import { generateCharacter, handleLevelUpCommand } from "./characters.ts";
import { lookup5e, formatSpellSections, formatLookup, formatMonsterBrief } from "./lookups.ts";
import { maybeLearnFromLookup } from "./bestiary.ts";
import { env, sendChatMessage, sendChatMessages, sendSpellSections } from "./twitch.ts";
import { formatRaceName, formatStatLine, resolveCheckWithDc, modifier, logRowText, type CheckKind } from "./utils.ts";
import { PLAIN_SAVE, recordSavingThrow, getSavingThrowTally, resetSavingThrowTally, savingThrowTallyText } from "./savingthrows.ts";
import { rollDice, rollSaveContest } from "./dice.ts";
import { getBossSaves } from "./boss_saves.ts";
import { rollFate, rollHug, renderShmash } from "./flavor.ts";
import { isGoodnightMessage, goodnightReply } from "./flavor_events.ts";
import { classes } from "./data.ts";
import { chatHelpText } from "./help.ts";
import { startGuideText } from "./start.ts";
import { rollBG3Character, rollBG3Companion, rollBG3Origin, rollBG3Loot, rollBG3Camp } from "./bg3.ts";
import { findBg3Entry, formatBg3Entry, parseBg3LookupQuery, bg3CategoryList } from "./bg3lookup.ts";
import { div2Index, rollDiv2Build, rollDiv2Loot, rollDiv2Mission, div2LookupReply } from "./division2.ts";
import { PUBLIC_BASE_URL } from "./config.ts";
import { delveHelpText, getDelveOptions } from "./idle.ts";

const GOODNIGHT_COOLDOWN_MS = Math.max(30_000, Number(Deno.env.get("GOODNIGHT_COOLDOWN_MS") ?? "300000"));

async function sendWelcomeMessage(display: string, broadcasterId: string) {
  await sendChatMessages(
    `@${display} Welcome to the Guild Hall, adventurer! 📜 Create your legend with !createchar or !newchar, check your parchment with !char, gather a company with !party create <name>, and consult the archives with !dndbothelp. Full guild codex: ${PUBLIC_BASE_URL}/guide`,
    broadcasterId,
  );
}

/** A saving throw (!save dex) or skill check (!roll stealth) with the
 * roller's — or @target's — saved character. Saving throws also feed the
 * tally under the theme's brb/chat cards (savingthrows.ts). */
async function rollCharacterCheck(opts: {
  broadcasterId: string;
  chatter: string;
  display: string;
  target: string | null;
  check: { kind: CheckKind; dc: number | null };
}) {
  const { broadcasterId, chatter, display, target, check } = opts;
  const { kind } = check;
  const owner = (target || chatter).toLowerCase();
  const c = await getCharacter(owner, broadcasterId);
  if (!c) {
    await sendChatMessage(
      owner === chatter
        ? `@${display} you don't have a character yet — try !createchar`
        : `@${display} @${owner} doesn't have a character yet.`,
      broadcasterId,
    );
    return;
  }
  const abilityMod = modifier(c.scores[kind.ability]);
  const proficient = kind.type === "save" && classes[c.cls].savingThrows.includes(kind.ability);
  const total = abilityMod + (proficient ? c.proficiency : 0);
  const result = rollDice(`1d20${total === 0 ? "" : total > 0 ? `+${total}` : `${total}`}`, kind.label);
  if (!result) return;
  if (result.rawD20 === 20 || result.rawD20 === 1) {
    await recordDiceRollEvent(broadcasterId, chatter, display, result.rawD20 === 20 ? "nat20" : "nat1");
  }
  // A saving throw goes against the bot's own roll (a tie saves), unless chat
  // named a DC (!save dex dc15). The bot rolls as this stream's raid boss,
  // adding the boss's save bonus for the same ability (boss_saves.ts).
  let verdict = "";
  if (kind.type === "save" && result.rawD20 !== null) {
    let dc: number;
    if (check.dc) {
      dc = check.dc;
      verdict = result.total >= dc ? ` ✔ Saved vs DC ${dc}!` : ` ✘ Failed vs DC ${dc}!`;
    } else {
      const boss = await getBossSaves(broadcasterId);
      const botMod = boss?.mods[kind.ability] ?? 0;
      const botD20 = 1 + Math.floor(Math.random() * 20);
      dc = botD20 + botMod;
      const modText = botMod === 0 ? "" : botMod > 0 ? `+${botMod}` : `${botMod}`;
      const who = boss ? `${boss.name} (${kind.ability} ${modText || "+0"}${boss.estimated ? ", est." : ""})` : "GuildScribe";
      const botText = modText ? `1d20${modText} → [${botD20}]${modText} = ${dc}` : `1d20 → [${botD20}]`;
      verdict = ` vs 🤖 ${who}: ${botText}. ${result.total >= dc ? (result.total === dc ? "✔ Saved (tie)!" : "✔ Saved!") : "✘ Failed!"}`;
    }
    await recordSavingThrow(broadcasterId, { username: owner, displayName: target ?? display }, kind.ability, result.rawD20, result.total, dc);
  }
  await sendChatMessage(
    target ? `@${display} rolled for @${target}: ${result.text}${verdict}` : `@${display} ${result.text}${verdict}`,
    broadcasterId,
  );
}

/** The built-in chat commands that aren't in their own modules (!logs, !help, !start,
 * lookups, dice, !createchar, !char, …), custom command invocation, and
 * plain-chat replies (goodnight, triggers, chronicle, NPC chatter). Runs last
 * in main.ts's chat handling, after every module's own handler declined. */
export async function handleBuiltinChatCommand(ctx: {
  chatMessage: string;
  chatter: string;
  display: string;
  broadcasterId: string;
  isModerator: boolean;
  baseUrl: string;
}) {
  const { chatMessage, chatter, display, broadcasterId, isModerator, baseUrl } = ctx;
  if (chatMessage === "!logs") {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can use !logs.`, broadcasterId);
    } else {
      const logs = await getRecentLogs(broadcasterId, 8);
      await sendChatMessages(
        logs.length
          ? `@${display} Recent activity: ${logs.reverse().map(logRowText).join(" || ")}`
          : `@${display} no activity has been logged yet.`,
        broadcasterId,
      );
    }
  } else if (chatMessage === "!connections") {
    if (!isModerator) {
      await sendChatMessage(
        `@${display} only the broadcaster or a moderator can use !connections.`,
        broadcasterId,
      );
    } else {
      const names = await getConnections();
      await sendChatMessages(
        `@${display} Connected channels (${names.length}): ${names.length ? names.join(", ") : "none"}`,
        broadcasterId,
      );
    }
  } else if (chatMessage === "!help") {
    await sendWelcomeMessage(display, broadcasterId);
  } else if (chatMessage === "!link" || chatMessage === "!guide") {
    await sendChatMessage(
      `@${display} 📜 Guild Codex (full command guide): ${PUBLIC_BASE_URL}/guide`,
      broadcasterId,
    );
  } else if (/^!start(?:\s+\w+)?$/i.test(chatMessage)) {
    const topic = chatMessage.split(/\s+/)[1]?.toLowerCase();
    await sendChatMessages(`@${display} ${startGuideText(topic, PUBLIC_BASE_URL)}`, broadcasterId);
  } else if (/^!dndbothelp(?:\s+\w+)?$/i.test(chatMessage)) {
    const category = chatMessage.split(/\s+/)[1]?.toLowerCase();
    const help = chatHelpText(category, PUBLIC_BASE_URL);
    await sendChatMessages(`@${display} ${help}`, broadcasterId);
  } else if (/^!levelup(?:\s+\S+)*$/i.test(chatMessage)) {
    await handleLevelUpCommand(chatMessage, chatter, display, broadcasterId, isModerator);
  } else if (/^!(spell|item|class|feat|ability|race|subrace|rule|rules|monster)(?:\s+.*)?$/i.test(chatMessage)) {
    const match = chatMessage.match(
      /^!(spell|item|class|feat|ability|race|subrace|rule|rules|monster)(?:\s+(.+?))?(?:\s+\+(\d+))?$/i,
    )!;
    const kind = match[1].toLowerCase();
    const query = (match[2] ?? "").trim();
    const bonus = match[3] ? Math.min(20, Number.parseInt(match[3], 10)) : null;

    // Incomplete command — suggest syntax + examples
    if (!query) {
      const usage: Record<string, string> = {
        spell: "Usage: !spell <name> [+N]. Example: !spell fireball or !spell cure wounds +1",
        item: "Usage: !item <name> [+N]. Example: !item longsword or !item longsword +1",
        class: "Usage: !class <name>. Example: !class wizard",
        feat: "Usage: !feat <name>. Example: !feat alert",
        ability: "Usage: !ability <score>. Example: !ability strength or !ability dex",
        race: "Usage: !race <name>. Example: !race elf",
        subrace: "Usage: !subrace <name>. Example: !subrace high elf",
        rule: "Usage: !rule <topic>. Example: !rule advantage or !rule casting a spell",
        rules: "Usage: !rules <topic>. Example: !rules magic or !rules combat",
        monster: "Usage: !monster <name>. Example: !monster goblin or !monster adult red dragon",
      };
      await sendChatMessage(`@${display} ${usage[kind] ?? `Usage: !${kind} <query>`}`, broadcasterId);
    } else {
      // An API outage/timeout must still answer in chat, not go silent.
      let apiDown = false;
      const data = await lookup5e(kind, query).catch((e) => {
        console.error("5e lookup failed", e);
        apiDown = true;
        return null;
      });
      if (apiDown) {
        await sendChatMessage(`@${display} the archives (dnd5eapi.co) aren't answering right now — try !${kind} ${query} again in a moment.`, broadcasterId);
      } else if (data && kind === "spell") {
        await sendSpellSections(formatSpellSections(data, bonus), display, broadcasterId);
      } else {
        const isRule = kind === "rule" || kind === "rules";
        const isMonster = kind === "monster";
        // A monster this channel can't hunt yet is learned into its bestiary.
        const learnedNote = data && isMonster ? await maybeLearnFromLookup(broadcasterId, data, chatter) : "";
        const sent = await sendChatMessages(
          data
            ? `@${display} ${formatLookup(kind, data, bonus)}`
            : `@${display} couldn't find that ${kind}. Try e.g. !spell fireball, !item longsword, or !rule advantage`,
          broadcasterId,
          isRule ? { maxParts: 3 } : isMonster ? { maxParts: 2 } : undefined,
        );
        // Monster action text ("swallowed", "grappled"…) can trip a channel's
        // AutoMod, which drops the whole reply silently; fall back to the bare
        // stat line, which still answers the lookup.
        if (!sent && data && isMonster) {
          await sendChatMessage(`@${display} ${formatMonsterBrief(data)}`, broadcasterId);
        }
        // Its own message, so it never pushes the lookup into a long reply.
        if (learnedNote) await sendChatMessage(`@${display}${learnedNote}`, broadcasterId);
      }
    }
  } else if (/^!bg3lookup(?:\s+.*)?$/i.test(chatMessage)) {
    const raw = chatMessage.replace(/^!bg3lookup\s*/i, "").trim();
    if (!raw) {
      await sendChatMessage(
        `@${display} Usage: !bg3lookup <name>. Example: !bg3lookup astarion or !bg3lookup shadow-cursed lands. Narrow by category with !bg3lookup <category> <name> (e.g. !bg3lookup faction zhentarim). Categories: ${bg3CategoryList()}`,
        broadcasterId,
      );
    } else {
      const { category, query: term } = parseBg3LookupQuery(raw);
      const entry = findBg3Entry(term, category);
      await sendChatMessages(
        entry
          ? `@${display} ${formatBg3Entry(entry)}`
          : `@${display} couldn't find "${term}" in the BG3 knowledgebase. Try e.g. !bg3lookup astarion, !bg3lookup moonrise towers, or !bg3lookup faction zhentarim`,
        broadcasterId,
      );
    }
  } else if (/^!(?:roll|r|d20)(?:\s+.*)?$/i.test(chatMessage)) {
    // Support: !d20 | !d20 @user | !roll | !roll @user 2d6+3 | !r 4d8
    // | !roll stealth (skill check) — pulls the modifier from the roller's
    // (or @target's) saved character. Ability saving throws live on !save.
    let rest = chatMessage.replace(/^!(?:roll|r|d20)\s*/i, "").trim();
    let rollTarget: string | null = null;
    const targetMatch = rest.match(/^@(\S+)\s*(.*)$/);
    if (targetMatch) {
      rollTarget = targetMatch[1].replace(/[,:]+$/, "");
      rest = targetMatch[2].trim();
    }

    const check = rest ? resolveCheckWithDc(rest) : null;

    // Fate question: "!roll is enya going to die this time?" — only once rest
    // has already failed to resolve as a saving throw/skill check, isn't
    // targeted at another user (that path stays reserved for dice rolls),
    // and reads like a question rather than a mistyped ability/dice
    // expression (contains a space, or ends in "?").
    const isFateQuestion =
      !check && !rollTarget && !!rest && !/^\d+d\d+([+-]\d+)?$/i.test(rest) && (/\s/.test(rest) || /\?$/.test(rest));

    if (check?.kind.type === "save") {
      await sendChatMessage(
        `@${display} saving throws use !save now — try !save ${rollTarget ? `@${rollTarget} ` : ""}${rest}`,
        broadcasterId,
      );
    } else if (check) {
      await rollCharacterCheck({ broadcasterId, chatter, display, target: rollTarget, check });
    } else if (isFateQuestion) {
      await sendChatMessage(`@${display} ${rollFate(rest)}`, broadcasterId);
    } else {
      const result = rollDice(rest || "1d20");
      if (!result) {
        await sendChatMessage(
          `@${display} that's not a valid roll — try !roll, !r, !d20, !roll 2d6+3, !roll stealth, !save dex, or !roll <question>?`,
          broadcasterId,
        );
      } else {
        if (result.rawD20 === 20 || result.rawD20 === 1) {
          await recordDiceRollEvent(broadcasterId, chatter, display, result.rawD20 === 20 ? "nat20" : "nat1");
        }
        await sendChatMessage(
          rollTarget ? `@${display} rolled for @${rollTarget}: ${result.text}` : `@${display} ${result.text}`,
          broadcasterId,
        );
      }
    }
  } else if (/^!save(?:\s+.*)?$/i.test(chatMessage)) {
    // !save <ability> [dc] — an ability saving throw with the saver's
    // character sheet (!save dex, !save @user con) against the bot's 1d20,
    // or against a DC when one is named (!save wis dc15).
    // !save [@user] [modifiers] — 1d20 + optional modifiers (!save +3,
    // !save -1 +1d4) against the bot's own 1d20; ties go to the saver.
    // !save @user [modifiers] makes @user roll the saving throw instead.
    let rest = chatMessage.replace(/^!save\s*/i, "").trim();
    let saveTarget: string | null = null;
    const targetMatch = rest.match(/^@(\S+)\s*(.*)$/);
    if (targetMatch) {
      saveTarget = targetMatch[1].replace(/[,:]+$/, "");
      rest = targetMatch[2].trim();
    }
    const check = rest ? resolveCheckWithDc(rest) : null;
    if (check?.kind.type === "save") {
      await rollCharacterCheck({ broadcasterId, chatter, display, target: saveTarget, check });
    } else {
      const result = rollSaveContest(rest, saveTarget ?? undefined);
      if (!result) {
        await sendChatMessage(
          `@${display} that's not a valid save — try !save dex, !save wis dc15, !save +3, !save -1 +1d4, or !save @user +2`,
          broadcasterId,
        );
      } else {
        if (result.rawD20 === 20 || result.rawD20 === 1) {
          const kind = result.rawD20 === 20 ? "nat20" : "nat1";
          if (saveTarget) await recordDiceRollEvent(broadcasterId, saveTarget.toLowerCase(), saveTarget, kind);
          else await recordDiceRollEvent(broadcasterId, chatter, display, kind);
        }
        // Counts on the saving throws tally too, with the bot's roll as the DC.
        const saver = saveTarget ? { username: saveTarget, displayName: saveTarget } : { username: chatter, displayName: display };
        await recordSavingThrow(broadcasterId, saver, PLAIN_SAVE, result.rawD20, result.total, result.botRoll);
        await sendChatMessage(
          saveTarget
            ? `@${display} calls for a saving throw from @${saveTarget}! ${result.text}`
            : `@${display} ${result.text}`,
          broadcasterId,
        );
      }
    }
  } else if (/^!saves(?:\s+.*)?$/i.test(chatMessage)) {
    // !saves — this stream's saving throws tally; !saves reset (mod) starts it over.
    if (/^!saves\s+reset\b/i.test(chatMessage)) {
      if (!isModerator) {
        await sendChatMessage(`@${display} only the broadcaster or a moderator can reset the saving throws tally.`, broadcasterId);
      } else {
        await resetSavingThrowTally(broadcasterId);
        await sendChatMessage(`@${display} 🛡️ Saving throws tally reset — a fresh page in the ledger.`, broadcasterId);
      }
    } else {
      await sendChatMessage(`@${display} ${savingThrowTallyText(await getSavingThrowTally(broadcasterId))}`, broadcasterId);
    }
  } else if (/^!rollcall(?:\s+.*)?$/i.test(chatMessage)) {
    // !rollcall [nat1|nat20] [hour|day|week] — natural 1/20 standings
    // logged from !roll/!r/!d20 (see recordDiceRollEvent above). Kind
    // defaults to nat20; with no time frame given, shows a compact top-3
    // across all three windows in one line, otherwise a bigger top-5 for
    // just the requested window.
    //
    // !rollcall @user [hour|day|week] — one player's own nat1 AND nat20
    // counts instead of the channel-wide top list. No kind filter here
    // since the point is seeing both side by side for that person.
    const rawArgs = chatMessage.replace(/^!rollcall\s*/i, "").trim();
    const targetMatch = rawArgs.match(/@(\S+)/);
    const targetDisplay = targetMatch ? targetMatch[1].replace(/[,:]+$/, "") : null;
    const targetUser = targetDisplay ? targetDisplay.toLowerCase() : null;
    const lbWords = rawArgs.replace(/@\S+/g, "").toLowerCase().split(/\s+/).filter(Boolean);
    const windowMs: Record<"hour" | "day" | "week", number> = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
    };
    const windowAliases: Record<string, "hour" | "day" | "week"> = {
      hour: "hour", "1hr": "hour", "1h": "hour",
      day: "day", "1d": "day",
      week: "week", "1w": "week",
    };
    const requestedWindow = lbWords.map((w) => windowAliases[w]).find(Boolean);

    if (targetUser) {
      if (requestedWindow) {
        const stats = await getDiceStatsForUser(broadcasterId, targetUser, Date.now() - windowMs[requestedWindow]);
        await sendChatMessage(
          `@${display} 🎲 @${targetDisplay}'s rolls (past ${requestedWindow}): 🌟 Nat20 x${stats.nat20} | 💀 Nat1 x${stats.nat1}`,
          broadcasterId,
        );
      } else {
        const [hourStats, dayStats, weekStats] = await Promise.all([
          getDiceStatsForUser(broadcasterId, targetUser, Date.now() - windowMs.hour),
          getDiceStatsForUser(broadcasterId, targetUser, Date.now() - windowMs.day),
          getDiceStatsForUser(broadcasterId, targetUser, Date.now() - windowMs.week),
        ]);
        await sendChatMessage(
          `@${display} 🎲 @${targetDisplay}'s rolls — 🌟 Nat20 (Hour ${hourStats.nat20}, Day ${dayStats.nat20}, Week ${weekStats.nat20}) | 💀 Nat1 (Hour ${hourStats.nat1}, Day ${dayStats.nat1}, Week ${weekStats.nat1})`,
          broadcasterId,
        );
      }
    } else {
      const kind: "nat1" | "nat20" = lbWords.includes("nat1") || lbWords.includes("1") ? "nat1" : "nat20";
      const label = kind === "nat20" ? "Natural 20" : "Natural 1";
      const emoji = kind === "nat20" ? "🌟" : "💀";
      const formatEntries = (rows: { displayName: string; count: number }[]) =>
        rows.length ? rows.map((r) => `${r.displayName} x${r.count}`).join(", ") : "none yet";

      if (requestedWindow) {
        const rows = await getDiceLeaderboard(broadcasterId, kind, Date.now() - windowMs[requestedWindow], 5);
        await sendChatMessage(
          `@${display} ${emoji} ${label} leaderboard (past ${requestedWindow}): ${formatEntries(rows)}`,
          broadcasterId,
        );
      } else {
        const [hourRows, dayRows, weekRows] = await Promise.all([
          getDiceLeaderboard(broadcasterId, kind, Date.now() - windowMs.hour, 3),
          getDiceLeaderboard(broadcasterId, kind, Date.now() - windowMs.day, 3),
          getDiceLeaderboard(broadcasterId, kind, Date.now() - windowMs.week, 3),
        ]);
        await sendChatMessages(
          `@${display} ${emoji} ${label} leaderboard — Hour: ${formatEntries(hourRows)} | Day: ${formatEntries(dayRows)} | Week: ${formatEntries(weekRows)}. Try !rollcall ${
            kind === "nat20" ? "nat1" : "nat20"
          }, !rollcall ${kind} week for a bigger top 5, or !rollcall @user for one player's stats.`,
          broadcasterId,
        );
      }
    }
  } else if (chatMessage === "!bg3roll") {
    await sendChatMessage(rollBG3Character(display), broadcasterId);
  } else if (chatMessage === "!bg3companion") {
    await sendChatMessage(rollBG3Companion(display), broadcasterId);
  } else if (chatMessage === "!bg3origin") {
    await sendChatMessage(rollBG3Origin(display), broadcasterId);
  } else if (chatMessage === "!bg3loot") {
    await sendChatMessage(rollBG3Loot(display), broadcasterId);
  } else if (chatMessage === "!bg3camp") {
    await sendChatMessage(rollBG3Camp(display), broadcasterId);
  } else if (/^!div2$/i.test(chatMessage)) {
    await sendChatMessage(div2Index(display), broadcasterId);
  } else if (/^!div2build$/i.test(chatMessage)) {
    await sendChatMessages(rollDiv2Build(display), broadcasterId);
  } else if (/^!div2loot$/i.test(chatMessage)) {
    await sendChatMessage(rollDiv2Loot(display), broadcasterId);
  } else if (/^!div2mission$/i.test(chatMessage)) {
    await sendChatMessage(rollDiv2Mission(display), broadcasterId);
  } else if (/^!div2lookup(?:\s+.*)?$/i.test(chatMessage)) {
    await sendChatMessages(div2LookupReply(display, chatMessage.replace(/^!div2lookup\s*/i, "").trim()), broadcasterId);
  } else if (/^!hug(?:\s+@?\S+)?$/i.test(chatMessage)) {
    const hugMatch = chatMessage.match(/^!hug(?:\s+@?(\S+))?$/i)!;
    const hugTarget = hugMatch[1] ? hugMatch[1].toLowerCase().replace(/[,:]+$/, "") : null;
    await sendChatMessage(rollHug(display, hugTarget), broadcasterId);
  } else if (/^!shmash(?:\s+@?\S+)?$/i.test(chatMessage)) {
    // Purely cosmetic (no HP/game state touched) — pulls each side's
    // character (race/class) when they have one saved, plain username
    // otherwise, and falls back to a comedic target when none is given.
    const shmashMatch = chatMessage.match(/^!shmash(?:\s+@?(\S+))?$/i)!;
    const shmashTarget = shmashMatch[1] ? shmashMatch[1].toLowerCase().replace(/[,:]+$/, "") : null;
    const actorChar = await getCharacter(chatter, broadcasterId);
    const actorDesc = actorChar
      ? `@${display}'s ${formatRaceName(actorChar.race, actorChar.subrace)} ${actorChar.cls}`
      : `@${display}`;
    if (!shmashTarget) {
      await sendChatMessage(renderShmash(actorDesc), broadcasterId);
    } else if (shmashTarget === chatter) {
      await sendChatMessage(renderShmash(actorDesc, null, true), broadcasterId);
    } else {
      const targetChar = await getCharacter(shmashTarget, broadcasterId);
      const targetDesc = targetChar
        ? `@${shmashTarget}'s ${formatRaceName(targetChar.race, targetChar.subrace)} ${targetChar.cls}`
        : `@${shmashTarget}`;
      await sendChatMessage(renderShmash(actorDesc, targetDesc), broadcasterId);
    }
  } else if (/^!createchar(?:\s+@?\S+)?$/i.test(chatMessage)) {
    const createMatch = chatMessage.match(/^!createchar(?:\s+@?(\S+))?$/i)!;
    const createTarget = createMatch[1] ? createMatch[1].toLowerCase() : null;
    if (createTarget && createTarget !== chatter && !isModerator) {
      await sendChatMessage(
        `@${display} only the broadcaster or a moderator can create a character for someone else.`,
        broadcasterId,
      );
    } else {
      const targetUser = createTarget || chatter;
      const existing = await getCharacter(targetUser, broadcasterId);
      if (existing) {
        await saveCreationSession(
          { username: chatter, step: "confirm_createchar", targetUser },
          broadcasterId,
        );
        const forSomeoneElse = targetUser !== chatter;
        await sendChatMessage(
          `@${display} ⚠️ ${forSomeoneElse ? `@${targetUser} already has` : "you already have"} an active ${formatRaceName(existing.race, existing.subrace)} ${existing.cls} (Level ${existing.level}). Reply !answer yes to overwrite with a new random character, or !answer no to keep it.`,
          broadcasterId,
        );
      } else {
        const c = generateCharacter(targetUser);
        await saveCharacter(c, broadcasterId);
        await sendChatMessage(
          `@${display} created a level 1 ${formatRaceName(c.race, c.subrace)} ${c.cls}! ${formatStatLine(c)} — ${baseUrl}/?user=${targetUser}&channel=${broadcasterId}`,
          broadcasterId,
        );
      }
    }
  } else if (/^!char(?:\s+@?\S+)?$/i.test(chatMessage)) {
    const charMatch = chatMessage.match(/^!char(?:\s+@?(\S+))?$/i)!;
    const targetUser = charMatch[1] ? charMatch[1].toLowerCase().replace(/[,:]+$/, "") : chatter;
    const c = await getCharacter(targetUser, broadcasterId);
    if (c) {
      const label = targetUser === chatter ? "" : `@${targetUser} `;
      await sendChatMessage(
        `@${display} ${label}${formatRaceName(c.race, c.subrace)} ${c.cls} — ${formatStatLine(c)}${c.items?.length ? ` | 🎒 ${c.items.length} gear (!gear)` : ""} — ${baseUrl}/?user=${targetUser}&channel=${broadcasterId}`,
        broadcasterId,
      );
    } else {
      await sendChatMessage(
        targetUser === chatter
          ? `@${display} you don't have a character yet — try !createchar`
          : `@${display} @${targetUser} doesn't have a character yet.`,
        broadcasterId,
      );
    }
  } else if (/^!roster$/i.test(chatMessage)) {
    await sendChatMessage(
      `@${display} 📜 The guild roster — every adventurer and party in this channel: ${baseUrl}/roster?channel=${broadcasterId}`,
      broadcasterId,
    );
  } else if (/^!overlays?$/i.test(chatMessage)) {
    await sendChatMessage(
      isModerator
        ? `@${display} 🖼️ OBS overlays for this channel (raid boss, battle tracker, giveaway, leaderboards and more) — add any of them as a Browser source: ${baseUrl}/overlays?channel=${broadcasterId}`
        : `@${display} only the broadcaster or a moderator can use !overlays.`,
      broadcasterId,
    );
  } else if (/^!delve$/i.test(chatMessage)) {
    await sendChatMessage(delveHelpText(display, await getDelveOptions(broadcasterId)), broadcasterId);
  } else if (chatMessage.startsWith("!hp ")) {
    const delta = Number.parseInt(chatMessage.slice(4).trim());
    if (Number.isNaN(delta)) {
      await sendChatMessage(`@${display} use !hp +5 or !hp -3`, broadcasterId);
    } else {
      const c = await adjustHp(chatter, delta, broadcasterId);
      await sendChatMessage(
        c
          ? `@${display} HP: ${c.hpCurrent}/${c.hpMax}`
          : `@${display} you don't have a character yet — try !createchar`,
        broadcasterId,
      );
    }
  } else if (chatMessage === "!savechar") {
    await sendChatMessage(
      (await backupCharacter(chatter, broadcasterId))
        ? `@${display} character saved!`
        : `@${display} no character to save — try !createchar`,
      broadcasterId,
    );
  } else if (chatMessage === "!loadchar") {
    const c = await loadBackup(chatter, broadcasterId);
    await sendChatMessage(
      c
        ? `@${display} character loaded! ${formatStatLine(c)} — ${baseUrl}/?user=${chatter}&channel=${broadcasterId}`
        : `@${display} no saved backup found — try !savechar first`,
      broadcasterId,
    );
  } else if (/^!resetchar(?:\s+@?\S+)?$/i.test(chatMessage)) {
    const resetMatch = chatMessage.match(/^!resetchar(?:\s+@?(\S+))?$/i)!;
    const resetTarget = resetMatch[1] ? resetMatch[1].toLowerCase().replace(/[,:]+$/, "") : null;
    if (resetTarget && resetTarget !== chatter && !isModerator) {
      // Mod gate: only the broadcaster/mods may reset someone else's character.
      await sendChatMessage(
        `@${display} only the broadcaster or a moderator can reset a character for someone else.`,
        broadcasterId,
      );
    } else if (resetTarget && resetTarget !== chatter) {
      // Targeted reset (mod/broadcaster): confirm the target actually has a character first.
      const existing = await getCharacter(resetTarget, broadcasterId);
      if (!existing) {
        await sendChatMessage(`@${display} @${resetTarget} has no character to reset.`, broadcasterId);
      } else {
        await resetCharacter(resetTarget, broadcasterId);
        await sendChatMessage(
          `@${display} reset @${resetTarget}'s character — they can use !createchar to roll a new one`,
          broadcasterId,
        );
      }
    } else {
      await resetCharacter(chatter, broadcasterId);
      await sendChatMessage(
        `@${display} character reset — use !createchar to roll a new one`,
        broadcasterId,
      );
    }
  } else if (chatMessage.startsWith("!")) {
    // Nothing built-in matched — try a chat-authored custom command.
    await handleCustomCommandInvocation(chatMessage, display, broadcasterId);
  } else if (isGoodnightMessage(chatMessage)) {
    // Plain-chat "goodnight" detection (not a "!" command). Cooldown per
    // channel so a wave of goodnights from many viewers only draws one reply.
    if (await checkGoodnightCooldown(broadcasterId, GOODNIGHT_COOLDOWN_MS)) {
      await sendChatMessage(goodnightReply(), broadcasterId);
    }
  } else {
    // Plain (non-"!") chat — check passive keyword triggers first (part
    // of the "triggers" dashboard group); only roll the chronicle's random
    // quote-back (then NPC chatter) if no trigger already replied, so a
    // single message never draws two separate unprompted replies.
    // Every lookup the decision needs is an independent read — fetch them
    // in one parallel batch rather than one after another.
    const [triggersOn, triggers, chronicleOn, npcChatterOn] = await Promise.all([
      isCommandGroupEnabled(broadcasterId, "triggers"),
      listCustomTriggers(broadcasterId),
      isChronicleEnabled(broadcasterId),
      isNpcChatterActive(broadcasterId),
    ]);
    const triggerFired = triggersOn
      ? await handleTriggerMatch(chatMessage, display, broadcasterId, triggers)
      : false;
    if (!triggerFired) {
      const chronicleFired = await maybeChronicleQuote(chatMessage, display, broadcasterId, chronicleOn);
      if (!chronicleFired) {
        await maybeNpcChatter(chatMessage, display, broadcasterId, npcChatterOn);
      }
    }
  }
}

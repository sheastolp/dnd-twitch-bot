// Character generation, leveling, and guided creation wizard

import type { Ability, Character } from "./types.ts";
import { races, subraceBonuses, classes, abilityNames } from "./data.ts";
import {
  pick,
  modifier,
  rollStat,
  formatRaceName,
  formatStatLine,
  splitChatMessage,
} from "./utils.ts";
import {
  getBroadcaster,
  getCharacter,
  saveCharacter,
  getCreationSession,
  saveCreationSession,
  clearCreationSession,
  isCommandGroupEnabled,
  listCharactersElsewhere,
  importCharacter,
} from "./db.ts";
import { sendChatMessage } from "./twitch.ts";
import { getReplyInitiator, sendWhisperParts, WHISPER_MAX } from "./whisper.ts";
import { gearHpBonus } from "./gear.ts";

export function generateCharacter(username: string): Character {
  const race = pick(Object.keys(races));
  const cls = pick(Object.keys(classes));
  const raceData = races[race];
  const classData = classes[cls];
  const subrace = raceData.subraces.length ? pick(raceData.subraces) : null;
  const scores = Array.from({ length: 6 }, rollStat).sort((a, b) => b - a);
  const abilityScores = {} as Record<Ability, number>;
  classData.priority.forEach((ability, i) => (abilityScores[ability] = scores[i]));
  const bonuses: Partial<Record<Ability, number>> = {
    ...raceData.bonuses,
    ...(subrace ? subraceBonuses[subrace] : {}),
  };
  if (race === "Human" && subrace === "Variant") {
    for (const a of abilityNames) delete bonuses[a];
    bonuses[classData.priority[0]] = 1;
    bonuses[classData.priority[1]] = 1;
  }
  if (race === "Half-Elf") {
    const choices = classData.priority.filter((a) => a !== "CHA").slice(0, 2);
    bonuses[choices[0]] = 1;
    bonuses[choices[1]] = 1;
  }
  for (const a of abilityNames) {
    abilityScores[a] = Math.min(20, abilityScores[a] + (bonuses[a] ?? 0));
  }
  const hpMax = Math.max(1, classData.hitDie + modifier(abilityScores.CON));
  return {
    username,
    race,
    subrace,
    cls,
    level: 1,
    xp: 0,
    scores: abilityScores,
    speed: raceData.speed,
    hpMax,
    hpCurrent: hpMax,
    proficiency: 2,
    traits: raceData.traits,
    spells: [],
    items: [],
    feats: [],
    abilities: [],
  };
}

export function customCharacterFromSession(s: any): Character {
  const raceData = races[s.race];
  const bonuses: Partial<Record<Ability, number>> = {
    ...raceData.bonuses,
    ...(s.subrace ? subraceBonuses[s.subrace] ?? {} : {}),
  };
  const scores = {} as Record<Ability, number>;
  const rolled = s.scores as number[];
  classes[s.cls].priority.forEach((a: Ability, i: number) => {
    scores[a] = Math.min(20, rolled[i] + (bonuses[a] ?? 0));
  });
  const hp = Math.max(1, classes[s.cls].hitDie + modifier(scores.CON));
  return {
    username: s.username,
    race: s.race,
    subrace: s.subrace || null,
    cls: s.cls,
    level: 1,
    xp: 0,
    scores,
    speed: raceData.speed,
    hpMax: hp,
    hpCurrent: hp,
    proficiency: 2,
    traits: raceData.traits,
    spells: [],
    items: [],
    feats: [],
    abilities: [],
  };
}

/** 5e cumulative XP thresholds, index = level - 1 (levels 1–12 enough for bot content). */
export const XP_THRESHOLDS = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000];

/** 5e-style XP for common solo-monster CRs used by the bot. */
export function xpForMonsterCr(cr: string): number {
  const table: Record<string, number> = {
    "0": 10,
    "1/8": 25,
    "1/4": 50,
    "1/2": 100,
    "1": 200,
    "2": 450,
    "3": 700,
    "4": 1100,
    "5": 1800,
    "6": 2300,
    "7": 2900,
    "8": 3900,
    "9": 5000,
    "10": 5900,
    "11": 7200,
    "12": 8400,
    "13": 10000,
    "14": 11500,
    "15": 13000,
    "16": 15000,
    "17": 18000,
  };
  return table[String(cr).trim()] ?? 100;
}

/**
 * Award XP for defeating a monster (never for PvP).
 * Optionally auto-levels when XP crosses 5e thresholds.
 * Returns null (no XP) while the stream is offline (broadcasters.is_live,
 * kept current by stream.online/offline EventSub) — same rule as canEarnGold
 * in points_db.ts, so mods testing commands offline don't level up.
 */
export async function awardMonsterXp(
  username: string,
  cr: string,
  broadcasterId: string,
): Promise<{ gained: number; total: number; leveledTo?: number } | null> {
  const b = await getBroadcaster(broadcasterId);
  if (!b || Number(b.is_live) !== 1) return null;
  const c = await getCharacter(username, broadcasterId);
  if (!c) return null;
  const gained = xpForMonsterCr(cr);
  c.xp = (c.xp ?? 0) + gained;

  const thresholds = XP_THRESHOLDS;
  let newLevel = c.level;
  for (let lv = thresholds.length; lv >= 1; lv--) {
    if (c.xp >= thresholds[lv - 1]) {
      newLevel = Math.min(20, lv);
      break;
    }
  }
  let leveledTo: number | undefined;
  if (newLevel > c.level) {
    const classData = classes[c.cls];
    const perLevelHp = Math.max(1, Math.floor(classData.hitDie / 2) + 1 + modifier(c.scores.CON));
    const baseHp = Math.max(1, classData.hitDie + modifier(c.scores.CON));
    const oldHpMax = c.hpMax;
    c.level = newLevel;
    c.hpMax = baseHp + (newLevel - 1) * perLevelHp + gearHpBonus(c);
    c.hpCurrent = Math.max(0, Math.min(c.hpMax, c.hpCurrent + (c.hpMax - oldHpMax)));
    c.proficiency = Math.floor((newLevel - 1) / 4) + 2;
    leveledTo = newLevel;
  }
  await saveCharacter(c, broadcasterId);
  return { gained, total: c.xp, leveledTo };
}

export async function adjustLevel(username: string, delta: number, broadcasterId: string) {
  const c = await getCharacter(username, broadcasterId);
  if (!c) return { error: "no character" as const };
  if (!Number.isInteger(delta) || delta === 0) return { error: "invalid amount" as const };
  const oldLevel = c.level;
  const newLevel = Math.max(1, Math.min(20, oldLevel + delta));
  if (newLevel === oldLevel) {
    return { error: delta > 0 ? ("max level" as const) : ("min level" as const) };
  }
  const classData = classes[c.cls];
  const perLevelHp = Math.max(1, Math.floor(classData.hitDie / 2) + 1 + modifier(c.scores.CON));
  const baseHp = Math.max(1, classData.hitDie + modifier(c.scores.CON));
  const oldHpMax = c.hpMax;
  c.level = newLevel;
  c.hpMax = baseHp + (newLevel - 1) * perLevelHp + gearHpBonus(c);
  c.hpCurrent = Math.max(0, Math.min(c.hpMax, c.hpCurrent + (c.hpMax - oldHpMax)));
  c.proficiency = Math.floor((newLevel - 1) / 4) + 2;
  await saveCharacter(c, broadcasterId);
  const asi = [4, 8, 12, 16, 19].includes(newLevel) ? " Ability Score Improvement/feat available." : "";
  return { c, oldLevel, delta: newLevel - oldLevel, hpGain: c.hpMax - oldHpMax, asi };
}

function describeImport(e: { channel: string; character: Character }) {
  const c = e.character;
  return `Level ${c.level} ${formatRaceName(c.race, c.subrace)} ${c.cls} from ${e.channel}`;
}

// Everything that names another channel goes by whisper, never into this
// channel's chat: other streamers' names don't belong in someone else's chat.
// The bot can only send whispers, so the viewer still answers in chat — with
// a number from the whispered list and !answer yes, which name nothing.
async function whisperChatter(text: string) {
  const to = getReplyInitiator()?.userId;
  return !!to && sendWhisperParts(to, splitChatMessage(text, WHISPER_MAX).filter((p) => p.trim()));
}

// Who has already been whispered the !importchar hint, so a viewer typing
// !char over and over isn't whispered each time (and the bot stays well
// inside Twitch's cap on whispers to new recipients).
const hintedImport = new Set<string>();

/** Whispers "you have a character in another channel — !importchar" once per
 * viewer and channel, when they have none here, have one elsewhere, and
 * imports are switched on here. Called from the "no character yet" replies. */
export async function whisperImportHint(username: string, broadcasterId: string) {
  const key = `${broadcasterId}:${username}`;
  if (hintedImport.has(key)) return;
  if (!(await isCommandGroupEnabled(broadcasterId, "charimport"))) return;
  const elsewhere = await listCharactersElsewhere(username, broadcasterId);
  if (!elsewhere.length) return;
  hintedImport.add(key);
  const b: any = await getBroadcaster(broadcasterId);
  const here = String(b?.display_name || b?.login || "the channel");
  const more = elsewhere.length > 1 ? ` (and ${elsewhere.length - 1} more)` : "";
  await whisperChatter(`📜 You have a ${describeImport(elsewhere[0])}${more}. Type !importchar in ${here}'s chat to bring it over.`);
}

/** !importchar [n]: copy your character from another channel into this one.
 * The list and the confirm prompt are whispered; the viewer picks by number
 * and confirms with !answer yes (confirm_importchar below). */
async function handleImportChar(username: string, display: string, broadcasterId: string, arg: string) {
  const elsewhere = await listCharactersElsewhere(username, broadcasterId);
  if (!elsewhere.length) {
    await sendChatMessage(`@${display} you have no character to import — try !createchar or !newchar.`, broadcasterId);
    return;
  }
  const n = arg ? Number(arg) : elsewhere.length === 1 ? 1 : 0;
  const pick = Number.isInteger(n) && n >= 1 ? elsewhere[n - 1] : undefined;
  const b: any = await getBroadcaster(broadcasterId);
  const here = String(b?.display_name || b?.login || "the channel");
  let whispered: boolean;
  if (!pick) {
    const list = elsewhere.map((e, i) => `${i + 1}) ${describeImport(e)}`).join(" · ");
    whispered = await whisperChatter(`📜 Your characters in other channels: ${list}. Type !importchar <number> in ${here}'s chat to pick one.`);
  } else {
    await saveCreationSession({ username, step: "confirm_importchar", sourceChannel: pick.broadcasterId }, broadcasterId);
    const existing = await getCharacter(username, broadcasterId);
    const warning = existing
      ? ` ⚠️ This overwrites your active ${formatRaceName(existing.race, existing.subrace)} ${existing.cls} (Level ${existing.level}) in ${here}.`
      : "";
    whispered = await whisperChatter(
      `📜 Import your ${describeImport(pick)} into ${here}? It's a copy — the original stays where it is.${warning} Type !answer yes in ${here}'s chat to import, or !answer no to cancel.`,
    );
    if (!whispered) await clearCreationSession(username, broadcasterId);
  }
  await sendChatMessage(
    whispered
      ? `@${display} 📜 I've whispered you the import details.`
      : `@${display} I couldn't whisper you the import details — check that your whispers are open, then try !importchar again.`,
    broadcasterId,
  );
}

export async function handleCreationCommand(
  username: string,
  display: string,
  broadcasterId: string,
  chatMessage: string,
) {
  if (chatMessage === "!newchar") {
    await saveCreationSession({ username, step: "race" }, broadcasterId);
    await sendChatMessage(
      `@${display} New character started. Choose a race: ${Object.keys(races).join(", ")}. Reply !answer <race>. Type !cancel to stop.`,
      broadcasterId,
    );
    if (!(await getCharacter(username, broadcasterId))) await whisperImportHint(username, broadcasterId);
    return true;
  }
  const importMatch = chatMessage.match(/^!importchar(?:\s+(\S+))?$/i);
  if (importMatch) {
    await handleImportChar(username, display, broadcasterId, importMatch[1] ?? "");
    return true;
  }
  if (chatMessage === "!cancel") {
    const active = await getCreationSession(username, broadcasterId);
    if (!active) return false;
    await clearCreationSession(username, broadcasterId);
    await sendChatMessage(`@${display} Character creation cancelled.`, broadcasterId);
    return true;
  }
  if (!chatMessage.startsWith("!answer ")) return false;
  const s = await getCreationSession(username, broadcasterId);
  if (!s) return false;
  const answer = chatMessage.slice(8).trim();

  if (s.step === "race") {
    const race = Object.keys(races).find((x) => x.toLowerCase() === answer.toLowerCase());
    if (!race) {
      await sendChatMessage(`@${display} Choose a race from: ${Object.keys(races).join(", ")}.`, broadcasterId);
      return true;
    }
    s.race = race;
    if (races[race].subraces.length) {
      s.step = "subrace";
      await saveCreationSession(s, broadcasterId);
      await sendChatMessage(
        `@${display} Choose a ${race} subrace: ${races[race].subraces.join(", ")}. Reply !answer <subrace>.`,
        broadcasterId,
      );
    } else {
      s.step = "class";
      await saveCreationSession(s, broadcasterId);
      await sendChatMessage(
        `@${display} Choose a class: ${Object.keys(classes).join(", ")}. Reply !answer <class>.`,
        broadcasterId,
      );
    }
    return true;
  }

  if (s.step === "subrace") {
    const subrace = races[s.race].subraces.find((x) => x.toLowerCase() === answer.toLowerCase());
    if (!subrace) {
      await sendChatMessage(
        `@${display} Choose a subrace from: ${races[s.race].subraces.join(", ")}.`,
        broadcasterId,
      );
      return true;
    }
    s.subrace = subrace;
    s.step = "class";
    await saveCreationSession(s, broadcasterId);
    await sendChatMessage(
      `@${display} Choose a class: ${Object.keys(classes).join(", ")}. Reply !answer <class>.`,
      broadcasterId,
    );
    return true;
  }

  if (s.step === "class") {
    const cls = Object.keys(classes).find((x) => x.toLowerCase() === answer.toLowerCase());
    if (!cls) {
      await sendChatMessage(`@${display} Choose a class from: ${Object.keys(classes).join(", ")}.`, broadcasterId);
      return true;
    }
    s.cls = cls;
    s.step = "scores";
    await saveCreationSession(s, broadcasterId);
    await sendChatMessage(
      `@${display} Enter 6 scores in order of importance, or use standard: !answer 15 14 13 12 10 8. ${cls} priority: ${classes[cls].priority.join(", ")}.`,
      broadcasterId,
    );
    return true;
  }

  if (s.step === "scores") {
    const scores =
      answer.toLowerCase() === "standard"
        ? [15, 14, 13, 12, 10, 8]
        : answer.split(/[ ,]+/).map(Number);
    if (scores.length !== 6 || scores.some((n: number) => !Number.isInteger(n) || n < 3 || n > 18)) {
      await sendChatMessage(
        `@${display} Enter exactly 6 whole-number scores from 3 to 18, such as !answer 15 14 13 12 10 8.`,
        broadcasterId,
      );
      return true;
    }
    s.scores = scores;
    s.step = "confirm";
    await saveCreationSession(s, broadcasterId);
    const preview = customCharacterFromSession(s);
    const existing = await getCharacter(username, broadcasterId);
    const warning = existing
      ? `⚠️ This will overwrite your active ${formatRaceName(existing.race, existing.subrace)} ${existing.cls} (Level ${existing.level}). `
      : "";
    const yesAction = existing ? "overwrite and save" : "save";
    await sendChatMessage(
      `@${display} ${warning}Confirm: level 1 ${formatRaceName(preview.race, preview.subrace)} ${preview.cls}, ${formatStatLine(preview)}. Reply !answer yes to ${yesAction} or !answer no to restart.`,
      broadcasterId,
    );
    return true;
  }

  if (s.step === "confirm") {
    if (answer.toLowerCase() === "yes") {
      const c = customCharacterFromSession(s);
      await saveCharacter(c, broadcasterId);
      await clearCreationSession(username, broadcasterId);
      await sendChatMessage(
        `@${display} Character saved! Use !char, !levelup, !savechar, and !loadchar.`,
        broadcasterId,
      );
    } else if (answer.toLowerCase() === "no") {
      await clearCreationSession(username, broadcasterId);
      await sendChatMessage(`@${display} Character discarded. Start again with !newchar.`, broadcasterId);
    } else {
      await sendChatMessage(`@${display} Reply !answer yes to save or !answer no to discard.`, broadcasterId);
    }
    return true;
  }

  // Pending confirmation for !createchar overwriting an existing active
  // character (see main.ts). Kept here so all "!answer" routing for
  // character creation lives in one place.
  if (s.step === "confirm_createchar") {
    const targetUser = s.targetUser ?? username;
    if (answer.toLowerCase() === "yes") {
      const c = generateCharacter(targetUser);
      await saveCharacter(c, broadcasterId);
      await clearCreationSession(username, broadcasterId);
      const forSomeoneElse = targetUser !== username;
      await sendChatMessage(
        `@${display} rolled a new level 1 ${formatRaceName(c.race, c.subrace)} ${c.cls}${forSomeoneElse ? ` for @${targetUser}` : ""}, overwriting the old one! ${formatStatLine(c)}`,
        broadcasterId,
      );
    } else if (answer.toLowerCase() === "no") {
      await clearCreationSession(username, broadcasterId);
      await sendChatMessage(
        `@${display} kept the existing character${targetUser !== username ? ` for @${targetUser}` : ""}. No changes made.`,
        broadcasterId,
      );
    } else {
      await sendChatMessage(`@${display} Reply !answer yes to overwrite or !answer no to keep the existing character.`, broadcasterId);
    }
    return true;
  }

  if (s.step === "confirm_importchar") {
    if (answer.toLowerCase() === "yes") {
      await clearCreationSession(username, broadcasterId);
      const c = s.sourceChannel ? await importCharacter(username, s.sourceChannel, broadcasterId) : null;
      await sendChatMessage(
        c
          ? `@${display} imported your level ${c.level} ${formatRaceName(c.race, c.subrace)} ${c.cls}! ${formatStatLine(c)}`
          : `@${display} that character isn't there anymore — nothing was imported.`,
        broadcasterId,
      );
    } else if (answer.toLowerCase() === "no") {
      await clearCreationSession(username, broadcasterId);
      await sendChatMessage(`@${display} import cancelled. No changes made.`, broadcasterId);
    } else {
      await sendChatMessage(`@${display} Reply !answer yes to import or !answer no to cancel.`, broadcasterId);
    }
    return true;
  }

  return false;
}

/** !levelup [+/-N] | !levelup @user [+/-N] | !levelup [+/-N] @user (mod only). Moved out of main.ts for Val Town's file-size limit. */
export async function handleLevelUpCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
) {
  // !levelup [+/-N] | !levelup @user [+/-N] | !levelup [+/-N] @user (mod only)
  const args = chatMessage.split(/\s+/).slice(1);
  let delta = 1;
  let levelTarget: string | null = null;
  let validArgs = true;
  if (args.length > 2) validArgs = false;
  for (const arg of args) {
    if (/^[+-]\d+$/.test(arg)) delta = Number.parseInt(arg, 10);
    else if (/^@?\w+$/.test(arg) && levelTarget === null) levelTarget = arg.replace(/^@/, "").toLowerCase();
    else validArgs = false;
  }
  if (!isModerator) {
    await sendChatMessage(
      `@${display} only the broadcaster or a moderator can use !levelup.`,
      broadcasterId,
    );
  } else if (!validArgs) {
    await sendChatMessage(
      `@${display} use !levelup, !levelup +2, !levelup @user, or !levelup @user -1`,
      broadcasterId,
    );
  } else {
    const targetUser = levelTarget || chatter;
    const forSomeoneElse = targetUser !== chatter;
    const subject = forSomeoneElse ? `@${targetUser}` : "you";
    const result = await adjustLevel(targetUser, delta, broadcasterId);
    if ("error" in result) {
      const errorText =
        result.error === "no character"
          ? forSomeoneElse
            ? `@${targetUser} doesn't have a character yet — try !createchar @${targetUser}`
            : "you don't have a character yet — try !createchar"
          : result.error === "max level"
            ? `${subject === "you" ? "you're" : `${subject} is`} already level 20`
            : result.error === "min level"
              ? `${subject === "you" ? "you're" : `${subject} is`} already level 1`
              : "use !levelup, !levelup +2, !levelup @user, or !levelup @user -1";
      await sendChatMessage(`@${display} ${errorText}`, broadcasterId);
    } else {
      const direction = result.delta > 0 ? "advanced" : "reduced";
      const hpChange = result.hpGain >= 0 ? `HP +${result.hpGain}` : `HP ${result.hpGain}`;
      await sendChatMessage(
        `@${display} ${forSomeoneElse ? `@${targetUser}'s level` : "level"} ${direction} from ${result.oldLevel} to ${result.c.level}; ${hpChange}, HP ${result.c.hpCurrent}/${result.c.hpMax}, Prof +${result.c.proficiency}.${result.asi}`,
        broadcasterId,
      );
    }
  }
}

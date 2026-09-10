// Character generation, leveling, and guided creation wizard

import type { Ability, Character } from "./types.ts";
import { races, subraceBonuses, classes, abilityNames } from "./data.ts";
import {
  pick,
  modifier,
  rollStat,
  formatRaceName,
  formatStatLine,
} from "./utils.ts";
import {
  getCharacter,
  saveCharacter,
  getCreationSession,
  saveCreationSession,
  clearCreationSession,
} from "./db.ts";
import { sendChatMessage } from "./twitch.ts";

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
  };
  return table[String(cr).trim()] ?? 100;
}

/**
 * Award XP for defeating a monster (never for PvP).
 * Optionally auto-levels when XP crosses 5e thresholds.
 */
export async function awardMonsterXp(
  username: string,
  cr: string,
  broadcasterId: string,
): Promise<{ gained: number; total: number; leveledTo?: number } | null> {
  const c = await getCharacter(username, broadcasterId);
  if (!c) return null;
  const gained = xpForMonsterCr(cr);
  c.xp = (c.xp ?? 0) + gained;

  // 5e cumulative XP thresholds (levels 1–12 enough for bot content)
  const thresholds = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000];
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
    c.hpMax = baseHp + (newLevel - 1) * perLevelHp;
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
  c.hpMax = baseHp + (newLevel - 1) * perLevelHp;
  c.hpCurrent = Math.max(0, Math.min(c.hpMax, c.hpCurrent + (c.hpMax - oldHpMax)));
  c.proficiency = Math.floor((newLevel - 1) / 4) + 2;
  await saveCharacter(c, broadcasterId);
  const asi = [4, 8, 12, 16, 19].includes(newLevel) ? " Ability Score Improvement/feat available." : "";
  return { c, oldLevel, delta: newLevel - oldLevel, hpGain: c.hpMax - oldHpMax, asi };
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

  return false;
}

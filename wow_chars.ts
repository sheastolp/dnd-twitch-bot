// !wowchar — make a World of Warcraft (Classic + Forever) character that
// plays the GuildScribe game alongside the 5e ones.
//
// The character is a normal saved Character: its race is the WoW race (a
// Skyborne's subrace is its branch, so it reads "Windshaper Skyborne"), its
// `cls` is the 5e class that does the fighting (wow_data.ts maps Warrior →
// Fighter, Shaman → Cleric …), and `wow` keeps the faction and WoW class that
// chat sees. Duels, hunts, raids, XP, gear and the shop all work unchanged.
//
//   !wowchar                       step by step: faction → race → class
//   !wowchar horde tauren druid    any of the three, in any order; asks the rest
//   !wowchar random                rolls all three
//   !wowchar classes               the race/class table, short
//
// Scores are rolled (4d6, drop the lowest), the best put where the class
// needs them, plus the race's bonuses; "!answer reroll" rolls again at the
// confirm step. Steps are creation_sessions rows with a "wow_" step prefix
// (race = WoW race, subrace = Skyborne branch, cls = WoW class, background =
// faction, scores = the rolled six, best first).

import type { Ability, Character } from "./types.ts";
import { classes } from "./data.ts";
import { clearCreationSession, getCharacter, getCreationSession, saveCharacter, saveCreationSession } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";
import { formatRaceName, formatStatLine, heroTitle, modifier, pick, rollStat } from "./utils.ts";
import {
  FACTION_ICON,
  factionHint,
  factionsFor,
  findWowClass,
  findWowFaction,
  findWowRaceName,
  racesFor,
  WOW_CLASSES,
  WOW_FACTIONS,
  WOW_RACES,
  wowRace,
  type WowClassName,
  type WowFaction,
  type WowRace,
} from "./wow_data.ts";

const ABILITIES: Ability[] = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];

/** The pieces a !wowchar line names, plus anything it couldn't place. */
export function parseWowPicks(text: string): {
  faction: WowFaction | null;
  race: string | null;
  cls: WowClassName | null;
  unknown: string[];
} {
  let faction: WowFaction | null = null;
  let race: string | null = null;
  let cls: WowClassName | null = null;
  const unknown: string[] = [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    // Two-word names first: "night elf", "high order", "skyborne elf".
    const pair = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : "";
    if (pair && !race && findWowRaceName(pair)) {
      race = findWowRaceName(pair);
      faction = faction ?? factionHint(pair);
      i++;
      continue;
    }
    const w = words[i];
    const f = findWowFaction(w);
    if (f && !faction) { faction = f; continue; }
    const r = findWowRaceName(w);
    if (r && !race) { race = r; faction = faction ?? factionHint(w); continue; }
    const c = findWowClass(w);
    if (c && !cls) { cls = c; continue; }
    unknown.push(w);
  }
  return { faction, race, cls, unknown };
}

/** Fills in what the picks leave open where only one choice fits. */
function settle(p: { faction: WowFaction | null; race: string | null; cls: WowClassName | null }) {
  let { faction, race } = p;
  const cls = p.cls;
  if (race && !faction) {
    const all = WOW_RACES.filter((r) => r.name === race);
    const fits = all.filter((r) => !cls || r.classes.includes(cls));
    if (fits.length === 1) faction = fits[0].faction;
    else if (all.length === 1) faction = all[0].faction;
  }
  if (!race && faction && cls) {
    const fits = racesFor(faction).filter((r) => r.classes.includes(cls));
    if (fits.length === 1) race = fits[0].name;
  }
  return { faction, race, cls };
}

function raceList(faction: WowFaction, cls: WowClassName | null): string {
  return racesFor(faction)
    .filter((r) => !cls || r.classes.includes(cls))
    .map((r) => `${r.name}${r.forever ? "*" : ""}`)
    .join(", ");
}

function classList(r: WowRace): string {
  return r.classes.map((c) => `${c}${r.foreverClasses?.includes(c) ? "*" : ""}`).join(", ");
}

/** Six rolled scores, best first. */
function rollSix(): number[] {
  return Array.from({ length: 6 }, rollStat).sort((a, b) => b - a);
}

/** The saved character for a finished session. */
export function buildWowCharacter(
  username: string,
  pick_: { faction: WowFaction; race: string; cls: WowClassName },
  rolled: number[],
): Character {
  const race = wowRace(pick_.race, pick_.faction)!;
  const wc = WOW_CLASSES[pick_.cls];
  const classData = classes[wc.dnd];
  const scores = {} as Record<Ability, number>;
  classData.priority.forEach((a: Ability, i: number) => (scores[a] = rolled[i]));
  for (const a of ABILITIES) scores[a] = Math.min(20, (scores[a] ?? 10) + (race.bonuses[a] ?? 0));
  const hpMax = Math.max(1, classData.hitDie + modifier(scores.CON));
  return {
    username,
    race: race.name,
    subrace: race.branch ?? null,
    cls: wc.dnd,
    level: 1,
    xp: 0,
    scores,
    speed: race.speed,
    hpMax,
    hpCurrent: hpMax,
    proficiency: 2,
    traits: [...race.traits],
    spells: [],
    items: [],
    feats: [],
    abilities: [],
    wow: { faction: race.faction, cls: pick_.cls },
  };
}

/** "🐺 Horde Tauren Druid (plays as a 5e Druid)" */
export function wowLabel(c: Pick<Character, "race" | "subrace" | "cls" | "wow">): string {
  if (!c.wow) return heroTitle(c);
  const f = c.wow.faction;
  return `${FACTION_ICON[f]} ${f} ${heroTitle(c)}`;
}

function classTable(): string {
  return WOW_FACTIONS.map((f) =>
    `${FACTION_ICON[f]} ${f}: ` + racesFor(f).map((r) => `${r.branch ? `${r.name} (${r.branch})` : r.name} ${r.classes.map((c) => c.slice(0, 3)).join("/")}`).join(" · ")
  ).join(" | ");
}

/** Asks for whatever is still missing, or moves on to the confirm step. */
async function nextStep(s: any, display: string, broadcasterId: string, username: string) {
  const say = (t: string) => sendChatMessage(`@${display} ${t}`, broadcasterId);
  const settled = settle({ faction: s.background ?? null, race: s.race ?? null, cls: s.cls ?? null });
  s.background = settled.faction;
  s.race = settled.race;
  s.cls = settled.cls;
  if (!s.background) {
    s.step = "wow_faction";
    await saveCreationSession(s, broadcasterId);
    const forRace = s.race && factionsFor(s.race).length > 1 ? ` (${s.race} can be either)` : "";
    await say(`⚔️ For the Alliance or for the Horde?${forRace} Reply !answer alliance or !answer horde. !cancel stops.`);
    return;
  }
  const faction = s.background as WowFaction;
  if (s.race && !wowRace(s.race, faction)) {
    const theirs = WOW_RACES.find((r) => r.name === s.race)?.faction;
    s.race = null;
    s.step = "wow_race";
    await saveCreationSession(s, broadcasterId);
    await say(`${theirs ? `that race fights for the ${theirs}. ` : ""}Pick ${faction === "Alliance" ? "an" : "a"} ${faction} race: ${raceList(faction, s.cls)}. Reply !answer <race>. (* = new in Forever)`);
    return;
  }
  if (!s.race) {
    s.step = "wow_race";
    await saveCreationSession(s, broadcasterId);
    const none = s.cls && !raceList(faction, s.cls);
    if (none) s.cls = null;
    await say(
      `${FACTION_ICON[faction]} ${faction}! ${none ? "No race there plays that class, so pick a race first: " : "Pick a race: "}${raceList(faction, s.cls)}. ` +
        `Reply !answer <race>. (* = new in Forever)`,
    );
    return;
  }
  const race = wowRace(s.race, faction)!;
  if (s.cls && !race.classes.includes(s.cls)) {
    const bad = s.cls;
    s.cls = null;
    s.step = "wow_class";
    await saveCreationSession(s, broadcasterId);
    await say(`a ${s.race} can't be a ${bad}. Pick a class: ${classList(race)}. Reply !answer <class>. (* = new in Forever)`);
    return;
  }
  if (!s.cls) {
    s.step = "wow_class";
    await saveCreationSession(s, broadcasterId);
    await say(`${formatRaceName(race.name, race.branch ?? null)} it is. Pick a class: ${classList(race)}. Reply !answer <class>. (* = new in Forever)`);
    return;
  }
  s.scores = Array.isArray(s.scores) && s.scores.length === 6 ? s.scores : rollSix();
  s.step = "wow_confirm";
  await saveCreationSession(s, broadcasterId);
  const preview = buildWowCharacter(username, { faction, race: s.race, cls: s.cls }, s.scores);
  const existing = await getCharacter(username, broadcasterId);
  const warning = existing ? `⚠️ This replaces your active ${heroTitle(existing)} (Level ${existing.level}). ` : "";
  const wc = WOW_CLASSES[s.cls as WowClassName];
  await say(
    `${warning}${wc.icon} Level 1 ${wowLabel(preview)} — ${wc.blurb}; fights as a 5e ${wc.dnd}. ` +
      `${formatStatLine(preview)} | ${race.traits.slice(0, 3).join(", ")}. ` +
      `Reply !answer yes to save, !answer reroll for new scores, or !answer no to stop.`,
  );
}

export async function handleWowCharCommand(
  username: string,
  display: string,
  broadcasterId: string,
  chatMessage: string,
  baseUrl: string,
): Promise<boolean> {
  const say = (t: string) => sendChatMessage(`@${display} ${t}`, broadcasterId);
  const m = chatMessage.match(/^!wowchar(?:\s+(.*))?$/i);
  if (m) {
    const arg = (m[1] ?? "").trim();
    if (/^(classes|races|table|list)$/i.test(arg)) {
      await say(`${classTable()} — !wowchar <faction> <race> <class> to make one.`);
      return true;
    }
    if (/^help$/i.test(arg)) {
      await say(
        "!wowchar makes a WoW Classic/Forever hero who fights alongside the D&D adventurers (duels, hunts, raids). " +
          "!wowchar step by step, !wowchar horde orc warrior in one go, !wowchar random, !wowchar classes for the table.",
      );
      return true;
    }
    const s: any = { username, step: "wow_faction", race: null, subrace: null, cls: null, background: null, scores: null };
    if (/^(random|roll)$/i.test(arg)) {
      const race = pick(WOW_RACES);
      s.background = race.faction;
      s.race = race.name;
      s.cls = pick(race.classes);
    } else if (arg) {
      const p = parseWowPicks(arg);
      if (p.unknown.length && !p.faction && !p.race && !p.cls) {
        await say(`I don't know "${p.unknown.join(" ")}". Try !wowchar horde tauren druid, !wowchar random or !wowchar classes.`);
        return true;
      }
      s.background = p.faction;
      s.race = p.race;
      s.cls = p.cls;
    }
    await nextStep(s, display, broadcasterId, username);
    return true;
  }

  if (!/^!answer\s/i.test(chatMessage)) return false;
  const s: any = await getCreationSession(username, broadcasterId);
  if (!s || !String(s.step).startsWith("wow_")) return false;
  const answer = chatMessage.replace(/^!answer\s+/i, "").trim();

  if (s.step === "wow_faction") {
    const p = parseWowPicks(answer);
    if (!p.faction) {
      await say("Reply !answer alliance or !answer horde (or !cancel).");
      return true;
    }
    s.background = p.faction;
    s.race = s.race ?? p.race;
    s.cls = s.cls ?? p.cls;
  } else if (s.step === "wow_race") {
    const p = parseWowPicks(answer);
    if (!p.race) {
      await say(`Pick a race: ${raceList(s.background, s.cls)}. Reply !answer <race>.`);
      return true;
    }
    s.race = p.race;
    s.cls = s.cls ?? p.cls;
  } else if (s.step === "wow_class") {
    const cls = findWowClass(answer);
    const race = wowRace(s.race, s.background);
    if (!cls || !race) {
      await say(`Pick a class: ${race ? classList(race) : "Warrior"}. Reply !answer <class>.`);
      return true;
    }
    s.cls = cls;
  } else if (s.step === "wow_confirm") {
    const a = answer.toLowerCase();
    if (a === "reroll" || a === "re-roll") {
      s.scores = rollSix();
    } else if (a === "yes" || a === "y") {
      const c = buildWowCharacter(username, { faction: s.background, race: s.race, cls: s.cls }, s.scores);
      await saveCharacter(c, broadcasterId);
      await clearCreationSession(username, broadcasterId);
      await say(
        `${FACTION_ICON[c.wow!.faction]} ${c.wow!.faction === "Horde" ? "Lok'tar ogar!" : "For the Alliance!"} ` +
          `Saved your level 1 ${heroTitle(c)} — ${formatStatLine(c)}. Duel, !hunt and raid like any adventurer. ` +
          `${baseUrl}/?user=${username}&channel=${broadcasterId}`,
      );
      return true;
    } else if (a === "no" || a === "n") {
      await clearCreationSession(username, broadcasterId);
      await say("WoW character discarded. Start again any time with !wowchar.");
      return true;
    } else {
      await say("Reply !answer yes to save, !answer reroll for new scores, or !answer no to stop.");
      return true;
    }
  } else {
    return false;
  }
  await nextStep(s, display, broadcasterId, username);
  return true;
}

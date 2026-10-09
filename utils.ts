// Pure helpers and small shared utilities

import type { Ability, Character } from "./types.ts";
import { abilityNames, abilityAliases, abilityFullNames, skillAbilities, findMonsterByName } from "./data.ts";

export const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

export const modifier = (score: number) => Math.floor((score - 10) / 2);

export function rollStat() {
  const d = Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 6)).sort((a, b) => b - a);
  return d[0] + d[1] + d[2];
}

export function formatRaceName(race: string, subrace: string | null) {
  if (!subrace) return race.trim();
  const nr = race.trim().toLowerCase();
  const ns = subrace.trim().toLowerCase();
  return ns === nr || ns.endsWith(` ${nr}`) ? subrace.trim() : `${subrace.trim()} ${race.trim()}`;
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]!));
}

export function formatStatLine(c: Character) {
  return `Lv${c.level} XP ${c.xp ?? 0} | ${abilityNames
    .map((a) => `${a} ${c.scores[a]}(${modifier(c.scores[a]) >= 0 ? "+" : ""}${modifier(c.scores[a])})`)
    .join(" ")} | HP ${c.hpCurrent}/${c.hpMax} | Speed ${c.speed}ft | Prof +${c.proficiency}`;
}

// ---------------------------------------------------------------------------
// Combat math from the character's own modifiers. Each part of a swing uses
// the ability that drives it in 5e, so a sheet's spread matters in a fight:
// - to-hit and damage: the class's attack ability — the casting stat for
//   spellcasters (INT/WIS/CHA), else the better of STR and DEX (finesse);
// - AC: DEX, plus CON for a Barbarian and WIS for a Monk (Unarmored
//   Defense); Fighters and Paladins wear heavy armor, which ignores a low DEX
//   (counts as at least +2);
// - initiative: DEX; holding on at 0 HP (fate's roll): CON.
// Proficiency still feeds to-hit and AC: the bestiary's level scaling
// (scaleMonsterForLevel in data.ts) is tuned against it.
// ---------------------------------------------------------------------------

const CASTING_ABILITY: Record<string, Ability> = {
  wizard: "INT",
  artificer: "INT",
  cleric: "WIS",
  druid: "WIS",
  bard: "CHA",
  sorcerer: "CHA",
  warlock: "CHA",
};
const UNARMORED_DEFENSE: Record<string, Ability> = { barbarian: "CON", monk: "WIS" };
const HEAVY_ARMOR = new Set(["fighter", "paladin"]);
/** What heavy armor counts as when the hero's DEX modifier is lower. */
const HEAVY_ARMOR_BONUS = 2;

const score = (c: Pick<Character, "scores">, a: Ability) => Number(c.scores?.[a] ?? 10);
const classKey = (c: { cls?: string }) => String(c.cls ?? "").trim().toLowerCase();

/** The ability a hero attacks (and deals damage) with: the casting stat for
 * spellcasters, else STR or DEX, whichever is higher (STR on a tie). */
export function attackAbility(c: Pick<Character, "scores"> & { cls?: string }): Ability {
  const casting = CASTING_ABILITY[classKey(c)];
  if (casting) return casting;
  return score(c, "DEX") > score(c, "STR") ? "DEX" : "STR";
}

/** A hero's AC and the labelled parts it's built from, e.g.
 * { ac: 17, parts: [["DEX", 2], ["CON", 3], ["prof", 2]] } on base 10. */
export function heroAc(
  c: Pick<Character, "scores" | "proficiency"> & { cls?: string },
  base = 10,
): { ac: number; parts: Array<[string, number]> } {
  const cls = classKey(c);
  const dex = modifier(score(c, "DEX"));
  const parts: Array<[string, number]> = HEAVY_ARMOR.has(cls) && dex < HEAVY_ARMOR_BONUS
    ? [["heavy armor", HEAVY_ARMOR_BONUS]]
    : [["DEX", dex]];
  const extra = UNARMORED_DEFENSE[cls];
  if (extra) parts.push([extra, modifier(score(c, extra))]);
  parts.push(["prof", Number(c.proficiency ?? 2)]);
  return { ac: base + parts.reduce((a, [, v]) => a + v, 0), parts };
}

/** Initiative bonus: the DEX modifier. */
export const initiativeMod = (c: Pick<Character, "scores">) => modifier(score(c, "DEX"));

/** Rolls initiative: d20 + DEX. */
export function rollInitiative(c: Pick<Character, "scores">): { roll: number; total: number } {
  const roll = 1 + Math.floor(Math.random() * 20);
  return { roll, total: roll + initiativeMod(c) };
}

/** A hero's attack numbers: `ability`/`mod` drive to-hit and damage,
 * `toHit` = mod + proficiency, `die` is the damage die, `ac` their AC on
 * the usual base of 10 (see heroAc). */
export function combatStats(c: Character) {
  const ability = attackAbility(c);
  const mod = modifier(score(c, ability));
  return { ability, mod, toHit: mod + c.proficiency, die: 8, ac: heroAc(c, 10).ac };
}

// Which accounts are bots — the list to edit is in bot_accounts.ts.
export { isBotAccount } from "./bot_accounts.ts";

/** Chat badges that count as "mod or higher" everywhere the bot checks
 * isModerator — including the offline-quiet gate in main.ts, so all of these
 * can use every command while the stream is offline. Twitch's Lead Moderator
 * role has its own badge (not "moderator"), so it must be listed explicitly. */
const MOD_PLUS_BADGES = new Set(["broadcaster", "lead_moderator", "moderator"]);

export function hasModeratorBadge(event: any) {
  const badges = [...(event?.badges ?? []), ...(event?.source_badges ?? [])];
  return badges.some((badge: any) => MOD_PLUS_BADGES.has(String(badge?.set_id ?? "")));
}

export type CheckKind =
  | { type: "save"; ability: Ability; label: string }
  | { type: "skill"; ability: Ability; label: string };

/**
 * Resolve chat input like "dex", "dexterity", or "stealth" to a saving-throw
 * ability or a skill (and its governing ability). Returns null for anything
 * that isn't a recognized ability/skill name (e.g. a dice expression).
 */
export function resolveCheckKind(input: string): CheckKind | null {
  const key = input.trim().toLowerCase();
  if (!key) return null;

  const ability = abilityAliases[key];
  if (ability) {
    return { type: "save", ability, label: `${abilityFullNames[ability]} Saving Throw` };
  }

  const collapsed = key.replace(/\s+/g, "");
  const skillEntry = Object.entries(skillAbilities).find(([name]) => name.replace(/\s+/g, "") === collapsed);
  if (skillEntry) {
    const [name, skillAbility] = skillEntry;
    const label = name
      .split(" ")
      .map((word, i) => (i > 0 && word === "of" ? word : word.charAt(0).toUpperCase() + word.slice(1)))
      .join(" ");
    return { type: "skill", ability: skillAbility, label: `${label} Check` };
  }

  return null;
}

/**
 * resolveCheckKind, plus an optional DC on a saving throw: "dex dc15",
 * "dex dc 15" or "dex 15" (DC 1–30). Skill checks take no DC.
 */
export function resolveCheckWithDc(input: string): { kind: CheckKind; dc: number | null } | null {
  const kind = resolveCheckKind(input);
  if (kind) return { kind, dc: null };
  const m = input.trim().match(/^(.+?)\s+(?:dc\s*)?(\d{1,2})$/i);
  const save = m ? resolveCheckKind(m[1]) : null;
  const dc = m ? Number(m[2]) : 0;
  return save?.type === "save" && dc >= 1 && dc <= 30 ? { kind: save, dc } : null;
}

export function compactText(value: unknown, max = 240) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/<[^>]+>/g, "")
    .trim()
    .slice(0, max);
}

export function splitChatMessage(text: string, max = 300) {
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf(" ", max);
    if (cut < 1) cut = max;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function firstAlive(members: string[], hp: Record<string, number>) {
  return members.findIndex((name) => Number(hp[name]) > 0);
}

export function logRowText(r: any) {
  return `${new Date(Number(r.created_at)).toISOString()} | @${r.username} | ${r.action} | ${r.detail}`;
}

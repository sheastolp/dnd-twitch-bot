// Pure helpers and small shared utilities

import type { Ability, Character } from "./types.ts";
import { abilityNames, abilityAliases, abilityFullNames, skillAbilities, knownBotAccounts, findMonsterByName } from "./data.ts";

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

export function combatStats(c: Character) {
  const ability = Math.max(c.scores.STR, c.scores.DEX);
  const mod = modifier(ability);
  return { attack: 10 + mod + c.proficiency, mod, die: 8 };
}

export function isBotAccount(username: string, userId: string, botUserId: string) {
  const normalized = username.toLowerCase();
  const configured = (Deno.env.get("BOT_USERNAMES") ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return (
    userId === botUserId ||
    knownBotAccounts.has(normalized) ||
    configured.includes(normalized) ||
    normalized.endsWith("bot")
  );
}

export function hasModeratorBadge(event: any) {
  const badges = [...(event?.badges ?? []), ...(event?.source_badges ?? [])];
  return badges.some((badge: any) => badge.set_id === "moderator" || badge.set_id === "broadcaster");
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

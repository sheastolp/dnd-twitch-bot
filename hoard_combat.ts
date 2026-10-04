// Hunt and Hoard inside GuildScribe's combat. While the module is open in a
// channel (!hoard on), wounds are shared by every monster fight — !hunt,
// !dndduel solo and party hunts (auto and classic), !autohunt and raids:
//
//   - a fight starts at the hero's current HP (the sheet's hpCurrent, after
//     catching up passive regen) instead of full HP;
//   - whatever HP the fight leaves is written back, never below 1 — nobody
//     dies, but a hero at 1 HP has to !rest or drink a potion (!use) first;
//   - autohunt rests a low hero to 80% instead of fighting that bout, the way
//     Hunt & Hoard's own autohunt did.
//
// With the module off, every helper here is a no-op and fights start at full
// HP as they always have. PvP (duels, !rob) never uses wounds.
//
// Order matters: settle wounds BEFORE awardMonsterXp, which re-reads the
// sheet and raises current HP with max HP on a level-up.

import { getCharacter, saveCharacter, sqlite } from "./db.ts";
import { getPlayer, type HoardPlayer, isHoardEnabled, savePlayer } from "./hoard_db.ts";
import { LOW_HP_FRACTION, REGEN_HP, REGEN_INTERVAL_MS, REST_FRACTION } from "./hoard_data.ts";
import type { Character } from "./types.ts";

/** Catch-up regen for however long it's been. Mutates both; true if either
 * changed (caller saves). */
export function applyRegen(c: Character, p: HoardPlayer): boolean {
  const now = Date.now();
  // Topped up: keep the clock fresh (at most one save per interval), so a
  // later wound doesn't cash in hours of banked regen.
  if (!p.lastHealAt || c.hpCurrent >= c.hpMax) {
    if (p.lastHealAt && now - p.lastHealAt < REGEN_INTERVAL_MS) return false;
    p.lastHealAt = now;
    return true;
  }
  const ticks = Math.floor((now - p.lastHealAt) / REGEN_INTERVAL_MS);
  if (ticks <= 0) return false;
  c.hpCurrent = Math.min(c.hpMax, c.hpCurrent + ticks * REGEN_HP);
  p.lastHealAt += ticks * REGEN_INTERVAL_MS;
  return true;
}

export const isLowHp = (c: Pick<Character, "hpCurrent" | "hpMax">) =>
  c.hpCurrent <= Math.max(1, Math.ceil(c.hpMax * LOW_HP_FRACTION));

/** Loads the hero and their pack, applying regen. */
export async function loadHero(broadcasterId: string, username: string): Promise<{ c: Character | null; p: HoardPlayer }> {
  const [c, p] = await Promise.all([getCharacter(username, broadcasterId), getPlayer(broadcasterId, username)]);
  if (c && applyRegen(c, p)) await Promise.all([saveCharacter(c, broadcasterId), savePlayer(broadcasterId, username, p)]);
  return { c, p };
}

/** Whether wounds carry between fights in this channel. */
export const woundsOn = (broadcasterId: string) => isHoardEnabled(broadcasterId);

/**
 * The HP a hero walks into a fight with: full when wounds are off, otherwise
 * their current HP after regen (also written onto `c.hpCurrent`).
 */
export async function startHp(broadcasterId: string, c: Character, wounds: boolean): Promise<number> {
  if (!wounds) return c.hpMax;
  const p = await getPlayer(broadcasterId, c.username);
  if (applyRegen(c, p)) await Promise.all([saveCharacter(c, broadcasterId), savePlayer(broadcasterId, c.username, p)]);
  return Math.max(1, Math.min(c.hpMax, c.hpCurrent));
}

/** Writes a fight's leftover HP back to the sheet (never below 1). No-op
 * when wounds are off. Call before awarding XP. */
export async function settleWounds(broadcasterId: string, username: string, hpAfter: number, wounds: boolean) {
  if (!wounds) return;
  await sqlite.execute(
    "UPDATE characters SET hp_current = MAX(1, MIN(hp_max, ?)) WHERE broadcaster_id = ? AND username = ?",
    [Math.floor(hpAfter), broadcasterId, username],
  );
}

/** The refusal for a hero too hurt to fight, or null if they can. */
export function tooWoundedText(name: string, hp: number, hpMax: number, wounds: boolean): string | null {
  if (!wounds || hp > 1) return null;
  return `${name} can barely stand (${hp}/${hpMax} HP) — !rest or drink a potion (!use) before fighting again.`;
}

/** Autohunt's "rest instead of fighting" when low: returns the new HP if it
 * rested (and saves it), or null to fight this bout. */
export async function restIfLow(broadcasterId: string, c: Character, wounds: boolean): Promise<number | null> {
  if (!wounds || !isLowHp(c)) return null;
  const target = Math.min(c.hpMax, Math.ceil(c.hpMax * REST_FRACTION));
  if (c.hpCurrent >= target) return null;
  await settleWounds(broadcasterId, c.username, target, wounds);
  return target;
}

/** " 🩸 Wounds carry over: 7/13 HP." — appended to fight replies while wounds are on. */
export function woundNote(hp: number, hpMax: number, wounds: boolean): string {
  if (!wounds) return "";
  const left = Math.max(1, Math.min(hpMax, hp));
  return ` 🩸 Wounds carry over: ${left}/${hpMax} HP${left <= Math.ceil(hpMax * LOW_HP_FRACTION) ? " — !rest or !use a potion" : ""}.`;
}

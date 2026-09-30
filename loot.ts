// Monster loot — a small coin reward whenever a monster falls, paid right
// next to the XP (combat.ts calls awardMonsterLoot wherever it calls
// awardMonsterXp). Covers solo monster fights (!dndduel / !dndduel monster)
// and party hunts (!dndduel party hunt ...). PvP (!dndduel @user, !rob) drops
// no loot, same as it grants no XP.
//
// How much: the monster's XP value (the same 5e table the XP uses) divided
// by 10, varied by ±25% so no two kills pay exactly the same, and never less
// than 1 cp. That lands a CR 1/8 goblin-tier kill at a few copper, CR 1 at
// about 2 sp, and CR 5 at about 1 gp 8 sp — pocket change next to the chat
// trickle, not a jackpot. A party hunt drops ONE hoard that the surviving
// members split, so a bigger company doesn't multiply the payout.
//
// Only pays while coin is switched on (the default; !gold off pauses it, the
// same switch as the rest of the coin system). HUNT_LOOT_MULTIPLIER scales
// every drop (default 1; 0 turns loot off without touching anything else).

import { xpForMonsterCr } from "./characters.ts";
import { adjustBalance, isPointsEnabled } from "./points_db.ts";
import { formatCoins } from "./coins.ts";

const LOOT_MULTIPLIER = Math.min(100, Math.max(0, Number(Deno.env.get("HUNT_LOOT_MULTIPLIER") ?? "1")));
const MAX_LOOT_COPPER = 1_000_000;

/** Total copper dropped by one monster of this CR. */
export function monsterLootCopper(
  cr: string,
  rng: () => number = Math.random,
  multiplier: number = LOOT_MULTIPLIER,
): number {
  if (!(multiplier > 0)) return 0;
  const base = Math.max(1, Math.ceil(xpForMonsterCr(cr) / 10));
  const jitter = 0.75 + rng() * 0.5; // 0.75 .. 1.25
  return Math.min(MAX_LOOT_COPPER, Math.max(1, Math.round(base * jitter * multiplier)));
}

/**
 * Splits `total` copper among `count` survivors: everyone gets an equal
 * share, and the leftover copper goes one piece each to randomly chosen
 * members. Every survivor gets at least 1 cp (the hoard is topped up if it
 * is smaller than the party). Returns one amount per member, in order.
 */
export function splitLoot(total: number, count: number, rng: () => number = Math.random): number[] {
  if (count <= 0) return [];
  const pool = Math.max(total, count);
  const share = Math.floor(pool / count);
  const out = Array<number>(count).fill(share);
  let extra = pool - share * count;
  const order = [...out.keys()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const idx of order) {
    if (extra <= 0) break;
    out[idx] += 1;
    extra -= 1;
  }
  return out;
}

/**
 * Pays the loot for one slain monster to the given survivors (login names).
 * Returns each member's payout, or null if coin is off, loot is disabled, or
 * nobody survived — in which case the caller prints nothing.
 */
export async function awardMonsterLoot(
  members: string[],
  cr: string,
  broadcasterId: string,
): Promise<Array<{ username: string; copper: number }> | null> {
  if (!members.length) return null;
  if (!(await isPointsEnabled(broadcasterId))) return null;
  const total = monsterLootCopper(cr);
  if (total <= 0) return null;
  const shares = splitLoot(total, members.length);
  const paid: Array<{ username: string; copper: number }> = [];
  for (let i = 0; i < members.length; i++) {
    await adjustBalance(broadcasterId, members[i], members[i], shares[i]);
    paid.push({ username: members[i], copper: shares[i] });
  }
  return paid;
}

/** " 🪙 Loot: +2 sp 3 cp" for one player (solo fights). */
export function soloLootNote(paid: Array<{ username: string; copper: number }> | null): string {
  return paid?.length ? ` 🪙 Loot: +${formatCoins(paid[0].copper)}.` : "";
}

/** " 🪙 Loot: a+4 cp, b+4 cp." for a party hunt. */
export function partyLootNote(paid: Array<{ username: string; copper: number }> | null): string {
  return paid?.length ? ` 🪙 Loot: ${paid.map((p) => `${p.username}+${formatCoins(p.copper)}`).join(", ")}.` : "";
}

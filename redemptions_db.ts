// Persistence for redemptions.ts — channel-point rewards that touch the game.
// Split out of db.ts (near Val Town's per-file size cap), same as
// points_db.ts / social_db.ts. Every row is scoped by broadcaster_id and
// usernames are stored lowercase, like the rest of the bot.
//
// Two tables:
//   redemption_rewards — which channel-point reward (matched by title) does
//     what: a robbery shield, a "can't use <feature>" lockout, or a swear-jar
//     action (claim it, gift it, fine the streamer), and for how many minutes.
//     For "jarfine" the minutes column holds the fine in copper instead; for
//     "jar"/"jargive" it is unused (0). Managed by mods with !boon.
//   redemption_effects — the timed effects currently in force on a viewer.
//     effect is "shield" or "lock:<feature>". Rows simply expire; nothing has
//     to tick or clean them up except an occasional lazy sweep on grant.

import { sqlite } from "./sqlite.ts";

/** No single viewer can have more than this much of one effect stacked up. */
export const MAX_EFFECT_MS = 120 * 60 * 1000;

export type RewardEffect = "shield" | "lockout" | "jar" | "jargive" | "jarfine";

export interface RewardMapping {
  title: string;
  effect: RewardEffect;
  /** Minutes for shield/lockout; copper for jarfine; 0 for jar/jargive. */
  minutes: number;
}

export async function ensureRedemptionTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS redemption_rewards (
      broadcaster_id TEXT NOT NULL,
      reward_key TEXT NOT NULL,
      title TEXT NOT NULL,
      effect TEXT NOT NULL,
      minutes INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, reward_key)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS redemption_effects (
      broadcaster_id TEXT NOT NULL,
      username TEXT NOT NULL,
      effect TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      granted_by TEXT,
      PRIMARY KEY (broadcaster_id, username, effect)
    )`,
  );
}

/** Reward titles are matched case-insensitively with whitespace collapsed. */
export function rewardKey(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

// ── Reward mappings ──

export async function saveRewardMapping(broadcasterId: string, title: string, effect: RewardEffect, minutes: number) {
  const clean = title.trim().replace(/\s+/g, " ");
  await sqlite.execute(
    `INSERT INTO redemption_rewards (broadcaster_id, reward_key, title, effect, minutes) VALUES (?,?,?,?,?)
     ON CONFLICT(broadcaster_id, reward_key) DO UPDATE SET title = excluded.title, effect = excluded.effect, minutes = excluded.minutes`,
    [broadcasterId, rewardKey(clean), clean, effect, minutes],
  );
}

export async function removeRewardMapping(broadcasterId: string, title: string): Promise<boolean> {
  const res = await sqlite.execute(
    "DELETE FROM redemption_rewards WHERE broadcaster_id = ? AND reward_key = ? RETURNING reward_key",
    [broadcasterId, rewardKey(title)],
  );
  return res.rows.length > 0;
}

export async function getRewardMapping(broadcasterId: string, title: string): Promise<RewardMapping | null> {
  const res = await sqlite.execute(
    "SELECT title, effect, minutes FROM redemption_rewards WHERE broadcaster_id = ? AND reward_key = ?",
    [broadcasterId, rewardKey(title)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { title: String(row.title), effect: String(row.effect) as RewardEffect, minutes: Number(row.minutes) };
}

export async function listRewardMappings(broadcasterId: string): Promise<RewardMapping[]> {
  const res = await sqlite.execute(
    "SELECT title, effect, minutes FROM redemption_rewards WHERE broadcaster_id = ? ORDER BY title",
    [broadcasterId],
  );
  return res.rows.map((row) => ({
    title: String(row.title),
    effect: String(row.effect) as RewardEffect,
    minutes: Number(row.minutes),
  }));
}

// ── Timed effects ──

/** Grants (or extends) a timed effect and returns the new expiry timestamp.
 * Buying the same effect again while it is active adds to the remaining time,
 * capped at MAX_EFFECT_MS from now. */
export async function grantEffect(
  broadcasterId: string,
  username: string,
  effect: string,
  durationMs: number,
  grantedBy: string,
): Promise<number> {
  const now = Date.now();
  const user = username.toLowerCase();
  await sqlite.execute("DELETE FROM redemption_effects WHERE broadcaster_id = ? AND expires_at <= ?", [broadcasterId, now]);
  const cur = await sqlite.execute(
    "SELECT expires_at FROM redemption_effects WHERE broadcaster_id = ? AND username = ? AND effect = ?",
    [broadcasterId, user, effect],
  );
  const base = Math.max(now, Number(cur.rows[0]?.expires_at ?? 0));
  const expiresAt = Math.min(base + durationMs, now + MAX_EFFECT_MS);
  await sqlite.execute(
    `INSERT INTO redemption_effects (broadcaster_id, username, effect, expires_at, granted_by) VALUES (?,?,?,?,?)
     ON CONFLICT(broadcaster_id, username, effect) DO UPDATE SET expires_at = excluded.expires_at, granted_by = excluded.granted_by`,
    [broadcasterId, user, effect, expiresAt, grantedBy.toLowerCase()],
  );
  return expiresAt;
}

/** Milliseconds left on an effect (0 = not in force). */
export async function getEffectRemainingMs(broadcasterId: string, username: string, effect: string): Promise<number> {
  const res = await sqlite.execute(
    "SELECT expires_at FROM redemption_effects WHERE broadcaster_id = ? AND username = ? AND effect = ?",
    [broadcasterId, username.toLowerCase(), effect],
  );
  return Math.max(0, Number(res.rows[0]?.expires_at ?? 0) - Date.now());
}

/** Every effect still in force on a viewer, soonest-expiring first. */
export async function listActiveEffects(
  broadcasterId: string,
  username: string,
): Promise<{ effect: string; remainingMs: number }[]> {
  const now = Date.now();
  const res = await sqlite.execute(
    "SELECT effect, expires_at FROM redemption_effects WHERE broadcaster_id = ? AND username = ? AND expires_at > ? ORDER BY expires_at",
    [broadcasterId, username.toLowerCase(), now],
  );
  return res.rows.map((row) => ({ effect: String(row.effect), remainingMs: Number(row.expires_at) - now }));
}

/** Mod escape hatch: drop every active effect on a viewer. Returns how many. */
export async function clearEffects(broadcasterId: string, username: string): Promise<number> {
  const res = await sqlite.execute(
    "DELETE FROM redemption_effects WHERE broadcaster_id = ? AND username = ? RETURNING effect",
    [broadcasterId, username.toLowerCase()],
  );
  return res.rows.length;
}

// ── Offboarding ──

/** `!dndbot leave` (no purge): timed effects are temporary, so they go; the
 * reward mappings are kept, like characters and balances. */
export async function disconnectRedemptionData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM redemption_effects WHERE broadcaster_id = ?", [broadcasterId]);
}

/** `!dndbot leave purge`: delete everything redemption-related for the channel. */
export async function purgeRedemptionData(broadcasterId: string) {
  for (const table of ["redemption_rewards", "redemption_effects"]) {
    await sqlite.execute(`DELETE FROM ${table} WHERE broadcaster_id = ?`, [broadcasterId]);
  }
}

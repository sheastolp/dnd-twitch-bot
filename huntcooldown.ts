// GuildScribe — hunting cooldown. One per-channel cooldown covers every way of
// going hunting: solo monster fights (!dndduel / !dndduel <monster> /
// !dndduel monster [classic]), party hunts (!dndduel party hunt ...) and
// !autohunt. It is stamped when a hunt STARTS and is per hero, so a party hunt
// stamps (and is blocked by) every member of the company — a party can't dodge
// it by rotating who types the command. PvP duels and !rob are not hunts and
// are unaffected.
//
//   !huntcooldown            anyone: the channel's cooldown + your own wait
//   !huntcooldown <time|off> mod/broadcaster: set it ("90", "90s", "5m",
//                            "1m30s", "1h", or "off"/"0"); max 1 hour
//   !huntcd                  short alias
//
// The default is HUNT_COOLDOWN_SECONDS (env, default 120). A mod's value is
// stored per channel and wins over the default. Autohunt bouts are spaced by
// at least the cooldown too (see autohunt.ts), so a long cooldown slows an
// autohunt down rather than being bypassed by it.

import { sqlite } from "./sqlite.ts";
import { sendChatMessage } from "./twitch.ts";

export const MAX_HUNT_COOLDOWN_SECONDS = 3600;
const envDefault = Math.floor(Number(Deno.env.get("HUNT_COOLDOWN_SECONDS") ?? "120"));
export const DEFAULT_HUNT_COOLDOWN_SECONDS = Number.isFinite(envDefault)
  ? Math.min(MAX_HUNT_COOLDOWN_SECONDS, Math.max(0, envDefault))
  : 120;

export async function ensureHuntCooldownTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS hunt_settings (
      broadcaster_id TEXT PRIMARY KEY, cooldown_seconds INTEGER NOT NULL, updated_at INTEGER
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS hunt_cooldowns (
      broadcaster_id TEXT NOT NULL, username TEXT NOT NULL, last_hunt_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, username)
    )`,
  );
}

/** The channel's cooldown in seconds (mod override, else the default). */
export async function getHuntCooldownSeconds(broadcasterId: string): Promise<number> {
  const res = await sqlite.execute("SELECT cooldown_seconds FROM hunt_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length ? Number(res.rows[0].cooldown_seconds) : DEFAULT_HUNT_COOLDOWN_SECONDS;
}

export const getHuntCooldownMs = async (broadcasterId: string) => (await getHuntCooldownSeconds(broadcasterId)) * 1000;

export async function setHuntCooldownSeconds(broadcasterId: string, seconds: number) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO hunt_settings (broadcaster_id, cooldown_seconds, updated_at) VALUES (?,?,?)",
    [broadcasterId, seconds, Date.now()],
  );
}

/** Milliseconds `username` still has to wait before hunting again (0 = free). */
export async function huntWaitMs(broadcasterId: string, username: string, now = Date.now()): Promise<number> {
  const cd = await getHuntCooldownMs(broadcasterId);
  if (cd <= 0) return 0;
  const res = await sqlite.execute(
    "SELECT last_hunt_at FROM hunt_cooldowns WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, username.toLowerCase()],
  );
  if (!res.rows.length) return 0;
  return Math.max(0, Number(res.rows[0].last_hunt_at) + cd - now);
}

/** Records that these heroes just went hunting. */
export async function stampHunt(broadcasterId: string, usernames: string[], now = Date.now()) {
  for (const u of usernames) {
    await sqlite.execute(
      "INSERT OR REPLACE INTO hunt_cooldowns (broadcaster_id, username, last_hunt_at) VALUES (?,?,?)",
      [broadcasterId, u.toLowerCase(), now],
    );
  }
}

/**
 * Gate for starting a hunt. If any of `usernames` is still cooling down, posts
 * a chat line to `display` naming who and for how long and returns false; the
 * caller must stop. Otherwise stamps all of them and returns true.
 */
export async function claimHunt(
  broadcasterId: string,
  usernames: string[],
  display: string,
  opts: { self?: string } = {},
): Promise<boolean> {
  const now = Date.now();
  let worst: { username: string; wait: number } | null = null;
  for (const u of usernames) {
    const wait = await huntWaitMs(broadcasterId, u, now);
    if (wait > 0 && (!worst || wait > worst.wait)) worst = { username: u, wait };
  }
  if (worst) {
    const who = opts.self && worst.username.toLowerCase() === opts.self.toLowerCase() ? "your hero is" : `${worst.username} is`;
    await sendChatMessage(
      `@${display} ${who} still catching their breath — the next hunt is allowed in ${waitText(worst.wait)}.`,
      broadcasterId,
    );
    return false;
  }
  await stampHunt(broadcasterId, usernames, now);
  return true;
}

export function waitText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** "90", "90s", "5m", "1m30s", "1h", "off"/"0"/"none" → seconds, or null if unreadable. */
export function parseCooldown(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (t === "off" || t === "none") return 0;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return parseInt(m[1] || "0", 10) * 3600 + parseInt(m[2] || "0", 10) * 60 + parseInt(m[3] || "0", 10);
}

/** Handles !huntcooldown / !huntcd. Returns true if it consumed the message. */
export async function handleHuntCooldownCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!(?:huntcooldown|huntcd)(?:\s+(.*))?$/i);
  if (!m) return false;
  const arg = (m[1] ?? "").trim();
  const say = (t: string) => sendChatMessage(t, broadcasterId);

  if (arg) {
    if (!isModerator) {
      await say(`@${display} only the broadcaster or a moderator can change the hunting cooldown. !huntcooldown shows the current one.`);
      return true;
    }
    const seconds = parseCooldown(arg);
    if (seconds === null) {
      await say(`@${display} usage: !huntcooldown <time|off> — e.g. 90, 5m, 1m30s, or off (max ${waitText(MAX_HUNT_COOLDOWN_SECONDS * 1000)}).`);
      return true;
    }
    if (seconds > MAX_HUNT_COOLDOWN_SECONDS) {
      await say(`@${display} that's too long — the hunting cooldown can be at most ${waitText(MAX_HUNT_COOLDOWN_SECONDS * 1000)}.`);
      return true;
    }
    await setHuntCooldownSeconds(broadcasterId, seconds);
    await say(
      seconds === 0
        ? `@${display} hunting cooldown is now off — heroes can hunt as often as they like.`
        : `@${display} hunting cooldown set to ${waitText(seconds * 1000)} per hero (solo hunts, party hunts and !autohunt).`,
    );
    return true;
  }

  const seconds = await getHuntCooldownSeconds(broadcasterId);
  if (seconds === 0) {
    await say(`@${display} the hunting cooldown is off.`);
    return true;
  }
  const wait = await huntWaitMs(broadcasterId, chatter);
  await say(
    `@${display} hunting cooldown is ${waitText(seconds * 1000)} per hero (solo, party and autohunt). ${
      wait > 0 ? `You can hunt again in ${waitText(wait)}.` : "You're clear to hunt now."
    }${isModerator ? " Change it with !huntcooldown <time|off>." : ""}`,
  );
  return true;
}

/** `!dndbot leave`: forget everyone's last-hunt stamps; with purge also the channel's setting. */
export async function purgeHuntCooldownData(broadcasterId: string, purge: boolean) {
  await sqlite.execute("DELETE FROM hunt_cooldowns WHERE broadcaster_id = ?", [broadcasterId]);
  if (purge) await sqlite.execute("DELETE FROM hunt_settings WHERE broadcaster_id = ?", [broadcasterId]);
}

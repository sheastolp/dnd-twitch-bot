// GuildScribe — autohunt. `!autohunt [duration]` sends your saved hero out on a
// timed hunting trip: roughly every AUTOHUNT_BOUT_MINUTES (default 5) the hero
// takes on a level-appropriate monster using the exact same dice engine as
// `!dndduel` (simulateMonsterFight in combat.ts), earning the same XP and
// loot per win. Modeled on Hunt & Hoard's !autohunt.
//
//   !autohunt [20m|1h|1h30m|45]   start (bare number = minutes)
//   !autohunt status              or !autohuntstatus — progress so far
//   !autohunt stop                or !autohuntstop   — recall early, with a report
//
// How it runs on Val Town: there's no always-on process here, so a session is
// just a row with a schedule, and bouts are *settled* — simulated with real
// dice, paid out, and reported in ONE chat message — whenever something looks
// at the session: the autohunt cron (autohunt_cron.ts, ~every 15 min) or the
// hero's own !autohunt / status / stop. Settling is claimed atomically
// (claimAutohuntBouts), so the cron and a viewer can't both pay the same bout.
//
// There is no resting mechanic: unlike Hunt & Hoard, GuildScribe heroes start
// every fight at full HP, so a loss costs a bout's XP and loot, nothing more.

import { getCharacter } from "./db.ts";
import { recordMonsterOutcome, summonMonster } from "./bestiary.ts";
import { simulateMonsterFight } from "./battle.ts";
import { awardMonsterXp } from "./characters.ts";
import { awardMonsterLoot } from "./loot.ts";
import { formatCoins } from "./coins.ts";
import { claimHunt, getHuntCooldownMs, stampHunt } from "./huntcooldown.ts";
import { sendChatMessages } from "./twitch.ts";
import {
  addAutohuntProgress,
  bumpAutohuntReports,
  type AutohuntSession,
  claimAutohuntBouts,
  countAutohuntSessions,
  createAutohuntSession,
  deleteAutohuntSession,
  getAutohuntSession,
} from "./autohunt_db.ts";

const MIN = 60_000;
const envMinutes = (name: string, fallback: number) => {
  const n = Math.floor(Number(Deno.env.get(name) ?? ""));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const BOUT_INTERVAL_MS = envMinutes("AUTOHUNT_BOUT_MINUTES", 5) * MIN;
export const DEFAULT_DURATION_MS = 15 * MIN;
export const MIN_DURATION_MS = 10 * MIN;
export const MAX_DURATION_MS = 120 * MIN;
/** Hunters allowed at once per channel — bounds both chat noise and cron work. */
export const MAX_ACTIVE_PER_CHANNEL = envMinutes("AUTOHUNT_MAX_ACTIVE", 10);
const MAX_BOUTS_PER_SETTLE = Math.ceil(MAX_DURATION_MS / BOUT_INTERVAL_MS);
/** Unprompted (cron) reports that @-tag the hunter; later ones use the plain
 * name so a long hunt doesn't ping the same viewer every 15 minutes. Reports
 * the hunter asks for (!autohunt, status, stop) always tag them. */
export const TAGGED_REPORTS = 2;
/** Bouts spelled out individually in a report; the rest are summarized. */
const MAX_LISTED_BOUTS = 6;

/** "20m", "1h", "1h30m" or a bare number of minutes; empty = default.
 * Returns null if unparseable, otherwise clamps to [MIN, MAX]. */
export function parseDuration(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (!t) return DEFAULT_DURATION_MS;
  const clamp = (ms: number) => Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, ms));
  if (/^\d+$/.test(t)) return clamp(parseInt(t, 10) * MIN);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const ms = (parseInt(m[1] || "0", 10) * 60 + parseInt(m[2] || "0", 10)) * MIN;
  return ms > 0 ? clamp(ms) : null;
}

export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / MIN));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h${m}m`;
  return h ? `${h}h` : `${m}m`;
}

/** How many bouts are due at `now` for a session whose next bout is `nextAt`. */
export function dueBouts(nextAt: number, endsAt: number, now: number, intervalMs = BOUT_INTERVAL_MS): number {
  const cutoff = Math.min(now, endsAt);
  if (nextAt > cutoff) return 0;
  return Math.min(MAX_BOUTS_PER_SETTLE, Math.floor((cutoff - nextAt) / intervalMs) + 1);
}

const tally = (s: { wins: number; losses: number }) => `${s.wins}W/${s.losses}L`;

/**
 * Simulates and pays every bout that is due for one session, and returns the
 * chat message to post (or null when nothing was due or another settler got
 * there first). `forceEnd` closes the session after settling (used by stop).
 * Deletes the session once it has run its full time.
 */
export async function settleAutohunt(
  session: AutohuntSession,
  opts: { forceEnd?: boolean; now?: number; direct?: boolean } = {},
): Promise<string | null> {
  const { broadcaster_id: bid, username } = session;
  const now = opts.now ?? Date.now();
  // Bouts are spaced by the bout interval or the channel's hunting cooldown,
  // whichever is longer, so a long cooldown slows an autohunt down.
  const intervalMs = Math.max(BOUT_INTERVAL_MS, await getHuntCooldownMs(bid));
  const count = dueBouts(session.next_at, session.ends_at, now, intervalMs);
  const expired = now >= session.ends_at;
  const closing = expired || !!opts.forceEnd;
  if (count === 0 && !closing) return null;

  // Claim the due bouts before paying anything. When closing with nothing
  // due there is nothing to claim; the delete below is idempotent.
  if (count > 0) {
    const claimed = await claimAutohuntBouts(bid, username, session.next_at, session.next_at + count * intervalMs);
    if (!claimed) return null;
  }

  // Tag the hunter when they asked for this report, or for the first
  // TAGGED_REPORTS unprompted ones. Read the live count: the caller's copy of
  // the session may be stale.
  const sent = (await getAutohuntSession(bid, username))?.reports_sent ?? session.reports_sent;
  const tag = opts.direct || sent < TAGGED_REPORTS ? "@" : "";
  if (!opts.direct) await bumpAutohuntReports(bid, username);

  const lines: string[] = [];
  let wins = 0;
  let losses = 0;
  let xp = 0;
  let copper = 0;
  let levels = 0;
  let lastLevel: number | undefined;
  let missing = false;

  for (let i = 0; i < count; i++) {
    // Re-read every bout: a level-up mid-trip changes what the hero fights.
    const c = await getCharacter(username, bid);
    if (!c) {
      missing = true;
      break;
    }
    // From the channel's live bestiary, level-scaled then adapted (bestiary.ts).
    const monster = (await summonMonster(bid, c.level))!;
    const fight = simulateMonsterFight(c, session.display_name, monster);
    await recordMonsterOutcome(bid, monster.name, fight.won, c.level);
    if (fight.won) {
      wins++;
      const gained = await awardMonsterXp(username, monster.cr, bid);
      if (gained) {
        xp += gained.gained;
        if (gained.leveledTo) {
          levels++;
          lastLevel = gained.leveledTo;
        }
      }
      const paid = await awardMonsterLoot([username], monster.cr, bid);
      copper += paid?.[0]?.copper ?? 0;
      lines.push(`✔ beat ${monster.name} in ${fight.rounds} rd${fight.rounds === 1 ? "" : "s"} (you ${fight.playerHp}/${c.hpMax} HP)`);
    } else {
      losses++;
      lines.push(`✘ fell to ${monster.name} (it kept ${fight.monsterHp}/${monster.hp} HP)`);
    }
  }

  if (wins + losses > 0) {
    // Manual hunts respect the cooldown from the hero's latest bout.
    await stampHunt(bid, [username], now);
    await addAutohuntProgress(bid, username, { bouts: wins + losses, wins, losses, xp, copper, levels });
  }

  const name = session.display_name;
  if (missing) {
    await deleteAutohuntSession(bid, username);
    return `${tag}${name} your hero is no longer on the roster, so the autohunt is called off.`;
  }

  const shown = lines.slice(0, MAX_LISTED_BOUTS).join(" · ") +
    (lines.length > MAX_LISTED_BOUTS ? ` · …and ${lines.length - MAX_LISTED_BOUTS} more` : "");
  const gains = `+${xp} XP${copper > 0 ? `, 🪙 +${formatCoins(copper)}` : ""}`;
  const levelNote = levels > 0 ? ` 🎉 Leveled up to ${lastLevel}!` : "";

  if (closing) {
    const fresh = (await getAutohuntSession(bid, username)) ?? session;
    await deleteAutohuntSession(bid, username);
    const why = opts.forceEnd && !expired ? "recalled early" : "time's up";
    const total = `${fresh.bouts} bout${fresh.bouts === 1 ? "" : "s"} (${tally(fresh)}), +${fresh.total_xp} XP` +
      (fresh.total_copper > 0 ? `, 🪙 +${formatCoins(fresh.total_copper)}` : "");
    const recent = lines.length ? `Latest: ${shown}. ` : "";
    const lv = fresh.levels_gained > 0 ? ` 🎉 Leveled up ${fresh.levels_gained} time${fresh.levels_gained === 1 ? "" : "s"}!` : "";
    return `${tag}${name} 🏹 autohunt over after ${formatDuration(now - fresh.started_at)} (${why}): ${recent}Trip total: ${total}.${lv}`;
  }

  const left = formatDuration(session.ends_at - now);
  return `${tag}${name} 🏹 autohunt report — ${lines.length} bout${lines.length === 1 ? "" : "s"} (${wins}W/${losses}L): ${shown} | ${gains}${levelNote} | ${left} left.`;
}

/** Handles !autohunt, !autohunt status|stop, !autohuntstatus, !autohuntstop. */
export async function handleAutohuntCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!autohunt(status|stop)?(?:\s+(.*))?$/i);
  if (!m) return false;
  const user = chatter.toLowerCase();
  const arg = (m[2] ?? "").trim();
  let sub = (m[1] ?? "").toLowerCase();
  if (!sub && /^(status|stop)$/i.test(arg)) sub = arg.toLowerCase();

  const say = (text: string) => sendChatMessages(text, broadcasterId);
  const existing = await getAutohuntSession(broadcasterId, user);

  if (sub === "status") {
    if (!existing) {
      await say(`@${display} no autohunt is running for you. Start one with !autohunt [20m|1h].`);
      return true;
    }
    // Pay anything already due so the numbers below are current.
    const report = await settleAutohunt(existing, { direct: true });
    if (report) await say(report);
    const s = await getAutohuntSession(broadcasterId, user);
    if (!s) return true; // that settle ended the session
    if (!report) {
      await say(
        `@${display} 🏹 autohunt in progress: ${s.bouts} bout${s.bouts === 1 ? "" : "s"} so far (${tally(s)}), +${s.total_xp} XP` +
          `${s.total_copper > 0 ? `, 🪙 +${formatCoins(s.total_copper)}` : ""}. Next bout in ~${
            formatDuration(Math.max(0, s.next_at - Date.now()))
          }, ${formatDuration(s.ends_at - Date.now())} left. !autohunt stop recalls your hero.`,
      );
    }
    return true;
  }

  if (sub === "stop") {
    if (!existing) {
      await say(`@${display} no autohunt is running for you.`);
      return true;
    }
    const report = await settleAutohunt(existing, { forceEnd: true, direct: true });
    // null means the cron settled it in the same instant; the session is gone either way.
    await say(report ?? `@${display} 🏹 your autohunt has already wrapped up.`);
    return true;
  }

  // Start
  const char = await getCharacter(user, broadcasterId);
  if (!char) {
    await say(`@${display} you need a saved character to send out hunting — try !createchar first.`);
    return true;
  }
  if (existing) {
    await say(
      `@${display} your hero is already out hunting (${formatDuration(existing.ends_at - Date.now())} left). ` +
        `!autohunt status to check in, !autohunt stop to recall.`,
    );
    return true;
  }
  const duration = parseDuration(arg);
  if (duration === null) {
    await say(
      `@${display} I couldn't read that duration. Try !autohunt 20m, !autohunt 1h or just !autohunt (${
        formatDuration(DEFAULT_DURATION_MS)
      }). Allowed: ${formatDuration(MIN_DURATION_MS)}–${formatDuration(MAX_DURATION_MS)}.`,
    );
    return true;
  }
  if (await countAutohuntSessions(broadcasterId) >= MAX_ACTIVE_PER_CHANNEL) {
    await say(`@${display} the hunting grounds are crowded (${MAX_ACTIVE_PER_CHANNEL} heroes out already) — try again shortly.`);
    return true;
  }
  // Starting a hunt is subject to the same cooldown as every other hunt.
  if (!(await claimHunt(broadcasterId, [user], display, { self: user }))) return true;
  const firstBoutIn = Math.max(BOUT_INTERVAL_MS, await getHuntCooldownMs(broadcasterId));
  const now = Date.now();
  await createAutohuntSession({
    broadcaster_id: broadcasterId,
    username: user,
    display_name: display,
    started_at: now,
    ends_at: now + duration,
    next_at: now + firstBoutIn, // first bout one interval (or cooldown) in, so a quick !autohunt stop can't be abused
    bouts: 0,
    wins: 0,
    losses: 0,
    total_xp: 0,
    total_copper: 0,
    levels_gained: 0,
    reports_sent: 0,
  });
  await say(
    `@${display} 🏹 your hero heads into the wilds for ${formatDuration(duration)}. ` +
      `A monster every ~${formatDuration(firstBoutIn)} at your level, same dice as !dndduel, with a report in chat as bouts are settled. ` +
      `!autohunt status to check in, !autohunt stop to recall.`,
  );
  return true;
}

// !watchtime and !followage.
//
//   !watchtime [@user]    how long a viewer has been around this channel
//   !followage [@user]    how long a viewer has followed this channel
//
// Both are open to everyone and answer with a D&D-flavored line.
//
// WATCH TIME. Twitch has no "watch time" API, so GuildScribe keeps its own
// clock, modelled on StreamElements': time counts while the viewer is *in
// chat* (lurkers included) and the stream is *live*.
//   - POLL (watchtime_cron.ts -> pollWatchtime). Each tick reads Twitch's Get
//     Chatters list with the broadcaster's stored token (scope
//     moderator:read:chatters) and credits everyone listed for the time since
//     they were last seen. Val Town crons can't run more often than every 15
//     minutes, so the join/leave edges are estimated instead of dropped: a
//     viewer who appears for the first time in a poll gets half the window,
//     and one who vanishes from the list gets half of the time since they
//     were last seen. On average that is exact. The poll also reads the
//     stream's started_at so a first poll never credits time before going
//     live, and a poll that finds the stream offline closes everyone out.
//   - MESSAGES (trackWatchtime). Every chat message while live still moves the
//     sender's clock by the gap since they were last seen, so channels that
//     haven't granted the chatters scope keep working exactly as before
//     (gaps over WATCHTIME_SESSION_GAP_MINUTES, default 15, aren't counted).
//     Both paths advance the same last_seen_at, so nothing is counted twice.
//   - Bots (isBotAccount) are never counted. Nothing counts while offline.
//   - Totals start from the day this shipped; there is no history to backfill.
//
// FOLLOW AGE. Twitch's Get Channel Followers endpoint needs a *user* token
// with moderator:read:followers for the broadcaster or one of their mods. The
// broadcaster's own token — the one /connect already stores in
// broadcaster_ad_tokens (see ads_db.ts) and ads.ts keeps refreshed — qualifies,
// exactly as it does for auto-ban. Channels that connected before this scope
// was requested get a one-line "broadcaster, please reconnect" reply from
// !followage until they revisit /connect; !watchtime needs no permission.

import { sqlite } from "./sqlite.ts";
import { getValidAdToken } from "./ads.ts";
import { getBroadcasterAdToken } from "./ads_db.ts";
import { env, getAppToken, sendChatMessage } from "./twitch.ts";
import { recordMonitorEvent } from "./db.ts";
import { isBotAccount, pick } from "./utils.ts";
import { getChannelBotLogins } from "./channel_bots.ts";

export const FOLLOW_SCOPE = "moderator:read:followers";
export const CHATTERS_SCOPE = "moderator:read:chatters";

const SESSION_GAP_MS = Math.max(1, Math.floor(Number(Deno.env.get("WATCHTIME_SESSION_GAP_MINUTES") ?? "15")) || 15) * 60_000;
// While the chatters poll is tracking a viewer (in_chat = 1) the gap between
// two sightings can legitimately be a full cron interval plus jitter.
const POLL_GAP_MS = Math.max(1, Math.floor(Number(Deno.env.get("WATCHTIME_POLL_GAP_MINUTES") ?? "30")) || 30) * 60_000;
// Messages closer together than this don't touch the database at all.
const MIN_TICK_MS = 30_000;

const USERNAME_RE = /^[a-z0-9_]{1,25}$/;
const COMMAND_RE = /^!(watchtime|followage)(?:\s+@?([^\s]+))?\s*$/i;

// ── Flavor ──
// Every line is built around "whose" ("your" / "Name's") and a duration, with
// something other than the viewer as the grammatical subject, so the same
// line reads correctly whether the viewer asked about themselves or someone
// else. Keep ≥ 20 unique, D&D-themed entries in each pool.

export const WATCHTIME_LINES: Array<(whose: string, time: string) => string> = [
  (w, t) => `🕯️ The scribes have kept ${w} candle burning in the guild hall for ${t}.`,
  (w, t) => `⏳ The hourglass on the tavern mantel records ${t} of ${w} company at this fire.`,
  (w, t) => `📜 The guild ledger credits ${w} vigil with ${t} in the hall.`,
  (w, t) => `🍺 The innkeeper has refilled ${w} tankard through ${t} of good company.`,
  (w, t) => `🛡️ Standing watch at the gates: ${t} on ${w} shift so far.`,
  (w, t) => `🔮 The crystal ball shows ${t} of ${w} presence among the faithful.`,
  (w, t) => `🐉 The old dragon has tolerated ${w} presence on the premises for ${t}.`,
  (w, t) => `🏰 ${t} — that is how long ${w} banner has flown over these halls.`,
  (w, t) => `🗝️ The doorkeeper has let ${w} name stand in the hall for ${t}.`,
  (w, t) => `🎲 The dice have tumbled for ${t} with ${w} seat at the table.`,
  (w, t) => `🧙 A wizard's timekeeping spell tallies ${t} of ${w} watch.`,
  (w, t) => `🔥 ${w} spot by the campfire has stayed warm for ${t}.`,
  (w, t) => `📯 The town crier has counted ${t} of ${w} time among the crowd.`,
  (w, t) => `🦉 My familiar has logged ${t} of ${w} watch in the rafters.`,
  (w, t) => `⚔️ The war room records ${t} of ${w} service to this company.`,
  (w, t) => `🧭 The cartographers mark ${t} of ${w} wandering through these halls.`,
  (w, t) => `🪙 The treasurer notes ${t} of ${w} time well spent in the guild hall.`,
  (w, t) => `🏹 The ranger's log notes ${w} presence in the glade for ${t}.`,
  (w, t) => `🕰️ The old clock tower has chimed through ${t} of ${w} stay.`,
  (w, t) => `🧪 The alchemist's timer has bubbled for ${t} on ${w} account.`,
  (w, t) => `🌙 The night watch counts ${t} of ${w} vigil beneath the stars.`,
  (w, t) => `📖 The chronicler has penned ${t} of ${w} tale into the guild annals.`,
];

export const FOLLOWAGE_LINES: Array<(whose: string, age: string, since: string) => string> = [
  (w, a, s) => `🏰 ${w} oath to the guild has stood for ${a} (sworn ${s}).`,
  (w, a, s) => `📜 The guild roll has borne ${w} name for ${a}, inked ${s}.`,
  (w, a, s) => `🛡️ Since ${s}, ${w} shield has stood in the wall — ${a} and counting.`,
  (w, a, s) => `🗝️ ${w} key to the guild hall was cut on ${s}: ${a} of welcome.`,
  (w, a, s) => `🐉 ${a} on the dragon's trail — ${w} journey began ${s}.`,
  (w, a, s) => `🕯️ ${w} candle was lit for this guild on ${s} and has burned ${a}.`,
  (w, a, s) => `📯 The herald announces ${w} fealty since ${s}: ${a} of faithful service.`,
  (w, a, s) => `🔮 The oracle sees ${w} bond with the guild stretching back ${a}, to ${s}.`,
  (w, a, s) => `🍺 The innkeeper has known ${w} face at the bar for ${a}, ever since ${s}.`,
  (w, a, s) => `🧙 The archmage's registry lists ${w} apprenticeship as ${a} old (begun ${s}).`,
  (w, a, s) => `⚔️ ${w} banner has flown with the company since ${s} — ${a} on the march.`,
  (w, a, s) => `🎲 ${w} first roll at this table came ${s}; ${a} of adventures since.`,
  (w, a, s) => `🦉 My familiar remembers ${w} arrival on ${s}: ${a} of faithful company.`,
  (w, a, s) => `🧭 ${w} road to the guild hall began ${s} and has run ${a}.`,
  (w, a, s) => `📖 The chronicle marks ${w} entry on ${s} — ${a} of the tale so far.`,
  (w, a, s) => `🪙 The treasurer's books show ${w} loyalty paid in full for ${a} (since ${s}).`,
  (w, a, s) => `🏹 ${w} arrow found its mark on ${s}; ${a} of the guild's quests since.`,
  (w, a, s) => `🗡️ The blade-sworn rolls list ${w} vow dated ${s}, ${a} unbroken.`,
  (w, a, s) => `🌲 ${w} tent has stood at the guild's campsite for ${a}, pitched ${s}.`,
  (w, a, s) => `🕰️ The clock tower has chimed through ${a} of ${w} fellowship, since ${s}.`,
  (w, a, s) => `🏔️ ${a} of climbing the mountain together — ${w} expedition set out ${s}.`,
  (w, a, s) => `🔥 The hearth has warmed ${w} seat for ${a}, ever since ${s}.`,
];

// ── Persistence (own table — db.ts is already near Val Town's file-size cap) ──

export async function ensureWatchtimeTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS watchtime_stats (
      broadcaster_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT,
      total_ms INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, username)
    )`,
  );
  // in_chat: 1 while the chatters poll last saw this viewer in the list.
  try { await sqlite.execute("ALTER TABLE watchtime_stats ADD COLUMN in_chat INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS watchtime_polls (
      broadcaster_id TEXT PRIMARY KEY,
      last_poll_at INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 0
    )`,
  );
}

/** Wipes the channel's watch-time totals — called from !dndbot leave purge. */
export async function purgeWatchtimeData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM watchtime_stats WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM watchtime_polls WHERE broadcaster_id = ?", [broadcasterId]);
}

/** Moves a viewer's clock forward. Call for every message from a real
 * (non-bot) chatter while the channel is live. One statement, no read: a
 * first message inserts a row at 0; later ones add the gap since the last
 * message when it is under the session window, and are skipped entirely when
 * it is under MIN_TICK_MS. Never throws — watch time must not break chat. */
export async function trackWatchtime(broadcasterId: string, chatter: string, display: string): Promise<void> {
  const user = chatter.toLowerCase();
  if (!USERNAME_RE.test(user)) return;
  const now = Date.now();
  try {
    await sqlite.execute(
      `INSERT INTO watchtime_stats (broadcaster_id, username, display_name, total_ms, first_seen_at, last_seen_at)
       VALUES (?,?,?,0,?,?)
       ON CONFLICT(broadcaster_id, username) DO UPDATE SET
         total_ms = total_ms + CASE
           WHEN excluded.last_seen_at - watchtime_stats.last_seen_at <= CASE WHEN watchtime_stats.in_chat = 1 THEN ? ELSE ? END
             THEN excluded.last_seen_at - watchtime_stats.last_seen_at
           ELSE 0 END,
         display_name = excluded.display_name,
         last_seen_at = excluded.last_seen_at
       WHERE excluded.last_seen_at - watchtime_stats.last_seen_at >= ?`,
      [broadcasterId, user, display, now, now, POLL_GAP_MS, SESSION_GAP_MS, MIN_TICK_MS],
    );
  } catch (e) {
    console.error("trackWatchtime failed", e);
  }
}

async function getWatchtime(broadcasterId: string, username: string): Promise<{ totalMs: number; displayName: string } | null> {
  const res = await sqlite.execute(
    "SELECT total_ms, display_name FROM watchtime_stats WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, username.toLowerCase()],
  );
  if (!res.rows.length) return null;
  return { totalMs: Number(res.rows[0].total_ms), displayName: String(res.rows[0].display_name ?? username) };
}

// ── Chatters poll (called by watchtime_cron.ts) ──

type StreamInfo = { live: boolean; startedAt: number };

/** Live status + start time straight from Helix (app token, no scope).
 * null on any failure so the caller can fall back to broadcasters.is_live. */
async function fetchStream(broadcasterId: string): Promise<StreamInfo | null> {
  try {
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(broadcasterId)}`, {
      headers: { Authorization: `Bearer ${await getAppToken()}`, "Client-Id": env("TWITCH_CLIENT_ID") },
    });
    if (!res.ok) return null;
    const s = (await res.json())?.data?.[0];
    if (!s || (s.type && s.type !== "live")) return { live: false, startedAt: 0 };
    const startedAt = Date.parse(String(s.started_at ?? ""));
    return { live: true, startedAt: Number.isFinite(startedAt) ? startedAt : 0 };
  } catch (_e) {
    return null;
  }
}

type Chatter = { login: string; display: string; id: string };

/** Everyone in the channel's chat list. "no_permission" if the broadcaster
 * hasn't granted moderator:read:chatters yet; throws on other failures. */
export async function fetchChatters(broadcasterId: string): Promise<Chatter[] | "no_permission"> {
  const token = await getValidAdToken(broadcasterId);
  if (!token) return "no_permission";
  const row = await getBroadcasterAdToken(broadcasterId);
  if (!String(row?.scope ?? "").split(/\s+/).includes(CHATTERS_SCOPE)) return "no_permission";

  const out: Chatter[] = [];
  let after = "";
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ broadcaster_id: broadcasterId, moderator_id: broadcasterId, first: "1000" });
    if (after) params.set("after", after);
    const res = await fetch(`https://api.twitch.tv/helix/chat/chatters?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": env("TWITCH_CLIENT_ID") },
    });
    if (res.status === 401 || res.status === 403) return "no_permission";
    if (!res.ok) throw new Error(`chatters ${res.status}`);
    const data = await res.json();
    for (const c of data?.data ?? []) {
      out.push({ login: String(c.user_login ?? "").toLowerCase(), display: String(c.user_name ?? c.user_login ?? ""), id: String(c.user_id ?? "") });
    }
    after = String(data?.pagination?.cursor ?? "");
    if (!after) break;
  }
  return out;
}

/** Connected, enabled channels that are live, or still hold a poll the last
 * tick left open (so the first offline tick can close it out). */
export async function getWatchtimePollChannels(): Promise<Array<{ broadcasterId: string; isLive: boolean }>> {
  const res = await sqlite.execute(
    `SELECT b.broadcaster_id AS broadcaster_id, b.is_live AS is_live
     FROM broadcasters b
     LEFT JOIN channel_settings cs ON cs.broadcaster_id = b.broadcaster_id
     LEFT JOIN channel_blocks cb ON cb.broadcaster_id = b.broadcaster_id
     LEFT JOIN watchtime_polls p ON p.broadcaster_id = b.broadcaster_id
     WHERE b.connected = 1
       AND cb.broadcaster_id IS NULL
       AND (cs.enabled IS NULL OR cs.enabled = 1)
       AND (b.is_live = 1 OR p.active = 1)`,
  );
  return res.rows.map((r: any) => ({ broadcasterId: String(r.broadcaster_id), isLive: Number(r.is_live) === 1 }));
}

export type PollResult = "polled" | "closed" | "idle" | "no_permission";

/** One chatters-poll tick for a channel. See the header comment for the model. */
export async function pollWatchtime(broadcasterId: string, isLiveDb: boolean): Promise<PollResult> {
  const now = Date.now();
  const pollRes = await sqlite.execute("SELECT last_poll_at, active FROM watchtime_polls WHERE broadcaster_id = ?", [broadcasterId]);
  const lastPollAt = Number(pollRes.rows[0]?.last_poll_at ?? 0);
  const active = Number(pollRes.rows[0]?.active ?? 0) === 1;

  const stream = await fetchStream(broadcasterId);
  const live = stream ? stream.live : isLiveDb;

  if (!live) {
    if (!active) return "idle";
    // Stream ended somewhere since the last tick: credit half the window to
    // everyone still marked present, then close the poll.
    await sqlite.execute(
      `UPDATE watchtime_stats
       SET total_ms = total_ms + MIN(MAX(? - last_seen_at, 0), ?) / 2, in_chat = 0
       WHERE broadcaster_id = ? AND in_chat = 1`,
      [now, POLL_GAP_MS, broadcasterId],
    );
    await sqlite.execute("INSERT OR REPLACE INTO watchtime_polls (broadcaster_id, last_poll_at, active) VALUES (?,0,0)", [broadcasterId]);
    return "closed";
  }

  const chatters = await fetchChatters(broadcasterId);
  if (chatters === "no_permission") return "no_permission";

  // The window these joiners could have been present for: since the previous
  // tick or the stream start, whichever is later, capped at one poll gap.
  const windowStart = Math.max(lastPollAt, stream?.startedAt ?? 0);
  const windowMs = windowStart > 0 ? Math.min(Math.max(0, now - windowStart), POLL_GAP_MS) : 0;
  const half = Math.floor(windowMs / 2);
  const botId = env("TWITCH_BOT_ID");

  const listed = await getChannelBotLogins(broadcasterId).catch(() => new Set<string>());
  const present = chatters.filter((c) => USERNAME_RE.test(c.login) && !isBotAccount(c.login, c.id, botId) && !listed.has(c.login.toLowerCase()));
  const upsert = `INSERT INTO watchtime_stats (broadcaster_id, username, display_name, total_ms, first_seen_at, last_seen_at, in_chat)
     VALUES (?,?,?,?,?,?,1)
     ON CONFLICT(broadcaster_id, username) DO UPDATE SET
       total_ms = total_ms + CASE
         WHEN watchtime_stats.in_chat = 1 THEN MIN(MAX(excluded.last_seen_at - watchtime_stats.last_seen_at, 0), ?)
         WHEN watchtime_stats.last_seen_at >= ? THEN MIN(?, MAX(?, excluded.last_seen_at - watchtime_stats.last_seen_at))
         ELSE ? END,
       display_name = excluded.display_name,
       last_seen_at = excluded.last_seen_at,
       in_chat = 1`;
  for (let i = 0; i < present.length; i += 25) {
    await Promise.all(
      present.slice(i, i + 25).map((c) =>
        sqlite.execute(upsert, [broadcasterId, c.login, c.display, half, now, now, POLL_GAP_MS, windowStart, windowMs, half, half])
      ),
    );
  }

  // Anyone still marked present but missing from the list left since the last
  // tick (their last_seen_at wasn't bumped to `now`): credit half the gap.
  await sqlite.execute(
    `UPDATE watchtime_stats
     SET total_ms = total_ms + MIN(MAX(? - last_seen_at, 0), ?) / 2, in_chat = 0
     WHERE broadcaster_id = ? AND in_chat = 1 AND last_seen_at < ?`,
    [now, POLL_GAP_MS, broadcasterId, now],
  );
  await sqlite.execute("INSERT OR REPLACE INTO watchtime_polls (broadcaster_id, last_poll_at, active) VALUES (?,?,1)", [broadcasterId, now]);
  return "polled";
}

// ── Formatting ──

/** "2d 3h 15m" / "3h 20m" / "12m" / "less than a minute". */
export function formatWatchtime(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  if (totalMinutes < 1) return "less than a minute";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || !parts.length) parts.push(`${minutes}m`);
  return parts.join(" ");
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** Calendar difference between two instants, "1 year, 2 months, 3 days". */
export function formatFollowAge(from: Date, to: Date): string {
  if (to.getTime() - from.getTime() < 86_400_000) return "less than a day";
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  let months = to.getUTCMonth() - from.getUTCMonth();
  let days = to.getUTCDate() - from.getUTCDate();
  if (days < 0) {
    months--;
    days += new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 0)).getUTCDate();
  }
  if (months < 0) {
    years--;
    months += 12;
  }
  const parts: string[] = [];
  if (years > 0) parts.push(plural(years, "year"));
  if (months > 0) parts.push(plural(months, "month"));
  if (days > 0) parts.push(plural(days, "day"));
  return parts.length ? parts.join(", ") : "less than a day";
}

const formatSince = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });

// ── Helix ──

async function lookupUserId(login: string): Promise<string | null> {
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
    headers: { Authorization: `Bearer ${await getAppToken()}`, "Client-Id": env("TWITCH_CLIENT_ID") },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.data?.[0]?.id ? String(data.data[0].id) : null;
}

type FollowResult =
  | { kind: "following"; followedAt: Date }
  | { kind: "not_following" }
  | { kind: "no_permission" }
  | { kind: "error" };

async function fetchFollow(broadcasterId: string, userId: string): Promise<FollowResult> {
  const token = await getValidAdToken(broadcasterId);
  if (!token) return { kind: "no_permission" };
  // Read the row *after* getValidAdToken so a just-refreshed scope is seen.
  const row = await getBroadcasterAdToken(broadcasterId);
  if (!String(row?.scope ?? "").split(/\s+/).includes(FOLLOW_SCOPE)) return { kind: "no_permission" };

  const params = new URLSearchParams({ broadcaster_id: broadcasterId, user_id: userId });
  const res = await fetch(`https://api.twitch.tv/helix/channels/followers?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}`, "Client-Id": env("TWITCH_CLIENT_ID") },
  });
  if (res.status === 401 || res.status === 403) return { kind: "no_permission" };
  if (!res.ok) return { kind: "error" };
  const data = await res.json();
  const followedAt = data?.data?.[0]?.followed_at;
  if (!followedAt) return { kind: "not_following" };
  const parsed = new Date(followedAt);
  return Number.isFinite(parsed.getTime()) ? { kind: "following", followedAt: parsed } : { kind: "error" };
}

// ── Command ──

/** Handles !watchtime and !followage. Returns true if it consumed the message. */
export async function handleWatchtimeCommand(
  chatMessage: string,
  chatter: string,
  chatterId: string,
  display: string,
  broadcasterId: string,
  baseUrl: string,
): Promise<boolean> {
  const m = chatMessage.trim().match(COMMAND_RE);
  if (!m) return false;
  const command = m[1].toLowerCase();

  const rawTarget = m[2] ? m[2].replace(/^@/, "").toLowerCase() : "";
  if (rawTarget && !USERNAME_RE.test(rawTarget)) {
    await sendChatMessage(`@${display} usage: !${command} [@user]`, broadcasterId);
    return true;
  }
  const isSelf = !rawTarget || rawTarget === chatter.toLowerCase();
  const targetLogin = isSelf ? chatter.toLowerCase() : rawTarget;
  const whose = isSelf ? "your" : `${rawTarget}'s`;
  const who = isSelf ? "you" : rawTarget;

  try {
    if (command === "watchtime") {
      const stats = await getWatchtime(broadcasterId, targetLogin);
      if (!stats) {
        await sendChatMessage(
          isSelf
            ? `@${display} the scribes haven't logged any watch time for you yet — hang around while the stream is live and the hourglass starts turning.`
            : `@${display} the scribes haven't logged any watch time for ${who} yet.`,
          broadcasterId,
        );
        return true;
      }
      const shownWhose = isSelf ? "your" : `${stats.displayName}'s`;
      await sendChatMessage(`@${display} ${pick(WATCHTIME_LINES)(shownWhose, formatWatchtime(stats.totalMs))}`, broadcasterId);
      return true;
    }

    // !followage
    const targetId = isSelf ? chatterId : await lookupUserId(targetLogin);
    if (!targetId) {
      await sendChatMessage(`@${display} the scribes can't find a Twitch user named ${rawTarget}.`, broadcasterId);
      return true;
    }
    if (targetId === broadcasterId) {
      await sendChatMessage(
        `@${display} 🏰 the guild hall can't be followed by its own master — ${isSelf ? "you are" : `${rawTarget} is`} the channel.`,
        broadcasterId,
      );
      return true;
    }
    const result = await fetchFollow(broadcasterId, targetId);
    if (result.kind === "no_permission") {
      await sendChatMessage(
        `@${display} !followage needs a one-time permission from the broadcaster — broadcaster, please reconnect at ${baseUrl}/connect.`,
        broadcasterId,
      );
    } else if (result.kind === "error") {
      await sendChatMessage(`@${display} the guild roll is unreadable right now — try again in a moment.`, broadcasterId);
    } else if (result.kind === "not_following") {
      await sendChatMessage(
        isSelf
          ? `@${display} you haven't sworn the guild's oath yet — hit that Follow button to take it!`
          : `@${display} ${who} hasn't sworn the guild's oath yet.`,
        broadcasterId,
      );
    } else {
      const age = formatFollowAge(result.followedAt, new Date());
      await sendChatMessage(`@${display} ${pick(FOLLOWAGE_LINES)(whose, age, formatSince(result.followedAt))}`, broadcasterId);
    }
  } catch (e) {
    console.error(`!${command} failed`, e);
    await sendChatMessage(`@${display} the scribes dropped their quills — try !${command} again in a moment.`, broadcasterId);
  }
  return true;
}

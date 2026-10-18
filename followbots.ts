// GuildScribe — follow-bot defense (Sery_Bot-style). Follow bots are throwaway
// accounts that follow (and often unfollow) in waves to spam alerts. Twitch
// has no "remove follower" API, but blocking an account removes its follow,
// so that's what GuildScribe does — with the broadcaster's token and the
// user:manage:blocked_users permission.
//
//   • Automatic (dashboard switch "followbots", !followbots on/off/status,
//     Sery's !followban / !followbanoff also work; off by default): every new
//     follower is scored like !botcheck does (account age, default picture,
//     generated-looking name — botdetect.ts scoreUser). Blocked when the score
//     is BLOCK_SCORE+, or BURST_SCORE+ during a follow wave (BURST_FOLLOWS+
//     follows in a minute). Blocked accounts get no follower thank-you.
//   • !removebots (mod, every 15 minutes): scores the channel's newest
//     SCAN_LIMIT followers and blocks the ones at BLOCK_SCORE+.
//   • !checkforbots (mod): the same scan, but only counts.
//   • !removebots undo @user (mod): unblocks a mistake (they'll need to follow again).
//
// Every block is logged in `followbot_blocks`; chat hears a short summary at
// most every ANNOUNCE_EVERY_MS while live.

import { sqlite } from "./sqlite.ts";
import { getBroadcaster, getCustomCommand, isChannelBlocked, isCommandGroupEnabled, recordMonitorEvent, setCommandGroupEnabled } from "./db.ts";
import { type BotScore, scoreUser } from "./botdetect.ts";
import { isChannelBot } from "./channel_bots.ts";
import { env, getUserIdByLogin, sendChatMessage } from "./twitch.ts";
import { FOLLOW_SCOPE } from "./watchtime.ts";
import { getScopedToken, getUsersById, helix, type HelixUser, reconnectHint } from "./stream_guard.ts";

export const BLOCK_SCOPE = "user:manage:blocked_users";
const BLOCK_SCORE = 5;
const BURST_SCORE = 3;
const BURST_FOLLOWS = Math.max(3, Number(Deno.env.get("FOLLOW_BOT_BURST") ?? "8"));
const SCAN_LIMIT = 1000;
const SCAN_COOLDOWN_MS = 15 * 60_000;
const ANNOUNCE_EVERY_MS = 2 * 60_000;

export async function ensureFollowBotTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS followbot_blocks (
      broadcaster_id TEXT NOT NULL, user_id TEXT NOT NULL, login TEXT NOT NULL, score INTEGER NOT NULL,
      reasons TEXT NOT NULL, source TEXT NOT NULL, blocked_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, user_id)
    )`,
  );
}

export async function purgeFollowBotData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM followbot_blocks WHERE broadcaster_id = ?", [broadcasterId]);
}

const follows = new Map<string, number[]>(); // channel → recent follow times
const lastScan = new Map<string, number>();
const pendingAnnounce = new Map<string, { count: number; last: number }>();

export async function blockUser(token: string, broadcasterId: string, user: { id: string; login: string }, score: number, reasons: string[], source: "auto" | "scan"): Promise<boolean> {
  const r = await helix("PUT", `/users/blocks?target_user_id=${encodeURIComponent(user.id)}&source_context=chat&reason=spam`, token);
  if (!r.ok) {
    await recordMonitorEvent("followbot_block_failed", `${broadcasterId} ${user.login}: ${r.status}`);
    return false;
  }
  await sqlite.execute(
    "INSERT OR REPLACE INTO followbot_blocks (broadcaster_id, user_id, login, score, reasons, source, blocked_at) VALUES (?,?,?,?,?,?,?)",
    [broadcasterId, user.id, user.login, score, reasons.join("; "), source, Date.now()],
  );
  return true;
}

async function announce(broadcasterId: string, n: number) {
  const now = Date.now();
  const p = pendingAnnounce.get(broadcasterId) ?? { count: 0, last: 0 };
  p.count += n;
  pendingAnnounce.set(broadcasterId, p);
  if (now - p.last < ANNOUNCE_EVERY_MS) return;
  const b = await getBroadcaster(broadcasterId);
  if (!b || Number(b.is_live) !== 1) return;
  await sendChatMessage(`🧹 Removed ${p.count} follow bot${p.count === 1 ? "" : "s"}.`, broadcasterId);
  pendingAnnounce.set(broadcasterId, { count: 0, last: now });
}

/** channel.follow hook (main.ts, before the thank-you). True when the
 * follower was blocked as a bot. */
// deno-lint-ignore no-explicit-any
export async function maybeBlockFollowBot(event: any): Promise<boolean> {
  const broadcasterId = String(event?.broadcaster_user_id ?? "");
  const userId = String(event?.user_id ?? "");
  const login = String(event?.user_login ?? "");
  if (!broadcasterId || !userId) return false;
  const now = Date.now();
  const times = (follows.get(broadcasterId) ?? []).filter((t) => now - t < 60_000);
  times.push(now);
  follows.set(broadcasterId, times);
  if (!(await isCommandGroupEnabled(broadcasterId, "followbots"))) return false;
  if (await isChannelBlocked(broadcasterId)) return false;
  // Bots the channel trusts (its bot list, known service bots) are never blocked.
  if (await isChannelBot(broadcasterId, login, userId, env("TWITCH_BOT_ID"))) return false;
  const [user] = await getUsersById([userId]);
  if (!user) return false;
  const s = scoreUser(user);
  if (!s) return false;
  const burst = times.length >= BURST_FOLLOWS;
  if (s.score < BLOCK_SCORE && !(burst && s.score >= BURST_SCORE)) return false;
  const t = await getScopedToken(broadcasterId, BLOCK_SCOPE);
  if ("problem" in t) return false;
  if (!(await blockUser(t.token, broadcasterId, user, s.score, burst ? [...s.reasons, "followed during a follow wave"] : s.reasons, "auto"))) return false;
  await announce(broadcasterId, 1);
  return true;
}

/** The newest followers (up to SCAN_LIMIT), scored. */
export async function scanFollowers(broadcasterId: string, token: string) {
  const ids: string[] = [];
  let cursor = "";
  while (ids.length < SCAN_LIMIT) {
    const r = await helix("GET", `/channels/followers?broadcaster_id=${broadcasterId}&first=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`, token);
    if (!r.ok) break;
    for (const f of r.data?.data ?? []) ids.push(String(f.user_id));
    cursor = String(r.data?.pagination?.cursor ?? "");
    if (!cursor) break;
  }
  const users = await getUsersById(ids);
  const flagged: Array<{ user: HelixUser; score: BotScore }> = [];
  for (const u of users) {
    const s = scoreUser(u);
    if (s && s.score >= BLOCK_SCORE && !(await isChannelBot(broadcasterId, u.login, u.id, env("TWITCH_BOT_ID")))) flagged.push({ user: u, score: s });
  }
  return { scanned: ids.length, flagged };
}

export type FollowBotBlock = { userId: string; login: string; score: number; reasons: string; source: string; blockedAt: number };

export async function listFollowBotBlocks(broadcasterId: string, limit = 100): Promise<FollowBotBlock[]> {
  const res = await sqlite.execute("SELECT * FROM followbot_blocks WHERE broadcaster_id = ? ORDER BY blocked_at DESC LIMIT ?", [broadcasterId, limit]);
  return res.rows.map((r: any) => ({ userId: String(r.user_id), login: String(r.login), score: Number(r.score), reasons: String(r.reasons), source: String(r.source), blockedAt: Number(r.blocked_at) }));
}

/** Unblocks an account (they'll need to follow again) and drops it from the log. */
export async function unblockFollower(broadcasterId: string, userId: string): Promise<"ok" | "no_token" | "no_scope" | "failed"> {
  const t = await getScopedToken(broadcasterId, BLOCK_SCOPE);
  if ("problem" in t) return t.problem;
  const r = await helix("DELETE", `/users/blocks?target_user_id=${encodeURIComponent(userId)}`, t.token);
  if (!r.ok) return "failed";
  await sqlite.execute("DELETE FROM followbot_blocks WHERE broadcaster_id = ? AND user_id = ?", [broadcasterId, userId]);
  return "ok";
}

/** Scans the newest followers and (unless `dryRun`) blocks the bots among
 * them. Shares !removebots' 15-minute cooldown. */
export async function removeFollowBots(broadcasterId: string, dryRun: boolean): Promise<{ scanned: number; flagged: string[]; removed: number } | { problem: "no_token" | "no_scope" | "cooldown"; minutes?: number }> {
  const now = Date.now();
  if (!dryRun && now - (lastScan.get(broadcasterId) ?? 0) < SCAN_COOLDOWN_MS) {
    return { problem: "cooldown", minutes: Math.ceil((SCAN_COOLDOWN_MS - (now - (lastScan.get(broadcasterId) ?? 0))) / 60_000) };
  }
  const read = await getScopedToken(broadcasterId, FOLLOW_SCOPE);
  if ("problem" in read) return { problem: read.problem };
  const block = dryRun ? read : await getScopedToken(broadcasterId, BLOCK_SCOPE);
  if ("problem" in block) return { problem: block.problem };
  if (!dryRun) lastScan.set(broadcasterId, now);
  const { scanned, flagged } = await scanFollowers(broadcasterId, read.token);
  let removed = 0;
  if (!dryRun) for (const f of flagged) if (await blockUser(block.token, broadcasterId, f.user, f.score.score, f.score.reasons, "scan")) removed++;
  return { scanned, flagged: flagged.map((f) => f.user.login), removed };
}

/** !followbots / !followban / !followbanoff / !removebots / !checkforbots. */
export async function handleFollowBotCommand(chatMessage: string, display: string, broadcasterId: string, isModerator: boolean, baseUrl: string): Promise<boolean> {
  const msg = chatMessage.trim();
  const toggle = msg.match(/^!(?:followbots(?:\s+(on|off|status))?|(followban)|(followbanoff))$/i);
  const scan = msg.match(/^!(removebots|checkforbots)(?:\s+(undo)\s+@?(\w{1,25}))?$/i);
  if (!toggle && !scan) return false;
  if (await getCustomCommand(broadcasterId, msg.slice(1).split(/\s+/)[0].toLowerCase())) return false; // the channel's own command wins

  if (toggle) {
    const arg = toggle[2] ? "on" : toggle[3] ? "off" : (toggle[1] ?? "status").toLowerCase();
    if (arg === "status") {
      const on = await isCommandGroupEnabled(broadcasterId, "followbots");
      await sendChatMessage(`@${display} Follow-bot blocking is ${on ? "on — new followers that look like bots are blocked, which removes their follow" : "off"}. Mods: !followbots on/off, !removebots, !checkforbots.`, broadcasterId);
      return true;
    }
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can switch follow-bot blocking.`, broadcasterId);
      return true;
    }
    await setCommandGroupEnabled(broadcasterId, "followbots", arg === "on");
    const perm = arg === "on" ? await getScopedToken(broadcasterId, BLOCK_SCOPE) : { token: "" };
    await sendChatMessage(
      `@${display} Follow-bot blocking is ${arg}.${arg === "on" ? " New followers that look like bots (brand-new account, default picture, generated name) are blocked, which removes their follow." : ""}${"problem" in perm ? ` I can't block yet — ${reconnectHint(baseUrl)}.` : ""}`,
      broadcasterId,
    );
    return true;
  }

  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can run !${scan![1].toLowerCase()}.`, broadcasterId);
    return true;
  }
  const word = scan![1].toLowerCase();

  if (scan![2]) {
    const login = scan![3].toLowerCase();
    const t = await getScopedToken(broadcasterId, BLOCK_SCOPE);
    if ("problem" in t) {
      await sendChatMessage(`@${display} I can't unblock — ${reconnectHint(baseUrl)}.`, broadcasterId);
      return true;
    }
    const id = await getUserIdByLogin(login);
    const r = id ? await helix("DELETE", `/users/blocks?target_user_id=${id}`, t.token) : null;
    if (id) await sqlite.execute("DELETE FROM followbot_blocks WHERE broadcaster_id = ? AND user_id = ?", [broadcasterId, id]);
    await sendChatMessage(`@${display} ${!id ? `there's no Twitch user “${login}”.` : r?.ok ? `unblocked ${login} — they'll need to follow again.` : "Twitch wouldn't unblock them — try again."}`, broadcasterId);
    return true;
  }

  const now = Date.now();
  if (word === "removebots" && now - (lastScan.get(broadcasterId) ?? 0) < SCAN_COOLDOWN_MS) {
    const mins = Math.ceil((SCAN_COOLDOWN_MS - (now - (lastScan.get(broadcasterId) ?? 0))) / 60_000);
    await sendChatMessage(`@${display} !removebots can run again in ${mins} min.`, broadcasterId);
    return true;
  }
  const read = await getScopedToken(broadcasterId, FOLLOW_SCOPE);
  const block = word === "removebots" ? await getScopedToken(broadcasterId, BLOCK_SCOPE) : read;
  if ("problem" in read || "problem" in block) {
    await sendChatMessage(`@${display} I can't ${word === "removebots" ? "remove" : "check"} followers yet — ${reconnectHint(baseUrl)}.`, broadcasterId);
    return true;
  }
  if (word === "removebots") lastScan.set(broadcasterId, now);
  const { scanned, flagged } = await scanFollowers(broadcasterId, read.token);
  if (word === "checkforbots") {
    const names = flagged.slice(0, 5).map((f) => f.user.login).join(", ");
    await sendChatMessage(
      `@${display} Checked the newest ${scanned} followers: ${flagged.length ? `${flagged.length} look like bots (${names}${flagged.length > 5 ? ", …" : ""}). !removebots blocks them.` : "none look like bots."}`,
      broadcasterId,
    );
    return true;
  }
  let removed = 0;
  for (const f of flagged) if (await blockUser(block.token, broadcasterId, f.user, f.score.score, f.score.reasons, "scan")) removed++;
  await sendChatMessage(`@${display} Checked the newest ${scanned} followers and removed ${removed} follow bot${removed === 1 ? "" : "s"}.${removed ? " Made a mistake? !removebots undo @name" : ""}`, broadcasterId);
  return true;
}

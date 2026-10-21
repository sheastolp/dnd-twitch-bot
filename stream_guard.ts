// GuildScribe — stream protection: hate-raid shield, Shield Mode, offline
// lock and the going-live announcement (Sery_Bot-style). Follow bots live in
// followbots.ts; both use the Helix helpers and scoped-token check here.
//
// Hate-raid shield (dashboard switch "hateraid", !hateraid on/off/status;
// off by default). A hate raid is many accounts posting the same thing at
// once. Every non-mod/VIP/sub chat message is normalized (case, accents,
// look-alike spacing, @mentions and digits stripped) and grouped; when
// HATE_RAID_USERS different chatters post the same text inside
// HATE_RAID_WINDOW_MS, their accounts are looked up and — if at least
// HATE_RAID_YOUNG of them are under YOUNG_DAYS old — it's a raid:
//   • every young account in the group is banned (old accounts joining in on
//     a copypasta are left alone),
//   • Shield Mode goes on (when the moderator:manage:shield_mode permission
//     was granted), and chat is told once,
//   • for RAID_MODE_MS afterwards, any young account repeating a raid message
//     is banned on sight.
// Short messages (under MIN_RAID_TEXT letters) and commands never count, so
// hype trains, "gg" and !enter spam can't trip it.
//
// !shield on/off (mod): Shield Mode by hand.
//
// Offline lock (!offlinelock [shield|emote|followers|subs|off|status]):
// OFFLINE_LOCK_DELAY_MS after the stream goes offline, turn on Shield Mode
// or a chat mode so nobody harasses the empty chat; undone when the stream
// comes back (only what GuildScribe itself turned on). Applied by the
// offlinelock cron (server.ts) — table `offline_lock`.
//
// Going live (dashboard switch "golive", !onlinenotif on/off/status; off by
// default): on stream.online, post "<name> is live: <title> — <game>" and a
// heads-up if chat is still in emote-only/followers-only/subs-only/slow/
// Shield Mode. !onlinecheck (mod) runs that check any time.

import { sqlite } from "./sqlite.ts";
import { getValidAdToken } from "./ads.ts";
import { getBroadcasterAdToken } from "./ads_db.ts";
import { getBroadcaster, getCustomCommand, isChannelBlocked, isChannelEnabled, isCommandGroupEnabled, recordMonitorEvent, setCommandGroupEnabled } from "./db.ts";
import { banChatUser, env, getAppToken, getChannelInfo, sendChatMessage } from "./twitch.ts";
import { logModAction } from "./mod_log.ts";

export const SHIELD_SCOPE = "moderator:manage:shield_mode";
export const CHAT_SETTINGS_SCOPE = "moderator:manage:chat_settings";
const BAN_SCOPE = "moderator:manage:banned_users";

const HATE_RAID_USERS = Math.max(3, Number(Deno.env.get("HATE_RAID_USERS") ?? "5"));
const HATE_RAID_YOUNG = Math.max(2, Number(Deno.env.get("HATE_RAID_YOUNG") ?? "3"));
const HATE_RAID_WINDOW_MS = 30_000;
const RAID_MODE_MS = 10 * 60_000;
const YOUNG_DAYS = 90; // banned when part of a raid
const VERY_YOUNG_DAYS = 30; // counts toward deciding it *is* a raid
const MIN_RAID_TEXT = 12;
const OFFLINE_LOCK_DELAY_MS = 5 * 60_000;

// ── Tokens and Helix ────────────────────────────────────────────────────────

export type ScopedToken = { token: string } | { problem: "no_token" | "no_scope" };

/** The broadcaster's user token (refreshed if needed), checked for `scope`. */
export async function getScopedToken(broadcasterId: string, scope: string): Promise<ScopedToken> {
  const token = await getValidAdToken(broadcasterId);
  if (!token) return { problem: "no_token" };
  const row = await getBroadcasterAdToken(broadcasterId);
  if (!String(row?.scope ?? "").split(/\s+/).includes(scope)) return { problem: "no_scope" };
  return { token };
}

export const reconnectHint = (baseUrl: string) => `the broadcaster needs to reconnect at ${baseUrl}/connect and approve the new permissions`;

/** One Helix call; never throws. */
export async function helix(method: string, path: string, token: string | null, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(`https://api.twitch.tv/helix${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token ?? await getAppToken()}`,
        "Client-Id": env("TWITCH_CLIENT_ID"),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    let data: any = null;
    try { data = await res.json(); } catch (_) { /* 204 */ }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { message: String(e) } };
  }
}

export type HelixUser = { id: string; login: string; display_name: string; created_at: string; profile_image_url: string };

/** Get Users by id (app token), 100 per call. */
export async function getUsersById(ids: string[]): Promise<HelixUser[]> {
  const out: HelixUser[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const p = new URLSearchParams();
    for (const id of ids.slice(i, i + 100)) p.append("id", id);
    const r = await helix("GET", `/users?${p}`, null);
    if (r.ok) out.push(...(r.data?.data ?? []));
  }
  return out;
}

export const accountAgeDays = (u: HelixUser) => (Date.now() - new Date(u.created_at).getTime()) / 86_400_000;

// ── Shield Mode and chat settings ───────────────────────────────────────────

export async function setShieldMode(broadcasterId: string, on: boolean): Promise<"ok" | "no_token" | "no_scope" | "failed"> {
  const t = await getScopedToken(broadcasterId, SHIELD_SCOPE);
  if ("problem" in t) return t.problem;
  const r = await helix("PUT", `/moderation/shield_mode?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`, t.token, { is_active: on });
  return r.ok ? "ok" : "failed";
}

/** Whether Shield Mode is on; null when it can't be read. */
export async function getShieldMode(broadcasterId: string): Promise<boolean | null> {
  const t = await getScopedToken(broadcasterId, SHIELD_SCOPE);
  if ("problem" in t) return null;
  const r = await helix("GET", `/moderation/shield_mode?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`, t.token);
  return r.ok ? Boolean(r.data?.data?.[0]?.is_active) : null;
}

export type ChatSettings = { emote_mode: boolean; follower_mode: boolean; follower_mode_duration: number | null; subscriber_mode: boolean; slow_mode: boolean; slow_mode_wait_time: number | null; unique_chat_mode: boolean };

export async function getChatSettings(broadcasterId: string): Promise<ChatSettings | null> {
  const r = await helix("GET", `/chat/settings?broadcaster_id=${broadcasterId}`, null);
  return r.ok ? (r.data?.data?.[0] ?? null) : null;
}

export async function patchChatSettings(broadcasterId: string, patch: Partial<ChatSettings>): Promise<"ok" | "no_token" | "no_scope" | "failed"> {
  const t = await getScopedToken(broadcasterId, CHAT_SETTINGS_SCOPE);
  if ("problem" in t) return t.problem;
  const r = await helix("PATCH", `/chat/settings?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}`, t.token, patch);
  return r.ok ? "ok" : "failed";
}

/** "emote-only, subscriber-only and slow (30s)" — the restrictive modes that are on. */
export function describeChatModes(s: ChatSettings, shield: boolean | null): string[] {
  const on: string[] = [];
  if (shield) on.push("Shield Mode");
  if (s.emote_mode) on.push("emote-only");
  if (s.subscriber_mode) on.push("subscriber-only");
  if (s.follower_mode) on.push(`followers-only${s.follower_mode_duration ? ` (${s.follower_mode_duration} min)` : ""}`);
  if (s.slow_mode) on.push(`slow mode${s.slow_mode_wait_time ? ` (${s.slow_mode_wait_time}s)` : ""}`);
  if (s.unique_chat_mode) on.push("unique-chat");
  return on;
}

const joinList = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

// ── Hate-raid shield ────────────────────────────────────────────────────────

/** Normalized text used to group raid messages; "" when it's too short to count. */
export function raidKey(message: string): string {
  const t = message.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/@\S+/g, " ")
    .replace(/[​-‏⁠﻿]/g, "")
    .replace(/[0-9]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ").trim();
  return t.replace(/\s/g, "").length >= MIN_RAID_TEXT ? t.slice(0, 80) : "";
}

type Hit = { userId: string; login: string; display: string; at: number };
const recent = new Map<string, Map<string, Hit[]>>(); // channel → key → hits
const raidMode = new Map<string, { until: number; keys: Set<string>; banned: Set<string>; announced: boolean }>();
const ageCache = new Map<string, { days: number; at: number }>();

async function ageOf(ids: string[]): Promise<Map<string, number>> {
  const now = Date.now();
  const out = new Map<string, number>();
  const missing = ids.filter((id) => {
    const c = ageCache.get(id);
    if (c && now - c.at < 3_600_000) { out.set(id, c.days); return false; }
    return true;
  });
  for (const u of await getUsersById(missing)) {
    const days = accountAgeDays(u);
    ageCache.set(u.id, { days, at: now });
    out.set(u.id, days);
  }
  if (ageCache.size > 20_000) ageCache.clear();
  return out;
}

const isExemptChatter = (badges: any[]) => badges.some((b) => ["vip", "subscriber", "founder", "moderator", "broadcaster", "lead_moderator", "staff", "admin"].includes(String(b?.set_id ?? "")));

/** Chat hook (main.ts, after the spam filters). True when the message was
 * consumed (the chatter was banned as part of a hate raid). */
export async function maybeHateRaid(
  ev: { message: string; badges: any[] },
  display: string,
  login: string,
  userId: string,
  broadcasterId: string,
  isModerator: boolean,
  isLive: boolean,
): Promise<boolean> {
  if (isModerator || !userId || isExemptChatter(ev.badges) || ev.message.trim().startsWith("!")) return false;
  const key = raidKey(ev.message);
  if (!key) return false;
  if (!(await isCommandGroupEnabled(broadcasterId, "hateraid"))) return false;
  const now = Date.now();

  // Already in a raid: young accounts repeating a raid message go straight out.
  const mode = raidMode.get(broadcasterId);
  if (mode && mode.until > now && mode.keys.has(key)) {
    if (mode.banned.has(userId)) return true;
    const days = (await ageOf([userId])).get(userId);
    if (days !== undefined && days < YOUNG_DAYS) {
      await banRaiders(broadcasterId, [{ userId, login, display, at: now }], mode, ev.message);
      return true;
    }
    return false;
  }

  let byKey = recent.get(broadcasterId);
  if (!byKey) recent.set(broadcasterId, byKey = new Map());
  for (const [k, hits] of byKey) {
    const kept = hits.filter((h) => now - h.at < HATE_RAID_WINDOW_MS);
    if (kept.length) byKey.set(k, kept); else byKey.delete(k);
  }
  const hits = byKey.get(key) ?? [];
  if (!hits.some((h) => h.userId === userId)) hits.push({ userId, login, display, at: now });
  byKey.set(key, hits);
  if (hits.length < HATE_RAID_USERS) return false;

  const ages = await ageOf(hits.map((h) => h.userId));
  const veryYoung = hits.filter((h) => (ages.get(h.userId) ?? 9999) < VERY_YOUNG_DAYS);
  if (veryYoung.length < HATE_RAID_YOUNG) return false;

  // It's a raid.
  const m = mode && mode.until > now ? mode : { until: 0, keys: new Set<string>(), banned: new Set<string>(), announced: false };
  m.until = now + RAID_MODE_MS;
  m.keys.add(key);
  raidMode.set(broadcasterId, m);
  byKey.delete(key);
  const targets = hits.filter((h) => (ages.get(h.userId) ?? 9999) < YOUNG_DAYS);
  const banned = await banRaiders(broadcasterId, targets, m, ev.message);
  await recordMonitorEvent("hate_raid", `${broadcasterId}: ${hits.length} chatters, banned ${banned}; "${key.slice(0, 60)}"`);
  if (!m.announced) {
    m.announced = true;
    const shield = await setShieldMode(broadcasterId, true);
    const shieldNote = shield === "ok" ? " Shield Mode is on — mods can lift it with !shield off when it's over." : "";
    const banNote = banned ? `banned ${banned} raider account${banned === 1 ? "" : "s"}` : "couldn't ban the raiders (no ban permission yet)";
    if (isLive || shield === "ok" || banned) {
      await sendChatMessage(`🛡️ Hate raid detected — ${banNote}.${shieldNote} Anyone new repeating it for the next 10 minutes is banned too.`, broadcasterId);
    }
  }
  return targets.some((t) => t.userId === userId);
}

async function banRaiders(broadcasterId: string, targets: Hit[], mode: { banned: Set<string> }, message = ""): Promise<number> {
  const t = await getScopedToken(broadcasterId, BAN_SCOPE);
  if ("problem" in t) return 0;
  let n = 0;
  for (const h of targets) {
    if (mode.banned.has(h.userId)) continue;
    mode.banned.add(h.userId);
    const r = await banChatUser(t.token, broadcasterId, broadcasterId, h.userId, "Hate raid (GuildScribe)");
    if (r.ok || r.status === 400) { // 400: already banned
      n++;
      await logModAction(broadcasterId, { kind: "hateraid", userId: h.userId, login: h.login, detail: message.slice(0, 200), by: "GuildScribe" });
    }
  }
  return n;
}

// ── Offline lock ────────────────────────────────────────────────────────────

export type LockMode = "shield" | "emote" | "followers" | "subs";
export const LOCK_LABELS: Record<LockMode, string> = { shield: "Shield Mode", emote: "emote-only chat", followers: "followers-only chat", subs: "subscriber-only chat" };
const LOCK_FIELD: Record<Exclude<LockMode, "shield">, keyof ChatSettings> = { emote: "emote_mode", followers: "follower_mode", subs: "subscriber_mode" };

export async function ensureStreamGuardTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS offline_lock (
      broadcaster_id TEXT PRIMARY KEY, mode TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      due_at INTEGER NOT NULL DEFAULT 0, applied TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
    )`,
  );
}

export async function purgeStreamGuardData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM offline_lock WHERE broadcaster_id = ?", [broadcasterId]);
  recent.delete(broadcasterId);
  raidMode.delete(broadcasterId);
}

export async function getLock(broadcasterId: string): Promise<{ mode: LockMode; enabled: boolean; dueAt: number; applied: string } | null> {
  const r = (await sqlite.execute("SELECT mode, enabled, due_at, applied FROM offline_lock WHERE broadcaster_id = ?", [broadcasterId])).rows[0] as any;
  return r ? { mode: String(r.mode) as LockMode, enabled: Number(r.enabled) === 1, dueAt: Number(r.due_at), applied: String(r.applied ?? "") } : null;
}

async function applyLock(broadcasterId: string, mode: LockMode, on: boolean): Promise<string> {
  if (mode === "shield") return await setShieldMode(broadcasterId, on);
  return await patchChatSettings(broadcasterId, { [LOCK_FIELD[mode]]: on } as Partial<ChatSettings>);
}

/** Turns the offline lock on with `mode`, or off (null). Shared by
 * !offlinelock and the Mod center. */
export async function setOfflineLock(broadcasterId: string, mode: LockMode | null) {
  if (!mode) {
    await sqlite.execute("UPDATE offline_lock SET enabled = 0, due_at = 0, updated_at = ? WHERE broadcaster_id = ?", [Date.now(), broadcasterId]);
    return;
  }
  await sqlite.execute(
    `INSERT INTO offline_lock (broadcaster_id, mode, enabled, due_at, applied, updated_at) VALUES (?,?,1,0,'',?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET mode = excluded.mode, enabled = 1, updated_at = excluded.updated_at`,
    [broadcasterId, mode, Date.now()],
  );
  const b = await getBroadcaster(broadcasterId);
  if (b && Number(b.is_live) !== 1) await sqlite.execute("UPDATE offline_lock SET due_at = ? WHERE broadcaster_id = ? AND applied = ''", [Date.now() + OFFLINE_LOCK_DELAY_MS, broadcasterId]);
}

/** stream.online / stream.offline (stream_status.ts). `offlineAt` is when the
 * stream dropped, so the lock delay counts from then, not from the end of the
 * reconnect grace. */
export async function onStreamStatusGuard(broadcasterId: string, online: boolean, offlineAt = Date.now()) {
  const lock = await getLock(broadcasterId);
  if (online) {
    if (lock?.applied) {
      const r = await applyLock(broadcasterId, lock.applied as LockMode, false);
      if (r !== "ok") await recordMonitorEvent("offline_lock_undo_failed", `${broadcasterId}: ${r}`);
    }
    if (lock) await sqlite.execute("UPDATE offline_lock SET due_at = 0, applied = '', updated_at = ? WHERE broadcaster_id = ?", [Date.now(), broadcasterId]);
    await announceLive(broadcasterId);
  } else if (lock?.enabled) {
    await sqlite.execute("UPDATE offline_lock SET due_at = ?, updated_at = ? WHERE broadcaster_id = ?", [offlineAt + OFFLINE_LOCK_DELAY_MS, Date.now(), broadcasterId]);
  }
}

/** Cron (server.ts, every minute): applies offline locks that are due. */
export default async function runOfflineLock() {
  const rows = (await sqlite.execute("SELECT broadcaster_id, mode FROM offline_lock WHERE enabled = 1 AND due_at > 0 AND due_at <= ? AND applied = ''", [Date.now()])).rows as any[];
  for (const row of rows) {
    const id = String(row.broadcaster_id);
    const mode = String(row.mode) as LockMode;
    const b = await getBroadcaster(id);
    await sqlite.execute("UPDATE offline_lock SET due_at = 0, updated_at = ? WHERE broadcaster_id = ?", [Date.now(), id]);
    if (!b || Number(b.connected) !== 1 || Number(b.is_live) === 1 || await isChannelBlocked(id)) continue;
    // Leave alone a mode the streamer already had on, so going live doesn't switch it off.
    if (mode === "shield" ? await getShieldMode(id) : (await getChatSettings(id))?.[LOCK_FIELD[mode as Exclude<LockMode, "shield">]]) continue;
    const r = await applyLock(id, mode, true);
    if (r === "ok") await sqlite.execute("UPDATE offline_lock SET applied = ?, updated_at = ? WHERE broadcaster_id = ?", [mode, Date.now(), id]);
    else await recordMonitorEvent("offline_lock_failed", `${id}: ${mode} ${r}`);
  }
}

// ── Going live ──────────────────────────────────────────────────────────────

/** "Heads up: chat is in emote-only and slow mode (30s)." or "" when chat is open. */
export async function chatCheckLine(broadcasterId: string): Promise<string | null> {
  const s = await getChatSettings(broadcasterId);
  if (!s) return null;
  const modes = describeChatModes(s, await getShieldMode(broadcasterId));
  return modes.length ? `Heads up: chat is in ${joinList(modes)}.` : "";
}

async function announceLive(broadcasterId: string) {
  const [b, on, enabled, blocked] = await Promise.all([
    getBroadcaster(broadcasterId),
    isCommandGroupEnabled(broadcasterId, "golive"),
    isChannelEnabled(broadcasterId),
    isChannelBlocked(broadcasterId),
  ]);
  if (!b || Number(b.connected) !== 1 || !on || !enabled || blocked) return;
  const info = await getChannelInfo(broadcasterId);
  const name = String(b.display_name || b.login || "The stream");
  const what = info ? [info.title, info.gameName].filter(Boolean).join(" — ") : "";
  const check = await chatCheckLine(broadcasterId);
  await sendChatMessage(`🔴 ${name} is live${what ? `: ${what}.` : "!"}${check ? ` ${check}` : ""}`.slice(0, 480), broadcasterId);
}

// ── Chat commands ───────────────────────────────────────────────────────────

async function toggleCommand(group: string, label: string, on: boolean | "status", display: string, broadcasterId: string, isModerator: boolean, onText: string) {
  if (on === "status") {
    const enabled = await isCommandGroupEnabled(broadcasterId, group);
    await sendChatMessage(`@${display} ${label} is ${enabled ? `on — ${onText}` : "off"}.`, broadcasterId);
    return;
  }
  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can switch ${label} ${on ? "on" : "off"}.`, broadcasterId);
    return;
  }
  await setCommandGroupEnabled(broadcasterId, group, on);
  await sendChatMessage(`@${display} ${label} is ${on ? `on — ${onText}` : "off"}.`, broadcasterId);
}

/** !hateraid, !shield, !offlinelock, !onlinenotif, !onlinecheck. */
export async function handleStreamGuardCommand(chatMessage: string, display: string, broadcasterId: string, isModerator: boolean, baseUrl: string): Promise<boolean> {
  const msg = chatMessage.trim();
  const word = msg.match(/^!(hateraid|raidguard|shield|offlinelock|offlinelockoff|onlinenotif|onlinecheck)(?:\s|$)/i);
  if (!word || await getCustomCommand(broadcasterId, word[1].toLowerCase())) return false; // the channel's own command wins
  let m = msg.match(/^!(?:hateraid|raidguard)(?:\s+(on|off|status))?$/i);
  if (m) {
    const arg = (m[1] ?? "status").toLowerCase();
    await toggleCommand("hateraid", "The hate-raid shield", arg === "status" ? "status" : arg === "on", display, broadcasterId, isModerator,
      `when ${HATE_RAID_USERS}+ chatters post the same message at once from brand-new accounts, I ban them and turn on Shield Mode`);
    if (arg === "on" && isModerator && "problem" in await getScopedToken(broadcasterId, BAN_SCOPE)) {
      await sendChatMessage(`@${display} I can't ban yet — ${reconnectHint(baseUrl)}.`, broadcasterId);
    }
    return true;
  }

  m = msg.match(/^!shield(?:\s+(on|off|status))?$/i);
  if (m) {
    const arg = (m[1] ?? "status").toLowerCase();
    if (arg === "status") {
      const s = await getShieldMode(broadcasterId);
      await sendChatMessage(`@${display} ${s === null ? `I can't read Shield Mode — ${reconnectHint(baseUrl)}.` : `Shield Mode is ${s ? "on" : "off"}.`}`, broadcasterId);
      return true;
    }
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can change Shield Mode.`, broadcasterId);
      return true;
    }
    const r = await setShieldMode(broadcasterId, arg === "on");
    await sendChatMessage(
      `@${display} ${r === "ok" ? `Shield Mode is ${arg}.` : r === "failed" ? "Twitch wouldn't change Shield Mode — try again." : `I can't change Shield Mode — ${reconnectHint(baseUrl)}.`}`,
      broadcasterId,
    );
    return true;
  }

  m = msg.match(/^!offlinelock(off)?(?:\s+(\S+))?$/i);
  if (m) {
    const arg = m[1] ? "off" : (m[2] ?? "status").toLowerCase();
    const lock = await getLock(broadcasterId);
    if (arg === "status") {
      await sendChatMessage(
        `@${display} Offline lock is ${lock?.enabled ? `on — ${LOCK_LABELS[lock.mode]} turns on 5 minutes after the stream ends and off when it starts again` : "off"}. Mods: !offlinelock shield | emote | followers | subs | off.`,
        broadcasterId,
      );
      return true;
    }
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can change the offline lock.`, broadcasterId);
      return true;
    }
    if (arg === "off") {
      await setOfflineLock(broadcasterId, null);
      await sendChatMessage(`@${display} Offline lock is off.${lock?.applied ? ` (${LOCK_LABELS[lock.applied as LockMode]} is still on from last time — switch it off in Twitch if you like.)` : ""}`, broadcasterId);
      return true;
    }
    const mode = ({ on: "shield", shield: "shield", emote: "emote", emoteonly: "emote", emotes: "emote", followers: "followers", follower: "followers", followersonly: "followers", subs: "subs", sub: "subs", subscribers: "subs", subonly: "subs" } as Record<string, LockMode>)[arg];
    if (!mode) {
      await sendChatMessage(`@${display} use !offlinelock shield, emote, followers, subs or off.`, broadcasterId);
      return true;
    }
    await setOfflineLock(broadcasterId, mode);
    const perm = await getScopedToken(broadcasterId, mode === "shield" ? SHIELD_SCOPE : CHAT_SETTINGS_SCOPE);
    await sendChatMessage(
      `@${display} Offline lock is on: ${LOCK_LABELS[mode]} turns on 5 minutes after the stream ends and back off when you go live.${"problem" in perm ? ` I don't have permission for that yet — ${reconnectHint(baseUrl)}.` : ""}`,
      broadcasterId,
    );
    return true;
  }

  m = msg.match(/^!onlinenotif(?:\s+(on|off|status))?$/i);
  if (m) {
    const arg = (m[1] ?? "status").toLowerCase();
    await toggleCommand("golive", "The going-live announcement", arg === "status" ? "status" : arg === "on", display, broadcasterId, isModerator,
      "I post the title and game when the stream starts, and warn if chat is still locked down");
    return true;
  }

  if (/^!onlinecheck$/i.test(msg)) {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can run !onlinecheck.`, broadcasterId);
      return true;
    }
    const line = await chatCheckLine(broadcasterId);
    await sendChatMessage(`@${display} ${line === null ? "I couldn't read the chat settings — try again." : line || "Chat is open: no emote-only, followers-only, subs-only, slow or Shield Mode."}`, broadcasterId);
    return true;
  }
  return false;
}

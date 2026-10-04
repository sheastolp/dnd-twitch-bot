// Auto-ban's memory of who was banned before, used as a reference for new
// bans. Spam-bot farms rarely change much between waves: the same pitch with
// a different @mention, or a fresh account named like the last one with new
// digits. So every ban becomes a reference:
//
//   - every auto-ban is recorded with the message that got the chatter banned;
//   - the channel's own Twitch ban list (bans mods made by hand) is imported
//     from Helix Get Banned Users — logins and reasons only, Twitch doesn't
//     keep the messages — on demand from /dashboard/autoban and at most every
//     IMPORT_EVERY_MS when that page is opened.
//
// A new message from a non-mod is then checked against the history when no
// word-list phrase matched:
//
//   - message match: after normalizing (case, look-alikes, @mentions, digits
//     and punctuation stripped) it's the same as, contains, or shares
//     SIMILARITY of its words with a previously banned message;
//   - name match: the chatter's login with digits/underscores stripped equals
//     a banned account's (only for numbered names, the bot-farm pattern) AND
//     the message itself looks promotional (spamScore ≥ 1), so a real viewer
//     who happens to share a name stem is never banned for the name alone.
//
// What happens on a match follows the learning mode (autoban_words.ts):
// "auto" bans, "suggest" queues the message for a mod to review, "off" skips
// the history entirely. Mods can forget individual references on the page.

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { env } from "./twitch.ts";
import { fold, normalizeText, spamScore } from "./autoban_words.ts";

export const IMPORT_EVERY_MS = 6 * 60 * 60_000;
/** Word overlap (Jaccard) that counts as "the same pitch". */
const SIMILARITY = 0.7;
const MIN_WORDS = 4;
const MIN_SKELETON = 15;
/** Most references held in the chat-path cache. */
const MAX_MESSAGE_REFS = 400;
const MAX_IMPORT = 2000;
const MAX_MESSAGE_LEN = 300;

export async function ensureAutoBanHistoryTables() {
  await sqlite.batch([
    `CREATE TABLE IF NOT EXISTS autoban_history (
      broadcaster_id TEXT NOT NULL, user_id TEXT NOT NULL, login TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
      banned_at INTEGER NOT NULL, PRIMARY KEY (broadcaster_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS autoban_history_sync (broadcaster_id TEXT PRIMARY KEY, synced_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0)`,
  ]);
}

export async function purgeAutoBanHistory(broadcasterId: string) {
  await sqlite.batch([
    { sql: "DELETE FROM autoban_history WHERE broadcaster_id = ?", args: [broadcasterId] },
    { sql: "DELETE FROM autoban_history_sync WHERE broadcaster_id = ?", args: [broadcasterId] },
  ]);
  cache.delete(broadcasterId);
}

// ── Fingerprints ──

/** The message with everything bots vary stripped: "Hey @bob, get 1000 viewers at x dot com!!" → "hey get viewers at x.com". */
export function skeleton(message: string): string {
  return fold(normalizeText(message).replace(/@\w+/g, " "))
    .replace(/\d+/g, " ")
    .replace(/[^a-z.\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const words = (sk: string) => new Set(sk.split(" ").filter((w) => w.length > 1));

/** A numbered login's stem ("streamboost_4471" → "streamboost"), or null for names without ≥3 digits. */
export function nameStem(login: string): string | null {
  const l = login.toLowerCase();
  if ((l.match(/\d/g) ?? []).length < 3) return null;
  const stem = l.replace(/[\d_]+/g, "");
  return stem.length >= 6 ? stem : null;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

// ── Recording ──

export async function recordBan(
  broadcasterId: string,
  b: { userId: string; login: string; message?: string; reason?: string; source: "autoban" | "history" | "twitch"; at?: number },
) {
  // Keep the first message we saw for a user (a re-import mustn't erase it).
  await sqlite.execute(
    `INSERT INTO autoban_history (broadcaster_id, user_id, login, message, reason, source, banned_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(broadcaster_id, user_id) DO UPDATE SET
       login = excluded.login,
       message = CASE WHEN autoban_history.message = '' THEN excluded.message ELSE autoban_history.message END,
       reason = CASE WHEN autoban_history.reason = '' THEN excluded.reason ELSE autoban_history.reason END`,
    [broadcasterId, b.userId, b.login.toLowerCase(), (b.message ?? "").slice(0, MAX_MESSAGE_LEN), (b.reason ?? "").slice(0, 200), b.source, b.at ?? Date.now()],
  );
  cache.delete(broadcasterId);
}

export async function forgetBan(broadcasterId: string, userId: string): Promise<boolean> {
  const res = await sqlite.execute("DELETE FROM autoban_history WHERE broadcaster_id = ? AND user_id = ?", [broadcasterId, userId]);
  cache.delete(broadcasterId);
  return res.rowsAffected > 0;
}

export interface BanRef {
  userId: string;
  login: string;
  message: string;
  reason: string;
  source: string;
  bannedAt: number;
}

export async function listBans(broadcasterId: string, limit = 50): Promise<{ refs: BanRef[]; total: number; syncedAt: number | null; imported: number }> {
  const [rows, total, sync] = await Promise.all([
    sqlite.execute("SELECT * FROM autoban_history WHERE broadcaster_id = ? ORDER BY banned_at DESC LIMIT ?", [broadcasterId, limit]),
    sqlite.execute("SELECT COUNT(*) AS n FROM autoban_history WHERE broadcaster_id = ?", [broadcasterId]),
    sqlite.execute("SELECT synced_at, count FROM autoban_history_sync WHERE broadcaster_id = ?", [broadcasterId]),
  ]);
  return {
    refs: rows.rows.map((r: any) => ({
      userId: String(r.user_id),
      login: String(r.login),
      message: String(r.message ?? ""),
      reason: String(r.reason ?? ""),
      source: String(r.source),
      bannedAt: Number(r.banned_at),
    })),
    total: Number(total.rows[0]?.n ?? 0),
    syncedAt: sync.rows.length ? Number(sync.rows[0].synced_at) : null,
    imported: Number(sync.rows[0]?.count ?? 0),
  };
}

/**
 * Imports the channel's permanent bans from Twitch (Helix Get Banned Users;
 * the broadcaster token's moderator:manage:banned_users scope covers it).
 * Returns how many bans Twitch listed, or an error message.
 */
export async function importTwitchBans(broadcasterId: string, token: string): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  let cursor = "";
  let count = 0;
  try {
    do {
      const params = new URLSearchParams({ broadcaster_id: broadcasterId, first: "100" });
      if (cursor) params.set("after", cursor);
      const res = await fetch(`https://api.twitch.tv/helix/moderation/banned?${params}`, {
        headers: { Authorization: `Bearer ${token}`, "Client-Id": env("TWITCH_CLIENT_ID") },
      });
      if (!res.ok) return { ok: false, error: `Twitch said ${res.status}` };
      const body = await res.json();
      for (const b of body?.data ?? []) {
        if (b.expires_at) continue; // timeouts aren't bans
        await recordBan(broadcasterId, {
          userId: String(b.user_id),
          login: String(b.user_login ?? ""),
          reason: String(b.reason ?? ""),
          source: "twitch",
          at: Date.parse(b.created_at) || Date.now(),
        });
        count++;
      }
      cursor = body?.pagination?.cursor ?? "";
    } while (cursor && count < MAX_IMPORT);
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
  await sqlite.execute("INSERT OR REPLACE INTO autoban_history_sync (broadcaster_id, synced_at, count) VALUES (?,?,?)", [broadcasterId, Date.now(), count]);
  cache.delete(broadcasterId);
  return { ok: true, count };
}

// ── Matching (chat path, cached) ──

interface Refs {
  messages: Array<{ login: string; sk: string; words: Set<string> }>;
  stems: Map<string, string>; // stem → a banned login with it
  at: number;
}
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, Refs>();

async function loadRefs(broadcasterId: string): Promise<Refs> {
  const hit = cache.get(broadcasterId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  const [msgs, names] = await Promise.all([
    sqlite.execute("SELECT login, message FROM autoban_history WHERE broadcaster_id = ? AND message != '' ORDER BY banned_at DESC LIMIT ?", [broadcasterId, MAX_MESSAGE_REFS]),
    sqlite.execute("SELECT login FROM autoban_history WHERE broadcaster_id = ? ORDER BY banned_at DESC LIMIT ?", [broadcasterId, MAX_IMPORT]),
  ]);
  const messages = msgs.rows
    .map((r: any) => ({ login: String(r.login), sk: skeleton(String(r.message)) }))
    .filter((m) => m.sk.length >= MIN_SKELETON)
    .map((m) => ({ ...m, words: words(m.sk) }));
  const stems = new Map<string, string>();
  for (const r of names.rows) {
    const stem = nameStem(String(r.login));
    if (stem && !stems.has(stem)) stems.set(stem, String(r.login));
  }
  const refs = { messages, stems, at: Date.now() };
  cache.set(broadcasterId, refs);
  return refs;
}

export type HistoryMatch = { kind: "message" | "name"; ref: string };

/** Whether this message/chatter matches someone banned before. */
export async function findHistoryMatch(broadcasterId: string, chatMessage: string, chatterLogin: string): Promise<HistoryMatch | null> {
  const refs = await loadRefs(broadcasterId);
  if (!refs.messages.length && !refs.stems.size) return null;
  const sk = skeleton(chatMessage);
  if (sk.length >= MIN_SKELETON) {
    const w = words(sk);
    for (const ref of refs.messages) {
      if (ref.sk === sk || (ref.sk.length >= 20 && sk.includes(ref.sk))) return { kind: "message", ref: ref.login };
      if (w.size >= MIN_WORDS && ref.words.size >= MIN_WORDS && jaccard(w, ref.words) >= SIMILARITY) return { kind: "message", ref: ref.login };
    }
  }
  const stem = nameStem(chatterLogin);
  if (stem && refs.stems.has(stem) && refs.stems.get(stem) !== chatterLogin.toLowerCase() && spamScore(normalizeText(chatMessage)).score >= 1) {
    return { kind: "name", ref: refs.stems.get(stem)! };
  }
  return null;
}

export function describeMatch(m: HistoryMatch): string {
  return m.kind === "message" ? `same message as banned ${m.ref}` : `named like banned ${m.ref}`;
}

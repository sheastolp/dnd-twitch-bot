// Ignore list — viewers GuildScribe ignores completely, without treating them
// as bots. Their chat messages are dropped before any feature sees them: no
// commands, no replies to @mentions or keyword triggers, no swear jar, no
// chat gold, no watch time, no NPC chatter or chronicle quotes. Their subs,
// raids, follows, cheers and channel-point redemptions get no thank-you or
// effect either, and the chat reader and idle overlays skip them.
//
// Moderation still applies: auto-ban, the spam filters and the hate-raid
// shield run before the ignore check, so an ignored spammer is still caught.
//
//   !ignore @user        mod: ignore them
//   !unignore @user      mod: listen to them again
//   !ignore list         mod: who's ignored
//   /dashboard/bots      mod: the same list, in its own section of the page
//
// Mods and the broadcaster are never ignored in chat, even if they're on the
// list, so nobody can lock the channel's mods out of the bot.
//
// Lookups go through a short per-isolate cache, so the chat hot path costs
// one read per channel every CACHE_MS at most.

import { sqlite } from "./sqlite.ts";
import { sendChatMessage } from "./twitch.ts";

const MAX_ENTRIES = 1000;
const CACHE_MS = 30_000;
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;

export type IgnoredCommandUser = { login: string; addedBy: string; addedAt: number };

export async function ensureCommandIgnoreTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS command_ignored (
      broadcaster_id TEXT NOT NULL, login TEXT NOT NULL, added_by TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, login)
    )`,
  );
}

/** Wipes the channel's ignore list — called from !dndbot leave purge. */
export async function purgeCommandIgnoreData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM command_ignored WHERE broadcaster_id = ?", [broadcasterId]);
  cache.delete(broadcasterId);
}

const cache = new Map<string, { at: number; logins: Set<string> }>();

async function loadSet(broadcasterId: string): Promise<Set<string>> {
  const hit = cache.get(broadcasterId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.logins;
  const res = await sqlite.execute("SELECT login FROM command_ignored WHERE broadcaster_id = ?", [broadcasterId]);
  const logins = new Set<string>((res.rows as any[]).map((r) => String(r.login)));
  cache.set(broadcasterId, { at: Date.now(), logins });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return logins;
}

/** Every ignored login in this channel (lowercase). Never throws. */
export async function getIgnoredLogins(broadcasterId: string): Promise<Set<string>> {
  try {
    return await loadSet(broadcasterId);
  } catch (e) {
    console.error("ignore list lookup failed", e);
    return new Set();
  }
}

/** Whether GuildScribe ignores this viewer in this channel. Never throws:
 * a failed lookup treats them as not ignored. */
export async function isIgnoredViewer(broadcasterId: string, login: string): Promise<boolean> {
  if (!broadcasterId || !login) return false;
  try {
    return (await loadSet(broadcasterId)).has(login.toLowerCase());
  } catch (e) {
    console.error("ignore list lookup failed", e);
    return false;
  }
}

export async function listCommandIgnored(broadcasterId: string): Promise<IgnoredCommandUser[]> {
  const res = await sqlite.execute(
    "SELECT login, added_by, added_at FROM command_ignored WHERE broadcaster_id = ? ORDER BY added_at DESC LIMIT ?",
    [broadcasterId, MAX_ENTRIES],
  );
  return (res.rows as any[]).map((r) => ({ login: String(r.login), addedBy: String(r.added_by ?? ""), addedAt: Number(r.added_at) }));
}

/** Adds viewers; ones already listed are left alone. Returns the logins actually added. */
export async function addCommandIgnored(broadcasterId: string, logins: string[], addedBy: string): Promise<string[]> {
  const added: string[] = [];
  const existing = await sqlite.execute("SELECT COUNT(*) AS n FROM command_ignored WHERE broadcaster_id = ?", [broadcasterId]);
  let room = MAX_ENTRIES - Number((existing.rows as any[])[0]?.n ?? 0);
  for (const raw of logins) {
    const login = raw.trim().replace(/^@/, "").toLowerCase();
    if (!LOGIN_RE.test(login) || room <= 0) continue;
    const res = await sqlite.execute(
      "INSERT OR IGNORE INTO command_ignored (broadcaster_id, login, added_by, added_at) VALUES (?,?,?,?)",
      [broadcasterId, login, addedBy.slice(0, 25), Date.now()],
    );
    if (Number(res.rowsAffected) > 0) {
      added.push(login);
      room--;
    }
  }
  if (added.length) cache.delete(broadcasterId);
  return added;
}

export async function removeCommandIgnored(broadcasterId: string, login: string): Promise<boolean> {
  const res = await sqlite.execute("DELETE FROM command_ignored WHERE broadcaster_id = ? AND login = ?", [broadcasterId, login.toLowerCase()]);
  cache.delete(broadcasterId);
  return Number(res.rowsAffected) > 0;
}

/** Handles !ignore / !unignore. Returns true if the message matched. */
export async function handleCommandIgnoreCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  isModerator: boolean,
  broadcasterId: string,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!(ignore|unignore)(?:\s+(.*))?$/i);
  if (!m) return false;
  const say = (text: string) => sendChatMessage(`@${display} ${text}`, broadcasterId);
  const verb = m[1].toLowerCase();
  if (!isModerator) {
    await say("only the broadcaster or a moderator can change who GuildScribe ignores.");
    return true;
  }
  const arg = (m[2] ?? "").trim().split(/\s+/)[0] ?? "";

  if (verb === "ignore" && (arg.toLowerCase() === "list" || arg === "")) {
    if (arg === "") {
      await say("usage: !ignore @user (GuildScribe ignores them completely) | !unignore @user | !ignore list");
      return true;
    }
    const list = await listCommandIgnored(broadcasterId);
    if (!list.length) await say("🔇 Nobody is being ignored.");
    else {
      const names = list.map((u) => u.login);
      const shown = names.slice(0, 20).join(", ");
      await say(`🔇 Ignoring ${list.length}: ${shown}${names.length > 20 ? `, and ${names.length - 20} more (see the dashboard's bot list page)` : ""}.`);
    }
    return true;
  }

  const target = arg.replace(/^@/, "").toLowerCase();
  if (!LOGIN_RE.test(target)) {
    await say(`usage: !${verb} @user`);
    return true;
  }
  if (verb === "ignore") {
    if (target === chatter.toLowerCase()) {
      await say("you can't ignore yourself.");
      return true;
    }
    const added = await addCommandIgnored(broadcasterId, [target], chatter);
    await say(
      added.length
        ? `🔇 GuildScribe will ignore ${target} completely: no commands, replies, gold, swear jar or watch time. (Mods are never ignored. !unignore ${target} to undo.)`
        : `${target} is already ignored.`,
    );
  } else {
    await say(
      (await removeCommandIgnored(broadcasterId, target))
        ? `🔊 GuildScribe is listening to ${target} again.`
        : `${target} wasn't being ignored.`,
    );
  }
  return true;
}

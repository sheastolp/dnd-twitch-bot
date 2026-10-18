// GuildScribe — the moderation action log behind the 🛡️ Mod center
// (mod_center.ts). Spam filters keep their own automod_log and auto-ban its
// autoban_history, and follow-bot blocks are in followbot_blocks; everything
// else that acts on chat lands here: hate-raid bans, and what mods do from
// the Mod center (unban, unblock, Shield Mode, chat modes, offline lock).
// Keeps the newest LOG_KEEP rows per channel. Purged by !dndbot leave purge.

import { sqlite } from "./sqlite.ts";

const LOG_KEEP = 500;

export type ModActionKind = "hateraid" | "ban" | "timeout" | "unban" | "unblock" | "shield" | "chatmode" | "offlinelock" | "strikes" | "settings";

export interface ModAction {
  at: number;
  kind: ModActionKind;
  userId: string;
  login: string;
  detail: string;
  by: string;
}

export async function ensureModLogTables() {
  await sqlite.batch([
    `CREATE TABLE IF NOT EXISTS mod_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, broadcaster_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '', login TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', by_whom TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS mod_actions_channel ON mod_actions (broadcaster_id, id)`,
  ]);
}

export async function purgeModLogData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM mod_actions WHERE broadcaster_id = ?", [broadcasterId]);
}

export async function logModAction(broadcasterId: string, a: Omit<ModAction, "at"> & { at?: number }) {
  await sqlite.batch([
    {
      sql: "INSERT INTO mod_actions (broadcaster_id, at, kind, user_id, login, detail, by_whom) VALUES (?,?,?,?,?,?,?)",
      args: [broadcasterId, a.at ?? Date.now(), a.kind, a.userId, a.login.toLowerCase(), a.detail.slice(0, 300), a.by.slice(0, 40)],
    },
    {
      sql: `DELETE FROM mod_actions WHERE broadcaster_id = ? AND id <= (
              SELECT id FROM mod_actions WHERE broadcaster_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      args: [broadcasterId, broadcasterId, LOG_KEEP],
    },
  ]);
}

export async function listModActions(broadcasterId: string, limit = 100): Promise<ModAction[]> {
  const res = await sqlite.execute(
    "SELECT at, kind, user_id, login, detail, by_whom FROM mod_actions WHERE broadcaster_id = ? ORDER BY id DESC LIMIT ?",
    [broadcasterId, limit],
  );
  return res.rows.map((r: any) => ({ at: Number(r.at), kind: String(r.kind) as ModActionKind, userId: String(r.user_id), login: String(r.login), detail: String(r.detail), by: String(r.by_whom) }));
}

// Persistence for chronicle.ts, npcs.ts, and the !rollcall dice leaderboard —
// split out of db.ts (which is already near Val Town's per-file size cap)
// rather than growing that file further. Mirrors db.ts's own conventions
// (INSERT OR REPLACE, broadcaster_id-keyed rows).

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

export async function ensureSocialTables() {
  // Chronicle: randomly quotes a plain chat message back with a D&D-flavored
  // reply. Off by default per channel; toggled with !chronicle.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS chronicle_settings (
      broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
    )`,
  );
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS chronicle_cooldowns (broadcaster_id TEXT PRIMARY KEY, last_at INTEGER NOT NULL)`);
  // Running count of chat messages (any account, bots included) seen since
  // the chronicle's last quote in a channel — see bumpChronicleMessageCount.
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS chronicle_activity (broadcaster_id TEXT PRIMARY KEY, message_count INTEGER NOT NULL DEFAULT 0)`);
  // AI-voiced NPC characters: off by default per channel; toggled with !npc
  // on/off/status, same pattern as merchant/chronicle. See npcs.ts.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS npc_settings (
      broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
    )`,
  );
  // Passive NPC chatter: an NPC occasionally chimes into plain chat
  // unprompted, mirroring chronicle_settings/chronicle_activity/
  // chronicle_cooldowns exactly. Off by default and requires npc_settings to
  // also be enabled — toggled with !npc chatter on/off/status. See npcs.ts.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS npc_chatter_settings (
      broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
    )`,
  );
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS npc_chatter_cooldowns (broadcaster_id TEXT PRIMARY KEY, last_at INTEGER NOT NULL)`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS npc_chatter_activity (broadcaster_id TEXT PRIMARY KEY, message_count INTEGER NOT NULL DEFAULT 0)`);
  // AI-voiced NPC characters — see npcs.ts. owner_key scopes a roster to one
  // tenant, currently always "twitch:<broadcasterId>" — or the literal
  // "global" for the fixed roster available as a fallback everywhere (see
  // PRIMARY_BROADCASTER_ID in npcs.ts).
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS npc_characters (
      owner_key TEXT, name TEXT, personality TEXT, created_by TEXT,
      created_at INTEGER, updated_at INTEGER, uses INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_key, name)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS npc_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_key TEXT NOT NULL, channel_id TEXT NOT NULL, character_name TEXT NOT NULL,
      role TEXT NOT NULL, author TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_npc_conversations_lookup ON npc_conversations(owner_key, channel_id, character_name, created_at)`);
  // Natural 1/20 log for the dice roller leaderboard (!rollcall) — one
  // row per qualifying 1d20 roll from !roll/!r/!d20 (including ability
  // checks/saves, since those are 1d20+mod under the hood). See
  // recordDiceRollEvent/getDiceLeaderboard below and the handler in main.ts.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS dice_roll_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcaster_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_dice_roll_events_lookup ON dice_roll_events(broadcaster_id, kind, created_at)`);
}

// ── Chronicle toggles & cooldown (see chronicle.ts) ──

export async function isChronicleEnabled(broadcasterId: string) {
  const res = await sqlite.execute("SELECT enabled FROM chronicle_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length > 0 && Number(res.rows[0].enabled) === 1;
}

/** Toggle the chronicle's random chat-quoting. Off by default. */
export async function setChronicleEnabled(broadcasterId: string, enabled: boolean) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO chronicle_settings (broadcaster_id, enabled, updated_at) VALUES (?,?,?)",
    [broadcasterId, enabled ? 1 : 0, Date.now()],
  );
}

/** Per-channel cooldown gate for chronicle quotes, mirrors
 * checkGoodnightCooldown: returns false (and leaves the timestamp alone) if
 * still cooling down, otherwise stamps "now" and returns true. */
export async function checkChronicleCooldown(broadcasterId: string, cooldownMs: number) {
  const now = Date.now();
  const res = await sqlite.execute("SELECT last_at FROM chronicle_cooldowns WHERE broadcaster_id = ?", [broadcasterId]);
  const last = Number(res.rows[0]?.last_at ?? 0);
  if (now - last < cooldownMs) return false;
  await sqlite.execute("INSERT OR REPLACE INTO chronicle_cooldowns (broadcaster_id,last_at) VALUES (?,?)", [broadcasterId, now]);
  return true;
}

/** Increments the running count of chat messages seen since the chronicle's
 * last quote in this channel — every message counts, including bot
 * accounts, so a bot-heavy but otherwise quiet channel still builds up
 * enough activity for a quote to eventually fire (bots just never get
 * selected as the one quoted). Returns the updated count. */
export async function bumpChronicleMessageCount(broadcasterId: string): Promise<number> {
  await sqlite.execute(
    "INSERT OR IGNORE INTO chronicle_activity (broadcaster_id, message_count) VALUES (?, 0)",
    [broadcasterId],
  );
  await sqlite.execute(
    "UPDATE chronicle_activity SET message_count = message_count + 1 WHERE broadcaster_id = ?",
    [broadcasterId],
  );
  const res = await sqlite.execute("SELECT message_count FROM chronicle_activity WHERE broadcaster_id = ?", [broadcasterId]);
  return Number(res.rows[0]?.message_count ?? 0);
}

/** Resets a channel's chronicle message-activity count to 0, called right
 * after a quote actually posts. */
export async function resetChronicleMessageCount(broadcasterId: string) {
  await sqlite.execute("UPDATE chronicle_activity SET message_count = 0 WHERE broadcaster_id = ?", [broadcasterId]);
}

// ── NPC toggles & chatter cooldown (see npcs.ts) ──

export async function isNpcEnabled(broadcasterId: string) {
  const res = await sqlite.execute("SELECT enabled FROM npc_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length > 0 && Number(res.rows[0].enabled) === 1;
}

/** Toggle AI-voiced NPC characters. Off by default. */
export async function setNpcEnabled(broadcasterId: string, enabled: boolean) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO npc_settings (broadcaster_id, enabled, updated_at) VALUES (?,?,?)",
    [broadcasterId, enabled ? 1 : 0, Date.now()],
  );
}

export async function isNpcChatterEnabled(broadcasterId: string) {
  const res = await sqlite.execute("SELECT enabled FROM npc_chatter_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length > 0 && Number(res.rows[0].enabled) === 1;
}

/** Toggle passive/random NPC chatter. Off by default, independent of
 * npc_settings (both must be on for an NPC to actually chime in). */
export async function setNpcChatterEnabled(broadcasterId: string, enabled: boolean) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO npc_chatter_settings (broadcaster_id, enabled, updated_at) VALUES (?,?,?)",
    [broadcasterId, enabled ? 1 : 0, Date.now()],
  );
}

/** Per-channel cooldown gate for random NPC chatter, mirrors
 * checkChronicleCooldown. */
export async function checkNpcChatterCooldown(broadcasterId: string, cooldownMs: number) {
  const now = Date.now();
  const res = await sqlite.execute("SELECT last_at FROM npc_chatter_cooldowns WHERE broadcaster_id = ?", [broadcasterId]);
  const last = Number(res.rows[0]?.last_at ?? 0);
  if (now - last < cooldownMs) return false;
  await sqlite.execute("INSERT OR REPLACE INTO npc_chatter_cooldowns (broadcaster_id,last_at) VALUES (?,?)", [broadcasterId, now]);
  return true;
}

/** Increments the running count of chat messages seen since an NPC last
 * chimed in unprompted in this channel — mirrors bumpChronicleMessageCount,
 * including bot accounts in the count (see recordNpcChatterBotMessage). */
export async function bumpNpcChatterMessageCount(broadcasterId: string): Promise<number> {
  await sqlite.execute(
    "INSERT OR IGNORE INTO npc_chatter_activity (broadcaster_id, message_count) VALUES (?, 0)",
    [broadcasterId],
  );
  await sqlite.execute(
    "UPDATE npc_chatter_activity SET message_count = message_count + 1 WHERE broadcaster_id = ?",
    [broadcasterId],
  );
  const res = await sqlite.execute("SELECT message_count FROM npc_chatter_activity WHERE broadcaster_id = ?", [broadcasterId]);
  return Number(res.rows[0]?.message_count ?? 0);
}

/** Resets a channel's NPC-chatter activity count to 0, called right after a
 * random chime-in actually posts. */
export async function resetNpcChatterMessageCount(broadcasterId: string) {
  await sqlite.execute("UPDATE npc_chatter_activity SET message_count = 0 WHERE broadcaster_id = ?", [broadcasterId]);
}

// ── NPC characters (see npcs.ts) ──

export interface NpcCharacterRow {
  owner_key: string;
  name: string;
  personality: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  uses: number;
}

export async function countNpcCharacters(ownerKey: string): Promise<number> {
  const res = await sqlite.execute("SELECT COUNT(*) AS count FROM npc_characters WHERE owner_key = ?", [ownerKey]);
  return Number(res.rows[0]?.count ?? 0);
}

/** Exact lookup within one roster only — no global fallback. Name match is
 * case-insensitive since chat input isn't reliably cased. */
export async function getNpcCharacterExact(ownerKey: string, name: string): Promise<NpcCharacterRow | null> {
  const res = await sqlite.execute(
    "SELECT * FROM npc_characters WHERE owner_key = ? AND LOWER(name) = LOWER(?)",
    [ownerKey, name],
  );
  return res.rows.length ? (res.rows[0] as NpcCharacterRow) : null;
}

/** Looks up a character in the caller's own roster first, falling back to
 * the shared "global" roster if the tenant hasn't defined one by that name. */
export async function getNpcCharacter(ownerKey: string, name: string): Promise<NpcCharacterRow | null> {
  const own = await getNpcCharacterExact(ownerKey, name);
  if (own) return own;
  if (ownerKey === "global") return null;
  return await getNpcCharacterExact("global", name);
}

/** Lists a tenant's own NPCs plus any global ones not shadowed by a
 * same-named local one, name ascending. */
export async function listNpcCharacters(ownerKey: string): Promise<NpcCharacterRow[]> {
  const res = await sqlite.execute(
    `SELECT * FROM npc_characters WHERE owner_key = ? OR owner_key = 'global' ORDER BY name ASC`,
    [ownerKey],
  );
  const rows = res.rows as NpcCharacterRow[];
  const seen = new Set<string>();
  const merged: NpcCharacterRow[] = [];
  // Prefer the tenant's own row over a same-named global one.
  for (const r of rows.filter((r) => r.owner_key === ownerKey)) {
    merged.push(r);
    seen.add(r.name.toLowerCase());
  }
  for (const r of rows.filter((r) => r.owner_key === "global")) {
    if (!seen.has(r.name.toLowerCase())) merged.push(r);
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

export async function addNpcCharacter(
  ownerKey: string,
  name: string,
  personality: string,
  createdBy: string,
  maxPerOwner: number,
): Promise<{ ok: true } | { ok: false; error: "exists" | "cap"; max?: number }> {
  if (await getNpcCharacterExact(ownerKey, name)) return { ok: false, error: "exists" };
  if ((await countNpcCharacters(ownerKey)) >= maxPerOwner) return { ok: false, error: "cap", max: maxPerOwner };
  const now = Date.now();
  await sqlite.execute(
    "INSERT INTO npc_characters (owner_key,name,personality,created_by,created_at,updated_at,uses) VALUES (?,?,?,?,?,?,0)",
    [ownerKey, name, personality, createdBy, now, now],
  );
  return { ok: true };
}

export async function editNpcCharacter(ownerKey: string, name: string, personality: string): Promise<boolean> {
  const row = await getNpcCharacterExact(ownerKey, name);
  if (!row) return false;
  await sqlite.execute(
    "UPDATE npc_characters SET personality = ?, updated_at = ? WHERE owner_key = ? AND name = ?",
    [personality, Date.now(), ownerKey, row.name],
  );
  return true;
}

export async function deleteNpcCharacter(ownerKey: string, name: string): Promise<boolean> {
  const row = await getNpcCharacterExact(ownerKey, name);
  if (!row) return false;
  await sqlite.execute("DELETE FROM npc_characters WHERE owner_key = ? AND name = ?", [ownerKey, row.name]);
  return true;
}

export async function bumpNpcCharacterUses(ownerKey: string, name: string): Promise<void> {
  await sqlite.execute(
    "UPDATE npc_characters SET uses = uses + 1 WHERE owner_key = ? AND LOWER(name) = LOWER(?)",
    [ownerKey, name],
  );
}

// ── NPC conversation history (see npcs.ts) ──

export interface NpcConversationRow {
  role: "user" | "assistant";
  author: string | null;
  content: string;
  created_at: number;
}

export async function appendNpcConversationMessage(
  ownerKey: string,
  channelId: string,
  characterName: string,
  role: "user" | "assistant",
  content: string,
  author?: string,
): Promise<void> {
  await sqlite.execute(
    "INSERT INTO npc_conversations (owner_key,channel_id,character_name,role,author,content,created_at) VALUES (?,?,?,?,?,?,?)",
    [ownerKey, channelId, characterName.toLowerCase(), role, author ?? null, content, Date.now()],
  );
}

/** Most recent turns for one character in one channel, oldest first (ready
 * to drop straight into a chat-completion messages array). */
export async function getRecentNpcConversation(
  ownerKey: string,
  channelId: string,
  characterName: string,
  limit: number,
): Promise<NpcConversationRow[]> {
  const res = await sqlite.execute(
    `SELECT role, author, content, created_at FROM npc_conversations
     WHERE owner_key = ? AND channel_id = ? AND LOWER(character_name) = LOWER(?)
     ORDER BY created_at DESC LIMIT ?`,
    [ownerKey, channelId, characterName, limit],
  );
  return (res.rows as NpcConversationRow[]).reverse();
}

/** Trims a conversation down to its most recent `keep` rows — call after
 * appending so history can't grow unbounded in a chatty channel. */
export async function trimNpcConversation(
  ownerKey: string,
  channelId: string,
  characterName: string,
  keep: number,
): Promise<void> {
  await sqlite.execute(
    `DELETE FROM npc_conversations WHERE id IN (
       SELECT id FROM npc_conversations
       WHERE owner_key = ? AND channel_id = ? AND LOWER(character_name) = LOWER(?)
       ORDER BY created_at DESC LIMIT -1 OFFSET ?
     )`,
    [ownerKey, channelId, characterName, keep],
  );
}

// ── Dice roll leaderboard (!rollcall — see main.ts) ──

/** Logs one natural 1 or natural 20 for the !rollcall command. Call only
 * for an actual 1d20 roll (see rawD20 on rollDice's result) — modified/multi-
 * die rolls don't have a "natural" result and shouldn't be logged. */
export async function recordDiceRollEvent(
  broadcasterId: string,
  username: string,
  displayName: string,
  kind: "nat1" | "nat20",
) {
  await sqlite.execute(
    "INSERT INTO dice_roll_events (broadcaster_id,username,display_name,kind,created_at) VALUES (?,?,?,?,?)",
    [broadcasterId, username.toLowerCase(), displayName, kind, Date.now()],
  );
}

/** Top rollers for one channel/kind/window, most nat 1s or nat 20s first
 * (ties broken by whoever's most recent). display_name is a best-effort
 * label — the most recently seen casing for that username, not necessarily
 * from their most recent roll. */
export async function getDiceLeaderboard(
  broadcasterId: string,
  kind: "nat1" | "nat20",
  sinceMs: number,
  limit = 5,
) {
  const res = await sqlite.execute(
    `SELECT username, MAX(display_name) AS display_name, COUNT(*) AS count, MAX(created_at) AS last_at
     FROM dice_roll_events
     WHERE broadcaster_id = ? AND kind = ? AND created_at >= ?
     GROUP BY username
     ORDER BY count DESC, last_at DESC
     LIMIT ?`,
    [broadcasterId, kind, sinceMs, limit],
  );
  return res.rows.map((r: any) => ({
    username: String(r.username),
    displayName: String(r.display_name),
    count: Number(r.count),
  }));
}

/** One player's own natural 1 and natural 20 counts in one channel/window,
 * for `!rollcall @user`. Always returns both kinds (0 if they have none)
 * rather than requiring two separate calls. */
export async function getDiceStatsForUser(
  broadcasterId: string,
  username: string,
  sinceMs: number,
): Promise<{ nat1: number; nat20: number }> {
  const res = await sqlite.execute(
    `SELECT kind, COUNT(*) AS count
     FROM dice_roll_events
     WHERE broadcaster_id = ? AND username = ? AND created_at >= ?
     GROUP BY kind`,
    [broadcasterId, username.toLowerCase(), sinceMs],
  );
  const stats = { nat1: 0, nat20: 0 };
  for (const r of res.rows as any[]) {
    if (r.kind === "nat1") stats.nat1 = Number(r.count);
    else if (r.kind === "nat20") stats.nat20 = Number(r.count);
  }
  return stats;
}

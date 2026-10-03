// Persistence for custom commands, custom variables, chat triggers and timed
// messages.
// Split out of db.ts (which re-exports everything here) to keep every file
// well under Val Town's per-file size ceiling.

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

// Channel-wide default cooldowns for custom commands/triggers (mods can
// override per-command/per-trigger with !dndbot cooldown / !trigger cooldown).
export const DEFAULT_CUSTOM_COMMAND_COOLDOWN_MS = 5_000;
export const DEFAULT_CUSTOM_TRIGGER_COOLDOWN_MS = 15_000;

// Default posting interval for a new timed message when none is given
// (mods can set their own with !timedmsg add/interval — see timedmessages.ts).
export const DEFAULT_TIMED_MESSAGE_INTERVAL_MINUTES = 30;

// ── Custom commands & triggers ──

export async function countCustomCommands(broadcasterId: string) {
  const res = await sqlite.execute("SELECT COUNT(*) AS count FROM custom_commands WHERE broadcaster_id = ?", [broadcasterId]);
  return Number(res.rows[0]?.count ?? 0);
}

export async function getCustomCommand(broadcasterId: string, name: string) {
  const res = await sqlite.execute("SELECT * FROM custom_commands WHERE broadcaster_id = ? AND name = ?", [broadcasterId, name]);
  return res.rows.length ? res.rows[0] : null;
}

export async function listCustomCommands(broadcasterId: string) {
  const res = await sqlite.execute("SELECT name, uses FROM custom_commands WHERE broadcaster_id = ? ORDER BY name ASC", [broadcasterId]);
  return res.rows;
}

export async function addCustomCommand(broadcasterId: string, name: string, response: string, createdBy: string) {
  if (await getCustomCommand(broadcasterId, name)) return { ok: false as const, error: "exists" as const };
  const max = Math.max(1, Number(Deno.env.get("MAX_CUSTOM_COMMANDS_PER_CHANNEL") ?? "100"));
  if ((await countCustomCommands(broadcasterId)) >= max) return { ok: false as const, error: "cap" as const, max };
  const now = Date.now();
  await sqlite.execute(
    "INSERT INTO custom_commands (broadcaster_id,name,response,created_by,created_at,updated_at,uses,cooldown_ms,last_used_at) VALUES (?,?,?,?,?,?,0,?,0)",
    [broadcasterId, name, response, createdBy, now, now, DEFAULT_CUSTOM_COMMAND_COOLDOWN_MS],
  );
  return { ok: true as const };
}

export async function editCustomCommand(broadcasterId: string, name: string, response: string) {
  if (!(await getCustomCommand(broadcasterId, name))) return false;
  await sqlite.execute(
    "UPDATE custom_commands SET response = ?, updated_at = ? WHERE broadcaster_id = ? AND name = ?",
    [response, Date.now(), broadcasterId, name],
  );
  return true;
}

export async function deleteCustomCommand(broadcasterId: string, name: string) {
  if (!(await getCustomCommand(broadcasterId, name))) return false;
  await sqlite.execute("DELETE FROM custom_commands WHERE broadcaster_id = ? AND name = ?", [broadcasterId, name]);
  return true;
}

export async function setCustomCommandCooldown(broadcasterId: string, name: string, cooldownMs: number) {
  if (!(await getCustomCommand(broadcasterId, name))) return false;
  await sqlite.execute(
    "UPDATE custom_commands SET cooldown_ms = ?, updated_at = ? WHERE broadcaster_id = ? AND name = ?",
    [cooldownMs, Date.now(), broadcasterId, name],
  );
  return true;
}

/** Atomically checks cooldown and (if clear) records a use. Returns null if the command doesn't exist. */
export async function useCustomCommand(broadcasterId: string, name: string) {
  const row = await getCustomCommand(broadcasterId, name);
  if (!row) return null;
  const now = Date.now();
  const cooldownMs = Number(row.cooldown_ms ?? 0);
  const lastUsedAt = Number(row.last_used_at ?? 0);
  if (cooldownMs > 0 && now - lastUsedAt < cooldownMs) return { row, onCooldown: true as const };
  await sqlite.execute(
    "UPDATE custom_commands SET uses = uses + 1, last_used_at = ? WHERE broadcaster_id = ? AND name = ?",
    [now, broadcasterId, name],
  );
  return { row: { ...row, uses: Number(row.uses ?? 0) + 1 }, onCooldown: false as const };
}

// ── Custom variables ({var:name} placeholders + !var) ──

export async function getCustomVariable(broadcasterId: string, name: string): Promise<string | null> {
  const res = await sqlite.execute("SELECT value FROM custom_variables WHERE broadcaster_id = ? AND name = ?", [broadcasterId, name]);
  const row = (res.rows as any[])[0];
  return row ? String(row.value ?? "") : null;
}

export async function listCustomVariables(broadcasterId: string) {
  const res = await sqlite.execute("SELECT name, value FROM custom_variables WHERE broadcaster_id = ? ORDER BY name ASC", [broadcasterId]);
  return res.rows as any[];
}

/** Creates or overwrites a variable. Fails only when creating a new one past the channel cap. */
export async function setCustomVariable(broadcasterId: string, name: string, value: string, updatedBy: string) {
  const exists = (await getCustomVariable(broadcasterId, name)) !== null;
  if (!exists) {
    const max = Math.max(1, Number(Deno.env.get("MAX_CUSTOM_VARIABLES_PER_CHANNEL") ?? "100"));
    const res = await sqlite.execute("SELECT COUNT(*) AS count FROM custom_variables WHERE broadcaster_id = ?", [broadcasterId]);
    if (Number((res.rows as any[])[0]?.count ?? 0) >= max) return { ok: false as const, error: "cap" as const, max };
  }
  await sqlite.execute(
    `INSERT INTO custom_variables (broadcaster_id,name,value,updated_by,updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(broadcaster_id,name) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [broadcasterId, name, value, updatedBy, Date.now()],
  );
  return { ok: true as const };
}

export async function deleteCustomVariable(broadcasterId: string, name: string) {
  if ((await getCustomVariable(broadcasterId, name)) === null) return false;
  await sqlite.execute("DELETE FROM custom_variables WHERE broadcaster_id = ? AND name = ?", [broadcasterId, name]);
  return true;
}

export async function countCustomTriggers(broadcasterId: string) {
  const res = await sqlite.execute("SELECT COUNT(*) AS count FROM custom_triggers WHERE broadcaster_id = ?", [broadcasterId]);
  return Number(res.rows[0]?.count ?? 0);
}

export async function getCustomTrigger(broadcasterId: string, keyword: string) {
  const res = await sqlite.execute("SELECT * FROM custom_triggers WHERE broadcaster_id = ? AND keyword = ?", [broadcasterId, keyword]);
  return res.rows.length ? res.rows[0] : null;
}

// Every plain chat message is matched against this list (see
// handleTriggerMatch in customcommands.ts), so it's kept small per channel
// and cached only for the duration of a single request.
export async function listCustomTriggers(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM custom_triggers WHERE broadcaster_id = ? ORDER BY created_at ASC", [broadcasterId]);
  return res.rows;
}

export async function addCustomTrigger(broadcasterId: string, keyword: string, response: string, createdBy: string) {
  if (await getCustomTrigger(broadcasterId, keyword)) return { ok: false as const, error: "exists" as const };
  const max = Math.max(1, Number(Deno.env.get("MAX_CUSTOM_TRIGGERS_PER_CHANNEL") ?? "50"));
  if ((await countCustomTriggers(broadcasterId)) >= max) return { ok: false as const, error: "cap" as const, max };
  const now = Date.now();
  await sqlite.execute(
    "INSERT INTO custom_triggers (broadcaster_id,keyword,response,created_by,created_at,updated_at,uses,cooldown_ms,last_used_at) VALUES (?,?,?,?,?,?,0,?,0)",
    [broadcasterId, keyword, response, createdBy, now, now, DEFAULT_CUSTOM_TRIGGER_COOLDOWN_MS],
  );
  return { ok: true as const };
}

// No !trigger edit chat command exists (mods currently remove+re-add to
// change a trigger's response — see customcommands.ts), but the web
// dashboard edits triggers in place like it does custom commands, so this
// mirrors editCustomCommand for that one caller.
export async function editCustomTrigger(broadcasterId: string, keyword: string, response: string) {
  if (!(await getCustomTrigger(broadcasterId, keyword))) return false;
  await sqlite.execute(
    "UPDATE custom_triggers SET response = ?, updated_at = ? WHERE broadcaster_id = ? AND keyword = ?",
    [response, Date.now(), broadcasterId, keyword],
  );
  return true;
}

export async function deleteCustomTrigger(broadcasterId: string, keyword: string) {
  if (!(await getCustomTrigger(broadcasterId, keyword))) return false;
  await sqlite.execute("DELETE FROM custom_triggers WHERE broadcaster_id = ? AND keyword = ?", [broadcasterId, keyword]);
  return true;
}

export async function setCustomTriggerCooldown(broadcasterId: string, keyword: string, cooldownMs: number) {
  if (!(await getCustomTrigger(broadcasterId, keyword))) return false;
  await sqlite.execute(
    "UPDATE custom_triggers SET cooldown_ms = ?, updated_at = ? WHERE broadcaster_id = ? AND keyword = ?",
    [cooldownMs, Date.now(), broadcasterId, keyword],
  );
  return true;
}

export async function markCustomTriggerUsed(broadcasterId: string, keyword: string) {
  await sqlite.execute(
    "UPDATE custom_triggers SET uses = uses + 1, last_used_at = ? WHERE broadcaster_id = ? AND keyword = ?",
    [Date.now(), broadcasterId, keyword],
  );
}

// Full rows (unlike listCustomCommands' name+uses-only projection used by
// the in-chat !dndbot list) — for the web dashboard, which needs to show
// and pre-fill the actual response/cooldown for editing.
export async function listCustomCommandsFull(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM custom_commands WHERE broadcaster_id = ? ORDER BY name ASC", [broadcasterId]);
  return res.rows;
}

// ── Timed messages (!timedmsg — see timedmessages.ts, posted by timedmessages_cron.ts) ──

export async function countTimedMessages(broadcasterId: string) {
  const res = await sqlite.execute("SELECT COUNT(*) AS count FROM timed_messages WHERE broadcaster_id = ?", [broadcasterId]);
  return Number(res.rows[0]?.count ?? 0);
}

export async function listTimedMessages(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM timed_messages WHERE broadcaster_id = ? ORDER BY id ASC", [broadcasterId]);
  return res.rows;
}

export async function getTimedMessage(broadcasterId: string, id: number) {
  const res = await sqlite.execute("SELECT * FROM timed_messages WHERE broadcaster_id = ? AND id = ?", [broadcasterId, id]);
  return res.rows.length ? res.rows[0] : null;
}

export async function addTimedMessage(broadcasterId: string, message: string, intervalMinutes: number, createdBy: string) {
  const max = Math.max(1, Number(Deno.env.get("MAX_TIMED_MESSAGES_PER_CHANNEL") ?? "20"));
  if ((await countTimedMessages(broadcasterId)) >= max) return { ok: false as const, error: "cap" as const, max };
  const now = Date.now();
  await sqlite.execute(
    "INSERT INTO timed_messages (broadcaster_id,message,interval_minutes,enabled,created_by,created_at,updated_at,next_post_at,last_sent_at,uses) VALUES (?,?,?,1,?,?,?,?,0,0)",
    [broadcasterId, message, intervalMinutes, createdBy, now, now, now + intervalMinutes * 60_000],
  );
  // No lastInsertRowId plumbing exists elsewhere in this codebase to reuse,
  // so the new row is looked up by its own created_at instead — safe enough
  // since it's scoped to one channel and a collision needs two adds in the
  // same broadcaster within the same millisecond.
  const res = await sqlite.execute(
    "SELECT id FROM timed_messages WHERE broadcaster_id = ? AND created_at = ? ORDER BY id DESC LIMIT 1",
    [broadcasterId, now],
  );
  return { ok: true as const, id: Number(res.rows[0]?.id ?? 0) };
}

export async function editTimedMessage(broadcasterId: string, id: number, message: string) {
  if (!(await getTimedMessage(broadcasterId, id))) return false;
  await sqlite.execute(
    "UPDATE timed_messages SET message = ?, updated_at = ? WHERE broadcaster_id = ? AND id = ?",
    [message, Date.now(), broadcasterId, id],
  );
  return true;
}

// Changing the interval reschedules from now, so a mod shortening a 6-hour
// interval to 10 minutes doesn't cause an immediate flood of overdue posts.
export async function setTimedMessageInterval(broadcasterId: string, id: number, intervalMinutes: number) {
  if (!(await getTimedMessage(broadcasterId, id))) return false;
  const now = Date.now();
  await sqlite.execute(
    "UPDATE timed_messages SET interval_minutes = ?, next_post_at = ?, updated_at = ? WHERE broadcaster_id = ? AND id = ?",
    [intervalMinutes, now + intervalMinutes * 60_000, now, broadcasterId, id],
  );
  return true;
}

// Re-enabling also reschedules from now, for the same reason as above — a
// message paused for a week shouldn't fire the instant it's turned back on.
export async function setTimedMessageEnabled(broadcasterId: string, id: number, enabled: boolean) {
  const row = await getTimedMessage(broadcasterId, id);
  if (!row) return false;
  const now = Date.now();
  const nextPostAt = enabled ? now + Number(row.interval_minutes ?? DEFAULT_TIMED_MESSAGE_INTERVAL_MINUTES) * 60_000 : row.next_post_at;
  await sqlite.execute(
    "UPDATE timed_messages SET enabled = ?, next_post_at = ?, updated_at = ? WHERE broadcaster_id = ? AND id = ?",
    [enabled ? 1 : 0, nextPostAt, now, broadcasterId, id],
  );
  return true;
}

export async function deleteTimedMessage(broadcasterId: string, id: number) {
  if (!(await getTimedMessage(broadcasterId, id))) return false;
  await sqlite.execute("DELETE FROM timed_messages WHERE broadcaster_id = ? AND id = ?", [broadcasterId, id]);
  return true;
}

// Polled by timedmessages_cron.ts. Only messages in currently-connected,
// non-blocked channels are considered due — mirrors getDueMerchantChannels'
// join against broadcasters(connected = 1). Carries along b.is_live so the
// cron can skip offline channels without a separate query per message.
export async function getDueTimedMessages(now: number) {
  const res = await sqlite.execute(
    `SELECT t.*, b.is_live AS is_live FROM timed_messages t
     JOIN broadcasters b ON b.broadcaster_id = t.broadcaster_id AND b.connected = 1
     WHERE t.enabled = 1 AND t.next_post_at IS NOT NULL AND t.next_post_at <= ?`,
    [now],
  );
  return res.rows;
}

export async function recordTimedMessageSent(id: number, nextPostAt: number) {
  await sqlite.execute(
    "UPDATE timed_messages SET next_post_at = ?, last_sent_at = ?, uses = uses + 1 WHERE id = ?",
    [nextPostAt, Date.now(), id],
  );
}

// One-time migration for "everything starts off".
//
// Feature switches used to default ON when a channel had never touched them
// (no command_toggles / points_settings / channel_bot_settings row). They now
// default OFF so GuildScribe is quiet when it joins a new chat. Channels that
// were already connected keep what they had: for each of them, every switch
// that was riding on the old default gets an explicit row with the state it
// effectively had, so flipping the default changes nothing for them.
//
// Runs after every table exists (main.ts ensureSchema), once, recorded in
// quiet_defaults_migrations.

import { sqlite } from "./sqlite.ts";
import { COMMAND_GROUPS } from "./commandgroups.ts";
import type { InStatement } from "./local_sqlite.ts";

/** Groups that were already off by default before the switch-over. */
const WERE_DEFAULT_OFF = new Set(["hateraid", "followbots", "golive", "chatreader", "lurk", "shoutout", "shots"]);

export async function migrateQuietDefaults() {
  await sqlite.execute("CREATE TABLE IF NOT EXISTS quiet_defaults_migrations (name TEXT PRIMARY KEY, ran_at INTEGER)");
  const done = await sqlite.execute("SELECT 1 FROM quiet_defaults_migrations WHERE name = 'v1'");
  if (done.rows.length) return;

  const now = Date.now();
  const channels = (await sqlite.execute("SELECT broadcaster_id FROM broadcasters")).rows.map((r: any) => String(r.broadcaster_id));
  for (const id of channels) {
    const saved = await sqlite.execute("SELECT group_name, enabled FROM command_toggles WHERE broadcaster_id = ?", [id]);
    const overrides = new Map<string, boolean>(saved.rows.map((r: any) => [String(r.group_name), Number(r.enabled) === 1]));
    const statements: InStatement[] = [];
    for (const [group, def] of Object.entries(COMMAND_GROUPS)) {
      if (overrides.has(group)) continue;
      // Same fallback the old isCommandGroupEnabled used: the parent's saved
      // state, else the old default.
      const parentState = def.parent ? overrides.get(def.parent) : undefined;
      const enabled = parentState ?? !WERE_DEFAULT_OFF.has(group);
      statements.push({
        sql: "INSERT OR IGNORE INTO command_toggles (broadcaster_id, group_name, enabled, updated_at) VALUES (?,?,?,?)",
        args: [id, group, enabled ? 1 : 0, now],
      });
    }
    statements.push(
      { sql: "INSERT OR IGNORE INTO points_settings (broadcaster_id, enabled, updated_at) VALUES (?,1,?)", args: [id, now] },
      { sql: "INSERT OR IGNORE INTO channel_bot_settings (broadcaster_id, botcheck_auto) VALUES (?,1)", args: [id] },
    );
    await sqlite.batch(statements);
  }
  await sqlite.execute("INSERT OR IGNORE INTO quiet_defaults_migrations (name, ran_at) VALUES ('v1', ?)", [now]);
}

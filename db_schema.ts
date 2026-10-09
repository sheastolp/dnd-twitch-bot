// Schema setup and migrations (ensureTables).
// Split out of db.ts (which re-exports everything here) to keep every file
// well under Val Town's per-file size ceiling.

import { sqlite } from "./sqlite.ts";
import {
  DEFAULT_CUSTOM_COMMAND_COOLDOWN_MS,
  DEFAULT_CUSTOM_TRIGGER_COOLDOWN_MS,
} from "./db_custom.ts";

async function tableColumns(table: string): Promise<string[]> {
  const res = await sqlite.execute(`PRAGMA table_info(${table})`);
  return res.rows.map((r: any) => String(r.name));
}

async function migrateCharacterTables() {
  const chars = await tableColumns("characters");
  if (chars.length && !chars.includes("broadcaster_id")) {
    await sqlite.execute("ALTER TABLE characters RENAME TO characters_legacy");
  }
  const backups = await tableColumns("character_backups");
  if (backups.length && !backups.includes("broadcaster_id")) {
    await sqlite.execute("ALTER TABLE character_backups RENAME TO character_backups_legacy");
  }
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS characters (
    broadcaster_id TEXT, username TEXT, race TEXT, subrace TEXT, class TEXT, level INTEGER,
    xp INTEGER DEFAULT 0, str INTEGER, dex INTEGER, con INTEGER, int INTEGER, wis INTEGER, cha INTEGER,
    speed INTEGER, hp_max INTEGER, hp_current INTEGER, proficiency INTEGER, traits TEXT,
    spells TEXT DEFAULT '[]', items TEXT DEFAULT '[]', feats TEXT DEFAULT '[]', abilities TEXT DEFAULT '[]',
    PRIMARY KEY (broadcaster_id, username)
  )`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS character_backups (
    broadcaster_id TEXT, username TEXT, race TEXT, subrace TEXT, class TEXT, level INTEGER,
    xp INTEGER DEFAULT 0, str INTEGER, dex INTEGER, con INTEGER, int INTEGER, wis INTEGER, cha INTEGER,
    speed INTEGER, hp_max INTEGER, hp_current INTEGER, proficiency INTEGER, traits TEXT,
    spells TEXT DEFAULT '[]', items TEXT DEFAULT '[]', feats TEXT DEFAULT '[]', abilities TEXT DEFAULT '[]',
    PRIMARY KEY (broadcaster_id, username)
  )`);
  const legacyChars = await tableColumns("characters_legacy");
  if (legacyChars.length) {
    for (const column of ["spells", "items", "feats", "abilities", "xp"]) {
      if (!legacyChars.includes(column)) {
        await sqlite.execute(`ALTER TABLE characters_legacy ADD COLUMN ${column} ${column === "xp" ? "INTEGER DEFAULT 0" : "TEXT DEFAULT '[]'"}`);
      }
    }
    await sqlite.execute(`INSERT OR IGNORE INTO characters
      (broadcaster_id,username,race,subrace,class,level,xp,str,dex,con,int,wis,cha,speed,hp_max,hp_current,proficiency,traits,spells,items,feats,abilities)
      SELECT cc.broadcaster_id,c.username,c.race,c.subrace,c.class,c.level,COALESCE(c.xp,0),c.str,c.dex,c.con,c.int,c.wis,c.cha,c.speed,c.hp_max,c.hp_current,c.proficiency,c.traits,COALESCE(c.spells,'[]'),COALESCE(c.items,'[]'),COALESCE(c.feats,'[]'),COALESCE(c.abilities,'[]')
      FROM characters_legacy c JOIN channel_characters cc ON cc.username=c.username`);
    await sqlite.execute("DROP TABLE characters_legacy");
  }
  const legacyBackups = await tableColumns("character_backups_legacy");
  if (legacyBackups.length) {
    for (const column of ["spells", "items", "feats", "abilities", "xp"]) {
      if (!legacyBackups.includes(column)) {
        await sqlite.execute(`ALTER TABLE character_backups_legacy ADD COLUMN ${column} ${column === "xp" ? "INTEGER DEFAULT 0" : "TEXT DEFAULT '[]'"}`);
      }
    }
    await sqlite.execute(`INSERT OR IGNORE INTO character_backups
      (broadcaster_id,username,race,subrace,class,level,xp,str,dex,con,int,wis,cha,speed,hp_max,hp_current,proficiency,traits,spells,items,feats,abilities)
      SELECT cc.broadcaster_id,c.username,c.race,c.subrace,c.class,c.level,COALESCE(c.xp,0),c.str,c.dex,c.con,c.int,c.wis,c.cha,c.speed,c.hp_max,c.hp_current,c.proficiency,c.traits,COALESCE(c.spells,'[]'),COALESCE(c.items,'[]'),COALESCE(c.feats,'[]'),COALESCE(c.abilities,'[]')
      FROM character_backups_legacy c JOIN channel_characters cc ON cc.username=c.username`);
    await sqlite.execute("DROP TABLE character_backups_legacy");
  }
  await sqlite.execute("CREATE INDEX IF NOT EXISTS idx_characters_channel ON characters(broadcaster_id)");
  await sqlite.execute("CREATE INDEX IF NOT EXISTS idx_backups_channel ON character_backups(broadcaster_id)");
}

async function migrateCreationSessions() {
  const cols = await tableColumns("creation_sessions");
  if (cols.length && !cols.includes("broadcaster_id")) {
    await sqlite.execute("ALTER TABLE creation_sessions RENAME TO creation_sessions_legacy");
    await sqlite.execute(`CREATE TABLE creation_sessions (
      broadcaster_id TEXT, username TEXT, step TEXT, race TEXT, subrace TEXT, class TEXT, scores TEXT, updated_at INTEGER,
      PRIMARY KEY (broadcaster_id, username)
    )`);
    await sqlite.execute(`INSERT OR IGNORE INTO creation_sessions (broadcaster_id,username,step,race,subrace,class,scores,updated_at)
      SELECT cc.broadcaster_id,s.username,s.step,s.race,s.subrace,s.class,s.scores,s.updated_at
      FROM creation_sessions_legacy s JOIN channel_characters cc ON cc.username=s.username`);
    await sqlite.execute("DROP TABLE creation_sessions_legacy");
  }
}

async function migrateMapTables() {
  // Sparse cell storage: a map only stores *overridden* cells; anything not
  // present falls back to the map's own default_terrain. Keeps `!map fill`
  // and large grids cheap, in line with SQLite's limited ALTER TABLE support.
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS maps (
    broadcaster_id TEXT NOT NULL,
    map_name TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    default_terrain TEXT NOT NULL DEFAULT 'grass',
    created_by TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (broadcaster_id, map_name)
  )`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS map_cells (
    broadcaster_id TEXT NOT NULL,
    map_name TEXT NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    terrain TEXT NOT NULL,
    PRIMARY KEY (broadcaster_id, map_name, x, y)
  )`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS map_tokens (
    broadcaster_id TEXT NOT NULL,
    map_name TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    placed_at INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (broadcaster_id, map_name, username)
  )`);
}

export async function ensureTables() {
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS channel_characters (broadcaster_id TEXT, username TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (broadcaster_id, username))`);
  await migrateCharacterTables();
  await migrateMapTables();
  for (const table of ["characters", "character_backups"]) {
    for (const column of ["spells", "items", "feats", "abilities"]) {
      try {
        await sqlite.execute(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT DEFAULT '[]'`);
      } catch (_) {
        /* column already exists */
      }
    }
    try {
      await sqlite.execute(`ALTER TABLE ${table} ADD COLUMN xp INTEGER DEFAULT 0`);
    } catch (_) {
      /* column already exists */
    }
  }
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS eventsub_extra_subscriptions (
      broadcaster_id TEXT, kind TEXT, subscription_id TEXT, created_at INTEGER,
      PRIMARY KEY (broadcaster_id, kind)
    )`,
  );
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, expires_at INTEGER)`);
  // Shared Twitch app access token (see getAppToken in twitch.ts), so a
  // fresh isolate reuses it instead of minting a new one before replying.
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS app_tokens (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
  // Separate OAuth state table for the dashboard's viewer-side "log in with
  // Twitch" moderator check (see dashboard.ts) — kept apart from the
  // broadcaster-connect oauth_states above since the payload differs
  // (channel_id + dashboard_key, not just an expiry) and the two flows use
  // different redirect URIs/scopes.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS dashboard_oauth_states (
      state TEXT PRIMARY KEY, channel_id TEXT NOT NULL, dashboard_key TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS broadcasters (
      broadcaster_id TEXT PRIMARY KEY, login TEXT, display_name TEXT, subscription_id TEXT, connected_at INTEGER, connected INTEGER NOT NULL DEFAULT 1, disconnected_at INTEGER, disconnect_reason TEXT
    )`,
  );
  try { await sqlite.execute(`ALTER TABLE broadcasters ADD COLUMN connected INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
  try { await sqlite.execute(`ALTER TABLE broadcasters ADD COLUMN disconnected_at INTEGER`); } catch (_) {}
  try { await sqlite.execute(`ALTER TABLE broadcasters ADD COLUMN disconnect_reason TEXT`); } catch (_) {}
  // Per-channel capability token for the web dashboard (see dashboard.ts) —
  // a mod/broadcaster fetches it with !dashboard, then anyone holding the
  // link can manage that one channel's custom commands/triggers/timed
  // messages at GET/POST /dashboard. Hex-only (crypto.randomUUID minus
  // dashes) so it never collides with the "+"-decodes-to-space query string
  // trap documented on /admin/logs below.
  try { await sqlite.execute(`ALTER TABLE broadcasters ADD COLUMN dashboard_key TEXT`); } catch (_) {}
  // Kept current by the stream.online/stream.offline EventSub subscriptions
  // (see createStreamStatusEventSubscriptions in twitch.ts + the notification
  // handling in main.ts) so "is this channel live" is a plain column read —
  // no Twitch API call — in the chat hot path and the merchant/timed-message
  // crons. Defaults to 0 until the first event (or the one-time connect-time
  // seed) sets it.
  try { await sqlite.execute(`ALTER TABLE broadcasters ADD COLUMN is_live INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
  // Tracks whether this channel has stream.online/offline EventSub
  // subscriptions yet. New connects get them immediately (see the OAuth
  // callback in main.ts); channels connected before this feature existed
  // default to 0 and get a one-time, best-effort lazy backfill the first
  // time the "quiet while offline" check runs for them (see main.ts) — after
  // that this flips to 1 and they're never re-checked.
  try { await sqlite.execute(`ALTER TABLE broadcasters ADD COLUMN stream_status_subscribed INTEGER NOT NULL DEFAULT 0`); } catch (_) {}
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS channel_characters (broadcaster_id TEXT, username TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (broadcaster_id, username))`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS channel_blocks (broadcaster_id TEXT PRIMARY KEY, reason TEXT, created_at INTEGER, updated_at INTEGER)`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS monitor_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, detail TEXT, created_at INTEGER)`);
  // Single-row status for the merchant cron tick — read by GET
  // /admin/merchant/status and /admin/logs (see getMerchantCronStatus /
  // recordMerchantCronRun below, written once per tick by merchant_cron.ts).
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS merchant_cron_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_run_at INTEGER, channels_due INTEGER NOT NULL DEFAULT 0,
      last_posts_ok INTEGER NOT NULL DEFAULT 0, last_posts_failed INTEGER NOT NULL DEFAULT 0
    )`,
  );
  // A table copied from an older deployment can predate these columns.
  for (const col of ["last_run_at INTEGER", "channels_due INTEGER NOT NULL DEFAULT 0", "last_posts_ok INTEGER NOT NULL DEFAULT 0", "last_posts_failed INTEGER NOT NULL DEFAULT 0"]) {
    try { await sqlite.execute(`ALTER TABLE merchant_cron_status ADD COLUMN ${col}`); } catch (_) {}
  }
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS eventsub_messages (message_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS command_rate_limits (broadcaster_id TEXT, username TEXT, last_at INTEGER NOT NULL, PRIMARY KEY (broadcaster_id, username))`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS pending_eventsub_cancellations (subscription_id TEXT PRIMARY KEY, broadcaster_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL)`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS welcomed_users (username TEXT PRIMARY KEY, welcomed_at INTEGER)`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS goodnight_cooldowns (broadcaster_id TEXT PRIMARY KEY, last_at INTEGER NOT NULL)`);
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS creation_sessions (
      broadcaster_id TEXT, username TEXT, step TEXT, race TEXT, subrace TEXT, class TEXT, scores TEXT, updated_at INTEGER,
      PRIMARY KEY (broadcaster_id, username)
    )`,
  );
  await migrateCreationSessions();
  // BG3-flavored creation (!bg3) stores extra flavor text alongside the
  // standard wizard's race/subrace/class/scores columns.
  for (const column of ["subclass", "background", "alignment", "hook"]) {
    try {
      await sqlite.execute(`ALTER TABLE creation_sessions ADD COLUMN ${column} TEXT`);
    } catch (_) {
      /* column already exists */
    }
  }
  // target_user: who a pending confirm_createchar overwrite-warning applies
  // to (may differ from the session's own username when a mod is rolling a
  // random character for someone else via !createchar @user).
  try {
    await sqlite.execute(`ALTER TABLE creation_sessions ADD COLUMN target_user TEXT`);
  } catch (_) {
    /* column already exists */
  }
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS encounters (
      broadcaster_id TEXT PRIMARY KEY, round INTEGER, current_index INTEGER, active INTEGER, entries TEXT, updated_at INTEGER
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, broadcaster_id TEXT, action TEXT, detail TEXT, created_at INTEGER
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS channel_settings (
      broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER
    )`,
  );
  // Open-stall merchant: off by default per channel. next_post_at is the
  // randomized due time (ms epoch) for the next ad; the merchant cron
  // trigger polls this rather than posting on every tick.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS merchant_settings (
      broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, next_post_at INTEGER, updated_at INTEGER
    )`,
  );
  // What's currently on offer per channel — the last-posted merchant ad's
  // item, kept around so !haggle (haggle.ts) knows what to bargain over.
  // One row per channel; each new ad overwrites the previous listing and
  // resets haggled_by (a JSON array with one entry per haggle attempt used —
  // a username appears once for each attempt that viewer has spent, so a
  // viewer can't re-roll the same item beyond the per-listing cap).
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS merchant_listings (
      broadcaster_id TEXT PRIMARY KEY, merchant_name TEXT, item_desc TEXT, price_text TEXT,
      posted_at INTEGER, haggled_by TEXT NOT NULL DEFAULT '[]'
    )`,
  );
  // Granular per-channel command-group toggles for the dashboard (see
  // COMMAND_GROUPS in utils.ts). Missing row = enabled, same "absence means
  // default" pattern as channel_settings above.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS command_toggles (
      broadcaster_id TEXT, group_name TEXT, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER,
      PRIMARY KEY (broadcaster_id, group_name)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS duel_challenges (
      broadcaster_id TEXT, challenger TEXT, defender TEXT, created_at INTEGER,
      PRIMARY KEY (broadcaster_id, challenger, defender)
    )`,
  );
  try {
    await sqlite.execute(`ALTER TABLE duel_challenges ADD COLUMN mode TEXT DEFAULT 'auto'`);
  } catch (_) {
    /* column already exists */
  }
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS duels (
      broadcaster_id TEXT PRIMARY KEY, challenger TEXT, defender TEXT, current_turn TEXT,
      challenger_hp INTEGER, defender_hp INTEGER, active INTEGER, updated_at INTEGER
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS parties (
      broadcaster_id TEXT, party_name TEXT, owner TEXT, created_at INTEGER,
      PRIMARY KEY (broadcaster_id, party_name)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS party_members (
      broadcaster_id TEXT, party_name TEXT, username TEXT, joined_at INTEGER,
      PRIMARY KEY (broadcaster_id, party_name, username)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS party_invites (
      broadcaster_id TEXT, party_name TEXT, target TEXT, inviter TEXT, created_at INTEGER,
      PRIMARY KEY (broadcaster_id, party_name, target)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS party_duel_challenges (
      broadcaster_id TEXT, challenger_party TEXT, defender_party TEXT,
      challenger_owner TEXT, defender_owner TEXT, created_at INTEGER,
      PRIMARY KEY (broadcaster_id, challenger_party, defender_party)
    )`,
  );
  try {
    await sqlite.execute(`ALTER TABLE party_duel_challenges ADD COLUMN mode TEXT DEFAULT 'auto'`);
  } catch (_) {
    /* column already exists */
  }
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS party_duels (
      broadcaster_id TEXT PRIMARY KEY, challenger_party TEXT, defender_party TEXT,
      current_side TEXT, current_index INTEGER, challenger_members TEXT, defender_members TEXT,
      challenger_hp TEXT, defender_hp TEXT, active INTEGER, updated_at INTEGER
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS monster_duels (
      broadcaster_id TEXT PRIMARY KEY, player TEXT, monster_name TEXT, monster_cr TEXT,
      monster_ac INTEGER, monster_hp INTEGER, monster_hp_max INTEGER, monster_attack INTEGER,
      monster_damage_die INTEGER, monster_damage_bonus INTEGER, current_turn TEXT, active INTEGER, updated_at INTEGER,
      player_hp INTEGER
    )`,
  );
  // player_hp was added after the original table shipped — back-fill it for
  // channels whose monster_duels table predates this column, or every
  // !dndduel attack past the first exchange throws on the UPDATE below and
  // the bot goes silent.
  try { await sqlite.execute(`ALTER TABLE monster_duels ADD COLUMN player_hp INTEGER`); } catch (_) {}
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS party_monster_duels (
      broadcaster_id TEXT PRIMARY KEY,
      party_name TEXT,
      members TEXT,
      member_hp TEXT,
      current_index INTEGER,
      monster_name TEXT,
      monster_cr TEXT,
      monster_ac INTEGER,
      monster_hp INTEGER,
      monster_hp_max INTEGER,
      monster_attack INTEGER,
      monster_damage_die INTEGER,
      monster_damage_bonus INTEGER,
      active INTEGER,
      updated_at INTEGER
    )`,
  );
  // Custom commands (!dndbot add/edit/remove/cooldown/list) and passive
  // keyword triggers (!trigger), both authored from Twitch chat by the
  // broadcaster/mods — see customcommands.ts.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS custom_commands (
      broadcaster_id TEXT, name TEXT, response TEXT, created_by TEXT,
      created_at INTEGER, updated_at INTEGER, uses INTEGER NOT NULL DEFAULT 0,
      cooldown_ms INTEGER NOT NULL DEFAULT ${DEFAULT_CUSTOM_COMMAND_COOLDOWN_MS}, last_used_at INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (broadcaster_id, name)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS custom_triggers (
      broadcaster_id TEXT, keyword TEXT, response TEXT, created_by TEXT,
      created_at INTEGER, updated_at INTEGER, uses INTEGER NOT NULL DEFAULT 0,
      cooldown_ms INTEGER NOT NULL DEFAULT ${DEFAULT_CUSTOM_TRIGGER_COOLDOWN_MS}, last_used_at INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (broadcaster_id, keyword)
    )`,
  );
  // Per-command/per-trigger on/off (!dndbot enable/disable, !trigger
  // enable/disable, or the dashboard's Active checkbox) — a disabled one
  // keeps its response/uses/cooldown but never fires. Added after launch.
  try { await sqlite.execute(`ALTER TABLE custom_commands ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
  try { await sqlite.execute(`ALTER TABLE custom_triggers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
  // Named per-channel variables for custom command/trigger responses
  // ({var:name}, {var:name+1}, …) and the !var chat command — see
  // customcommands.ts. Values are stored as text; numeric ops coerce.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS custom_variables (
      broadcaster_id TEXT, name TEXT, value TEXT NOT NULL DEFAULT '',
      updated_by TEXT, updated_at INTEGER,
      PRIMARY KEY (broadcaster_id, name)
    )`,
  );
  // Timed messages: broadcaster/mod-authored announcements posted on a
  // recurring interval by timedmessages_cron.ts (a separate Val Town cron
  // trigger, same shape as merchant_cron.ts). Each row schedules itself via
  // next_post_at rather than the cron computing a shared schedule, so
  // messages with different intervals in the same channel rotate
  // independently instead of all firing together.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS timed_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcaster_id TEXT NOT NULL,
      message TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      next_post_at INTEGER,
      last_sent_at INTEGER NOT NULL DEFAULT 0,
      uses INTEGER NOT NULL DEFAULT 0
    )`,
  );
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_custom_commands_channel ON custom_commands(broadcaster_id)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_custom_triggers_channel ON custom_triggers(broadcaster_id)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_timed_messages_channel ON timed_messages(broadcaster_id)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_timed_messages_due ON timed_messages(enabled, next_post_at)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_activity_logs_channel_id ON activity_logs(broadcaster_id,id)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_channel_characters_channel ON channel_characters(broadcaster_id)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_party_members_channel ON party_members(broadcaster_id)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_parties_channel ON parties(broadcaster_id)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_activity_logs_username_channel ON activity_logs(broadcaster_id,username)`);
}

/** ensureTables' helpers, for main.ts's schema fingerprint (their source
 * changing means the schema setup has to run again). */
export const SCHEMA_HELPERS = [tableColumns, migrateCharacterTables, migrateCreationSessions, migrateMapTables];

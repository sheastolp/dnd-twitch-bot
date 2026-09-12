// SQLite persistence layer

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import type { Character } from "./types.ts";

// Channel-wide default cooldowns for custom commands/triggers (mods can
// override per-command/per-trigger with !dndbot cooldown / !trigger cooldown).
export const DEFAULT_CUSTOM_COMMAND_COOLDOWN_MS = 5_000;
export const DEFAULT_CUSTOM_TRIGGER_COOLDOWN_MS = 15_000;

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
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS broadcasters (
      broadcaster_id TEXT PRIMARY KEY, login TEXT, display_name TEXT, subscription_id TEXT, connected_at INTEGER, connected INTEGER NOT NULL DEFAULT 1, disconnected_at INTEGER, disconnect_reason TEXT
    )`,
  );
  try { await sqlite.execute(`ALTER TABLE broadcasters ADD COLUMN connected INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
  try { await sqlite.execute(`ALTER TABLE broadcasters ADD COLUMN disconnected_at INTEGER`); } catch (_) {}
  try { await sqlite.execute(`ALTER TABLE broadcasters ADD COLUMN disconnect_reason TEXT`); } catch (_) {}
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS channel_characters (broadcaster_id TEXT, username TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY (broadcaster_id, username))`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS channel_blocks (broadcaster_id TEXT PRIMARY KEY, reason TEXT, created_at INTEGER, updated_at INTEGER)`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS monitor_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, detail TEXT, created_at INTEGER)`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS eventsub_messages (message_id TEXT PRIMARY KEY, received_at INTEGER NOT NULL)`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS command_rate_limits (broadcaster_id TEXT, username TEXT, last_at INTEGER NOT NULL, PRIMARY KEY (broadcaster_id, username))`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS pending_eventsub_cancellations (subscription_id TEXT PRIMARY KEY, broadcaster_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL)`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS welcomed_users (username TEXT PRIMARY KEY, welcomed_at INTEGER)`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS goodnight_cooldowns (broadcaster_id TEXT PRIMARY KEY, last_at INTEGER NOT NULL)`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS chronicle_cooldowns (broadcaster_id TEXT PRIMARY KEY, last_at INTEGER NOT NULL)`);
  // Running count of chat messages (any account, bots included) seen since
  // the chronicle's last quote in a channel — see bumpChronicleMessageCount.
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS chronicle_activity (broadcaster_id TEXT PRIMARY KEY, message_count INTEGER NOT NULL DEFAULT 0)`);
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
  // Single-row rolling status for the merchant cron trigger — lets an
  // operator (or an external monitor) check "is the merchant actually
  // ticking, and did the last run have errors" without digging through raw
  // monitor_events. Written by merchant.cron.ts on every run.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS merchant_cron_status (
      id INTEGER PRIMARY KEY,
      last_run_at INTEGER,
      last_channels_due INTEGER DEFAULT 0,
      last_posts_ok INTEGER DEFAULT 0,
      last_posts_failed INTEGER DEFAULT 0,
      last_error TEXT,
      last_error_at INTEGER,
      last_success_at INTEGER,
      total_runs INTEGER DEFAULT 0,
      total_posts_ok INTEGER DEFAULT 0,
      total_posts_failed INTEGER DEFAULT 0
    )`,
  );
  // Chronicle: randomly quotes a plain chat message back with a D&D-flavored
  // reply. Off by default per channel; toggled with !chronicle.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS chronicle_settings (
      broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
    )`,
  );
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
  // Web dashboard login sessions (/dashboard). A viewer logs in with Twitch
  // (scope user:read:moderated_channels) so we can prove they're a
  // moderator/broadcaster of a channel before letting them flip module
  // switches. session_id is an opaque cookie value; the Twitch user tokens
  // live server-side only, never in the cookie itself.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS dashboard_sessions (
      session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, login TEXT, display_name TEXT,
      access_token TEXT NOT NULL, refresh_token TEXT, token_expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    )`,
  );
  // The broadcaster's own OAuth token for real Twitch ad-schedule reads
  // (channel:read:ads, requested during /connect) — separate from
  // dashboard_sessions, which is a per-login viewer session rather than a
  // durable per-channel credential. Channels connected before this scope
  // existed simply have no row here until they reconnect. See ads.ts.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS broadcaster_ad_tokens (
      broadcaster_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
      scope TEXT, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
  );
  // Last known real ad break, logged manually via !adslogged — a fallback
  // for channels without a broadcaster_ad_tokens row (or when Twitch's ad
  // schedule API has nothing to report) so !adcheck still has something to
  // reason about. See ads.ts.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS ad_tracking (
      broadcaster_id TEXT PRIMARY KEY, last_ad_at INTEGER, last_ad_source TEXT, last_ad_by TEXT, updated_at INTEGER
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
      PRIMARY KEY (broadcaster_id, name)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS custom_triggers (
      broadcaster_id TEXT, keyword TEXT, response TEXT, created_by TEXT,
      created_at INTEGER, updated_at INTEGER, uses INTEGER NOT NULL DEFAULT 0,
      cooldown_ms INTEGER NOT NULL DEFAULT ${DEFAULT_CUSTOM_TRIGGER_COOLDOWN_MS}, last_used_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (broadcaster_id, keyword)
    )`,
  );
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
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_custom_commands_channel ON custom_commands(broadcaster_id)`);
  // AI-voiced NPC characters — see npcs.ts. owner_key scopes a roster to one
  // tenant, currently always "twitch:<broadcasterId>" — or the literal
  // "global" for the fixed roster available as a fallback everywhere (see
  // PRIMARY_BROADCASTER_ID in npcs.ts). The format is deliberately opaque
  // rather than assumed-Twitch so another surface could reuse this schema
  // later. npc_conversations holds rolling per-channel context so a
  // character remembers the last few exchanges; channel_id is currently
  // always the broadcasterId, kept as its own column (rather than reusing
  // owner_key) since a future non-Twitch tenant could have multiple
  // channels sharing one roster.
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
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_custom_triggers_channel ON custom_triggers(broadcaster_id)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_activity_logs_channel_id ON activity_logs(broadcaster_id,id)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_channel_characters_channel ON channel_characters(broadcaster_id)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_party_members_channel ON party_members(broadcaster_id)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_parties_channel ON parties(broadcaster_id)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_activity_logs_username_channel ON activity_logs(broadcaster_id,username)`);
}

export async function getPartyMonsterDuel(broadcasterId: string) {
  const res = await sqlite.execute(
    "SELECT * FROM party_monster_duels WHERE broadcaster_id = ? AND active = 1",
    [broadcasterId],
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return {
    ...r,
    current_index: Number(r.current_index),
    members: JSON.parse(r.members || "[]") as string[],
    member_hp: JSON.parse(r.member_hp || "{}") as Record<string, number>,
  };
}

export function rowToCharacter(r: any): Character {
  return {
    username: r.username,
    race: r.race,
    subrace: r.subrace,
    cls: r.class,
    level: r.level,
    xp: Number(r.xp ?? 0),
    scores: { STR: r.str, DEX: r.dex, CON: r.con, INT: r.int, WIS: r.wis, CHA: r.cha },
    speed: r.speed,
    hpMax: r.hp_max,
    hpCurrent: r.hp_current,
    proficiency: r.proficiency,
    traits: JSON.parse(r.traits || "[]"),
    spells: JSON.parse(r.spells || "[]"),
    items: JSON.parse(r.items || "[]"),
    feats: JSON.parse(r.feats || "[]"),
    abilities: JSON.parse(r.abilities || "[]"),
  };
}

export async function getCharacter(username: string, broadcasterId: string) {
  const res = await sqlite.execute(
    "SELECT * FROM characters WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, username],
  );
  if (!res.rows.length) return null;
  await sqlite.execute(
    "UPDATE channel_characters SET updated_at = ? WHERE broadcaster_id = ? AND username = ?",
    [Date.now(), broadcasterId, username],
  );
  return rowToCharacter(res.rows[0]);
}

export async function saveCharacter(c: Character, broadcasterId: string) {
  const existing = await sqlite.execute(
    "SELECT 1 FROM channel_characters WHERE broadcaster_id = ? AND username = ?",
    [broadcasterId, c.username],
  );
  if (!existing.rows.length) {
    const max = Math.max(1, Number(Deno.env.get("MAX_CHARACTERS_PER_CHANNEL") ?? "500"));
    const count = await sqlite.execute("SELECT COUNT(*) AS count FROM channel_characters WHERE broadcaster_id = ?", [broadcasterId]);
    if (Number(count.rows[0]?.count ?? 0) >= max) throw new Error(`Channel character cap reached (${max}).`);
  }
  const now = Date.now();
  await sqlite.execute(
    "INSERT OR IGNORE INTO channel_characters (broadcaster_id,username,created_at,updated_at) VALUES (?,?,?,?)",
    [broadcasterId, c.username, now, now],
  );
  await sqlite.execute("UPDATE channel_characters SET updated_at = ? WHERE broadcaster_id = ? AND username = ?", [now, broadcasterId, c.username]);
  await sqlite.execute(
    `INSERT OR REPLACE INTO characters
      (broadcaster_id,username,race,subrace,class,level,xp,str,dex,con,int,wis,cha,speed,hp_max,hp_current,proficiency,traits,spells,items,feats,abilities)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      broadcasterId,
      c.username,
      c.race,
      c.subrace,
      c.cls,
      c.level,
      c.xp ?? 0,
      c.scores.STR,
      c.scores.DEX,
      c.scores.CON,
      c.scores.INT,
      c.scores.WIS,
      c.scores.CHA,
      c.speed,
      c.hpMax,
      c.hpCurrent,
      c.proficiency,
      JSON.stringify(c.traits),
      JSON.stringify(c.spells),
      JSON.stringify(c.items),
      JSON.stringify(c.feats),
      JSON.stringify(c.abilities),
    ],
  );
}

export async function adjustHp(username: string, delta: number, broadcasterId: string) {
  const c = await getCharacter(username, broadcasterId);
  if (!c) return null;
  c.hpCurrent = Math.max(0, Math.min(c.hpMax, c.hpCurrent + delta));
  await sqlite.execute("UPDATE characters SET hp_current = ? WHERE broadcaster_id = ? AND username = ?", [c.hpCurrent, broadcasterId, username]);
  return c;
}

export async function backupCharacter(username: string, broadcasterId: string) {
  const c = await getCharacter(username, broadcasterId);
  if (!c) return false;
  await sqlite.execute(
    `INSERT OR REPLACE INTO character_backups
      (broadcaster_id,username,race,subrace,class,level,xp,str,dex,con,int,wis,cha,speed,hp_max,hp_current,proficiency,traits,spells,items,feats,abilities)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      broadcasterId,
      c.username,
      c.race,
      c.subrace,
      c.cls,
      c.level,
      c.xp ?? 0,
      c.scores.STR,
      c.scores.DEX,
      c.scores.CON,
      c.scores.INT,
      c.scores.WIS,
      c.scores.CHA,
      c.speed,
      c.hpMax,
      c.hpCurrent,
      c.proficiency,
      JSON.stringify(c.traits),
      JSON.stringify(c.spells),
      JSON.stringify(c.items),
      JSON.stringify(c.feats),
      JSON.stringify(c.abilities),
    ],
  );
  return true;
}

export async function loadBackup(username: string, broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM character_backups WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username]);
  if (!res.rows.length) return null;
  const c = rowToCharacter(res.rows[0]);
  await saveCharacter(c, broadcasterId);
  return c;
}

export async function resetCharacter(username: string, broadcasterId: string) {
  await sqlite.execute("DELETE FROM channel_characters WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username]);
  await sqlite.execute("DELETE FROM characters WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username]);
  await sqlite.execute("DELETE FROM character_backups WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username]);
}

export async function getCreationSession(username: string, broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM creation_sessions WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username]);
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return {
    username,
    broadcasterId,
    step: r.step,
    race: r.race,
    subrace: r.subrace,
    cls: r.class,
    scores: r.scores ? JSON.parse(r.scores) : null,
    subclass: r.subclass ?? null,
    background: r.background ?? null,
    alignment: r.alignment ?? null,
    hook: r.hook ?? null,
    targetUser: r.target_user ?? null,
  };
}

export async function saveCreationSession(s: any, broadcasterId: string) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO creation_sessions (broadcaster_id,username,step,race,subrace,class,scores,subclass,background,alignment,hook,target_user,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      broadcasterId,
      s.username,
      s.step,
      s.race ?? null,
      s.subrace ?? null,
      s.cls ?? null,
      s.scores ? JSON.stringify(s.scores) : null,
      s.subclass ?? null,
      s.background ?? null,
      s.alignment ?? null,
      s.hook ?? null,
      s.targetUser ?? null,
      Date.now(),
    ],
  );
}

export async function clearCreationSession(username: string, broadcasterId: string) {
  await sqlite.execute("DELETE FROM creation_sessions WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username]);
}

export async function getConnections() {
  const res = await sqlite.execute("SELECT display_name, login FROM broadcasters WHERE connected = 1 ORDER BY connected_at ASC");
  return res.rows.map((r: any) => r.display_name || r.login);
}

export async function isChannelBlocked(broadcasterId: string) {
  const res = await sqlite.execute("SELECT 1 FROM channel_blocks WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length > 0;
}

export async function blockChannel(broadcasterId: string, reason = "operator block") {
  await sqlite.execute("INSERT OR REPLACE INTO channel_blocks (broadcaster_id,reason,created_at,updated_at) VALUES (?,?,COALESCE((SELECT created_at FROM channel_blocks WHERE broadcaster_id = ?),?),?)", [broadcasterId, reason.slice(0,240), broadcasterId, Date.now(), Date.now()]);
  await setChannelEnabled(broadcasterId, false);
}

export async function unblockChannel(broadcasterId: string) {
  await sqlite.execute("DELETE FROM channel_blocks WHERE broadcaster_id = ?", [broadcasterId]);
  await setChannelEnabled(broadcasterId, true);
}

export async function markBroadcasterDisconnected(broadcasterId: string, reason: string, subscriptionId?: string) {
  await sqlite.execute(
    "UPDATE broadcasters SET connected = 0, disconnected_at = ?, disconnect_reason = ?, subscription_id = COALESCE(?, subscription_id) WHERE broadcaster_id = ?",
    [Date.now(), reason.slice(0, 240), subscriptionId ?? null, broadcasterId],
  );
}

export async function getBroadcaster(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM broadcasters WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length ? res.rows[0] : null;
}

/** Bulk-fetch connected broadcasters from a candidate id list (e.g. "channels
 * this Twitch user moderates or owns") — used by the /dashboard route to
 * intersect a viewer's Twitch moderator status with channels GuildScribe
 * actually knows about. Returns only rows that are currently connected. */
export async function getConnectedBroadcastersByIds(broadcasterIds: string[]) {
  const ids = [...new Set(broadcasterIds)].filter(Boolean);
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const res = await sqlite.execute(
    `SELECT * FROM broadcasters WHERE connected = 1 AND broadcaster_id IN (${placeholders})`,
    ids,
  );
  return res.rows;
}

// "kind" is a short label ("sub" for channel.subscribe, "resub" for
// channel.subscription.message) distinguishing the two extra subscriptions
// created alongside the main chat-message one in broadcasters.subscription_id.
export async function saveExtraEventSubSubscription(broadcasterId: string, kind: string, subscriptionId: string) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO eventsub_extra_subscriptions (broadcaster_id,kind,subscription_id,created_at) VALUES (?,?,?,?)",
    [broadcasterId, kind, subscriptionId, Date.now()],
  );
}

export async function getExtraEventSubSubscriptions(broadcasterId: string) {
  const res = await sqlite.execute(
    "SELECT kind, subscription_id FROM eventsub_extra_subscriptions WHERE broadcaster_id = ?",
    [broadcasterId],
  );
  return res.rows as Array<{ kind: string; subscription_id: string }>;
}

export async function deleteExtraEventSubSubscriptions(broadcasterId: string) {
  await sqlite.execute("DELETE FROM eventsub_extra_subscriptions WHERE broadcaster_id = ?", [broadcasterId]);
}

export async function purgeChannelData(broadcasterId: string) {
  for (const table of [
    "activity_logs",
    "creation_sessions",
    "encounters",
    "duel_challenges",
    "duels",
    "parties",
    "party_members",
    "party_invites",
    "party_duel_challenges",
    "party_duels",
    "monster_duels",
    "party_monster_duels",
    "channel_settings",
    "merchant_settings",
    "chronicle_settings",
    "chronicle_activity",
    "npc_settings",
    "npc_chatter_settings",
    "npc_chatter_activity",
    "channel_characters",
    "characters",
    "character_backups",
    "eventsub_extra_subscriptions",
    "maps",
    "map_cells",
    "map_tokens",
    "dice_roll_events",
    "broadcaster_ad_tokens",
    "ad_tracking",
  ]) {
    await sqlite.execute(`DELETE FROM ${table} WHERE broadcaster_id = ?`, [broadcasterId]);
  }
  // npc_characters/npc_conversations are keyed by owner_key ("twitch:<id>"),
  // not broadcaster_id directly, so they don't fit the generic loop above.
  await sqlite.execute("DELETE FROM npc_characters WHERE owner_key = ?", [`twitch:${broadcasterId}`]);
  await sqlite.execute("DELETE FROM npc_conversations WHERE owner_key = ?", [`twitch:${broadcasterId}`]);
  await sqlite.execute("DELETE FROM broadcasters WHERE broadcaster_id = ?", [broadcasterId]);
}

export async function disconnectBroadcasterData(broadcasterId: string, purge = false) {
  if (purge) await purgeChannelData(broadcasterId);
  else {
    await sqlite.execute("DELETE FROM channel_settings WHERE broadcaster_id = ?", [broadcasterId]);
    await sqlite.execute("DELETE FROM merchant_settings WHERE broadcaster_id = ?", [broadcasterId]);
    await sqlite.execute("DELETE FROM chronicle_settings WHERE broadcaster_id = ?", [broadcasterId]);
    await sqlite.execute("DELETE FROM npc_settings WHERE broadcaster_id = ?", [broadcasterId]);
    await sqlite.execute("DELETE FROM npc_chatter_settings WHERE broadcaster_id = ?", [broadcasterId]);
    await sqlite.execute("DELETE FROM eventsub_extra_subscriptions WHERE broadcaster_id = ?", [broadcasterId]);
    // Credential material tied to the connection itself, not gameplay data —
    // cleared on every disconnect (not just purge), same as the broadcasters
    // row and its EventSub subscriptions.
    await sqlite.execute("DELETE FROM broadcaster_ad_tokens WHERE broadcaster_id = ?", [broadcasterId]);
    await sqlite.execute("DELETE FROM broadcasters WHERE broadcaster_id = ?", [broadcasterId]);
  }
}

export async function isChannelEnabled(broadcasterId: string) {
  const res = await sqlite.execute("SELECT enabled FROM channel_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return !res.rows.length || Number(res.rows[0].enabled) === 1;
}

export async function setChannelEnabled(broadcasterId: string, enabled: boolean) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO channel_settings (broadcaster_id, enabled, updated_at) VALUES (?,?,?)",
    [broadcasterId, enabled ? 1 : 0, Date.now()],
  );
}

export async function isMerchantEnabled(broadcasterId: string) {
  const res = await sqlite.execute("SELECT enabled FROM merchant_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length > 0 && Number(res.rows[0].enabled) === 1;
}

/** Toggle the open-stall merchant. `nextPostAt` should be a freshly randomized
 * due time (ms epoch) when enabling; pass null when disabling. */
export async function setMerchantEnabled(broadcasterId: string, enabled: boolean, nextPostAt: number | null) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO merchant_settings (broadcaster_id, enabled, next_post_at, updated_at) VALUES (?,?,?,?)",
    [broadcasterId, enabled ? 1 : 0, enabled ? nextPostAt : null, Date.now()],
  );
}

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

/** Create a /dashboard login session after a successful Twitch OAuth
 * exchange. session_id is the opaque value stored in the viewer's cookie. */
export async function createDashboardSession(opts: {
  sessionId: string;
  userId: string;
  login: string;
  displayName: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: number;
}) {
  const now = Date.now();
  await sqlite.execute(
    `INSERT OR REPLACE INTO dashboard_sessions
     (session_id, user_id, login, display_name, access_token, refresh_token, token_expires_at, created_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      opts.sessionId,
      opts.userId,
      opts.login,
      opts.displayName,
      opts.accessToken,
      opts.refreshToken,
      opts.tokenExpiresAt,
      now,
      now,
    ],
  );
}

export async function getDashboardSession(sessionId: string) {
  const res = await sqlite.execute("SELECT * FROM dashboard_sessions WHERE session_id = ?", [sessionId]);
  return res.rows.length ? res.rows[0] : null;
}

/** Called after a token refresh so the next request reuses the new access
 * token instead of refreshing again. */
export async function updateDashboardSessionToken(
  sessionId: string,
  accessToken: string,
  refreshToken: string | null,
  tokenExpiresAt: number,
) {
  await sqlite.execute(
    "UPDATE dashboard_sessions SET access_token = ?, refresh_token = ?, token_expires_at = ?, last_seen_at = ? WHERE session_id = ?",
    [accessToken, refreshToken, tokenExpiresAt, Date.now(), sessionId],
  );
}

export async function deleteDashboardSession(sessionId: string) {
  await sqlite.execute("DELETE FROM dashboard_sessions WHERE session_id = ?", [sessionId]);
}

/** Persists (or refreshes) the broadcaster's own ad-schedule OAuth token —
 * called once from the /callback OAuth exchange and again by ads.ts
 * whenever a stored token is refreshed. */
export async function saveBroadcasterAdToken(
  broadcasterId: string,
  accessToken: string,
  refreshToken: string,
  scope: string,
  expiresAt: number,
) {
  await sqlite.execute(
    `INSERT OR REPLACE INTO broadcaster_ad_tokens
     (broadcaster_id, access_token, refresh_token, scope, expires_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
    [broadcasterId, accessToken, refreshToken, scope, expiresAt, Date.now()],
  );
}

export async function getBroadcasterAdToken(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM broadcaster_ad_tokens WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length ? res.rows[0] : null;
}

/** Records a mod/broadcaster manually marking "ads were just run" via
 * !adslogged — the fallback source of truth when the real Twitch ad
 * schedule isn't available for this channel. */
export async function recordManualAdTrigger(broadcasterId: string, byUser: string) {
  const now = Date.now();
  await sqlite.execute(
    `INSERT OR REPLACE INTO ad_tracking (broadcaster_id, last_ad_at, last_ad_source, last_ad_by, updated_at)
     VALUES (?,?,?,?,?)`,
    [broadcasterId, now, "manual", byUser, now],
  );
}

export async function getAdTracking(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM ad_tracking WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length ? res.rows[0] : null;
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

/** Channels whose merchant is enabled, due for a post, connected, not
 * operator-blocked, and not otherwise disabled via !dndbot off. */
export async function getDueMerchantChannels(now: number): Promise<string[]> {
  const res = await sqlite.execute(
    `SELECT m.broadcaster_id AS broadcaster_id
     FROM merchant_settings m
     JOIN broadcasters b ON b.broadcaster_id = m.broadcaster_id AND b.connected = 1
     LEFT JOIN channel_settings cs ON cs.broadcaster_id = m.broadcaster_id
     LEFT JOIN channel_blocks cb ON cb.broadcaster_id = m.broadcaster_id
     WHERE m.enabled = 1
       AND m.next_post_at IS NOT NULL AND m.next_post_at <= ?
       AND cb.broadcaster_id IS NULL
       AND (cs.enabled IS NULL OR cs.enabled = 1)`,
    [now],
  );
  return res.rows.map((r: any) => String(r.broadcaster_id));
}

export async function rescheduleMerchant(broadcasterId: string, nextPostAt: number) {
  await sqlite.execute(
    "UPDATE merchant_settings SET next_post_at = ?, updated_at = ? WHERE broadcaster_id = ?",
    [nextPostAt, Date.now(), broadcasterId],
  );
}

/** Records the outcome of one merchant.cron.ts tick. `errorDetail` should be
 * the most recent failure's message, or null if the tick had no failures —
 * on a clean tick the previously-recorded error (if any) is preserved so a
 * status check still shows the last time something actually went wrong. */
export async function recordMerchantCronRun(
  now: number,
  channelsDue: number,
  postsOk: number,
  postsFailed: number,
  errorDetail: string | null,
) {
  await sqlite.execute(
    `INSERT OR REPLACE INTO merchant_cron_status
       (id, last_run_at, last_channels_due, last_posts_ok, last_posts_failed,
        last_error, last_error_at, last_success_at,
        total_runs, total_posts_ok, total_posts_failed)
     VALUES (
       1, ?, ?, ?, ?,
       CASE WHEN ? > 0 THEN ? ELSE (SELECT last_error FROM merchant_cron_status WHERE id = 1) END,
       CASE WHEN ? > 0 THEN ? ELSE (SELECT last_error_at FROM merchant_cron_status WHERE id = 1) END,
       CASE WHEN ? > 0 THEN ? ELSE (SELECT last_success_at FROM merchant_cron_status WHERE id = 1) END,
       COALESCE((SELECT total_runs FROM merchant_cron_status WHERE id = 1), 0) + 1,
       COALESCE((SELECT total_posts_ok FROM merchant_cron_status WHERE id = 1), 0) + ?,
       COALESCE((SELECT total_posts_failed FROM merchant_cron_status WHERE id = 1), 0) + ?
     )`,
    [
      now, channelsDue, postsOk, postsFailed,
      postsFailed, errorDetail ? errorDetail.slice(0, 300) : null,
      postsFailed, now,
      postsOk, now,
      postsOk, postsFailed,
    ],
  );
}

export async function getMerchantCronStatus() {
  const res = await sqlite.execute("SELECT * FROM merchant_cron_status WHERE id = 1");
  return res.rows[0] ?? null;
}

/** Per-channel merchant diagnostic view: settings joined with connection,
 * block, and bot-enable state, so an operator can see at a glance *why* a
 * given channel's merchant isn't posting (never turned on, channel
 * disconnected, blocked, bot disabled, or just not due yet). Ordered by
 * next_post_at so the soonest-due channels surface first. */
export async function getMerchantOverview() {
  const res = await sqlite.execute(
    `SELECT
       m.broadcaster_id AS broadcaster_id,
       b.login AS login,
       b.display_name AS display_name,
       m.enabled AS merchant_enabled,
       m.next_post_at AS next_post_at,
       m.updated_at AS merchant_updated_at,
       b.connected AS connected,
       CASE WHEN cb.broadcaster_id IS NULL THEN 0 ELSE 1 END AS blocked,
       cb.reason AS block_reason,
       COALESCE(cs.enabled, 1) AS bot_enabled
     FROM merchant_settings m
     LEFT JOIN broadcasters b ON b.broadcaster_id = m.broadcaster_id
     LEFT JOIN channel_blocks cb ON cb.broadcaster_id = m.broadcaster_id
     LEFT JOIN channel_settings cs ON cs.broadcaster_id = m.broadcaster_id
     ORDER BY (m.next_post_at IS NULL), m.next_post_at ASC`,
  );
  return res.rows;
}

/** Per-channel NPC overview for the admin logs page: on/off state, roster
 * size, and total uses across the channel's own NPCs (global-roster NPCs
 * aren't attributed to any one channel, so they're excluded from the count
 * here). Only channels with an npc_settings row appear — i.e. at least one
 * !npc on/off toggle has happened — same convention as getMerchantOverview. */
export async function getNpcOverview() {
  const res = await sqlite.execute(
    `SELECT
       n.broadcaster_id AS broadcaster_id,
       b.login AS login,
       b.display_name AS display_name,
       n.enabled AS npc_enabled,
       n.updated_at AS npc_updated_at,
       COALESCE(nch.enabled, 0) AS chatter_enabled,
       b.connected AS connected,
       CASE WHEN cb.broadcaster_id IS NULL THEN 0 ELSE 1 END AS blocked,
       cb.reason AS block_reason,
       COALESCE(cs.enabled, 1) AS bot_enabled,
       COALESCE(nc.character_count, 0) AS character_count,
       COALESCE(nc.total_uses, 0) AS total_uses
     FROM npc_settings n
     LEFT JOIN broadcasters b ON b.broadcaster_id = n.broadcaster_id
     LEFT JOIN channel_blocks cb ON cb.broadcaster_id = n.broadcaster_id
     LEFT JOIN channel_settings cs ON cs.broadcaster_id = n.broadcaster_id
     LEFT JOIN npc_chatter_settings nch ON nch.broadcaster_id = n.broadcaster_id
     LEFT JOIN (
       SELECT owner_key, COUNT(*) AS character_count, SUM(uses) AS total_uses
       FROM npc_characters GROUP BY owner_key
     ) nc ON nc.owner_key = 'twitch:' || n.broadcaster_id
     ORDER BY n.enabled DESC, n.updated_at DESC`,
  );
  return res.rows;
}

/** Recent monitor_events, optionally filtered to kinds starting with a
 * prefix (e.g. "merchant" to see only merchant-related entries). */
export async function getMonitorEvents(kindPrefix?: string, limit = 50) {
  const cappedLimit = Math.min(Math.max(Math.floor(limit) || 50, 1), 200);
  if (kindPrefix) {
    const res = await sqlite.execute(
      "SELECT kind, detail, created_at FROM monitor_events WHERE kind LIKE ? ORDER BY id DESC LIMIT ?",
      [`${kindPrefix}%`, cappedLimit],
    );
    return res.rows;
  }
  const res = await sqlite.execute(
    "SELECT kind, detail, created_at FROM monitor_events ORDER BY id DESC LIMIT ?",
    [cappedLimit],
  );
  return res.rows;
}

export async function getDuel(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM duels WHERE broadcaster_id = ? AND active = 1", [broadcasterId]);
  return res.rows.length ? res.rows[0] : null;
}

export async function getMonsterDuel(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM monster_duels WHERE broadcaster_id = ? AND active = 1", [
    broadcasterId,
  ]);
  return res.rows.length ? res.rows[0] : null;
}

export async function getParty(broadcasterId: string, partyName: string) {
  const res = await sqlite.execute("SELECT * FROM parties WHERE broadcaster_id = ? AND party_name = ?", [
    broadcasterId,
    partyName.toLowerCase(),
  ]);
  return res.rows.length ? res.rows[0] : null;
}

export async function getPartyMembers(broadcasterId: string, partyName: string) {
  const res = await sqlite.execute(
    "SELECT username FROM party_members WHERE broadcaster_id = ? AND party_name = ? ORDER BY joined_at ASC",
    [broadcasterId, partyName.toLowerCase()],
  );
  return res.rows.map((r: any) => String(r.username));
}

// A party invite must be explicitly accepted by the target before they're
// added to party_members — see !party invite / accept / decline.
export async function createPartyInvite(
  broadcasterId: string,
  partyName: string,
  target: string,
  inviter: string,
) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO party_invites (broadcaster_id,party_name,target,inviter,created_at) VALUES (?,?,?,?,?)",
    [broadcasterId, partyName, target, inviter, Date.now()],
  );
}

export async function getPartyInvites(broadcasterId: string, target: string) {
  const res = await sqlite.execute(
    "SELECT * FROM party_invites WHERE broadcaster_id = ? AND target = ? ORDER BY created_at DESC",
    [broadcasterId, target],
  );
  return res.rows;
}

export async function getPartyInvite(broadcasterId: string, target: string, partyName: string) {
  const res = await sqlite.execute(
    "SELECT * FROM party_invites WHERE broadcaster_id = ? AND target = ? AND party_name = ?",
    [broadcasterId, target, partyName],
  );
  return res.rows.length ? res.rows[0] : null;
}

export async function deletePartyInvite(broadcasterId: string, partyName: string, target: string) {
  await sqlite.execute("DELETE FROM party_invites WHERE broadcaster_id = ? AND party_name = ? AND target = ?", [
    broadcasterId,
    partyName,
    target,
  ]);
}

export async function getPartyDuel(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM party_duels WHERE broadcaster_id = ? AND active = 1", [
    broadcasterId,
  ]);
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return {
    ...r,
    current_index: Number(r.current_index),
    challenger_members: JSON.parse(r.challenger_members || "[]"),
    defender_members: JSON.parse(r.defender_members || "[]"),
    challenger_hp: JSON.parse(r.challenger_hp || "{}"),
    defender_hp: JSON.parse(r.defender_hp || "{}"),
  };
}

export async function getEncounter(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM encounters WHERE broadcaster_id = ?", [broadcasterId]);
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return {
    broadcasterId,
    round: Number(r.round),
    currentIndex: Number(r.current_index),
    active: Boolean(r.active),
    entries: JSON.parse(r.entries || "[]") as Array<{ name: string; initiative: number; dex?: number; rolled?: boolean }>,
  };
}

export async function saveEncounter(e: any) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO encounters (broadcaster_id,round,current_index,active,entries,updated_at) VALUES (?,?,?,?,?,?)",
    [e.broadcasterId, e.round, e.currentIndex, e.active ? 1 : 0, JSON.stringify(e.entries), Date.now()],
  );
}

export async function recordActivity(username: string, broadcasterId: string, action: string, detail: string) {
  await sqlite.execute(
    "INSERT INTO activity_logs (username,broadcaster_id,action,detail,created_at) VALUES (?,?,?,?,?)",
    [username, broadcasterId, action.slice(0, 40), detail.replace(/\s+/g, " ").trim().slice(0, 220), Date.now()],
  );
  // Retain at most 5,000 rows per channel, plus a hard 90-day privacy window.
  await sqlite.execute(
    `DELETE FROM activity_logs
     WHERE created_at < ?
        OR (broadcaster_id = ? AND id NOT IN (SELECT id FROM activity_logs WHERE broadcaster_id = ? ORDER BY id DESC LIMIT 5000))`,
    [Date.now() - 90 * 24 * 60 * 60 * 1000, broadcasterId, broadcasterId],
  );
}

export async function getRecentLogs(broadcasterId?: string, limit = 200) {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const query = broadcasterId
    ? `SELECT username,broadcaster_id,action,detail,created_at FROM activity_logs WHERE broadcaster_id = ? ORDER BY id DESC LIMIT ${safeLimit}`
    : `SELECT username,broadcaster_id,action,detail,created_at FROM activity_logs ORDER BY id DESC LIMIT ${safeLimit}`;
  const res = await sqlite.execute(query, broadcasterId ? [broadcasterId] : []);
  return res.rows;
}

/** Self-healing safety net for schema drift: ensureTables() already runs a
 * best-effort ALTER TABLE ADD COLUMN for columns added after a table
 * originally shipped (see the monster_duels/player_hp comment above), but
 * that migration hasn't proven 100% reliable in practice — a write
 * referencing the column can still occasionally hit "no such column" (seen
 * with monster_duels/player_hp: the bot goes silent mid-duel with an
 * unhandled_error instead of replying). Rather than track down exactly why
 * that particular ALTER isn't always landing in time, this wraps the
 * fragile write itself: run it, and if it fails specifically because the
 * named column is missing, add the column right here and retry once before
 * giving up. Cheap, idempotent, and fixes the symptom regardless of cause. */
export async function withColumnHeal<T>(
  table: string,
  column: string,
  columnDef: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!String(e).includes(`no such column: ${column}`)) throw e;
    try {
      await sqlite.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
    } catch (_) {
      /* lost a race with another request adding it concurrently — fine,
         fn() below will succeed either way, or throw its real error. */
    }
    return await fn();
  }
}

export { sqlite };

export async function queueEventSubCancellation(subscriptionId: string, broadcasterId: string, error: string) {
  if (!subscriptionId) return;
  await sqlite.execute(
    `INSERT OR REPLACE INTO pending_eventsub_cancellations (subscription_id,broadcaster_id,attempts,last_error,updated_at)
     VALUES (?, ?, COALESCE((SELECT attempts FROM pending_eventsub_cancellations WHERE subscription_id = ?), 0) + 1, ?, ?)`,
    [subscriptionId, broadcasterId, subscriptionId, error.slice(0, 500), Date.now()],
  );
}

export async function getPendingEventSubCancellations(limit = 5) {
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const res = await sqlite.execute(`SELECT * FROM pending_eventsub_cancellations ORDER BY updated_at ASC LIMIT ${safeLimit}`);
  return res.rows;
}

export async function clearPendingEventSubCancellation(subscriptionId: string) {
  await sqlite.execute("DELETE FROM pending_eventsub_cancellations WHERE subscription_id = ?", [subscriptionId]);
}

export async function claimEventSubMessage(messageId: string, now = Date.now()) {
  if (!messageId) return false;
  try {
    await sqlite.execute("INSERT INTO eventsub_messages (message_id,received_at) VALUES (?,?)", [messageId, now]);
    await sqlite.execute("DELETE FROM eventsub_messages WHERE received_at < ?", [now - 24 * 60 * 60 * 1000]);
    return true;
  } catch (_) {
    return false;
  }
}

export async function checkCommandRateLimit(broadcasterId: string, username: string, cooldownMs = 1200) {
  const now = Date.now();
  const res = await sqlite.execute("SELECT last_at FROM command_rate_limits WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username]);
  const last = Number(res.rows[0]?.last_at ?? 0);
  if (now - last < cooldownMs) return false;
  await sqlite.execute("INSERT OR REPLACE INTO command_rate_limits (broadcaster_id,username,last_at) VALUES (?,?,?)", [broadcasterId, username, now]);
  await sqlite.execute("DELETE FROM command_rate_limits WHERE last_at < ?", [now - 10 * 60 * 1000]);
  return true;
}

// Per-channel cooldown so a wave of "goodnight"s from many chatters only
// gets one bot reply instead of one per person.
export async function checkGoodnightCooldown(broadcasterId: string, cooldownMs = 300_000) {
  const now = Date.now();
  const res = await sqlite.execute("SELECT last_at FROM goodnight_cooldowns WHERE broadcaster_id = ?", [broadcasterId]);
  const last = Number(res.rows[0]?.last_at ?? 0);
  if (now - last < cooldownMs) return false;
  await sqlite.execute("INSERT OR REPLACE INTO goodnight_cooldowns (broadcaster_id,last_at) VALUES (?,?)", [broadcasterId, now]);
  return true;
}

export async function recordMonitorEvent(kind: string, detail: string) {
  await sqlite.execute("INSERT INTO monitor_events (kind,detail,created_at) VALUES (?,?,?)", [kind.slice(0,80), detail.slice(0,500), Date.now()]);
  await sqlite.execute("DELETE FROM monitor_events WHERE id NOT IN (SELECT id FROM monitor_events ORDER BY id DESC LIMIT 1000)");
}

export async function getChannelCounts(broadcasterId: string) {
  const [p, c, l] = await Promise.all([
    sqlite.execute("SELECT COUNT(*) AS count FROM parties WHERE broadcaster_id = ?", [broadcasterId]),
    sqlite.execute("SELECT COUNT(*) AS count FROM channel_characters WHERE broadcaster_id = ?", [broadcasterId]),
    sqlite.execute("SELECT COUNT(*) AS count FROM activity_logs WHERE broadcaster_id = ?", [broadcasterId]),
  ]);
  return { parties: Number(p.rows[0]?.count ?? 0), characters: Number(c.rows[0]?.count ?? 0), logs: Number(l.rows[0]?.count ?? 0) };
}

// ── Maps ──

export type MapRow = {
  broadcaster_id: string;
  map_name: string;
  width: number;
  height: number;
  default_terrain: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};

export type MapToken = {
  username: string;
  display_name: string | null;
  x: number;
  y: number;
};

export async function getMap(broadcasterId: string, mapName: string): Promise<MapRow | null> {
  const res = await sqlite.execute("SELECT * FROM maps WHERE broadcaster_id = ? AND map_name = ?", [broadcasterId, mapName]);
  if (!res.rows.length) return null;
  const r: any = res.rows[0];
  return {
    broadcaster_id: r.broadcaster_id,
    map_name: r.map_name,
    width: Number(r.width),
    height: Number(r.height),
    default_terrain: r.default_terrain,
    created_by: r.created_by,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

export async function listMaps(broadcasterId: string): Promise<MapRow[]> {
  const res = await sqlite.execute("SELECT * FROM maps WHERE broadcaster_id = ? ORDER BY map_name ASC", [broadcasterId]);
  return res.rows.map((r: any) => ({
    broadcaster_id: r.broadcaster_id,
    map_name: r.map_name,
    width: Number(r.width),
    height: Number(r.height),
    default_terrain: r.default_terrain,
    created_by: r.created_by,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  }));
}

export async function createMap(
  broadcasterId: string,
  mapName: string,
  width: number,
  height: number,
  createdBy: string,
) {
  const maxMaps = Math.max(1, Number(Deno.env.get("MAX_MAPS_PER_CHANNEL") ?? "25"));
  const count = await sqlite.execute("SELECT COUNT(*) AS count FROM maps WHERE broadcaster_id = ?", [broadcasterId]);
  if (Number(count.rows[0]?.count ?? 0) >= maxMaps) throw new Error(`Channel map cap reached (${maxMaps}).`);
  const now = Date.now();
  await sqlite.execute(
    "INSERT INTO maps (broadcaster_id,map_name,width,height,default_terrain,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [broadcasterId, mapName, width, height, "grass", createdBy, now, now],
  );
}

export async function deleteMap(broadcasterId: string, mapName: string) {
  await sqlite.execute("DELETE FROM maps WHERE broadcaster_id = ? AND map_name = ?", [broadcasterId, mapName]);
  await sqlite.execute("DELETE FROM map_cells WHERE broadcaster_id = ? AND map_name = ?", [broadcasterId, mapName]);
  await sqlite.execute("DELETE FROM map_tokens WHERE broadcaster_id = ? AND map_name = ?", [broadcasterId, mapName]);
}

async function touchMap(broadcasterId: string, mapName: string) {
  await sqlite.execute("UPDATE maps SET updated_at = ? WHERE broadcaster_id = ? AND map_name = ?", [Date.now(), broadcasterId, mapName]);
}

export async function getMapCells(broadcasterId: string, mapName: string): Promise<Record<string, string>> {
  const res = await sqlite.execute("SELECT x,y,terrain FROM map_cells WHERE broadcaster_id = ? AND map_name = ?", [broadcasterId, mapName]);
  const out: Record<string, string> = {};
  for (const r of res.rows as any[]) out[`${r.x},${r.y}`] = r.terrain;
  return out;
}

export async function setMapCell(broadcasterId: string, mapName: string, x: number, y: number, terrain: string) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO map_cells (broadcaster_id,map_name,x,y,terrain) VALUES (?,?,?,?,?)",
    [broadcasterId, mapName, x, y, terrain],
  );
  await touchMap(broadcasterId, mapName);
}

export async function fillMap(broadcasterId: string, mapName: string, terrain: string) {
  await sqlite.execute("DELETE FROM map_cells WHERE broadcaster_id = ? AND map_name = ?", [broadcasterId, mapName]);
  await sqlite.execute("UPDATE maps SET default_terrain = ?, updated_at = ? WHERE broadcaster_id = ? AND map_name = ?", [
    terrain,
    Date.now(),
    broadcasterId,
    mapName,
  ]);
}

export async function getMapTokens(broadcasterId: string, mapName: string): Promise<MapToken[]> {
  const res = await sqlite.execute(
    "SELECT username,display_name,x,y FROM map_tokens WHERE broadcaster_id = ? AND map_name = ?",
    [broadcasterId, mapName],
  );
  return (res.rows as any[]).map((r) => ({ username: r.username, display_name: r.display_name, x: Number(r.x), y: Number(r.y) }));
}

export async function getMapToken(broadcasterId: string, mapName: string, username: string): Promise<MapToken | null> {
  const res = await sqlite.execute(
    "SELECT username,display_name,x,y FROM map_tokens WHERE broadcaster_id = ? AND map_name = ? AND username = ?",
    [broadcasterId, mapName, username],
  );
  if (!res.rows.length) return null;
  const r: any = res.rows[0];
  return { username: r.username, display_name: r.display_name, x: Number(r.x), y: Number(r.y) };
}

export async function findTokenAt(broadcasterId: string, mapName: string, x: number, y: number): Promise<MapToken | null> {
  const res = await sqlite.execute(
    "SELECT username,display_name,x,y FROM map_tokens WHERE broadcaster_id = ? AND map_name = ? AND x = ? AND y = ?",
    [broadcasterId, mapName, x, y],
  );
  if (!res.rows.length) return null;
  const r: any = res.rows[0];
  return { username: r.username, display_name: r.display_name, x: Number(r.x), y: Number(r.y) };
}

export async function upsertMapToken(
  broadcasterId: string,
  mapName: string,
  username: string,
  displayName: string,
  x: number,
  y: number,
) {
  const now = Date.now();
  await sqlite.execute(
    "INSERT OR REPLACE INTO map_tokens (broadcaster_id,map_name,username,display_name,x,y,placed_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [broadcasterId, mapName, username, displayName, x, y, now, now],
  );
  await touchMap(broadcasterId, mapName);
}

export async function removeMapToken(broadcasterId: string, mapName: string, username: string) {
  await sqlite.execute("DELETE FROM map_tokens WHERE broadcaster_id = ? AND map_name = ? AND username = ?", [broadcasterId, mapName, username]);
  await touchMap(broadcasterId, mapName);
}

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

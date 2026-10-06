// SQLite persistence layer

import { sqlite } from "./sqlite.ts";
import type { Character } from "./types.ts";
import { COMMAND_GROUPS } from "./commandgroups.ts";

// db.ts is split by area to stay well under Val Town's per-file size
// ceiling; these modules are re-exported so importers keep using "./db.ts".
export * from "./db_schema.ts";
export * from "./db_custom.ts";
export * from "./db_merchant.ts";
export * from "./db_maps.ts";

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

/** Set from stream.online/stream.offline EventSub notifications (see
 * main.ts). Also set once from a direct Twitch lookup right after a channel
 * connects, so is_live isn't wrong for however long until the first future
 * transition (see fetchIsChannelLiveNow in twitch.ts). */
export async function setBroadcasterLiveStatus(broadcasterId: string, live: boolean) {
  await sqlite.execute("UPDATE broadcasters SET is_live = ? WHERE broadcaster_id = ?", [live ? 1 : 0, broadcasterId]);
}

/** Marks a channel as having stream.online/offline EventSub subscriptions,
 * optionally seeding is_live in the same write (used by the lazy backfill in
 * main.ts for channels connected before this feature existed). */
export async function markStreamStatusSubscribed(broadcasterId: string, isLiveNow?: boolean) {
  if (isLiveNow === undefined) {
    await sqlite.execute("UPDATE broadcasters SET stream_status_subscribed = 1 WHERE broadcaster_id = ?", [broadcasterId]);
  } else {
    await sqlite.execute(
      "UPDATE broadcasters SET stream_status_subscribed = 1, is_live = ? WHERE broadcaster_id = ?",
      [isLiveNow ? 1 : 0, broadcasterId],
    );
  }
}

export async function getBroadcaster(broadcasterId: string) {
  const res = await sqlite.execute("SELECT * FROM broadcasters WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length ? res.rows[0] : null;
}

/** Connected, unblocked channels that haven't switched the "showcase" group
 * off — the public channel list on tavernworks.dev (GET /api/channels).
 * No toggle row means listed, same as every other command group.
 * `excludeId` drops the bot's own account (connected for testing), which
 * isn't a guild. */
export async function listShowcaseChannels(excludeId = ""): Promise<Array<{ login: string; display_name: string; is_live: boolean }>> {
  const res = await sqlite.execute(
    `SELECT b.login, b.display_name, b.is_live FROM broadcasters b
     WHERE b.connected = 1 AND b.broadcaster_id != ?
       AND NOT EXISTS (SELECT 1 FROM channel_blocks k WHERE k.broadcaster_id = b.broadcaster_id)
       AND NOT EXISTS (SELECT 1 FROM command_toggles t WHERE t.broadcaster_id = b.broadcaster_id AND t.group_name = 'showcase' AND t.enabled = 0)
     ORDER BY b.display_name COLLATE NOCASE`,
    [excludeId],
  );
  return res.rows
    .filter((r: any) => r.login)
    .map((r: any) => ({ login: String(r.login), display_name: String(r.display_name || r.login), is_live: Number(r.is_live) === 1 }));
}

// Lets operator-only routes (e.g. /admin/dashboard-link) accept a Twitch
// login instead of the numeric broadcaster_id, since that's what a human
// actually has memorized.
export async function getBroadcasterByLogin(login: string) {
  const res = await sqlite.execute(
    "SELECT * FROM broadcasters WHERE login = ? COLLATE NOCASE",
    [login],
  );
  return res.rows.length ? res.rows[0] : null;
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
    "merchant_listings",
    "command_toggles",
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
    "battle_log",
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
    await sqlite.execute("DELETE FROM merchant_listings WHERE broadcaster_id = ?", [broadcasterId]);
    await sqlite.execute("DELETE FROM command_toggles WHERE broadcaster_id = ?", [broadcasterId]);
    await sqlite.execute("DELETE FROM chronicle_settings WHERE broadcaster_id = ?", [broadcasterId]);
    await sqlite.execute("DELETE FROM npc_settings WHERE broadcaster_id = ?", [broadcasterId]);
    await sqlite.execute("DELETE FROM npc_chatter_settings WHERE broadcaster_id = ?", [broadcasterId]);
    await sqlite.execute("DELETE FROM eventsub_extra_subscriptions WHERE broadcaster_id = ?", [broadcasterId]);
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

/** All command-group states for the dashboard's toggle list, defaulting any
 * group with no row (never touched) to enabled. */
export async function getCommandGroupToggles(broadcasterId: string): Promise<Record<string, boolean>> {
  const res = await sqlite.execute("SELECT group_name, enabled FROM command_toggles WHERE broadcaster_id = ?", [broadcasterId]);
  const overrides = new Map<string, boolean>(res.rows.map((r: any) => [String(r.group_name), Number(r.enabled) === 1]));
  const out: Record<string, boolean> = {};
  for (const [group, def] of Object.entries(COMMAND_GROUPS)) {
    // Never switched since the split? Inherit the older group it came from.
    out[group] = overrides.get(group) ?? (def.parent ? overrides.get(def.parent) : undefined) ?? true;
  }
  return out;
}

export async function isCommandGroupEnabled(broadcasterId: string, group: string): Promise<boolean> {
  // A group split out of an older, coarser one (COMMAND_GROUPS[..].parent)
  // falls back to that parent's saved state until it is switched itself.
  const parent = COMMAND_GROUPS[group]?.parent;
  const names = parent ? [group, parent] : [group];
  const res = await sqlite.execute(
    `SELECT group_name, enabled FROM command_toggles WHERE broadcaster_id = ? AND group_name IN (${names.map(() => "?").join(",")})`,
    [broadcasterId, ...names],
  );
  const row = res.rows.find((r: any) => String(r.group_name) === group) ??
    res.rows.find((r: any) => String(r.group_name) === parent);
  return !row || Number(row.enabled) === 1;
}

export async function setCommandGroupEnabled(broadcasterId: string, group: string, enabled: boolean) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO command_toggles (broadcaster_id, group_name, enabled, updated_at) VALUES (?,?,?,?)",
    [broadcasterId, group, enabled ? 1 : 0, Date.now()],
  );
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

// ── Roster (web page + !roster) ──
// Read-only listings for the public GET /roster page (see renderRosterPage in
// pages.ts): every saved character in a channel, plus every party with its
// leader and members. Deliberately does NOT go through getCharacter(), which
// bumps channel_characters.updated_at — merely viewing the roster shouldn't
// count as character activity.

/** Every saved character in a channel, highest level first. */
export async function listChannelCharacters(broadcasterId: string, limit = 1000): Promise<Character[]> {
  const res = await sqlite.execute(
    "SELECT * FROM characters WHERE broadcaster_id = ? ORDER BY level DESC, xp DESC, username ASC LIMIT ?",
    [broadcasterId, limit],
  );
  return res.rows.map(rowToCharacter);
}

export interface PartyRosterEntry {
  party_name: string;
  owner: string;
  created_at: number;
  /** Usernames in join order (the leader is normally first). */
  members: string[];
}

/** Every party in a channel with its members, alphabetical by party name. */
export async function listChannelParties(broadcasterId: string): Promise<PartyRosterEntry[]> {
  const [parties, members] = await Promise.all([
    sqlite.execute(
      "SELECT party_name, owner, created_at FROM parties WHERE broadcaster_id = ? ORDER BY party_name ASC",
      [broadcasterId],
    ),
    sqlite.execute(
      "SELECT party_name, username FROM party_members WHERE broadcaster_id = ? ORDER BY joined_at ASC",
      [broadcasterId],
    ),
  ]);
  const byParty = new Map<string, string[]>();
  for (const m of members.rows as any[]) {
    const key = String(m.party_name);
    const list = byParty.get(key) ?? [];
    list.push(String(m.username));
    byParty.set(key, list);
  }
  return (parties.rows as any[]).map((p) => ({
    party_name: String(p.party_name),
    owner: String(p.owner ?? ""),
    created_at: Number(p.created_at ?? 0),
    members: byParty.get(String(p.party_name)) ?? [],
  }));
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

const lastActivityPrune = new Map<string, number>();

export async function recordActivity(username: string, broadcasterId: string, action: string, detail: string) {
  await sqlite.execute(
    "INSERT INTO activity_logs (username,broadcaster_id,action,detail,created_at) VALUES (?,?,?,?,?)",
    [username, broadcasterId, action.slice(0, 40), detail.replace(/\s+/g, " ").trim().slice(0, 220), Date.now()],
  );
  // Retain at most 5,000 rows per channel, plus a hard 90-day privacy window.
  // The trim scans the channel's newest 5,000 ids, so do it at most every
  // few minutes per channel per isolate rather than on every command.
  const now = Date.now();
  if (now - (lastActivityPrune.get(broadcasterId) ?? 0) < 5 * 60_000) return;
  lastActivityPrune.set(broadcasterId, now);
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

let lastEventSubPrune = 0;
export async function claimEventSubMessage(messageId: string, now = Date.now()) {
  if (!messageId) return false;
  try {
    await sqlite.execute("INSERT INTO eventsub_messages (message_id,received_at) VALUES (?,?)", [messageId, now]);
    // Pruning old rows doesn't need to happen on every message — at most
    // once a minute per isolate is plenty and saves a round-trip per event.
    if (now - lastEventSubPrune > 60_000) {
      lastEventSubPrune = now;
      sqlite.execute("DELETE FROM eventsub_messages WHERE received_at < ?", [now - 24 * 60 * 60 * 1000]).catch(() => {});
    }
    return true;
  } catch (_) {
    return false;
  }
}

let lastRateLimitPrune = 0;
export async function checkCommandRateLimit(broadcasterId: string, username: string, cooldownMs = 1200) {
  const now = Date.now();
  // One round-trip: stamp the use only if the cooldown has passed, and read
  // back whether it did (RETURNING yields no row when the WHERE blocks it).
  const res = await sqlite.execute(
    `INSERT INTO command_rate_limits (broadcaster_id,username,last_at) VALUES (?,?,?)
     ON CONFLICT(broadcaster_id,username) DO UPDATE SET last_at = excluded.last_at
     WHERE excluded.last_at - command_rate_limits.last_at >= ?
     RETURNING last_at`,
    [broadcasterId, username, now, cooldownMs],
  );
  if (!res.rows.length) return false;
  // Throttled prune (see claimEventSubMessage) — not needed on every command.
  if (now - lastRateLimitPrune > 60_000) {
    lastRateLimitPrune = now;
    sqlite.execute("DELETE FROM command_rate_limits WHERE last_at < ?", [now - 10 * 60 * 1000]).catch(() => {});
  }
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

// ── Web dashboard capability token (see dashboard.ts) ──

export async function getDashboardKey(broadcasterId: string): Promise<string | null> {
  const broadcaster = await getBroadcaster(broadcasterId);
  return broadcaster?.dashboard_key ? String(broadcaster.dashboard_key) : null;
}

/** Returns the channel's existing dashboard key, minting one on first use. */
export async function getOrCreateDashboardKey(broadcasterId: string): Promise<string> {
  const existing = await getDashboardKey(broadcasterId);
  if (existing) return existing;
  return await regenerateDashboardKey(broadcasterId);
}

/** Invalidates any previously shared dashboard link (e.g. leaked in chat/VOD) and issues a fresh key. */
export async function regenerateDashboardKey(broadcasterId: string): Promise<string> {
  const key = crypto.randomUUID().replace(/-/g, "");
  await sqlite.execute("UPDATE broadcasters SET dashboard_key = ? WHERE broadcaster_id = ?", [key, broadcasterId]);
  return key;
}

/** True only for a connected channel whose current dashboard key matches. */
export async function verifyDashboardKey(broadcasterId: string, key: string): Promise<boolean> {
  if (!key || key.length < 20) return false;
  const broadcaster = await getBroadcaster(broadcasterId);
  if (!broadcaster || Number(broadcaster.connected) !== 1) return false;
  return !!broadcaster.dashboard_key && String(broadcaster.dashboard_key) === key;
}

// ── Dashboard "log in with Twitch" OAuth state (see dashboard.ts) ──

export async function saveDashboardOAuthState(state: string, channelId: string, dashboardKey: string, expiresAt: number) {
  await sqlite.execute(
    "INSERT INTO dashboard_oauth_states (state, channel_id, dashboard_key, expires_at) VALUES (?,?,?,?)",
    [state, channelId, dashboardKey, expiresAt],
  );
}

/** One-time read: returns the state row (if valid and unexpired) and always
 * deletes it, so a state value can never be replayed. */
export async function consumeDashboardOAuthState(state: string) {
  const res = await sqlite.execute(
    "SELECT * FROM dashboard_oauth_states WHERE state = ? AND expires_at > ?",
    [state, Date.now()],
  );
  await sqlite.execute("DELETE FROM dashboard_oauth_states WHERE state = ?", [state]);
  return res.rows.length ? res.rows[0] : null;
}

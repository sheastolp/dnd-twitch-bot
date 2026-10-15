// Spam filters — the everyday side of moderation, next to autoban.ts's
// permanent bans for viewer-bot ads. Where auto-ban is a trapdoor, these are
// the tavern bouncer: a message that breaks one of the channel's filters is
// removed, and the chatter climbs a strike ladder (warn → timeouts → optionally
// a ban) that resets after a quiet spell.
//
//   links    any URL or domain ("grow dot com" too), unless the domain is on
//            the channel's allow list or a mod gave the chatter a !permit
//   caps     mostly CAPITAL LETTERS (emotes don't count)
//   symbols  walls of punctuation / emoji (░▒▓ ascii art, ‼️‼️‼️)
//   emotes   more than N emotes in one message
//   repeats  one word or character over and over, or the same message sent
//            three times in a couple of minutes
//   length   messages longer than N characters
//
// Mods and the broadcaster are always exempt, as are auto-ban's ignored users
// (autoban_words.ts) and trusted channel bots (main.ts skips them). VIPs, and
// optionally subscribers, can be exempted too.
//
// Removing a message uses Helix Delete Chat Messages, which needs the
// moderator:manage:chat_messages scope. Channels that connected before it was
// requested fall back to a 1-second timeout, which also clears the message
// and only needs the ban scope auto-ban already uses — so nothing requires a
// reconnect. Timeouts and bans use Helix Ban User (moderator:manage:banned_users).
//
// Off by default per channel: !automod on|off|status, the dashboard switch, or
// /dashboard/autoban's "Spam filters" section, which also holds the settings
// and a log of recent actions.

import { sqlite } from "./sqlite.ts";
import { getValidAdToken } from "./ads.ts";
import { getBroadcasterAdToken } from "./ads_db.ts";
import { recordMonitorEvent } from "./db.ts";
import { banChatUser, deleteChatMessage, sendChatMessage } from "./twitch.ts";
import { BAN_SCOPE } from "./autoban.ts";
import { isUserIgnored, normalizeText, sanitizeLogin } from "./autoban_words.ts";

export const DELETE_SCOPE = "moderator:manage:chat_messages";

export type FilterKey = "links" | "caps" | "symbols" | "emotes" | "repeats" | "length";
export const FILTERS: Array<{ key: FilterKey; label: string; reason: string }> = [
  { key: "links", label: "Links", reason: "no links without a !permit" },
  { key: "caps", label: "Excessive caps", reason: "ease up on the caps" },
  { key: "symbols", label: "Symbol / emoji walls", reason: "no symbol walls" },
  { key: "emotes", label: "Emote floods", reason: "too many emotes" },
  { key: "repeats", label: "Repetition & copy-paste", reason: "no spamming the same thing" },
  { key: "length", label: "Very long messages", reason: "message too long" },
];

/** Who besides mods skips the filters: VIPs, VIPs + subscribers, or nobody. */
export type Exempt = "vip" | "sub" | "none";

/** One rung of the strike ladder: delete + warn, a timeout in seconds, or a permanent ban. */
export type Step = "warn" | "ban" | number;

export interface AutoModConfig {
  filters: Record<FilterKey, boolean>;
  capsPct: number;
  capsMin: number;
  symbolPct: number;
  emoteMax: number;
  lengthMax: number;
  exempt: Exempt;
  ladder: Step[];
  /** Minutes without an offense after which a chatter's strikes reset. */
  strikeMemoryMin: number;
  allowDomains: string[];
  /** Post a short notice in chat (only while live, throttled). */
  announce: boolean;
}

export const DEFAULT_CONFIG: AutoModConfig = {
  filters: { links: true, caps: true, symbols: true, emotes: false, repeats: true, length: false },
  capsPct: 70,
  capsMin: 15,
  symbolPct: 50,
  emoteMax: 15,
  lengthMax: 400,
  exempt: "vip",
  ladder: ["warn", 60, 600],
  strikeMemoryMin: 60,
  allowDomains: ["clips.twitch.tv", "twitch.tv"],
  announce: true,
};

/** Twitch's longest timeout (two weeks). */
const MAX_TIMEOUT_S = 1_209_600;
const MAX_LADDER = 6;
const MAX_ALLOW = 50;
export const PERMIT_DEFAULT_S = 60;
const PERMIT_MAX_S = 600;
const LOG_KEEP = 200;

// Bounds for the dashboard's number boxes.
export const LIMITS = {
  capsPct: [30, 100],
  capsMin: [5, 200],
  symbolPct: [20, 100],
  emoteMax: [3, 100],
  lengthMax: [100, 500],
  strikeMemoryMin: [5, 1440],
} as const;

// ── Persistence ──

export async function ensureAutoModTables() {
  await sqlite.batch([
    `CREATE TABLE IF NOT EXISTS automod_settings (
      broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS automod_strikes (
      broadcaster_id TEXT NOT NULL, user_id TEXT NOT NULL, login TEXT NOT NULL DEFAULT '', strikes INTEGER NOT NULL,
      last_at INTEGER NOT NULL, PRIMARY KEY (broadcaster_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS automod_permits (
      broadcaster_id TEXT NOT NULL, login TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (broadcaster_id, login)
    )`,
    `CREATE TABLE IF NOT EXISTS automod_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, broadcaster_id TEXT NOT NULL, at INTEGER NOT NULL, login TEXT NOT NULL,
      filter TEXT NOT NULL, action TEXT NOT NULL, message TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS automod_log_channel ON automod_log (broadcaster_id, id)`,
  ]);
}

export async function purgeAutoModData(broadcasterId: string) {
  await sqlite.batch([
    { sql: "DELETE FROM automod_settings WHERE broadcaster_id = ?", args: [broadcasterId] },
    { sql: "DELETE FROM automod_strikes WHERE broadcaster_id = ?", args: [broadcasterId] },
    { sql: "DELETE FROM automod_permits WHERE broadcaster_id = ?", args: [broadcasterId] },
    { sql: "DELETE FROM automod_log WHERE broadcaster_id = ?", args: [broadcasterId] },
  ]);
  settingsCache.delete(broadcasterId);
}

const clampInt = (v: unknown, [lo, hi]: readonly [number, number], dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** Fills in defaults and clamps a stored (or submitted) config. */
export function sanitizeConfig(raw: any): AutoModConfig {
  const c = raw && typeof raw === "object" ? raw : {};
  const filters = { ...DEFAULT_CONFIG.filters };
  for (const f of FILTERS) if (typeof c.filters?.[f.key] === "boolean") filters[f.key] = c.filters[f.key];
  const ladder = Array.isArray(c.ladder)
    ? c.ladder.filter((s: unknown) => s === "warn" || s === "ban" || (typeof s === "number" && s >= 1 && s <= MAX_TIMEOUT_S)).slice(0, MAX_LADDER)
    : [];
  const allow: string[] | null = Array.isArray(c.allowDomains) ? c.allowDomains.map(sanitizeDomain).filter((d: string | null): d is string => !!d) : null;
  return {
    filters,
    capsPct: clampInt(c.capsPct, LIMITS.capsPct, DEFAULT_CONFIG.capsPct),
    capsMin: clampInt(c.capsMin, LIMITS.capsMin, DEFAULT_CONFIG.capsMin),
    symbolPct: clampInt(c.symbolPct, LIMITS.symbolPct, DEFAULT_CONFIG.symbolPct),
    emoteMax: clampInt(c.emoteMax, LIMITS.emoteMax, DEFAULT_CONFIG.emoteMax),
    lengthMax: clampInt(c.lengthMax, LIMITS.lengthMax, DEFAULT_CONFIG.lengthMax),
    exempt: c.exempt === "sub" || c.exempt === "none" ? c.exempt : "vip",
    ladder: ladder.length ? ladder : [...DEFAULT_CONFIG.ladder],
    strikeMemoryMin: clampInt(c.strikeMemoryMin, LIMITS.strikeMemoryMin, DEFAULT_CONFIG.strikeMemoryMin),
    allowDomains: allow ? [...new Set(allow)].slice(0, MAX_ALLOW) : [...DEFAULT_CONFIG.allowDomains],
    announce: typeof c.announce === "boolean" ? c.announce : DEFAULT_CONFIG.announce,
  };
}

export function sanitizeDomain(raw: unknown): string | null {
  const d = String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && d.length <= 100 ? d : null;
}

// ── Ladder text ⇄ steps ("warn, 1m, 10m, ban") ──

const UNIT_S: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

export function parseLadder(text: string): { ok: true; ladder: Step[] } | { ok: false; error: string } {
  const parts = text.split(/[,>→\s]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return { ok: false, error: "The strike ladder needs at least one step." };
  if (parts.length > MAX_LADDER) return { ok: false, error: `The strike ladder can have at most ${MAX_LADDER} steps.` };
  const ladder: Step[] = [];
  for (const p of parts) {
    if (p === "warn" || p === "warning" || p === "delete") ladder.push("warn");
    else if (p === "ban") ladder.push("ban");
    else {
      const m = p.match(/^(\d+)([smhdw]?)$/);
      if (!m) return { ok: false, error: `"${p}" isn't a step — use warn, ban, or a timeout like 30s, 10m, 1h, 1d.` };
      const secs = parseInt(m[1], 10) * UNIT_S[m[2] || "s"];
      if (secs < 1 || secs > MAX_TIMEOUT_S) return { ok: false, error: `Timeouts must be between 1s and 2 weeks ("${p}").` };
      ladder.push(secs);
    }
  }
  return { ok: true, ladder };
}

export function formatSeconds(s: number): string {
  for (const [u, n] of [["w", 604800], ["d", 86400], ["h", 3600], ["m", 60]] as const) {
    if (s >= n && s % n === 0) return `${s / n}${u}`;
  }
  return `${s}s`;
}

export const formatStep = (s: Step) => (typeof s === "number" ? formatSeconds(s) : s);
export const formatLadder = (l: Step[]) => l.map(formatStep).join(", ");

// ── Settings ──

const SETTINGS_TTL_MS = 30_000;
const settingsCache = new Map<string, { enabled: boolean; config: AutoModConfig; at: number }>();

export async function getAutoModSettings(broadcasterId: string): Promise<{ enabled: boolean; config: AutoModConfig }> {
  const hit = settingsCache.get(broadcasterId);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit;
  const res = await sqlite.execute("SELECT enabled, config FROM automod_settings WHERE broadcaster_id = ?", [broadcasterId]);
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(String(res.rows[0]?.config ?? "{}"));
  } catch { /* fall back to defaults */ }
  const entry = { enabled: Number(res.rows[0]?.enabled ?? 0) === 1, config: sanitizeConfig(parsed), at: Date.now() };
  settingsCache.set(broadcasterId, entry);
  return entry;
}

export async function isAutoModEnabled(broadcasterId: string) {
  return (await getAutoModSettings(broadcasterId)).enabled;
}

export async function setAutoModEnabled(broadcasterId: string, enabled: boolean) {
  await sqlite.execute(
    `INSERT INTO automod_settings (broadcaster_id, enabled, config, updated_at) VALUES (?,?,'{}',?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    [broadcasterId, enabled ? 1 : 0, Date.now()],
  );
  settingsCache.delete(broadcasterId);
}

export async function saveAutoModConfig(broadcasterId: string, config: AutoModConfig) {
  await sqlite.execute(
    `INSERT INTO automod_settings (broadcaster_id, enabled, config, updated_at) VALUES (?,0,?,?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    [broadcasterId, JSON.stringify(sanitizeConfig(config)), Date.now()],
  );
  settingsCache.delete(broadcasterId);
}

// ── Detection (pure — see automod_test.ts) ──

export interface Fragment {
  type?: string;
  text?: string;
}

// Generous TLD list: unlike auto-ban's learner, the link filter wants every
// link, not just the ones spam bots favour.
const TLDS =
  "com|net|org|io|gg|tv|co|me|ly|be|xyz|shop|store|site|online|live|pro|top|ru|cc|info|biz|app|link|click|dev|ai|us|uk|ca|de|fr|nl|eu|fm|to|sh|club|gl|gd|vip|win|bio|page|social|art|fun|lol|one|tk|ml|ga|cf|cn|in|jp|kr|br|es|it|pl|se|no|au|nz|ws";
const URL_RE = /\bhttps?:\/\/([^\s/?#]+)/g;
const BARE_DOMAIN_RE = new RegExp(`(?:^|[^a-z0-9@.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS}))(?![a-z0-9-])(?:[/:?#]\\S*)?`, "g");

/** Every domain linked in a message ("www.", "dot com" and http(s):// all count). */
export function findLinks(message: string): string[] {
  const text = normalizeText(message);
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const host = m[1].replace(/^www\./, "").replace(/:\d+$/, "");
    if (host.includes(".")) out.add(host);
  }
  for (const m of text.matchAll(BARE_DOMAIN_RE)) out.add(m[1].replace(/^www\./, ""));
  return [...out];
}

export function isAllowedDomain(domain: string, allow: string[]): boolean {
  return allow.some((a) => domain === a || domain.endsWith(`.${a}`));
}

/** The message with emote text removed (emote codes like LUL / PogChamp aren't shouting). */
function textWithoutEmotes(message: string, fragments?: Fragment[]): string {
  if (!fragments?.length) return message;
  return fragments.filter((f) => f.type !== "emote").map((f) => f.text ?? "").join("");
}

/** Messages a chatter sent recently, for the "same message three times" check. Per process. */
const lastMessages = new Map<string, { text: string; count: number; firstAt: number }>();
const REPEAT_WINDOW_MS = 2 * 60_000;
const REPEAT_COUNT = 3;

export function repeatKey(message: string): string {
  return normalizeText(message).replace(/@\w+/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Records the message and returns how many times in a row (within the window) the chatter sent it. */
export function trackRepeat(channelUser: string, message: string, now = Date.now()): number {
  const text = repeatKey(message);
  const prev = lastMessages.get(channelUser);
  const count = prev && prev.text === text && now - prev.firstAt < REPEAT_WINDOW_MS ? prev.count + 1 : 1;
  lastMessages.set(channelUser, { text, count, firstAt: count === 1 ? now : prev!.firstAt });
  if (lastMessages.size > 5000) {
    for (const [k, v] of lastMessages) if (now - v.firstAt > REPEAT_WINDOW_MS) lastMessages.delete(k);
  }
  return count;
}

/** One word or character over and over inside a single message. */
export function isRepetitive(message: string): boolean {
  if (/(.)\1{24,}/u.test(message.replace(/\s+/g, ""))) return true;
  const words = normalizeText(message).split(" ").filter(Boolean);
  if (words.length < 10) return false;
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return top >= 10 && top / words.length >= 0.6;
}

export interface CheckInput {
  message: string;
  fragments?: Fragment[];
  /** Times in a row this chatter has now sent this message (trackRepeat). */
  repeatCount?: number;
  permitted?: boolean;
}

/** The first filter the message breaks, or null. Pure: no DB, no Twitch. */
export function checkMessage(cfg: AutoModConfig, input: CheckInput): { filter: FilterKey; detail: string } | null {
  const { message, fragments } = input;
  const f = cfg.filters;
  if (f.links && !input.permitted) {
    const bad = findLinks(message).filter((d) => !isAllowedDomain(d, cfg.allowDomains));
    if (bad.length) return { filter: "links", detail: bad[0] };
  }
  if (f.length && [...message].length > cfg.lengthMax) return { filter: "length", detail: `${[...message].length} chars` };
  if (f.emotes && fragments) {
    const emotes = fragments.filter((x) => x.type === "emote").length;
    if (emotes > cfg.emoteMax) return { filter: "emotes", detail: `${emotes} emotes` };
  }
  const plain = textWithoutEmotes(message, fragments);
  if (f.caps) {
    const letters = [...plain].filter((ch) => ch.toLowerCase() !== ch.toUpperCase());
    const upper = letters.filter((ch) => ch === ch.toUpperCase()).length;
    if (letters.length >= cfg.capsMin && (upper * 100) / letters.length >= cfg.capsPct) {
      return { filter: "caps", detail: `${Math.round((upper * 100) / letters.length)}% caps` };
    }
  }
  if (f.symbols) {
    const chars = [...plain.replace(/\s+/g, "")];
    if (chars.length >= 15) {
      const sym = chars.filter((ch) => !/[\p{L}\p{N}]/u.test(ch)).length;
      if ((sym * 100) / chars.length >= cfg.symbolPct) return { filter: "symbols", detail: `${Math.round((sym * 100) / chars.length)}% symbols` };
    }
  }
  if (f.repeats) {
    if (isRepetitive(message)) return { filter: "repeats", detail: "repeated word/character" };
    if ((input.repeatCount ?? 0) >= REPEAT_COUNT) return { filter: "repeats", detail: `same message ${input.repeatCount}×` };
  }
  return null;
}

/** Whether the chatter's badges put them past the filters. */
export function isExempt(exempt: Exempt, badges: Array<{ set_id?: string }>): boolean {
  const ids = new Set(badges.map((b) => String(b?.set_id ?? "")));
  if (exempt === "none") return false;
  if (ids.has("vip")) return true;
  return exempt === "sub" && (ids.has("subscriber") || ids.has("founder"));
}

// ── Strikes ──

/** Adds a strike (after letting old ones lapse) and returns the new count. */
async function addStrike(broadcasterId: string, userId: string, login: string, memoryMin: number): Promise<number> {
  const now = Date.now();
  const res = await sqlite.execute("SELECT strikes, last_at FROM automod_strikes WHERE broadcaster_id = ? AND user_id = ?", [broadcasterId, userId]);
  const row = res.rows[0];
  const prev = row && now - Number(row.last_at) < memoryMin * 60_000 ? Number(row.strikes) : 0;
  const strikes = prev + 1;
  await sqlite.execute(
    "INSERT OR REPLACE INTO automod_strikes (broadcaster_id, user_id, login, strikes, last_at) VALUES (?,?,?,?,?)",
    [broadcasterId, userId, login.toLowerCase(), strikes, now],
  );
  return strikes;
}

/** Wipes a chatter's strikes by login. Returns whether they had any. */
export async function clearStrikes(broadcasterId: string, login: string): Promise<boolean> {
  const res = await sqlite.execute("DELETE FROM automod_strikes WHERE broadcaster_id = ? AND login = ?", [broadcasterId, login.toLowerCase()]);
  return res.rowsAffected > 0;
}

/** The ladder step for the nth strike (the last step repeats). */
export function stepFor(ladder: Step[], strikes: number): Step {
  return ladder[Math.min(strikes, ladder.length) - 1];
}

// ── Permits ──

export async function grantPermit(broadcasterId: string, login: string, seconds: number) {
  await sqlite.batch([
    { sql: "DELETE FROM automod_permits WHERE broadcaster_id = ? AND expires_at < ?", args: [broadcasterId, Date.now()] },
    {
      sql: "INSERT OR REPLACE INTO automod_permits (broadcaster_id, login, expires_at) VALUES (?,?,?)",
      args: [broadcasterId, login.toLowerCase(), Date.now() + seconds * 1000],
    },
  ]);
}

async function hasPermit(broadcasterId: string, login: string): Promise<boolean> {
  const res = await sqlite.execute(
    "SELECT 1 FROM automod_permits WHERE broadcaster_id = ? AND login = ? AND expires_at >= ?",
    [broadcasterId, login.toLowerCase(), Date.now()],
  );
  return res.rows.length > 0;
}

// ── Log ──

export interface AutoModLogEntry {
  at: number;
  login: string;
  filter: string;
  action: string;
  message: string;
}

async function logAction(broadcasterId: string, e: Omit<AutoModLogEntry, "at">) {
  await sqlite.batch([
    {
      sql: "INSERT INTO automod_log (broadcaster_id, at, login, filter, action, message) VALUES (?,?,?,?,?,?)",
      args: [broadcasterId, Date.now(), e.login, e.filter, e.action, e.message.slice(0, 200)],
    },
    {
      sql: `DELETE FROM automod_log WHERE broadcaster_id = ? AND id <= (
              SELECT id FROM automod_log WHERE broadcaster_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      args: [broadcasterId, broadcasterId, LOG_KEEP],
    },
  ]);
}

export async function listAutoModLog(broadcasterId: string, limit = 50): Promise<AutoModLogEntry[]> {
  const res = await sqlite.execute(
    "SELECT at, login, filter, action, message FROM automod_log WHERE broadcaster_id = ? ORDER BY id DESC LIMIT ?",
    [broadcasterId, limit],
  );
  return res.rows.map((r: any) => ({ at: Number(r.at), login: String(r.login), filter: String(r.filter), action: String(r.action), message: String(r.message) }));
}

// ── Token ──

type ModToken = { token: string; canDelete: boolean } | { problem: "no_token" | "no_scope" };

async function getModToken(broadcasterId: string): Promise<ModToken> {
  const token = await getValidAdToken(broadcasterId);
  if (!token) return { problem: "no_token" };
  const scopes = new Set(String((await getBroadcasterAdToken(broadcasterId))?.scope ?? "").split(/\s+/));
  if (!scopes.has(BAN_SCOPE)) return { problem: "no_scope" };
  return { token, canDelete: scopes.has(DELETE_SCOPE) };
}

/** Whether the stored token can delete single messages (else a 1 s timeout stands in). */
export async function hasDeletePermission(broadcasterId: string): Promise<boolean> {
  return String((await getBroadcasterAdToken(broadcasterId))?.scope ?? "").split(/\s+/).includes(DELETE_SCOPE);
}

// ── Chat notices (throttled so a raid of caps can't make the bot the spammer) ──

const NOTICE_USER_MS = 30_000;
const NOTICE_CHANNEL_MS = 5_000;
const lastNoticeAt = new Map<string, number>();

function mayNotice(broadcasterId: string, userId: string): boolean {
  const now = Date.now();
  const u = `${broadcasterId}:${userId}`;
  if (now - (lastNoticeAt.get(u) ?? 0) < NOTICE_USER_MS || now - (lastNoticeAt.get(broadcasterId) ?? 0) < NOTICE_CHANNEL_MS) return false;
  lastNoticeAt.set(u, now);
  lastNoticeAt.set(broadcasterId, now);
  return true;
}

function noticeText(display: string, reason: string, step: Step, strikes: number, ladderLen: number): string {
  if (step === "warn") return `🛡️ @${display} ${reason} — the scribe struck that from the record (warning ${strikes}/${ladderLen}).`;
  if (step === "ban") return `🔨 ${display} ignored the warnings (${reason}) and has been banished from the guild hall.`;
  return `⏳ @${display} ${reason} — cooling your heels in the stocks for ${formatSeconds(step)}.`;
}

// ── Chat hook ──

export interface AutoModEvent {
  message: string;
  messageId: string;
  fragments?: Fragment[];
  badges: Array<{ set_id?: string }>;
}

/** Applies the channel's spam filters to a non-mod message. Returns true if
 * the message was acted on (so the caller skips commands and chat rewards). */
export async function maybeAutoMod(
  ev: AutoModEvent,
  display: string,
  chatterLogin: string,
  chatterId: string,
  broadcasterId: string,
  isModerator: boolean,
  isLive: boolean,
): Promise<boolean> {
  if (isModerator || !chatterId || chatterId === broadcasterId) return false;
  const { enabled, config } = await getAutoModSettings(broadcasterId);
  if (!enabled || isExempt(config.exempt, ev.badges)) return false;
  // Commands repeat legitimately (!hunt, !d20 …), so they skip the copy-paste count.
  const repeatCount = ev.message.trim().startsWith("!") ? 0 : trackRepeat(`${broadcasterId}:${chatterId}`, ev.message);
  // Links are the only filter a permit lifts; look one up only when there's a link to judge.
  const linked = config.filters.links && findLinks(ev.message).some((d) => !isAllowedDomain(d, config.allowDomains));
  const permitted = linked && await hasPermit(broadcasterId, chatterLogin);
  const hit = checkMessage(config, { message: ev.message, fragments: ev.fragments, repeatCount, permitted });
  if (!hit) return false;
  if (await isUserIgnored(broadcasterId, chatterLogin)) return false;

  const auth = await getModToken(broadcasterId);
  if ("problem" in auth) {
    await recordMonitorEvent("automod_no_permission", `${broadcasterId}: ${auth.problem}`);
    return false;
  }

  const strikes = await addStrike(broadcasterId, chatterId, chatterLogin, config.strikeMemoryMin);
  const step = stepFor(config.ladder, strikes);
  const reasonText = FILTERS.find((f) => f.key === hit!.filter)!.reason;
  const twitchReason = `Spam filter: ${reasonText} (${hit.detail}) — strike ${strikes} (GuildScribe)`;

  let result;
  let action: string;
  if (step === "warn") {
    if (auth.canDelete && ev.messageId) {
      result = await deleteChatMessage(auth.token, broadcasterId, broadcasterId, ev.messageId);
      action = "deleted + warned";
    } else {
      result = await banChatUser(auth.token, broadcasterId, broadcasterId, chatterId, twitchReason, 1);
      action = "purged (1s timeout) + warned";
    }
  } else if (step === "ban") {
    result = await banChatUser(auth.token, broadcasterId, broadcasterId, chatterId, twitchReason);
    action = "banned";
  } else {
    result = await banChatUser(auth.token, broadcasterId, broadcasterId, chatterId, twitchReason, step);
    action = `timed out ${formatSeconds(step)}`;
  }

  if (!result.ok) {
    // 400: Twitch won't act on this target (a mod/VIP Twitch protects, already banned…).
    await recordMonitorEvent(result.status === 400 ? "automod_skipped" : "automod_failed", `${broadcasterId}: ${chatterId}: ${result.status} ${result.message}`);
    return result.status === 400;
  }

  await Promise.all([
    logAction(broadcasterId, { login: chatterLogin, filter: hit.filter, action: `${action} (strike ${strikes})`, message: ev.message }),
    recordMonitorEvent("automod", `${broadcasterId}: ${chatterId} ${hit.filter} → ${action}`),
  ]);
  if (config.announce && isLive && mayNotice(broadcasterId, chatterId)) {
    await sendChatMessage(noticeText(display, reasonText, step, strikes, config.ladder.length), broadcasterId);
  }
  return true;
}

// ── Commands ──

/** !automod on|off|status|pardon @user and !permit @user [seconds]. Returns true if handled. */
export async function handleAutoModCommand(
  chatMessage: string,
  display: string,
  isModerator: boolean,
  broadcasterId: string,
  baseUrl: string,
): Promise<boolean> {
  const text = chatMessage.trim();
  const permit = text.match(/^!permit(?:\s+@?(\S+))?(?:\s+(\d+)\s*s?)?\s*$/i);
  const am = text.match(/^!automod(?:\s+(on|off|status|pardon)(?:\s+@?(\S+))?)?\s*$/i);
  if (!permit && !am) return false;

  if (am && (!am[1] || am[1].toLowerCase() === "status")) {
    const { enabled, config } = await getAutoModSettings(broadcasterId);
    const on = FILTERS.filter((f) => config.filters[f.key]).map((f) => f.label.toLowerCase());
    await sendChatMessage(
      enabled
        ? `@${display} Spam filters are on: ${on.join(", ") || "none selected"}. Strike ladder: ${formatLadder(config.ladder)} (resets after ${config.strikeMemoryMin} min). Mods: !permit @user, !automod pardon @user — settings on !dashboard.`
        : `@${display} Spam filters are off in this channel. Mods can turn them on with !automod on and tune them from !dashboard.`,
      broadcasterId,
    );
    return true;
  }

  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can do that.`, broadcasterId);
    return true;
  }

  if (permit) {
    const login = sanitizeLogin(permit[1] ?? "");
    if (!login) {
      await sendChatMessage(`@${display} usage: !permit @user [seconds] — lets them post one link for ${PERMIT_DEFAULT_S}s by default.`, broadcasterId);
      return true;
    }
    const secs = Math.min(PERMIT_MAX_S, Math.max(10, permit[2] ? parseInt(permit[2], 10) : PERMIT_DEFAULT_S));
    await grantPermit(broadcasterId, login, secs);
    await sendChatMessage(`📜 @${login} may post links for the next ${secs}s — by writ of @${display}.`, broadcasterId);
    return true;
  }

  const action = am![1].toLowerCase();
  if (action === "pardon") {
    const login = sanitizeLogin(am![2] ?? "");
    if (!login) {
      await sendChatMessage(`@${display} usage: !automod pardon @user — clears their spam-filter strikes.`, broadcasterId);
      return true;
    }
    await sendChatMessage(
      (await clearStrikes(broadcasterId, login))
        ? `🕊️ @${login}'s strikes are wiped clean. (A timeout already given still runs.)`
        : `@${display} ${login} has no spam-filter strikes.`,
      broadcasterId,
    );
    return true;
  }

  const enable = action === "on";
  await setAutoModEnabled(broadcasterId, enable);
  if (!enable) {
    await sendChatMessage(`@${display} Spam filters are off. The bouncer takes the night off.`, broadcasterId);
    return true;
  }
  const auth = await getModToken(broadcasterId);
  await sendChatMessage(
    "problem" in auth
      ? `@${display} Spam filters are on, but I can't moderate yet — the broadcaster needs to reconnect at ${baseUrl}/connect and approve the moderation permissions.`
      : `@${display} Spam filters are on (${formatLadder((await getAutoModSettings(broadcasterId)).config.ladder)}). Tune them from !dashboard → 🔨 Auto-ban & spam filters.`,
    broadcasterId,
  );
  return true;
}

// GuildScribe — Sound alerts: the streamer's own sound clips, played on stream
// by chat, channel points or bits. An alternative to the SoundAlerts
// extension. Separate from Sound Bytes (soundbytes.ts): its own command,
// cooldown, switch and overlay, so either runs without the other.
//
//   !sfx <name>                     anyone (per clip: everyone / mods / nobody): play a clip from chat,
//                                   for its gold price if it has one (mods skip the price and the cooldown)
//   !sfx / !sfx list                anyone: list the clips
//   !sfx cooldown [<secs>|off]      the channel-wide gap between chat plays (mods set it)
//   !sfx test <name>                mod/broadcaster: play a clip on stream, free
//   channel points                  a clip linked to a reward (by its exact title) plays on every redemption
//   bits                            a cheer of at least a clip's bits that names it ("Cheer100 airhorn")
//                                   plays it; with no name, a cheer of exactly a clip's bits does
//   GET  /dashboard/sounds · POST /dashboard/sounds   upload and manage clips (dashboard key + mod login; dashboard.ts)
//   GET  /overlay?channel=<id|login>&panel=soundalerts the OBS source that plays them (renderSoundAlertsOverlay)
//   GET  /overlay/sound?channel=<id|login>&id=<n>      a clip's audio (the overlay and the dashboard's preview)
//   GET  /overlay/soundalerts?channel=<id|login>&after=<n>
//                                   the plays after <n> (the overlay polls it); &after=-1
//                                   (first poll) only answers the newest id, so nothing old replays
//
// Clips live in the database (sound_alerts, up to MAX_CLIPS per channel, each
// at most MAX_CLIP_BYTES), checked by their first bytes to be MP3, OGG, WAV,
// WebM or M4A — the type the browser is told comes from those bytes, never
// from the upload. A play is a row in sound_alert_plays that the overlay picks
// up within a couple of seconds; like alerts.ts, the overlay only plays rows
// newer than when it loaded and at most PLAY_FRESH_MS old, so an OBS source
// that reloads never replays a backlog. The overlay stops a clip after
// MAX_CLIP_SECONDS.
//
// Channel points and bits need nothing new from the streamer: the redemption
// (channel:read:redemptions) and cheer (bits:read) subscriptions are the ones
// !boon and the cheer alert already use. GuildScribe can't refund a reward it
// didn't create, so a redemption that can't play (switch off) is left for a
// mod to refund from the rewards queue, like !boon's.
//
// Dashboard switch "soundalerts" (off by default): off stops every play and
// blanks the overlay. A channel's own !sfx custom command wins.

import { sqlite } from "./sqlite.ts";
import { sendChatMessage } from "./twitch.ts";
import { getBroadcaster, getCustomCommand, isChannelBlocked, isChannelEnabled, isCommandGroupEnabled } from "./db.ts";
import { rewardKey } from "./redemptions_db.ts";
import { getBalance, isPointsEnabled, trySpend } from "./points_db.ts";
import { formatCoins, MAX_COPPER, parseCoins } from "./coins.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

export const MAX_CLIPS = 25;
export const MAX_CLIP_BYTES = 1024 * 1024;
/** The overlay stops a clip after this long. */
export const MAX_CLIP_SECONDS = 20;
const MAX_NAME = 25;
const MAX_TITLE = 40;
const MAX_REWARD_TITLE = 45; // Twitch's own reward-title limit
const MAX_BITS = 100_000;
/** A play older than this is never played (an OBS source that was closed doesn't replay). */
const PLAY_FRESH_MS = 2 * 60_000;
const PLAY_KEEP_MS = 24 * 60 * 60_000;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,24}$/;
/** Gap between chat plays, channel-wide, until a mod changes it. */
export const DEFAULT_COOLDOWN_SECONDS = 15;
const MAX_COOLDOWN_SECONDS = 600;
/** Words !sfx already uses for something else. */
const RESERVED = new Set(["list", "help", "cooldown", "cd", "test"]);

export type ChatAccess = "everyone" | "mods" | "none";
const CHAT_ACCESS: ChatAccess[] = ["everyone", "mods", "none"];

export type SoundClip = {
  id: number;
  name: string;
  title: string;
  volume: number;
  /** Gold price (copper) to play it from chat; 0 = free. */
  price: number;
  chat: ChatAccess;
  /** Channel-point reward title that plays it; "" = none. */
  reward: string;
  /** Fewest bits that play it; 0 = not by bits. */
  bits: number;
  size: number;
  plays: number;
};

export async function ensureSoundAlertTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS sound_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, broadcaster_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL,
      mime TEXT NOT NULL, audio BLOB NOT NULL, size INTEGER NOT NULL, volume INTEGER NOT NULL DEFAULT 100,
      price INTEGER NOT NULL DEFAULT 0, chat TEXT NOT NULL DEFAULT 'everyone', reward TEXT NOT NULL DEFAULT '',
      reward_key TEXT NOT NULL DEFAULT '', bits INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute("CREATE UNIQUE INDEX IF NOT EXISTS sound_alerts_name ON sound_alerts (broadcaster_id, name)");
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS sound_alert_plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT, broadcaster_id TEXT NOT NULL, sound_id INTEGER NOT NULL,
      who TEXT NOT NULL DEFAULT '', via TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute("CREATE INDEX IF NOT EXISTS sound_alert_plays_channel ON sound_alert_plays (broadcaster_id, id)");
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS sound_alert_settings (
      broadcaster_id TEXT PRIMARY KEY, cooldown_seconds INTEGER, last_played_at INTEGER
    )`,
  );
}

export async function purgeSoundAlertData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM sound_alerts WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM sound_alert_plays WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM sound_alert_settings WHERE broadcaster_id = ?", [broadcasterId]);
}

// ── Cooldown (chat plays only; channel points and bits are paid for) ───────

async function getCooldown(broadcasterId: string): Promise<{ cooldown: number; lastAt: number }> {
  const res = await sqlite.execute("SELECT cooldown_seconds, last_played_at FROM sound_alert_settings WHERE broadcaster_id = ?", [broadcasterId]);
  const r: any = res.rows[0];
  const cd = r?.cooldown_seconds;
  return { cooldown: cd === null || cd === undefined ? DEFAULT_COOLDOWN_SECONDS : Number(cd), lastAt: Number(r?.last_played_at ?? 0) };
}

/** Claims the channel's cooldown: true when a clip may play now. One UPDATE,
 * so two chatters firing at once can't both get through. */
async function claimCooldown(broadcasterId: string, cooldownSeconds: number, now = Date.now()): Promise<boolean> {
  await sqlite.execute("INSERT OR IGNORE INTO sound_alert_settings (broadcaster_id, cooldown_seconds, last_played_at) VALUES (?, NULL, 0)", [broadcasterId]);
  const res = await sqlite.execute(
    "UPDATE sound_alert_settings SET last_played_at = ? WHERE broadcaster_id = ? AND COALESCE(last_played_at, 0) <= ?",
    [now, broadcasterId, now - cooldownSeconds * 1000],
  );
  return Number(res.rowsAffected ?? 0) > 0;
}

async function stampPlayed(broadcasterId: string, now = Date.now()) {
  await sqlite.execute(
    `INSERT INTO sound_alert_settings (broadcaster_id, cooldown_seconds, last_played_at) VALUES (?, NULL, ?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET last_played_at = excluded.last_played_at`,
    [broadcasterId, now],
  );
}

async function setCooldown(broadcasterId: string, seconds: number) {
  await sqlite.execute(
    `INSERT INTO sound_alert_settings (broadcaster_id, cooldown_seconds, last_played_at) VALUES (?, ?, 0)
     ON CONFLICT(broadcaster_id) DO UPDATE SET cooldown_seconds = excluded.cooldown_seconds`,
    [broadcasterId, seconds],
  );
}

/** Takes the cooldown for a chat play (mods skip it): true when it may play
 * now; otherwise tells chat how long to wait. */
async function takeCooldown(broadcasterId: string, display: string, isModerator: boolean): Promise<boolean> {
  const { cooldown, lastAt } = await getCooldown(broadcasterId);
  if (isModerator || cooldown <= 0) {
    await stampPlayed(broadcasterId);
    return true;
  }
  if (await claimCooldown(broadcasterId, cooldown)) return true;
  const wait = Math.max(1, Math.ceil((lastAt + cooldown * 1000 - Date.now()) / 1000));
  await sendChatMessage(`@${display} the horns need a breather — next sound alert in ${wait}s.`, broadcasterId);
  return false;
}

const CLIP_COLUMNS = "id, name, title, volume, price, chat, reward, bits, size, plays";

// deno-lint-ignore no-explicit-any
function toClip(r: any): SoundClip {
  const chat = String(r.chat) as ChatAccess;
  return {
    id: Number(r.id),
    name: String(r.name),
    title: String(r.title),
    volume: Number(r.volume),
    price: Number(r.price),
    chat: CHAT_ACCESS.includes(chat) ? chat : "everyone",
    reward: String(r.reward),
    bits: Number(r.bits),
    size: Number(r.size),
    plays: Number(r.plays),
  };
}

export async function listClips(broadcasterId: string): Promise<SoundClip[]> {
  const res = await sqlite.execute(`SELECT ${CLIP_COLUMNS} FROM sound_alerts WHERE broadcaster_id = ? ORDER BY name`, [broadcasterId]);
  return res.rows.map(toClip);
}

async function clipByName(broadcasterId: string, name: string): Promise<SoundClip | null> {
  const res = await sqlite.execute(`SELECT ${CLIP_COLUMNS} FROM sound_alerts WHERE broadcaster_id = ? AND name = ?`, [broadcasterId, name.toLowerCase()]);
  return res.rows[0] ? toClip(res.rows[0]) : null;
}

/** A clip's audio for GET /overlay/sound. */
export async function getClipAudio(broadcasterId: string, id: number): Promise<{ mime: string; audio: Uint8Array<ArrayBuffer> } | null> {
  const res = await sqlite.execute("SELECT mime, audio FROM sound_alerts WHERE broadcaster_id = ? AND id = ?", [broadcasterId, id]);
  const r = res.rows[0] as any;
  return r ? { mime: String(r.mime), audio: r.audio as Uint8Array<ArrayBuffer> } : null;
}

/** The audio type from a file's first bytes, or null when it isn't one we play. */
export function sniffAudio(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length < 12) return null;
  if (ascii(0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "audio/webm";
  if (ascii(4, 8) === "ftyp") return "audio/mp4";
  return null;
}

/** Why a clip name can't be used, or null when it can. */
function badName(name: string): string | null {
  if (!NAME_RE.test(name)) return `"${name.slice(0, 30)}" can't be a sound name: use 2–${MAX_NAME} letters, numbers, - or _ (it's what chat types after !sfx).`;
  if (RESERVED.has(name)) return `"${name}" is one of !sfx's own words — pick another name.`;
  return null;
}

// ── Plays ───────────────────────────────────────────────────────────────────

export type PlayVia = "chat" | "points" | "bits" | "test";

/** Queues a clip for the channel's overlay. */
async function queuePlay(broadcasterId: string, clip: SoundClip, via: PlayVia, who: string, detail = "") {
  const now = Date.now();
  await sqlite.execute(
    "INSERT INTO sound_alert_plays (broadcaster_id, sound_id, who, via, detail, created_at) VALUES (?,?,?,?,?,?)",
    [broadcasterId, clip.id, who.slice(0, 40), via, detail.slice(0, 60), now],
  );
  await sqlite.execute("UPDATE sound_alerts SET plays = plays + 1 WHERE id = ?", [clip.id]);
  await sqlite.execute("DELETE FROM sound_alert_plays WHERE broadcaster_id = ? AND created_at < ?", [broadcasterId, now - PLAY_KEEP_MS]);
}

/** What the overlay's card says under the clip's title. */
function playLine(via: string, who: string, detail: string): string {
  const name = who || "An anonymous patron";
  switch (via) {
    case "points": return `${name} redeemed ${detail || "a reward"}`;
    case "bits": return `${name} cheered ${detail || "bits"}`;
    case "test": return "Testing, testing. Is this thing on?";
    default: return `${name} played it`;
  }
}

/** The overlay's poll. after < 0: just the newest id (nothing old is replayed). */
export async function getSoundPlaysAfter(broadcasterId: string, after: number) {
  if (after < 0) {
    const res = await sqlite.execute("SELECT MAX(id) AS last FROM sound_alert_plays WHERE broadcaster_id = ?", [broadcasterId]);
    return { last: Number(res.rows[0]?.last ?? 0), plays: [] };
  }
  const res = await sqlite.execute(
    `SELECT p.id, p.sound_id, p.who, p.via, p.detail, p.created_at, s.title, s.volume
     FROM sound_alert_plays p LEFT JOIN sound_alerts s ON s.id = p.sound_id AND s.broadcaster_id = p.broadcaster_id
     WHERE p.broadcaster_id = ? AND p.id > ? ORDER BY p.id LIMIT 10`,
    [broadcasterId, after],
  );
  const rows = res.rows as any[];
  const fresh = Date.now() - PLAY_FRESH_MS;
  const plays = rows
    .filter((r) => Number(r.created_at) >= fresh && r.title != null) // a clip deleted since: skipped
    .map((r) => ({
      id: Number(r.id),
      sound: Number(r.sound_id),
      title: String(r.title),
      volume: Number(r.volume),
      line: playLine(String(r.via), String(r.who), String(r.detail)),
    }));
  return { last: rows.length ? Number(rows[rows.length - 1].id) : after, plays };
}

/** Same gate as alerts.ts: connected, switched on, not blocked, and sound alerts on. */
async function channelTakesSounds(broadcasterId: string): Promise<boolean> {
  const b = await getBroadcaster(broadcasterId);
  if (!b || Number(b.connected) !== 1) return false;
  const [on, blocked, sounds] = await Promise.all([isChannelEnabled(broadcasterId), isChannelBlocked(broadcasterId), isCommandGroupEnabled(broadcasterId, "soundalerts")]);
  return on && !blocked && sounds;
}

// ── Channel points and bits (main.ts's EventSub handlers) ───────────────────

/** channel.channel_points_custom_reward_redemption.add: plays the clip linked to the reward, if any. */
// deno-lint-ignore no-explicit-any
export async function onSoundAlertRedemption(event: any) {
  const broadcasterId = String(event?.broadcaster_user_id ?? "");
  const title = String(event?.reward?.title ?? "");
  if (!broadcasterId || !title) return;
  const res = await sqlite.execute(`SELECT ${CLIP_COLUMNS} FROM sound_alerts WHERE broadcaster_id = ? AND reward_key = ? LIMIT 1`, [broadcasterId, rewardKey(title)]);
  if (!res.rows[0] || !(await channelTakesSounds(broadcasterId))) return;
  await queuePlay(broadcasterId, toClip(res.rows[0]), "points", String(event?.user_name ?? event?.user_login ?? ""), title);
}

/** Cheer emotes ("Cheer100", "Kappa50") are the bits themselves, not words. */
const stripCheermotes = (text: string) => text.replace(/(?:^|\s)[A-Za-z]+\d+(?=\s|$)/g, " ");

/** Which clip a cheer plays: the first clip it names that its bits cover, or
 * when it names no clip at all, the one clip priced at exactly its bits. */
export function clipForCheer(clips: SoundClip[], bits: number, message: string): SoundClip | null {
  const byBits = clips.filter((c) => c.bits > 0 && c.bits <= bits);
  const words = stripCheermotes(message).toLowerCase().split(/[^a-z0-9_-]+/);
  for (const word of words) {
    const hit = byBits.find((c) => c.name === word);
    if (hit) return hit;
  }
  // Named a clip it can't pay for (or one not played by bits): play nothing rather than a different one.
  if (words.some((w) => clips.some((c) => c.name === w))) return null;
  const exact = byBits.filter((c) => c.bits === bits);
  return exact.length === 1 ? exact[0] : null;
}

/** channel.cheer: plays the clip the cheer pays for, if any. */
// deno-lint-ignore no-explicit-any
export async function onSoundAlertCheer(event: any) {
  const broadcasterId = String(event?.broadcaster_user_id ?? "");
  const bits = Number(event?.bits ?? 0);
  if (!broadcasterId || !(bits > 0) || !(await channelTakesSounds(broadcasterId))) return;
  const clip = clipForCheer(await listClips(broadcasterId), bits, String(event?.message ?? ""));
  if (!clip) return;
  const who = event?.is_anonymous ? "" : String(event?.user_name ?? event?.user_login ?? "");
  await queuePlay(broadcasterId, clip, "bits", who, `${bits.toLocaleString("en-US")} bit${bits === 1 ? "" : "s"}`);
}

// ── Chat ────────────────────────────────────────────────────────────────────

const MAX_CHAT = 480;
const fit = (text: string) => text.length <= MAX_CHAT ? text : `${text.slice(0, MAX_CHAT - 1)}…`;

export async function handleSoundAlertCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const match = chatMessage.match(/^!sfx(?:\s+([\s\S]*))?$/i);
  if (!match) return false;
  const [on, custom] = await Promise.all([
    isCommandGroupEnabled(broadcasterId, "soundalerts"),
    getCustomCommand(broadcasterId, "sfx"),
  ]);
  // The channel's own !sfx wins; switched off, only mods hear why.
  if (custom) return false;
  if (!on) {
    if (isModerator) await sendChatMessage(`@${display} sound alerts are switched off — turn them on with !feature soundalerts on.`, broadcasterId);
    return true;
  }
  const arg = (match[1] ?? "").trim();

  if (!arg || /^(list|help)$/i.test(arg)) {
    const clips = await listClips(broadcasterId);
    const inChat = clips.filter((c) => c.chat === "everyone" || (c.chat === "mods" && isModerator));
    const paid = clips.filter((c) => c.reward || c.bits);
    const parts = [
      inChat.length ? `!sfx <name>: ${inChat.map((c) => `${c.name}${c.price ? ` (${formatCoins(c.price)})` : ""}`).join(" | ")}` : "",
      paid.length ? `Channel points & bits: ${paid.map((c) => `${c.title}${c.bits ? ` (${c.bits} bits)` : ""}`).join(" | ")}` : "",
    ].filter(Boolean);
    await sendChatMessage(fit(`@${display} 📯 ${parts.length ? parts.join(" · ") : "No sound alerts yet — the streamer adds them on the dashboard."}`), broadcasterId);
    return true;
  }

  const cd = arg.match(/^(?:cooldown|cd)(?:\s+(\S+))?$/i);
  if (cd) {
    if (!cd[1]) {
      const { cooldown } = await getCooldown(broadcasterId);
      await sendChatMessage(`@${display} 📯 Sound alert cooldown: ${cooldown ? `${cooldown}s between chat plays for the whole channel` : "off"}.${isModerator ? " Change it with !sfx cooldown <seconds|off>." : ""}`, broadcasterId);
      return true;
    }
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a mod can change the sound alert cooldown.`, broadcasterId);
      return true;
    }
    const raw = cd[1].toLowerCase();
    const secs = raw === "off" ? 0 : Number(raw.replace(/s$/, ""));
    if (!Number.isInteger(secs) || secs < 0 || secs > MAX_COOLDOWN_SECONDS) {
      await sendChatMessage(`@${display} usage: !sfx cooldown <0-${MAX_COOLDOWN_SECONDS} seconds|off>.`, broadcasterId);
      return true;
    }
    await setCooldown(broadcasterId, secs);
    await sendChatMessage(`@${display} 📯 Sound alert cooldown ${secs ? `set to ${secs}s` : "turned off"}.`, broadcasterId);
    return true;
  }

  const test = arg.match(/^test\s+(\S+)/i);
  if (test && isModerator) {
    const clip = await clipByName(broadcasterId, test[1]);
    if (!clip) {
      await sendChatMessage(`@${display} no sound alert called "${test[1].slice(0, 30)}".`, broadcasterId);
      return true;
    }
    await queuePlay(broadcasterId, clip, "test", display);
    await sendChatMessage(`@${display} 📯 Testing "${clip.title}" on the overlay.`, broadcasterId);
    return true;
  }

  const word = arg.split(/\s+/)[0].toLowerCase();
  const clip = await clipByName(broadcasterId, word);
  if (!clip) {
    await sendChatMessage(`@${display} no sound alert by that name — !sfx lists them.`, broadcasterId);
    return true;
  }
  if (clip.chat === "none" || (clip.chat === "mods" && !isModerator)) {
    const how = [clip.reward ? `the "${clip.reward}" reward` : "", clip.bits ? `a cheer of ${clip.bits}+ bits naming it` : ""].filter(Boolean).join(" or ");
    await sendChatMessage(`@${display} "${clip.title}" ${clip.chat === "mods" ? "is for mods in chat" : "can't be played from chat"}${how ? ` — it plays with ${how}` : ""}.`, broadcasterId);
    return true;
  }
  // A price only counts while gold is on; mods play for free.
  const price = !isModerator && clip.price > 0 && await isPointsEnabled(broadcasterId) ? clip.price : 0;
  if (price) {
    const have = (await getBalance(broadcasterId, chatter))?.balance ?? 0;
    if (have < price) {
      await sendChatMessage(`@${display} "${clip.title}" costs ${formatCoins(price)} — you have ${formatCoins(have)}.`, broadcasterId);
      return true;
    }
  }
  if (!(await takeCooldown(broadcasterId, display, isModerator))) return true;
  if (price && !(await trySpend(broadcasterId, chatter, price))) {
    await sendChatMessage(`@${display} your purse came up short for "${clip.title}" (${formatCoins(price)}).`, broadcasterId);
    return true;
  }
  await queuePlay(broadcasterId, clip, "chat", display);
  await sendChatMessage(`@${display} 📯 ${clip.title} plays on stream${price ? ` (−${formatCoins(price)})` : ""}.`, broadcasterId);
  return true;
}

// ── Dashboard page (auth is done by the caller; see dashboard.ts) ──────────

type FormResult = { ok: boolean; message: string };

/** The settings every clip has, read from a form; field names carry `suffix`. */
function readSettings(form: FormData, suffix = ""): { title: string; volume: number; price: number; chat: ChatAccess; reward: string; bits: number } | { error: string } {
  const get = (k: string) => String(form.get(`${k}${suffix}`) ?? "").trim();
  const volume = get("volume") === "" ? 100 : Number(get("volume"));
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) return { error: "Volume must be 0–100." };
  const rawPrice = get("price");
  const price = rawPrice === "" || rawPrice === "0" ? 0 : parseCoins(rawPrice);
  if (price === null || price < 0 || price > MAX_COPPER) return { error: `"${rawPrice.slice(0, 30)}" isn't a price — try 50, 5 sp or 2 gp.` };
  const chat = get("chat") as ChatAccess;
  if (!CHAT_ACCESS.includes(chat)) return { error: "Pick who can play it from chat." };
  const reward = get("reward").replace(/\s+/g, " ").slice(0, MAX_REWARD_TITLE);
  const bits = get("bits") === "" ? 0 : Number(get("bits"));
  if (!Number.isInteger(bits) || bits < 0 || bits > MAX_BITS) return { error: `Bits must be a whole number, 0–${MAX_BITS.toLocaleString("en-US")} (0 = not by bits).` };
  return { title: get("title").slice(0, MAX_TITLE), volume, price, chat, reward, bits };
}

/** Another clip of this channel already linked to the same reward? */
async function rewardTaken(broadcasterId: string, reward: string, exceptId = 0): Promise<string | null> {
  if (!reward) return null;
  const res = await sqlite.execute("SELECT name FROM sound_alerts WHERE broadcaster_id = ? AND reward_key = ? AND id != ?", [broadcasterId, rewardKey(reward), exceptId]);
  return res.rows[0] ? String((res.rows[0] as any).name) : null;
}

export async function applySoundAlertsForm(broadcasterId: string, form: FormData): Promise<FormResult> {
  const intent = String(form.get("intent") ?? "");
  const id = Number(form.get("id") ?? 0);

  if (intent === "upload") {
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) return { ok: false, message: "Choose a sound file to upload." };
    if (file.size > MAX_CLIP_BYTES) return { ok: false, message: `That file is ${(file.size / 1048576).toFixed(1)} MB — sounds can be up to 1 MB. Trim it or save it as an MP3.` };
    const count = Number((await sqlite.execute("SELECT COUNT(*) AS n FROM sound_alerts WHERE broadcaster_id = ?", [broadcasterId])).rows[0]?.n ?? 0);
    if (count >= MAX_CLIPS) return { ok: false, message: `You have ${MAX_CLIPS} sounds already — delete one first.` };
    const audio = new Uint8Array(await file.arrayBuffer());
    const mime = sniffAudio(audio);
    if (!mime) return { ok: false, message: "That doesn't look like an MP3, OGG, WAV, WebM or M4A sound file." };
    const fromFile = file.name.replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, MAX_NAME);
    const name = (String(form.get("name") ?? "").trim().toLowerCase() || fromFile).replace(/^!/, "");
    const bad = badName(name);
    if (bad) return { ok: false, message: bad };
    if (await clipByName(broadcasterId, name)) return { ok: false, message: `You already have a sound called "${name}".` };
    const s = readSettings(form);
    if ("error" in s) return { ok: false, message: s.error };
    const clash = await rewardTaken(broadcasterId, s.reward);
    if (clash) return { ok: false, message: `The "${s.reward}" reward already plays "${clash}".` };
    await sqlite.execute(
      `INSERT INTO sound_alerts (broadcaster_id, name, title, mime, audio, size, volume, price, chat, reward, reward_key, bits, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [broadcasterId, name, s.title || name, mime, audio, audio.length, s.volume, s.price, s.chat, s.reward, s.reward ? rewardKey(s.reward) : "", s.bits, Date.now()],
    );
    return { ok: true, message: `Added "${name}" — chat plays it with !sfx ${name}.` };
  }

  const clip = (await listClips(broadcasterId)).find((c) => c.id === id);
  if (!clip) return { ok: false, message: "That sound is gone — maybe someone else deleted it." };

  if (intent === "delete") {
    await sqlite.execute("DELETE FROM sound_alerts WHERE broadcaster_id = ? AND id = ?", [broadcasterId, id]);
    return { ok: true, message: `Deleted "${clip.name}".` };
  }
  if (intent === "test") {
    await queuePlay(broadcasterId, clip, "test", "");
    return { ok: true, message: `Sent "${clip.name}" to the overlay.${(await isCommandGroupEnabled(broadcasterId, "soundalerts")) ? "" : " (Sound alerts are switched off, so the overlay won't play it until you turn them on.)"}` };
  }
  if (intent === "save") {
    const s = readSettings(form);
    if ("error" in s) return { ok: false, message: s.error };
    const clash = await rewardTaken(broadcasterId, s.reward, id);
    if (clash) return { ok: false, message: `The "${s.reward}" reward already plays "${clash}".` };
    await sqlite.execute(
      "UPDATE sound_alerts SET title = ?, volume = ?, price = ?, chat = ?, reward = ?, reward_key = ?, bits = ? WHERE broadcaster_id = ? AND id = ?",
      [s.title || clip.name, s.volume, s.price, s.chat, s.reward, s.reward ? rewardKey(s.reward) : "", s.bits, broadcasterId, id],
    );
    return { ok: true, message: `Saved "${clip.name}".` };
  }
  return { ok: false, message: "Unknown action." };
}

/** The settings fields, filled from `c` (blank for a new upload). */
function settingsFields(c?: SoundClip): string {
  const opt = (v: ChatAccess, label: string) => `<option value="${v}"${(c?.chat ?? "everyone") === v ? " selected" : ""}>${label}</option>`;
  return `<label>Title on screen<input name="title" value="${escapeHtml(c?.title ?? "")}" maxlength="${MAX_TITLE}" placeholder="${c ? escapeHtml(c.name) : "e.g. Air horn"}"></label>
<label>Volume<input name="volume" type="number" min="0" max="100" value="${c?.volume ?? 100}"></label>
<label>In chat<select name="chat">${opt("everyone", "Everyone")}${opt("mods", "Mods only")}${opt("none", "Not from chat")}</select></label>
<label>Gold price <span class="muted">(chat)</span><input name="price" value="${c?.price ? escapeHtml(formatCoins(c.price)) : ""}" placeholder="free" maxlength="30"></label>
<label>Channel-point reward <span class="muted">(exact title)</span><input name="reward" value="${escapeHtml(c?.reward ?? "")}" maxlength="${MAX_REWARD_TITLE}" placeholder="none"></label>
<label>Bits <span class="muted">(fewest)</span><input name="bits" type="number" min="0" max="${MAX_BITS}" value="${c?.bits || ""}" placeholder="not by bits"></label>`;
}

export async function renderSoundAlertsDashboardPage(d: { broadcasterId: string; broadcasterName: string; key: string; notice?: string; error?: string }): Promise<string> {
  const [clips, on] = await Promise.all([
    listClips(d.broadcasterId),
    isCommandGroupEnabled(d.broadcasterId, "soundalerts"),
  ]);
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const name = escapeHtml(d.broadcasterName);
  const list = clips.map((c) => {
    const src = `/overlay/sound?channel=${encodeURIComponent(d.broadcasterId)}&id=${c.id}`;
    return `<form method="post" action="/dashboard/sounds" class="clip">${hidden}<input type="hidden" name="id" value="${c.id}">
<div class="clip-head"><code>!sfx ${escapeHtml(c.name)}</code><audio controls preload="none" src="${escapeHtml(src)}"></audio><span class="muted small">${(c.size / 1024).toFixed(0)} KB · played ${c.plays.toLocaleString("en-US")}×</span></div>
<div class="grid">${settingsFields(c)}</div>
<p class="actions"><button type="submit" name="intent" value="save">Save</button><button type="submit" name="intent" value="test" class="ghost">▶ Test on stream</button><button type="submit" name="intent" value="delete" class="ghost" onclick="return confirm('Delete ${escapeHtml(c.name)}?')">Delete</button></p></form>`;
  }).join("");
  const body = `<header class="dash-top"><div><span class="pill">Stream · Sound alerts</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>Your own sound clips, played on stream when chat types <code>!sfx &lt;name&gt;</code>, redeems a channel-point reward, or cheers bits. They play through their own <b>Sound alerts</b> overlay — not Sound Bytes, and not the Full stream theme. Add it in OBS as a Browser source (1920 × 1080; the link is on the <code>!overlays</code> page) in each scene they should be heard in, and tick <i>Control audio via OBS</i> to hear them in your mixer.</p>
${on ? `<p class="ok-line">✓ Sound alerts are on.</p>` : `<p class="note">Sound alerts are off. Turn on "Sound alerts" on the dashboard (or type <code>!feature soundalerts on</code>) once your sounds are in.</p>`}
<h2>Add a sound</h2>
<form method="post" action="/dashboard/sounds" enctype="multipart/form-data" class="clip">${hidden}<input type="hidden" name="intent" value="upload">
<div class="grid"><label>Sound file <span class="muted">(MP3, OGG, WAV, WebM or M4A, up to 1 MB)</span><input type="file" name="file" accept="audio/*,.mp3,.ogg,.wav,.webm,.m4a" required></label>
<label>Name chat types <span class="muted">(!sfx …)</span><input name="name" maxlength="${MAX_NAME}" placeholder="from the file name" pattern="!?[A-Za-z0-9][A-Za-z0-9_\\-]{1,24}" autocomplete="off" spellcheck="false"></label>
${settingsFields()}</div>
<p class="actions"><button type="submit" class="ember">Upload</button></p></form>
<p class="muted small">Keep clips short: the overlay stops any sound after ${MAX_CLIP_SECONDS} seconds. Up to ${MAX_CLIPS} sounds.</p>
<h2>Your sounds <span class="muted small">(${clips.length}/${MAX_CLIPS})</span></h2>
${list || `<p class="muted">No sounds yet.</p>`}
<h2>How each one plays</h2>
<ul>
<li><b>Chat:</b> <code>!sfx &lt;name&gt;</code>, for its gold price if it has one (only while gold is on; mods play free). Chat plays have their own channel-wide gap (default ${DEFAULT_COOLDOWN_SECONDS} s) — mods set it with <code>!sfx cooldown &lt;seconds|off&gt;</code>. <code>!sfx</code> lists them.</li>
<li><b>Channel points:</b> make the reward in your Twitch dashboard (Viewer rewards → Channel points) and type its exact title here. Every redemption plays the sound. GuildScribe can't refund rewards it didn't make, so if sound alerts are off, refund from the rewards queue.</li>
<li><b>Bits:</b> a cheer of at least that many bits that names the sound (<code>Cheer100 airhorn</code>) plays it. A cheer with no name plays the sound set to exactly that many bits. Needs one reconnect to GuildScribe if cheer alerts never worked for you (Twitch's <code>bits:read</code>).</li>
<li><b>Mods:</b> <code>!sfx test &lt;name&gt;</code> plays one on stream for free.</li>
</ul>`;
  return scrollDoc(`${d.broadcasterName} — Sound alerts`, body, {
    width: 980,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}
.clip{border:1px solid var(--edge);border-radius:10px;padding:14px 16px;margin:12px 0;background:#f3ead0}
.clip-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px}.clip-head code{font-size:1.05rem;font-weight:700}.clip-head audio{height:34px;max-width:100%}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.grid label{display:flex;flex-direction:column;gap:4px;font-weight:600;font-size:.86rem}
.grid input,.grid select{padding:8px 10px;font-weight:400;min-width:0}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 0}
.ok-line{color:var(--ok);font-weight:600}.muted{color:var(--ink-3)}.small{font-size:.86rem}`,
  });
}

// ── Overlay (GET /overlay?panel=soundalerts; overlay.ts routes it) ─────────

/** While the switch is off: an empty, transparent source that checks back every minute. */
export const SOUND_ALERTS_OFF_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>Sound alerts (off)</title><style>html,body{background:transparent;margin:0}</style></head><body></body></html>`;

/** The Sound alerts OBS source: polls /overlay/soundalerts and plays each clip
 * in turn with a card at the bottom centre, stopping one after
 * MAX_CLIP_SECONDS. `always` (setup-page preview) shows a sample card and
 * never polls. Extras: &volume=0-100 (default 70), &caption=0 for sound only,
 * &debug=1 to keep the status chip up. */
export function renderSoundAlertsOverlay(channelKey: string, always: boolean): string {
  // JSON inside <script>: escape "<" so a value can never close the tag.
  const cfgJson = JSON.stringify({ channel: channelKey, always, maxClip: MAX_CLIP_SECONDS }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sound alerts · ${escapeHtml(channelKey)}</title><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@800&family=Inter:wght@500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:transparent;overflow:hidden;height:100%}
body{font-family:Inter,system-ui,sans-serif;color:#f1e6d6}
.stage{position:fixed;left:0;right:0;bottom:6vh;display:flex;justify-content:center;pointer-events:none}
.pop{display:flex;align-items:center;gap:18px;max-width:min(92vw,820px);padding:16px 26px 16px 18px;border-radius:18px;
  background:linear-gradient(180deg,rgba(36,26,19,.94),rgba(21,16,12,.94));border:2px solid #e0a84a;
  box-shadow:0 12px 40px rgba(0,0,0,.55),0 0 30px rgba(224,168,74,.25);
  transform:translateY(30px) scale(.92);opacity:0;transition:transform .35s cubic-bezier(.2,1.4,.4,1),opacity .3s}
.pop.show{transform:none;opacity:1}
.pop .icon{font-size:54px;line-height:1;filter:drop-shadow(0 0 14px rgba(245,200,115,.5))}
.pop .name{font-family:Cinzel,serif;font-weight:800;font-size:30px;line-height:1.1;color:#f5c873}
.pop .line{font-size:18px;font-weight:500;color:#e9dcc8;margin-top:4px;overflow-wrap:anywhere}
.status{position:fixed;top:12px;left:12px;font:600 14px Inter,system-ui,sans-serif;padding:8px 12px;border-radius:10px;background:rgba(0,0,0,.7);color:#b9a68f}
</style></head><body>
<div class="stage"><div class="pop" id="pop" aria-live="polite"><div class="icon">📯</div><div><div class="name" id="pop-name"></div><div class="line" id="pop-line"></div></div></div></div>
<div class="status" id="status" hidden></div>
<script>
(function(){
  const CFG=${cfgJson};
  const q=new URLSearchParams(location.search);
  const volume=Math.max(0,Math.min(100,Number(q.get("volume")??70)||0))/100;
  const caption=q.get("caption")!=="0";
  const debug=q.get("debug")==="1";
  const pop=document.getElementById("pop"),status=document.getElementById("status");
  const show=(name,line)=>{document.getElementById("pop-name").textContent=name;document.getElementById("pop-line").textContent=line;pop.classList.add("show")};
  if(CFG.always){show("Air horn","Your own sound plays here, with this card, from !sfx, channel points or bits.");return}
  let hideStatus;
  const setStatus=(text)=>{status.textContent=text;status.hidden=false;clearTimeout(hideStatus);if(!debug)hideStatus=setTimeout(()=>status.hidden=true,5000)};

  // One clip at a time, in the order they came in; paid plays wait their turn.
  const MAX_QUEUE=20,queue=[];let playing=false;
  function enqueue(p){if(queue.length>=MAX_QUEUE)return;queue.push(p);if(!playing)next()}
  function next(){const p=queue.shift();if(!p){playing=false;return}playing=true;
    const a=new Audio("/overlay/sound?channel="+encodeURIComponent(CFG.channel)+"&id="+p.sound);
    a.volume=Math.max(0,Math.min(1,volume*p.volume/100));if(caption)show(p.title,p.line);
    // The card stays up at least 3 s; a clip is cut off after maxClip seconds.
    const started=Date.now();let over=false,cap=0;
    const finish=()=>{if(over)return;over=true;clearTimeout(cap);a.pause();const ms=Math.max(0,3000-(Date.now()-started));
      setTimeout(()=>pop.classList.remove("show"),ms);setTimeout(next,ms+450)};
    cap=setTimeout(finish,CFG.maxClip*1000);
    a.addEventListener("ended",finish);a.addEventListener("error",finish);
    a.play().catch(finish)}

  // Poll for plays (chat, channel points, bits); the first poll only learns the newest id.
  let after=-1;
  async function poll(){try{const r=await fetch("/overlay/soundalerts?channel="+encodeURIComponent(CFG.channel)+"&after="+after,{cache:"no-store"});const j=await r.json();
      if(j.off){location.reload();return}
      if(j.ok){if(after<0)setStatus("📯 Sound alerts ready");after=j.last;(j.plays||[]).forEach(enqueue)}}catch(e){}
    setTimeout(poll,2000)}
  poll();
})();
</script></body></html>`;
}

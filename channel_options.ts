// Per-channel options for GuildScribe's features: the numbers a streamer might
// want to tune (gold per message, raid cooldown, the Delve's boss timer, …).
//
// OPTIONS is the registry: each option's label, the Quick setup card it shows
// on (dashboard_quick.ts), its type and range, a few suggested values, and its
// default. Defaults are the server-wide ones (the same env vars the features
// always read), so an option left blank behaves exactly as before.
//
// Values live in `channel_options` (one row per channel and option; no row =
// default), except the hunting and raid cooldowns, which keep using their own
// tables so the chat commands (!huntcooldown, !raid cooldown) and the
// dashboard always agree. Reads go through a short per-isolate cache, so the
// chat hot path costs at most one read per channel every OPTIONS_CACHE_MS.
//
// Durations are stored in seconds and accepted as "90s", "10m", "1h", "1h30m"
// or a bare number in the option's own unit; "off" means 0 where 0 is allowed.

import { sqlite } from "./sqlite.ts";

const OPTIONS_CACHE_MS = 30_000;

type Kind = "duration" | "number" | "percent" | "multiplier" | "word";

export type OptionDef = {
  key: string;
  /** Quick setup card (dashboard_quick.ts QUICK_BUNDLES key). */
  bundle: string;
  label: string;
  help?: string;
  kind: Kind;
  /** Number kinds: the default, min and max (durations in seconds). */
  def: number | string;
  min?: number;
  max?: number;
  /** Duration kinds: what a bare number means. */
  unit?: "s" | "m";
  /** Number kinds: whole numbers only. */
  int?: boolean;
  /** Values offered in the input's suggestion list, as the streamer would type them. */
  suggest: string[];
  /** Kept in another module's table instead of channel_options. */
  table?: "hunt_settings" | "raid_settings";
};

const env = (name: string, fallback: number, min: number, max: number) => {
  const raw = Deno.env.get(name);
  const n = Number(raw ?? "");
  return raw && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const OPTIONS: OptionDef[] = [
  // Gold & giveaways
  { key: "gold.perMessage", bundle: "gold", label: "Copper per chat message", kind: "number", int: true,
    def: env("POINTS_PER_MESSAGE", 1, 1, 1000), min: 1, max: 1000, suggest: ["1", "2", "5", "10"] },
  { key: "gold.earnEvery", bundle: "gold", label: "Chatters earn at most once every", kind: "duration", unit: "s",
    def: env("POINTS_EARN_COOLDOWN_SECONDS", 60, 10, 86_400), min: 10, max: 3600, suggest: ["30s", "1m", "2m", "5m"] },
  { key: "rob.cooldown", bundle: "gold", label: "Time between robberies (per robber)", kind: "duration", unit: "s",
    def: env("ROB_COOLDOWN_SECONDS", 300, 10, 86_400), min: 10, max: 86_400, suggest: ["1m", "5m", "15m", "1h"] },
  { key: "rob.protect", bundle: "gold", label: "Safe from robbery after being robbed", kind: "duration", unit: "s",
    def: env("ROB_PROTECT_SECONDS", 600, 0, 86_400), min: 0, max: 86_400, suggest: ["off", "5m", "10m", "30m"] },
  // Fighting & hunts
  { key: "hunt.cooldown", bundle: "fighting", label: "Rest between monster hunts", help: "Same as !huntcooldown in chat.", kind: "duration", unit: "s",
    def: env("HUNT_COOLDOWN_SECONDS", 120, 0, 3600), min: 0, max: 3600, suggest: ["off", "1m", "2m", "5m", "10m"], table: "hunt_settings" },
  { key: "hunt.loot", bundle: "fighting", label: "Coin dropped by monsters", help: "× the normal amount; 0 = no coin.", kind: "multiplier",
    def: env("HUNT_LOOT_MULTIPLIER", 1, 0, 100), min: 0, max: 100, suggest: ["0", "0.5", "1", "2", "3"] },
  { key: "autohunt.max", bundle: "fighting", label: "Heroes out on !autohunt at once", kind: "number", int: true,
    def: env("AUTOHUNT_MAX_ACTIVE", 10, 1, 50), min: 1, max: 50, suggest: ["5", "10", "20"] },
  // Raid boss
  { key: "raid.cooldown", bundle: "raid", label: "Time between raids", help: "Same as !raid cooldown in chat.", kind: "duration", unit: "m",
    def: env("RAID_COOLDOWN_SECONDS", 600, 0, 7200), min: 0, max: 7200, suggest: ["off", "5m", "10m", "20m", "30m"], table: "raid_settings" },
  { key: "raid.muster", bundle: "raid", label: "Time to join before the raid charges", kind: "duration", unit: "s",
    def: env("RAID_MUSTER_SECONDS", 60, 15, 600), min: 15, max: 600, suggest: ["30s", "1m", "2m"] },
  { key: "raid.party", bundle: "raid", label: "Heroes per raid", kind: "number", int: true,
    def: env("RAID_PARTY_MAX", 6, 1, 20), min: 1, max: 20, suggest: ["4", "6", "10"] },
  { key: "raid.hp", bundle: "raid", label: "Boss toughness", help: "× a normal monster's HP; applies to the next boss posted.", kind: "multiplier",
    def: env("RAID_HP_MULTIPLIER", 2, 0.1, 20), min: 0.1, max: 20, suggest: ["1", "2", "3", "5"] },
  { key: "raid.loot", bundle: "raid", label: "Raid hoard", help: "× a normal monster's coin.", kind: "multiplier",
    def: env("RAID_LOOT_MULTIPLIER", 5, 0, 100), min: 0, max: 100, suggest: ["0", "2", "5", "10"] },
  // The Endless Delve (read by the game page; a change shows the next time the source loads)
  { key: "delve.bossTime", bundle: "delve", label: "Boss timer", kind: "duration", unit: "s",
    def: 30, min: 10, max: 300, suggest: ["20s", "30s", "45s", "1m"] },
  { key: "delve.killsPerFloor", bundle: "delve", label: "Monsters per floor", kind: "number", int: true,
    def: 5, min: 1, max: 50, suggest: ["3", "5", "10"] },
  { key: "delve.fireballWord", bundle: "delve", label: "Big-hit spell word", help: "What chat types for a big hit.", kind: "word",
    def: "fireball", suggest: ["fireball", "smite", "boom", "meteor"] },
  { key: "delve.fireballCooldown", bundle: "delve", label: "Big-hit cooldown (per chatter)", kind: "duration", unit: "s",
    def: 60, min: 5, max: 600, suggest: ["30s", "1m", "2m"] },
  { key: "delve.blessWord", bundle: "delve", label: "Party-buff spell word", help: "What chat types for double damage.", kind: "word",
    def: "bless", suggest: ["bless", "hype", "rally", "inspire"] },
  { key: "delve.blessCooldown", bundle: "delve", label: "Party-buff cooldown", kind: "duration", unit: "s",
    def: 90, min: 20, max: 1800, suggest: ["1m", "90s", "3m", "5m"] },
  // Wandering merchant
  { key: "merchant.minGap", bundle: "merchant", label: "Shortest gap between visits", kind: "duration", unit: "m",
    def: env("MERCHANT_MIN_INTERVAL_MINUTES", 25, 5, 10_000) * 60, min: 300, max: 86_400, suggest: ["15m", "25m", "45m", "1h"] },
  { key: "merchant.maxGap", bundle: "merchant", label: "Longest gap between visits", kind: "duration", unit: "m",
    def: Math.max(env("MERCHANT_MIN_INTERVAL_MINUTES", 25, 5, 10_000), env("MERCHANT_MAX_INTERVAL_MINUTES", 60, 5, 10_000)) * 60, min: 300, max: 86_400, suggest: ["30m", "1h", "2h"] },
  // Swear jar
  { key: "jar.cost", bundle: "jar", label: "Fine per swear (copper)", kind: "number", int: true,
    def: env("SWEAR_COST_COPPER", 2, 1, 1_000_000), min: 1, max: 1000, suggest: ["1", "2", "5", "10"] },
  // AI characters
  { key: "npc.chatterChance", bundle: "npcs", label: "NPCs chime in on a chat message", kind: "percent",
    def: env("NPC_CHATTER_CHANCE_PERCENT", 4, 0, 100), min: 0, max: 100, suggest: ["1%", "4%", "10%"] },
  { key: "npc.chatterCooldown", bundle: "npcs", label: "Quiet time between NPC chime-ins", kind: "duration", unit: "m",
    def: Math.round(env("NPC_CHATTER_COOLDOWN_MS", 900_000, 60_000, 86_400_000) / 1000), min: 60, max: 86_400, suggest: ["5m", "15m", "30m", "1h"] },
  { key: "chronicle.chance", bundle: "npcs", label: "Story quote-back on a chat message", kind: "percent",
    def: env("CHRONICLE_QUOTE_CHANCE_PERCENT", 3, 0, 100), min: 0, max: 100, suggest: ["1%", "3%", "10%"] },
  { key: "chronicle.cooldown", bundle: "npcs", label: "Quiet time between quote-backs", kind: "duration", unit: "m",
    def: Math.round(env("CHRONICLE_COOLDOWN_MS", 600_000, 30_000, 86_400_000) / 1000), min: 30, max: 86_400, suggest: ["5m", "10m", "30m"] },
];

const BY_KEY = new Map(OPTIONS.map((o) => [o.key, o]));
export const optionDef = (key: string) => BY_KEY.get(key);

export async function ensureChannelOptionTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS channel_options (
      broadcaster_id TEXT NOT NULL, opt_key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, opt_key)
    )`,
  );
}

/** Wipes the channel's options — !dndbot leave purge. */
export async function purgeChannelOptions(broadcasterId: string) {
  await sqlite.execute("DELETE FROM channel_options WHERE broadcaster_id = ?", [broadcasterId]);
  cache.delete(broadcasterId);
}

// ── Reading ──

const cache = new Map<string, { at: number; set: Map<string, string> }>();

/** The channel's own values (no entry = default), cached briefly. */
async function channelValues(broadcasterId: string): Promise<Map<string, string>> {
  const hit = cache.get(broadcasterId);
  if (hit && Date.now() - hit.at < OPTIONS_CACHE_MS) return hit.set;
  const set = new Map<string, string>();
  const [own, hunt, raid] = await Promise.all([
    sqlite.execute("SELECT opt_key, value FROM channel_options WHERE broadcaster_id = ?", [broadcasterId]),
    sqlite.execute("SELECT cooldown_seconds FROM hunt_settings WHERE broadcaster_id = ?", [broadcasterId]).catch(() => ({ rows: [] as any[] })),
    sqlite.execute("SELECT cooldown_seconds FROM raid_settings WHERE broadcaster_id = ?", [broadcasterId]).catch(() => ({ rows: [] as any[] })),
  ]);
  for (const r of own.rows as any[]) if (BY_KEY.has(String(r.opt_key))) set.set(String(r.opt_key), String(r.value));
  if ((hunt.rows as any[]).length) set.set("hunt.cooldown", String((hunt.rows as any[])[0].cooldown_seconds));
  if ((raid.rows as any[]).length) set.set("raid.cooldown", String((raid.rows as any[])[0].cooldown_seconds));
  cache.set(broadcasterId, { at: Date.now(), set });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return set;
}

/** A number option for a channel: its own value, else the default. Never throws. */
export async function optNum(broadcasterId: string, key: string): Promise<number> {
  const o = BY_KEY.get(key);
  if (!o) throw new Error(`unknown option ${key}`);
  const fallback = Number(o.def);
  if (!broadcasterId) return fallback;
  try {
    const raw = (await channelValues(broadcasterId)).get(key);
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) ? clamp(o, n) : fallback;
  } catch (e) {
    console.error("option read failed", key, e);
    return fallback;
  }
}

/** A word option for a channel: its own value, else the default. Never throws. */
export async function optWord(broadcasterId: string, key: string): Promise<string> {
  const o = BY_KEY.get(key);
  if (!o) throw new Error(`unknown option ${key}`);
  try {
    return (await channelValues(broadcasterId)).get(key) ?? String(o.def);
  } catch (_) {
    return String(o.def);
  }
}

/** Every option's current value as the dashboard shows it ("" = default). */
export async function optionInputs(broadcasterId: string): Promise<Record<string, string>> {
  const set = await channelValues(broadcasterId);
  const out: Record<string, string> = {};
  for (const o of OPTIONS) {
    const raw = set.get(o.key);
    out[o.key] = raw === undefined ? "" : o.kind === "word" ? raw : formatValue(o, Number(raw));
  }
  return out;
}

const clamp = (o: OptionDef, n: number) => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, n));

// ── Formatting & parsing ──

/** 90 → "90s", 600 → "10m", 5400 → "1h30m", 0 → "off"; numbers as typed; percents with "%". */
export function formatValue(o: OptionDef, n: number): string {
  if (o.kind === "word") return String(n);
  if (o.kind === "percent") return `${+n.toFixed(2)}%`;
  if (o.kind === "multiplier") return `×${+n.toFixed(2)}`;
  if (o.kind !== "duration") return String(+n.toFixed(2));
  if (n <= 0) return "off";
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = Math.round(n % 60);
  if (!h && !m) return `${s}s`;
  if (!h) return s ? `${m}m${s}s` : `${m}m`;
  return `${h}h${m ? `${m}m` : ""}`;
}

/** The default as hint text: "default: 10m". */
export const defaultText = (o: OptionDef) => `default: ${o.kind === "word" ? String(o.def) : formatValue(o, Number(o.def))}`;

const readable = (o: OptionDef, n: number) => formatValue(o, n).replace(/^×/, "×");

/** Parses what a streamer typed. null = blank (use the default). */
export function parseOptionInput(o: OptionDef, raw: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const t = raw.trim().toLowerCase().replace(/,/g, ".");
  if (!t || t === "default") return { ok: true, value: null };
  if (o.kind === "word") {
    const w = t.replace(/^!/, "");
    return /^[a-z0-9]{2,20}$/.test(w) ? { ok: true, value: w } : { ok: false, error: `${o.label}: one word, 2–20 letters or numbers (like "${o.def}").` };
  }
  let n: number;
  if (o.kind === "duration") {
    if (t === "off" || t === "none" || t === "0") n = 0;
    else {
      const parts = [...t.replace(/\s+/g, "").matchAll(/(\d+(?:\.\d+)?)(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)?/g)];
      const joined = parts.map((p) => p[0]).join("");
      if (!parts.length || joined !== t.replace(/\s+/g, "")) return { ok: false, error: `${o.label}: try something like ${o.suggest.filter((x) => x !== "off").slice(0, 2).join(" or ")}.` };
      n = 0;
      for (const [, num, u] of parts) {
        const v = Number(num), unit = (u ?? o.unit ?? "s")[0];
        n += unit === "h" ? v * 3600 : unit === "m" ? v * 60 : v;
      }
    }
    n = Math.round(n);
  } else {
    const num = Number(t.replace(/^[x×]/, "").replace(/%$/, "").trim());
    if (!Number.isFinite(num)) return { ok: false, error: `${o.label}: that's not a number.` };
    n = o.int ? Math.round(num) : num;
  }
  if (o.min !== undefined && n < o.min) {
    return { ok: false, error: `${o.label}: the lowest allowed is ${o.min === 0 && o.kind === "duration" ? "off" : readable(o, o.min)}.` };
  }
  if (o.max !== undefined && n > o.max) return { ok: false, error: `${o.label}: the highest allowed is ${readable(o, o.max)}.` };
  return { ok: true, value: String(n) };
}

// ── Saving ──

/** Saves typed options (opt_<key> fields). Only fields present in the form are touched; blank = default. */
export async function saveOptionsFromForm(broadcasterId: string, form: FormData): Promise<{ changed: string[]; errors: string[] }> {
  if (!OPTIONS.some((o) => form.has(`opt_${o.key}`))) return { changed: [], errors: [] };
  const current = await channelValues(broadcasterId);
  const changed: string[] = [], errors: string[] = [];
  for (const o of OPTIONS) {
    const field = form.get(`opt_${o.key}`);
    if (field === null) continue;
    const parsed = parseOptionInput(o, String(field));
    if (!parsed.ok) { errors.push(parsed.error); continue; }
    const before = current.get(o.key) ?? null;
    if (parsed.value === before || (parsed.value !== null && before !== null && Number(parsed.value) === Number(before) && o.kind !== "word")) continue;
    await writeOption(broadcasterId, o, parsed.value);
    changed.push(o.label);
  }
  // The merchant's gaps must stay in order: a longer "shortest" than "longest" gap is swapped.
  if (changed.length) cache.delete(broadcasterId);
  const minGap = await optNum(broadcasterId, "merchant.minGap"), maxGap = await optNum(broadcasterId, "merchant.maxGap");
  if (minGap > maxGap) {
    await writeOption(broadcasterId, BY_KEY.get("merchant.minGap")!, String(maxGap));
    await writeOption(broadcasterId, BY_KEY.get("merchant.maxGap")!, String(minGap));
    cache.delete(broadcasterId);
  }
  return { changed, errors };
}

async function writeOption(broadcasterId: string, o: OptionDef, value: string | null) {
  if (o.table) {
    if (value === null) await sqlite.execute(`DELETE FROM ${o.table} WHERE broadcaster_id = ?`, [broadcasterId]);
    else await sqlite.execute(`INSERT OR REPLACE INTO ${o.table} (broadcaster_id, cooldown_seconds, updated_at) VALUES (?,?,?)`, [broadcasterId, Number(value), Date.now()]);
  } else if (value === null) {
    await sqlite.execute("DELETE FROM channel_options WHERE broadcaster_id = ? AND opt_key = ?", [broadcasterId, o.key]);
  } else {
    await sqlite.execute(
      "INSERT OR REPLACE INTO channel_options (broadcaster_id, opt_key, value, updated_at) VALUES (?,?,?,?)",
      [broadcasterId, o.key, value, Date.now()],
    );
  }
  cache.delete(broadcasterId);
}

/** Forget a channel's cached options (after a chat command changed one). */
export const forgetOptionCache = (broadcasterId: string) => cache.delete(broadcasterId);

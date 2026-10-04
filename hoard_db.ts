// Hunt and Hoard — persistence and the shared stall / bounty board (see
// hoard.ts for the commands). Own tables, all keyed by channel:
//
//   hoard_settings  module on/off (off by default)
//   hoard_players   per hero: potion pack, bounty progress, regen clock.
//                   Level, XP, HP and gear live on the GuildScribe character.
//   hoard_stall     the merchant stall's offers (JSON) + when it last turned over
//   hoard_board     the bounty board's postings (JSON) + when it was posted

import { sqlite } from "./sqlite.ts";
import { LEGENDARY_ITEMS, MERCHANT_ITEMS, findMerchantItem, type MerchantItem } from "./gear.ts";
import { parseFirstPrice } from "./coins.ts";
import { xpForMonsterCr } from "./characters.ts";
import { getChannelRoster } from "./bestiary.ts";
import { SOLO_MONSTERS, type SoloMonster } from "./data.ts";
import {
  BOARD_REFRESH_MS,
  BOARD_SLOTS,
  BOUNTY_MAX_CR,
  BOUNTY_POTION_CHANCE,
  MERCHANT_NAMES,
  POTIONS,
  type Potion,
  STALL_LEGENDARY_CHANCE,
  STALL_POTION_SHARE,
  STALL_REFRESH_MS,
  STALL_SLOTS,
} from "./hoard_data.ts";

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

export async function ensureHoardTables() {
  await sqlite.batch([
    `CREATE TABLE IF NOT EXISTS hoard_settings (broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS hoard_players (
      broadcaster_id TEXT NOT NULL, username TEXT NOT NULL, potions TEXT NOT NULL DEFAULT '{}',
      progress TEXT NOT NULL DEFAULT '{}', last_heal_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (broadcaster_id, username)
    )`,
    `CREATE TABLE IF NOT EXISTS hoard_stall (broadcaster_id TEXT PRIMARY KEY, offers TEXT NOT NULL, restocked_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS hoard_board (broadcaster_id TEXT PRIMARY KEY, quests TEXT NOT NULL, posted_at INTEGER NOT NULL)`,
  ]);
}

export async function purgeHoardData(broadcasterId: string) {
  await sqlite.batch(
    ["hoard_settings", "hoard_players", "hoard_stall", "hoard_board"].map((t) => ({
      sql: `DELETE FROM ${t} WHERE broadcaster_id = ?`,
      args: [broadcasterId],
    })),
  );
}

// ── On/off ──

export async function isHoardEnabled(broadcasterId: string): Promise<boolean> {
  const res = await sqlite.execute("SELECT enabled FROM hoard_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length > 0 && Number(res.rows[0].enabled) === 1;
}

export async function setHoardEnabled(broadcasterId: string, enabled: boolean) {
  await sqlite.execute("INSERT OR REPLACE INTO hoard_settings (broadcaster_id, enabled, updated_at) VALUES (?,?,?)", [
    broadcasterId,
    enabled ? 1 : 0,
    Date.now(),
  ]);
}

// ── Players ──

export interface HoardPlayer {
  potions: Record<string, number>;
  progress: Record<string, number>;
  lastHealAt: number;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  try {
    const v = JSON.parse(String(raw ?? ""));
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

export async function getPlayer(broadcasterId: string, username: string): Promise<HoardPlayer> {
  const res = await sqlite.execute("SELECT * FROM hoard_players WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username.toLowerCase()]);
  const r = res.rows[0];
  return {
    potions: parseJson(r?.potions, {}),
    progress: parseJson(r?.progress, {}),
    lastHealAt: Number(r?.last_heal_at ?? 0),
  };
}

export async function savePlayer(broadcasterId: string, username: string, p: HoardPlayer) {
  for (const [k, n] of Object.entries(p.potions)) if (!(n > 0)) delete p.potions[k];
  await sqlite.execute(
    "INSERT OR REPLACE INTO hoard_players (broadcaster_id, username, potions, progress, last_heal_at) VALUES (?,?,?,?,?)",
    [broadcasterId, username.toLowerCase(), JSON.stringify(p.potions), JSON.stringify(p.progress), p.lastHealAt],
  );
}

export function findPotion(needle: string): Potion | undefined {
  const n = needle.trim().toLowerCase();
  if (!n) return undefined;
  return POTIONS.find((p) => p.key === n || p.name.toLowerCase() === n) ?? POTIONS.find((p) => p.name.toLowerCase().includes(n));
}

/** The potion in the pack matching `needle`; a bare "potion" picks the
 * smallest heal the hero carries. */
export function findPackPotion(p: HoardPlayer, needle: string): Potion | undefined {
  const owned = POTIONS.filter((x) => (p.potions[x.key] ?? 0) > 0);
  const n = needle.trim().toLowerCase();
  if (!n || n === "potion" || n === "potions") return owned[0];
  return owned.find((x) => x.key === n || x.name.toLowerCase() === n) ?? owned.find((x) => x.name.toLowerCase().includes(n));
}

// ── Merchant stall ──

// Every ware sells exactly once: buying it marks the slot soldTo (claimOffer,
// atomic) and the slot stays empty until the whole stall turns over.
export type StallOffer =
  | { kind: "potion"; key: string; merchant: string; soldTo?: string }
  | { kind: "gear"; desc: string; merchant: string; soldTo?: string };

const offerId = (o: StallOffer) => (o.kind === "potion" ? `p:${o.key}` : `g:${o.desc}`);

/** An offer with its catalog entry and price resolved (null if it's sold or
 * the catalog no longer has it). */
export type ResolvedOffer =
  | { kind: "potion"; potion: Potion; name: string; price: number; merchant: string; pitch: string }
  | { kind: "gear"; gear: MerchantItem; name: string; price: number; merchant: string; pitch: string; legendary: boolean };

export function resolveOffer(o: StallOffer): ResolvedOffer | null {
  if (o.soldTo) return null;
  if (o.kind === "potion") {
    const potion = POTIONS.find((p) => p.key === o.key);
    return potion ? { kind: "potion", potion, name: potion.name, price: potion.price, merchant: o.merchant, pitch: potion.desc } : null;
  }
  const gear = findMerchantItem(o.desc);
  if (!gear) return null;
  return {
    kind: "gear",
    gear,
    name: gear.name,
    price: parseFirstPrice(gear.price) ?? 1,
    merchant: o.merchant,
    pitch: gear.desc,
    legendary: LEGENDARY_ITEMS.includes(gear),
  };
}

function rollOffer(exclude: StallOffer[] = []): StallOffer {
  const taken = new Set(exclude.map((o) => (o.kind === "potion" ? o.key : o.desc)));
  for (let i = 0; i < 20; i++) {
    const merchant = pick(MERCHANT_NAMES);
    const offer: StallOffer = Math.random() < STALL_POTION_SHARE
      ? { kind: "potion", key: pick(POTIONS).key, merchant }
      : { kind: "gear", desc: pick(Math.random() < STALL_LEGENDARY_CHANCE ? LEGENDARY_ITEMS : MERCHANT_ITEMS).desc, merchant };
    if (!taken.has(offer.kind === "potion" ? offer.key : offer.desc)) return offer;
  }
  return { kind: "potion", key: pick(POTIONS).key, merchant: pick(MERCHANT_NAMES) };
}

function rollStall(): StallOffer[] {
  const out: StallOffer[] = [];
  while (out.length < STALL_SLOTS) out.push(rollOffer(out));
  return out;
}

/** The current stall and how long until it turns over, turning it over
 * first if it's stale. */
export async function getStallState(broadcasterId: string): Promise<{ offers: StallOffer[]; turnsOverInMs: number }> {
  const res = await sqlite.execute("SELECT offers, restocked_at FROM hoard_stall WHERE broadcaster_id = ?", [broadcasterId]);
  const r = res.rows[0];
  const offers = parseJson<StallOffer[]>(r?.offers, []);
  const age = Date.now() - Number(r?.restocked_at ?? 0);
  if (r && Array.isArray(offers) && offers.length === STALL_SLOTS && age < STALL_REFRESH_MS) {
    return { offers, turnsOverInMs: STALL_REFRESH_MS - age };
  }
  const fresh = rollStall();
  await sqlite.execute("INSERT OR REPLACE INTO hoard_stall (broadcaster_id, offers, restocked_at) VALUES (?,?,?)", [
    broadcasterId,
    JSON.stringify(fresh),
    Date.now(),
  ]);
  return { offers: fresh, turnsOverInMs: STALL_REFRESH_MS };
}

export async function getStall(broadcasterId: string): Promise<StallOffer[]> {
  return (await getStallState(broadcasterId)).offers;
}

/**
 * Marks slot `index` sold to `username` — but only if it still holds the same
 * unsold ware `expected` (compare-and-swap on the stored JSON, so two buyers
 * can never both get it, and a turnover in between voids the claim). Returns
 * who got it: `username` on success, the earlier buyer's name if it was
 * already sold, or null if the slot changed (the stall turned over).
 */
export async function claimOffer(broadcasterId: string, index: number, expected: StallOffer, username: string): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await sqlite.execute("SELECT offers FROM hoard_stall WHERE broadcaster_id = ?", [broadcasterId]);
    const raw = String(res.rows[0]?.offers ?? "");
    const offers = parseJson<StallOffer[]>(raw, []);
    const cur = offers[index];
    if (!cur || offerId(cur) !== offerId(expected)) return null;
    if (cur.soldTo) return cur.soldTo;
    offers[index] = { ...cur, soldTo: username };
    const upd = await sqlite.execute("UPDATE hoard_stall SET offers = ? WHERE broadcaster_id = ? AND offers = ?", [
      JSON.stringify(offers),
      broadcasterId,
      raw,
    ]);
    if (upd.rowsAffected > 0) return username;
  }
  return null;
}

// ── Bounty board ──

export interface Bounty {
  id: string;
  monster: string;
  cr: string;
  target: number;
  /** Copper. */
  reward: number;
  potion: string | null;
}

async function bountyPool(broadcasterId: string): Promise<SoloMonster[]> {
  const roster = await getChannelRoster(broadcasterId);
  const easy = roster.filter((m) => m.crValue <= BOUNTY_MAX_CR);
  return easy.length ? easy : SOLO_MONSTERS.filter((m) => m.crValue <= BOUNTY_MAX_CR);
}

function rollBounty(pool: SoloMonster[], exclude: Bounty[]): Bounty {
  const taken = new Set(exclude.map((b) => b.monster));
  const choices = pool.filter((m) => !taken.has(m.name));
  const m = pick(choices.length ? choices : pool);
  const target = Math.max(1, Math.min(6, Math.round(6 - m.crValue)));
  // About one and a half kills' worth of loot per kill asked, plus a flat fee.
  const reward = Math.round(target * Math.ceil(xpForMonsterCr(m.cr) / 10) * 1.5) + 10;
  return {
    id: crypto.randomUUID().slice(0, 8),
    monster: m.name,
    cr: m.cr,
    target,
    reward,
    potion: Math.random() < BOUNTY_POTION_CHANCE ? pick(POTIONS.slice(0, 4)).key : null,
  };
}

export async function getBoard(broadcasterId: string): Promise<Bounty[]> {
  const res = await sqlite.execute("SELECT quests, posted_at FROM hoard_board WHERE broadcaster_id = ?", [broadcasterId]);
  const r = res.rows[0];
  const quests = parseJson<Bounty[]>(r?.quests, []);
  if (r && Array.isArray(quests) && quests.length === BOARD_SLOTS && Date.now() - Number(r.posted_at) < BOARD_REFRESH_MS) return quests;
  const pool = await bountyPool(broadcasterId);
  const fresh: Bounty[] = [];
  while (fresh.length < BOARD_SLOTS) fresh.push(rollBounty(pool, fresh));
  await sqlite.execute("INSERT OR REPLACE INTO hoard_board (broadcaster_id, quests, posted_at) VALUES (?,?,?)", [
    broadcasterId,
    JSON.stringify(fresh),
    Date.now(),
  ]);
  return fresh;
}

/** Replaces one fulfilled posting with a fresh one (the rest stay). */
export async function rerollBounty(broadcasterId: string, board: Bounty[], index: number) {
  const pool = await bountyPool(broadcasterId);
  board[index] = rollBounty(pool, board.filter((_, i) => i !== index));
  await sqlite.execute("UPDATE hoard_board SET quests = ? WHERE broadcaster_id = ?", [JSON.stringify(board), broadcasterId]);
}

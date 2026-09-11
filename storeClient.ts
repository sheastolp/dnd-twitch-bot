// =============================================================================
//  storeClient.ts — talks to the Val Town HTTP val's storage API instead of
//  SQLite directly (only code running inside a Val Town val can use Val
//  Town's SQLite binding). Same function names/shapes commands.ts already
//  expects — only this file's internals changed.
// =============================================================================
import { Character, MerchantOffer, Rules, AutoHuntSession } from "./game.ts";
import { Quest } from "./quests.ts";

const BASE_URL = (Deno.env.get("VALTOWN_API_BASE_URL") || "").replace(/\/+$/, "");
const API_SECRET = Deno.env.get("VALTOWN_API_SECRET") || "";

if (!BASE_URL || !API_SECRET) {
  console.error("Missing VALTOWN_API_BASE_URL or VALTOWN_API_SECRET env vars.");
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${API_SECRET}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

export async function getCharacter(username: string): Promise<Character | null> {
  const res = await apiFetch(`/api/characters/${encodeURIComponent(username.toLowerCase())}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error("getCharacter failed:", res.status, await res.text());
    return null;
  }
  const character = (await res.json()) as Character;
  if (!character.questProgress) character.questProgress = {};
  const healed = Rules.applyPassiveHealing(character); // catch up on regen since last read
  if (healed) await saveCharacter(character);
  return character;
}

export async function saveCharacter(character: Character): Promise<void> {
  const res = await apiFetch(`/api/characters/${encodeURIComponent(character.username.toLowerCase())}`, {
    method: "PUT",
    body: JSON.stringify(character),
  });
  if (!res.ok) console.error("saveCharacter failed:", res.status, await res.text());
}

export async function deleteCharacter(username: string): Promise<void> {
  const res = await apiFetch(`/api/characters/${encodeURIComponent(username.toLowerCase())}`, { method: "DELETE" });
  if (!res.ok) console.error("deleteCharacter failed:", res.status, await res.text());
}

export async function getMerchantOffers(): Promise<MerchantOffer[]> {
  const res = await apiFetch(`/api/merchant`);
  if (!res.ok) {
    console.error("getMerchantOffers failed:", res.status, await res.text());
    return [];
  }
  return await res.json();
}

export async function saveMerchantOffers(offers: MerchantOffer[]): Promise<void> {
  const res = await apiFetch(`/api/merchant`, { method: "PUT", body: JSON.stringify(offers) });
  if (!res.ok) console.error("saveMerchantOffers failed:", res.status, await res.text());
}

export async function getChannels(): Promise<string[]> {
  const res = await apiFetch(`/api/channels`);
  if (!res.ok) {
    console.error("getChannels failed:", res.status, await res.text());
    return [];
  }
  return await res.json();
}

export async function addChannel(channel: string, addedBy: string): Promise<void> {
  const res = await apiFetch(`/api/channels`, { method: "POST", body: JSON.stringify({ channel, addedBy }) });
  if (!res.ok) console.error("addChannel failed:", res.status, await res.text());
}

export async function removeChannel(channel: string): Promise<void> {
  const res = await apiFetch(`/api/channels/${encodeURIComponent(channel.toLowerCase())}`, { method: "DELETE" });
  if (!res.ok) console.error("removeChannel failed:", res.status, await res.text());
}

export async function getQuestBoard(): Promise<Quest[]> {
  const res = await apiFetch(`/api/quests`);
  if (!res.ok) {
    console.error("getQuestBoard failed:", res.status, await res.text());
    return [];
  }
  return await res.json();
}

export async function saveQuestBoard(quests: Quest[]): Promise<void> {
  const res = await apiFetch(`/api/quests`, { method: "PUT", body: JSON.stringify(quests) });
  if (!res.ok) console.error("saveQuestBoard failed:", res.status, await res.text());
}

export async function getMeta(key: string): Promise<string | null> {
  const res = await apiFetch(`/api/meta/${encodeURIComponent(key)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error("getMeta failed:", res.status, await res.text());
    return null;
  }
  const body = await res.json();
  return body.value as string;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const res = await apiFetch(`/api/meta/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ value }) });
  if (!res.ok) console.error("setMeta failed:", res.status, await res.text());
}

// Feature toggles set from the moderator-locked /admin panel on Val Town,
// scoped per channel. Keys here must stay in sync with FEATURE_DEFS in the
// Val Town main.ts.
const FEATURE_KEYS = ["characters", "combat", "shop", "quests", "merchant_ads", "quest_ads", "item_lore", "start_nudge"];

export async function getFeatureFlags(channel: string): Promise<Record<string, boolean>> {
  const raw = await getMeta("feature_flags");
  const stored = raw ? JSON.parse(raw) : {};
  const channelStored = stored[channel.toLowerCase()] || {};
  const flags: Record<string, boolean> = {};
  for (const key of FEATURE_KEYS) flags[key] = channelStored[key] !== false; // default: enabled
  return flags;
}

// Timed autohunt sessions — stored as one flat list under a single meta
// key, reusing the same generic key-value store feature_flags already
// uses. No dedicated Val Town backend endpoint needed.
export async function getAutohuntSessions(): Promise<AutoHuntSession[]> {
  const raw = await getMeta("autohunt_sessions");
  if (!raw) return [];
  try {
    return JSON.parse(raw) as AutoHuntSession[];
  } catch (err) {
    console.error("getAutohuntSessions parse failed:", err);
    return [];
  }
}

export async function saveAutohuntSessions(sessions: AutoHuntSession[]): Promise<void> {
  await setMeta("autohunt_sessions", JSON.stringify(sessions));
}

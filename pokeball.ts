// Pokéball advisor — watches the Pokémon Community Game bot
// (PokemonCommunityGame) and, when it announces a spawn ("A wild Ralts
// appears … Catch it using !pokecatch"), replies with the ball to throw.
// Off by default per channel; !pokeball on/off/status (mod/broadcaster).
//
// The pick uses the species' real data from PokeAPI (types, weight, base
// stats, catch rate, legendary/mythical), cached per isolate:
//   legendary/mythical or catch rate ≤ 3  → Ultra Ball (Master Ball if you have one)
//   Water or Bug type                     → Net Ball
//   weight ≥ 200 kg                       → Heavy Ball
//   base Speed ≥ 100                      → Fast Ball
//   otherwise by catch rate: ≥ 150 Poké Ball, ≥ 75 Great Ball, else Ultra Ball
// A Quick Ball (thrown right away) is always offered as the alternative.
//
// PokemonCommunityGame is a bot account, so its messages reach this through
// the bot branch in main.ts (maybePokeballAdvice), never the command router.

import { sqlite } from "./sqlite.ts";
import { getBroadcaster, isChannelBlocked, isChannelEnabled } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";

export const POKEMON_GAME_BOT = "pokemoncommunitygame";

export async function ensurePokeballTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS pokeball_settings (broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
  );
}

export async function purgePokeballData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM pokeball_settings WHERE broadcaster_id = ?", [broadcasterId]);
}

export async function isPokeballEnabled(broadcasterId: string): Promise<boolean> {
  const res = await sqlite.execute("SELECT enabled FROM pokeball_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return res.rows.length > 0 && Number(res.rows[0].enabled) === 1;
}

export async function setPokeballEnabled(broadcasterId: string, enabled: boolean) {
  await sqlite.execute("INSERT OR REPLACE INTO pokeball_settings (broadcaster_id, enabled, updated_at) VALUES (?,?,?)", [
    broadcasterId,
    enabled ? 1 : 0,
    Date.now(),
  ]);
}

/** !pokeball on|off|status. Status answers anyone; on/off is mod-only. */
export async function handlePokeballCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!pokeball(?:\s+(on|off|status))?$/i);
  if (!m) return false;
  const action = (m[1] ?? "status").toLowerCase();
  const say = (text: string) => sendChatMessage(`@${display} ${text}`, broadcasterId);
  if (action === "status") {
    const on = await isPokeballEnabled(broadcasterId);
    await say(`🔴 The Pokéball advisor is ${on ? "on — I'll suggest a ball whenever PokemonCommunityGame spawns a Pokémon" : "off in this channel"}.${isModerator ? ` Mods: !pokeball ${on ? "off" : "on"}.` : ""}`);
  } else if (!isModerator) {
    await say("only the broadcaster or a moderator can turn the Pokéball advisor on or off.");
  } else {
    await setPokeballEnabled(broadcasterId, action === "on");
    await say(action === "on"
      ? "🔴 Pokéball advisor on! When PokemonCommunityGame spawns a Pokémon I'll suggest which ball to throw."
      : "Pokéball advisor off.");
  }
  return true;
}

/** The Pokémon name from a spawn announcement, or null if it isn't one. */
export function parseSpawn(text: string): string | null {
  const m = text.match(/\bA wild (.+?) (?:appears|appeared|has appeared)\b/i);
  if (!m) return null;
  const name = m[1].replace(/[!.]+$/, "").trim();
  return name && name.length <= 40 ? name : null;
}

const REGIONS: Record<string, string> = { alolan: "alola", galarian: "galar", hisuian: "hisui", paldean: "paldea" };

/** PokeAPI slugs to try for a displayed name: "Alolan Vulpix" → vulpix-alola, "Mr. Mime" → mr-mime. */
export function pokeApiSlugs(name: string): string[] {
  const words = name.trim().split(/\s+/);
  let suffix = "";
  if (words.length > 1 && REGIONS[words[0].toLowerCase()]) suffix = `-${REGIONS[words.shift()!.toLowerCase()]}`;
  const base = words.join(" ")
    .replace(/♀/g, "-f").replace(/♂/g, "-m")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’:]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  if (!base) return [];
  return suffix ? [`${base}${suffix}`, base] : [base];
}

interface PokeInfo {
  name: string;
  types: string[];
  weightKg: number;
  speed: number;
  captureRate: number;
  legendary: boolean;
}

const cache = new Map<string, PokeInfo | null>();

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function lookupPokemon(name: string): Promise<PokeInfo | null> {
  const key = name.toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  let info: PokeInfo | null = null;
  for (const slug of pokeApiSlugs(name)) {
    let poke = await getJson(`https://pokeapi.co/api/v2/pokemon/${slug}`);
    let species = null;
    if (!poke) {
      // Species with forms (e.g. "Deoxys", "Toxtricity") have no plain /pokemon/<name>.
      species = await getJson(`https://pokeapi.co/api/v2/pokemon-species/${slug}`);
      const variety = species?.varieties?.find((v: any) => v.is_default)?.pokemon?.url;
      if (variety) poke = await getJson(variety);
    }
    if (!poke) continue;
    species ??= poke.species?.url ? await getJson(poke.species.url) : null;
    info = {
      name,
      types: (poke.types ?? []).map((t: any) => String(t.type?.name ?? "")).filter(Boolean),
      weightKg: Number(poke.weight ?? 0) / 10,
      speed: Number((poke.stats ?? []).find((s: any) => s.stat?.name === "speed")?.base_stat ?? 0),
      captureRate: Number(species?.capture_rate ?? 45),
      legendary: Boolean(species?.is_legendary || species?.is_mythical),
    };
    break;
  }
  // Don't remember a failed lookup forever — only cache hits, plus a small cap.
  if (info) {
    if (cache.size > 500) cache.clear();
    cache.set(key, info);
  }
  return info;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The ball to throw and why. */
export function recommendBall(p: PokeInfo): { ball: string; why: string } {
  const rate = p.captureRate;
  if (p.legendary || rate <= 3) return { ball: "Ultra Ball (Master Ball if you have one)", why: p.legendary ? "legendary — very hard catch" : "very hard catch" };
  if (rate >= 190) return { ball: "Poké Ball", why: "easy catch — save your good balls" };
  if (p.types.includes("water") || p.types.includes("bug")) return { ball: "Net Ball", why: `${p.types.includes("water") ? "Water" : "Bug"} type` };
  if (p.weightKg >= 200) return { ball: "Heavy Ball", why: `heavy (${p.weightKg} kg)` };
  if (p.speed >= 100) return { ball: "Fast Ball", why: `fast (base Speed ${p.speed})` };
  if (rate >= 150) return { ball: "Poké Ball", why: "easy catch" };
  if (rate >= 75) return { ball: "Great Ball", why: "medium catch" };
  return { ball: "Ultra Ball", why: "tough catch" };
}

/**
 * Called for every bot-account chat message (main.ts). Replies with a ball
 * suggestion when PokemonCommunityGame announces a spawn in a channel that
 * has the advisor on. Never throws.
 */
export async function maybePokeballAdvice(broadcasterId: string, chatter: string, text: string): Promise<void> {
  try {
    if (chatter.toLowerCase() !== POKEMON_GAME_BOT) return;
    const name = parseSpawn(text);
    if (!name) return;
    const [on, connection, blocked, channelOn] = await Promise.all([
      isPokeballEnabled(broadcasterId),
      getBroadcaster(broadcasterId),
      isChannelBlocked(broadcasterId),
      isChannelEnabled(broadcasterId),
    ]);
    if (!on || !connection || Number(connection.connected) !== 1 || blocked || !channelOn) return;
    if (Number(connection.is_live) !== 1) return; // quiet while offline, like other ambient sends
    const info = await lookupPokemon(name);
    if (!info) {
      await sendChatMessage(`🔴 ${name} spotted! I couldn't look it up — try a Great Ball, or a Quick Ball thrown right away.`, broadcasterId);
      return;
    }
    const { ball, why } = recommendBall(info);
    const types = info.types.map(cap).join("/");
    await sendChatMessage(
      `🔴 Wild ${name} (${types}, catch rate ${info.captureRate}/255) → ${ball} (${why}). Alt: Quick Ball if you throw right away.`,
      broadcasterId,
    );
  } catch {
    // advisory only — never break chat handling
  }
}

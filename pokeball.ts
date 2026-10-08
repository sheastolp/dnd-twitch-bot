// Pokéball advisor — watches the Pokémon Community Game bot
// (PokemonCommunityGame) and, when it announces a spawn ("A wild Ralts
// appears … Catch it using !pokecatch"), replies with the ball to throw.
// Off by default per channel; !ball on/off/status (mod/broadcaster).
//
// The pick uses the species' real data from PokeAPI (types, weight, base
// stats, catch rate, legendary/mythical; cached per isolate) against the
// channel's ball list (pokeball_db.ts — built-in core balls plus whatever
// mods add on /dashboard/pokeballs, pokeball_page.ts). Each ball has a rule
// (works on anything, better against certain types, heavy, fast, hard or
// easy catches, legendaries, or timing) and a catch multiplier. Of the balls
// whose rule fits, the advisor suggests the weakest one that still gives a
// good chance (catch rate × multiplier ≥ 60% of 255), so good balls are kept
// for hard catches; if none gets there, the strongest. Balls of 100× or more
// (Master Ball) are only suggested for legendaries. A timing ball (Quick
// Ball) is offered as the alternative.
//
// Unknown balls: when a viewer throws one the channel doesn't know
// (!pokecatch duskball), or PokemonCommunityGame mentions one, it's recorded
// as pending on the dashboard page, and the first time a viewer uses it the
// advisor asks chat what it does so a mod can teach it there.
//
// PokemonCommunityGame is a bot account, so its messages reach this through
// the bot branch in main.ts (maybePokeballAdvice), never the command router.

import { getBroadcaster, isChannelBlocked, isChannelEnabled } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";
import {
  type Ball,
  ballKey,
  ballNameFromKey,
  isPokeballEnabled,
  listBalls,
  recordUnknownBall,
  setPokeballEnabled,
} from "./pokeball_db.ts";

export { ensurePokeballTables, purgePokeballData } from "./pokeball_db.ts";

export const POKEMON_GAME_BOT = "pokemoncommunitygame";

/** Catch rate × multiplier, out of 255, that counts as "a good chance". */
const GOOD_CHANCE = 0.6;
/** Balls this strong are saved for legendaries. */
const RESERVE_MULT = 100;
/** At most one "what's that ball?" question per channel this often. */
const ASK_COOLDOWN_MS = 2 * 60_000;

/** !ball on|off|status, !ball balls, !ball unknown, !ball <Pokémon>. */
export async function handlePokeballCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!ball(?:\s+(.+))?$/i);
  if (!m) return false;
  const arg = (m[1] ?? "status").trim();
  const action = arg.toLowerCase();
  const say = (text: string) => sendChatMessage(`@${display} ${text}`, broadcasterId);

  if (action === "status") {
    const on = await isPokeballEnabled(broadcasterId);
    await say(`🔴 The Pokéball advisor is ${on ? "on — I'll suggest a ball whenever PokemonCommunityGame spawns a Pokémon" : "off in this channel"}.${isModerator ? ` Mods: !ball ${on ? "off" : "on"}; edit the balls on !dashboard → 🔴 Pokéballs.` : ""}`);
    return true;
  }
  if (action === "on" || action === "off") {
    if (!isModerator) {
      await say("only the broadcaster or a moderator can turn the Pokéball advisor on or off.");
    } else {
      await setPokeballEnabled(broadcasterId, action === "on");
      await say(action === "on"
        ? "🔴 Pokéball advisor on! When PokemonCommunityGame spawns a Pokémon I'll suggest which ball to throw. Mods can add balls on !dashboard → 🔴 Pokéballs."
        : "Pokéball advisor off.");
    }
    return true;
  }

  // Everything else only answers while the module is on.
  if (!(await isPokeballEnabled(broadcasterId))) return false;
  const balls = await listBalls(broadcasterId);
  if (action === "balls" || action === "list") {
    const known = balls.filter((b) => b.status === "active").map((b) => b.name);
    await say(`🔴 Balls I know: ${known.join(", ")}.`);
    return true;
  }
  if (action === "unknown" || action === "pending") {
    const pending = balls.filter((b) => b.status === "pending");
    await say(pending.length
      ? `🔴 Balls I don't know yet: ${pending.map((b) => b.name).join(", ")}. Mods can teach them on !dashboard → 🔴 Pokéballs.`
      : "🔴 No unknown balls — I know every ball chat has used.");
    return true;
  }
  // !ball <Pokémon> — the same suggestion a spawn gets.
  await sendChatMessage(await adviceFor(arg.slice(0, 40), balls), broadcasterId);
  return true;
}

/** The Pokémon name from a spawn announcement, or null if it isn't one. */
export function parseSpawn(text: string): string | null {
  const m = text.match(/\bA wild (.+?) (?:appears|appeared|has appeared)\b/i);
  if (!m) return null;
  const name = m[1].replace(/[!.]+$/, "").trim();
  return name && name.length <= 40 ? name : null;
}

const NOT_BALL_WORDS = new Set(["a", "an", "the", "any", "your", "this", "that", "no", "one", "each", "every", "my", "their", "his", "her", "of", "with", "and", "foot", "base", "snow", "basket", "hair"]);

/** Ball keys mentioned in a message: "Dusk Ball", "duskball". */
export function ballsMentioned(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^a-zé])([a-zé]+)\s?ball(?:s)?\b/gi)) {
    const word = m[1].toLowerCase();
    if (!NOT_BALL_WORDS.has(word)) keys.add(ballKey(word));
  }
  return [...keys].filter((k) => k.length > 4 && k.length <= 24);
}

/** The ball a viewer threw: "!pokecatch dusk ball" / "!pokecatch duskball" / "!pokecatch dusk" → "duskball". */
export function thrownBall(text: string): string | null {
  const m = text.trim().match(/^!pokecatch\s+([a-zé]+)(?:\s?ball)?\b/i);
  if (!m) return null;
  const key = ballKey(m[1]);
  return key.length > 4 && key.length <= 24 ? key : null;
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

export interface PokeInfo {
  name: string;
  types: string[];
  weightKg: number;
  speed: number;
  captureRate: number;
  legendary: boolean;
}

const cache = new Map<string, PokeInfo>();

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
    let species: any = null;
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
  // Only hits are cached (a failed lookup is retried next time), with a small cap.
  if (info) {
    if (cache.size > 500) cache.clear();
    cache.set(key, info);
  }
  return info;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Why this ball fits this Pokémon ("" for a ball that works on anything), or null if its rule doesn't apply. */
export function ballFits(b: Ball, p: PokeInfo): string | null {
  const n = Number(b.value);
  switch (b.rule) {
    case "always": return "";
    case "types": {
      const hit = p.types.find((t) => b.value.toLowerCase().split(/[\s,]+/).includes(t));
      return hit ? `${cap(hit)} type` : null;
    }
    case "heavy": return p.weightKg >= n ? `heavy (${p.weightKg} kg)` : null;
    case "fast": return p.speed >= n ? `fast (base Speed ${p.speed})` : null;
    case "hardcatch": return p.captureRate <= n ? "hard catch" : null;
    case "easycatch": return p.captureRate >= n ? "easy catch" : null;
    case "legendary": return p.legendary ? "legendary" : null;
    default: return null; // timing, unknown
  }
}

/** The ball to throw, why, and a timing ball to offer as the alternative. */
export function recommendBall(p: PokeInfo, balls: Ball[]): { ball: string; why: string; alt: Ball | null } {
  const active = balls.filter((b) => b.status === "active");
  const alt = active.filter((b) => b.rule === "timing").sort((a, b) => b.mult - a.mult)[0] ?? null;
  // Weakest first; on a tie a ball that works on anything comes first (it's the cheaper kind).
  const fits = active
    .map((b) => ({ b, why: ballFits(b, p) }))
    .filter((c): c is { b: Ball; why: string } => c.why !== null && (p.legendary || c.b.mult < RESERVE_MULT))
    .sort((x, y) => x.b.mult - y.b.mult || (x.why ? 1 : 0) - (y.why ? 1 : 0));
  if (!fits.length) return { ball: "Poké Ball", why: "no other ball fits", alt };
  const chance = (mult: number) => (p.captureRate * mult) / 255;
  const pick = p.legendary
    ? fits[fits.length - 1]
    : fits.find((c) => chance(c.b.mult) >= GOOD_CHANCE) ?? fits[fits.length - 1];
  let why = pick.why;
  if (!why) why = p.captureRate >= 150 ? "easy catch — save your good balls" : p.captureRate >= 75 ? "medium catch" : "tough catch";
  if (p.legendary && pick.why !== "legendary") why = `legendary — ${why}`;
  return { ball: pick.b.name, why, alt };
}

async function adviceFor(name: string, balls: Ball[]): Promise<string> {
  const info = await lookupPokemon(name);
  if (!info) return `🔴 ${name}? I couldn't look it up — try a Great Ball, or a Quick Ball thrown right away.`;
  const { ball, why, alt } = recommendBall(info, balls);
  const types = info.types.map(cap).join("/");
  const altText = alt && alt.name !== ball ? ` Alt: ${alt.name}${alt.note ? ` — ${alt.note.replace(/\.$/, "")}` : ""}.` : "";
  return `🔴 Wild ${name} (${types}, catch rate ${info.captureRate}/255) → ${ball} (${why}).${altText}`;
}

/** Whether the advisor may talk in this channel right now. */
async function advisorLive(broadcasterId: string): Promise<boolean> {
  const [on, connection, blocked, channelOn] = await Promise.all([
    isPokeballEnabled(broadcasterId),
    getBroadcaster(broadcasterId),
    isChannelBlocked(broadcasterId),
    isChannelEnabled(broadcasterId),
  ]);
  if (!on || !connection || Number(connection.connected) !== 1 || blocked || !channelOn) return false;
  return Number(connection.is_live) === 1; // quiet while offline, like other ambient sends
}

/**
 * Called for every bot-account chat message (main.ts). Replies with a ball
 * suggestion when PokemonCommunityGame announces a spawn, and notes any
 * ball it mentions that this channel doesn't know. Never throws.
 */
export async function maybePokeballAdvice(broadcasterId: string, chatter: string, text: string): Promise<void> {
  try {
    if (chatter.toLowerCase() !== POKEMON_GAME_BOT) return;
    const name = parseSpawn(text);
    const mentioned = ballsMentioned(text);
    if (!name && !mentioned.length) return;
    if (!(await advisorLive(broadcasterId))) return;
    const balls = await listBalls(broadcasterId);
    const known = new Set(balls.map((b) => b.key));
    // Unknown balls the game mentions are listed on the page quietly — only a viewer's throw asks chat.
    for (const key of mentioned) if (!known.has(key)) await recordUnknownBall(broadcasterId, key, POKEMON_GAME_BOT);
    if (name) await sendChatMessage(await adviceFor(name, balls), broadcasterId);
  } catch {
    // advisory only — never break chat handling
  }
}

const lastAsk = new Map<string, number>();

/**
 * Called for viewers' chat messages (main.ts). When someone throws a ball
 * this channel doesn't know (!pokecatch duskball), it goes on the page's
 * unknown list, and the first time, chat is asked what it does. Never
 * claims the message — PokemonCommunityGame still gets it. Never throws.
 */
export async function maybeAskAboutBall(broadcasterId: string, chatter: string, text: string): Promise<void> {
  try {
    const key = thrownBall(text);
    if (!key || !(await advisorLive(broadcasterId))) return;
    const balls = await listBalls(broadcasterId);
    if (balls.some((b) => b.key === key && b.status !== "pending")) return;
    const first = await recordUnknownBall(broadcasterId, key, chatter);
    const now = Date.now();
    if (!first || now - (lastAsk.get(broadcasterId) ?? 0) < ASK_COOLDOWN_MS) return;
    lastAsk.set(broadcasterId, now);
    await sendChatMessage(
      `🔴 @${chatter} I don't know the ${ballNameFromKey(key)} yet — what does it do? (Better against a type? Heavy or fast Pokémon? Hard catches? Timing?) Mods can teach me on !dashboard → 🔴 Pokéballs.`,
      broadcasterId,
    );
  } catch {
    // advisory only
  }
}

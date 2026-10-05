// Channel-point redemptions that reach into the game.
//
// A streamer links a Twitch channel-point reward (by its exact title) to one
// of two effects with !boon, and from then on every redemption of that reward
// is applied automatically:
//
//   shield   — the redeemer cannot be targeted by !rob for N minutes.
//   lockout  — the redeemer picks another viewer and a feature (typed into
//              the reward's text box as "<user> <feature>", e.g. "bob rob"),
//              and that viewer cannot use that feature for N minutes.
//
//   !boon add shield <minutes> <reward title>      (mod)
//   !boon add lockout <minutes> <reward title>     (mod)
//   !boon remove <reward title>                    (mod)
//   !boon clear @user                              (mod — drops every active effect)
//   !boon list                                     (everyone — what each reward does)
//   !boon status [@user]                           (everyone — active effects)
//
// Notes:
//   - Needs the broadcaster to (re)connect once so GuildScribe is granted the
//     channel:read:redemptions scope (see /connect in main.ts).
//   - Read-only: the bot cannot fulfil or refund redemptions of rewards it did
//     not create (a Twitch rule), so a malformed lockout is reported in chat
//     and a mod refunds it from the rewards queue.
//   - Timed effects stack by extension (buy a shield while shielded and the
//     time is added), capped at MAX_EFFECT_MS per effect.
//   - The broadcaster, the bot and yourself cannot be locked out.
//   - Command named !boon because StreamElements already owns !redeem.

import { getBroadcaster, isChannelBlocked, isChannelEnabled, saveExtraEventSubSubscription } from "./db.ts";
import { createRedemptionEventSubscription, sendChatMessage } from "./twitch.ts";
import { isChannelBot } from "./channel_bots.ts";
import {
  clearEffects,
  getEffectRemainingMs,
  getRewardMapping,
  grantEffect,
  listActiveEffects,
  listRewardMappings,
  MAX_EFFECT_MS,
  removeRewardMapping,
  saveRewardMapping,
} from "./redemptions_db.ts";

const USERNAME_RE = /^[a-z0-9_]{1,25}$/;
const MAX_MINUTES = Math.floor(MAX_EFFECT_MS / 60000);
const MAX_TITLE = 45; // Twitch's own reward-title limit

// ── Lockable features ──
// `test` decides whether a chat message is "using" the feature; `aliases` are
// the words a redeemer may type for it.

interface LockableFeature {
  label: string;
  aliases: string[];
  test: (message: string) => boolean;
}

export const LOCKABLE_FEATURES: Record<string, LockableFeature> = {
  rob: { label: "!rob", aliases: ["rob", "robbing", "robbery"], test: (m) => /^!rob(?:\s|$)/i.test(m) },
  haggle: { label: "!haggle", aliases: ["haggle", "haggling"], test: (m) => /^!haggle(?:\s|$)/i.test(m) },
  duel: {
    label: "duels & party hunts (!dndduel)",
    aliases: ["duel", "duels", "dndduel"],
    test: (m) => /^!dndduel(?:\s|$)/i.test(m) || /^!party\s+hunt(?:\s|$)/i.test(m),
  },
  autohunt: {
    label: "!autohunt",
    aliases: ["autohunt"],
    test: (m) => /^!autohunt(?:\s|$)/i.test(m) && !/^!autohunt\s+(?:status|stop)\b/i.test(m),
  },
  dice: { label: "dice (!roll)", aliases: ["dice", "roll", "rolls", "d20"], test: (m) => /^!(?:roll|r|d20)(?:\s|$)/i.test(m) },
  gold: {
    label: "coin & giveaways (!gold)",
    aliases: ["gold", "coin", "coins", "giveaway"],
    test: (m) => /^!(?:gold|goldboard|giveaway)(?:\s|$)/i.test(m),
  },
};

function resolveFeature(word: string): string | null {
  const w = word.toLowerCase().replace(/^!/, "");
  for (const [key, def] of Object.entries(LOCKABLE_FEATURES)) {
    if (key === w || def.aliases.includes(w)) return key;
  }
  return null;
}

/** Which lockable feature (if any) a chat message is using. */
export function featureForMessage(chatMessage: string): string | null {
  const m = chatMessage.trim();
  if (!m.startsWith("!")) return null;
  for (const [key, def] of Object.entries(LOCKABLE_FEATURES)) if (def.test(m)) return key;
  return null;
}

/** Parses the reward's text box: "<user> <feature>" (either order, @/! optional). */
export function parseLockInput(input: string): { target: string; feature: string } | null {
  let target: string | null = null;
  let feature: string | null = null;
  for (const raw of input.trim().split(/\s+/)) {
    const token = raw.replace(/^[@!]/, "").toLowerCase();
    if (!token) continue;
    const asFeature = resolveFeature(token);
    if (asFeature && !feature) feature = asFeature;
    else if (!target && USERNAME_RE.test(token)) target = token;
  }
  return target && feature ? { target, feature } : null;
}

function waitText(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

// ── Flavor ──
// {user} {target} {feature} {mins}. Each pool has 20+ unique D&D lines.

export const SHIELD_LINES = [
  "🛡️ {user} is wrapped in a ward of Mage Armor — no pickpocket may touch their purse for {mins}.",
  "✨ A Sanctuary spell settles over {user}. Thieves look away from their purse for {mins}.",
  "🔒 {user} casts Arcane Lock on their coin pouch. It stays sealed against robbers for {mins}.",
  "🐉 A dragon-scale purse cover materialises on {user}'s belt — robbers are turned away for {mins}.",
  "💪 {user} hires a hulking dwarven bodyguard for {mins}. Pickpockets, beware.",
  "🧿 A Glyph of Warding blazes over {user}'s coin purse. Robbery is off the table for {mins}.",
  "🏰 {user} retreats behind the guild's iron gate — no robber may reach them for {mins}.",
  "🐕 {user} buys a guard mastiff with a nasty bite. Thieves keep their distance for {mins}.",
  "📜 {user} signs a charter with the Thieves' Guild: hands off their purse for {mins}.",
  "🪄 Mordenkainen's Private Sanctum settles over {user}. Nothing gets in for {mins}.",
  "🔔 {user} wires their purse with an Alarm spell. Any would-be robber thinks twice for {mins}.",
  "🧱 A Wall of Force hums around {user} — no robbery attempts get through for {mins}.",
  "🙏 {user} raises a Shield of Faith, and their coin is safe from robbers for {mins}.",
  "🗝️ {user} stashes their gold in a Secret Chest. Nothing to steal for {mins}.",
  "🦉 {user}'s familiar keeps an owl-eyed watch over their purse for {mins}.",
  "⚔️ A paladin swears an oath to guard {user}'s purse for {mins}.",
  "🌿 {user} wanders into a druid's grove — robbers can't follow for {mins}.",
  "🕯️ {user} burns a candle at the temple of Tyr. Robbery is forbidden near them for {mins}.",
  "🪤 {user} sets mimic-trapped coin bags all over camp. Thieves are warned off for {mins}.",
  "🏯 {user} hires the town watch to patrol their stall for {mins}. No robberies, citizens!",
];

export const LOCKOUT_LINES = [
  "🔮 {user} hexes {target}! They can't use {feature} for {mins}.",
  "⛓️ {user} binds {target} in a Hold Person spell — {feature} is off limits for {mins}.",
  "🤐 {user} casts Silence on {target}: no {feature} for {mins}.",
  "👻 A curse from {user} falls on {target}. {feature} is barred for {mins}.",
  "📜 {user} bribes the guild clerk — {target} is struck from the {feature} rolls for {mins}.",
  "🧙 {user} slips a Bestow Curse on {target}. {feature} fails them for {mins}.",
  "🚪 {user} bars the door: {target} cannot use {feature} for {mins}.",
  "🕸️ {user} snares {target} in a web of spider silk — {feature} is out for {mins}.",
  "😈 A warlock pact is invoked by {user}: {target} loses {feature} for {mins}.",
  "🧊 {user} freezes {target} in place with a Ray of Frost. No {feature} for {mins}.",
  "🐑 {user} Polymorphs {target} into a sheep. Sheep can't use {feature} for {mins}.",
  "⚖️ The guild magistrate, nudged by {user}, bans {target} from {feature} for {mins}.",
  "🌑 {user} casts Darkness over {target}, who cannot find {feature} for {mins}.",
  "🦇 {user} sends a swarm of bats to harry {target} — {feature} is impossible for {mins}.",
  "🔥 {user} sets {target}'s spellbook ablaze. No {feature} for {mins}.",
  "🧂 {user} sprinkles a ring of salt around {target} — {feature} is banished for {mins}.",
  "💤 {user} lulls {target} with Sleep. They can't use {feature} for {mins}.",
  "🗡️ {user} calls in a favor at the Thieves' Guild: {target} is shut out of {feature} for {mins}.",
  "🧿 {user} lays a Geas on {target}: no {feature} for {mins}.",
  "📯 The town crier, paid by {user}, announces {target} is forbidden from {feature} for {mins}.",
];

function fill(line: string, vars: Record<string, string>): string {
  return line.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

// ── Connect-time subscription ──

/** Best-effort EventSub subscription for redemptions, called from /connect.
 * Throws if the channel hasn't granted channel:read:redemptions yet. */
export async function subscribeToRedemptions(broadcasterId: string, callbackUrl: string) {
  const sub = await createRedemptionEventSubscription(broadcasterId, callbackUrl);
  await saveExtraEventSubSubscription(broadcasterId, "redemption", sub.id);
}

// ── EventSub: a viewer redeemed a reward ──

// deno-lint-ignore no-explicit-any
export async function handleRedemptionEvent(event: any): Promise<void> {
  const broadcasterId = String(event?.broadcaster_user_id ?? "");
  const title = String(event?.reward?.title ?? "");
  const redeemer = String(event?.user_login ?? "").toLowerCase();
  const display = String(event?.user_name ?? redeemer);
  if (!broadcasterId || !title || !redeemer) return;

  // Rewards the bot has no mapping for are none of its business.
  const mapping = await getRewardMapping(broadcasterId, title);
  if (!mapping) return;

  const botId = Deno.env.get("TWITCH_BOT_ID") ?? "";
  if (await isChannelBot(broadcasterId, redeemer, String(event?.user_id ?? ""), botId)) return;
  const connection = await getBroadcaster(broadcasterId);
  if (!connection || Number(connection.connected) !== 1) return;
  if (await isChannelBlocked(broadcasterId)) return;
  if (!(await isChannelEnabled(broadcasterId))) return;

  if (mapping.effect === "shield") {
    const expiresAt = await grantEffect(broadcasterId, redeemer, "shield", mapping.minutes * 60_000, redeemer);
    await sendChatMessage(
      fill(pick(SHIELD_LINES), { user: `@${display}`, mins: waitText(expiresAt - Date.now()) }),
      broadcasterId,
    );
    return;
  }

  // lockout
  const parsed = parseLockInput(String(event?.user_input ?? ""));
  const featureNames = Object.keys(LOCKABLE_FEATURES).join(", ");
  if (!parsed) {
    await sendChatMessage(
      `@${display} your "${title}" redemption needs "<user> <feature>" in its text box (e.g. "bob rob"). Features: ${featureNames}. A mod can refund it from the rewards queue.`,
      broadcasterId,
    );
    return;
  }
  const broadcasterLogin = String(connection.login ?? "").toLowerCase();
  if (parsed.target === redeemer) {
    await sendChatMessage(`@${display} you can't hex yourself — a mod can refund "${title}" from the rewards queue.`, broadcasterId);
    return;
  }
  if (parsed.target === broadcasterLogin || await isChannelBot(broadcasterId, parsed.target, "", botId)) {
    await sendChatMessage(
      `@${display} that target is protected by powers beyond any hex — a mod can refund "${title}" from the rewards queue.`,
      broadcasterId,
    );
    return;
  }
  const expiresAt = await grantEffect(
    broadcasterId,
    parsed.target,
    `lock:${parsed.feature}`,
    mapping.minutes * 60_000,
    redeemer,
  );
  await sendChatMessage(
    fill(pick(LOCKOUT_LINES), {
      user: `@${display}`,
      target: `@${parsed.target}`,
      feature: LOCKABLE_FEATURES[parsed.feature].label,
      mins: waitText(expiresAt - Date.now()),
    }),
    broadcasterId,
  );
}

// ── Chat gate: is this viewer locked out of the command they just typed? ──

/** Returns a chat notice (without the @name) if the chatter is locked out of
 * the feature their message uses, else null. Costs no DB read unless the
 * message is a lockable command. */
export async function checkFeatureLock(chatMessage: string, chatter: string, broadcasterId: string): Promise<string | null> {
  const feature = featureForMessage(chatMessage);
  if (!feature) return null;
  const left = await getEffectRemainingMs(broadcasterId, chatter, `lock:${feature}`);
  if (left <= 0) return null;
  return `a hex keeps you from ${LOCKABLE_FEATURES[feature].label} for another ${waitText(left)}.`;
}

/** Shield check for !rob: ms left on the target's robbery shield (0 = none). */
export async function robShieldRemainingMs(broadcasterId: string, target: string): Promise<number> {
  return await getEffectRemainingMs(broadcasterId, target, "shield");
}

// ── !boon ──

function describeEffect(effect: string): string {
  if (effect === "shield") return "🛡️ robbery shield";
  const feature = effect.startsWith("lock:") ? effect.slice(5) : "";
  const def = LOCKABLE_FEATURES[feature];
  return `🔮 hexed from ${def ? def.label : feature}`;
}

/** Handles !boon. Returns true if it consumed the message. */
export async function handleBoonCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const match = chatMessage.trim().match(/^!boon(?:\s+([\s\S]*))?$/i);
  if (!match) return false;
  const args = (match[1] ?? "").trim();
  const sub = (args.split(/\s+/)[0] ?? "").toLowerCase();
  const rest = args.slice(sub.length).trim();

  if (sub === "" || sub === "status") {
    const who = rest.replace(/^@/, "").toLowerCase();
    const name = sub === "status" && who && USERNAME_RE.test(who) ? who : chatter.toLowerCase();
    const label = name === chatter.toLowerCase() ? "you have" : `${name} has`;
    const active = await listActiveEffects(broadcasterId, name);
    if (!active.length) {
      const hint = sub === "" && isModerator
        ? " Mods: !boon add shield|lockout <minutes> <reward title> | !boon remove <title> | !boon clear @user | !boon list."
        : "";
      await sendChatMessage(`@${display} ${label} no active boons or hexes.${hint}`, broadcasterId);
    } else {
      await sendChatMessage(
        `@${display} ${label}: ${active.map((a) => `${describeEffect(a.effect)} (${waitText(a.remainingMs)})`).join(" | ")}`,
        broadcasterId,
      );
    }
    return true;
  }

  if (sub === "list") {
    const rewards = await listRewardMappings(broadcasterId);
    if (!rewards.length) {
      await sendChatMessage(`@${display} no channel-point rewards are linked to GuildScribe yet.`, broadcasterId);
    } else {
      const parts = rewards.map((r) =>
        `"${r.title}" → ${r.effect === "shield" ? "robbery shield" : "lockout"} ${r.minutes}m`
      );
      await sendChatMessage(`@${display} linked rewards: ${parts.join(" | ")}`, broadcasterId);
    }
    return true;
  }

  // Everything below changes configuration: mods and the broadcaster only.
  if (!["add", "remove", "clear"].includes(sub)) {
    await sendChatMessage(`@${display} usage: !boon status [@user] | !boon list${isModerator ? " | !boon add shield|lockout <minutes> <reward title> | !boon remove <title> | !boon clear @user" : ""}`, broadcasterId);
    return true;
  }
  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can change linked rewards.`, broadcasterId);
    return true;
  }

  if (sub === "add") {
    const add = rest.match(/^(shield|lockout)\s+(\d+)\s+([\s\S]+)$/i);
    if (!add) {
      await sendChatMessage(`@${display} usage: !boon add shield|lockout <minutes> <exact reward title>`, broadcasterId);
      return true;
    }
    const effect = add[1].toLowerCase() as "shield" | "lockout";
    const minutes = Number(add[2]);
    const title = add[3].trim().replace(/\s+/g, " ");
    if (minutes < 1 || minutes > MAX_MINUTES) {
      await sendChatMessage(`@${display} minutes must be between 1 and ${MAX_MINUTES}.`, broadcasterId);
      return true;
    }
    if (title.length > MAX_TITLE) {
      await sendChatMessage(`@${display} Twitch reward titles are at most ${MAX_TITLE} characters.`, broadcasterId);
      return true;
    }
    await saveRewardMapping(broadcasterId, title, effect, minutes);
    await sendChatMessage(
      effect === "shield"
        ? `@${display} linked "${title}" → robbery shield for ${minutes}m. The title must match the Twitch reward exactly (case ignored).`
        : `@${display} linked "${title}" → lockout for ${minutes}m. Make the reward require viewer input; viewers type "<user> <feature>" (features: ${Object.keys(LOCKABLE_FEATURES).join(", ")}).`,
      broadcasterId,
    );
    return true;
  }

  if (sub === "remove") {
    if (!rest) {
      await sendChatMessage(`@${display} usage: !boon remove <reward title>`, broadcasterId);
      return true;
    }
    const removed = await removeRewardMapping(broadcasterId, rest);
    await sendChatMessage(
      removed ? `@${display} unlinked "${rest}".` : `@${display} no linked reward called "${rest}" — see !boon list.`,
      broadcasterId,
    );
    return true;
  }

  // clear
  const target = rest.replace(/^@/, "").toLowerCase();
  if (!USERNAME_RE.test(target)) {
    await sendChatMessage(`@${display} usage: !boon clear @user`, broadcasterId);
    return true;
  }
  const cleared = await clearEffects(broadcasterId, target);
  await sendChatMessage(
    cleared ? `@${display} lifted ${cleared} boon${cleared === 1 ? "" : "s"}/hex${cleared === 1 ? "" : "es"} from ${target}.` : `@${display} ${target} has nothing active to lift.`,
    broadcasterId,
  );
  return true;
}

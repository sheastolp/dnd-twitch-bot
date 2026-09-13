// Custom commands & chat triggers — lets a broadcaster/mod add their own
// !commands and passive keyword auto-responses without touching code.
//
// NOTE: this reuses the "!dndbot" word already used for on/off/status/leave
// (see main.ts) as a second-level namespace. Those exact phrases are matched
// and handled earlier in main.ts and never reach this module, so there's no
// collision — but keep any new subcommand word here off that list too.
//
//   !dndbot add <name> <response>      (mod) create a new !name → response
//   !dndbot edit <name> <response>     (mod) change an existing one
//   !dndbot remove <name>              (mod) delete one
//   !dndbot cooldown <name> <seconds>  (mod) per-command cooldown (0-3600s)
//   !dndbot list                       anyone — list configured command names
//
//   !trigger add <keyword> <response>      (mod) fire <response> whenever
//                                           <keyword> appears in chat (no !)
//   !trigger remove <keyword>              (mod)
//   !trigger cooldown <keyword> <seconds>  (mod)
//   !trigger list                          anyone
//
// Responses support several placeholders:
//   {user} {sender}   display name of whoever triggered it ({sender} is an
//                     alias of {user})
//   {target}          first @mentioned user in a !command's arguments (falls
//                     back to {user} for triggers, which have no arguments)
//   {touser}          first word of the arguments with a leading @ stripped
//                     (falls back to {user} if there are no arguments)
//   {args}            the full text after the command, or the whole message
//                     for a trigger
//   {count}           how many times this command/trigger has now fired
//   {random:a|b|c}    picks one option at random (max 5 per response)
//   {randnum:MIN-MAX} random integer in [MIN, MAX], negatives allowed
//   {d4} {d6} {d8} {d10} {d12} {d20} {d100}  shorthand die-roll expansions
//   {repeat:N|text}   repeats text back-to-back N times (N capped at 10)
//   {math:expr}       evaluates a numeric expression (digits, + - * / % ( ) . only)
//   {channel}         the broadcaster's display name (from the broadcasters
//                     table — no extra Twitch API call)
//   {time}            current UTC time, HH:MM
//   {date}            current UTC date, YYYY-MM-DD
//   {game} {title} {status} {uptime}  live channel info via Twitch Helix
//                     using the existing app token — {status} is "live" or
//                     "offline", {uptime} is "offline" when not live
//   {twitchemotes} {7tvemotes} {bttvemotes} {ffzemotes}  a random emote from
//                     that provider's set for this channel (public,
//                     unauthenticated provider APIs)
//
// Every placeholder that needs a network or DB call is only resolved when it
// actually appears in the response text, so a plain response with none of
// them costs nothing extra.

import { pick, compactText } from "./utils.ts";
import { sendChatMessage, sendChatMessages, getAppToken, getChannelInfo, getStreamUptime, env } from "./twitch.ts";
import {
  addCustomCommand,
  addCustomTrigger,
  deleteCustomCommand,
  deleteCustomTrigger,
  getBroadcaster,
  listCustomCommands,
  listCustomTriggers,
  markCustomTriggerUsed,
  editCustomCommand,
  setCustomCommandCooldown,
  setCustomTriggerCooldown,
  useCustomCommand,
} from "./db.ts";

const MAX_CUSTOM_RESPONSE_LEN = 400;
const MAX_COOLDOWN_SECONDS = 3600;
const MAX_RANDOM_BLOCKS = 5;
const MAX_RANDOM_OPTIONS_LEN = 300;
const MAX_REPEAT_COUNT = 10;
const MAX_MATH_EXPR_LEN = 60;

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function getRandomTwitchGlobalEmote(): Promise<string | null> {
  try {
    const token = await getAppToken();
    const res = await fetch("https://api.twitch.tv/helix/chat/emotes/global", {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": env("TWITCH_CLIENT_ID") },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const emotes = (data?.data ?? []) as Array<{ name: string }>;
    return emotes.length ? pick(emotes.map((e) => e.name)) : null;
  } catch (err) {
    console.error("getRandomTwitchGlobalEmote failed", err);
    return null;
  }
}

async function getRandom7tvEmote(broadcasterId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://7tv.io/v3/users/twitch/${broadcasterId}`);
    if (!res.ok) return null;
    const data = await res.json();
    const emotes = (data?.emote_set?.emotes ?? []) as Array<{ name: string }>;
    return emotes.length ? pick(emotes.map((e) => e.name)) : null;
  } catch (err) {
    console.error("getRandom7tvEmote failed", err);
    return null;
  }
}

async function getRandomBttvEmote(broadcasterId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${broadcasterId}`);
    if (!res.ok) return null;
    const data = await res.json();
    const emotes = [
      ...((data?.channelEmotes ?? []) as Array<{ code: string }>),
      ...((data?.sharedEmotes ?? []) as Array<{ code: string }>),
    ];
    return emotes.length ? pick(emotes.map((e) => e.code)) : null;
  } catch (err) {
    console.error("getRandomBttvEmote failed", err);
    return null;
  }
}

async function getRandomFfzEmote(broadcasterId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.frankerfacez.com/v1/room/id/${broadcasterId}`);
    if (!res.ok) return null;
    const data = await res.json();
    const sets = (data?.sets ?? {}) as Record<string, { emoticons?: Array<{ name: string }> }>;
    const all = Object.values(sets).flatMap((s) => s.emoticons?.map((e) => e.name) ?? []);
    return all.length ? pick(all) : null;
  } catch (err) {
    console.error("getRandomFfzEmote failed", err);
    return null;
  }
}

// Every built-in command word (and a few words reserved for future/adjacent
// features, e.g. undocumented or not-yet-loaded modules) so custom commands
// can never shadow or be confused with the bot's own commands.
const RESERVED_NAMES = new Set([
  "roll", "r", "d20", "bg3roll", "bg3", "bg3companion", "bg3origin", "bg3loot", "bg3camp", "bg3lookup",
  "createchar", "newchar", "answer", "cancel", "char", "hp", "savechar", "loadchar", "resetchar",
  "levelup", "spell", "item", "class", "feat", "ability", "race", "subrace", "rule", "rules",
  "dndduel", "turn", "party", "dndbot", "dndbothelp", "logs", "connections", "help", "link", "guide",
  "cmd", "trigger", "command", "commands", "hug", "map", "mod", "admin", "bot",
]);

const NAME_RE = /^[a-z0-9_-]{2,25}$/;

export function sanitizeCommandName(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/^!/, "");
  return NAME_RE.test(name) ? name : null;
}

export function sanitizeTriggerKeyword(raw: string): string | null {
  const keyword = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!/^[\p{L}\p{N} '!?.-]{2,40}$/u.test(keyword)) return null;
  if (keyword.split(" ").length > 5) return null;
  return keyword;
}

async function applyTemplate(
  response: string,
  vars: {
    user: string;
    broadcasterId: string;
    target?: string;
    touser?: string;
    args?: string;
    count?: number;
  },
): Promise<string> {
  let randomBlocks = 0;
  let out = response.replace(new RegExp(`\\{random:([^{}]{1,${MAX_RANDOM_OPTIONS_LEN}})\\}`, "gi"), (_match, options: string) => {
    randomBlocks++;
    if (randomBlocks > MAX_RANDOM_BLOCKS) return "";
    const choices = options.split("|").map((s: string) => s.trim()).filter(Boolean);
    return choices.length ? pick(choices) : "";
  });

  out = out.replace(/\{randnum:(-?\d+)-(-?\d+)\}/gi, (_match, a: string, b: string) => {
    const lo = Math.min(Number(a), Number(b));
    const hi = Math.max(Number(a), Number(b));
    return String(randomInt(lo, hi));
  });

  out = out.replace(/\{d(4|6|8|10|12|20|100)\}/gi, (_match, sides: string) => String(randomInt(1, Number(sides))));

  out = out.replace(/\{repeat:(\d{1,2})\|([^{}]{1,100})\}/gi, (_match, n: string, text: string) => {
    const count = Math.min(MAX_REPEAT_COUNT, Math.max(0, Number.parseInt(n, 10) || 0));
    return text.repeat(count).slice(0, MAX_CUSTOM_RESPONSE_LEN);
  });

  out = out.replace(new RegExp(`\\{math:([0-9+\\-*/%.()\\s]{1,${MAX_MATH_EXPR_LEN}})\\}`, "gi"), (_match, expr: string) => {
    try {
      // deno-lint-ignore no-new-func
      const result = new Function(`"use strict"; return (${expr});`)();
      return Number.isFinite(result) ? String(Math.round(result * 1000) / 1000) : "?";
    } catch {
      return "?";
    }
  });

  const now = new Date();
  out = out.replaceAll("{time}", now.toISOString().slice(11, 16) + " UTC");
  out = out.replaceAll("{date}", now.toISOString().slice(0, 10));

  if (out.includes("{channel}")) {
    const broadcaster = await getBroadcaster(vars.broadcasterId);
    const channelName = String((broadcaster as any)?.display_name || (broadcaster as any)?.login || vars.user);
    out = out.replaceAll("{channel}", channelName);
  }

  if (out.includes("{game}") || out.includes("{title}")) {
    const info = await getChannelInfo(vars.broadcasterId);
    out = out.replaceAll("{game}", info?.gameName ?? "");
    out = out.replaceAll("{title}", info?.title ?? "");
  }

  if (out.includes("{status}") || out.includes("{uptime}")) {
    const uptime = await getStreamUptime(vars.broadcasterId);
    out = out.replaceAll("{status}", uptime ? "live" : "offline");
    out = out.replaceAll("{uptime}", uptime ?? "offline");
  }

  if (out.includes("{twitchemotes}")) out = out.replaceAll("{twitchemotes}", (await getRandomTwitchGlobalEmote()) ?? "");
  if (out.includes("{7tvemotes}")) out = out.replaceAll("{7tvemotes}", (await getRandom7tvEmote(vars.broadcasterId)) ?? "");
  if (out.includes("{bttvemotes}")) out = out.replaceAll("{bttvemotes}", (await getRandomBttvEmote(vars.broadcasterId)) ?? "");
  if (out.includes("{ffzemotes}")) out = out.replaceAll("{ffzemotes}", (await getRandomFfzEmote(vars.broadcasterId)) ?? "");

  out = out.replaceAll("{user}", vars.user);
  out = out.replaceAll("{sender}", vars.user);
  out = out.replaceAll("{target}", vars.target ?? vars.user);
  out = out.replaceAll("{touser}", vars.touser ?? vars.user);
  out = out.replaceAll("{args}", vars.args ?? "");
  out = out.replaceAll("{count}", String(vars.count ?? ""));
  return out;
}

function buildKeywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

function parseCooldownSeconds(raw: string | undefined): number | null {
  const seconds = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_COOLDOWN_SECONDS ? seconds : null;
}

async function requireModerator(display: string, broadcasterId: string, isModerator: boolean, what: string) {
  if (isModerator) return true;
  await sendChatMessage(`@${display} only the broadcaster or a moderator can manage ${what}.`, broadcasterId);
  return false;
}

async function handleDndbotCustomCommandSubcommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const parts = chatMessage.trim().split(/\s+/);
  const action = (parts[1] ?? "").toLowerCase();

  if (action === "list" || action === "") {
    const rows = await listCustomCommands(broadcasterId);
    await sendChatMessages(
      rows.length
        ? `@${display} Custom commands (${rows.length}): ${rows.map((r: any) => `!${r.name}`).join(", ")}`
        : `@${display} no custom commands yet.${isModerator ? " Add one with !dndbot add <name> <response>." : ""}`,
      broadcasterId,
    );
    return true;
  }

  if (action === "add" || action === "edit") {
    if (!(await requireModerator(display, broadcasterId, isModerator, "custom commands"))) return true;
    const match = chatMessage.match(/^!dndbot\s+(?:add|edit)\s+!?(\S+)\s+([\s\S]+)$/i);
    if (!match) {
      await sendChatMessage(`@${display} usage: !dndbot ${action} <name> <response text>`, broadcasterId);
      return true;
    }
    const name = sanitizeCommandName(match[1]);
    const response = compactText(match[2], MAX_CUSTOM_RESPONSE_LEN);
    if (!name) {
      await sendChatMessage(`@${display} command names must be 2-25 characters: letters, numbers, - or _.`, broadcasterId);
      return true;
    }
    if (RESERVED_NAMES.has(name)) {
      await sendChatMessage(`@${display} !${name} is a built-in command and can't be added or edited.`, broadcasterId);
      return true;
    }
    if (!response) {
      await sendChatMessage(`@${display} give the command a response, e.g. !dndbot add hello Welcome to the guild hall, {user}!`, broadcasterId);
      return true;
    }
    if (action === "add") {
      const result = await addCustomCommand(broadcasterId, name, response, display);
      if (!result.ok) {
        await sendChatMessage(
          result.error === "exists"
            ? `@${display} !${name} already exists — use !dndbot edit ${name} <response> to change it.`
            : `@${display} this channel's custom command limit (${result.max}) is reached — remove one with !dndbot remove <name> first.`,
          broadcasterId,
        );
        return true;
      }
      await sendChatMessage(`@${display} added !${name}.`, broadcasterId);
    } else {
      const updated = await editCustomCommand(broadcasterId, name, response);
      await sendChatMessage(
        updated ? `@${display} updated !${name}.` : `@${display} !${name} doesn't exist yet — use !dndbot add ${name} <response>.`,
        broadcasterId,
      );
    }
    return true;
  }

  if (action === "remove" || action === "delete") {
    if (!(await requireModerator(display, broadcasterId, isModerator, "custom commands"))) return true;
    const name = sanitizeCommandName(parts[2] ?? "");
    if (!name) {
      await sendChatMessage(`@${display} usage: !dndbot remove <name>`, broadcasterId);
      return true;
    }
    const removed = await deleteCustomCommand(broadcasterId, name);
    await sendChatMessage(removed ? `@${display} removed !${name}.` : `@${display} !${name} doesn't exist.`, broadcasterId);
    return true;
  }

  if (action === "cooldown") {
    if (!(await requireModerator(display, broadcasterId, isModerator, "custom commands"))) return true;
    const name = sanitizeCommandName(parts[2] ?? "");
    const seconds = parseCooldownSeconds(parts[3]);
    if (!name || seconds === null) {
      await sendChatMessage(`@${display} usage: !dndbot cooldown <name> <seconds 0-${MAX_COOLDOWN_SECONDS}>`, broadcasterId);
      return true;
    }
    const updated = await setCustomCommandCooldown(broadcasterId, name, seconds * 1000);
    await sendChatMessage(
      updated ? `@${display} !${name} cooldown set to ${seconds}s.` : `@${display} !${name} doesn't exist.`,
      broadcasterId,
    );
    return true;
  }

  await sendChatMessage(
    `@${display} Custom commands: !dndbot add <name> <response> | !dndbot edit <name> <response> | !dndbot remove <name> | !dndbot cooldown <name> <seconds> | !dndbot list — add/edit/remove/cooldown are mod-only`,
    broadcasterId,
  );
  return true;
}

async function handleTriggerSubcommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const parts = chatMessage.trim().split(/\s+/);
  const action = (parts[1] ?? "").toLowerCase();

  if (action === "list" || action === "") {
    const rows = await listCustomTriggers(broadcasterId);
    await sendChatMessages(
      rows.length
        ? `@${display} Chat triggers (${rows.length}): ${rows.map((r: any) => `"${r.keyword}"`).join(", ")}`
        : `@${display} no chat triggers yet.${isModerator ? " Add one with !trigger add <keyword> <response>." : ""}`,
      broadcasterId,
    );
    return true;
  }

  if (action === "add") {
    if (!(await requireModerator(display, broadcasterId, isModerator, "triggers"))) return true;
    const match =
      chatMessage.match(/^!trigger\s+add\s+"([^"]{2,40})"\s+([\s\S]+)$/i) ??
      chatMessage.match(/^!trigger\s+add\s+(\S+)\s+([\s\S]+)$/i);
    if (!match) {
      await sendChatMessage(
        `@${display} usage: !trigger add <keyword> <response text> (wrap multi-word keywords in quotes)`,
        broadcasterId,
      );
      return true;
    }
    const keyword = sanitizeTriggerKeyword(match[1]);
    const response = compactText(match[2], MAX_CUSTOM_RESPONSE_LEN);
    if (!keyword) {
      await sendChatMessage(`@${display} keywords must be 2-40 characters, up to 5 words.`, broadcasterId);
      return true;
    }
    if (!response) {
      await sendChatMessage(`@${display} give the trigger a response.`, broadcasterId);
      return true;
    }
    const result = await addCustomTrigger(broadcasterId, keyword, response, display);
    if (!result.ok) {
      await sendChatMessage(
        result.error === "exists"
          ? `@${display} a trigger for "${keyword}" already exists — remove it first with !trigger remove ${keyword}.`
          : `@${display} this channel's trigger limit (${result.max}) is reached.`,
        broadcasterId,
      );
      return true;
    }
    await sendChatMessage(`@${display} added trigger for "${keyword}".`, broadcasterId);
    return true;
  }

  if (action === "remove" || action === "delete") {
    if (!(await requireModerator(display, broadcasterId, isModerator, "triggers"))) return true;
    const rawKeyword = chatMessage.replace(/^!trigger\s+(?:remove|delete)\s+/i, "").replace(/^"|"$/g, "").trim();
    const keyword = sanitizeTriggerKeyword(rawKeyword);
    if (!keyword) {
      await sendChatMessage(`@${display} usage: !trigger remove <keyword>`, broadcasterId);
      return true;
    }
    const removed = await deleteCustomTrigger(broadcasterId, keyword);
    await sendChatMessage(
      removed ? `@${display} removed trigger "${keyword}".` : `@${display} no trigger found for "${keyword}".`,
      broadcasterId,
    );
    return true;
  }

  if (action === "cooldown") {
    if (!(await requireModerator(display, broadcasterId, isModerator, "triggers"))) return true;
    const cdMatch =
      chatMessage.match(/^!trigger\s+cooldown\s+"([^"]{2,40})"\s+(\d+)$/i) ??
      chatMessage.match(/^!trigger\s+cooldown\s+(\S+)\s+(\d+)$/i);
    const keyword = cdMatch ? sanitizeTriggerKeyword(cdMatch[1]) : null;
    const seconds = cdMatch ? parseCooldownSeconds(cdMatch[2]) : null;
    if (!keyword || seconds === null) {
      await sendChatMessage(`@${display} usage: !trigger cooldown <keyword> <seconds 0-${MAX_COOLDOWN_SECONDS}>`, broadcasterId);
      return true;
    }
    const updated = await setCustomTriggerCooldown(broadcasterId, keyword, seconds * 1000);
    await sendChatMessage(
      updated ? `@${display} trigger "${keyword}" cooldown set to ${seconds}s.` : `@${display} no trigger found for "${keyword}".`,
      broadcasterId,
    );
    return true;
  }

  await sendChatMessage(
    `@${display} Chat triggers: !trigger add <keyword> <response> | !trigger remove <keyword> | !trigger cooldown <keyword> <seconds> | !trigger list — add/remove/cooldown are mod-only`,
    broadcasterId,
  );
  return true;
}

/**
 * Handles !dndbot add/edit/remove/cooldown/list and !trigger ... management
 * syntax. Returns false if the message is neither — in particular, call this
 * only after main.ts's own !dndbot on/off/status/leave checks have already
 * had a chance to match and return early.
 */
export async function handleCustomCommandManagement(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  if (/^!dndbot(?:\s|$)/i.test(chatMessage)) return await handleDndbotCustomCommandSubcommand(chatMessage, display, broadcasterId, isModerator);
  if (/^!trigger(?:\s|$)/i.test(chatMessage)) return await handleTriggerSubcommand(chatMessage, display, broadcasterId, isModerator);
  return false;
}

/**
 * Fallback for any "!something" that didn't match a built-in command. Only
 * call this after every built-in handler has already declined the message.
 */
export async function handleCustomCommandInvocation(
  chatMessage: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const match = chatMessage.trim().match(/^!(\S+)(?:\s+(.*))?$/);
  if (!match) return false;
  const name = match[1].toLowerCase();
  if (RESERVED_NAMES.has(name)) return false;
  const result = await useCustomCommand(broadcasterId, name);
  if (!result) return false; // no such custom command — silently ignore, like any unknown command
  if (result.onCooldown) return true; // known command, just cooling down — swallow silently

  const args = (match[2] ?? "").trim();
  const targetMatch = args.match(/@(\S+)/);
  const target = targetMatch ? targetMatch[1].replace(/[,:]+$/, "") : undefined;
  const firstWord = args.split(/\s+/)[0];
  const touser = firstWord ? firstWord.replace(/^@/, "").replace(/[,:]+$/, "") : undefined;
  const text = await applyTemplate(String(result.row.response ?? ""), {
    user: display,
    broadcasterId,
    target,
    touser,
    args,
    count: Number(result.row.uses ?? 0),
  });
  await sendChatMessages(text, broadcasterId);
  return true;
}

/**
 * Passive keyword matching for ordinary (non-"!") chat messages. Fires at
 * most one trigger per message, skipping any still on cooldown.
 */
export async function handleTriggerMatch(
  chatMessage: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const text = chatMessage.trim();
  if (!text) return false;
  const triggers = await listCustomTriggers(broadcasterId);
  if (!triggers.length) return false;
  const lower = text.toLowerCase();
  const now = Date.now();
  for (const row of triggers) {
    const keyword = String(row.keyword ?? "");
    if (!keyword || !buildKeywordRegex(keyword).test(lower)) continue;
    const cooldownMs = Number(row.cooldown_ms ?? 0);
    const lastUsedAt = Number(row.last_used_at ?? 0);
    if (cooldownMs > 0 && now - lastUsedAt < cooldownMs) continue; // on cooldown — see if another trigger matches
    await markCustomTriggerUsed(broadcasterId, keyword);
    const rendered = await applyTemplate(String(row.response ?? ""), {
      user: display,
      broadcasterId,
      args: text,
      count: Number(row.uses ?? 0) + 1,
    });
    await sendChatMessages(rendered, broadcasterId);
    return true;
  }
  return false;
}

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
// Responses support a few placeholders:
//   {user}    display name of whoever triggered it
//   {target}  the first @mentioned user in a !command's arguments (falls
//             back to {user} for triggers, which have no arguments)
//   {count}   how many times this command/trigger has now fired
//   {args}    everything typed after the command name (a !command's own
//             arguments; for a !trigger, the whole chat message that set it
//             off) — empty string if there was nothing to capture
//   {random:a|b|c}       picks one option at random (max 5 per response)
//   {randnum:MIN-MAX}    a random whole number in that inclusive range, e.g.
//                        {randnum:1-100} (max 5 per response; MIN/MAX may be
//                        negative, e.g. {randnum:-5-5})
//   {d4} {d6} {d8} {d10} {d12} {d20} {d100}   shorthand for a single roll of
//                        that standard die, e.g. {d20} → 1-20 (max 10 per
//                        response combined)
//   {channel}   this channel's display name (falls back to "the channel" if
//               it can't be looked up)
//   {time}      current time, HH:MM UTC
//   {date}      current date, YYYY-MM-DD (UTC)
//   {sender}    same as {user} — display name of whoever triggered it
//   {touser}    first word of the command's arguments (@ stripped), falling
//               back to {user} if there wasn't one — handy for "aim this at
//               someone" responses that don't require an @mention
//   {game}      the channel's current game/category (falls back to "no game
//               set" if it can't be looked up)
//   {title}     the channel's current stream title (also {status}; falls
//               back to "no title set")
//   {uptime}    how long the channel has been live, e.g. "2h 15m" (falls
//               back to "offline" if it isn't live)
//   {repeat:N|text}   repeats text N times, space-separated (N capped 1-20)
//   {math:expression} evaluates simple arithmetic, e.g. {math:(3+4)*2} — only
//               digits, + - * / ( ) . and spaces are allowed (max 5 per
//               response)
//   {twitchemotes}   this channel's active Twitch subscriber emotes
//   {7tvemotes}      this channel's active 7TV emotes
//   {bttvemotes}     this channel's active BetterTTV emotes
//   {ffzemotes}      this channel's active FrankerFaceZ emotes
//               (each emote list falls back to "no emotes found" and is
//               capped to the first 15 names to keep the message short)
//
// Not supported (would need new setup this bot doesn't have yet): changing
// the stream's game/title from chat (needs a broadcaster OAuth scope no
// connected channel has granted), redeeming channel-point rewards from chat,
// a saved-quote system (!quote add/get), named counters separate from a
// command's own use count ({count} already covers "how many times has this
// fired"), conditional/$(if) logic, and anything needing a paid API key
// (stock prices, weather) that isn't configured here. AI chat replies ARE
// now supported, just not through this system — see npcs.ts's !npc command
// (AI-voiced NPC characters, via Val Town's built-in std/openai wrapper).

import { pick, compactText } from "./utils.ts";
import {
  sendChatMessage,
  sendChatMessages,
  getChannelInfo,
  getStreamUptime,
  getSubscriberEmoteNames,
  get7tvEmoteNames,
  getBttvEmoteNames,
  getFfzEmoteNames,
} from "./twitch.ts";
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
const MAX_RANDNUM_BLOCKS = 5;
const MAX_DIE_BLOCKS = 10;
// Keeps {randnum:MIN-MAX} bounds sane regardless of what's typed — plenty of
// range for loot rolls, gold drops, percentages, etc.
const RANDNUM_ABS_LIMIT = 1_000_000;
const MAX_REPEAT_BLOCKS = 5;
const MAX_REPEAT_N = 20;
const MAX_MATH_BLOCKS = 5;
// Only characters an arithmetic expression could legitimately need — keeps
// {math:...} safe to evaluate without a full expression parser.
const MATH_EXPR_RE = /^[0-9+\-*/().\s]{1,100}$/;
// Long emote lists blow past Twitch's chat message length fast — cap how
// many names a single {Xemotes} placeholder lists.
const MAX_EMOTES_LISTED = 15;

// Every built-in command word (and a few words reserved for future/adjacent
// features, e.g. undocumented or not-yet-loaded modules) so custom commands
// can never shadow or be confused with the bot's own commands.
const RESERVED_NAMES = new Set([
  "roll", "r", "d20", "rollcall", "bg3roll", "bg3", "bg3companion", "bg3origin", "bg3loot", "bg3camp", "bg3lookup",
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

function applyTemplate(
  response: string,
  vars: {
    user: string;
    target?: string;
    count?: number;
    args?: string;
    channel?: string;
    game?: string;
    title?: string;
    uptime?: string;
    twitchEmotes?: string[];
    sevenTvEmotes?: string[];
    bttvEmotes?: string[];
    ffzEmotes?: string[];
  },
): string {
  let randomBlocks = 0;
  let out = response.replace(/\{random:([^{}]{1,200})\}/gi, (_match, options: string) => {
    randomBlocks++;
    if (randomBlocks > MAX_RANDOM_BLOCKS) return "";
    const choices = options.split("|").map((s) => s.trim()).filter(Boolean);
    return choices.length ? pick(choices) : "";
  });
  let randnumBlocks = 0;
  out = out.replace(/\{randnum:(-?\d{1,7})-(-?\d{1,7})\}/gi, (_match, minStr: string, maxStr: string) => {
    randnumBlocks++;
    if (randnumBlocks > MAX_RANDNUM_BLOCKS) return "";
    let min = Number.parseInt(minStr, 10);
    let max = Number.parseInt(maxStr, 10);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return "";
    if (min > max) [min, max] = [max, min];
    min = Math.max(-RANDNUM_ABS_LIMIT, min);
    max = Math.min(RANDNUM_ABS_LIMIT, max);
    return String(min + Math.floor(Math.random() * (max - min + 1)));
  });
  let dieBlocks = 0;
  out = out.replace(/\{d(4|6|8|10|12|20|100)\}/gi, (_match, sizeStr: string) => {
    dieBlocks++;
    if (dieBlocks > MAX_DIE_BLOCKS) return "";
    const size = Number.parseInt(sizeStr, 10);
    return String(1 + Math.floor(Math.random() * size));
  });
  let repeatBlocks = 0;
  out = out.replace(/\{repeat:(\d{1,2})\|([^{}]{1,100})\}/gi, (_match, nStr: string, text: string) => {
    repeatBlocks++;
    if (repeatBlocks > MAX_REPEAT_BLOCKS) return "";
    const n = Math.max(1, Math.min(MAX_REPEAT_N, Number.parseInt(nStr, 10) || 1));
    return Array(n).fill(text.trim()).join(" ");
  });
  let mathBlocks = 0;
  out = out.replace(/\{math:([^{}]{1,100})\}/gi, (_match, expr: string) => {
    mathBlocks++;
    if (mathBlocks > MAX_MATH_BLOCKS) return "";
    const trimmed = expr.trim();
    if (!MATH_EXPR_RE.test(trimmed)) return "?";
    try {
      // deno-lint-ignore no-explicit-any
      const result = Function(`"use strict"; return (${trimmed});`)();
      return Number.isFinite(result) ? String(result) : "?";
    } catch {
      return "?";
    }
  });
  out = out.replaceAll("{user}", vars.user);
  out = out.replaceAll("{sender}", vars.user);
  out = out.replaceAll("{target}", vars.target ?? vars.user);
  out = out.replaceAll("{touser}", vars.target ?? ((vars.args ?? "").trim().split(/\s+/)[0]?.replace(/^@/, "") || vars.user));
  out = out.replaceAll("{count}", String(vars.count ?? ""));
  out = out.replaceAll("{args}", vars.args ?? "");
  if (out.includes("{channel}")) {
    out = out.replaceAll("{channel}", vars.channel ?? "the channel");
  }
  if (out.includes("{game}")) {
    out = out.replaceAll("{game}", vars.game || "no game set");
  }
  if (out.includes("{title}") || out.includes("{status}")) {
    out = out.replaceAll("{title}", vars.title || "no title set");
    out = out.replaceAll("{status}", vars.title || "no title set");
  }
  if (out.includes("{uptime}")) {
    out = out.replaceAll("{uptime}", vars.uptime || "offline");
  }
  if (out.includes("{twitchemotes}")) {
    out = out.replaceAll("{twitchemotes}", formatEmoteList(vars.twitchEmotes));
  }
  if (out.includes("{7tvemotes}")) {
    out = out.replaceAll("{7tvemotes}", formatEmoteList(vars.sevenTvEmotes));
  }
  if (out.includes("{bttvemotes}")) {
    out = out.replaceAll("{bttvemotes}", formatEmoteList(vars.bttvEmotes));
  }
  if (out.includes("{ffzemotes}")) {
    out = out.replaceAll("{ffzemotes}", formatEmoteList(vars.ffzEmotes));
  }
  if (out.includes("{time}") || out.includes("{date}")) {
    const now = new Date();
    out = out.replaceAll(
      "{time}",
      `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")} UTC`,
    );
    out = out.replaceAll("{date}", now.toISOString().slice(0, 10));
  }
  return out;
}

function formatEmoteList(names: string[] | undefined): string {
  if (!names || !names.length) return "no emotes found";
  return names.slice(0, MAX_EMOTES_LISTED).join(" ");
}

/** Best-effort channel display name for {channel} — falls back to the login,
 * then to undefined (applyTemplate substitutes "the channel"), rather than
 * failing the whole response if the broadcasters row is missing/stale. */
async function resolveChannelName(broadcasterId: string): Promise<string | undefined> {
  const broadcaster = await getBroadcaster(broadcasterId);
  const name = broadcaster?.display_name || broadcaster?.login;
  return name ? String(name) : undefined;
}

/** Extra template vars that require a network call — only fetched when the
 * response text actually references one of them, so an ordinary custom
 * command with no {game}/{uptime}/emote placeholders stays a pure DB read. */
async function resolveExtraTemplateVars(broadcasterId: string, responseText: string) {
  const needsChannelInfo = responseText.includes("{game}") || responseText.includes("{title}") || responseText.includes("{status}");
  const needsUptime = responseText.includes("{uptime}");
  const needsTwitchEmotes = responseText.includes("{twitchemotes}");
  const needsSevenTv = responseText.includes("{7tvemotes}");
  const needsBttv = responseText.includes("{bttvemotes}");
  const needsFfz = responseText.includes("{ffzemotes}");

  const [channelInfo, uptime, twitchEmotes, sevenTvEmotes, bttvEmotes, ffzEmotes] = await Promise.all([
    needsChannelInfo ? getChannelInfo(broadcasterId) : Promise.resolve(null),
    needsUptime ? getStreamUptime(broadcasterId) : Promise.resolve(null),
    needsTwitchEmotes ? getSubscriberEmoteNames(broadcasterId) : Promise.resolve(undefined),
    needsSevenTv ? get7tvEmoteNames(broadcasterId) : Promise.resolve(undefined),
    needsBttv ? getBttvEmoteNames(broadcasterId) : Promise.resolve(undefined),
    needsFfz ? getFfzEmoteNames(broadcasterId) : Promise.resolve(undefined),
  ]);

  return {
    game: channelInfo?.gameName,
    title: channelInfo?.title,
    uptime: uptime ?? undefined,
    twitchEmotes,
    sevenTvEmotes,
    bttvEmotes,
    ffzEmotes,
  };
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
  const responseText = String(result.row.response ?? "");
  const channel = responseText.includes("{channel}") ? await resolveChannelName(broadcasterId) : undefined;
  const extra = await resolveExtraTemplateVars(broadcasterId, responseText);
  const text = applyTemplate(responseText, {
    user: display,
    target,
    count: Number(result.row.uses ?? 0),
    args,
    channel,
    ...extra,
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
    const triggerResponseText = String(row.response ?? "");
    const channel = triggerResponseText.includes("{channel}") ? await resolveChannelName(broadcasterId) : undefined;
    const triggerExtra = await resolveExtraTemplateVars(broadcasterId, triggerResponseText);
    const rendered = applyTemplate(triggerResponseText, {
      user: display,
      count: Number(row.uses ?? 0) + 1,
      args: text,
      channel,
      ...triggerExtra,
    });
    await sendChatMessages(rendered, broadcasterId);
    return true;
  }
  return false;
}

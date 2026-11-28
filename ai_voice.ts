// GuildScribe's replies, worded by the AI.
//
// Every reply the bot posts in chat (dice, characters, HP, the swear jar,
// gold, errors, help, toggles…) is built by the code as before: the code
// still works out every fact. Just before it goes out, twitch.ts hands the
// finished line here and the AI rewords it in GuildScribe's voice. The
// canned line is always the fallback, and it goes out unchanged when:
//   - the AI switch is off (/admin/ai or !ai off), or no AI is set up;
//   - the line isn't prose: over REWORD_MAX_LEN characters (rules, spells,
//     battle logs, lists), a usage line, a table of many numbers or a
//     "|"-separated list;
//   - AI_REWORD_MAX_WAITING (2) more lines are already waiting for the AI (a busy chat
//     doesn't pile up behind the AI Pool, which answers one at a time);
//   - the AI doesn't answer within AI_REWORD_TIMEOUT_MS (8 s), errors, or
//     sends something garbled (ai_reply.ts junkReason);
//   - the AI's line drops or changes a fact (checkFacts): every number and
//     dice roll in the same order, every @-tag, !command, link, "quoted"
//     text, <placeholder> and capitalised name mid-sentence (item, monster,
//     character names), and it adds no number, tag, command or link of its
//     own.
// A line that leads with "@Name" keeps it: the AI words only the rest, and
// the tag goes back in front, so whisper mode and nicknames work as before.
// Blocked lines and errors are logged on /admin/logs (ai_reword_blocked,
// ai_reword_error), like the guard on the NPCs' and peddler's replies.
//
// Replies the AI already wrote (NPCs, !haggle, !askme answers, the
// babushka) and text people wrote themselves (custom commands, timed
// messages, the quote book, the message of the day) are sent with
// { ai: false } and never reworded.

import { currentAiConfig, isAiBusy, isAiEnabled, isAiOff, OpenAI } from "./openai.ts";
import { cleanChatReply, junkReason, junkSample } from "./ai_reply.ts";
import { recordMonitorEvent } from "./db.ts";

const openai = new OpenAI();

const MODEL = Deno.env.get("AI_REWORD_MODEL") ?? "gpt-4o-mini";
/** Longer lines are reference text (rules, spells, logs) and stay as they are. */
export const REWORD_MAX_LEN = Math.max(40, Number(Deno.env.get("AI_REWORD_MAX_LEN") ?? "300"));
/** The longest reworded line (one Twitch chat message part in twitch.ts). */
const REPLY_CAP = 300;
const TIMEOUT_MS = Math.max(1000, Number(Deno.env.get("AI_REWORD_TIMEOUT_MS") ?? "8000"));
/** Lines allowed to wait for the AI at once (beyond the one being worded). */
const MAX_WAITING = Math.max(0, Math.floor(Number(Deno.env.get("AI_REWORD_MAX_WAITING") ?? "2")));
const MAX_TOKENS = 160;

const SYSTEM_PROMPT = [
  `You are GuildScribe, the scribe of a Dungeons & Dragons guild hall that lives in a Twitch chat.`,
  `You are given one of your own ready-made chat replies. Reword it so it sounds fresh and in character: warm, witty, with a light touch of tavern-and-quill fantasy flavor, never cruel. Vary your wording from one reply to the next.`,
  `Keep the meaning exactly the same. Copy every number, dice roll, amount, name, item, @-tag, !command, link and anything in quotes or <angle brackets> exactly as written, in the same order. Add no new facts, numbers, names, @-tags, commands or links, and leave nothing out.`,
  `If the reply tells someone what to type, keep the command exactly as given.`,
  `Keep it about as long as the original and chat-friendly: one or two sentences. Plain text only: no markdown, no *stage directions*, no speaker label, no wrapping quotes. Keep the original's emoji where they fit.`,
  `Keep it fit for a general Twitch audience. Reply with only the reworded line.`,
].join(" ");

// ── Facts that must survive the rewording ──

const URL_RE = /https?:\/\/[^\s|]+/gi;
const MENTION_RE = /@[A-Za-z0-9_]{1,25}(?![A-Za-z0-9_])/g;
const COMMAND_RE = /(?<![\w!/])![A-Za-z][\w-]*/g;
const QUOTE_RE = /"([^"]{1,200})"|“([^”]{1,200})”/g;
const PLACEHOLDER_RE = /<[^<>\s][^<>]{0,40}>|\{[A-Za-z_]{1,30}\}/g;
// "1d20+3", "2d6", "1,250", "3.5", "14".
const NUMBER_RE = /\d+d\d+(?:\s*[+-]\s*\d+)?|\d+(?:,\d{3})*(?:\.\d+)?/gi;
const WORD_RE = /[\p{L}][\p{L}\p{N}'’-]*/gu;
/** Capitalised words that aren't names. */
const NOT_NAMES = new Set(["i", "i'm", "i've", "i'll", "i'd", "ok", "okay", "guildscribe"]);

function normNumber(n: string): string {
  return n.toLowerCase().replace(/\s+/g, "").replace(/(?<=\d),(?=\d)/g, "");
}

function all(re: RegExp, text: string): string[] {
  return [...text.matchAll(re)].map((m) => m[0]);
}

/** The text without links, @-tags and !commands (their digits and capitals aren't numbers or names). */
function plain(text: string): string {
  return text.replace(URL_RE, " ").replace(MENTION_RE, " ").replace(COMMAND_RE, " ").replace(PLACEHOLDER_RE, " ");
}

export function numbersIn(text: string): string[] {
  return all(NUMBER_RE, plain(text)).map(normNumber);
}

/** Capitalised words that don't start a sentence: names of items, monsters,
 * characters, places ("You found a Longsword", "the Goblin hits for 4"). */
export function namesIn(text: string): string[] {
  const t = plain(text).replace(QUOTE_RE, " ");
  const out: string[] = [];
  for (const m of t.matchAll(WORD_RE)) {
    const w = m[0];
    if (w[0] === w[0].toLowerCase()) continue; // lowercase, or a script without capitals
    const before = t.slice(0, m.index).trimEnd();
    const prev = before.slice(-1);
    // A sentence or clause start, or right after an emoji or symbol.
    if (!prev || !/[\p{L}\p{N},'’"“”)]/u.test(prev)) continue;
    if (NOT_NAMES.has(w.toLowerCase())) continue;
    out.push(w);
  }
  return out;
}

function hasWord(text: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

function isSubsequence(want: string[], got: string[]): boolean {
  let i = 0;
  for (const g of got) if (i < want.length && g === want[i]) i++;
  return i === want.length;
}

/** Why the AI's `reply` doesn't carry the canned line's facts, or null if it does. */
export function checkFacts(canned: string, reply: string): string | null {
  const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
  const urls = all(URL_RE, canned);
  const gotUrls = all(URL_RE, reply);
  if (urls.some((u) => !gotUrls.includes(u))) return "lost a link";
  if (gotUrls.some((u) => !urls.includes(u))) return "added a link";
  const tags = lower(all(MENTION_RE, canned));
  const gotTags = lower(all(MENTION_RE, reply));
  if (tags.some((t) => !gotTags.includes(t))) return "lost an @-tag";
  if (gotTags.some((t) => !tags.includes(t))) return "added an @-tag";
  const cmds = lower(all(COMMAND_RE, canned));
  const gotCmds = lower(all(COMMAND_RE, reply));
  if (cmds.some((c) => !gotCmds.includes(c))) return "lost a !command";
  if (gotCmds.some((c) => !cmds.includes(c))) return "added a !command";
  for (const p of all(PLACEHOLDER_RE, canned)) if (!reply.includes(p)) return `lost ${p}`;
  for (const m of canned.matchAll(QUOTE_RE)) {
    const q = (m[1] ?? m[2]).trim();
    if (q && !reply.includes(q)) return "changed quoted text";
  }
  const nums = numbersIn(canned);
  const gotNums = numbersIn(reply);
  if (gotNums.some((n) => !nums.includes(n))) return "added a number";
  if (!isSubsequence(nums, gotNums)) return nums.every((n) => gotNums.includes(n)) ? "moved numbers around" : "lost a number";
  for (const n of namesIn(canned)) if (!hasWord(reply, n)) return `lost the name ${n}`;
  return null;
}

/** What a line's wording must and must not name, on top of checkFacts:
 * !oracle's chosen option is in `keep`, the options it didn't pick are in
 * `avoid`, so the AI can't swap the answer. */
export type RewordGuard = { keep?: string[]; avoid?: string[] };

/** Where `phrase` appears in `text` as whole words (any case). */
function spans(text: string, phrase: string): Array<[number, number]> {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu");
  return [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length]);
}

/** Why `reply` breaks `guard`, or null if it doesn't. An avoided option
 * inside the kept one ("pizza" in "pineapple pizza") doesn't count, nor
 * one the canned line itself names. */
export function checkGuard(canned: string, reply: string, guard?: RewordGuard): string | null {
  if (!guard) return null;
  const kept: Array<[number, number]> = [];
  for (const k of guard.keep ?? []) {
    const found = spans(reply, k);
    if (!found.length) return "lost the answer";
    kept.push(...found);
  }
  for (const a of guard.avoid ?? []) {
    if (spans(canned, a).length) continue;
    const loose = spans(reply, a).filter(([s, e]) => !kept.some(([ks, ke]) => ks <= s && e <= ke));
    if (loose.length) return "named another option";
  }
  return null;
}

/** Why `text` is left as it is (no AI), or null if the AI may word it. */
export function notRewordable(text: string): string | null {
  const t = text.trim();
  if (t.length < 4) return "too short";
  if (t.length > REWORD_MAX_LEN) return "long";
  if (/^[!/.]/.test(t)) return "a command for chat or another bot";
  if (/\busage\s*:/i.test(t)) return "usage line";
  if (numbersIn(t).length > 6) return "many numbers";
  if ((t.match(/\s\|\s/g) ?? []).length >= 2) return "list";
  if (!/\p{L}{2}/u.test(plain(t))) return "no words";
  return null;
}

/** "@Name " (with any emoji before it) at the front of a line. */
function splitLead(text: string): { lead: string; body: string } {
  const m = text.match(/^([^\w@]*@[A-Za-z0-9_]{1,25}[\s,:]*)/);
  return m ? { lead: m[1], body: text.slice(m[1].length) } : { lead: "", body: text };
}

// ── Counts for /admin/ai ──

export const rewordStats = { reworded: 0, canned: 0, blocked: 0, busy: 0, failed: 0 };

/** Lines being worded or waiting for the AI right now. */
let pending = 0;

/** Test hook. */
export function rewordPending(): number {
  return pending;
}

/** `text` worded by the AI, or `text` itself (see the top of this file).
 * Never throws. */
export async function aiWordReply(text: string, broadcasterId = "", guard?: RewordGuard): Promise<string> {
  if (!isAiEnabled()) return text;
  if (notRewordable(text)) return text;
  const cfg = currentAiConfig();
  if (cfg.isOpenAI && !cfg.apiKey) return text; // no AI set up
  const { lead, body } = splitLead(text);
  if (body.trim().length < 4 || !/\p{L}{2}/u.test(plain(body))) return text;
  if (pending > MAX_WAITING) {
    rewordStats.busy++;
    rewordStats.canned = rewordStats.blocked + rewordStats.busy + rewordStats.failed;
    return text;
  }
  pending++;
  let raw = "";
  try {
    const max = Math.min(REPLY_CAP - lead.length, Math.max(140, Math.round(body.length * 1.6)));
    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: MAX_TOKENS,
      temperature: 0.9,
      top_p: 0.9,
      presence_penalty: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${lead ? `Reply to ${lead.replace(/[^\w@]/g, "").trim()}` : "Reply"} (under ${max} characters): ${body.trim()}` },
      ],
    }, { timeoutMs: TIMEOUT_MS });
    raw = String(completion?.choices?.[0]?.message?.content ?? "");
    let reply = cleanChatReply(raw, ["GuildScribe", "Scribe", "the scribe"], max);
    // The AI repeating the lead tag: it goes back in front once.
    if (lead) {
      const tag = lead.match(/@[A-Za-z0-9_]+/)![0];
      reply = reply.replace(new RegExp(`^\\W*${tag}\\b[\\s,:]*`, "i"), "").trim();
    }
    const why = !reply
      ? (junkReason(raw) ?? "empty after cleanup")
      : /^[/.]/.test(reply)
      ? "starts like a chat command"
      : (checkFacts(body, reply) ?? checkGuard(body, reply, guard));
    if (why) {
      rewordStats.blocked++;
      await recordMonitorEvent("ai_reword_blocked", `${broadcasterId}: ${why}. Canned ${junkSample(body)}, AI ${junkSample(raw)}`).catch(() => {});
      return text;
    }
    rewordStats.reworded++;
    return lead + reply;
  } catch (e) {
    if (isAiOff(e)) return text;
    if (isAiBusy(e)) {
      rewordStats.busy++;
      return text;
    }
    rewordStats.failed++;
    console.error("AI reword failed", e);
    await recordMonitorEvent("ai_reword_error", `${broadcasterId}: ${String(e).slice(0, 300)}`).catch(() => {});
    return text;
  } finally {
    pending--;
    rewordStats.canned = rewordStats.blocked + rewordStats.busy + rewordStats.failed;
  }
}

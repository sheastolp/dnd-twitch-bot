// !askme <question> — a straight, factual answer from an AI that searches the
// web first, with a link to the source it used.
//
//   !askme <question>   anyone — e.g. !askme how far away is the moon?
//
//   - Dashboard switch "askme" (off by default, "Other" section); main.ts
//     gates it through COMMAND_GROUPS like any other command word.
//   - Needs OpenAI (OPENAI_API_KEY): it uses the Responses API's web_search
//     tool, which Ollama doesn't have (see openai.ts responses.create).
//     ASKME_MODEL picks the model (default gpt-4.1-mini).
//   - Per-chatter cooldown (ASKME_USER_COOLDOWN_S, default 30 s, mods skip it)
//     and a channel-wide one (ASKME_CHANNEL_COOLDOWN_S, default 5 s), since
//     every question is a paid web search.
//   - The answer and source fit one chat message; inline citations the model
//     writes into its text are stripped and the first cited URL is shown.

import { OpenAI, supportsWebSearch } from "./openai.ts";
import { sendChatMessage } from "./twitch.ts";
import { compactText } from "./utils.ts";
import { recordMonitorEvent } from "./db.ts";

const openai = new OpenAI();

const MODEL = Deno.env.get("ASKME_MODEL") ?? "gpt-4.1-mini";
const MIN_QUESTION_LEN = 3;
const MAX_QUESTION_LEN = 300;
const MAX_ANSWER_LEN = 300;
const MAX_URL_LEN = 120;
const ANSWER_MAX_TOKENS = 400;
const TIMEOUT_MS = 45_000;
const USER_COOLDOWN_MS = Math.max(0, Number(Deno.env.get("ASKME_USER_COOLDOWN_S") ?? "30")) * 1000;
const CHANNEL_COOLDOWN_MS = Math.max(0, Number(Deno.env.get("ASKME_CHANNEL_COOLDOWN_S") ?? "5")) * 1000;

const INSTRUCTIONS = [
  `You answer questions from viewers in a Twitch chat. Search the web, then give an accurate, factual answer based on reliable sources.`,
  `Reply in plain text, at most two short sentences (under ${MAX_ANSWER_LEN} characters). No markdown, no lists, no links or citations in the text itself — the source is attached separately.`,
  `Lead with the direct answer. If sources disagree or the answer is uncertain, say so briefly. Never invent facts.`,
  `Keep it family-friendly. If a question asks for something harmful, hateful, sexual, or someone's private personal information, politely decline in one sentence.`,
].join(" ");

const lastUserAsk = new Map<string, number>();
const lastChannelAsk = new Map<string, number>();

interface Answer {
  text: string;
  source?: { url: string; title: string };
}

/** Drops OpenAI's "?utm_source=openai" tag so the link is clean. */
function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("utm_source");
    return u.toString().replace(/\?$/, "");
  } catch {
    return url;
  }
}

/** Removes markdown links/citations the model sometimes writes into its text
 * despite being asked not to: "([site](url))", "[site](url)", bare URLs. */
function stripCitations(text: string): string {
  return text
    .replace(/\s*\(\s*\[[^\]]*\]\([^)]*\)\s*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s*https?:\/\/\S+/g, "")
    .replace(/[*_`#]/g, "")
    .replace(/\s+([.,;!?])/g, "$1");
}

/** Asks the model, with web search, to answer `question`. */
async function answerQuestion(broadcasterId: string, question: string): Promise<Answer | null> {
  try {
    const response = await openai.responses.create({
      model: MODEL,
      instructions: INSTRUCTIONS,
      input: question,
      tools: [{ type: "web_search" }],
      max_output_tokens: ANSWER_MAX_TOKENS,
    }, { timeoutMs: TIMEOUT_MS });

    let text = "";
    let source: Answer["source"];
    for (const item of response.output ?? []) {
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) {
        if (part.type !== "output_text") continue;
        text += part.text ?? "";
        const cite = (part.annotations ?? []).find((a: any) => a.type === "url_citation" && a.url);
        if (cite && !source) source = { url: cleanUrl(cite.url), title: String(cite.title ?? "").trim() };
      }
    }
    text = compactText(stripCitations(text), MAX_ANSWER_LEN);
    return text ? { text, source } : null;
  } catch (e) {
    console.error("askme failed", e);
    await recordMonitorEvent("askme_error", `${broadcasterId}: ${String(e)}`);
    return null;
  }
}

export async function handleAskMeCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const match = chatMessage.match(/^!askme(?:\s+([\s\S]+))?$/i);
  if (!match) return false;

  const question = (match[1] ?? "").trim();
  if (question.length < MIN_QUESTION_LEN) {
    await sendChatMessage(`@${display} ask me anything, e.g. !askme how far away is the moon?`, broadcasterId);
    return true;
  }
  if (!supportsWebSearch()) {
    await sendChatMessage(`@${display} !askme isn't set up on this bot yet (it needs an OpenAI key).`, broadcasterId);
    return true;
  }

  // Cooldowns stay silent, like the babushka's, so spamming can't spam back.
  const now = Date.now();
  const userKey = `${broadcasterId}:${chatter.toLowerCase()}`;
  if (now - (lastChannelAsk.get(broadcasterId) ?? 0) < CHANNEL_COOLDOWN_MS) return true;
  if (!isModerator && now - (lastUserAsk.get(userKey) ?? 0) < USER_COOLDOWN_MS) return true;
  lastChannelAsk.set(broadcasterId, now);
  lastUserAsk.set(userKey, now);

  const answer = await answerQuestion(broadcasterId, compactText(question, MAX_QUESTION_LEN));
  if (!answer) {
    await sendChatMessage(`@${display} I couldn't find a good answer to that right now — try again in a bit.`, broadcasterId);
    return true;
  }

  // "@name " (≤27) + answer (≤300) + source (≤~165) stays under Twitch's 500-character limit.
  let reply = `@${display} ${answer.text}`;
  if (answer.source && answer.source.url.length <= MAX_URL_LEN) {
    const title = compactText(answer.source.title, 30);
    reply += ` 📚 Source: ${title ? `${title} — ` : ""}${answer.source.url}`;
  } else {
    reply += " (no source found — take this with a grain of salt)";
  }
  await sendChatMessage(reply, broadcasterId, [], { keepNames: true });
  return true;
}

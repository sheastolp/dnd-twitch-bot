// !askme <question> — a straight, factual answer from an AI, based on
// Wikipedia, with a link to the article it used.
//
//   !askme <question>         anyone — e.g. !askme how far away is the moon?
//   !askme on|off|status      on/off: broadcaster or mods; status: anyone
//
//   - Dashboard switch "askme" (off by default, "Other" section), also
//     switched by !askme on/off. This file checks the switch itself (it isn't
//     gated by COMMAND_GROUPS' word list), so on/off/status work while it's
//     off and, when off, questions fall through to a channel's own !askme
//     custom command.
//   - No paid search: looks the question up on Wikipedia (search + intros, no
//     key), then the AI in openai.ts — Ollama or OpenAI, whichever the bot
//     uses — answers from those intros only and names the one it used, which
//     becomes the source link. If the AI call fails, the best article's
//     opening sentence is posted instead. ASKME_MODEL picks the model when
//     OPENAI_MODEL doesn't override it (default gpt-4o-mini).
//   - Per-chatter cooldown (ASKME_USER_COOLDOWN_S, default 30 s, mods skip it)
//     and a channel-wide one (ASKME_CHANNEL_COOLDOWN_S, default 5 s).

import { OpenAI } from "./openai.ts";
import { sendChatMessage } from "./twitch.ts";
import { compactText } from "./utils.ts";
import { isCommandGroupEnabled, recordMonitorEvent, setCommandGroupEnabled } from "./db.ts";

const openai = new OpenAI();

const MODEL = Deno.env.get("ASKME_MODEL") ?? "gpt-4o-mini";
const WIKI_API = "https://en.wikipedia.org/w/api.php";
// Wikimedia asks API clients to identify themselves.
const USER_AGENT = `GuildScribe/1.0 (${Deno.env.get("PUBLIC_BASE_URL") || "https://guildscribe.tavernworks.dev"})`;
const MIN_QUESTION_LEN = 3;
const MAX_QUESTION_LEN = 300;
const MAX_ANSWER_LEN = 300;
const MAX_URL_LEN = 120;
const ARTICLES = 3;
const MAX_EXTRACT_LEN = 1500;
// Roomy so "thinking" models (qwen3, gpt-5…) have budget left to answer;
// llama3.2 and the like stop after a sentence or two anyway.
const ANSWER_MAX_TOKENS = 1000;
const WIKI_TIMEOUT_MS = 8_000;
const AI_TIMEOUT_MS = 45_000;
const USER_COOLDOWN_MS = Math.max(0, Number(Deno.env.get("ASKME_USER_COOLDOWN_S") ?? "30")) * 1000;
const CHANNEL_COOLDOWN_MS = Math.max(0, Number(Deno.env.get("ASKME_CHANNEL_COOLDOWN_S") ?? "5")) * 1000;

const SYSTEM_PROMPT = [
  `You answer questions from viewers in a Twitch chat, using ONLY the numbered Wikipedia excerpts you are given.`,
  `Reply in plain text, at most two short sentences (under ${MAX_ANSWER_LEN} characters), then the number of the excerpt you used in brackets, e.g. "The Moon is about 384,400 km from Earth. [2]". No markdown, no links.`,
  `Lead with the direct answer. If the excerpts don't answer the question, say you couldn't find it — never guess or add facts that aren't in them.`,
  `Keep it family-friendly. If a question asks for something harmful, hateful, sexual, or someone's private personal information, politely decline in one sentence.`,
].join(" ");

const lastUserAsk = new Map<string, number>();
const lastChannelAsk = new Map<string, number>();

interface Article {
  title: string;
  url: string;
  extract: string;
}

interface Answer {
  text: string;
  source: { url: string; title: string };
}

async function wikiQuery(params: Record<string, string>): Promise<any> {
  const url = `${WIKI_API}?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", ...params })}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(WIKI_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Wikipedia request failed: HTTP ${res.status}`);
  return await res.json();
}

/** The top Wikipedia articles for `question`, best match first, with their
 * plain-text intros. */
async function searchWikipedia(question: string): Promise<Article[]> {
  const search = await wikiQuery({ list: "search", srsearch: question, srlimit: String(ARTICLES), srprop: "" });
  const titles: string[] = (search.query?.search ?? []).map((r: any) => r.title);
  if (!titles.length) return [];
  const pages = await wikiQuery({ prop: "extracts|info", exintro: "1", explaintext: "1", inprop: "url", titles: titles.join("|") });
  const byTitle = new Map<string, any>((pages.query?.pages ?? []).map((p: any) => [p.title, p]));
  return titles
    .map((t) => byTitle.get(t))
    .filter((p) => p?.extract?.trim())
    .map((p) => ({ title: p.title, url: p.fullurl, extract: compactText(p.extract, MAX_EXTRACT_LEN) }));
}

/** An article's first sentence or two, for when the AI can't answer. */
function openingSentences(extract: string): string {
  // A sentence ends at ". " before a capital, but not after an initial
  // ("J. R. R. Tolkien") — decimals ("1.6") have no space, so never split.
  const sentences = extract.split(/(?<=[a-z0-9)\]"'][.!?])\s+(?=[A-Z"'(])/);
  let text = "";
  for (const s of sentences) {
    if ((text + " " + s).length > MAX_ANSWER_LEN) break;
    text = text ? `${text} ${s}` : s;
  }
  if (text) return text;
  // One very long first sentence: cut it at a word.
  return extract.slice(0, MAX_ANSWER_LEN - 1).replace(/\s+\S*$/, "") + "…";
}

/** Looks `question` up on Wikipedia and has the AI answer from what it finds. */
async function answerQuestion(broadcasterId: string, question: string): Promise<Answer | null> {
  let articles: Article[];
  try {
    articles = await searchWikipedia(question);
  } catch (e) {
    console.error("askme Wikipedia lookup failed", e);
    await recordMonitorEvent("askme_error", `${broadcasterId}: ${String(e)}`);
    return null;
  }
  if (!articles.length) return null;

  try {
    const excerpts = articles.map((a, i) => `[${i + 1}] ${a.title}: ${a.extract}`).join("\n\n");
    // No `temperature` override: some OpenAI models only accept the default.
    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: ANSWER_MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Excerpts:\n\n${excerpts}\n\nQuestion: ${question}` },
      ],
    }, { timeoutMs: AI_TIMEOUT_MS });
    const raw = String(completion.choices?.[0]?.message?.content ?? "");
    // The excerpt it cited; the top search result if it didn't say.
    const cited = Number(raw.match(/\[(\d)\]/)?.[1] ?? 0);
    const article = articles[cited - 1] ?? articles[0];
    const text = compactText(
      raw.replace(/\s*\[\d\]/g, "").replace(/\s*https?:\/\/\S+/g, "").replace(/[*_`#]/g, "").replace(/^["']|["']$/g, ""),
      MAX_ANSWER_LEN,
    );
    if (text) return { text, source: { url: article.url, title: article.title } };
  } catch (e) {
    console.error("askme AI answer failed", e);
    await recordMonitorEvent("askme_error", `${broadcasterId}: ${String(e)}`);
  }
  // The AI is down or said nothing: let Wikipedia speak for itself.
  const top = articles[0];
  return { text: openingSentences(top.extract), source: { url: top.url, title: top.title } };
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
  const toggle = question.match(/^(on|off|status)$/i)?.[1].toLowerCase();
  if (toggle === "status") {
    const on = await isCommandGroupEnabled(broadcasterId, "askme");
    await sendChatMessage(`@${display} !askme is ${on ? "on — ask me anything, e.g. !askme how far away is the moon?" : "off"}.`, broadcasterId);
    return true;
  }
  if (toggle) {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can switch !askme ${toggle}.`, broadcasterId);
      return true;
    }
    await setCommandGroupEnabled(broadcasterId, "askme", toggle === "on");
    await sendChatMessage(`@${display} !askme is ${toggle}.`, broadcasterId);
    return true;
  }
  if (!await isCommandGroupEnabled(broadcasterId, "askme")) return false;

  if (question.length < MIN_QUESTION_LEN) {
    await sendChatMessage(`@${display} ask me anything, e.g. !askme how far away is the moon?`, broadcasterId);
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
    await sendChatMessage(`@${display} I couldn't find anything on Wikipedia for that — try wording it differently.`, broadcasterId);
    return true;
  }

  // "@name " (≤27) + answer (≤300) + source (≤~165) stays under Twitch's 500-character limit.
  // A very long article URL is left off rather than cut mid-link.
  const title = compactText(answer.source.title, 30);
  const link = answer.source.url.length <= MAX_URL_LEN ? ` — ${answer.source.url}` : "";
  const reply = `@${display} ${answer.text} 📚 Source: Wikipedia, ${title}${link}`;
  await sendChatMessage(reply, broadcasterId, [], { keepNames: true });
  return true;
}

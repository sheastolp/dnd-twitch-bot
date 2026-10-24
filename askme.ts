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
//   - No paid search: looks the question up on Wikipedia (search + full
//     article text, no key), picks the few passages that best match the
//     question, then the AI in openai.ts — Ollama or OpenAI, whichever the
//     bot uses — answers from those passages only and names the one it used,
//     whose article becomes the source link. Sending a handful of matching
//     passages instead of whole intros keeps the prompt small (fast on a CPU
//     Ollama) and puts the specific fact in front of the model. If the AI
//     call fails, the best passage itself is posted. ASKME_MODEL picks the
//     model when OPENAI_MODEL doesn't override it (default gpt-4o-mini).
//   - Game questions: chat abbreviations (bg3, botw, rdr2…) are spelled out,
//     "this game" becomes the channel's current Twitch category, game-worded
//     questions also search "… video game", and the article whose title the
//     question names outranks its sequels, spin-offs and namesakes.
//   - Per-chatter cooldown (ASKME_USER_COOLDOWN_S, default 30 s, mods skip it)
//     and a channel-wide one (ASKME_CHANNEL_COOLDOWN_S, default 5 s).

import { OpenAI } from "./openai.ts";
import { getChannelInfo, sendChatMessage } from "./twitch.ts";
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
/** Passages handed to the AI, and the most characters each may have. */
const PASSAGES = 5;
const MAX_PASSAGE_LEN = 400;
// Roomy so "thinking" models (qwen3, gpt-5…) have budget left to answer;
// llama3.2 and the like stop after a sentence or two anyway.
const ANSWER_MAX_TOKENS = 1000;
const WIKI_TIMEOUT_MS = 8_000;
const AI_TIMEOUT_MS = 45_000;
const USER_COOLDOWN_MS = Math.max(0, Number(Deno.env.get("ASKME_USER_COOLDOWN_S") ?? "30")) * 1000;
const CHANNEL_COOLDOWN_MS = Math.max(0, Number(Deno.env.get("ASKME_CHANNEL_COOLDOWN_S") ?? "5")) * 1000;

const SYSTEM_PROMPT = [
  `You answer questions from viewers in a Twitch chat, using ONLY the numbered Wikipedia passages you are given.`,
  `Answer exactly what was asked: if they ask for a number, name, date, place or yes/no, give that specific fact first. Don't summarize the topic or add background they didn't ask for.`,
  `Reply in plain text, one or two short sentences (under ${MAX_ANSWER_LEN} characters), then the number of the passage you used in brackets, e.g. "The Moon is about 384,400 km from Earth on average. [2]". No markdown, no links.`,
  `Passages can be about different things with similar names — a game and its sequel, spin-off or remake, a film, a book. Use only passages about exactly the thing asked about, and never mix facts from one into another.`,
  `You may be told which game the stream is playing: "this game" means that game, and you can use that note to say what game is being played.`,
  `If the passages don't contain the answer, say you couldn't find it — never guess or add facts that aren't in them.`,
  `Keep it family-friendly. If a question asks for something harmful, hateful, sexual, or someone's private personal information, politely decline in one sentence.`,
].join(" ");

const lastUserAsk = new Map<string, number>();
const lastChannelAsk = new Map<string, number>();

interface Article {
  title: string;
  url: string;
  text: string;
}

interface Passage {
  article: Article;
  /** The article's search rank, 0 = best. */
  rank: number;
  /** 0 for the article's opening paragraph. */
  index: number;
  /** In the lead section, before the first heading. */
  lead: boolean;
  text: string;
  words: Set<string>;
}

interface Answer {
  text: string;
  source: { url: string; title: string };
}

// Words that say nothing about what's being asked.
const STOPWORDS = new Set(
  ("a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or " +
    "so than that the their them then there these they this to was we were what when where which who whom whose why will " +
    "with would you your about tell know many much long far away old big tall get got also").split(" "),
);
// Common irregular verb forms, so "when did it sink" matches "it sank".
const IRREGULAR: Record<string, string> = {
  sank: "sink", sunk: "sink", wrote: "write", written: "writ", began: "begin", begun: "begin", ran: "run",
  won: "win", lost: "lose", built: "build", made: "make", found: "find", fought: "fight", flew: "fly", flown: "fly",
  became: "become", born: "birth", died: "die", dead: "die", death: "die", sold: "sell", taught: "teach", thought: "think",
};
// Sections that are lists of links and citations, not prose.
const SKIP_SECTIONS = /^(see also|references|external links|further reading|notes|bibliography|sources|citations|footnotes)$/i;
// Questions whose answer is usually a number or a date.
const NUMERIC_QUESTION = /^(how (many|much|far|old|long|tall|big|high|deep|fast|heavy|large|wide)|when|what year|what date)\b/i;
// A number in a passage, as digits or a word ("eight legs").
const HAS_NUMBER = /\d|\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|hundred|thousand|million|billion|dozen)\b/i;

// Words that mark a question as being about video games.
const GAME_WORDS = /\b(games?|gaming|video ?games?|played|player|boss(es)?|dlc|sequel|prequel|remake|remaster(ed)?|developer|studio|publisher|console|steam|xbox|playstation|ps[1-5]|nintendo|switch|speedruns?|multiplayer|rpg|jrpg|fps|mmo(rpg)?|roguelike|metroidvania|expansion|patch|early access)\b/i;
// Twitch categories that aren't a game, so there's no "this game" to look up.
const NON_GAME_CATEGORIES = /^(just chatting|music|art|irl|talk shows? & podcasts|asmr|pools, hot tubs, and beaches|sports|travel & outdoors|food & drink|science & technology|software and game development|makers & crafting|special events|always on|i'm only sleeping)$/i;
// "this game", "the current game", "who made the game?" — the stream's
// current game ("the game hades" names its own).
const THIS_GAME = /\b(this|current|that) game\b|\bthe game(?=\s*[?.!]*$)/i;
// Short names chat uses that Wikipedia search doesn't know.
// (Ones that are also everyday words — wow, lol, cod, poe — are left out.)
const GAME_ABBREVIATIONS: Record<string, string> = {
  bg3: "Baldur's Gate 3", botw: "Breath of the Wild", totk: "Tears of the Kingdom", gta: "Grand Theft Auto",
  gta5: "Grand Theft Auto V", gtav: "Grand Theft Auto V", gta6: "Grand Theft Auto VI", rdr2: "Red Dead Redemption 2",
  csgo: "Counter-Strike: Global Offensive", cs2: "Counter-Strike 2", ff7: "Final Fantasy VII",
  ffvii: "Final Fantasy VII", ff14: "Final Fantasy XIV", ffxiv: "Final Fantasy XIV", ff16: "Final Fantasy XVI",
  mhw: "Monster Hunter: World", poe2: "Path of Exile 2", tf2: "Team Fortress 2", dbd: "Dead by Daylight",
  oot: "Ocarina of Time", ssbu: "Super Smash Bros. Ultimate", acnh: "Animal Crossing: New Horizons",
  wc3: "Warcraft III", sc2: "StarCraft II", ds3: "Dark Souls III", dnd: "Dungeons & Dragons",
  "d&d": "Dungeons & Dragons", eft: "Escape from Tarkov", pubg: "PUBG: Battlegrounds", r6: "Rainbow Six Siege",
  ow2: "Overwatch 2",
};

/** A word's comparable form: lowercase, irregular verbs mapped, a rough
 * -ing/-ed/plural ending stripped and a final "e" dropped, so "sinking" →
 * "sink", "games"/"game" → "gam", "released"/"release" → "releas". */
function stem(word: string): string {
  let w = word.toLowerCase();
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ied")) w = w.slice(0, -3) + "y";
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w.length > 3 && w.endsWith("e") ? w.slice(0, -1) : w;
}

/** The question's meaningful words, as typed (for searching). */
function searchWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

// Stems that ask the same thing the way Wikipedia phrases it: "who made it"
// is answered by "developed by", "when did it come out" by "released".
const SYNONYMS: Record<string, string> = { make: "develop", creat: "develop", design: "develop", launch: "releas" };

/** The question's meaningful words, stemmed (for matching). */
function keywords(text: string): Set<string> {
  const words = searchWords(text.replace(/\b(come|came|comes|coming) out\b/gi, "released"));
  return new Set(words.map((w) => SYNONYMS[stem(w)] ?? stem(w)));
}

/** The question as Wikipedia should see it — game abbreviations spelled out
 * and "this game" replaced by the game the stream is playing — and the games
 * it named that way, which are searched for by name. The stream's game is only
 * used when the question points at it, so "how far away is the moon" on a
 * Minecraft stream is still about the Moon. */
function expandQuestion(question: string, currentGame: string | null): { text: string; games: string[] } {
  const games: string[] = [];
  const named = (game: string) => (games.push(game), game);
  let text = question.replace(/[a-z0-9&]+/gi, (w) => {
    const game = GAME_ABBREVIATIONS[w.toLowerCase()];
    return game ? named(game) : w;
  });
  if (currentGame) {
    text = text.replace(THIS_GAME, () => named(currentGame));
    // "who directed control" on a Control stream means the game.
    const gameWords = [...keywords(currentGame)];
    const asked = keywords(text);
    if (!games.length && gameWords.length && gameWords.every((w) => asked.has(w))) games.push(currentGame);
  }
  return { text, games };
}

/** The game the channel is streaming, or null for non-game categories. */
async function currentGameOf(broadcasterId: string): Promise<string | null> {
  const game = (await getChannelInfo(broadcasterId))?.gameName.trim();
  return game && !NON_GAME_CATEGORIES.test(game) ? game : null;
}

/** Splits text into sentences. A sentence ends at ". " before a capital, but
 * not after an initial ("J. R. R. Tolkien"); decimals ("1.6") have no space. */
function sentences(text: string): string[] {
  return text.split(/(?<=[a-z0-9)\]"'][.!?])\s+(?=[A-Z"'(])/);
}

/** As many whole sentences of `text` as fit in `max` characters (cut at a
 * word if even the first one is longer). */
function fitSentences(text: string, max: number): string {
  let out = "";
  for (const s of sentences(text)) {
    if ((out + " " + s).length > max) break;
    out = out ? `${out} ${s}` : s;
  }
  return out || text.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

async function wikiQuery(params: Record<string, string>): Promise<any> {
  const url = `${WIKI_API}?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", ...params })}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(WIKI_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Wikipedia request failed: HTTP ${res.status}`);
  return await res.json();
}

async function searchTitles(query: string): Promise<string[]> {
  if (!query.trim()) return [];
  const search = await wikiQuery({ list: "search", srsearch: query, srlimit: String(ARTICLES), srprop: "" });
  return (search.query?.search ?? []).map((r: any) => String(r.title)).filter((t: string) => !/\(disambiguation\)$/i.test(t));
}

/** The top Wikipedia articles for `question`, with their full plain text and
 * search rank (0 = best). Searches both the whole question and just its key
 * words: the question alone often misses the main article ("how far away is
 * the moon" → a YouTuber; "moon" → Moon), the key words alone sometimes miss
 * the specific one. A game question also searches "<key words> video game",
 * so "who developed the game hades" finds the game, not the god, and each
 * game the question named by abbreviation or "this game" is searched by name.
 * (Full extracts come one page per request.) */
async function searchWikipedia(question: string, game: boolean, games: string[]): Promise<{ article: Article; rank: number }[]> {
  const words = searchWords(question).join(" ");
  const searches = [searchTitles(words), searchTitles(question), ...games.map(searchTitles)];
  if (game) searches.push(searchTitles(`${words.replace(/\b(video ?)?games?\b/g, "")} video game`));
  const lists = await Promise.all(searches);
  const rankOf = new Map<string, number>();
  for (const list of lists) list.forEach((t, i) => rankOf.set(t, Math.min(i, rankOf.get(t) ?? i)));
  const pages = await Promise.all([...rankOf].map(async ([title, rank]) => {
    try {
      const data = await wikiQuery({ prop: "extracts|info", explaintext: "1", inprop: "url", titles: title, redirects: "1" });
      const page = data.query?.pages?.[0];
      return page?.extract?.trim() ? { article: { title: page.title, url: page.fullurl, text: page.extract } as Article, rank } : null;
    } catch {
      return null; // one missing article shouldn't sink the others
    }
  }));
  return pages.filter((p) => p !== null);
}

/** Cuts an article into paragraph-sized passages, skipping reference sections
 * and the leftovers of math formulas (indented fragments, {\displaystyle …}). */
function passagesOf(article: Article, rank: number): Passage[] {
  const out: Passage[] = [];
  let lead = true;
  const add = (text: string) => out.push({ article, rank, index: out.length, lead, text, words: keywords(text) });
  let skipping = false;
  const text = article.text.replace(/\n[ \t]+[^\n]*/g, "").replace(/\s*\n(?=[),.;:])/g, "");
  for (const block of text.split(/\n+/)) {
    const heading = block.match(/^=+\s*(.*?)\s*=+$/);
    if (heading) {
      lead = false;
      skipping = SKIP_SECTIONS.test(heading[1]);
      continue;
    }
    const para = block.replace(/\s+/g, " ").trim();
    if (skipping || para.length < 40) continue;
    // Long paragraphs become several passages of whole sentences.
    let chunk = "";
    for (const s of sentences(para)) {
      if (chunk && chunk.length + s.length + 1 > MAX_PASSAGE_LEN) {
        add(chunk);
        chunk = "";
      }
      chunk = chunk ? `${chunk} ${s}` : s;
    }
    if (chunk) add(fitSentences(chunk, MAX_PASSAGE_LEN));
  }
  return out;
}

/** How well an article's title matches what the question names. A title
 * whose every word is in the question scores 2 per word (capped), so the
 * longest name the question spells out wins ("The Witcher 3" over "The
 * Witcher"); a title with words the question doesn't have scores little, so
 * a spin-off ("Elden Ring Nightreign") loses to the game itself. A title
 * matched only before its subtitle colon ("The Witcher 3: Wild Hunt") scores
 * a point less than the full name, so "Hollow Knight" beats "Hollow Knight:
 * Silksong". A "(video game)" title gains a point on a game question; any
 * other "(…)" title loses half of one, as Wikipedia gives the main topic the
 * bare name ("The Hobbit" over "The Hobbit (film series)"). */
function titleScore(title: string, wanted: Set<string>, game: boolean): number {
  const match = (name: string) => {
    const words = [...keywords(name)];
    const hits = words.filter((w) => wanted.has(w)).length;
    if (!hits) return 0;
    return hits === words.length ? 2 * Math.min(hits, 3) : hits / words.length;
  };
  const name = title.replace(/\s*\(.*\)$/, "");
  const colon = name.indexOf(":");
  const s = Math.max(match(name), colon > 0 ? match(name.slice(0, colon)) - 1 : 0);
  if (!s || name === title) return s;
  return s + (/\((\d{4} )?video game\)$/i.test(title) ? (game ? 1 : 0) : -0.5);
}

/** The passages that best match `question`, best first: the two best lead-
 * section passages (where Wikipedia puts the key facts) plus the best
 * passages from anywhere else. Each question word a passage contains counts
 * for more the rarer it is across all the passages (capped, so one odd word
 * can't outweigh the rest); the article the question names, a better-ranked
 * article and (for "how many/when…" questions) a passage with digits in it
 * get a nudge. */
function bestPassages(question: string, articles: { article: Article; rank: number }[], game: boolean): Passage[] {
  const all = articles.flatMap(({ article, rank }) => passagesOf(article, rank));
  const wanted = [...keywords(question)];
  const wantedSet = new Set(wanted);
  const titles = new Map(articles.map(({ article }) => [article.title, titleScore(article.title, wantedSet, game)]));
  const df = new Map(wanted.map((w) => [w, all.filter((p) => p.words.has(w)).length]));
  const numeric = NUMERIC_QUESTION.test(question.trim());
  const score = (p: Passage) => {
    let s = 0;
    for (const w of wanted) {
      const n = df.get(w) ?? 0;
      if (n && p.words.has(w)) s += Math.min(Math.log(1 + all.length / n), 2.5);
    }
    if (numeric && HAS_NUMBER.test(p.text)) s += 1;
    if (p.lead) s += 0.5;
    return s + (titles.get(p.article.title) ?? 0) - p.rank * 0.5;
  };
  const ranked = all.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s);
  const intros = ranked.filter(({ p }) => p.lead).slice(0, 2);
  const rest = ranked.filter(({ p }) => !p.lead).slice(0, PASSAGES - intros.length);
  return [...intros, ...rest].sort((a, b) => b.s - a.s).map(({ p }) => p);
}

/** Looks `question` up on Wikipedia and has the AI answer from what it finds. */
async function answerQuestion(broadcasterId: string, question: string): Promise<Answer | null> {
  const currentGame = await currentGameOf(broadcasterId);
  const { text: query, games } = expandQuestion(question, currentGame);
  const game = games.length > 0 || GAME_WORDS.test(query);
  let passages: Passage[];
  try {
    passages = bestPassages(query, await searchWikipedia(query, game, games), game);
  } catch (e) {
    console.error("askme Wikipedia lookup failed", e);
    await recordMonitorEvent("askme_error", `${broadcasterId}: ${String(e)}`);
    return null;
  }
  if (!passages.length) return null;

  try {
    const excerpts = passages.map((p, i) => `[${i + 1}] (${p.article.title}) ${p.text}`).join("\n\n");
    // No `temperature` override: some OpenAI models only accept the default.
    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: ANSWER_MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Passages:\n\n${excerpts}\n\n${currentGame ? `(The stream is playing ${currentGame}.)\n` : ""}Question: ${query}`,
        },
      ],
    }, { timeoutMs: AI_TIMEOUT_MS });
    const raw = String(completion.choices?.[0]?.message?.content ?? "");
    // The passage it cited; the best-matching one if it didn't say.
    const cited = Number(raw.match(/\[(\d)\]/)?.[1] ?? 0);
    const article = (passages[cited - 1] ?? passages[0]).article;
    const text = compactText(
      raw.replace(/\s*\[\d\]/g, "").replace(/\s*https?:\/\/\S+/g, "").replace(/[*_`#]/g, "").replace(/^["']|["']$/g, ""),
      MAX_ANSWER_LEN,
    );
    if (text) return { text, source: { url: article.url, title: article.title } };
  } catch (e) {
    console.error("askme AI answer failed", e);
    await recordMonitorEvent("askme_error", `${broadcasterId}: ${String(e)}`);
  }
  // The AI is down or said nothing: let the best passage speak for itself.
  const top = passages[0];
  return { text: fitSentences(top.text, MAX_ANSWER_LEN), source: { url: top.article.url, title: top.article.title } };
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

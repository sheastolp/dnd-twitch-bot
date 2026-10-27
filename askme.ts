// !askme <question> — a straight, factual answer from an AI, based on
// Wikipedia, game wikis and a web search, with a link to the page it used.
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
//     article text, no key) and on the web (DuckDuckGo, no key: websearch.ts
//     reads the top few result pages), picks the few passages that best match
//     the question, then the AI in openai.ts — Ollama or OpenAI, whichever the
//     bot uses — answers from those passages only and names the one it used,
//     whose page becomes the source link. The web covers what Wikipedia
//     doesn't: news, release dates, patches, prices. If one source is down,
//     the other still answers. ASKME_WEB_SEARCH=off leaves the web out;
//     ASKME_SEARCH_URL sends the searches through the Local AI search server
//     instead of straight to DuckDuckGo (see websearch.ts).
//   - ASKME_DEBUG=1 logs every lookup's passages and the AI's raw reply.
//   - Thinking models answer without thinking first (think: false in
//     openai.ts), and the AI gets ASKME_AI_TIMEOUT_S (default 90) to reply. Sending a handful of matching
//     passages instead of whole intros keeps the prompt small (fast on a CPU
//     Ollama) and puts the specific fact in front of the model. If the AI
//     call fails, the best passage itself is posted. ASKME_MODEL picks the
//     model when OPENAI_MODEL doesn't override it (default gpt-4o-mini).
//   - Game questions: chat abbreviations (bg3, botw, rdr2…) are spelled out,
//     "this game" becomes the channel's current Twitch category, game-worded
//     questions also search "… video game", and the article whose title the
//     question names outranks its sequels, spin-offs and namesakes. A game
//     the question names also gets its Fandom wiki searched (free, same API as
//     Wikipedia), which has the in-game detail Wikipedia doesn't — charms,
//     items, stats — and is credited as the source when it's used.
//   - Nothing is posted that doesn't answer the question: "couldn't find"
//     from the AI, or (when the AI is down) a best passage that misses most of
//     the question's words, becomes a "couldn't find" reply instead.
//   - Per-chatter cooldown (ASKME_USER_COOLDOWN_S, default 30 s, mods skip it)
//     and a channel-wide one (ASKME_CHANNEL_COOLDOWN_S, default 5 s).

import { isReasoningModel, OpenAI } from "./openai.ts";
import { mainContent, readPage, WEB_SEARCH_ON, webSearch } from "./websearch.ts";
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
const PASSAGES = 7;
/** Of those, how many are kept for the best web passages. */
const WEB_PASSAGES = 2;
/** Web results looked at, and how many of their pages are read in full. */
const WEB_RESULTS = 5;
const WEB_PAGES = 3;
// Sites already searched on their own (through their APIs).
const SEARCHED_SITES = /(^|\.)(wikipedia\.org|fandom\.com)$/i;
const MAX_PASSAGE_LEN = 400;
/** Score added to game-wiki passages over Wikipedia's. */
const GAME_WIKI_BONUS = 1.5;
/** The share of the question's words a passage must contain to be posted on
 * its own when the AI can't answer — below it, it's likely off topic. */
const MIN_FALLBACK_COVERAGE = 0.6;
// Roomy so "thinking" models (qwen3, gpt-5…) have budget left to answer;
// llama3.2 and the like stop after a sentence or two anyway.
const ANSWER_MAX_TOKENS = 1000;
const WIKI_TIMEOUT_MS = 8_000;
// A laptop GPU can take a while, more so when Ollama has to load the model first.
const AI_TIMEOUT_MS = Math.max(10, Number(Deno.env.get("ASKME_AI_TIMEOUT_S") ?? "90")) * 1000;
// ASKME_DEBUG=1 logs each question's lookup and the AI's raw reply, to see
// why an answer came out wrong or not at all.
const DEBUG = /^(1|true|yes|on)$/i.test(Deno.env.get("ASKME_DEBUG") ?? "");
const debug = (...args: unknown[]) => DEBUG && console.log("askme debug:", ...args);
const USER_COOLDOWN_MS = Math.max(0, Number(Deno.env.get("ASKME_USER_COOLDOWN_S") ?? "30")) * 1000;
const CHANNEL_COOLDOWN_MS = Math.max(0, Number(Deno.env.get("ASKME_CHANNEL_COOLDOWN_S") ?? "5")) * 1000;

const SYSTEM_PROMPT = [
  `You answer questions from viewers in a Twitch chat, using ONLY the numbered passages you are given, from Wikipedia, game wikis and web pages.`,
  `Answer exactly what was asked: if they ask for a number, name, date, place or yes/no, give that specific fact first. Don't summarize the topic or add background they didn't ask for.`,
  `Reply in plain text, one or two short sentences (under ${MAX_ANSWER_LEN} characters), then the number of the passage you used in brackets, e.g. "The Moon is about 384,400 km from Earth on average. [2]". No markdown, no links.`,
  `Passages can be about different things with similar names — a game and its sequel, spin-off or remake, a film, a book. Use only passages about exactly the thing asked about, and never mix facts from one into another.`,
  `You may be told which game the stream is playing: "this game" means that game, and you can use that note to say what game is being played.`,
  `If passages disagree, trust the most recent, most official-looking one. Web pages can be ads, forums or out of date: prefer the passages that state the fact plainly.`,
  `If the passages don't contain the answer, say you couldn't find it — never guess or add facts that aren't in them.`,
  `Keep it family-friendly. If a question asks for something harmful, hateful, sexual, or someone's private personal information, politely decline in one sentence.`,
].join(" ");

const lastUserAsk = new Map<string, number>();
const lastChannelAsk = new Map<string, number>();

interface Article {
  title: string;
  url: string;
  text: string;
  /** Where it's from, for the source line: "Wikipedia", a game wiki's name or a website. */
  site: string;
  kind: "wikipedia" | "gamewiki" | "web";
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
  source: { url: string; title: string; site: string };
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
  const search = await wikiQuery({ list: "search", srsearch: query, srlimit: String(ARTICLES), srprop: "", srinfo: "suggestion" });
  const titles = (search.query?.search ?? []).map((r: any) => String(r.title)).filter((t: string) => !/\(disambiguation\)$/i.test(t));
  // Nothing found for a typo or a run-together name ("hollowknight"): try
  // Wikipedia's own "did you mean" ("hollow knight").
  const suggestion = search.query?.searchinfo?.suggestion;
  return titles.length || !suggestion ? titles : await searchTitles(suggestion);
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
      return page?.extract?.trim()
        ? { article: { title: page.title, url: page.fullurl, text: page.extract, site: "Wikipedia", kind: "wikipedia" } as Article, rank }
        : null;
    } catch {
      return null; // one missing article shouldn't sink the others
    }
  }));
  return pages.filter((p) => p !== null);
}

/** Letters and digits only, lowercased: "Hollow Knight" → "hollowknight". */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The games a question is about: the ones it named by abbreviation or "this
 * game", plus any Wikipedia article it found that's a game and whose name the
 * question spells out, spaces or not ("hollowknight" → Hollow Knight). A
 * "(video game)" title only counts on a game-worded question, so "how far is
 * the moon" doesn't pull in a game called Moon. */
async function gamesAsked(question: string, named: string[], articles: { article: Article }[], game: boolean): Promise<string[]> {
  const asked = squash(question);
  const found = articles.filter(({ article }) => {
    const name = squash(article.title.replace(/\s*\(.*\)$/, "").replace(/:.*$/, ""));
    if (name.length < 4 || !asked.includes(name)) return false;
    if (/\(.*video game\)$/i.test(article.title)) return game;
    // The opening sentence says what it is: "Warframe is a … online game".
    return /\b(video|computer|online|mobile) game\b|\bgame (developed|published)\b/i.test(article.text.slice(0, 400));
  }).map(({ article }) => article.title.replace(/\s*\(.*\)$/, ""));
  return [...new Set([...named, ...found, ...await gamesByTitle(question)])].slice(0, 2);
}

/** Games named outright in the question that its search missed ("what is the
 * fastest warframe" finds articles that mention fast, not Warframe): every run
 * of one to three of its words is looked up as a Wikipedia title, and the
 * ones whose short description is "<year> video game" count, longest first. */
async function gamesByTitle(question: string): Promise<string[]> {
  const words = question.match(/[a-z0-9'&]+/gi) ?? [];
  const runs = new Set<string>();
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const run = words.slice(i, i + n);
      if (STOPWORDS.has(run[0].toLowerCase()) || STOPWORDS.has(run[n - 1].toLowerCase())) continue;
      runs.add(run.map((w) => w[0].toUpperCase() + w.slice(1)).join(" "));
    }
  }
  if (!runs.size) return [];
  try {
    const data = await wikiQuery({ prop: "description", titles: [...runs].slice(0, 50).join("|"), redirects: "1" });
    return (data.query?.pages ?? [])
      .filter((p: any) => /\bvideo game\b/i.test(p.description ?? ""))
      .map((p: any) => String(p.title).replace(/\s*\(.*\)$/, ""))
      .sort((a: string, b: string) => b.length - a.length);
  } catch {
    return [];
  }
}

// Fandom game wikis have the detail Wikipedia leaves out (charms, items,
// stats) and the same free MediaWiki API. A game's wiki is found by guessing
// its address, and kept so it's only looked up once.
const fandomWikis = new Map<string, { url: string; name: string } | null>();
// "Fastest"/"strongest" questions are answered by a stat page, which game
// wikis name by the stat ("Sprint Speed"), not the superlative.
const GAME_WIKI_TERMS: Record<string, string> = {
  fastest: "fastest speed", slowest: "slowest speed", strongest: "strongest damage", tankiest: "tankiest health armor",
  best: "best tier",
};
/** Most characters of a game-wiki page's HTML that get read (stat tables can be huge). */
const MAX_WIKI_HTML = 300_000;

async function fandomQuery(wiki: string, params: Record<string, string>): Promise<any> {
  const url = `${wiki}/api.php?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(WIKI_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Game wiki request failed: HTTP ${res.status}`);
  return await res.json(); // an unknown wiki answers with an HTML page, which throws here
}

/** The Fandom wiki for `game` ("Hollow Knight" → hollowknight.fandom.com),
 * or null. Tries the full name, without "The", and before its subtitle; the
 * wiki's own name must share a word with the game's, so a guess doesn't land
 * on an unrelated wiki. */
async function fandomWikiFor(game: string): Promise<{ url: string; name: string } | null> {
  const key = game.toLowerCase();
  if (fandomWikis.has(key)) return fandomWikis.get(key)!;
  const base = game.replace(/\s*\(.*\)$/, "");
  const short = base.replace(/:.*$/, "");
  const slugs = [...new Set([base, short, short.replace(/^the\s+/i, ""), short.replace(/\s*\d+$/, "")].map(squash))]
    .filter((s) => s.length >= 3);
  const gameWords = keywords(base);
  let found: { url: string; name: string } | null = null;
  for (const slug of slugs) {
    const url = `https://${slug}.fandom.com`;
    try {
      const name = String((await fandomQuery(url, { action: "query", meta: "siteinfo" })).query?.general?.sitename ?? "");
      if ([...keywords(name)].some((w) => gameWords.has(w))) {
        found = { url, name };
        break;
      }
    } catch { /* no wiki at that address */ }
  }
  fandomWikis.set(key, found);
  return found;
}

/** A game-wiki page's HTML as plain text in the shape Wikipedia extracts have:
 * "== Heading ==" lines, a paragraph or table row per line, cells split by "|". */
function htmlToText(html: string): string {
  return html.slice(0, MAX_WIKI_HTML)
    .replace(/<(script|style|sup)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<table[^>]*class="[^"]*navbox[\s\S]*?<\/table>/gi, "")
    .replace(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi, (_, h) => `\n== ${h.replace(/<[^>]+>/g, "").trim()} ==\n`)
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<(\/(p|tr|li|div|dd|dt)|br\s*\/?)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]*\|[ \t]*$/gm, "")
    .replace(/\[edit\]/gi, "");
}

/** The best pages on `game`'s Fandom wiki for `question`. The search leaves
 * out the game's own name, which is on every page of its wiki ("fastest
 * warframe" on the Warframe wiki searches "fastest"). */
async function searchGameWiki(question: string, game: string): Promise<{ article: Article; rank: number }[]> {
  const wiki = await fandomWikiFor(game);
  if (!wiki) return [];
  const gameWords = keywords(game);
  const words = searchWords(question).filter((w) => !gameWords.has(stem(w)) && !squash(game).includes(w));
  const query = (words.length ? words : searchWords(question)).map((w) => GAME_WIKI_TERMS[w] ?? w).join(" ");
  // A page named for what's asked about ("charm" → Charms) is usually the
  // overview, which the text search ranks below pages that just mention it.
  const named = words.flatMap((w) => {
    const word = w[0].toUpperCase() + w.slice(1);
    return [word, word.endsWith("s") ? word : `${word}s`];
  });
  try {
    const [search, exact] = await Promise.all([
      fandomQuery(wiki.url, { action: "query", list: "search", srsearch: query, srlimit: String(ARTICLES), srprop: "" }),
      named.length ? fandomQuery(wiki.url, { action: "query", titles: named.slice(0, 20).join("|"), redirects: "1" }) : null,
    ]);
    const titles: string[] = [...new Set([
      ...(exact?.query?.pages ?? []).filter((p: any) => !p.missing && p.ns === 0).map((p: any) => String(p.title)),
      ...(search.query?.search ?? []).map((r: any) => String(r.title)),
    ])].slice(0, ARTICLES + 1);
    const pages = await Promise.all(titles.map(async (title, rank) => {
      try {
        const page = (await fandomQuery(wiki.url, { action: "parse", page: title, prop: "text", redirects: "1", disabletoc: "1" })).parse;
        const text = htmlToText(String(page?.text ?? "")).trim();
        const url = `${wiki.url}/wiki/${encodeURIComponent(String(page.title).replace(/ /g, "_"))}`;
        return text ? { article: { title: page.title, url, text, site: wiki.name, kind: "gamewiki" } as Article, rank } : null;
      } catch {
        return null;
      }
    }));
    return pages.filter((p) => p !== null);
  } catch (e) {
    console.error("askme game wiki lookup failed", e);
    return [];
  }
}

/** The top web results for `query`, as articles: the first few pages read in
 * full, each led by its search snippet (the bit DuckDuckGo matched to the
 * question), and the rest as just their snippet. Wikipedia and Fandom are
 * left out, as they're searched on their own. Never throws: no web is fine. */
async function searchWeb(query: string): Promise<{ article: Article; rank: number }[]> {
  if (!WEB_SEARCH_ON) return [];
  try {
    const results = (await webSearch(query, WEB_RESULTS + 3))
      .filter((r) => { try { return !SEARCHED_SITES.test(new URL(r.url).hostname); } catch { return false; } })
      .slice(0, WEB_RESULTS);
    const pages = await Promise.all(results.map(async (r, rank) => {
      const html = rank < WEB_PAGES ? await readPage(r.url) : null;
      const body = html ? htmlToText(mainContent(html)).trim() : "";
      const text = [r.snippet, body].filter(Boolean).join("\n");
      const site = new URL(r.url).hostname.replace(/^www\./, "");
      return text ? { article: { title: r.title || site, url: r.url, text, site, kind: "web" } as Article, rank } : null;
    }));
    return pages.filter((p) => p !== null);
  } catch (e) {
    console.error("askme web search failed", e);
    return [];
  }
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
  // The same paragraph can turn up on two pages (game wikis reuse text).
  const seen = new Set<string>();
  const all = articles.flatMap(({ article, rank }) => passagesOf(article, rank))
    .filter((p) => !seen.has(p.text) && seen.add(p.text));
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
    // A game wiki page was searched for this exact game, so it's on topic.
    if (p.article.kind === "gamewiki") s += GAME_WIKI_BONUS;
    return s + (titles.get(p.article.title) ?? 0) - p.rank * 0.5;
  };
  const ranked = all.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s);
  // Web pages' openings are menus as often as summaries, so they get their
  // own places instead of competing for the lead ones.
  const web = ranked.filter(({ p }) => p.article.kind === "web").slice(0, WEB_PASSAGES);
  const intros = ranked.filter(({ p }) => p.lead && p.article.kind !== "web").slice(0, 2);
  const picked = new Set([...web, ...intros]);
  const rest = ranked.filter((x) => !picked.has(x) && !(x.p.lead && x.p.article.kind !== "web")).slice(0, PASSAGES - picked.size);
  return [...picked, ...rest].sort((a, b) => b.s - a.s).map(({ p }) => p);
}

/** The passages the AI answers `query` from: Wikipedia's, the wiki of any
 * game the question names, and the web's. Wikipedia being down only throws
 * if the web found nothing either. (Exported for testing.) */
export async function findPassages(query: string, games: string[], game: boolean): Promise<Passage[]> {
  let wikiError: unknown = null;
  const [wikipedia, web] = await Promise.all([
    searchWikipedia(query, game, games).catch((e) => (wikiError = e, [])),
    searchWeb(query),
  ]);
  if (wikiError) {
    if (!web.length) throw wikiError;
    console.error("askme Wikipedia lookup failed", wikiError);
  }
  const gameWiki = (await Promise.all((await gamesAsked(query, games, wikipedia, game)).map((g) => searchGameWiki(query, g)))).flat();
  return bestPassages(query, [...gameWiki, ...wikipedia, ...web], game);
}

/** Looks `question` up on Wikipedia and the web, and has the AI answer from what it finds. */
async function answerQuestion(broadcasterId: string, question: string): Promise<Answer | null> {
  const currentGame = await currentGameOf(broadcasterId);
  const { text: query, games } = expandQuestion(question, currentGame);
  const game = games.length > 0 || GAME_WORDS.test(query);
  let passages: Passage[];
  try {
    passages = await findPassages(query, games, game);
  } catch (e) {
    console.error("askme lookup failed", e);
    await recordMonitorEvent("askme_error", `${broadcasterId}: ${String(e)}`);
    return null;
  }
  debug(`"${question}" → searched as "${query}"${games.length ? ` (games: ${games.join(", ")})` : ""}`);
  debug(`${passages.length} passages:\n` + passages.map((p, i) => `  [${i + 1}] ${p.article.kind} · ${p.article.site} · ${p.article.title}: ${p.text.slice(0, 160)}`).join("\n"));
  if (!passages.length) return null;

  try {
    // The date, so "latest" and "when is…" are answered from the right side of it.
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
    const excerpts = passages.map((p, i) => `[${i + 1}] (${p.article.site}: ${p.article.title}) ${p.text}`).join("\n\n");
    // No `temperature` override: some OpenAI models only accept the default.
    const ask = (retry: boolean) => openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: ANSWER_MAX_TOKENS,
      // Answering from passages needs no thinking, and on Ollama it's the slow part.
      think: false,
      // The second try, after the model got stuck repeating itself, is
      // steered away from repeating (reasoning models don't take these).
      ...(retry && !isReasoningModel(MODEL) ? { frequency_penalty: 0.6, presence_penalty: 0.3 } : {}),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Passages:\n\n${excerpts}\n\n(Today is ${today}.)\n${currentGame ? `(The stream is playing ${currentGame}.)\n` : ""}Question: ${query}`,
        },
      ],
    }, { timeoutMs: AI_TIMEOUT_MS });
    let completion;
    try {
      completion = await ask(false);
    } catch (e) {
      // Ollama aborts a reply that loops on the same words ("token repeat
      // limit reached", HTTP 500); one more go usually comes out fine.
      if (!/HTTP 5\d\d/.test(String(e))) throw e;
      console.warn("askme AI answer failed, trying once more:", String(e).slice(0, 200));
      completion = await ask(true);
    }
    const raw = String(completion.choices?.[0]?.message?.content ?? "");
    debug(`AI replied: ${JSON.stringify(raw)}`);
    // The passage it cited; the best-matching one if it didn't say.
    const cited = Number(raw.match(/\[(\d)\]/)?.[1] ?? 0);
    const article = (passages[cited - 1] ?? passages[0]).article;
    const text = compactText(
      raw.replace(/\s*\[\d\]/g, "").replace(/\s*https?:\/\/\S+/g, "").replace(/[*_`#]/g, "").replace(/^["']|["']$/g, ""),
      MAX_ANSWER_LEN,
    );
    // "I couldn't find that" with a source link under it reads as an answer.
    if (/\b(couldn'?t|could not|can'?t|cannot|unable to) find\b|\bdo(es)?n'?t (say|mention|contain|include)\b/i.test(text)) return null;
    if (text) return { text, source: { url: article.url, title: article.title, site: article.site } };
  } catch (e) {
    console.error("askme AI answer failed", e);
    await recordMonitorEvent("askme_error", `${broadcasterId}: ${String(e)}`);
  }
  // The AI is down or said nothing: let a passage speak for itself — the one
  // that covers the most of what was asked (the best-ranked of those), and
  // only if it covers most of it, so an unrelated paragraph isn't posted as
  // the answer.
  const wanted = [...keywords(query)];
  if (!wanted.length) return null;
  const coverage = (p: Passage) => {
    const title = keywords(p.article.title);
    return wanted.filter((w) => p.words.has(w) || title.has(w)).length / wanted.length;
  };
  const top = passages.reduce((best, p) => coverage(p) > coverage(best) ? p : best);
  if (coverage(top) < MIN_FALLBACK_COVERAGE) return null;
  return {
    text: fitSentences(top.text, MAX_ANSWER_LEN),
    source: { url: top.article.url, title: top.article.title, site: top.article.site },
  };
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
    await sendChatMessage(`@${display} I couldn't find a reliable answer to that — try wording it differently.`, broadcasterId);
    return true;
  }

  // "@name " (≤27) + answer (≤300) + source (≤~165) stays under Twitch's 500-character limit.
  // A very long article URL is left off rather than cut mid-link.
  const title = compactText(answer.source.title, 30);
  const link = answer.source.url.length <= MAX_URL_LEN ? ` — ${answer.source.url}` : "";
  const site = compactText(answer.source.site, 30);
  const reply = `@${display} ${answer.text} 📚 Source: ${site}, ${title}${link}`;
  await sendChatMessage(reply, broadcasterId, [], { keepNames: true });
  return true;
}

// Free web search for !askme: DuckDuckGo's plain HTML results (no key, no
// account), and reading a result page as text.
//
//   webSearch(query, n)   [{ title, url, snippet }], best first
//   readPage(url)         the page's HTML, or null
//
//   - DuckDuckGo limits automated searches, so they're spaced out
//     (SEARCH_GAP_MS) and kept for CACHE_MS. When it asks for a captcha, or
//     doesn't answer, the search throws and !askme carries on with Wikipedia.
//   - Pages are only read from public addresses (checked on every redirect),
//     so a link in a search result can't reach the bot host's own network.
//   - ASKME_WEB_SEARCH=off turns it off; SEARCH_REGION picks DuckDuckGo's
//     region (default wt-wt, none; e.g. us-en).

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const REGION = Deno.env.get("SEARCH_REGION") || "wt-wt";
export const WEB_SEARCH_ON = !/^(off|false|0|no)$/i.test(Deno.env.get("ASKME_WEB_SEARCH") ?? "");
const SEARCH_TIMEOUT_MS = 8_000;
const PAGE_TIMEOUT_MS = 6_000;
const SEARCH_GAP_MS = 1_200;
const CACHE_MS = 15 * 60 * 1000;
/** Most bytes of a page that get downloaded. */
const MAX_PAGE_BYTES = 1_500_000;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decode = (s: string) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (ENTITIES[e.toLowerCase()] != null) return ENTITIES[e.toLowerCase()];
    const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : /^#/.test(e) ? Number(e.slice(1)) : NaN;
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
const strip = (html: string) => decode(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

/** Result links come wrapped as //duckduckgo.com/l/?uddg=<real url>; ads
 * and DuckDuckGo's own links come back null. */
function realUrl(href: string): string | null {
  href = decode(href);
  if (href.startsWith("//")) href = "https:" + href;
  try {
    const u = new URL(href, "https://duckduckgo.com/");
    if (/(^|\.)duckduckgo\.com$/.test(u.hostname)) {
      const target = u.pathname === "/l/" ? u.searchParams.get("uddg") : null;
      return target && /^https?:\/\//i.test(target) ? target : null;
    }
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/** html.duckduckgo.com: each result is a div.result with a.result__a (the
 * title) and .result__snippet. (Exported for testing.) */
export function parseHtmlResults(page: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const block of page.split(/<div[^>]+class="[^"]*?\bresult\b/).slice(1)) {
    if (/^[^>]*result--ad/.test(block)) continue;
    const a = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) ??
      block.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const url = a ? realUrl(a[1]) : null;
    if (!a || !url) continue;
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
    out.push({ title: strip(a[2]), url, snippet: snippet ? strip(snippet[1]) : "" });
  }
  return out;
}

/** lite.duckduckgo.com: a table, with a.result-link followed by
 * td.result-snippet. (Exported for testing.) */
export function parseLiteResults(page: string): SearchResult[] {
  const out: SearchResult[] = [];
  const re = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>|<a[^>]*class=['"]result-link['"][^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>|<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
  for (const m of page.matchAll(re)) {
    if (m[5] != null) {
      const last = out[out.length - 1];
      if (last && !last.snippet) last.snippet = strip(m[5]);
      continue;
    }
    const url = realUrl(m[1] ?? m[3]);
    if (url) out.push({ title: strip(m[2] ?? m[4]), url, snippet: "" });
  }
  return out;
}

const cache = new Map<string, { at: number; value: Promise<SearchResult[]> }>();
let nextTurn = 0;

async function ddg(endpoint: string, query: string, parse: (page: string) => SearchResult[]): Promise<SearchResult[]> {
  const wait = nextTurn - Date.now();
  nextTurn = Math.max(Date.now(), nextTurn) + SEARCH_GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html", "Accept-Language": "en-US,en;q=0.8" },
    body: new URLSearchParams({ q: query, kl: REGION }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  const page = await res.text();
  // A 202, or a page with the "anomaly" captcha, is DuckDuckGo deciding we're a bot.
  if (res.status === 202 || /anomaly-modal|class="anomaly/.test(page)) throw new Error("DuckDuckGo asked for a captcha (too many searches)");
  if (!res.ok) throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);
  return parse(page);
}

/** The top `n` DuckDuckGo results for `query`. Tries the HTML page, then the
 * plainer lite page, which sometimes answers when the other won't. */
export function webSearch(query: string, n = 5): Promise<SearchResult[]> {
  const key = `${n}:${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = (async () => {
    let first: unknown;
    try {
      const results = await ddg("https://html.duckduckgo.com/html/", query, parseHtmlResults);
      if (results.length) return results.slice(0, n);
    } catch (e) {
      first = e;
    }
    try {
      return (await ddg("https://lite.duckduckgo.com/lite/", query, parseLiteResults)).slice(0, n);
    } catch (e) {
      throw first ?? e;
    }
  })();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return value;
}

/** True for loopback, private, link-local, CGNAT (Tailscale) and multicast addresses. */
function privateIp(ip: string): boolean {
  const v4 = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

/** Whether `url` is on the public internet (resolving its name to check). */
async function isPublic(url: URL): Promise<boolean> {
  if (!/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.(local|internal|lan|home|ts\.net)$/i.test(host)) return false;
  if (/^[\d.]+$/.test(host) || host.includes(":")) return !privateIp(host);
  const ips = (await Promise.all((["A", "AAAA"] as const).map((t) => Deno.resolveDns(host, t).catch(() => [] as string[])))).flat();
  return ips.length > 0 && !ips.some(privateIp);
}

/** A result page's HTML (text pages too), or null if it can't be read. */
export async function readPage(raw: string): Promise<string | null> {
  try {
    let url = new URL(raw);
    let res: Response | null = null;
    for (let hops = 0; hops <= 4; hops++) { // redirects by hand, so each hop is checked
      if (!await isPublic(url)) return null;
      res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,text/plain;q=0.9" }, redirect: "manual", signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!next) break;
      await res.body?.cancel();
      url = new URL(next, url);
      res = null;
    }
    if (!res?.ok || !res.body || !/text\/(html|plain)|xhtml/.test(res.headers.get("content-type") ?? "")) {
      await res?.body?.cancel();
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_PAGE_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel().catch(() => {});
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** The part of a web page worth reading: its <article> or <main> if it has
 * one, without scripts, menus, headers, footers, sidebars and forms. */
export function mainContent(html: string): string {
  const body = html.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? html.match(/<body\b[^>]*>([\s\S]*)/i)?.[1] ?? html;
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, " ");
}

// Baldur's Gate 3 knowledgebase lookup — !bg3lookup
//
// Search + formatting for the static BG3 knowledgebase in bg3data.ts.
// Unlike lookups.ts (which calls the dnd5eapi.co SRD API), this is a fully
// local, hand-curated dataset — there's no public BG3 API to query.

import { BG3_CATEGORY_ALIASES, BG3_CATEGORY_LABELS, BG3_KNOWLEDGEBASE, type Bg3Category, type Bg3Entry } from "./bg3data.ts";
import { compactText } from "./utils.ts";

function normalize(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function comparable(value: string): string {
  return normalize(value).replace(/ /g, "");
}

/** Public bg3.wiki search link for chat — no scraping, just a reference jump-off point. */
export function bg3WikiLink(name: string): string {
  return `https://bg3.wiki/wiki/Special:Search?search=${encodeURIComponent(name)}`;
}

/**
 * Splits "!bg3lookup <query>" into an optional leading category keyword and
 * the remaining search text, e.g. "companion astarion" -> category
 * "companion", query "astarion". Falls back to an unfiltered search when the
 * first word isn't a recognized category.
 */
export function parseBg3LookupQuery(raw: string): { category: Bg3Category | null; query: string } {
  const trimmed = raw.trim();
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace > 0) {
    const maybeCategory = trimmed.slice(0, firstSpace).toLowerCase();
    const resolved = BG3_CATEGORY_ALIASES[maybeCategory];
    if (resolved) {
      return { category: resolved, query: trimmed.slice(firstSpace + 1).trim() };
    }
  }
  return { category: null, query: trimmed };
}

/** Finds the best matching knowledgebase entry for a chat query, optionally scoped to one category. */
export function findBg3Entry(query: string, category: Bg3Category | null = null): Bg3Entry | null {
  if (!query || query.length > 60) return null;
  const wanted = comparable(query);
  if (!wanted) return null;
  const pool = category ? BG3_KNOWLEDGEBASE.filter((e) => e.category === category) : BG3_KNOWLEDGEBASE;

  const exact = pool.find(
    (e) => comparable(e.name) === wanted || (e.aliases ?? []).some((a) => comparable(a) === wanted),
  );
  if (exact) return exact;

  const partial = pool.find((e) => {
    const nameC = comparable(e.name);
    if (nameC.includes(wanted) || wanted.includes(nameC)) return true;
    return (e.aliases ?? []).some((a) => {
      const aliasC = comparable(a);
      return aliasC.includes(wanted) || wanted.includes(aliasC);
    });
  });
  return partial ?? null;
}

/** Formats a knowledgebase entry as a single chat-ready string (sendChatMessages splits it if needed). */
export function formatBg3Entry(entry: Bg3Entry): string {
  const label = BG3_CATEGORY_LABELS[entry.category];
  const link = bg3WikiLink(entry.name);
  return `🔗 ${link} | [${label}] ${entry.name}: ${compactText(entry.summary, 400)}`;
}

/** Comma-separated list of recognized category keywords, for usage text. */
export function bg3CategoryList(): string {
  return Object.keys(BG3_CATEGORY_LABELS).join(", ");
}

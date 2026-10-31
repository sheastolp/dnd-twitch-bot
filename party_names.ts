// Party names: free-form, multi-word ("the iron wolves"). Pure helpers — no
// DB, no chat — shared by !party (combat_party.ts) and !dndduel party
// (combat_partyduel.ts), so a name with spaces can sit in front of other
// arguments (a monster, a second party) and still be told apart.
//
// Names are stored normalized: lowercase, letters/digits/_/-/spaces, runs of
// spaces collapsed, at most PARTY_NAME_MAX characters.

export const PARTY_NAME_MAX = 32;

/** "  The   IRON wolves!" → "the iron wolves". Leading @ and quotes are dropped. */
export function normalizePartyName(raw: string): string {
  return (raw ?? "")
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PARTY_NAME_MAX)
    .trim();
}

const OPEN_QUOTE = /^["“'‘]/;
const CLOSE_QUOTE = /["”'’]$/;

/**
 * Pulls a party name off the front of `words`, returning it and the words
 * after it. A quoted name ("iron wolves") is taken as written; otherwise the
 * longest run of leading words that names a party in `known` wins. With no
 * match, `fallback` decides: "all" treats every word as the name (for
 * commands where the name is the last argument), "first" just the first word.
 */
export function takePartyName(
  words: string[],
  known: Iterable<string>,
  fallback: "all" | "first" = "all",
): { name: string; rest: string[] } {
  if (!words.length) return { name: "", rest: [] };
  if (OPEN_QUOTE.test(words[0])) {
    const end = words.findIndex((w, i) => CLOSE_QUOTE.test(i === 0 ? w.slice(1) : w));
    if (end >= 0) return { name: normalizePartyName(words.slice(0, end + 1).join(" ")), rest: words.slice(end + 1) };
  }
  const names = new Set([...known].map(normalizePartyName));
  for (let k = words.length; k >= 1; k--) {
    const name = normalizePartyName(words.slice(0, k).join(" "));
    if (name && names.has(name)) return { name, rest: words.slice(k) };
  }
  return fallback === "all"
    ? { name: normalizePartyName(words.join(" ")), rest: [] }
    : { name: normalizePartyName(words[0]), rest: words.slice(1) };
}

const RENAME_SEPARATORS = new Set(["to", "->", "=>", ">", "|"]);

/**
 * Reads the arguments of !party rename against the parties the caller may
 * rename (`renamable`):
 *   <old name> to <new name>   (also ->, =>, >, |)
 *   <old name> <new name>      (old name must match a renamable party)
 *   <new name>                 (only when there's exactly one renamable party)
 * Returns null when it can't tell which party is meant.
 */
export function parseRename(words: string[], renamable: string[]): { from: string; to: string } | null {
  if (!words.length) return null;
  const owned = renamable.map(normalizePartyName);
  for (let i = 1; i < words.length - 1; i++) {
    if (!RENAME_SEPARATORS.has(words[i].toLowerCase())) continue;
    const from = normalizePartyName(words.slice(0, i).join(" "));
    if (owned.includes(from)) return { from, to: normalizePartyName(words.slice(i + 1).join(" ")) };
  }
  if (owned.length > 1) {
    const { name, rest } = takePartyName(words, owned, "first");
    if (owned.includes(name) && rest.length) return { from: name, to: normalizePartyName(rest.join(" ")) };
    return null;
  }
  if (owned.length === 1) return { from: owned[0], to: normalizePartyName(words.join(" ")) };
  return null;
}

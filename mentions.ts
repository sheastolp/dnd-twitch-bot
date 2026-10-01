// Mention limiter. Twitch (and mod-view/extension chat clients) box-highlight
// any chatter name in a message, so an auto-resolved battle log that repeats a
// viewer's name on every swing lights up like a Christmas tree. A name keeps
// its normal, highlightable form for its first MAX_NAME_MENTIONS appearances in
// a response; after that one lookalike letter is swapped so it still reads as
// the same plain name but no longer matches a chatter.
//
// Applied across the WHOLE response before it is split into chat parts, so the
// count isn't reset by the part breaks.

export const MAX_NAME_MENTIONS = 2;
const ZWSP = "\u200B";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Latin letters that have a Cyrillic twin. Swapping ONE of them makes the name
// look identical but no longer match the chatter. Twitch can strip zero-width
// characters, so a zero-width space alone isn't a reliable way to defuse a
// highlight; it's only the fallback for names with no swappable letter.
const TWINS: Record<string, string> = { a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", i: "і" };

/** The same name, readable as-is, that Twitch will not highlight. */
export function quietName(name: string): string {
  for (let i = name.length - 1; i >= 0; i--) {
    const twin = TWINS[name[i]];
    if (twin) return name.slice(0, i) + twin + name.slice(i + 1);
  }
  return name.length > 1 ? name[0] + ZWSP + name.slice(1) : name;
}

/**
 * Keeps the first `max` appearances of each name (case-insensitive, whole
 * word, with or without a leading @) as written and quiets the rest.
 * `names` that are empty/duplicate are ignored.
 */
export function limitNameMentions(text: string, names: string[], max = MAX_NAME_MENTIONS): string {
  const uniq = [...new Set(names.map((n) => n.replace(/^@/, "").trim()).filter(Boolean))];
  if (!uniq.length) return text;
  const alternation = uniq.map(escapeRe).sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(`(^|[^A-Za-z0-9_])(@?)(${alternation})(?![A-Za-z0-9_])`, "gi");
  const seen = new Map<string, number>();
  return text.replace(re, (_m, pre: string, at: string, name: string) => {
    const key = name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n <= max) return pre + at + name;
    return pre + quietName(name); // drop the @ too once past the limit
  });
}

/** Names worth guarding in `text`: its leading @tag plus any extra names. */
export function mentionNames(text: string, extra: string[] = []): string[] {
  const lead = text.match(/^@([A-Za-z0-9_]{1,25})\b/);
  return [...(lead ? [lead[1]] : []), ...extra];
}

// Mention limiter. Twitch (and mod-view/extension chat clients) box-highlight
// any chatter name in a message, so an auto-resolved battle log that repeats a
// viewer's name on every swing lights up like a Christmas tree. A name keeps
// its normal, highlightable form for its first MAX_NAME_MENTIONS appearances in
// a response; after that a zero-width space is slipped inside it so it still
// reads as the same plain name but no longer matches a chatter.
//
// Applied across the WHOLE response before it is split into chat parts, so the
// count isn't reset by the part breaks.

export const MAX_NAME_MENTIONS = 2;
const ZWSP = "\u200B";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Plain name with a zero-width space after its first character. */
export const quietName = (name: string) => (name.length > 1 ? name[0] + ZWSP + name.slice(1) : name);

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

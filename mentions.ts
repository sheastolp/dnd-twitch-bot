// @-tag limiter. Within one response, a name keeps its "@" for its first
// MAX_TAGS appearances; any further "@name" has the "@" removed so it reads as
// the plain name. Applied across the WHOLE response before it is split into
// chat parts, so the count isn't reset by part breaks. Bare (un-@'d) names are
// never touched.

export const MAX_TAGS = 2;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function limitNameMentions(text: string, names: string[], max = MAX_TAGS): string {
  const uniq = [...new Set(names.map((n) => n.replace(/^@/, "").trim()).filter(Boolean))];
  if (!uniq.length) return text;
  const alternation = uniq.map(escapeRe).sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(`@(${alternation})(?![A-Za-z0-9_])`, "gi");
  const seen = new Map<string, number>();
  return text.replace(re, (m, name: string) => {
    const key = name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n <= max ? m : name;
  });
}

/** Names worth guarding in `text`: its leading @tag plus any extra names. */
export function mentionNames(text: string, extra: string[] = []): string[] {
  const lead = text.match(/^(?:[^\w@]*)@([A-Za-z0-9_]{1,25})\b/);
  return [...(lead ? [lead[1]] : []), ...extra];
}

// @-tag limiter. Within one response, a name keeps its "@" for its first
// MAX_TAGS appearances; any further "@name" has the "@" removed so it reads as
// the plain name. Applied across the WHOLE response before it is split into
// chat parts, so the count isn't reset by part breaks. Bare (un-@'d) names are
// never touched.

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

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

// ── Short names for battle logs ─────────────────────────────────────────────
// Twitch boxes every plain-text chatter name too, so a log that repeats
// "stonedsheamus" on every swing still lights up. Inside battle logs a bare
// fighter name (anything but the reply's own @tag) is replaced by ONE COMPLETE
// WORD of it: the first word of their display name, split on capitals,
// underscores, digits and hyphens — "StonedSheamus" -> "Stoned",
// "xX_DragonSlayer_Xx" -> "Dragon". Display names come from the leading @tag,
// from any mixed-case name passed in, and from viewer_names (remembered
// whenever someone runs a command). Where no word boundary can be found (an
// all-lowercase single-token name we have never seen with capitals), it falls
// back to the first SHORT_NAME_LETTERS letters plus an ellipsis ("Stone…").
// If two fighters would end up with the same label, those fall back too, with
// the ellipsis form lengthened until they differ.

export const SHORT_NAME_LETTERS = 5;

export async function ensureViewerNameTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS viewer_names (
      broadcaster_id TEXT NOT NULL, username TEXT NOT NULL, display_name TEXT NOT NULL,
      PRIMARY KEY (broadcaster_id, username)
    )`,
  );
}

/** Remembers how a viewer capitalizes their name (called when they run a command). */
export async function recordViewerName(broadcasterId: string, username: string, display: string) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO viewer_names (broadcaster_id, username, display_name) VALUES (?,?,?)",
    [broadcasterId, username.toLowerCase(), display],
  );
}

/** lowercase login -> remembered display name, for whichever of `names` are known. */
export async function lookupViewerNames(broadcasterId: string, names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(names.map((n) => n.replace(/^@/, "").trim().toLowerCase()).filter(Boolean))];
  if (!uniq.length) return out;
  const res = await sqlite.execute(
    `SELECT username, display_name FROM viewer_names WHERE broadcaster_id = ? AND username IN (${uniq.map(() => "?").join(",")})`,
    [broadcasterId, ...uniq],
  );
  for (const r of res.rows as any[]) out.set(String(r.username), String(r.display_name));
  return out;
}

export async function purgeViewerNames(broadcasterId: string) {
  await sqlite.execute("DELETE FROM viewer_names WHERE broadcaster_id = ?", [broadcasterId]);
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** First whole word of a name, or null if it can't be told apart from the name. */
export function firstWord(name: string, display?: string): string | null {
  const source = display && display.toLowerCase() === name.toLowerCase() ? display : name;
  const words = source.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? [];
  const word = words.find((w) => w.length >= 3) ?? words[0];
  if (!word || word.toLowerCase() === name.toLowerCase()) return null;
  return cap(word.toLowerCase());
}

function truncated(name: string, len: number): string {
  return cap(name.slice(0, len)) + "…";
}

/** lowercase name -> short label, distinct across `names`. */
export function shortNameMap(names: string[], displays: Map<string, string> = new Map()): Map<string, string> {
  const hints = new Map(displays);
  for (const raw of names) {
    const n = raw.replace(/^@/, "").trim();
    if (n && n !== n.toLowerCase() && !hints.has(n.toLowerCase())) hints.set(n.toLowerCase(), n);
  }
  const uniq = [...new Set(names.map((n) => n.replace(/^@/, "").trim().toLowerCase()).filter(Boolean))];
  const label = new Map<string, string>();
  const word = new Set<string>(); // names that got a whole-word label
  for (const n of uniq) {
    const w = firstWord(n, hints.get(n));
    if (w) {
      label.set(n, w);
      word.add(n);
    }
  }
  // Collisions between whole-word labels -> those fall back to truncation.
  const seen = new Map<string, string[]>();
  for (const n of word) seen.set(label.get(n)!.toLowerCase(), [...(seen.get(label.get(n)!.toLowerCase()) ?? []), n]);
  for (const group of seen.values()) if (group.length > 1) for (const n of group) word.delete(n);
  // Truncation for everyone without a (unique) word, lengthened until distinct.
  const lens = new Map<string, number>();
  for (const n of uniq) if (!word.has(n)) lens.set(n, SHORT_NAME_LETTERS);
  const taken = new Set([...word].map((n) => label.get(n)!.toLowerCase()));
  for (let guard = 0; guard < 40; guard++) {
    const groups = new Map<string, string[]>();
    for (const [n, len] of lens) {
      const key = truncated(n, len).toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), n]);
    }
    let changed = false;
    for (const [key, group] of groups) {
      if (group.length < 2 && !taken.has(key)) continue;
      for (const n of group) if (lens.get(n)! < n.length) { lens.set(n, lens.get(n)! + 1); changed = true; }
    }
    if (!changed) break;
  }
  for (const [n, len] of lens) label.set(n, truncated(n, len));
  return label;
}

/** Replaces bare occurrences of `names` (not "@name") with their short label. */
export function shortenNames(text: string, names: string[], displays: Map<string, string> = new Map()): string {
  const map = shortNameMap(names, displays);
  if (!map.size) return text;
  const alternation = [...map.keys()].map(escapeRe).sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(`(?<![@A-Za-z0-9_])(${alternation})(?![A-Za-z0-9_])`, "gi");
  return text.replace(re, (_m, name: string) => map.get(name.toLowerCase()) ?? name);
}

// @-tag limiter. Within one response, every name keeps its "@" for its
// first MAX_TAGS appearances; any further "@name" has the "@" removed so it
// reads as the plain name. Applied across the WHOLE response before it is split into
// chat parts, so the count isn't reset by part breaks. Bare (un-@'d) names are
// never touched.

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

export const MAX_TAGS = 2;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every "@name" in `text` keeps its "@" for its first `max` appearances;
 * later ones lose the "@" (no extra ping). Pass the same `seen` map to carry
 * the count across several chat messages of one response. */
export function limitAllMentions(text: string, max = MAX_TAGS, seen = new Map<string, number>()): string {
  return text.replace(/(^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{1,25})(?![A-Za-z0-9_])/g, (m, pre: string, name: string) => {
    const key = name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n <= max ? m : pre + name;
  });
}

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
// fighter name (anything but the reply's own @tag) is replaced by a shorter
// label, chosen in this order:
//   1. A NICKNAME a mod set with !nick (nick.ts, stored in viewer_nicknames),
//      then the NAME_ALIASES env var, then BUILTIN_NAME_ALIASES.
//   2. ONE COMPLETE WORD of the display name, split on capitals, underscores,
//      digits and hyphens — "StonedSheamus" -> "Stoned", "xX_DragonSlayer_Xx"
//      -> "Dragon". Display names come from the leading @tag, from any
//      mixed-case name passed in, and from viewer_names (remembered whenever
//      someone runs a command).
//   3. Otherwise (an all-lowercase name with no word boundary) the FIRST FEW
//      LETTERS with no ellipsis — "felivore" -> "Feli". The length is
//      SHORT_NAME_LETTERS (default 4; set the env var to 3 for "Fel").
// If two fighters would end up with the same label, the truncated ones are
// lengthened one letter at a time until they differ.

export const SHORT_NAME_LETTERS = Math.min(8, Math.max(2, Math.floor(Number(Deno.env.get("SHORT_NAME_LETTERS") ?? "4")) || 4));

// Hand-picked nicknames for battle logs, keyed by lowercase login. Use these
// for regulars whose all-lowercase name can't be split into words (so they'd
// otherwise be cut to their first few letters). More can be added without a deploy via the
// NAME_ALIASES env var, formatted "login=Nick,login2=Nick2".
const BUILTIN_NAME_ALIASES: Record<string, string> = {
  felivore: "Fel",
};

function nameAliases(): Map<string, string> {
  const out = new Map(Object.entries(BUILTIN_NAME_ALIASES));
  for (const pair of (Deno.env.get("NAME_ALIASES") ?? "").split(",")) {
    const [login, nick] = pair.split("=").map((x) => x?.trim());
    if (login && nick) out.set(login.toLowerCase(), nick);
  }
  return out;
}

export async function ensureViewerNameTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS viewer_names (
      broadcaster_id TEXT NOT NULL, username TEXT NOT NULL, display_name TEXT NOT NULL,
      PRIMARY KEY (broadcaster_id, username)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS viewer_nicknames (
      broadcaster_id TEXT NOT NULL, username TEXT NOT NULL, nickname TEXT NOT NULL,
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
  await sqlite.execute("DELETE FROM viewer_nicknames WHERE broadcaster_id = ?", [broadcasterId]);
}

/** lowercase login -> mod-set nickname (!nick), for whichever of `names` have one. */
export async function lookupNicknames(broadcasterId: string, names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(names.map((n) => n.replace(/^@/, "").trim().toLowerCase()).filter(Boolean))];
  if (!uniq.length) return out;
  const res = await sqlite.execute(
    `SELECT username, nickname FROM viewer_nicknames WHERE broadcaster_id = ? AND username IN (${uniq.map(() => "?").join(",")})`,
    [broadcasterId, ...uniq],
  );
  for (const r of res.rows as any[]) out.set(String(r.username), String(r.nickname));
  return out;
}

export async function setNickname(broadcasterId: string, username: string, nickname: string) {
  await sqlite.execute("INSERT OR REPLACE INTO viewer_nicknames (broadcaster_id, username, nickname) VALUES (?,?,?)", [
    broadcasterId,
    username.toLowerCase(),
    nickname,
  ]);
}

/** True if a nickname existed and was removed. */
export async function removeNickname(broadcasterId: string, username: string): Promise<boolean> {
  const before = await sqlite.execute("SELECT 1 FROM viewer_nicknames WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username.toLowerCase()]);
  if (!before.rows.length) return false;
  await sqlite.execute("DELETE FROM viewer_nicknames WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username.toLowerCase()]);
  return true;
}

export async function listNicknames(broadcasterId: string): Promise<Array<{ username: string; nickname: string }>> {
  const res = await sqlite.execute("SELECT username, nickname FROM viewer_nicknames WHERE broadcaster_id = ? ORDER BY username", [broadcasterId]);
  return res.rows.map((r: any) => ({ username: String(r.username), nickname: String(r.nickname) }));
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
  return cap(name.slice(0, len));
}

/** lowercase name -> short label, distinct across `names`. */
export function shortNameMap(
  names: string[],
  displays: Map<string, string> = new Map(),
  nicks: Map<string, string> = new Map(),
): Map<string, string> {
  const hints = new Map(displays);
  for (const raw of names) {
    const n = raw.replace(/^@/, "").trim();
    if (n && n !== n.toLowerCase() && !hints.has(n.toLowerCase())) hints.set(n.toLowerCase(), n);
  }
  const uniq = [...new Set(names.map((n) => n.replace(/^@/, "").trim().toLowerCase()).filter(Boolean))];
  const label = new Map<string, string>();
  const word = new Set<string>(); // names that got a whole-word label
  // Nicknames win outright; nobody else may end up with the same label.
  const aliases = nameAliases();
  for (const [login, nick] of nicks) aliases.set(login.toLowerCase(), nick); // !nick wins over env/built-in
  const aliased = new Set<string>();
  for (const n of uniq) {
    const nick = aliases.get(n);
    if (nick) {
      label.set(n, nick);
      aliased.add(n);
    }
  }
  const nickLabels = new Set([...aliased].map((n) => label.get(n)!.toLowerCase()));
  for (const n of uniq) {
    if (aliased.has(n)) continue;
    const w = firstWord(n, hints.get(n));
    if (w && nickLabels.has(w.toLowerCase())) continue; // clashes with a nickname -> truncate instead
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
  for (const n of uniq) if (!word.has(n) && !aliased.has(n)) lens.set(n, SHORT_NAME_LETTERS);
  const taken = new Set([...word, ...aliased].map((n) => label.get(n)!.toLowerCase()));
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
export function shortenNames(
  text: string,
  names: string[],
  displays: Map<string, string> = new Map(),
  nicks: Map<string, string> = new Map(),
): string {
  const map = shortNameMap(names, displays, nicks);
  if (!map.size) return text;
  const alternation = [...map.keys()].map(escapeRe).sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(`(?<![@A-Za-z0-9_])(${alternation})(?![A-Za-z0-9_])`, "gi");
  return text.replace(re, (_m, name: string) => map.get(name.toLowerCase()) ?? name);
}

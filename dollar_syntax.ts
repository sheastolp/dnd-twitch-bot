// $(…) placeholder syntax for custom command/trigger responses — the
// Nightbot/Fossabot-style spelling many streamers already know. Each $(…) is
// rewritten into the equivalent {…} placeholder before customcommands.ts's
// applyTemplate resolves anything, so both spellings behave identically and
// can be mixed in one response.
//
//   $(user) $(sender) $(target) $(touser) $(args) $(1)…$(9) $(count)
//   $(channel) $(time) $(date) $(game) $(title) $(status) $(uptime)
//   $(twitchemotes) $(7tvemotes) $(bttvemotes) $(ffzemotes) $(d4)…$(d100)
//                           → the {same} placeholder
//   $(count name)           add 1 to counter "name", show the new value
//   $(count name +N|-N)     add/subtract N, show the new value
//   $(count name =N)        set the counter to N, show it
//   $(getcount name) $(var name)  show the value without changing it
//                           ($(var name +N/-N/=x) works like count)
//   $(random a|b|c)         → {random:a|b|c}
//   $(randnum 1-10) $(randnum 1 10)  → {randnum:1-10}
//   $(roll 2d6+3)           → {roll:2d6+3}
//   $(math (2+3)*4)         → {math:(2+3)*4}
//   $(repeat 3 text)        → {repeat:3|text}
//
// $(…) may nest, e.g. $(math $(getcount deaths)*2). Anything unrecognized
// (or unbalanced) is left exactly as typed. This only ever runs on the stored
// response, before chatter text ({args}, {1}…) is substituted, so nothing a
// chatter types is parsed as $(…).

const VAR_NAME_RE = /^[a-z0-9_]{1,25}$/;
const MAX_DEPTH = 5;

const SIMPLE = new Set([
  "user", "sender", "target", "touser", "args", "count",
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "channel", "time", "date", "game", "title", "status", "uptime",
  "twitchemotes", "7tvemotes", "bttvemotes", "ffzemotes",
  "d4", "d6", "d8", "d10", "d12", "d20", "d100",
]);

/** Counter op for {var:…}: "" (read), "+N", "-N" or "=text"; null if malformed. */
function counterOp(raw: string | undefined, fallback: string): string | null {
  const op = (raw ?? "").trim();
  if (!op) return fallback;
  if (/^[+-]\s*\d+(?:\.\d+)?$/.test(op)) return op.replace(/\s+/g, "");
  if (op.startsWith("=")) return /[{}]/.test(op) ? null : op;
  return null;
}

function translate(inner: string): string | null {
  const m = inner.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const rest = (m[2] ?? "").trim();
  if (!rest) return SIMPLE.has(word) ? `{${word}}` : null;

  switch (word) {
    case "count":
    case "getcount":
    case "var": {
      const [rawName, ...more] = rest.split(/\s+/);
      const name = rawName.toLowerCase();
      if (!VAR_NAME_RE.test(name)) return null;
      if (word === "getcount") return more.length ? null : `{var:${name}}`;
      const op = counterOp(more.join(" "), word === "count" ? "+1" : "");
      return op === null ? null : `{var:${name}${op}}`;
    }
    case "random":
      return `{random:${rest}}`;
    case "randnum": {
      const r = rest.match(/^(-?\d+)\s*(?:-|\s|,)\s*(-?\d+)$/);
      return r ? `{randnum:${r[1]}-${r[2]}}` : null;
    }
    case "roll":
      return `{roll:${rest.replace(/\s+/g, "")}}`;
    case "math":
      return `{math:${rest}}`;
    case "repeat": {
      const r = rest.match(/^(\d{1,2})\s*(?:\|\s*|\s)([\s\S]+)$/);
      return r ? `{repeat:${r[1]}|${r[2]}}` : null;
    }
    default:
      return null;
  }
}

/** Index of the ")" closing the "(" at `open`, or -1 if unbalanced. */
function findClose(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Rewrites every recognized $(…) in a response into its {…} placeholder. */
export function convertDollarSyntax(response: string, depth = 0): string {
  if (depth > MAX_DEPTH || !response.includes("$(")) return response;
  let out = "";
  let i = 0;
  while (i < response.length) {
    const start = response.indexOf("$(", i);
    if (start === -1) break;
    const close = findClose(response, start + 1);
    if (close === -1) break;
    out += response.slice(i, start);
    const inner = convertDollarSyntax(response.slice(start + 2, close), depth + 1);
    out += translate(inner) ?? `$(${inner})`;
    i = close + 1;
  }
  return out + response.slice(i);
}

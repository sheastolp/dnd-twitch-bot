// !oracle with options: "!oracle pizza or tacos?", "!oracle a, b, or c",
// "!oracle should I play Elden Ring or Hades", "!oracle dinner: pizza/tacos".
//
// choiceOptions() reads the options out of the question (or says there are
// none, and !oracle names a recent chatter as before). The pick itself is
// made in code (pickChoice), so it's fair; the AI only words the line, and
// ai_voice.ts checks that its wording names that option and no other.

/** Over this many options it's not a choice, it's a paragraph. */
const MAX_OPTIONS = 20;
/** An option longer than this isn't an option. */
const MAX_OPTION_LEN = 80;
/** Options in a list with commas only ("pizza, tacos, sushi") are short. */
const MAX_COMMA_OPTION_WORDS = 4;

// "hey oracle," "ok chat" — words in front of the real question.
const FILLER_RE = /^(?:(?:hey|yo|ok|okay|so|um|uh|oh|o|dear|great|wise|mighty|oracle|chat|guildscribe|scribe|pls|please|quick)\b[\s,!:.-]*)+/i;
const PRONOUN = String.raw`(?:i|we|you|u|he|she|they|it|chat|y'?all|ya)`;
const AUX = String.raw`(?:should|shall|would|could|can|will|must|do|does|did|is|are|am|was|were)`;
// "should I", "do we", "is it" at the front.
const MODAL_LEAD_RE = new RegExp(String.raw`^${AUX}\s+${PRONOUN}\s+`, "i");
// "which is better", "what should I", "which game should we".
const WH_LEAD_RE = new RegExp(
  String.raw`^(?:which|what|who|whom|whose|where)(?:\s+(?!${AUX}\b)[\w'-]+)?\s+(?:${AUX}|'s)(?:\s+${PRONOUN})?(?:\s+(?:better|best|first|next|nicer|cooler|stronger|faster|more\s+fun))?\s+`,
  "i",
);
const QUESTION_WORD_RE = new RegExp(String.raw`^(?:${AUX}|which|what|who|whom|whose|where|when|why|how)\b`, "i");
// The verb after "should I" when it isn't one of the options itself:
// "should I play Elden Ring or Hades" → Elden Ring / Hades.
const VERB_RE = /^(?:play|eat|watch|get|buy|pick|choose|try|do|go\s+(?:with|for|to)|go|use|have|take|make|build|run|order|cook|drink|stream|wear|name|call|join|start|learn|read|visit|grab|keep|main|roll|be|become|play\s+as)\s+/i;
const NEGATIONS = new Set(["not", "no", "nah", "nope", "neither"]);

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function clean(s: string): string {
  return s
    .replace(/["“”`]/g, "")
    .replace(/^[\s'(\[{-]+|[\s?!.,;:'\])}-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The options a question offers, in order, or null if it offers none
 * (a plain question, which !oracle answers with a chatter's name). */
export function choiceOptions(question: string): string[] | null {
  let q = question.trim();
  if (/https?:\/\//i.test(q)) return null;
  q = q.replace(/[?!.]+$/g, "").trim();
  let afterColon = false;
  const colon = q.lastIndexOf(":");
  if (colon >= 0 && q.slice(colon + 1).trim()) {
    q = q.slice(colon + 1).trim();
    afterColon = true;
  }
  q = q.replace(FILLER_RE, "").trim();

  const strong = /\s(?:or|vs\.?|versus)\s|;|\s\|\s/i.test(q);
  const comma = q.includes(",");
  let parts: string[];
  if (strong || comma) {
    parts = q.split(/\s*(?:,|;|\s\|\s)\s*(?:or\s+)?|\s+(?:or|vs\.?|versus)\s+/i);
  } else if (q.includes("/")) {
    parts = q.split(/\s*\/\s*/);
  } else {
    return null;
  }
  parts = parts.map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  // A lead-in on its own ("which should I play, X or Y"): drop it.
  if (parts.length >= 3 && /^(?:which|what|who|whom|whose|where)\b/i.test(parts[0]) && comma) parts.shift();

  // A lead-in stuck to the first option: "should I eat pizza", "is it pizza".
  let first = parts[0];
  const led = MODAL_LEAD_RE.test(first) || WH_LEAD_RE.test(first);
  first = first.replace(MODAL_LEAD_RE, "").replace(WH_LEAD_RE, "");
  if (led) {
    const others = parts.slice(1);
    const verb = first.match(VERB_RE);
    if (verb && first.length > verb[0].length && !others.some((o) => VERB_RE.test(o + " "))) first = first.slice(verb[0].length);
  }
  parts[0] = first;

  let options = parts.map(clean).filter(Boolean);
  // "should I stream or not" → stream / not stream.
  options = options.map((o, i) => (i > 0 && NEGATIONS.has(o.toLowerCase()) ? `not ${options[0]}` : o));

  if (options.length < 2 || options.length > MAX_OPTIONS) return null;
  if (options.some((o) => o.length > MAX_OPTION_LEN)) return null;
  // Commas alone are also how people write sentences ("honestly, I think
  // so"): only a short list counts, three or more, or after a colon.
  if (!strong && comma) {
    if (options.length < 3 && !afterColon) return null;
    if (options.some((o) => words(o) > MAX_COMMA_OPTION_WORDS || QUESTION_WORD_RE.test(o))) return null;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of options) {
    const k = o.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(o);
    }
  }
  return out.length >= 2 ? out : null;
}

/** One of `options`, each equally likely. */
export function pickChoice(options: string[], random: () => number = Math.random): string {
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))];
}

// Tidying an AI chat reply before it goes to Twitch chat, shared by the NPCs,
// the peddler (!haggle) and the babushka (@-mention replies).
//
//   - cleanChatReply() drops a speaker label the model put first ("Grimsby:",
//     "**Babushka:**"), *stage directions*, markdown and wrapping quotes, and
//     fits the reply to `max` characters.
//   - fitReply() fits text to `max` characters at a sentence end when it can
//     (a word end otherwise, with "…"), so a long reply never stops mid-word.

/** Splits text into sentences (keeps the end mark with each). */
function sentences(text: string): string[] {
  return text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
}

/** `text` in at most `max` characters, cut at a sentence end if one keeps at
 * least half of it, otherwise at a word end with "…". */
export function fitReply(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let out = "";
  for (const s of sentences(t)) {
    if ((out ? out.length + 1 : 0) + s.length > max) break;
    out = out ? `${out} ${s}` : s;
  }
  if (out.length >= max / 2) return out;
  return t.slice(0, max - 1).replace(/\s+\S*$/, "").replace(/[,;:\-—\s]+$/, "") + "…";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The model's reply made chat-ready: no "Name:" label for any of `names`
 * (case-insensitive, with up to three words before it, e.g. "Old Grimsby:"),
 * no *stage directions* or markdown, no wrapping quotes, at most `max`
 * characters. */
export function cleanChatReply(raw: string, names: string[], max: number): string {
  let t = String(raw ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    // *leans on the counter* — an action, not speech.
    .replace(/(^|\s)\*[^*]{1,80}\*(?=\s|$|[.,!?])/g, "$1")
    .trim();
  const alts = names.filter(Boolean).map(escapeRe).join("|");
  if (alts) {
    const label = new RegExp(`^[*_"'\\s]*(?:[\\p{L}'-]+\\s+){0,3}(?:${alts})[*_\\s]*[:\\-—][*_\\s]*`, "iu");
    t = t.replace(label, "");
  }
  t = t
    .replace(/[*_`#]+/g, "")
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (/^["“'].*["”']$/.test(t) && !/["“”]/.test(t.slice(1, -1))) t = t.slice(1, -1).trim();
  return fitReply(t, max);
}

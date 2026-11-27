// Tidying an AI chat reply before it goes to Twitch chat, shared by the NPCs,
// the peddler (!haggle) and the babushka (@-mention replies).
//
//   - cleanChatReply() drops a speaker label the model put first ("Grimsby:",
//     "**Babushka:**"), *stage directions*, markdown and wrapping quotes, and
//     fits the reply to `max` characters.
//   - fitReply() fits text to `max` characters at a sentence end when it can
//     (a word end otherwise, with "…"), so a long reply never stops mid-word.
//   - junkReason() spots a garbled reply: a wall of one character
//     ("//////…", which Qwen3.5 on llama.cpp has sent), the same word or
//     chunk over and over, or text that is mostly not words. cleanChatReply()
//     returns "" for one, so every caller falls back to its own canned line
//     exactly as it does when the AI is down, and junk never reaches chat.

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

/** A short, safe-to-log sample of a reply that failed junkReason. */
export function junkSample(text: string): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return JSON.stringify(t.length > 60 ? `${t.slice(0, 60)}…` : t);
}

/** Why `text` looks like a garbled model reply rather than speech, or null
 * if it reads fine. Lenient on purpose: "Nooooooo!", "hahahaha", "!!!" and
 * an emoji or two pass; a run of one symbol, a word or chunk repeated over
 * and over, or a long reply that is mostly not letters does not. */
export function junkReason(text: string): string | null {
  const t = String(text ?? "").trim();
  if (!t) return "empty";
  // The same symbol 8+ times in a row ("////////", "........", "@@@@@@@@"),
  // or the same letter or digit 12+ times ("aaaaaaaaaaaa").
  if (/([^\p{L}\p{N}\s])\1{7,}/u.test(t)) return "a run of one symbol";
  if (/([\p{L}\p{N}])\1{11,}/u.test(t)) return "a run of one letter";
  // A chunk of 2-20 characters 6+ times in a row, 30+ characters in all
  // ("/ / / / …", "abcabcabc…", "the the the …").
  const chunk = t.match(/(.{2,20}?)\1{5,}/su);
  if (chunk && chunk[0].length >= 30) return "one chunk repeated";
  const words = t.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  if (words.length >= 12 && new Set(words).size / words.length < 0.3) return "the same few words repeated";
  // Mostly symbols: under half of a longer reply's visible characters are
  // letters (digits count too, so "Year 1969, 384,400 km." is fine).
  const visible = t.replace(/\s+/g, "");
  if (visible.length >= 20) {
    const wordy = (visible.match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (wordy / visible.length < 0.5) return "mostly symbols";
  } else if (!/\p{L}/u.test(t)) return "no words";
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The model's reply made chat-ready: no "Name:" label for any of `names`
 * (case-insensitive, with up to three words before it, e.g. "Old Grimsby:"),
 * no *stage directions* or markdown, no wrapping quotes, at most `max`
 * characters. "" for a garbled reply (junkReason), so callers fall back the
 * same way they do for an empty one. */
export function cleanChatReply(raw: string, names: string[], max: number): string {
  let t = String(raw ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (junkReason(t)) return "";
  t = t
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
  if (junkReason(t)) return "";
  return fitReply(t, max);
}

import { assert, assertEquals } from "jsr:@std/assert@1";
import { cleanChatReply, junkReason } from "./ai_reply.ts";

// What the AI Pool sent for "!haggle 3c" on 2026-11-27: a wall of slashes.
const SLASHES = "/".repeat(170);

Deno.test("junkReason flags garbled replies", () => {
  for (
    const junk of [
      "",
      "   ",
      SLASHES,
      `NO DEAL: ${SLASHES}`,
      "Ha! " + "/".repeat(40),
      "/ / / / / / / / / / / / / / / / / / / /",
      "@@@@@@@@@@@@@@@@",
      "aaaaaaaaaaaaaaaaaaaaaa",
      "abcabcabcabcabcabcabcabcabcabcabcabc",
      "the the the the the the the the the the the the the the",
      "deal deal deal deal deal no deal deal deal deal deal deal deal deal",
      "#$%&*(#$%&*()_+{}|:<>?#$%&*(",
      "?!",
      "…",
    ]
  ) assert(junkReason(junk), `should be junk: ${JSON.stringify(junk)}`);
});

Deno.test("junkReason lets ordinary replies through", () => {
  for (
    const ok of [
      "You'll have me begging in the gutter! 4 cp, and that's me being generous.",
      "Three copper for a chicken? NOOOOOOO! My mother would weep. Five cp, final offer.",
      "Hahahahaha, you think that's an offer? 😂 Bring me 6 cp and we'll talk...",
      "Fine!!! Fine. It's yours for 4 cp. Don't tell anyone I'm this soft.",
      "The Moon is about 384,400 km (238,855 miles) from Earth on average.",
      "Apollo 11 landed in 1969.",
      "Hmph.",
      "Deal.",
      "...fine.",
      "Ugh — 4 cp? You drive a hard bargain — but my stomach's growling. Deal!",
    ]
  ) assertEquals(junkReason(ok), null, ok);
});

Deno.test("cleanChatReply turns a garbled reply into nothing, so callers fall back", () => {
  assertEquals(cleanChatReply(SLASHES, ["Podge Ashborn"], 380), "");
  assertEquals(cleanChatReply(`Podge Ashborn: ${SLASHES}`, ["Podge Ashborn"], 380), "");
  assertEquals(cleanChatReply("**" + "#".repeat(30) + "**", [], 380), "");
  assertEquals(cleanChatReply("Podge Ashborn: Five copper, take it or leave it.", ["Podge Ashborn"], 380), "Five copper, take it or leave it.");
});

Deno.test("the haggle's canned lines pass the guard", () => {
  // haggle.ts fallbackVerdict's lines (haggle.ts can't load offline here).
  for (
    const line of [
      "Full price? Finally, someone with taste. 1 sp, sold!",
      "Ugh, 4 cp? You drive a hard bargain, but my stomach's growling louder than my pride. Deal.",
      "4 cp... my poor mother would weep. Fine, fine, it's yours for 4 cp.",
      "3 cp?! For that I'd sooner sell you the sack it came in. No deal.",
      "Too low, friend — but I like your face. Bring me 5 cp and we'll talk.",
    ]
  ) assertEquals(junkReason(line), null, line);
});

import { assert, assertStringIncludes } from "jsr:@std/assert@1";
import { offstreamInviteText, VERROWEN_URL } from "./offstream.ts";

Deno.test("off-stream invite names the channel, the hero and Wake in Verrowen", () => {
  const t = offstreamInviteText("Sheastolp", "your Elf Wizard");
  assertStringIncludes(t, "Sheastolp is offline");
  assertStringIncludes(t, "your Elf Wizard doesn't have to wait");
  assertStringIncludes(t, VERROWEN_URL);
  assert(t.length <= 500, "fits one whisper");
});

Deno.test("off-stream invite without a character", () => {
  assertStringIncludes(offstreamInviteText("Sheastolp", null), "your adventure doesn't have to wait");
});

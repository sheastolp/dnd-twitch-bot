import { assertEquals } from "jsr:@std/assert@1";
import { autoWhisperReason, chatPace, noteChatMessage, PACE_WINDOW_MS } from "./chat_pace.ts";

Deno.test("chatPace counts only the last minute, per channel", () => {
  const t = 1_000_000;
  for (let i = 0; i < 9; i++) noteChatMessage("a", t + i);
  noteChatMessage("b", t);
  assertEquals(chatPace("a", t + 10), 9);
  noteChatMessage("a", t + 20);
  assertEquals(chatPace("a", t + 20), 10);
  assertEquals(chatPace("b", t + 20), 1);
  assertEquals(chatPace("a", t + 5 + PACE_WINDOW_MS), 5); // t..t+4 aged out; t+5..t+8 and t+20 left
  assertEquals(chatPace("a", t + 21 + PACE_WINDOW_MS), 0);
  assertEquals(chatPace("nobody"), 0);
});

Deno.test("auto whispers below quietBelow and above busyAt, chat in between", () => {
  assertEquals(autoWhisperReason(0, 5, 10), "quiet");
  assertEquals(autoWhisperReason(4, 5, 10), "quiet");
  assertEquals(autoWhisperReason(5, 5, 10), null);
  assertEquals(autoWhisperReason(10, 5, 10), null);
  assertEquals(autoWhisperReason(11, 5, 10), "busy");
  assertEquals(autoWhisperReason(0, 0, 10), null); // quietBelow off
});

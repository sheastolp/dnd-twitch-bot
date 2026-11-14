import { assertEquals } from "jsr:@std/assert@1";
import { normalizeAutohuntSpelling as n } from "./autohunt.ts";

Deno.test("!auto hunt is !autohunt", () => {
  assertEquals(n("!autohunt"), "!autohunt");
  assertEquals(n("!autohunt 1h"), "!autohunt 1h");
  assertEquals(n("!auto hunt"), "!autohunt");
  assertEquals(n("!Auto Hunt 1h"), "!autohunt 1h");
  assertEquals(n("!auto  hunt 30m"), "!autohunt 30m");
  assertEquals(n("!auto-hunt status"), "!autohunt status");
  assertEquals(n("!auto_hunt stop"), "!autohunt stop");
  assertEquals(n("!auto hunt stop"), "!autohunt stop");
});

Deno.test("leaves everything else alone", () => {
  assertEquals(n("!auto hunting"), "!auto hunting");
  assertEquals(n("!automod on"), "!automod on");
  assertEquals(n("!autoban status"), "!autoban status");
  assertEquals(n("!hunt"), "!hunt");
  assertEquals(n("I want to auto hunt"), "I want to auto hunt");
});

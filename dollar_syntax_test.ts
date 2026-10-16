// Tests for the $(…) placeholder spelling (dollar_syntax.ts).
// deno test dollar_syntax_test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { convertDollarSyntax as c } from "./dollar_syntax.ts";

Deno.test("count: named counters", () => {
  assertEquals(c("Snacks eaten: $(count snacks)"), "Snacks eaten: {var:snacks+1}");
  assertEquals(c("$(COUNT Snacks)"), "{var:snacks+1}");
  assertEquals(c("$(count snacks +5) $(count snacks -1) $(count snacks =0)"), "{var:snacks+5} {var:snacks-1} {var:snacks=0}");
  assertEquals(c("$(getcount snacks) $(var snacks)"), "{var:snacks} {var:snacks}");
  assertEquals(c("$(count)"), "{count}");
});

Deno.test("count: bad names and ops are left as typed", () => {
  assertEquals(c("$(count sn-acks)"), "$(count sn-acks)");
  assertEquals(c("$(count snacks lots)"), "$(count snacks lots)");
  assertEquals(c("$(getcount snacks +1)"), "$(getcount snacks +1)");
});

Deno.test("simple placeholders", () => {
  assertEquals(c("hi $(user), $(touser) $(1) $(args)"), "hi {user}, {touser} {1} {args}");
  assertEquals(c("$(game) $(uptime) $(d20) $(7tvemotes)"), "{game} {uptime} {d20} {7tvemotes}");
});

Deno.test("placeholders with arguments", () => {
  assertEquals(c("$(random a|b|c)"), "{random:a|b|c}");
  assertEquals(c("$(randnum 1-100) $(randnum 1 100) $(randnum -5 10)"), "{randnum:1-100} {randnum:1-100} {randnum:-5-10}");
  assertEquals(c("$(roll 2d6 + 3)"), "{roll:2d6+3}");
  assertEquals(c("$(math (3+4)*2)"), "{math:(3+4)*2}");
  assertEquals(c("$(repeat 3 ha) $(repeat 2|ho)"), "{repeat:3|ha} {repeat:2|ho}");
});

Deno.test("nesting, unknowns and unbalanced input", () => {
  assertEquals(c("$(math $(getcount deaths)*2)"), "{math:{var:deaths}*2}");
  assertEquals(c("costs $(10) or $(whatever x)"), "costs $(10) or $(whatever x)");
  assertEquals(c("oops $(user"), "oops $(user");
  assertEquals(c("$(user) then $(count x"), "{user} then $(count x");
  assertEquals(c("{user} plain (text) $5"), "{user} plain (text) $5");
});

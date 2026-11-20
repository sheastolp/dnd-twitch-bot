import { assertEquals } from "jsr:@std/assert@1";
import { earnsChatGold } from "./coins.ts";

Deno.test("chat gold: short messages count", () => {
  for (const m of ["B2 3", "gg", "7", "k", "  lol  ", "a much longer message about the fight"]) {
    assertEquals(earnsChatGold(m), true, m);
  }
  for (const m of ["", "   ", "\n\t"]) assertEquals(earnsChatGold(m), false, JSON.stringify(m));
});

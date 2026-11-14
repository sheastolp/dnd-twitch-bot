import { assertEquals } from "jsr:@std/assert@1";
import { hydrationLine } from "./hydrate.ts";

Deno.test("hydration reminders say non-alcoholic and mention the count once there is one", () => {
  const w = { one: "shot", many: "shots" };
  for (let i = 0; i < 20; i++) {
    const none = hydrationLine(0, w);
    assertEquals(/water/i.test(none) && /alcohol/i.test(none), true);
    assertEquals(/\d/.test(none), false);
    assertEquals(hydrationLine(1, w).includes("1 shot "), true);
    assertEquals(hydrationLine(3, { one: "drink", many: "drinks" }).includes("3 drinks"), true);
  }
});

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

Deno.test("hydrate rewards restart the reminder timer", async () => {
  const { isHydrateReward, onHydrateRedemption, hydrationTimerStartedAt } = await import("./hydrate.ts");
  const { ensureTables } = await import("./db_schema.ts");
  const { ensureChannelOptionTables } = await import("./channel_options.ts");
  await ensureTables();
  await ensureChannelOptionTables();
  for (const t of ["Hydrate", "HYDRATE!", "Hydration check", "Make the streamer hydrate 💧", "hydrated?"]) assertEquals(isHydrateReward(t), true, t);
  for (const t of ["Dehydrated", "Take a shot", "Water the plants", ""]) assertEquals(isHydrateReward(t), false, t);
  // The shots switch is off in a fresh database, so this restarts the timer without posting.
  assertEquals(await onHydrateRedemption({ broadcaster_user_id: "77", reward: { title: "Hydrate!" } }, 12345), true);
  assertEquals(hydrationTimerStartedAt("77"), 12345);
  assertEquals(await onHydrateRedemption({ broadcaster_user_id: "77", reward: { title: "Hug the streamer" } }, 99999), false);
  assertEquals(hydrationTimerStartedAt("77"), 12345);
});

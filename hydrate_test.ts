import { assertEquals } from "jsr:@std/assert@1";
import { hydrateRedeemLine, hydrationLine, sinceText } from "./hydrate.ts";

Deno.test("hydration reminders: time since the last redeem, the count, non-alcoholic", () => {
  const w = { one: "shot", many: "shots" };
  const now = 10_000_000;
  for (let i = 0; i < 20; i++) {
    const none = hydrationLine(0, w, null, now);
    assertEquals(none.includes("No hydrate redeem yet this stream"), true);
    assertEquals(/water/i.test(none) && /alcohol/i.test(none), true);
    assertEquals(/\d/.test(none), false);
    const r = hydrationLine(3, w, { at: now - 75 * 60_000, title: "Hydrate!" }, now);
    assertEquals(r.includes("It's been 1 hour 15 minutes since the last “Hydrate!” redeem and 3 shots are down"), true);
    assertEquals(hydrationLine(1, { one: "drink", many: "drinks" }, { at: now - 60_000, title: "" }, now).includes("1 minute since the last hydrate redeem and 1 drink is down"), true);
  }
});

Deno.test("sinceText", () => {
  assertEquals(sinceText(10_000), "1 minute");
  assertEquals(sinceText(45 * 60_000), "45 minutes");
  assertEquals(sinceText(60 * 60_000), "1 hour");
  assertEquals(sinceText(121 * 60_000), "2 hours 1 minute");
});

Deno.test("hydrate rewards restart the reminder timer", async () => {
  const { isHydrateReward, onHydrateRedemption, hydrationTimerStartedAt, ensureHydrateTables, lastHydrateRedeem } = await import("./hydrate.ts");
  const { ensureTables } = await import("./db_schema.ts");
  const { ensureChannelOptionTables } = await import("./channel_options.ts");
  await ensureTables();
  await ensureChannelOptionTables();
  await ensureHydrateTables();
  for (const t of ["Hydrate", "HYDRATE!", "Hydration check", "Make the streamer hydrate 💧", "hydrated?"]) assertEquals(isHydrateReward(t), true, t);
  for (const t of ["Dehydrated", "Take a shot", "Water the plants", ""]) assertEquals(isHydrateReward(t), false, t);
  // The shots switch is off in a fresh database, so this restarts the timer without posting.
  assertEquals(await onHydrateRedemption({ broadcaster_user_id: "77", reward: { title: "Hydrate!" } }, 12345), true);
  assertEquals(hydrationTimerStartedAt("77"), 12345);
  assertEquals(await lastHydrateRedeem("77"), { at: 12345, title: "Hydrate!" });
  assertEquals(await onHydrateRedemption({ broadcaster_user_id: "77", reward: { title: "Hug the streamer" } }, 99999), false);
  assertEquals(hydrationTimerStartedAt("77"), 12345);
});

Deno.test("a hydrate redeem says how long since the one before", () => {
  const now = 50_000_000;
  assertEquals(hydrateRedeemLine("Sheamus", "Hydrate!", { at: now - 47 * 60_000 }, now), `💧 Sheamus redeemed "Hydrate!" — drink up! It's been 47 minutes since the last one.`);
  assertEquals(hydrateRedeemLine("Sheamus", "Hydrate!", null, now), `💧 Sheamus redeemed "Hydrate!" — drink up! That's the first one this stream.`);
});

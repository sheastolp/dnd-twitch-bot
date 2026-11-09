// Tests for the peddlers' stall stock from the Grand Orrery's database (its
// resources.md items): orrery.ts's waresFromEntities / parseSold and gear.ts's merchantStock, which
// merchant.ts and the hoard stall (hoard_db.ts) pick from.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type OrreryEntity, parseSold, setOrreryForTest, waresFromEntities } from "./orrery.ts";
import { findMerchantItem, merchantStock } from "./gear.ts";
import { rollMerchantOffer } from "./merchant.ts";

// resources.md's items as the Orrery's build writes them into the database.
const ITEMS: OrreryEntity[] = [
  { id: "river-stone", type: "item", name: "River stone", icon: "🪨", category: "Materials", status: "decided", fields: { does: "Gets charged into a Hearthstone." } },
  { id: "empty-wooden-bowl", type: "item", name: "Empty wooden bowl", icon: "🥣", category: "Peddlers' wares", kind: "Odds and ends", status: "decided", fields: { pitch: "an empty wooden bowl, licked clean by the last owner's dog", sold: "1 copper · +1 WIS" } },
  { id: "hand-me-down-shield", type: "item", name: "Hand-me-down shield", icon: "🛡️", category: "Peddlers' wares", kind: "Odds and ends", status: "decided", fields: { sold: "1 silver 2 copper · +4 max HP" } },
  { id: "murky-tonic", type: "item", name: "Murky tonic", icon: "🧪", category: "Peddlers' wares", kind: "Odds and ends", status: "pitch", fields: { sold: "2 copper · +1 CON" } },
  { id: "rod-of-seven-parts-67", type: "item", name: "Rod of Seven Parts (6/7)", icon: "🪄", category: "Peddlers' wares", kind: "Relics", status: "decided", fields: { pitch: "the Rod of Seven Parts", sold: "60 gold · +2 WIS, +1 INT, +5 max HP, +10 ft speed · relic" } },
  { id: "empty-wooden-bowl-2", type: "item", name: "Empty wooden bowl", icon: "🥣", category: "Peddlers' wares", kind: "Relics", status: "decided", fields: { sold: "9 gold · +1 STR" } },
] as OrreryEntity[];

Deno.test("parseSold reads price, bonus and relic", () => {
  assertEquals(parseSold("3 copper · +1 CON"), { price: "3 copper", effect: { scores: { CON: 1 } }, relic: false });
  assertEquals(parseSold("1 silver 2 copper · +4 max HP"), { price: "1 silver 2 copper", effect: { hp: 4 }, relic: false });
  assertEquals(parseSold("90 gold · +2 CON, +5 max HP · relic"), { price: "90 gold", effect: { scores: { CON: 2 }, hp: 5 }, relic: true });
  assertEquals(parseSold("2 copper · +5 ft speed"), { price: "2 copper", effect: { speed: 5 }, relic: false });
  assertEquals(parseSold("+1 CON"), null);
});

Deno.test("waresFromEntities keeps decided items with a Sold line, once each", () => {
  const w = waresFromEntities(ITEMS);
  assertEquals(w.map((x) => x.name), ["Empty wooden bowl", "Hand-me-down shield", "Rod of Seven Parts (6/7)"]);
  assertEquals(w[0], { name: "Empty wooden bowl", icon: "🥣", desc: "an empty wooden bowl, licked clean by the last owner's dog", price: "1 copper", effect: { scores: { WIS: 1 } }, relic: false });
  assertEquals(w[1].desc, "hand-me-down shield");
  assertEquals(w[2].relic, true);
  assertEquals(w[2].effect, { scores: { WIS: 2, INT: 1 }, hp: 5, speed: 10 });
});

Deno.test("the stall sells the Orrery's wares, and nothing of its own without them", () => {
  setOrreryForTest({ places: [], creatures: [] }, { sections: {} }, undefined, []);
  assertEquals(merchantStock().fromOrrery, false);
  assertEquals(merchantStock().wares, []);
  assertEquals(rollMerchantOffer(), null);

  setOrreryForTest({ places: [], creatures: [] }, { sections: {} }, undefined, waresFromEntities(ITEMS));
  const s = merchantStock();
  assert(s.fromOrrery);
  assertEquals(s.wares.map((i) => i.name), ["Empty wooden bowl", "Hand-me-down shield"]);
  assertEquals(s.relics.map((i) => i.name), ["Rod of Seven Parts (6/7)"]);
  assert(rollMerchantOffer()!.ad.includes("—"));
  assertEquals(findMerchantItem("hand-me-down shield")?.price, "1 silver 2 copper");
});

// The real documents, built by the Orrery's own build when the grand-orrery
// checkout sits next to this repo: the stall has wares and relics to sell.
Deno.test({
  name: "grand-orrery's database stocks the stall",
  ignore: (() => { try { Deno.statSync(new URL("../grand-orrery/tools/build.mjs", import.meta.url)); return false; } catch { return true; } })(),
  async fn() {
    const { build } = await import(new URL("../grand-orrery/tools/build.mjs", import.meta.url).href);
    const live = waresFromEntities(build().entities);
    assert(live.some((w) => !w.relic));
    assert(live.some((w) => w.relic));
  },
});

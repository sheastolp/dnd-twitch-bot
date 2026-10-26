// GuildScribe — /dashboard/merchant, the one-time merchant sale. A mod (or a
// login on MERCHANT_SALE_EXTRA_LOGINS in dashboard.ts, mod or not) types up a
// ware — sheet name, the peddler's pitch, price and stat bonuses — and the
// peddler posts it to chat right away, replacing whatever the stall had.
//
// The ware is never added to the gear.ts catalog: it rides on the listing
// itself (merchant_listings.custom_item), so !stall and !haggle sell it like
// any other ware and a paid deal bakes its effect into the buyer's sheet. It
// sells to ONE buyer only — the first paid deal marks it sold
// (claimListingSale) and the stall reads "sold out" until the next ad.
//
// Auth (Twitch login, the channel list, the extra logins) lives in
// dashboard.ts handleMerchantSalePage/handleMerchantSaleForm.

import { isMerchantEnabled, recordMonitorEvent, rescheduleMerchant, setMerchantListing } from "./db.ts";
import { isPointsEnabled } from "./points_db.ts";
import { randomMerchantIntervalMs } from "./merchant.ts";
import { effectText, type GearEffect, type MerchantItem } from "./gear.ts";
import { COPPER_PER_GOLD, COPPER_PER_SILVER } from "./coins.ts";
import { sendChatMessage } from "./twitch.ts";
import type { Ability } from "./types.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

const ABILITIES: Ability[] = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];
const MAX_NAME_LEN = 40;
const MAX_DESC_LEN = 200;
const MAX_MERCHANT_LEN = 40;
const MAX_SCORE_BONUS = 5;
const MAX_HP_BONUS = 50;
const MAX_SPEED_BONUS = 30;
const MAX_PRICE_GOLD = 10_000;
const DEFAULT_MERCHANT = "A hooded traveling peddler";

export interface SaleChannel {
  id: string;
  name: string;
}

type Result = { ok: boolean; message: string };

/** One line of plain text: no newlines, runs of spaces collapsed. */
function clean(raw: unknown, max: number): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A whole number from the form, or null if it's not one within [0, max]. */
function wholeNumber(raw: unknown, max: number): number | null {
  const t = String(raw ?? "").trim();
  if (!t) return 0;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n <= max ? n : null;
}

/** 123 -> "1 gold 2 silver 3 copper" — the catalog's own price style, which
 * parseFirstPrice (coins.ts) reads back for !haggle. */
function priceWords(copper: number): string {
  const gp = Math.floor(copper / COPPER_PER_GOLD);
  const sp = Math.floor((copper % COPPER_PER_GOLD) / COPPER_PER_SILVER);
  const cp = copper % COPPER_PER_SILVER;
  return [gp && `${gp} gold`, sp && `${sp} silver`, cp && `${cp} copper`].filter(Boolean).join(" ");
}

/** Validates the form, posts the ad and lists the ware. */
export async function applyMerchantSaleForm(broadcasterId: string, form: FormData, byName: string): Promise<Result> {
  // The sheet line is "Name (+1 STR)" and gearHpBonus reads "+N max HP" back
  // out of it, so the name can't carry its own brackets or plus signs.
  const name = clean(form.get("name"), MAX_NAME_LEN).replace(/[()+]/g, "").trim();
  const desc = clean(form.get("desc"), MAX_DESC_LEN);
  const merchant = clean(form.get("merchant"), MAX_MERCHANT_LEN) || DEFAULT_MERCHANT;
  if (!name) return { ok: false, message: "Give the item a name (what goes on the buyer's sheet)." };
  if (!desc) return { ok: false, message: "Give the item a description (the peddler's pitch)." };

  const gp = wholeNumber(form.get("gp"), MAX_PRICE_GOLD);
  const sp = wholeNumber(form.get("sp"), 9);
  const cp = wholeNumber(form.get("cp"), 9);
  if (gp === null || sp === null || cp === null) {
    return { ok: false, message: `Price must be whole numbers: up to ${MAX_PRICE_GOLD.toLocaleString("en-US")} gold, 0–9 silver and 0–9 copper.` };
  }
  const copper = gp * COPPER_PER_GOLD + sp * COPPER_PER_SILVER + cp;
  if (copper < 1) return { ok: false, message: "Set a price of at least 1 copper." };

  const effect: GearEffect = {};
  for (const a of ABILITIES) {
    const n = wholeNumber(form.get(a), MAX_SCORE_BONUS);
    if (n === null) return { ok: false, message: `${a} bonus must be 0–${MAX_SCORE_BONUS}.` };
    if (n) (effect.scores ??= {})[a] = n;
  }
  const hp = wholeNumber(form.get("hp"), MAX_HP_BONUS);
  if (hp === null) return { ok: false, message: `Max HP bonus must be 0–${MAX_HP_BONUS}.` };
  if (hp) effect.hp = hp;
  const speed = wholeNumber(form.get("speed"), MAX_SPEED_BONUS);
  if (speed === null) return { ok: false, message: `Speed bonus must be 0–${MAX_SPEED_BONUS} ft.` };
  if (speed) effect.speed = speed;

  if (!(await isMerchantEnabled(broadcasterId))) {
    return { ok: false, message: "The market is off in this channel — turn it on first (dashboard switch or !market on), or nobody can !haggle for it." };
  }

  const priceText = priceWords(copper);
  const item: MerchantItem = { name, desc, price: priceText, effect };
  const perk = effectText(effect);
  const ad = `🛒 ✨ ${merchant} sets out a ONE-TIME offer: ${desc} — ${priceText}${perk ? ` (🎒 ${perk})` : ""}. One buyer only — !haggle to bargain for it, !stall to look.`;
  if (!(await sendChatMessage(ad, broadcasterId))) {
    return { ok: false, message: "Couldn't post to chat just now — nothing was listed. Try again in a moment." };
  }
  await setMerchantListing(broadcasterId, merchant, desc, priceText, item);
  // Like !market now: the regular peddler's next ad counts from this one, so
  // the sale isn't overwritten a minute after it goes up.
  await rescheduleMerchant(broadcasterId, Date.now() + await randomMerchantIntervalMs(broadcasterId));
  await recordMonitorEvent("merchant_sale", `${broadcasterId}: ${byName} listed "${name}" for ${priceText}${perk ? ` (${perk})` : ""}`).catch(() => {});
  return { ok: true, message: `Posted! ${merchant} is selling ${name} for ${priceText}${perk ? ` (${perk})` : ""} — first paid !haggle deal takes it.` };
}

export async function renderMerchantSalePage(d: {
  channels: SaleChannel[];
  selected: string;
  viewerName: string;
  notice?: string;
  error?: string;
}): Promise<string> {
  const [marketOn, goldOn] = await Promise.all([isMerchantEnabled(d.selected), isPointsEnabled(d.selected)]);
  const current = d.channels.find((c) => c.id === d.selected);
  const channelPicker = d.channels.length > 1
    ? `<form method="get" action="/dashboard/merchant" class="controls"><label>Channel <select name="channel" onchange="this.form.submit()">${
      d.channels.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === d.selected ? " selected" : ""}>${escapeHtml(c.name)}</option>`).join("")
    }</select></label><noscript><button type="submit" class="ghost">Switch</button></noscript></form>`
    : "";
  const num = (field: string, label: string, max: number, step = 1) =>
    `<label class="stat-in"><span>${label}</span><input type="number" name="${field}" min="0" max="${max}" step="${step}" value="0" inputmode="numeric"></label>`;

  const body = `<header class="dash-top"><div><span class="pill">Merchant · One-time sale</span><h1>${escapeHtml(current?.name ?? d.selected)}</h1></div><span class="muted small">Logged in as ${escapeHtml(d.viewerName)}</span></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
${channelPicker}
<p>Make up a ware and the peddler posts it to chat <strong>right now</strong>, replacing whatever is on the stall. Viewers buy it with <code>!haggle</code> like any other ware, and the stat bonuses land on the buyer's character sheet. It sells to <strong>one buyer only</strong>; the next regular ad replaces it if nobody bites.</p>
${marketOn ? "" : `<p class="banner error">The market is off in this channel, so a sale can't be posted. Turn it on from the dashboard or with <code>!market on</code>.</p>`}
${goldOn ? "" : `<p class="banner error">Gold is off in this channel: viewers can haggle, but nobody pays, so nobody actually gets the item.</p>`}
<form method="post" action="/dashboard/merchant" class="sale">
<input type="hidden" name="channel" value="${escapeHtml(d.selected)}">
<label>Item name <span class="muted small">(goes on the buyer's sheet)</span><input type="text" name="name" required maxlength="${MAX_NAME_LEN}" placeholder="e.g. Sheamus's Lucky Socks" autocomplete="off"></label>
<label>Description <span class="muted small">(the peddler's pitch, shown in chat)</span><textarea name="desc" required maxlength="${MAX_DESC_LEN}" rows="3" placeholder="e.g. a pair of mismatched socks that have never once lost a dice roll"></textarea></label>
<label>Merchant name <span class="muted small">(optional)</span><input type="text" name="merchant" maxlength="${MAX_MERCHANT_LEN}" placeholder="${escapeHtml(DEFAULT_MERCHANT)}" autocomplete="off"></label>
<fieldset><legend>Price</legend><div class="row">${num("gp", "Gold", MAX_PRICE_GOLD)}${num("sp", "Silver", 9)}${num("cp", "Copper", 9)}</div></fieldset>
<fieldset><legend>Stat bonuses</legend><div class="row">${ABILITIES.map((a) => num(a, a, MAX_SCORE_BONUS)).join("")}${num("hp", "Max HP", MAX_HP_BONUS)}${num("speed", "Speed (ft)", MAX_SPEED_BONUS, 5)}</div>
<p class="muted small">Ability scores still cap at 20 — a point that doesn't fit becomes +2 max HP. All zeros makes it pure flavor.</p></fieldset>
<button type="submit" class="ember"${marketOn ? "" : " disabled"}>🛒 Post the sale now</button>
</form>`;

  return scrollDoc(`${escapeHtml(current?.name ?? "Channel")} — One-time sale`, body, {
    width: 900,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}form.sale{display:flex;flex-direction:column;gap:14px;margin-top:16px}form.sale label{display:flex;flex-direction:column;gap:4px}form.sale input[type=text],form.sale textarea{width:100%;box-sizing:border-box;padding:10px}fieldset{border:1px solid var(--rule);border-radius:6px;padding:10px 14px}.row{display:flex;flex-wrap:wrap;gap:12px}.stat-in{width:90px}.stat-in input{width:100%;box-sizing:border-box;padding:8px}form.sale button{align-self:flex-start}`,
  });
}

// GuildScribe — the public /gear?channel=<id> page: every piece of gear the
// peddler can sell (gear.ts), its price, what it does to a character sheet,
// and which heroes in this channel already carry it. The gear counterpart of
// the bestiary page (bestiary_page.ts).

import { effectText, LEGENDARY_ITEMS, MERCHANT_ITEMS, type MerchantItem, ownsGear } from "./gear.ts";
import type { Character } from "./types.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

/** "1 silver 2 copper" -> 12 (in copper), for sorting by price. */
function priceInCopper(price: string): number {
  const rate: Record<string, number> = { gold: 100, silver: 10, copper: 1 };
  let total = 0;
  for (const m of price.matchAll(/(\d+)\s*(gold|silver|copper)/gi)) total += Number(m[1]) * rate[m[2].toLowerCase()];
  return total;
}

export function renderGearPage(
  channelName: string,
  broadcasterId: string,
  characters: Character[],
  baseUrl: string,
): string {
  const name = escapeHtml(channelName);
  const charLink = (username: string) =>
    `${baseUrl}/?user=${encodeURIComponent(username)}&channel=${encodeURIComponent(broadcasterId)}`;
  const all = [
    ...MERCHANT_ITEMS.map((i) => ({ item: i, legendary: false })),
    ...LEGENDARY_ITEMS.map((i) => ({ item: i, legendary: true })),
  ];
  const ownersOf = (item: MerchantItem) => characters.filter((c) => ownsGear(c, item)).map((c) => c.username)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  let owned = 0;
  let carried = 0;

  const rows = all.map(({ item, legendary }) => {
    const owners = ownersOf(item);
    if (owners.length) owned++;
    carried += owners.length;
    const effect = effectText(item.effect);
    const kind = legendary ? `<span class="badge legendary">legendary</span>` : `<span class="badge">junk</span>`;
    const shown = owners.slice(0, 8).map((u) => `<a href="${charLink(u)}">${escapeHtml(u)}</a>`).join(", ");
    const ownerCell = owners.length
      ? `${shown}${owners.length > 8 ? ` <span class="muted">+${owners.length - 8} more</span>` : ""}`
      : `<span class="muted">—</span>`;
    const search = [item.name, item.desc, effect, legendary ? "legendary" : "junk", owners.length ? "owned" : "", ...owners].join(" ").toLowerCase();
    return `<tr data-search="${escapeHtml(search)}" data-price="${priceInCopper(item.price)}" data-owners="${owners.length}" data-carriers="${escapeHtml(owners.join(", ").toLowerCase())}" data-legendary="${legendary ? 1 : 0}">` +
      `<td><strong>${escapeHtml(item.name)}</strong><div class="muted small">${escapeHtml(item.desc)}</div></td>` +
      `<td>${kind}</td><td class="num" data-sort="${priceInCopper(item.price)}">${escapeHtml(item.price)}</td>` +
      `<td>${escapeHtml(effect || "—")}</td><td class="num">${owners.length}</td><td class="small">${ownerCell}</td></tr>`;
  }).join("");

  const body =
    `<span class="pill">Gear</span><h1>${name}</h1><p class="muted">Every piece of gear the wandering peddler can turn up with. Buy it with coin through <code>!haggle</code> when it's on offer, and its bonus is written straight onto your character sheet — it counts in checks, saves, duels, hunts and raids.</p>` +
    `<div class="stats"><div class="stat"><b>${all.length}</b>items</div><div class="stat"><b>${MERCHANT_ITEMS.length}</b>junk</div><div class="stat"><b>${LEGENDARY_ITEMS.length}</b>legendary</div><div class="stat"><b>${owned}</b>owned here</div><div class="stat"><b>${carried}</b>carried by heroes</div></div>` +
    `<div class="controls"><input id="q" class="search" type="search" placeholder="Search gear, effects (e.g. DEX, max HP), owners…" autocomplete="off" aria-label="Search the gear">` +
    `<select id="f" aria-label="Filter"><option value="">All gear</option><option value="junk">Junk only</option><option value="legendary">Legendary only</option><option value="owned">Owned here</option><option value="unowned">Not yet owned</option></select></div>` +
    `<p id="count" class="muted small"></p>` +
    `<div class="table-wrap"><table id="t"><thead><tr><th data-k="0">Item</th><th data-k="1">Kind</th><th data-k="2" class="num">Price</th><th data-k="3">Effect</th><th data-k="4" class="num" title="Heroes in this channel carrying it">Owners</th><th data-k="5">Carried by</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<div class="card"><h2 style="margin-top:0">How gear works</h2>` +
    `<p><strong>Getting it:</strong> the peddler sets up a stall in chat now and then with one item for sale. Strike a deal with <code>!haggle</code> and the coin comes out of your purse (needs gold on). Junk costs a few copper; the legendary relics are rare and cost gold.</p>` +
    `<p><strong>What it does:</strong> the bonus is permanent and baked into your saved hero. Ability scores still cap at 20 — any point that can't fit becomes +2 max HP instead, so a purchase is never wasted. CON gear raises max HP like a real CON increase, and max-HP gear survives level-ups. Owning a second copy of an item does nothing, so the peddler won't sell you one.</p>` +
    `<p class="muted small">Check your sheet with <code>!char</code> · full list of commands: <a href="${baseUrl}/guide">Guild Codex</a></p></div>` +
    `<script>(function(){var q=document.getElementById("q"),f=document.getElementById("f"),c=document.getElementById("count"),tb=document.querySelector("#t tbody"),rows=[].slice.call(tb.rows);` +
    `function apply(){var t=q.value.trim().toLowerCase(),v=f.value,n=0;rows.forEach(function(r){var s=r.getAttribute("data-search");var ok=(!t||s.indexOf(t)!==-1)&&(!v||(v==="junk"&&r.dataset.legendary==="0")||(v==="legendary"&&r.dataset.legendary==="1")||(v==="owned"&&r.dataset.owners!=="0")||(v==="unowned"&&r.dataset.owners==="0"));r.hidden=!ok;if(ok)n++});c.textContent=n+" of "+rows.length+" items shown"}` +
    `q.addEventListener("input",apply);f.addEventListener("change",apply);` +
    `var dir={};document.querySelectorAll("th[data-k]").forEach(function(th){th.addEventListener("click",function(){var k=+th.dataset.k;dir[k]=!dir[k];rows.sort(function(a,b){var x,y;if(k===2){x=+a.dataset.price;y=+b.dataset.price}else if(k===4){x=+a.dataset.owners;y=+b.dataset.owners}else if(k===5){x=a.dataset.carriers;y=b.dataset.carriers;if(!x!==!y)return x?-1:1}else{x=a.cells[k].textContent;y=b.cells[k].textContent}var r=x<y?-1:x>y?1:0;return dir[k]?r:-r});rows.forEach(function(r){tb.appendChild(r)})})});apply()})();</script>`;
  return scrollDoc(`${name} — Gear`, body, {
    width: 1200,
    css: `${LEDGER_CSS}table{min-width:860px}th[data-k]{cursor:pointer;user-select:none}th[data-k]:hover{color:var(--seal)}` +
      `.badge.legendary{border-color:var(--gold);background:#efe0b0;color:#5c3f0e}.card{margin-top:22px}`,
  });
}

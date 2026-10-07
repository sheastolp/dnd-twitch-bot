// GuildScribe — the public /bestiary?channel=<id> page that !bestiary links to:
// every monster the channel can hunt (core + learned), with its base stat
// block, where it turns up, its fight record here and what it has learned.
// Its own module to keep pages.ts under Val Town's per-file size ceiling.

import { randomEncounterMinLevel, type SoloMonster } from "./data.ts";
import { type AdaptationRecord, describeTier, expectedHeroWinRate, type HuntableMonster } from "./bestiary.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

export function renderBestiaryPage(
  channelName: string,
  roster: HuntableMonster[],
  adapt: Map<string, AdaptationRecord>,
  raidMinCr: number,
  baseUrl: string,
): string {
  const name = escapeHtml(channelName);
  const learnedCount = roster.filter((m) => m.learned).length;
  const adapting = roster.filter((m) => (adapt.get(m.name.toLowerCase())?.tier ?? 0) !== 0).length;
  const fought = [...adapt.values()].reduce((t, a) => t + a.heroWins + a.monsterWins, 0);

  const where = (m: SoloMonster) => {
    const lv = randomEncounterMinLevel(m.crValue, roster);
    const parts: string[] = [];
    parts.push(lv ? `random from Lv ${lv}` : "by name only");
    if (m.crValue >= raidMinCr) parts.push("raid boss");
    return parts.join(" · ");
  };

  const rows = roster.map((m) => {
    const a = adapt.get(m.name.toLowerCase());
    const tier = a?.tier ?? 0;
    const total = (a?.heroWins ?? 0) + (a?.monsterWins ?? 0);
    const record = total
      ? `<span class="win">${a!.heroWins}</span>–<span class="loss">${a!.monsterWins}</span>`
      : `<span class="muted">—</span>`;
    const tierCell = tier
      ? `<span class="tier ${tier > 0 ? "up" : "down"}" title="${escapeHtml(describeTier(tier))}">🧠 ${tier > 0 ? "+" : "−"}${Math.abs(tier)}</span><div class="muted small">${escapeHtml(describeTier(tier))}</div>`
      : `<span class="muted">—</span>`;
    const origin = m.learned
      ? `<span class="badge learned" title="Learned ${escapeHtml(new Date(m.learned.at).toISOString().slice(0, 10))}">learned${m.learned.by ? ` · ${escapeHtml(m.learned.by)}` : ""}</span>`
      : `<span class="badge">core</span>`;
    const search = [m.name, m.cr, m.learned ? "learned" : "core", tier ? "adapting" : "", m.crValue >= raidMinCr ? "raid" : ""].join(" ").toLowerCase();
    const cmd = `!dndduel ${m.name.toLowerCase()}`;
    return `<tr data-search="${escapeHtml(search)}" data-cr="${m.crValue}" data-tier="${tier}" data-learned="${m.learned ? 1 : 0}">` +
      `<td><strong>${escapeHtml(m.name)}</strong><div class="muted small"><code>${escapeHtml(cmd)}</code></div></td>` +
      `<td class="num" data-sort="${m.crValue}">${escapeHtml(m.cr)}</td>` +
      `<td class="num">${m.ac}</td><td class="num">${m.hp}</td>` +
      `<td class="num">+${m.attack}</td><td>1d${m.die}${m.bonus ? `+${m.bonus}` : ""}</td>` +
      `<td>${origin}</td><td class="small">${escapeHtml(where(m))}</td>` +
      `<td class="num">${record}</td><td>${tierCell}</td></tr>`;
  }).join("");

  const pct = (lv: number) => Math.round(expectedHeroWinRate(lv) * 100);
  const body =
    `<span class="pill">Bestiary</span><h1>${name}</h1><p class="muted">Every monster that can be hunted in this channel right now. Stats are the base stat block; fights scale it to the hero's level, then apply what the monster has learned.</p>` +
    `<div class="stats"><div class="stat"><b>${roster.length}</b>huntable</div><div class="stat"><b>${roster.length - learnedCount}</b>core</div><div class="stat"><b>${learnedCount}</b>learned</div><div class="stat"><b>${adapting}</b>adapting</div><div class="stat"><b>${fought}</b>fights recorded</div></div>` +
    `<div class="controls"><input id="q" class="search" type="search" placeholder="Search monsters, CR, learned, adapting, raid…" autocomplete="off" aria-label="Search the bestiary">` +
    `<select id="f" aria-label="Filter"><option value="">All monsters</option><option value="learned">Learned only</option><option value="core">Core only</option><option value="adapting">Adapting only</option><option value="raid">Raid bosses</option></select></div>` +
    `<p id="count" class="muted small"></p>` +
    `<div class="table-wrap"><table id="t"><thead><tr><th data-k="0">Monster</th><th data-k="1" class="num">CR</th><th data-k="2" class="num">AC</th><th data-k="3" class="num">HP</th><th data-k="4" class="num">Hit</th><th>Damage</th><th>Origin</th><th>Encountered</th><th class="num" title="Hero wins – monster wins in this channel">Record</th><th data-k="9" title="Adaptation tier from fights in this channel">Adapted</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<div class="card"><h2 style="margin-top:0">How monsters learn</h2>` +
    `<p><strong>New monsters:</strong> look one up with <code>!monster &lt;name&gt;</code> (or <code>!bestiary learn &lt;name&gt;</code>) and, if it isn't huntable yet, its stat block is learned into this channel's bestiary. Mods can <code>!bestiary forget &lt;name&gt;</code> a learned monster.</p>` +
    `<p><strong>Adaptation:</strong> every solo duel, party hunt, autohunt bout and raid teaches the monster species. When heroes beat it more often than the bot's designed odds for their level (about ${pct(1)}% at level 1 down to ${pct(20)}% at level 20) it adapts upward — each tier is ±1 to hit and ±8% HP, and every second tier ±1 AC and ±1 damage, from −3 up to +5. When it wins more than expected it grows careless and eases off. Recent fights count most. Mods can <code>!bestiary reset &lt;name|all&gt;</code>.</p>` +
    `<p class="muted small">Hunt from Twitch chat: <code>!dndduel &lt;monster&gt;</code> · <code>!dndduel party hunt &lt;party&gt; &lt;monster&gt;</code> · <code>!autohunt</code> · <code>!rally</code> · full list: <a href="${baseUrl}/guide">Guild Codex</a></p></div>` +
    `<script>(function(){var q=document.getElementById("q"),f=document.getElementById("f"),c=document.getElementById("count"),tb=document.querySelector("#t tbody"),rows=[].slice.call(tb.rows);` +
    `function apply(){var t=q.value.trim().toLowerCase(),v=f.value,n=0;rows.forEach(function(r){var s=r.getAttribute("data-search");var ok=(!t||s.indexOf(t)!==-1)&&(!v||(v==="learned"&&r.dataset.learned==="1")||(v==="core"&&r.dataset.learned==="0")||(v==="adapting"&&r.dataset.tier!=="0")||(v==="raid"&&s.indexOf("raid")!==-1));r.hidden=!ok;if(ok)n++});c.textContent=n+" of "+rows.length+" monsters shown"}` +
    `q.addEventListener("input",apply);f.addEventListener("change",apply);` +
    `var dir={};document.querySelectorAll("th[data-k]").forEach(function(th){th.addEventListener("click",function(){var k=+th.dataset.k;dir[k]=!dir[k];var num=k>0&&k<5;rows.sort(function(a,b){var x,y;if(k===1){x=+a.dataset.cr;y=+b.dataset.cr}else if(k===9){x=+a.dataset.tier;y=+b.dataset.tier}else{x=a.cells[k].textContent;y=b.cells[k].textContent;if(num){x=parseFloat(x)||0;y=parseFloat(y)||0}}var r=x<y?-1:x>y?1:0;return dir[k]?r:-r});rows.forEach(function(r){tb.appendChild(r)})})});apply()})();</script>`;
  return scrollDoc(`${name} — Bestiary`, body, {
    width: 1200,
    css: `${LEDGER_CSS}table{min-width:900px}th[data-k]{cursor:pointer;user-select:none}th[data-k]:hover{color:var(--seal)}` +
    `.tier{font-weight:700}.tier.up{color:var(--seal)}.tier.down{color:#2f5d86}.win{color:var(--ok);font-weight:600}.loss{color:var(--seal);font-weight:600}.card{margin-top:22px}`,
  });
}

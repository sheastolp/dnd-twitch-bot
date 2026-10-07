// HTML page rendering for the web UI

import type { Character } from "./types.ts";
import { abilityNames } from "./data.ts";
import { modifier, formatRaceName, escapeHtml } from "./utils.ts";
import type { MapRow, MapToken, PartyRosterEntry } from "./db.ts";
import { MAP_TEMPLATES, TERRAINS, tokenColor } from "./maps.ts";
import { formatCoins } from "./coins.ts";
import type { RaidRosterStatus } from "./raid.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

export { page } from "./page_shell.ts";

export function renderCharacterPage(c: Character) {
  const abilities = abilityNames
    .map((a) => {
      const m = modifier(c.scores[a]);
      return `<div class="ability"><span class="ab-name">${a}</span><span class="ab-mod">${m >= 0 ? "+" : ""}${m}</span><span class="ab-score">${c.scores[a]}</span></div>`;
    })
    .join("");
  const name = escapeHtml(c.username);
  return scrollDoc(
    `${name}'s Character`,
    `<span class="pill">Adventurer's sheet</span><h1>${name}</h1><p class="intro">Level ${c.level} ${escapeHtml(formatRaceName(c.race, c.subrace))} ${escapeHtml(c.cls)}</p>
<div class="stats"><div class="stat"><b>${c.hpCurrent}/${c.hpMax}</b>Hit points</div><div class="stat"><b>${c.speed} ft</b>Speed</div><div class="stat"><b>+${c.proficiency}</b>Proficiency</div></div>
<h2>Ability scores</h2><div class="abilities">${abilities}</div>
<h2>Traits</h2><p>${c.traits.length ? c.traits.map(escapeHtml).join(" · ") : `<span class="muted">None recorded.</span>`}</p>
${c.items?.length ? `<h2>Gear</h2><p>${c.items.map(escapeHtml).join(" · ")}</p>` : ""}
<p class="colophon muted">Kept by GuildScribe · <a href="/guide">Guild Codex</a></p>`,
    {
      width: 680,
      css: `${LEDGER_CSS}.intro{font-style:italic;font-size:1.15rem;margin-top:0}.abilities{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}@media(max-width:560px){.abilities{grid-template-columns:repeat(3,1fr);row-gap:20px}}.ability{display:flex;flex-direction:column;align-items:center;background:linear-gradient(180deg,#e4dcc2,#dccfaa);border:1px solid var(--edge);border-radius:8px;padding:10px 6px 0;box-shadow:0 3px 8px #6b441826}.ab-name{font:700 .72rem var(--display);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)}.ab-mod{font:700 1.7rem var(--display);color:var(--seal-dk);line-height:1.3}.ab-score{margin:4px 0 -12px;min-width:38px;text-align:center;background:var(--parch);border:1px solid var(--edge);border-radius:999px;font-weight:600;font-size:.9rem;color:var(--ink)}.abilities{margin-bottom:22px}`,
    },
  );
}

// Not currently wired to any route — the activity log is only exposed via
// the in-chat !logs command, which is scoped to one channel and restricted
// to that channel's broadcaster/moderators. Kept here in case an
// authenticated (per-channel, per-steward) web view is added later; do not
// route this to a public GET endpoint without adding auth + per-channel scoping.
export function renderLogsPage(rows: any[]) {
  const lines = rows
    .map(
      (r: any) =>
        `<tr><td>${escapeHtml(new Date(Number(r.created_at)).toLocaleString())}</td><td>${escapeHtml(r.username || "unknown")}</td><td>${escapeHtml(r.broadcaster_id || "")}</td><td><code>${escapeHtml(r.action || "")}</code></td><td>${escapeHtml(r.detail || "")}</td></tr>`,
    )
    .join("");
  return `<h1>GuildScribe Activity Logs</h1><p>Recent bot activity with timestamps, Twitch usernames, channels, and command details.</p><p><a href="/guide">Back to guide</a> · <a href="/">Bot home</a></p><style>${LEDGER_CSS}</style><div class="table-wrap"><table><thead><tr><th>Timestamp</th><th>Username</th><th>Channel ID</th><th>Action</th><th>Details</th></tr></thead><tbody>${lines || `<tr><td colspan="5">No activity recorded yet.</td></tr>`}</tbody></table></div>`;
}

// Operator-only page body for GET /admin/logs (main.ts wraps this in its own
// <html> shell + auto-refresh meta tag). Shows whether the merchant cron is
// still ticking, a per-channel merchant on/off overview, and a filterable
// feed of monitor_events — everything main.ts gathers via getMerchantCronStatus/
// getMerchantOverview/getMonitorEvents in one page instead of raw JSON.
export interface AdminLogsData {
  status: any | null;
  overview: any[];
  events: any[];
  kindFilter: string;
  key: string;
}

export function renderAdminLogsPage(d: AdminLogsData): string {
  const lastRunAt = d.status ? Number(d.status.last_run_at ?? 0) : 0;
  const staleMs = 20 * 60_000;
  const stale = !lastRunAt || Date.now() - lastRunAt > staleMs;
  const statusLine = d.status
    ? `Last tick: ${escapeHtml(new Date(lastRunAt).toLocaleString())} (${stale ? "⚠️ stale" : "ok"}) — ${Number(d.status.channels_due ?? 0)} channel(s) due, ${Number(d.status.last_posts_ok ?? 0)} posted, ${Number(d.status.last_posts_failed ?? 0)} failed`
    : "No merchant cron tick recorded yet — is the cron trigger on merchant_cron.ts set up?";

  const overviewRows = d.overview
    .map(
      (r: any) =>
        `<tr><td>${escapeHtml(r.display_name || r.login || r.broadcaster_id)}</td><td>${Number(r.enabled) === 1 ? "on" : "off"}</td><td>${r.next_post_at ? escapeHtml(new Date(Number(r.next_post_at)).toLocaleString()) : "—"}</td></tr>`,
    )
    .join("");

  const eventRows = d.events
    .map(
      (r: any) =>
        `<tr><td>${escapeHtml(new Date(Number(r.created_at)).toLocaleString())}</td><td><code>${escapeHtml(r.kind || "")}</code></td><td>${escapeHtml(r.detail || "")}</td></tr>`,
    )
    .join("");

  return `<h1>GuildScribe Operator Logs</h1>
  <p><a href="/admin/channels?key=${encodeURIComponent(d.key)}">Channel connections</a> · <a href="/guide">Guild Codex</a> · <a href="/">Bot home</a></p>
  <style>.table-wrap{margin:10px 0 24px}form.filter{margin:10px 0;display:flex;flex-wrap:wrap;gap:10px;align-items:center}form.filter label{display:flex;gap:8px;align-items:center}td{font-size:.92rem}</style>
  <h2>Merchant cron</h2>
  <p>${statusLine}</p>
  <h2>Per-channel merchant overview</h2>
  <div class="table-wrap"><table><thead><tr><th>Channel</th><th>Market</th><th>Next post due</th></tr></thead><tbody>${overviewRows || `<tr><td colspan="3">No connected channels.</td></tr>`}</tbody></table></div>
  <h2>Recent events</h2>
  <form class="filter" method="get" action="/admin/logs">
    <input type="hidden" name="key" value="${escapeHtml(d.key)}">
    <label>Kind filter <input type="text" name="kind" value="${escapeHtml(d.kindFilter)}" placeholder="e.g. merchant"></label>
    <button type="submit">Filter</button>
    ${d.kindFilter ? `<a href="/admin/logs?key=${encodeURIComponent(d.key)}">Clear</a>` : ""}
  </form>
  <div class="table-wrap"><table><thead><tr><th>Timestamp</th><th>Kind</th><th>Detail</th></tr></thead><tbody>${eventRows || `<tr><td colspan="3">No events recorded yet.</td></tr>`}</tbody></table></div>`;
}

export { renderGuidePage } from "./guide.ts";

// ── Battle maps ──

export function renderMapPage(map: MapRow, cells: Record<string, string>, tokens: MapToken[], baseUrl: string) {
  const cellPx = map.width > 16 || map.height > 16 ? 28 : 36;
  const byCell = new Map(tokens.map((t) => [`${t.x},${t.y}`, t]));
  let gridCells = "";
  for (let y = 1; y <= map.height; y++) {
    for (let x = 1; x <= map.width; x++) {
      const terrain = cells[`${x},${y}`] ?? map.default_terrain;
      const info = TERRAINS[terrain] ?? TERRAINS.grass;
      const token = byCell.get(`${x},${y}`);
      const initials = token ? escapeHtml((token.display_name || token.username).slice(0, 2).toUpperCase()) : "";
      const tokenHtml = token
        ? `<div class="token" style="background:${tokenColor(token.username)}" title="${escapeHtml(token.display_name || token.username)} (${x},${y})">${initials}</div>`
        : "";
      gridCells += `<div class="cell" style="background:${info.color}" title="${escapeHtml(info.label)} (${x},${y})">${tokenHtml}</div>`;
    }
  }
  const legend = Object.entries(TERRAINS)
    .map(([k, v]) => `<span class="legend-item"><span class="swatch" style="background:${v.color}"></span>${escapeHtml(v.label)}${v.blocksMovement ? " 🚫" : ""}</span>`)
    .join("");
  const roster = tokens.length
    ? `<ul class="list">${tokens
        .map((t) => `<li><span class="dot" style="background:${tokenColor(t.username)}"></span>${escapeHtml(t.display_name || t.username)} — (${t.x},${t.y})</li>`)
        .join("")}</ul>`
    : `<p class="muted">No characters placed yet. In chat: <code>!map addchar ${escapeHtml(map.map_name)}</code></p>`;
  return scrollDoc(`${escapeHtml(map.map_name)} — GuildScribe Map`, `<p class="muted"><a href="${baseUrl}/maps?channel=${map.broadcaster_id}">← All maps</a></p><h1>${escapeHtml(map.map_name)}</h1><p class="muted">${map.width}×${map.height} — updated ${escapeHtml(new Date(map.updated_at).toLocaleString())}. This page auto-refreshes every 15s.</p><div class="map-wrap"><div class="map-grid">${gridCells}</div></div><div class="legend">${legend}</div><h2>Characters on this map</h2>${roster}<p class="muted">Edit from Twitch chat: <code>!map paint ${escapeHtml(map.map_name)} x y terrain</code> · <code>!map addchar ${escapeHtml(map.map_name)}</code> · <code>!map move ${escapeHtml(map.map_name)} x y</code> · <code>!map removechar ${escapeHtml(map.map_name)}</code> · full list: <code>!dndbothelp maps</code></p>`, {
    width: 960,
    head: `<meta http-equiv="refresh" content="15">`,
    css: `${LEDGER_CSS}.map-wrap{overflow:auto;width:fit-content;max-width:100%;border:1px solid var(--edge);border-radius:6px;padding:14px;background:#2b1d12;margin:18px 0;box-shadow:inset 0 0 20px #0008,0 3px 10px #6b44182b}.map-grid{display:grid;grid-template-columns:repeat(${map.width},${cellPx}px);grid-auto-rows:${cellPx}px;gap:2px;width:fit-content}.cell{position:relative;border-radius:3px;box-shadow:inset 0 0 0 1px #0006}.token{position:absolute;inset:3px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:700 .62rem var(--mono);color:#15120f;box-shadow:0 0 0 2px #15120f}.legend{display:flex;flex-wrap:wrap;gap:10px 16px;margin:14px 0}.legend-item{display:inline-flex;align-items:center;gap:6px;font-size:.9rem;color:var(--ink-2)}.swatch{width:14px;height:14px;border-radius:3px;display:inline-block;box-shadow:inset 0 0 0 1px #0006}.list li{align-items:center}.dot{width:12px;height:12px;border-radius:50%;display:inline-block;box-shadow:0 0 0 1px #0005}`,
  });
}

export function renderMapListPage(maps: MapRow[], broadcasterId: string, baseUrl: string) {
  const items = maps.length
    ? `<ul class="list">${maps
        .map(
          (m) =>
            `<li><a href="${baseUrl}/map?channel=${broadcasterId}&map=${encodeURIComponent(m.map_name)}">${escapeHtml(m.map_name)}</a> <span class="muted">(${m.width}×${m.height})</span></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">No maps yet. In chat, a moderator can start one with <code>!map create &lt;name&gt; [WxH]</code>.</p>`;
  return scrollDoc("Maps — GuildScribe", `<span class="pill">Battle maps</span><h1>Maps in this channel</h1>${items}<p class="muted">See <code>!dndbothelp maps</code> in chat for the full command list.</p>`, { width: 720, css: LEDGER_CSS });
}

// ── Roster: every character + every party (see GET /roster in main.ts and
// the !roster chat command that hands out the link) ──

export function renderRosterPage(
  channelName: string,
  characters: Character[],
  parties: PartyRosterEntry[],
  broadcasterId: string,
  baseUrl: string,
  truncated = false,
  // Coin per lowercase username; omitted when the channel has gold off.
  gold?: Map<string, number>,
  // The current raid quest; null/omitted hides the section.
  raid?: RaidRosterStatus | null,
) {
  const goldCell = (username: string) => {
    if (!gold) return "";
    const copper = gold.get(username.toLowerCase()) ?? 0;
    return `<td class="num" data-copper="${copper}">${copper > 0 ? escapeHtml(formatCoins(copper)) : `<span class="muted">—</span>`}</td>`;
  };
  const charByUser = new Map(characters.map((c) => [c.username.toLowerCase(), c]));
  const partiesByUser = new Map<string, string[]>();
  for (const p of parties) {
    for (const m of p.members) {
      const key = m.toLowerCase();
      const list = partiesByUser.get(key) ?? [];
      list.push(p.party_name);
      partiesByUser.set(key, list);
    }
  }
  const charLink = (username: string) =>
    `${baseUrl}/?user=${encodeURIComponent(username)}&channel=${encodeURIComponent(broadcasterId)}`;
  const summary = (c: Character) => `Lv ${c.level} ${formatRaceName(c.race, c.subrace)} ${c.cls}`;

  const partyCards = parties.length
    ? parties
        .map((p) => {
          const owner = p.owner.toLowerCase();
          // Leader first, then everyone else in join order.
          const ordered = [...p.members].sort((a, b) => Number(b.toLowerCase() === owner) - Number(a.toLowerCase() === owner));
          const rows = ordered
            .map((m) => {
              const c = charByUser.get(m.toLowerCase());
              const crown = m.toLowerCase() === owner ? `<span class="crown" title="Party leader">👑</span>` : "";
              const name = c ? `<a href="${charLink(m)}">${escapeHtml(m)}</a>` : escapeHtml(m);
              const copper = gold?.get(m.toLowerCase()) ?? 0;
              const purse = copper > 0 ? ` · 🪙 ${formatCoins(copper)}` : "";
              const detail = c ? `<span class="muted">${escapeHtml(summary(c) + purse)}</span>` : `<span class="muted">no character yet${escapeHtml(purse)}</span>`;
              return `<li>${crown}<span class="who">${name}</span>${detail}</li>`;
            })
            .join("");
          const search = [p.party_name, ...p.members].join(" ").toLowerCase();
          return `<section class="card" data-search="${escapeHtml(search)}"><h3>${escapeHtml(p.party_name)}</h3><p class="muted">Led by ${escapeHtml(p.owner || "unknown")} · ${p.members.length} member${p.members.length === 1 ? "" : "s"}</p><ul class="members">${rows || `<li class="muted">No members.</li>`}</ul></section>`;
        })
        .join("")
    : `<p class="muted">No parties yet. In chat: <code>!party create &lt;name&gt;</code></p>`;

  const charRows = characters.length
    ? characters
        .map((c) => {
          const memberOf = partiesByUser.get(c.username.toLowerCase()) ?? [];
          const search = [c.username, c.race, c.subrace ?? "", c.cls, ...memberOf].join(" ").toLowerCase();
          return `<tr data-search="${escapeHtml(search)}"><td><a href="${charLink(c.username)}">${escapeHtml(c.username)}</a></td><td class="num">${c.level}</td><td>${escapeHtml(formatRaceName(c.race, c.subrace))}</td><td>${escapeHtml(c.cls)}</td><td class="num">${c.hpCurrent}/${c.hpMax}</td>${goldCell(c.username)}<td>${memberOf.length ? memberOf.map(escapeHtml).join(", ") : `<span class="muted">—</span>`}</td></tr>`;
        })
        .join("")
    : "";
  const charTable = characters.length
    ? `<div class="table-wrap"><table><thead><tr><th>Adventurer</th><th class="num">Lvl</th><th>Race</th><th>Class</th><th class="num">HP</th>${gold ? `<th class="num">Gold</th>` : ""}<th>Party</th></tr></thead><tbody>${charRows}</tbody></table></div>`
    : `<p class="muted">No adventurers yet. In chat: <code>!createchar</code> or <code>!newchar</code></p>`;

  const raidSection = raid ? (() => {
    const pct = raid.hpMax > 0 ? Math.round((raid.hp / raid.hpMax) * 100) : 0;
    const top = raid.contributors.length
      ? `<p class="muted">Top damage: ${raid.contributors.map((c) => `${escapeHtml(c.name)} ${c.damage}`).join(", ")}</p>`
      : "";
    return `<h2>Raid quest</h2><section class="card raid${raid.slain ? " slain" : ""}"><h3>${escapeHtml(raid.monster)}${raid.slain ? " — 🏆 slain" : ""}</h3>` +
      `<p class="muted">CR ${escapeHtml(raid.cr)} · AC ${raid.ac} · ${raid.raids} raid${raid.raids === 1 ? "" : "s"} so far</p>` +
      `<div class="hpbar" role="img" aria-label="Boss HP ${raid.hp} of ${raid.hpMax}"><span style="width:${pct}%"></span></div>` +
      `<p><strong>HP ${raid.hp}/${raid.hpMax}</strong> (${pct}%)</p><p>${escapeHtml(raid.state)}</p>${top}</section>`;
  })() : "";

  const note = truncated ? `<p class="muted">Showing the first ${characters.length} adventurers by level.</p>` : "";
  const name = escapeHtml(channelName);

  return scrollDoc(`${name} — Guild Roster`, `<span class="pill">Guild roster</span><h1>${name}</h1><p class="muted">${characters.length} adventurer${characters.length === 1 ? "" : "s"} · ${parties.length} part${parties.length === 1 ? "y" : "ies"}. Click a name to open their character sheet.</p><input id="q" class="search" type="search" placeholder="Search adventurers, races, classes, parties…" autocomplete="off" aria-label="Search the roster"><p id="nomatch" class="muted" hidden>No adventurers or parties match that search.</p>${raidSection}<h2>Parties</h2><div class="grid">${partyCards}</div><h2>Adventurers</h2>${note}${charTable}<p class="muted colophon">Join in from Twitch chat: <code>!createchar</code> · <code>!party create &lt;name&gt;</code> · <code>!party join &lt;name&gt;</code> · full list: <a href="${baseUrl}/guide">Guild Codex</a></p><script>(function(){var q=document.getElementById("q"),none=document.getElementById("nomatch"),items=document.querySelectorAll("[data-search]");if(!q)return;q.addEventListener("input",function(){var t=q.value.trim().toLowerCase(),shown=0;items.forEach(function(el){var hit=!t||el.getAttribute("data-search").indexOf(t)!==-1;el.hidden=!hit;if(hit)shown++});none.hidden=!t||shown>0})})();</script>`, { width: 1040, css: `${LEDGER_CSS}table{min-width:560px}.card h3{margin-bottom:2px}.crown{margin-right:-4px}` });
}

// The web dashboard page lives in dashboard_page.ts (size ceiling).
export { DEDICATED_TOGGLES, renderDashboardLoginGate, renderDashboardPage, switchStates, type DashboardData } from "./dashboard_page.ts";

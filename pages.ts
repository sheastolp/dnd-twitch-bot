// HTML page rendering for the web UI

import type { Character } from "./types.ts";
import { abilityNames } from "./data.ts";
import { modifier, formatRaceName, escapeHtml } from "./utils.ts";
import type { MapRow, MapToken, PartyRosterEntry } from "./db.ts";
import { MAP_TEMPLATES, TERRAINS, tokenColor } from "./maps.ts";
import { formatCoins } from "./coins.ts";
import type { RaidRosterStatus } from "./raid.ts";

export { page } from "./page_shell.ts";

export function renderCharacterPage(c: Character) {
  const statLine = abilityNames
    .map(
      (a) =>
        `<li><strong>${a}</strong> ${c.scores[a]} (${modifier(c.scores[a]) >= 0 ? "+" : ""}${modifier(c.scores[a])})</li>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(c.username)}'s Character</title><style>body{font-family:sans-serif;max-width:600px;margin:40px auto;background:#1a1a1a;color:#eee;padding:20px;border-radius:8px}h1{color:#ffd700}ul{list-style:none;padding:0}li{padding:4px 0;border-bottom:1px solid #333}</style></head><body><h1>${escapeHtml(c.username)}</h1><p>Level ${c.level} ${escapeHtml(formatRaceName(c.race, c.subrace))} ${escapeHtml(c.cls)}</p><p>HP: ${c.hpCurrent}/${c.hpMax} &nbsp;|&nbsp; Speed: ${c.speed} ft &nbsp;|&nbsp; Proficiency: +${c.proficiency}</p><ul>${statLine}</ul><p><strong>Traits:</strong> ${c.traits.map(escapeHtml).join(", ")}</p></body></html>`;
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
  return `<h1>GuildScribe Activity Logs</h1><p>Recent bot activity with timestamps, Twitch usernames, channels, and command details.</p><p><a href="/guide">Back to guide</a> · <a href="/">Bot home</a></p><style>body{max-width:1100px!important}table{width:100%;border-collapse:collapse;background:#211b16}th,td{padding:10px;border:1px solid #684632;text-align:left;vertical-align:top}th{color:#e6a56e}td{color:#d6c6b5;font-size:.9rem}code{color:#f0c39e}@media(max-width:700px){table{font-size:.78rem}th,td{padding:6px}}</style><div style="overflow:auto"><table><thead><tr><th>Timestamp</th><th>Username</th><th>Channel ID</th><th>Action</th><th>Details</th></tr></thead><tbody>${lines || `<tr><td colspan="5">No activity recorded yet.</td></tr>`}</tbody></table></div>`;
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
  <p><a href="/guide">Guild Codex</a> · <a href="/">Bot home</a></p>
  <style>body{max-width:1100px!important}table{width:100%;border-collapse:collapse;background:#211b16;margin:10px 0 24px}th,td{padding:10px;border:1px solid #684632;text-align:left;vertical-align:top}th{color:#e6a56e}td{color:#d6c6b5;font-size:.9rem}code{color:#f0c39e}form.filter{margin:10px 0}input[type=text]{background:#0e0d0c;color:#f4eadb;border:1px solid #453626;border-radius:6px;padding:6px 10px}button{background:#9147ff;color:#fff;border:0;border-radius:6px;padding:6px 14px}@media(max-width:700px){table{font-size:.78rem}th,td{padding:6px}}</style>
  <h2>Merchant cron</h2>
  <p>${statusLine}</p>
  <h2>Per-channel merchant overview</h2>
  <div style="overflow:auto"><table><thead><tr><th>Channel</th><th>Market</th><th>Next post due</th></tr></thead><tbody>${overviewRows || `<tr><td colspan="3">No connected channels.</td></tr>`}</tbody></table></div>
  <h2>Recent events</h2>
  <form class="filter" method="get" action="/admin/logs">
    <input type="hidden" name="key" value="${escapeHtml(d.key)}">
    <label>Kind filter <input type="text" name="kind" value="${escapeHtml(d.kindFilter)}" placeholder="e.g. merchant"></label>
    <button type="submit">Filter</button>
    ${d.kindFilter ? `<a href="/admin/logs?key=${encodeURIComponent(d.key)}">Clear</a>` : ""}
  </form>
  <div style="overflow:auto"><table><thead><tr><th>Timestamp</th><th>Kind</th><th>Detail</th></tr></thead><tbody>${eventRows || `<tr><td colspan="3">No events recorded yet.</td></tr>`}</tbody></table></div>`;
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
    ? `<ul class="roster">${tokens
        .map((t) => `<li><span class="dot" style="background:${tokenColor(t.username)}"></span>${escapeHtml(t.display_name || t.username)} — (${t.x},${t.y})</li>`)
        .join("")}</ul>`
    : `<p class="muted">No characters placed yet. In chat: <code>!map addchar ${escapeHtml(map.map_name)}</code></p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="15"><title>${escapeHtml(map.map_name)} — GuildScribe Map</title><style>:root{color-scheme:dark}body{font-family:Georgia,serif;max-width:900px;margin:32px auto;background:#15120f;color:#f4eadb;padding:20px}h1{color:#e6a56e;margin-bottom:4px}a{color:#e6a56e}.muted{color:#aa9b8d;font-size:.9rem}.map-wrap{overflow:auto;border:1px solid #684632;border-radius:10px;padding:14px;background:#0e0d0c;margin:18px 0}.map-grid{display:grid;grid-template-columns:repeat(${map.width},${cellPx}px);grid-auto-rows:${cellPx}px;gap:2px;width:fit-content}.cell{position:relative;border-radius:3px;box-shadow:inset 0 0 0 1px #0006}.token{position:absolute;inset:3px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:700 .62rem ui-monospace,monospace;color:#15120f;box-shadow:0 0 0 2px #15120f}.legend{display:flex;flex-wrap:wrap;gap:10px 16px;margin:14px 0}.legend-item{display:inline-flex;align-items:center;gap:6px;font-size:.85rem;color:#d6c6b5}.swatch{width:14px;height:14px;border-radius:3px;display:inline-block;box-shadow:inset 0 0 0 1px #0006}.roster{list-style:none;padding:0}.roster li{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #2a231c}.dot{width:12px;height:12px;border-radius:50%;display:inline-block}code{background:#0e0d0c;color:#f0c39e;padding:2px 6px;border-radius:4px}</style></head><body><p class="muted"><a href="${baseUrl}/maps?channel=${map.broadcaster_id}">← All maps</a></p><h1>🗺️ ${escapeHtml(map.map_name)}</h1><p class="muted">${map.width}×${map.height} — updated ${escapeHtml(new Date(map.updated_at).toLocaleString())}. This page auto-refreshes every 15s.</p><div class="map-wrap"><div class="map-grid">${gridCells}</div></div><div class="legend">${legend}</div><h2 style="color:#e6a56e">Characters on this map</h2>${roster}<p class="muted">Edit from Twitch chat: <code>!map paint ${escapeHtml(map.map_name)} x y terrain</code> · <code>!map addchar ${escapeHtml(map.map_name)}</code> · <code>!map move ${escapeHtml(map.map_name)} x y</code> · <code>!map removechar ${escapeHtml(map.map_name)}</code> · full list: <code>!dndbothelp maps</code></p></body></html>`;
}

export function renderMapListPage(maps: MapRow[], broadcasterId: string, baseUrl: string) {
  const items = maps.length
    ? `<ul class="roster">${maps
        .map(
          (m) =>
            `<li><a href="${baseUrl}/map?channel=${broadcasterId}&map=${encodeURIComponent(m.map_name)}">${escapeHtml(m.map_name)}</a> <span class="muted">(${m.width}×${m.height})</span></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">No maps yet. In chat, a moderator can start one with <code>!map create &lt;name&gt; [WxH]</code>.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Maps — GuildScribe</title><style>:root{color-scheme:dark}body{font-family:Georgia,serif;max-width:700px;margin:40px auto;background:#15120f;color:#f4eadb;padding:20px}h1{color:#e6a56e}a{color:#e6a56e;text-decoration:underline}.muted{color:#aa9b8d;font-size:.9rem}.roster{list-style:none;padding:0}.roster li{padding:8px 0;border-bottom:1px solid #2a231c}code{background:#0e0d0c;color:#f0c39e;padding:2px 6px;border-radius:4px}</style></head><body><h1>🗺️ Maps in this channel</h1>${items}<p class="muted">See <code>!dndbothelp maps</code> in chat for the full command list.</p></body></html>`;
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
    return `<h2>🐉 Raid quest</h2><section class="card raid${raid.slain ? " slain" : ""}"><h3>${escapeHtml(raid.monster)}${raid.slain ? " — 🏆 slain" : ""}</h3>` +
      `<p class="muted">CR ${escapeHtml(raid.cr)} · AC ${raid.ac} · ${raid.raids} raid${raid.raids === 1 ? "" : "s"} so far</p>` +
      `<div class="hpbar" role="img" aria-label="Boss HP ${raid.hp} of ${raid.hpMax}"><span style="width:${pct}%"></span></div>` +
      `<p><strong>HP ${raid.hp}/${raid.hpMax}</strong> (${pct}%)</p><p>${escapeHtml(raid.state)}</p>${top}</section>`;
  })() : "";

  const note = truncated ? `<p class="muted">Showing the first ${characters.length} adventurers by level.</p>` : "";
  const name = escapeHtml(channelName);

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name} — Guild Roster</title><style>:root{color-scheme:dark}[hidden]{display:none!important}body{font-family:Georgia,serif;max-width:1000px;margin:32px auto;background:#15120f;color:#f4eadb;padding:20px;line-height:1.5}h1{color:#e6a56e;margin-bottom:4px}h2{color:#e6a56e;border-bottom:1px solid #684632;padding-bottom:8px;margin-top:34px}h3{color:#f0c39e;margin:0 0 2px}a{color:#e6a56e}.muted{color:#aa9b8d;font-size:.9rem}.search{width:100%;box-sizing:border-box;background:#0e0d0c;color:#f4eadb;border:1px solid #684632;border-radius:8px;padding:12px 14px;font:inherit;margin:14px 0 4px}.search:focus{outline:2px solid #e6a56e}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}.card{background:#211b16;border:1px solid #684632;border-radius:10px;padding:16px 18px;box-shadow:0 10px 24px #0005}.members{list-style:none;padding:0;margin:10px 0 0}.members li{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:6px 0;border-bottom:1px solid #2a231c}.members li:last-child{border-bottom:0}.who{font-weight:700}.crown{margin-right:-4px}.table-wrap{overflow-x:auto;border:1px solid #684632;border-radius:10px;background:#0e0d0c}table{width:100%;border-collapse:collapse;min-width:560px}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #2a231c}th{color:#e6a56e;font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;background:#1b1612}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#1b1612}.num{text-align:right;font-variant-numeric:tabular-nums}code{background:#0e0d0c;color:#f0c39e;padding:2px 6px;border-radius:4px}.hpbar{height:12px;background:#0e0d0c;border:1px solid #684632;border-radius:6px;overflow:hidden;margin:10px 0 4px}.hpbar span{display:block;height:100%;background:#b8432f}.raid.slain .hpbar span{background:#555}@media(max-width:600px){body{margin:16px auto;padding:14px}}</style></head><body><h1>📜 ${name} — Guild Roster</h1><p class="muted">${characters.length} adventurer${characters.length === 1 ? "" : "s"} · ${parties.length} part${parties.length === 1 ? "y" : "ies"}. Click a name to open their character sheet.</p><input id="q" class="search" type="search" placeholder="Search adventurers, races, classes, parties…" autocomplete="off" aria-label="Search the roster"><p id="nomatch" class="muted" hidden>No adventurers or parties match that search.</p>${raidSection}<h2>🛡️ Parties</h2><div class="grid">${partyCards}</div><h2>⚔️ Adventurers</h2>${note}${charTable}<p class="muted" style="margin-top:28px">Join in from Twitch chat: <code>!createchar</code> · <code>!party create &lt;name&gt;</code> · <code>!party join &lt;name&gt;</code> · full list: <a href="${baseUrl}/guide">Guild Codex</a></p><script>(function(){var q=document.getElementById("q"),none=document.getElementById("nomatch"),items=document.querySelectorAll("[data-search]");if(!q)return;q.addEventListener("input",function(){var t=q.value.trim().toLowerCase(),shown=0;items.forEach(function(el){var hit=!t||el.getAttribute("data-search").indexOf(t)!==-1;el.hidden=!hit;if(hit)shown++});none.hidden=!t||shown>0})})();</script></body></html>`;
}

// The web dashboard page lives in dashboard_page.ts (size ceiling).
export { DEDICATED_TOGGLES, renderDashboardLoginGate, renderDashboardPage, type DashboardData } from "./dashboard_page.ts";

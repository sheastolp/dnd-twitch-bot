// HTML page rendering for the web UI

import type { Character } from "./types.ts";
import { abilityNames } from "./data.ts";
import { modifier, formatRaceName, escapeHtml, COMMAND_GROUPS } from "./utils.ts";
import type { MapRow, MapToken, PartyRosterEntry } from "./db.ts";
import { MAP_TEMPLATES, TERRAINS, tokenColor } from "./maps.ts";

export function page(title: string, body: string) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:sans-serif;max-width:700px;margin:40px auto;background:#1a1a1a;color:#eee;padding:24px}a,button{background:#9147ff;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;border:0;font-size:1rem}h1{color:#ffd700}</style></head><body>${body}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

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
) {
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
              const detail = c ? `<span class="muted">${escapeHtml(summary(c))}</span>` : `<span class="muted">no character yet</span>`;
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
          return `<tr data-search="${escapeHtml(search)}"><td><a href="${charLink(c.username)}">${escapeHtml(c.username)}</a></td><td class="num">${c.level}</td><td>${escapeHtml(formatRaceName(c.race, c.subrace))}</td><td>${escapeHtml(c.cls)}</td><td class="num">${c.hpCurrent}/${c.hpMax}</td><td>${memberOf.length ? memberOf.map(escapeHtml).join(", ") : `<span class="muted">—</span>`}</td></tr>`;
        })
        .join("")
    : "";
  const charTable = characters.length
    ? `<div class="table-wrap"><table><thead><tr><th>Adventurer</th><th class="num">Lvl</th><th>Race</th><th>Class</th><th class="num">HP</th><th>Party</th></tr></thead><tbody>${charRows}</tbody></table></div>`
    : `<p class="muted">No adventurers yet. In chat: <code>!createchar</code> or <code>!newchar</code></p>`;

  const note = truncated ? `<p class="muted">Showing the first ${characters.length} adventurers by level.</p>` : "";
  const name = escapeHtml(channelName);

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name} — Guild Roster</title><style>:root{color-scheme:dark}[hidden]{display:none!important}body{font-family:Georgia,serif;max-width:1000px;margin:32px auto;background:#15120f;color:#f4eadb;padding:20px;line-height:1.5}h1{color:#e6a56e;margin-bottom:4px}h2{color:#e6a56e;border-bottom:1px solid #684632;padding-bottom:8px;margin-top:34px}h3{color:#f0c39e;margin:0 0 2px}a{color:#e6a56e}.muted{color:#aa9b8d;font-size:.9rem}.search{width:100%;box-sizing:border-box;background:#0e0d0c;color:#f4eadb;border:1px solid #684632;border-radius:8px;padding:12px 14px;font:inherit;margin:14px 0 4px}.search:focus{outline:2px solid #e6a56e}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}.card{background:#211b16;border:1px solid #684632;border-radius:10px;padding:16px 18px;box-shadow:0 10px 24px #0005}.members{list-style:none;padding:0;margin:10px 0 0}.members li{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:6px 0;border-bottom:1px solid #2a231c}.members li:last-child{border-bottom:0}.who{font-weight:700}.crown{margin-right:-4px}.table-wrap{overflow-x:auto;border:1px solid #684632;border-radius:10px;background:#0e0d0c}table{width:100%;border-collapse:collapse;min-width:560px}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #2a231c}th{color:#e6a56e;font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;background:#1b1612}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#1b1612}.num{text-align:right;font-variant-numeric:tabular-nums}code{background:#0e0d0c;color:#f0c39e;padding:2px 6px;border-radius:4px}@media(max-width:600px){body{margin:16px auto;padding:14px}}</style></head><body><h1>📜 ${name} — Guild Roster</h1><p class="muted">${characters.length} adventurer${characters.length === 1 ? "" : "s"} · ${parties.length} part${parties.length === 1 ? "y" : "ies"}. Click a name to open their character sheet.</p><input id="q" class="search" type="search" placeholder="Search adventurers, races, classes, parties…" autocomplete="off" aria-label="Search the roster"><p id="nomatch" class="muted" hidden>No adventurers or parties match that search.</p><h2>🛡️ Parties</h2><div class="grid">${partyCards}</div><h2>⚔️ Adventurers</h2>${note}${charTable}<p class="muted" style="margin-top:28px">Join in from Twitch chat: <code>!createchar</code> · <code>!party create &lt;name&gt;</code> · <code>!party join &lt;name&gt;</code> · full list: <a href="${baseUrl}/guide">Guild Codex</a></p><script>(function(){var q=document.getElementById("q"),none=document.getElementById("nomatch"),items=document.querySelectorAll("[data-search]");if(!q)return;q.addEventListener("input",function(){var t=q.value.trim().toLowerCase(),shown=0;items.forEach(function(el){var hit=!t||el.getAttribute("data-search").indexOf(t)!==-1;el.hidden=!hit;if(hit)shown++});none.hidden=!t||shown>0})})();</script></body></html>`;
}

// ── Web dashboard (see dashboard.ts for the !dashboard chat command that
// hands out the link, and main.ts for the GET/POST /dashboard routes) ──

export interface DashboardData {
  broadcasterId: string;
  broadcasterName: string;
  channelKey: string;
  commands: any[];
  triggers: any[];
  timedMessages: any[];
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  maxCooldownSeconds: number;
  notice?: string;
  error?: string;
  botEnabled: boolean;
  marketEnabled: boolean;
  chronicleEnabled: boolean;
  npcEnabled: boolean;
  npcChatterEnabled: boolean;
  groupToggles: Record<string, boolean>;
  autoBanEnabled: boolean;
  autoBanPermitted: boolean;
  pointsEnabled: boolean;
}

function dashHidden(broadcasterId: string, key: string): string {
  return `<input type="hidden" name="channel" value="${escapeHtml(broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(key)}">`;
}

/** Switches with their own dedicated on/off (not COMMAND_GROUPS); each has a
 * #toggle-<key> anchor the guide's /dashboard/go links can land on. */
export const DEDICATED_TOGGLES = ["bot", "market", "chronicle", "autoban", "points", "npc", "npcchatter"];
// Dashboard switches with no Guild Codex card of their own to link back to.
const NO_GUIDE_CARD = new Set(["npcchatter", "vars", "timedmsgs", "misc"]);

function guideLink(key: string): string {
  return NO_GUIDE_CARD.has(key) ? "" : ` <a class="guide-link" href="/guide#card-${key}" target="_blank" rel="noopener">guide ↗</a>`;
}

/** A feature/group switch rendered like the rest of the dashboard: a square tile
 * (name + On/Off) that expands into a window holding the details and the button.
 * The tile keeps id="toggle-<key>" so /dashboard/go#toggle-<key> links land on it. */
function toggleTile(d: DashboardData, key: string, label: string, sub: string, enabled: boolean, hidden: string, warn = ""): string {
  const dlg = `dlg-tgl-${escapeHtml(key)}`;
  // Group labels look like "Battle maps (!map …)": the tile shows the short name, the window shows it all.
  const paren = label.indexOf(" (");
  const short = paren > 0 ? label.slice(0, paren) : label;
  const pill = `<span class="pill ${enabled ? "on" : "off"}">${enabled ? "On" : "Off"}</span>`;
  return `<button type="button" class="tile${enabled ? "" : " tile-paused"}" id="toggle-${escapeHtml(key)}" data-open="${dlg}" aria-haspopup="dialog">
      <span class="tile-title">${escapeHtml(short)}${warn ? " ⚠️" : ""}</span>${pill}
    </button>${editorDialog(dlg, escapeHtml(label), `<div class="toggle-detail">
      ${sub ? `<p>${escapeHtml(sub)}</p>` : ""}${warn ? `<p class="warn">${warn}</p>` : ""}
      <div class="row-controls">${pill}${guideLink(key)}
        <form method="post" action="/dashboard/features" class="push">
          ${dashHidden(d.broadcasterId, d.channelKey)}${hidden}
          <button type="submit" class="${enabled ? "danger" : ""}">${enabled ? "Turn off" : "Turn on"}</button>
        </form>
      </div>
    </div>`)}`;
}

function featureToggleRow(d: DashboardData, intentOn: string, intentOff: string, label: string, sub: string, enabled: boolean): string {
  const key = intentOn.replace(/_on$/, "");
  return toggleTile(d, key, label, sub, enabled, `<input type="hidden" name="intent" value="${enabled ? intentOff : intentOn}">`);
}

function autoBanToggleRow(d: DashboardData): string {
  const enabled = d.autoBanEnabled;
  const sub = 'Permanently bans non-mods who say "ai viewers" — same as !autoban on/off';
  const warn = !d.autoBanPermitted
    ? `⚠️ Ban permission not granted yet — the broadcaster needs to <a href="/connect">reconnect</a> and approve it, or nothing will be banned.`
    : "";
  return toggleTile(d, "autoban", "Auto-ban", sub, enabled, `<input type="hidden" name="intent" value="${enabled ? "autoban_off" : "autoban_on"}">`, warn);
}

function groupToggleRow(d: DashboardData, key: string, label: string, enabled: boolean): string {
  return toggleTile(d, key, label, "", enabled, `<input type="hidden" name="intent" value="${enabled ? "group_off" : "group_on"}"><input type="hidden" name="group" value="${escapeHtml(key)}">`);
}

/** Stable anchor id for a command-group heading (used by the dashboard index). */
function sectionSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "group";
}

/** Top-of-page index: jump links to each dashboard section plus the command-group
 * sub-sections, and expand/collapse-all controls. */
function renderDashboardIndex(): string {
  const groupNames = [...new Set(Object.values(COMMAND_GROUPS).map((g) => g.section))];
  const groupLinks = groupNames
    .map((n) => `<li><a href="#grp-${sectionSlug(n)}">${escapeHtml(n)}</a></li>`)
    .join("");
  return `<nav class="index" aria-label="Dashboard index">
    <div class="index-head"><strong>Index</strong><span class="index-ctl"><button type="button" class="link" data-all="open">Expand all</button> · <button type="button" class="link" data-all="close">Collapse all</button></span></div>
    <ol>
      <li><a href="#sec-features">Bot &amp; feature switches</a></li>
      <li><a href="#sec-groups">Command groups</a><ul>${groupLinks}</ul></li>
      <li><a href="#sec-commands">Custom commands</a></li>
      <li><a href="#sec-triggers">Chat triggers</a></li>
      <li><a href="#sec-timed">Timed messages</a></li>
    </ol>
  </nav>`;
}

function renderFeaturesSection(d: DashboardData): { switches: string; groups: string } {
  const dedicated = [
    featureToggleRow(d, "bot_on", "bot_off", "Entire bot", "Master switch — same as !dndbot on/off in chat", d.botEnabled),
    featureToggleRow(d, "market_on", "market_off", "Open-stall merchant", "Random flavor ads in chat — same as !market on/off", d.marketEnabled),
    featureToggleRow(d, "chronicle_on", "chronicle_off", "Chronicle", "Occasional quote-backs of chat — same as !chronicle on/off", d.chronicleEnabled),
    autoBanToggleRow(d),
    featureToggleRow(d, "points_on", "points_off", "Gold, leaderboard & giveaways", "Viewers earn copper by chatting and from monster loot on hunts (10 cp = 1 sp, 10 sp = 1 gp); !gold, !gold top, !giveaway, !rob, and real coin prices for !haggle — same as !gold on/off", d.pointsEnabled),
    featureToggleRow(d, "npc_on", "npc_off", "AI NPCs", "Lets viewers talk to AI-voiced NPCs with !npc talk", d.npcEnabled),
    featureToggleRow(d, "npcchatter_on", "npcchatter_off", "AI NPC chatter", "NPCs jumping into chat on their own (needs AI NPCs on too)", d.npcChatterEnabled),
  ].join("");
  // One switch per Guild Codex card, under that card's guide section.
  const bySection = new Map<string, { rows: string[]; on: number }>();
  for (const [key, def] of Object.entries(COMMAND_GROUPS)) {
    const g = bySection.get(def.section) ?? { rows: [], on: 0 };
    const enabled = d.groupToggles[key] ?? true;
    g.rows.push(groupToggleRow(d, key, def.label, enabled));
    if (enabled) g.on++;
    bySection.set(def.section, g);
  }
  // Each Codex section is a large collapsible square holding its switch tiles inline.
  const groups = `<div class="folders">${[...bySection]
    .map(([section, g]) => {
      const total = g.rows.length;
      const state = g.on === total ? "all on" : g.on === 0 ? "all off" : `${g.on}/${total} on`;
      return `<details class="folder" id="grp-${sectionSlug(section)}" open>
        <summary><span class="folder-name">${escapeHtml(section)}</span><span class="tile-meta">${total} switch${total === 1 ? "" : "es"} · ${state}</span></summary>
        <div class="tiles mini">${g.rows.join("")}</div>
      </details>`;
    })
    .join("")}</div>`;
  const flags = [d.botEnabled, d.marketEnabled, d.chronicleEnabled, d.autoBanEnabled, d.pointsEnabled, d.npcEnabled, d.npcChatterEnabled];
  const flagsOn = flags.filter(Boolean).length;
  const groupTotal = [...bySection.values()].reduce((n, g) => n + g.rows.length, 0);
  const groupOn = [...bySection.values()].reduce((n, g) => n + g.on, 0);
  return { switches: bigSquare("sec-features", "Bot &amp; feature switches", `${plural(flags.length, "switch", "switches")} · ${flagsOn} on`,
    `<p class="muted">Turning off the entire bot overrides everything else. Changes apply immediately.</p>
    <div class="tiles mini">${dedicated}</div>`),
    groups: bigSquare("sec-groups", "Command groups", `${plural(bySection.size, "group")} · ${groupOn}/${groupTotal} on`,
    `<p class="muted">One switch per card in the <a href="/guide" target="_blank" rel="noopener">Guild Codex</a>. Gold cards also need the gold switch on.</p>
    ${groups}`, true) };
}

/** A small square tile that opens its editor dialog (see the dashboard script). */
function editorTile(dialogId: string, title: string, meta: string, extraClass = ""): string {
  return `<button type="button" class="tile ${extraClass}" data-open="${dialogId}" aria-haspopup="dialog">
    <span class="tile-title">${title}</span>${meta ? `<span class="tile-meta">${meta}</span>` : ""}
  </button>`;
}

/** The editor window a tile expands into: a native modal <dialog> holding one form. */
function editorDialog(dialogId: string, heading: string, body: string, extraClass = ""): string {
  return `<dialog id="${dialogId}" class="editor ${extraClass}" aria-label="${escapeHtml(heading.replace(/<[^>]+>/g, ""))}">
    <div class="editor-head"><h3>${heading}</h3><button type="button" class="x" data-close aria-label="Close">✕</button></div>
    ${body}
  </dialog>`;
}

/** A large collapsible square for one top-level dashboard section (same look as the
 * command-group squares, one size up). `meta` is the short status shown in its header. */
function bigSquare(id: string, name: string, meta: string, body: string, wide = false): string {
  return `<details class="folder big${wide ? " wide" : ""}" id="${id}" open>
    <summary><h2 class="folder-name">${name}</h2><span class="tile-meta">${meta}</span></summary>
    ${body}
  </details>`;
}

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Tiles + their dialogs for one list section; the "new" tile always comes last. */
function tileSection(tiles: string[], dialogs: string[], emptyText: string): string {
  const note = tiles.length > 1 ? "" : `<p class="muted">${emptyText}</p>`;
  return `${note}<div class="tiles mini">${tiles.join("")}</div>${dialogs.join("")}`;
}

function snippet(text: string, max = 48): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function renderCommandsSection(d: DashboardData): string {
  const tiles: string[] = [];
  const dialogs: string[] = [];
  d.commands.forEach((c: any, i: number) => {
    const id = `dlg-cmd-${i}`;
    const cooldownSeconds = Math.round(Number(c.cooldown_ms ?? 0) / 1000);
    tiles.push(editorTile(id, `!${escapeHtml(c.name)}`, `used ${Number(c.uses ?? 0)}×`));
    dialogs.push(editorDialog(id, `<code>!${escapeHtml(c.name)}</code>`, `<form method="post" action="/dashboard/commands" class="row-form">
        ${dashHidden(d.broadcasterId, d.channelKey)}
        <input type="hidden" name="intent" value="save">
        <input type="hidden" name="name" value="${escapeHtml(c.name)}">
        <p class="muted">Used ${Number(c.uses ?? 0)}×</p>
        <label>Response <textarea name="response" maxlength="400" rows="4">${escapeHtml(c.response ?? "")}</textarea></label>
        <div class="row-controls">
          <label>Cooldown (s) <input type="number" name="cooldown_seconds" min="0" max="${d.maxCooldownSeconds}" value="${cooldownSeconds}"></label>
          <button type="submit">Save</button>
          <button type="submit" formaction="/dashboard/commands" name="intent" value="delete" class="danger">Delete</button>
        </div>
      </form>`));
  });
  tiles.push(editorTile("dlg-cmd-new", "＋ New command", "", "tile-new"));
  dialogs.push(editorDialog("dlg-cmd-new", "Add a command", `<form method="post" action="/dashboard/commands" class="add-form">
      ${dashHidden(d.broadcasterId, d.channelKey)}
      <input type="hidden" name="intent" value="add">
      <label>Name <input type="text" name="name" maxlength="25" pattern="[a-zA-Z0-9_-]{2,25}" placeholder="hello" required></label>
      <label>Response <textarea name="response" maxlength="400" rows="4" placeholder="Welcome to the guild hall, {user}!" required></textarea></label>
      <label>Cooldown (s) <input type="number" name="cooldown_seconds" min="0" max="${d.maxCooldownSeconds}" value="5"></label>
      <button type="submit">Add command</button>
    </form>`));
  return bigSquare("sec-commands", "Custom commands", plural(d.commands.length, "command"), `<p class="muted">Chat with <code>!&lt;name&gt;</code>. Placeholders: <code>{user}</code> <code>{target}</code> <code>{count}</code> <code>{random:a|b|c}</code>. Click a square to edit it.</p>
    ${tileSection(tiles, dialogs, "No custom commands yet.")}`);
}

function renderTriggersSection(d: DashboardData): string {
  const tiles: string[] = [];
  const dialogs: string[] = [];
  d.triggers.forEach((t: any, i: number) => {
    const id = `dlg-trg-${i}`;
    const cooldownSeconds = Math.round(Number(t.cooldown_ms ?? 0) / 1000);
    tiles.push(editorTile(id, `“${escapeHtml(t.keyword)}”`, `used ${Number(t.uses ?? 0)}×`));
    dialogs.push(editorDialog(id, `Trigger: “${escapeHtml(t.keyword)}”`, `<form method="post" action="/dashboard/triggers" class="row-form">
        ${dashHidden(d.broadcasterId, d.channelKey)}
        <input type="hidden" name="intent" value="save">
        <input type="hidden" name="keyword" value="${escapeHtml(t.keyword)}">
        <p class="muted">Used ${Number(t.uses ?? 0)}×</p>
        <label>Response <textarea name="response" maxlength="400" rows="4">${escapeHtml(t.response ?? "")}</textarea></label>
        <div class="row-controls">
          <label>Cooldown (s) <input type="number" name="cooldown_seconds" min="0" max="${d.maxCooldownSeconds}" value="${cooldownSeconds}"></label>
          <button type="submit">Save</button>
          <button type="submit" formaction="/dashboard/triggers" name="intent" value="delete" class="danger">Delete</button>
        </div>
      </form>`));
  });
  tiles.push(editorTile("dlg-trg-new", "＋ New trigger", "", "tile-new"));
  dialogs.push(editorDialog("dlg-trg-new", "Add a trigger", `<form method="post" action="/dashboard/triggers" class="add-form">
      ${dashHidden(d.broadcasterId, d.channelKey)}
      <input type="hidden" name="intent" value="add">
      <label>Keyword <input type="text" name="keyword" maxlength="40" placeholder="good luck" required></label>
      <label>Response <textarea name="response" maxlength="400" rows="4" placeholder="May the dice favor you, {user}!" required></textarea></label>
      <label>Cooldown (s) <input type="number" name="cooldown_seconds" min="0" max="${d.maxCooldownSeconds}" value="15"></label>
      <button type="submit">Add trigger</button>
    </form>`));
  return bigSquare("sec-triggers", "Chat triggers", plural(d.triggers.length, "trigger"), `<p class="muted">Fires automatically whenever the keyword appears in chat — no <code>!</code> needed. Click a square to edit it.</p>
    ${tileSection(tiles, dialogs, "No chat triggers yet.")}`);
}

function renderTimedMessagesSection(d: DashboardData): string {
  const tiles: string[] = [];
  const dialogs: string[] = [];
  d.timedMessages.forEach((m: any) => {
    const id = `dlg-tm-${escapeHtml(String(m.id))}`;
    const enabled = Number(m.enabled) === 1;
    const every = Number(m.interval_minutes ?? 0);
    tiles.push(editorTile(id, escapeHtml(snippet(m.message)), `every ${every} min · ${enabled ? "active" : "paused"}`, enabled ? "" : "tile-paused"));
    dialogs.push(editorDialog(id, `Timed message #${escapeHtml(String(m.id))}`, `<form method="post" action="/dashboard/timedmessages" class="row-form">
        ${dashHidden(d.broadcasterId, d.channelKey)}
        <input type="hidden" name="intent" value="save">
        <input type="hidden" name="id" value="${escapeHtml(String(m.id))}">
        <p class="muted">Posted ${Number(m.uses ?? 0)}× — ${enabled ? "active" : "paused"}</p>
        <label>Message <textarea name="message" maxlength="400" rows="4">${escapeHtml(m.message ?? "")}</textarea></label>
        <div class="row-controls">
          <label>Every (min) <input type="number" name="interval_minutes" min="${d.minIntervalMinutes}" max="${d.maxIntervalMinutes}" value="${every}"></label>
          <label class="check"><input type="checkbox" name="enabled" ${enabled ? "checked" : ""}> Active</label>
          <button type="submit">Save</button>
          <button type="submit" formaction="/dashboard/timedmessages" name="intent" value="delete" class="danger">Delete</button>
        </div>
      </form>`));
  });
  tiles.push(editorTile("dlg-tm-new", "＋ New timed message", "", "tile-new"));
  dialogs.push(editorDialog("dlg-tm-new", "Add a timed message", `<form method="post" action="/dashboard/timedmessages" class="add-form">
      ${dashHidden(d.broadcasterId, d.channelKey)}
      <input type="hidden" name="intent" value="add">
      <label>Message <textarea name="message" maxlength="400" rows="4" placeholder="Don't forget to follow the guild! {random:⚔️|🛡️|📜}" required></textarea></label>
      <label>Every (min) <input type="number" name="interval_minutes" min="${d.minIntervalMinutes}" max="${d.maxIntervalMinutes}" value="30" required></label>
      <button type="submit">Add timed message</button>
    </form>`));
  const active = d.timedMessages.filter((m: any) => Number(m.enabled) === 1).length;
  return bigSquare("sec-timed", "Timed messages", `${plural(d.timedMessages.length, "message")} · ${active} active`, `<p class="muted">Posted automatically on a rotating interval. Placeholders: <code>{count}</code> <code>{random:a|b|c}</code>. Click a square to edit it.</p>
    ${tileSection(tiles, dialogs, "No timed messages yet.")}`);
}

// Shown at GET /dashboard when the dashboard_key is valid but there's no
// verified mod session yet (see dashboard.ts) — a lightweight gate in front
// of the real management UI, not the UI itself.
export function renderDashboardLoginGate(d: { broadcasterName: string; loginUrl: string; error?: string }): string {
  const gateBanner = d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(d.broadcasterName)} — GuildScribe Dashboard</title>
  <style>
    :root{color-scheme:dark}
    body{font-family:Georgia,serif;max-width:520px;margin:80px auto;background:#15120f;color:#f4eadb;padding:24px;text-align:center}
    h1{color:#e6a56e}
    .muted{color:#aa9b8d;font-size:.9rem}
    a.btn{display:inline-block;background:#9147ff;color:#fff;border:0;border-radius:6px;padding:12px 22px;font-size:1rem;text-decoration:none;margin-top:16px}
    .banner{padding:10px 14px;border-radius:6px;margin:12px 0}
    .banner.error{background:#3a1f1f;color:#f0a6a6}
  </style></head><body>
  <h1>🔒 ${escapeHtml(d.broadcasterName)}'s Dashboard</h1>
  <p class="muted">This link is only good with a matching Twitch login — you need to be a moderator or the broadcaster of this channel.</p>
  ${gateBanner}
  <a class="btn" href="${d.loginUrl}">Log in with Twitch</a>
  </body></html>`;
}

export function renderDashboardPage(d: DashboardData): string {
  const features = renderFeaturesSection(d);
  const banner = d.error
    ? `<p class="banner error">${escapeHtml(d.error)}</p>`
    : d.notice
    ? `<p class="banner ok">${escapeHtml(d.notice)}</p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(d.broadcasterName)} — GuildScribe Dashboard</title>
  <style>
    :root{color-scheme:dark}
    body{font-family:Georgia,serif;max-width:1180px;margin:32px auto;background:#15120f;color:#f4eadb;padding:20px}
    h1{color:#e6a56e;margin-bottom:2px}
    h2{color:#e6a56e;margin:0}
    h3{color:#d6c6b5;margin:14px 0 8px}
    a{color:#e6a56e}
    .muted{color:#aa9b8d;font-size:.88rem}
    code{background:#0e0d0c;color:#f0c39e;padding:2px 6px;border-radius:4px}
    summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;user-select:none}
    summary::-webkit-details-marker{display:none}
    summary::before{content:"▸";color:#aa9b8d;font-size:.9rem;width:1em;transition:transform .15s}
    details[open]>summary::before{transform:rotate(90deg)}
    summary:hover h2,summary:hover h4{text-decoration:underline;text-decoration-color:#684632}
    summary:focus-visible{outline:2px solid #e6a56e;outline-offset:4px;border-radius:4px}
    details{scroll-margin-top:16px}
    .index{background:#1c1712;border:1px solid #2a231c;border-radius:8px;padding:12px 16px;margin:18px 0}
    .index-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}
    .index ol{margin:8px 0 0;padding-left:22px;line-height:1.7}
    .index ul{margin:0 0 4px;padding-left:0;list-style:none;display:flex;flex-wrap:wrap;gap:2px 14px;font-size:.85rem}
    button.link{background:none;border:0;padding:0;margin:0;color:#e6a56e;font:inherit;font-size:.85rem;cursor:pointer;text-decoration:underline}
    .row-form,.add-form{background:#1c1712;border:1px solid #2a231c;border-radius:8px;padding:12px 14px}
    .add-form{border-style:dashed}
    .row-head{font-size:.92rem;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
    textarea,input[type=text],input[type=number]{width:100%;box-sizing:border-box;background:#0e0d0c;color:#f4eadb;border:1px solid #453626;border-radius:6px;padding:8px;font-family:inherit;margin:4px 0}
    label{display:block;font-size:.85rem;color:#c9b8a6}
    label.check{display:flex;align-items:center;gap:6px;font-size:.9rem}
    .row-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:6px}
    .row-controls label{flex:0 0 auto}
    button{background:#9147ff;color:#fff;border:0;border-radius:6px;padding:8px 16px;font-size:.9rem;cursor:pointer;margin-top:6px}
    button.danger{background:#5c2a2a}
    .banner{padding:10px 14px;border-radius:6px;margin:12px 0}
    .banner.ok{background:#1e3320;color:#a7e6ac}
    .banner.error{background:#3a1f1f;color:#f0a6a6}
    .guide-link{white-space:nowrap}
    .tile>.pill{flex:0 0 auto}
    .tile:target{border-color:#e6a56e;box-shadow:0 0 0 2px #e6a56e66}
    .tile{scroll-margin-top:24px}
    .toggle-detail p{margin:8px 0;color:#d6c6b5;font-size:.92rem}
    .toggle-detail .warn{color:#f0c39e}
    .row-controls form.push{margin:0 0 0 auto}
    .tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:10px;margin:12px 0}
    .tile{aspect-ratio:1;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:6px;text-align:center;background:#1c1712;color:#f4eadb;border:1px solid #453626;border-radius:10px;padding:10px;margin:0;font-family:inherit;font-size:.92rem;cursor:pointer;min-width:0;transition:transform .12s,border-color .12s,background .12s}
    .tile:hover,.tile:focus-visible{transform:translateY(-2px);border-color:#e6a56e;background:#221b15;outline:none}
    .tile-title{font-weight:700;color:#f0c39e;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
    .tile-meta{font-size:.75rem;color:#aa9b8d}
    .tile-new{border-style:dashed;background:transparent}
    .tile-new .tile-title{color:#e6a56e;font-weight:400}
    .tile-paused{opacity:.6}
    .folders{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;align-items:start;margin:12px 0}
    details.folder{box-sizing:border-box;background:#1a1511;border:1px solid #684632;border-radius:12px;padding:12px 14px;min-width:0}
    details.folder[open]{aspect-ratio:1}
    .board{display:flex;flex-direction:column;gap:18px;margin:22px 0}
    .board-col{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:18px;align-items:start;min-width:0}
    .board-col.wide{display:block}
    details.folder.big{padding:16px 18px;background:#17130f;border-color:#7a5238}
    @media(min-width:1180px){.board{flex-direction:row;align-items:flex-start}.board-col{flex:1;display:flex;flex-direction:column;align-items:stretch;container-type:inline-size}.board-col.wide{flex:2;display:block}.board-col>details.folder.big[open]{aspect-ratio:auto;min-height:100cqw}}
    details.folder.big.wide[open]{aspect-ratio:auto}
    details.folder.big>summary{border-bottom:1px solid #2a231c;padding-bottom:8px;margin-bottom:6px}
    h2.folder-name{font-size:1.3rem;color:#e6a56e;margin:0}
    details.folder>summary{justify-content:space-between;flex-wrap:wrap;gap:4px 10px}
    details.folder>summary::before{order:-1}
    .folder-name{flex:1;font-weight:700;color:#f0c39e;font-size:1.02rem}
    .tiles.mini{grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:12px 0 0}
    .tiles.mini .tile{font-size:.82rem;padding:8px}
    dialog.editor{background:#1c1712;color:#f4eadb;border:1px solid #684632;border-radius:12px;width:min(560px,92vw);max-height:88vh;padding:16px 20px 20px;box-shadow:0 24px 60px #000c}
    dialog.editor::backdrop{background:#000b}
    .editor-head{display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:1px solid #2a231c;padding-bottom:8px;margin-bottom:6px}
    .editor-head h3{margin:0;color:#e6a56e}
    dialog.editor .row-form,dialog.editor .add-form{background:none;border:0;padding:0}
    button.x{background:none;color:#aa9b8d;font-size:1.1rem;padding:2px 8px;margin:0}
    button.x:hover{color:#f4eadb}
.guide-link{font-size:.8rem;font-weight:400;margin-left:4px}
    .pill{display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 9px;border-radius:999px}
    .pill.on{background:#1e3320;color:#a7e6ac}
    .pill.off{background:#3a1f1f;color:#f0a6a6}
    button.danger{background:#5c2a2a}
  </style></head><body>
  <h1>🛡️ ${escapeHtml(d.broadcasterName)}'s Dashboard</h1>
  <p class="muted">Manage this channel's bot settings, custom commands, chat triggers, and timed messages. This link is private — anyone holding it can edit this channel; get a fresh one in chat with <code>!dashboard reset</code>.</p>
  ${banner}
  ${renderDashboardIndex()}
  <div class="board">
    <div class="board-col">
      ${features.switches}
      ${renderCommandsSection(d)}
      ${renderTriggersSection(d)}
      ${renderTimedMessagesSection(d)}
    </div>
    <div class="board-col wide">${features.groups}</div>
  </div>
  <script>(function(){
    var KEY="gs-dash-closed",all=[].slice.call(document.querySelectorAll("details.folder"));
    function load(){try{return JSON.parse(localStorage.getItem(KEY)||"[]")}catch(e){return[]}}
    function save(){try{localStorage.setItem(KEY,JSON.stringify(all.filter(function(d){return!d.open}).map(function(d){return d.id})))}catch(e){}}
    // Open every collapsed section / folder window containing el, so index links and /dashboard/go#toggle-* anchors land visibly.
    function reveal(el){var dl=[];for(var n=el;n;n=n.parentElement){if(n.tagName==="DETAILS")n.open=true;else if(n.tagName==="DIALOG"&&!n.open)dl.unshift(n)}dl.forEach(function(d){openDlg(d,document.querySelector('[data-open="'+d.id+'"]'),true)})}
    function show(el){reveal(el);if(el.hasAttribute("data-open")){el.scrollIntoView({block:"center"});openDlg(document.getElementById(el.getAttribute("data-open")),el)}else el.scrollIntoView()}
    function goHash(){var h=location.hash.slice(1),el=h&&document.getElementById(h);if(el)show(el)}
    load().forEach(function(id){var d=document.getElementById(id);if(d)d.open=false});
    all.forEach(function(d){d.addEventListener("toggle",save)});
    window.addEventListener("hashchange",goHash);
    document.querySelectorAll(".index a[href^='#']").forEach(function(a){a.addEventListener("click",function(e){var id=a.getAttribute("href").slice(1),el=document.getElementById(id);if(!el)return;e.preventDefault();try{history.replaceState(null,"","#"+id)}catch(x){}show(el)})});
    // Tiles expand into their editor window; it shrinks back into the tile on close.
    var reduce=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
    function fromTile(dlg,tile,reverse){
      if(reduce||!tile||!dlg.animate)return null;
      var t=tile.getBoundingClientRect(),r=dlg.getBoundingClientRect();
      var tf="translate("+((t.left+t.width/2)-(r.left+r.width/2))+"px,"+((t.top+t.height/2)-(r.top+r.height/2))+"px) scale("+(t.width/r.width)+","+(t.height/r.height)+")";
      var k=[{transform:tf,opacity:.3},{transform:"none",opacity:1}];
      return dlg.animate(reverse?k.reverse():k,{duration:reverse?160:220,easing:"cubic-bezier(.2,.8,.2,1)"});
    }
    var opener={};
    function openDlg(dlg,tile,quiet){
      if(!dlg||dlg.open)return;
      opener[dlg.id]=tile;
      if(dlg.showModal)dlg.showModal();else dlg.setAttribute("open","");
      if(!quiet)fromTile(dlg,tile,false);
      var f=dlg.classList.contains("folder")?dlg.querySelector(".tile"):dlg.querySelector("textarea,input:not([type=hidden])");if(f)f.focus();
    }
    document.querySelectorAll("[data-open]").forEach(function(tile){tile.addEventListener("click",function(){openDlg(document.getElementById(tile.getAttribute("data-open")),tile)})});
    function closeDlg(dlg){var a=fromTile(dlg,opener[dlg.id],true);if(a)a.onfinish=function(){dlg.close()};else dlg.close()}
    document.querySelectorAll("dialog.editor").forEach(function(dlg){
      dlg.addEventListener("click",function(e){if(e.target!==dlg)return;var r=dlg.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDlg(dlg)}); // backdrop click
      dlg.addEventListener("cancel",function(e){e.preventDefault();closeDlg(dlg)}); // Esc
      dlg.querySelector("[data-close]").addEventListener("click",function(){closeDlg(dlg)});
      dlg.addEventListener("close",function(){var t=opener[dlg.id];if(t)t.focus()});
    });
    document.querySelectorAll("[data-all]").forEach(function(b){b.addEventListener("click",function(){var o=b.getAttribute("data-all")==="open";all.forEach(function(d){d.open=o});save()})});
    goHash();
  })();</script>
  </body></html>`;
}

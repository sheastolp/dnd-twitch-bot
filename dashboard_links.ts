// Linked switches on the dashboard: which switches depend on which
// (TOGGLE_REQUIRES in commandgroups.ts), drawn as gold-bordered links so a
// mod can always jump straight to the switch a feature is waiting on.
//
//   - reqChips()      "Needs: 🪙 Gold … On/Off" links inside a switch's window
//   - tileNeedNote()  a short "needs Gold" line on the tile itself when a
//                     required switch is off
//   - requiredByChips()  on a required switch, which switches depend on it
//   - renderLinksSection()  the command → switch summary: every command, its
//                     switch, what that switch needs, and whether it's ready
//
// Links point at #toggle-<key>; the dashboard script closes any open window
// and opens the target switch (see .req-link in dashboard_page.ts).

import { COMMAND_GROUPS, DEDICATED_COMMANDS, DEDICATED_LABELS, REQUIRED_TOGGLES, requiredBy, requiredLabel, TOGGLE_REQUIRES, toggleLabel } from "./commandgroups.ts";
import { escapeHtml } from "./utils.ts";
import type { DashboardData } from "./dashboard_page.ts";

/** On/off for any switch key, as the dashboard shows it. */
export function toggleState(d: DashboardData, key: string): boolean {
  switch (key) {
    case "bot": return d.botEnabled;
    case "market": return d.marketEnabled;
    case "chronicle": return d.chronicleEnabled;
    case "autoban": return d.autoBanEnabled;
    case "points": return d.pointsEnabled;
    case "npc": return d.npcEnabled;
    case "npcchatter": return d.npcChatterEnabled;
    case "hoard": return d.hoardEnabled;
  }
  return d.groupToggles[key] ?? true;
}

const ICON: Record<string, string> = { points: "🪙", hoard: "⚔️", npc: "🎭", maps: "🗺️", bot: "⚙" };
const icon = (key: string) => ICON[key] ?? "⚙";

/** One gold-bordered link to switch `key`, with its current state. */
export function reqLink(d: DashboardData, key: string, prefix = ""): string {
  const on = toggleState(d, key);
  return `<a class="req-link${on ? "" : " off"}" href="#toggle-${escapeHtml(key)}" title="${escapeHtml(toggleLabel(key))} switch">${prefix}${icon(key)} ${escapeHtml(requiredLabel(key))} <b>${on ? "On" : "Off"}</b></a>`;
}

/** "Needs: …" links for the switches `key` depends on ("" if none). */
export function reqChips(d: DashboardData, key: string): string {
  const reqs = TOGGLE_REQUIRES[key] ?? [];
  if (!reqs.length) return "";
  const blocked = reqs.some((r) => !toggleState(d, r));
  return `<p class="req-row"><span class="req-label">Needs:</span> ${reqs.map((r) => reqLink(d, r)).join(" ")}${
    blocked ? `<span class="req-warn">Turn the switch${reqs.length > 1 ? "es" : ""} above on too, or this does nothing.</span>` : ""
  }</p>`;
}

/** On a switch others depend on: links to each of them. */
export function requiredByChips(d: DashboardData, key: string): string {
  const deps = requiredBy(key);
  if (!deps.length) return "";
  return `<p class="req-row"><span class="req-label">Required by:</span> ${deps.map((k) => `<a class="req-link soft" href="#toggle-${escapeHtml(k)}">${escapeHtml(toggleLabel(k))}</a>`).join(" ")}</p>`;
}

/** Small line on a tile whose required switch is off ("" otherwise). */
export function tileNeedNote(d: DashboardData, key: string): string {
  const off = (TOGGLE_REQUIRES[key] ?? []).filter((r) => !toggleState(d, r));
  return off.length ? `<span class="tile-need">needs ${off.map((r) => `${icon(r)} ${escapeHtml(requiredLabel(r))}`).join(" + ")}</span>` : "";
}

/** Extra class for a tile: gold border when other switches depend on it. */
export function tileReqClass(key: string): string {
  return REQUIRED_TOGGLES.has(key) ? " tile-required" : "";
}

/** "Switches here also depend on: …" for one dashboard folder ("" if none). */
export function folderReqNote(d: DashboardData, keys: string[]): string {
  const reqs = [...new Set(keys.flatMap((k) => TOGGLE_REQUIRES[k] ?? []))].filter((r) => !keys.includes(r));
  if (!reqs.length) return "";
  return `<p class="req-row folder-req"><span class="req-label">Some switches here also need:</span> ${reqs.map((r) => reqLink(d, r)).join(" ")}</p>`;
}

/** Commands named in a group label: "Hunting (!hunt, !rest, !ledger)" → "!hunt, !rest, !ledger". */
function labelCommands(label: string): string {
  const m = label.match(/\(([^)]*)\)\s*$/);
  return m ? m[1] : "";
}

/** The command → switch summary (a wide dashboard section). */
export function renderLinksSection(d: DashboardData, bigSquare: (id: string, name: string, meta: string, body: string, wide?: boolean) => string): string {
  const rows: Array<{ key: string; commands: string; section: string }> = [
    ...Object.keys(DEDICATED_LABELS).map((key) => ({ key, commands: DEDICATED_COMMANDS[key] ?? "", section: "Bot & feature switches" })),
    ...Object.entries(COMMAND_GROUPS).map(([key, g]) => ({ key, commands: labelCommands(g.label) || g.label, section: g.section })),
  ];
  let ready = 0;
  const body = rows.map(({ key, commands, section }) => {
    const on = toggleState(d, key);
    const needs = (TOGGLE_REQUIRES[key] ?? []).filter((r) => r !== key);
    const blockers = [...(key === "bot" ? [] : ["bot"]), ...needs].filter((r) => !toggleState(d, r));
    const ok = on && !blockers.length;
    if (ok) ready++;
    const status = ok
      ? `<span class="pill on">Ready</span>`
      : !on
      ? `<span class="pill off">Off</span>`
      : `<span class="pill off">Blocked</span>`;
    const search = `${commands} ${toggleLabel(key)} ${section} ${needs.map(toggleLabel).join(" ")}`.toLowerCase();
    return `<tr data-search="${escapeHtml(search)}"><td class="cmds">${escapeHtml(commands)}</td>` +
      `<td><a class="sum-link${REQUIRED_TOGGLES.has(key) ? " gold" : ""}" href="#toggle-${escapeHtml(key)}">${escapeHtml(toggleLabel(key))}</a><div class="muted small">${escapeHtml(section)}</div></td>` +
      `<td>${needs.length ? needs.map((r) => reqLink(d, r)).join(" ") : `<span class="muted">—</span>`}</td>` +
      `<td>${status}${!ok && blockers.length && on ? `<div class="muted small">turn on ${blockers.map((b) => `<a href="#toggle-${b}" class="req-inline">${escapeHtml(requiredLabel(b))}</a>`).join(", ")}</div>` : ""}</td></tr>`;
  }).join("");
  return bigSquare(
    "sec-links",
    "Linked commands summary",
    `${rows.length} switches · ${ready} ready`,
    `<p class="muted">Find a command to see which switch runs it and which other switches it needs. Every name links straight to its switch; switches with a <span class="gold-swatch">gold border</span> are ones other features depend on.</p>
    <input type="search" class="sum-filter" placeholder="Find a command, e.g. !buy or gold" aria-label="Filter commands">
    <div class="sum-wrap"><table class="sum"><thead><tr><th>Commands</th><th>Switch</th><th>Also needs</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="muted small sum-empty" hidden>No command matches.</p>`,
    true,
  );
}

export const LINKS_CSS = `
.req-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:8px 0}
.req-label{font:600 .72rem var(--display);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3)}
.req-link{display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border:2px solid var(--gold);border-radius:999px;background:#ecdcab;color:#5c3f0e;font:600 .78rem var(--display);text-decoration:none;box-shadow:inset 0 0 0 1px #f6e8bf}
.req-link:hover{background:#e4cd8c;color:#3f2a06}
.req-link b{font-weight:700;color:var(--ok)}
.req-link.off b{color:var(--bad)}
.req-link.soft{border-width:1px;background:#e6dcc0}
.req-warn{flex-basis:100%;font-size:.82rem;color:var(--bad)}
.folder-req{margin:4px 0 10px}
.tile-required{border:3px solid var(--gold);box-shadow:0 0 0 2px #e9d59a inset,0 2px 6px #6b441826}
.tile-need{font-size:.7rem;line-height:1.2;color:#7a4d0c;background:#efe0b0;border:1px solid var(--gold);border-radius:999px;padding:1px 7px}
.sum-filter{width:100%;padding:10px 12px;margin:6px 0 10px}
.sum-wrap{overflow-x:auto;border:1px solid var(--edge);border-radius:6px;background:#e7e0ca}
table.sum{width:100%;border-collapse:collapse}
table.sum th,table.sum td{text-align:left;padding:8px 10px;border-bottom:1px solid #cebb8b;vertical-align:top}
table.sum th{font:700 .72rem var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--seal-dk);background:#d9caa2}
table.sum td.cmds{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.82rem;color:var(--ink-2)}
.sum-link{font-weight:600}
.sum-link.gold{padding:0 6px;border:2px solid var(--gold);border-radius:4px;background:#efe0b0;text-decoration:none}
.gold-swatch{padding:0 6px;border:2px solid var(--gold);border-radius:4px;background:#efe0b0}
.req-inline{color:var(--seal)}
.tile.flash{outline:3px solid var(--gold);outline-offset:3px}
`;

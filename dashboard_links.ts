// Linked switches on the dashboard: which switches depend on which
// (TOGGLE_REQUIRES in commandgroups.ts), drawn as gold-bordered links so a
// mod can always jump straight to the switch a feature is waiting on.
//
//   - reqChips()      "Needs: 🪙 Gold … On/Off" links inside a switch's window
//   - tileNeedNote()  a short "needs Gold" line on the tile itself when a
//                     required switch is off
//   - requiredByChips()  on a required switch, which switches depend on it
//
// Links point at #toggle-<key>; the dashboard script closes any open window
// and opens the target switch (see .req-link in dashboard_page.ts).

import { REQUIRED_TOGGLES, requiredBy, requiredLabel, TOGGLE_REQUIRES, toggleLabel } from "./commandgroups.ts";
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
.tile.flash{outline:3px solid var(--gold);outline-offset:3px}
.gold-swatch{padding:0 6px;border:2px solid var(--gold);border-radius:4px;background:#efe0b0}
`;

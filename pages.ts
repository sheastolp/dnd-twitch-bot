// HTML page rendering for the web UI

import type { Character } from "./types.ts";
import { abilityNames } from "./data.ts";
import { modifier, formatRaceName, escapeHtml } from "./utils.ts";
import type { MapRow, MapToken } from "./db.ts";
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

// Operator-only diagnostic page: merchant cron health + per-channel merchant
// state + recent monitor_events, all in one browser-viewable page instead of
// raw JSON. Gated in main.ts by ADMIN_API_SECRET; this function assumes the
// caller has already authenticated.
export function renderAdminLogsPage(opts: {
  status: any | null;
  overview: any[];
  events: any[];
  kindFilter: string;
  key: string;
}): string {
  const { status, overview, events, kindFilter, key } = opts;
  const now = Date.now();
  const lastRunAt = status ? Number(status.last_run_at ?? 0) : 0;
  const staleMs = 20 * 60_000;
  const stale = !lastRunAt || now - lastRunAt > staleMs;
  const lastFailed = status ? Number(status.last_posts_failed ?? 0) > 0 : false;

  const fmt = (ts: any) => (ts ? escapeHtml(new Date(Number(ts)).toLocaleString()) : "—");
  const relMinutes = (ts: any) => {
    const n = Number(ts);
    if (!n) return "—";
    const diffMin = Math.round((n - now) / 60_000);
    if (diffMin > 0) return `in ${diffMin}m`;
    return `${Math.abs(diffMin)}m ago`;
  };

  const statusBadge = !status
    ? `<span class="badge badge-warn">never run</span>`
    : stale
    ? `<span class="badge badge-bad">stale — no run in 20+ min</span>`
    : lastFailed
    ? `<span class="badge badge-warn">running, last tick had failures</span>`
    : `<span class="badge badge-ok">running cleanly</span>`;

  const statusCard = `<div class="card">
    <h2>🛒 Merchant Cron Health ${statusBadge}</h2>
    ${
      status
        ? `<table class="kv">
      <tr><td>Last run</td><td>${fmt(status.last_run_at)} (${relMinutes(status.last_run_at)})</td></tr>
      <tr><td>Last tick</td><td>${Number(status.last_channels_due ?? 0)} due, ${Number(status.last_posts_ok ?? 0)} posted, ${Number(status.last_posts_failed ?? 0)} failed</td></tr>
      <tr><td>Last successful post</td><td>${fmt(status.last_success_at)}</td></tr>
      <tr><td>Last error</td><td>${status.last_error ? `${escapeHtml(String(status.last_error))} <span class="muted">(${fmt(status.last_error_at)})</span>` : "none recorded"}</td></tr>
      <tr><td>Totals</td><td>${Number(status.total_runs ?? 0)} runs · ${Number(status.total_posts_ok ?? 0)} posted · ${Number(status.total_posts_failed ?? 0)} failed</td></tr>
    </table>`
        : `<p class="muted">No cron run has ever been recorded. If channels have the merchant turned on but this stays empty, the Val Town CRON trigger for <code>merchant.cron.ts</code> most likely isn't scheduled — check the val's trigger settings in Val Town.</p>`
    }
  </div>`;

  const overviewRows = overview
    .map((r: any) => {
      const merchantOn = Number(r.merchant_enabled) === 1;
      const connected = Number(r.connected) === 1;
      const blocked = Number(r.blocked) === 1;
      const botOn = Number(r.bot_enabled) === 1;
      let why = "";
      if (!merchantOn) why = "merchant is off (!market on not run, or turned off)";
      else if (!connected) why = "channel not connected to GuildScribe";
      else if (blocked) why = `channel blocked by operator${r.block_reason ? ` (${escapeHtml(String(r.block_reason))})` : ""}`;
      else if (!botOn) why = "bot disabled in this channel (!dndbot off)";
      else if (r.next_post_at && Number(r.next_post_at) > now) why = `waiting — next post ${relMinutes(r.next_post_at)}`;
      else if (r.next_post_at) why = "due now — should post on the next cron tick";
      else why = "enabled but no next_post_at scheduled — toggle !market off then on again";
      const rowClass = merchantOn && connected && !blocked && botOn ? "" : "row-muted";
      return `<tr class="${rowClass}"><td>${escapeHtml(r.display_name || r.login || r.broadcaster_id)}</td><td>${merchantOn ? "on" : "off"}</td><td>${connected ? "yes" : "no"}</td><td>${blocked ? "yes" : "no"}</td><td>${botOn ? "yes" : "no"}</td><td>${fmt(r.next_post_at)}</td><td>${escapeHtml(why)}</td></tr>`;
    })
    .join("");

  const overviewCard = `<div class="card">
    <h2>Per-channel merchant state</h2>
    ${
      overview.length
        ? `<div style="overflow:auto"><table><thead><tr><th>Channel</th><th>Merchant</th><th>Connected</th><th>Blocked</th><th>Bot on</th><th>Next post</th><th>Diagnosis</th></tr></thead><tbody>${overviewRows}</tbody></table></div>`
        : `<p class="muted">No channel has ever run <code>!market on</code> — the merchant_settings table is empty.</p>`
    }
  </div>`;

  const kindOptions = ["", "merchant", "operator_disable", "operator_enable", "dashboard_toggle"]
    .map((k) => `<option value="${escapeHtml(k)}" ${k === kindFilter ? "selected" : ""}>${k ? escapeHtml(k) : "all kinds"}</option>`)
    .join("");

  const eventRows = events
    .map(
      (e: any) =>
        `<tr><td>${fmt(e.created_at)}</td><td><code>${escapeHtml(String(e.kind || ""))}</code></td><td>${escapeHtml(String(e.detail || ""))}</td></tr>`,
    )
    .join("");

  const eventsCard = `<div class="card">
    <h2>Recent monitor events</h2>
    <form method="get" action="/admin/logs" class="filter-form">
      <input type="hidden" name="key" value="${escapeHtml(key)}">
      <label>Filter: <select name="kind" onchange="this.form.submit()">${kindOptions}</select></label>
    </form>
    <div style="overflow:auto"><table><thead><tr><th>Timestamp</th><th>Kind</th><th>Detail</th></tr></thead><tbody>${
      eventRows || `<tr><td colspan="3">No events recorded.</td></tr>`
    }</tbody></table></div>
  </div>`;

  return `<h1>🪵 GuildScribe Operator Logs</h1><p class="muted">Auto-refreshes every 30s. Bookmark this URL with your key to check back later.</p>${statusCard}${overviewCard}${eventsCard}<style>
    body{max-width:1100px!important}
    .card{background:#211b16;border:1px solid #684632;border-radius:10px;padding:16px 20px;margin:18px 0}
    .card h2{color:#e6a56e;margin-top:0;font-size:1.15rem}
    table{width:100%;border-collapse:collapse}
    th,td{padding:8px 10px;border:1px solid #684632;text-align:left;vertical-align:top;font-size:.88rem}
    th{color:#e6a56e}
    td{color:#d6c6b5}
    table.kv td:first-child{color:#e6a56e;width:180px}
    .row-muted td{opacity:.55}
    code{color:#f0c39e}
    .muted{color:#aa9b8d;font-size:.9rem}
    .badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:.7rem;font-weight:700;vertical-align:middle;margin-left:8px}
    .badge-ok{background:#1e4620;color:#8be08e}
    .badge-warn{background:#4a3a12;color:#e6c56e}
    .badge-bad{background:#4a1e1e;color:#e68e8e}
    .filter-form{margin-bottom:10px}
    select{background:#15120f;color:#eee;border:1px solid #684632;border-radius:4px;padding:4px 8px}
    @media(max-width:700px){table{font-size:.75rem}th,td{padding:5px}}
  </style>`;
}

// Shared look for the /dashboard pages — mirrors the guild-hall palette used
// by renderGuidePage/renderAdminLogsPage so this doesn't feel like a
// different app bolted on.
const DASHBOARD_STYLE = `<style>
  body{max-width:640px!important}
  .card{background:#211b16;border:1px solid #684632;border-radius:10px;padding:18px 20px;margin:16px 0}
  .card h2{color:#e6a56e;margin:0 0 4px;font-size:1.05rem}
  .muted{color:#aa9b8d;font-size:.88rem}
  .module-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 0;border-top:1px solid #684632}
  .module-row:first-of-type{border-top:0}
  .module-row h3{margin:0;color:#f0c39e;font-size:1rem}
  .module-row p{margin:2px 0 0;color:#aa9b8d;font-size:.85rem}
  .state{font-weight:700;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;padding:3px 10px;border-radius:999px;margin-right:10px}
  .state-on{background:#1e4620;color:#8be08e}
  .state-off{background:#3a2b22;color:#c9a98c}
  button.toggle-btn{background:#b97545;color:#15120f;border:1px solid #e6a56e;border-radius:6px;padding:8px 14px;font-weight:700;font-size:.85rem;cursor:pointer}
  button.toggle-btn:hover{background:#e6a56e}
  .badge-blocked{display:inline-block;background:#4a1e1e;color:#e68e8e;font-size:.78rem;font-weight:700;padding:3px 10px;border-radius:999px;margin-left:8px}
  ul.channel-pick{list-style:none;padding:0;margin:0}
  ul.channel-pick li{border-top:1px solid #684632;padding:12px 0}
  ul.channel-pick li:first-child{border-top:0}
  ul.channel-pick a{background:transparent;color:#f0c39e;text-decoration:underline;padding:0}
  .top-links{margin-top:18px;font-size:.85rem}
  .top-links a{background:transparent;color:#e6a56e;padding:0;text-decoration:underline;margin-right:14px}
</style>`;

/** Shown when a signed-in viewer isn't a mod/broadcaster of any
 * GuildScribe-connected channel — either they picked the wrong Twitch
 * account, or their channel hasn't run /connect yet. */
export function renderDashboardEmptyPage(displayName: string): string {
  return `<h1>🛡️ Guild Dashboard</h1><div class="card"><p>Signed in as <strong>${
    escapeHtml(displayName)
  }</strong>, but that account isn't a moderator or broadcaster of any channel currently connected to GuildScribe.</p><p class="muted">If this is the wrong Twitch account, log out and sign back in with the right one. If your channel hasn't connected yet, use <a href="/connect">Raise your banner</a> first.</p></div><p class="top-links"><a href="/dashboard/logout">Log out</a> · <a href="/guide">Guild Codex</a></p>${DASHBOARD_STYLE}`;
}

/** Shown when a signed-in viewer moderates/broadcasts more than one
 * connected channel — picks which channel's dashboard to open. */
export function renderDashboardPicker(
  displayName: string,
  channels: { broadcaster_id: string; display_name?: string; login?: string }[],
): string {
  const items = channels
    .map((c) => {
      const label = escapeHtml(c.display_name || c.login || c.broadcaster_id);
      return `<li><a href="/dashboard?channel=${encodeURIComponent(c.broadcaster_id)}">${label}</a></li>`;
    })
    .join("");
  return `<h1>🛡️ Guild Dashboard</h1><div class="card"><p>Signed in as <strong>${
    escapeHtml(displayName)
  }</strong>. Choose a channel to manage:</p><ul class="channel-pick">${items}</ul></div><p class="top-links"><a href="/dashboard/logout">Log out</a> · <a href="/guide">Guild Codex</a></p>${DASHBOARD_STYLE}`;
}

/** The main status page — one on/off switch per module for a single
 * channel. Only reached after main.ts has confirmed the signed-in viewer is
 * a mod/broadcaster of this exact channel. */
export function renderDashboardStatusPage(opts: {
  displayName: string;
  channel: { broadcaster_id: string; display_name?: string; login?: string };
  blocked: boolean;
  showSwitcher: boolean;
  // `key` is deliberately a plain string, not a fixed union — the module
  // list is driven entirely by DASHBOARD_MODULES in main.ts, so this page
  // never needs editing when a module is added, renamed, or removed.
  modules: { key: string; label: string; description: string; enabled: boolean }[];
}): string {
  const { displayName, channel, blocked, showSwitcher, modules } = opts;
  const channelLabel = escapeHtml(channel.display_name || channel.login || channel.broadcaster_id);
  const rows = modules
    .map((m) => {
      const nextEnabled = m.enabled ? "0" : "1";
      return `<div class="module-row"><div><h3>${escapeHtml(m.label)}</h3><p>${escapeHtml(m.description)}</p></div><div style="display:flex;align-items:center"><span class="state ${
        m.enabled ? "state-on" : "state-off"
      }">${m.enabled ? "On" : "Off"}</span><form method="post" action="/dashboard/toggle"><input type="hidden" name="channel" value="${
        escapeHtml(channel.broadcaster_id)
      }"><input type="hidden" name="module" value="${m.key}"><input type="hidden" name="enabled" value="${nextEnabled}"><button class="toggle-btn" type="submit">Turn ${
        m.enabled ? "off" : "on"
      }</button></form></div></div>`;
    })
    .join("");
  return `<h1>🛡️ ${channelLabel}'s Guild Dashboard</h1><p class="muted">Signed in as ${
    escapeHtml(displayName)
  }${blocked ? '<span class="badge-blocked">blocked by operator</span>' : ""}</p><div class="card">${rows}</div>${
    blocked
      ? '<div class="card"><p class="muted">This channel is currently blocked at the operator level — modules stay off in chat regardless of these switches until the block is lifted.</p></div>'
      : ""
  }<p class="top-links">${
    showSwitcher ? '<a href="/dashboard">Switch channel</a> · ' : ""
  }<a href="/dashboard/logout">Log out</a> · <a href="/guide">Guild Codex</a></p>${DASHBOARD_STYLE}`;
}

function renderMapTemplateList(): string {
  return Object.values(MAP_TEMPLATES)
    .map(
      (t) =>
        `<li><code>${escapeHtml(t.name)}</code> — ${escapeHtml(t.label)} (${t.width}x${t.height}): ${escapeHtml(t.description)}</li>`,
    )
    .join("");
}

export function renderGuidePage() {
  return `<style>:root{color-scheme:dark}body{max-width:1040px;background:#15120f;color:#f4eadb;font-family:Georgia,serif;line-height:1.5}a{background:transparent;color:#e6a56e;padding:0;text-decoration:underline}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;margin-left:42px}.action-button{display:inline-flex;align-items:center;justify-content:center;background:#b97545;color:#15120f!important;border:1px solid #e6a56e;border-radius:8px;padding:14px 20px;min-width:190px;font:700 1rem ui-monospace,SFMono-Regular,monospace;text-decoration:none!important;box-shadow:0 8px 18px #0005;transition:transform .18s ease,background .18s ease}.action-button:hover{background:#e6a56e;transform:translateY(-2px)}.action-button:focus-visible{outline:3px solid #f4eadb;outline-offset:3px}h1{font-size:3rem;line-height:1.05;margin-bottom:8px;color:#f4eadb}h2{color:#e6a56e;border-bottom:1px solid #684632;padding-bottom:8px;margin-top:36px}h3{color:#f0c39e;margin-bottom:4px}p{color:#d6c6b5}.intro{font-size:1.2rem;max-width:700px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}.card{background:#211b16;border:1px solid #684632;border-radius:10px;padding:18px;box-shadow:0 10px 24px #0005}.cmd{display:block;background:#0e0d0c;color:#f0c39e;border-left:3px solid #b97545;padding:9px 12px;margin:8px 0;font-family:ui-monospace,SFMono-Regular,monospace;font-size:.9rem;overflow-wrap:anywhere}.note{background:#33251c;border-left:4px solid #b97545;padding:12px 16px;margin:18px 0}.muted{color:#aa9b8d;font-size:.94rem}.top{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;border-bottom:1px solid #684632;padding-bottom:22px}.pill{display:inline-block;border:1px solid #b97545;border-radius:999px;padding:5px 10px;color:#e6a56e;font:600 .78rem ui-monospace,SFMono-Regular,monospace;text-transform:uppercase;letter-spacing:.08em}html{scroll-behavior:smooth}h2{scroll-margin-top:16px}.toc{background:#211b16;border:1px solid #684632;border-radius:10px;padding:16px 20px;margin:22px 0}.toc h2{margin:0 0 10px;padding:0;border:0;font-size:1.05rem;color:#e6a56e}.toc ol{margin:0;padding-left:1.2em;columns:2;column-gap:24px}.toc li{break-inside:avoid;margin:4px 0}.toc a{color:#f0c39e;text-decoration:none}.toc a:hover{text-decoration:underline}@media(max-width:600px){body{margin:20px auto;padding:16px}h1{font-size:2.35rem}.top{display:block}.actions{margin-left:0;margin-top:18px}.toc ol{columns:1}}</style><div class="top" id="top"><div><span class="pill">Guild hall · D&amp;D 5e</span><h1>GuildScribe Codex</h1><p class="intro">Welcome to the guild hall. Herein lie the rites of character, company, dice, duels, and the archives of the SRD.</p></div><div class="actions"><a class="action-button" href="/connect">Raise your banner</a><a class="action-button" href="/donate">Support the Guild</a><a class="action-button" href="/privacy">Privacy</a><a class="action-button" href="/terms">Terms</a></div></div><div class="note"><strong>Entering the hall:</strong> Grant the scribes a voice with <code>/mod GuildScribeBot</code>, then use <code>!help</code> for the welcome guide or <code>!dndbothelp</code> to browse this reference from chat.</div><nav class="toc" aria-label="Guide index"><h2>Index</h2><ol><li><a href="#parchment">Adventurer’s parchment</a></li><li><a href="#dice">Fate’s dice</a></li><li><a href="#bg3">Baldur's Gate 3</a></li><li><a href="#archives">Guild archives</a></li><li><a href="#arena">Arena, wilds &amp; the company</a></li><li><a href="#custom">Custom commands &amp; triggers</a></li><li><a href="#maps">Battle maps</a></li><li><a href="#onboarding">Onboarding and support</a></li></ol></nav><h2 id="parchment">Adventurer’s parchment</h2><div class="grid"><section class="card"><h3>Create and view</h3><span class="cmd">!newchar</span><p>Start a guided chat wizard. Reply with <code>!answer &lt;choice&gt;</code> to select a race, subrace, class, and ability scores. Use <code>!cancel</code> to abandon the wizard mid-way.</p><span class="cmd">!bg3</span><p>Rolls a random Baldur's Gate 3 style race and class, then lets you assign ability scores under BG3 point-buy rules (base 8, cap 15, 27-point budget) with <code>!answer &lt;STR&gt; &lt;DEX&gt; &lt;CON&gt; &lt;INT&gt; &lt;WIS&gt; &lt;CHA&gt;</code>. Confirm with <code>!answer yes</code> to save it as your character and get a link to its page. Use <code>!cancel</code> to abandon.</p><span class="cmd">!createchar</span><p>Immediately create a level 1 character.</p><span class="cmd">!createchar @username</span><p>Broadcaster/moderator only: create a level 1 character for someone else, such as for a viewer who can't chat directly.</p><span class="cmd">!char</span><span class="cmd">!char @username</span><p>Display your current character summary, or view another player’s saved character.</p><p class="muted">You keep exactly one active character and one saved backup per channel. If you already have an active character, <code>!createchar</code>, <code>!newchar</code>, and <code>!bg3</code> will warn you and ask you to confirm with <code>!answer yes</code> before overwriting it.</p></section><section class="card"><h3>Manage progress</h3><span class="cmd">!levelup</span><span class="cmd">!levelup +2</span><span class="cmd">!levelup -1</span><p>Adjust levels from 1 through 20. HP maximum, current HP, and proficiency are recalculated.</p><span class="cmd">!hp +5</span><span class="cmd">!hp -3</span><p>Adjust current HP within the character’s valid range.</p></section><section class="card"><h3>Save and restore</h3><span class="cmd">!savechar</span><span class="cmd">!loadchar</span><span class="cmd">!resetchar</span><p>Save a backup, restore the latest backup, or reset your character.</p></section></div><h2 id="dice">Fate’s dice</h2><section class="card"><span class="cmd">!d20</span><span class="cmd">!d20 @username</span><span class="cmd">!roll</span><span class="cmd">!r</span><p>Call upon the D20 of Fate. Use <code>!d20 @username</code> to roll for another adventurer.</p><span class="cmd">!roll NdS[+/-M]</span><p>Roll a custom dice expression, such as <code>!roll 1d20+5</code>, <code>!roll 2d6</code>, or <code>!roll 4d8-2</code>.</p><span class="cmd">!roll @username [NdS[+/-M]]</span><p>Roll on behalf of someone else in chat, such as <code>!roll @friend</code> or <code>!roll @friend 2d6+3</code>. Anyone can do this.</p><span class="cmd">!roll dex</span><span class="cmd">!roll strength</span><p>Ability saving throw. Uses your saved character's ability modifier, plus proficiency if your class is proficient in that save. Works with abbreviations (str, dex, con, int, wis, cha) or full names.</p><span class="cmd">!roll stealth</span><span class="cmd">!roll animal handling</span><p>Skill check. Uses your saved character's modifier for that skill's governing ability. Add <code>@username</code> to roll using someone else's saved character, e.g. <code>!roll @friend perception</code>.</p><span class="cmd">!roll &lt;question&gt;?</span><p>Consult fate for a yes-or-no verdict, delivered with a random D&amp;D-flavored omen (natural 20s, Augury, a beholder's judgment, the Deck of Many Things, and more). Example: <code>!roll is enya going to die this time?</code></p></section><h2 id="bg3">Baldur's Gate 3</h2><div class="grid"><section class="card"><h3>Roll a character (saved)</h3><span class="cmd">!bg3</span><p>Rolls a random BG3-style race and class, then lets you assign ability scores under BG3 point-buy rules (base 8, cap 15, 27-point budget) with <code>!answer &lt;STR&gt; &lt;DEX&gt; &lt;CON&gt; &lt;INT&gt; &lt;WIS&gt; &lt;CHA&gt;</code>. Confirm with <code>!answer yes</code> to save it as your character and get a link to its page — see <a href="#parchment">Adventurer's parchment</a> for the rest of the character commands.</p></section><section class="card"><h3>Roll a character (flavor only)</h3><span class="cmd">!bg3roll</span><p>Rolls a full BG3-flavored character in one line: race (with subrace where BG3 has one, like High Elf or Lolth-Sworn Drow), class and subclass, background, alignment, a BG3-style 27-point point-buy ability spread weighted toward the class's primary stat, and a one-line origin hook straight off the Nautiloid.</p></section><section class="card"><h3>Companion &amp; origin</h3><span class="cmd">!bg3companion</span><p>Rolls which BG3 companion you're traveling with — their role, a one-line personality blurb, and an iconic line.</p><span class="cmd">!bg3origin</span><p>Casts you as one of the six canonical BG3 Origin Characters — or the Dark Urge — for this run, with their signature hook.</p></section><section class="card"><h3>Loot &amp; camp</h3><span class="cmd">!bg3loot</span><p>Rolls a random magic item drop with a BG3-style rarity tier, from Common up through Legendary.</p><span class="cmd">!bg3camp</span><p>Rolls a random camp-night vignette featuring one of the companions.</p></section><section class="card"><h3>Knowledgebase</h3><span class="cmd">!bg3lookup &lt;name&gt;</span><p>Searches a hand-curated Baldur's Gate 3 knowledgebase — companions, origins, classes, races, locations, factions, deities, notable villains, and legendary items — and returns a short blurb with a link to <code>bg3.wiki</code>. Examples: <code>!bg3lookup astarion</code>, <code>!bg3lookup moonrise towers</code>.</p><span class="cmd">!bg3lookup &lt;category&gt; &lt;name&gt;</span><p>Narrow the search to one category, e.g. <code>!bg3lookup faction zhentarim</code> or <code>!bg3lookup location grymforge</code>. A bare <code>!bg3lookup</code> lists all recognized categories.</p></section></div><p class="muted"><code>!bg3roll</code>, <code>!bg3companion</code>, <code>!bg3origin</code>, <code>!bg3loot</code>, and <code>!bg3camp</code> are flavor rolls only — they print straight to chat and aren't saved, and none of them touch your <code>!createchar</code>/<code>!char</code> sheet. <code>!bg3</code> is different — it saves a real character (see the parchment section above). <code>!bg3lookup</code> is also different: it's a reference lookup against the static knowledgebase above, not a roll, so the same query always returns the same entry.</p><h2 id="archives">Guild archives</h2><p>Consult the SRD archives by name. Optional <code>+N</code> upcasts a spell or adds an item attack/damage bonus. Incomplete commands (e.g. bare <code>!rules</code>) return usage tips.</p><div class="grid"><section class="card"><h3>Spells, classes &amp; rules</h3><span class="cmd">!rules &lt;topic&gt;</span><span class="cmd">!rule &lt;topic&gt;</span><p>Summarize a rule (up to 3 messages) with a public link. Examples: <code>!rules magic</code>, <code>!rules combat</code>, <code>!rule advantage</code>.</p><span class="cmd">!spell &lt;spell&gt; [+N]</span><p>Shows level, school, casting details, range, duration, components, damage dice, damage type, save, area, classes, and higher-level scaling.</p><span class="cmd">!class &lt;class&gt; [+N]</span><p>Shows Hit Die, saving throws, and proficiencies.</p><span class="cmd">!feat &lt;feat&gt; [+N]</span><p>Shows prerequisites and the feat description.</p></section><section class="card"><h3>Equipment and abilities</h3><span class="cmd">!item &lt;item&gt; [+N]</span><p>Shows weapon damage, type, range, weight, cost, armor class, properties, and modifier.</p><span class="cmd">!ability &lt;ability&gt; [+N]</span><p>Shows the ability score, related skills, and description.</p></section><section class="card"><h3>Races</h3><span class="cmd">!race &lt;race&gt; [+N]</span><p>Shows ability bonuses, speed, size, languages, and racial traits.</p><span class="cmd">!subrace &lt;subrace&gt; [+N]</span><p>Shows subrace bonuses, parent race, speed, languages, and traits.</p></section><section class="card"><h3>Bestiary</h3><span class="cmd">!monster &lt;name&gt;</span><p>Shows size, type, alignment, AC, HP, speed, challenge rating, XP, and notable actions for a creature from the SRD bestiary. Example: <code>!monster goblin</code> or <code>!monster adult red dragon</code>.</p></section></div><h2 id="arena">Arena, wilds &amp; the company</h2><div class="card"><p>A moderator or the broadcaster starts and manages the encounter; any adventurer can roll their own initiative once it's started. Duels and hunts are open to any adventurer with a saved character.</p><span class="cmd">!turn start</span><span class="cmd">!turn roll</span><span class="cmd">!turn add &lt;name&gt; &lt;initiative&gt;</span><span class="cmd">!turn show</span><span class="cmd">!turn next</span><span class="cmd">!turn prev</span><span class="cmd">!turn remove &lt;name&gt;</span><span class="cmd">!turn end</span><p><code>!turn start</code> opens the roll window; players call <code>!turn roll</code> to roll 1d20 plus their character's DEX modifier for initiative (each player rolls once per encounter). Moderators can still <code>!turn add</code> monsters, NPCs, or manual scores. The tracker stores one encounter per connected channel, sorts combatants from highest to lowest initiative, shows the active combatant with an arrow, and advances the round automatically.</p><h3>Parties</h3><span class="cmd">!party create &lt;name&gt;</span><span class="cmd">!party join &lt;name&gt;</span><span class="cmd">!party invite @user [name]</span><span class="cmd">!party accept [name]</span><span class="cmd">!party decline [name]</span><span class="cmd">!party list [name]</span><p class="muted"><code>!party list</code> shows each of your companies with leader and members. An invite only adds someone once they <code>!party accept</code> it — the party name is optional if they only have one pending invite.</p><span class="cmd">!party leave &lt;name&gt;</span><span class="cmd">!party disband &lt;name&gt;</span><p>Create a party (you become leader and member), invite friends, and list rosters. Party name is optional on invite if you only belong to one party.</p><h3>Player duels &amp; hunts</h3><span class="cmd">!dndduel @user</span><span class="cmd">!dndduel classic @user</span><span class="cmd">!dndduel accept | decline | attack | status | end</span><span class="cmd">!dndduel</span><span class="cmd">!dndduel monster</span><span class="cmd">!dndduel party &lt;yours&gt; &lt;theirs&gt;</span><span class="cmd">!dndduel party classic &lt;yours&gt; &lt;theirs&gt;</span><span class="cmd">!dndduel party accept | decline | attack | status | end</span><span class="cmd">!dndduel party hunt &lt;party&gt;</span><span class="cmd">!dndduel party hunt classic &lt;party&gt;</span><span class="cmd">!dndduel party hunt attack | status | end</span><p><strong>Auto</strong> challenges resolve when accepted. <strong>Classic</strong> modes use turn-based attack. Solo <code>!dndduel</code> fights a level-scaled monster (auto); <code>!dndduel monster</code> is classic. Party hunts fight a shared monster and award XP on victory. PvP gives no XP. A pending challenge (<code>accept</code>/<code>decline</code>) expires after 5 minutes if unanswered. Any active classic duel — 1v1, party vs. party, or a hunt — auto-forfeits to the non-idle side after 10 minutes of inactivity, so a duel left mid-fight overnight won't block that channel's dueling next stream.</p></div><h2 id="custom">Custom commands &amp; triggers</h2><div class="card"><p>Broadcasters and moderators can add their own commands and passive keyword auto-responses right from chat — no code required. These share the <code>!dndbot</code> word used for bot settings below, but different subcommands, so nothing collides. <code>list</code> is open to everyone; the rest are mod/broadcaster only.</p><span class="cmd">!dndbot add &lt;name&gt; &lt;response&gt;</span><span class="cmd">!dndbot edit &lt;name&gt; &lt;response&gt;</span><span class="cmd">!dndbot remove &lt;name&gt;</span><span class="cmd">!dndbot cooldown &lt;name&gt; &lt;seconds&gt;</span><span class="cmd">!dndbot list</span><p>Creates <code>!&lt;name&gt;</code> as a new chat command. Built-in command names can't be used or overridden.</p><span class="cmd">!trigger add &lt;keyword&gt; &lt;response&gt;</span><span class="cmd">!trigger remove &lt;keyword&gt;</span><span class="cmd">!trigger cooldown &lt;keyword&gt; &lt;seconds&gt;</span><span class="cmd">!trigger list</span><p>Fires the response automatically whenever <code>&lt;keyword&gt;</code> appears in chat (no <code>!</code> needed to trigger it) — wrap multi-word keywords in quotes, e.g. <code>!trigger add "good luck" May the dice favor you!</code></p><p class="muted">Responses can use <code>{user}</code>, <code>{target}</code> (first @mention, commands only), <code>{count}</code> (times used), and <code>{random:a|b|c}</code> to pick one option at random. Each channel has a cap on the number of custom commands/triggers and a default cooldown to prevent spam.</p></div><h2 id="maps">Battle maps</h2><div class="grid"><section class="card"><h3>Create &amp; view</h3><span class="cmd">!map create &lt;name&gt; [WxH] [template]</span><p>Mod/broadcaster only. Makes a new grid map (default 10x8, up to 20x20), starting as all grass — or stamped with a template's terrain if you name one, e.g. <code>!map create tav1 tavern</code> or <code>!map create tav1 14x10 tavern</code>.</p><span class="cmd">!map list</span><span class="cmd">!map view &lt;name&gt;</span><p>List every map in the channel, or post a link to one — the map page is a live, auto-refreshing visual grid.</p><span class="cmd">!map delete &lt;name&gt;</span><span class="cmd">!map remove &lt;name&gt;</span><p>Mod/broadcaster only. Deletes the map along with its terrain and every character token on it — this can't be undone.</p></section><section class="card"><h3>Templates</h3><span class="cmd">!map templates</span><p>Lists every ready-made layout you can stamp onto a new map with <code>!map create &lt;name&gt; [WxH] &lt;template&gt;</code>. A template sets its own default size (overridable) and pre-paints walls, doors, hazards, and features — a starting point you can still touch up with <code>!map paint</code>/<code>!map fill</code> afterward.</p><ul>${renderMapTemplateList()}</ul></section><section class="card"><h3>Edit the terrain</h3><span class="cmd">!map terrains</span><p>Lists every terrain type (grass, forest, water, sand, mountain, road, floor, wall, door, trap, lava, void) — some, like water/wall/mountain/lava/void, block tokens from standing there.</p><span class="cmd">!map fill &lt;name&gt; &lt;terrain&gt;</span><p>Mod/broadcaster only. Resets the whole grid to one terrain.</p><span class="cmd">!map paint &lt;name&gt; &lt;x&gt; &lt;y&gt; &lt;terrain&gt;</span><p>Mod/broadcaster only. Sets a single cell, e.g. <code>!map paint dungeon1 4 2 wall</code>. Coordinates start at (1,1) in the top-left.</p></section><section class="card"><h3>Place &amp; move characters</h3><span class="cmd">!map addchar &lt;name&gt; [x y]</span><p>Puts your saved character on the map, at the coordinates you give or the first free cell otherwise.</p><span class="cmd">!map addchar &lt;name&gt; @user [x y]</span><p>Mod/broadcaster only: place someone else's character.</p><span class="cmd">!map move &lt;name&gt; &lt;x&gt; &lt;y&gt;</span><span class="cmd">!map move &lt;name&gt; @user &lt;x&gt; &lt;y&gt;</span><p>Move a token; the second form (moving someone else) is mod/broadcaster only.</p><span class="cmd">!map removechar &lt;name&gt; [@user]</span><p>Take a character off the map.</p></section></div><p class="muted">Map creation, terrain painting, and moving <em>someone else's</em> token are restricted to the broadcaster/moderators, the same as the rest of the guild's shared state; everyone can place and move their own character.</p><h2 id="onboarding">Onboarding and support</h2><div class="grid"><section class="card"><h3>In chat</h3><span class="cmd">!help</span><p>Welcome to the guild hall and a path to begin your legend.</p><span class="cmd">!guide</span><span class="cmd">!link</span><p>Post the Guild Codex URL in chat.</p><span class="cmd">!dndbothelp</span><p>List codex chapters.</p><p>Expand one of: <code>!dndbothelp dice</code>, <code>!dndbothelp character</code>, <code>!dndbothelp party</code>, <code>!dndbothelp combat</code>, <code>!dndbothelp lookup</code>, <code>!dndbothelp settings</code>.</p></section><section class="card"><h3>Connect and support</h3><p>Use the <a href="/">onboarding page</a> to connect a Twitch channel. After connecting, run <code>/mod GuildScribeBot</code> in that channel.</p><p>Already connected? <a href="/connect">Reconnect your channel</a> any time to grant newly requested permissions as GuildScribe gains features — safe to run repeatedly, and won't duplicate or lose your existing data.</p><p>Moderators and broadcasters: <a href="/dashboard">open the Guild Dashboard</a> to flip the bot, merchant, and chronicle modules on or off without touching chat.</p><p>Support the project through the <a href="/donate">donations page</a>.</p><p>Moderators can review recent activity for their channel with <code>!logs</code> in chat.</p></section><section class="card"><h3>Guild stewards (mod/broadcaster)</h3><span class="cmd">!dndbot on</span><span class="cmd">!dndbot off</span><span class="cmd">!dndbot status</span><span class="cmd">!dndbot leave</span><span class="cmd">!dndbot leave purge</span><p>Enable/disable the bot. The broadcaster can disconnect with <code>!dndbot leave</code>; add <code>purge</code> to delete channel data.</p><span class="cmd">!market on</span><span class="cmd">!market off</span><span class="cmd">!market status</span><p><strong>Off by default.</strong> Toggles a threadbare open-stall merchant who drops by the channel every so often (interval randomized per channel) with a one-line D&amp;D-flavored sales pitch for some cheap, secondhand good. Purely flavor — no coin, inventory, or character state involved. <code>status</code> is open to everyone; <code>on</code>/<code>off</code> are mod/broadcaster only.</p><span class="cmd">!chronicle on</span><span class="cmd">!chronicle off</span><span class="cmd">!chronicle status</span><p><strong>Off by default.</strong> When enabled, the guild scribe occasionally quotes a plain chat message back at random with a one-line D&amp;D-flavored reply. Low odds per message, a channel-wide cooldown, and a minimum-activity threshold keep it rare, not a running commentary. Bot accounts count toward that activity but are never the ones quoted. <code>status</code> is open to everyone; <code>on</code>/<code>off</code> are mod/broadcaster only.</p></section></div><p><a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a> · <a href="/donate">Support</a> · <a href="#top">Back to top</a></p><p class="muted">GuildScribe provides reference and gameplay utilities. Always verify rules, character choices, and wallet details before acting.</p>`;
}

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

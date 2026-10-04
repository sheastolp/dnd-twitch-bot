// The per-channel web dashboard page (GET /dashboard), split out of pages.ts
// to keep files well under Val Town's per-file size ceiling. Re-exported
// from pages.ts, so importers don't change.

import { escapeHtml } from "./utils.ts";
import { COMMAND_GROUPS } from "./commandgroups.ts";
import { page } from "./page_shell.ts";
import { DASH_CSS, SCROLL_CSS, SCROLL_HEAD, scrollClose, scrollOpen } from "./scroll_theme.ts";

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
  hoardEnabled: boolean;
}

function dashHidden(broadcasterId: string, key: string): string {
  return `<input type="hidden" name="channel" value="${escapeHtml(broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(key)}">`;
}

/** Switches with their own dedicated on/off (not COMMAND_GROUPS); each has a
 * #toggle-<key> anchor the guide's /dashboard/go links can land on. */
export const DEDICATED_TOGGLES = ["bot", "market", "chronicle", "autoban", "points", "npc", "npcchatter", "hoard"];
// Dashboard switches with no Guild Codex card of their own to link back to.
const NO_GUIDE_CARD = new Set(["npcchatter", "vars", "timedmsgs", "hug", "logs", "connections"]);

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
  const sub = 'Permanently bans non-mods who use a phrase on the auto-ban list (starts with "ai viewers") — same as !autoban on/off. Edit the list and ignored users under 🔨 Auto-ban words';
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
      <li><a href="#sec-commands">Custom commands</a></li>
      <li><a href="#sec-triggers">Chat triggers</a></li>
      <li><a href="#sec-timed">Timed messages</a></li>
      <li><a href="#sec-groups">Command groups</a><ul>${groupLinks}</ul></li>
    </ol>
  </nav>`;
}

function renderFeaturesSection(d: DashboardData): { switches: string; groups: string } {
  const dedicated = [
    featureToggleRow(d, "bot_on", "bot_off", "Entire bot", "Master switch — same as !dndbot on/off in chat", d.botEnabled),
    featureToggleRow(d, "market_on", "market_off", "Open-stall merchant", "Random flavor ads in chat — same as !market on/off", d.marketEnabled),
    autoBanToggleRow(d),
    featureToggleRow(d, "points_on", "points_off", "Gold, leaderboard & giveaways", "Viewers earn copper by chatting and from monster loot on hunts (10 cp = 1 sp, 10 sp = 1 gp); !gold, !gold top, !giveaway, !rob, and real coin prices for !haggle — same as !gold on/off", d.pointsEnabled),
  ].join("");
  // Chronicle and the AI NPCs have their own dedicated switches, but they
  // live in the "Chronicle, oracle & NPCs" folder beside !oracle, matching
  // the Codex section their cards are in.
  const chronicleTile = featureToggleRow(d, "chronicle_on", "chronicle_off", "Chronicle", "Occasional quote-backs of chat — same as !chronicle on/off", d.chronicleEnabled);
  const npcTiles = [
    featureToggleRow(d, "npc_on", "npc_off", "AI NPCs", "Lets viewers talk to AI-voiced NPCs with !npc talk", d.npcEnabled),
    featureToggleRow(d, "npcchatter_on", "npcchatter_off", "AI NPC chatter", "NPCs jumping into chat on their own (needs AI NPCs on too)", d.npcChatterEnabled),
  ];
  // One switch per Guild Codex card, under that card's guide section.
  const bySection = new Map<string, { rows: string[]; on: number }>();
  for (const [key, def] of Object.entries(COMMAND_GROUPS)) {
    const g = bySection.get(def.section) ?? { rows: [], on: 0 };
    const enabled = d.groupToggles[key] ?? true;
    g.rows.push(groupToggleRow(d, key, def.label, enabled));
    if (enabled) g.on++;
    bySection.set(def.section, g);
  }
  // Hunt and Hoard's master switch sits in its own folder, ahead of the
  // per-card switches (which only matter while it's on).
  const hoard = bySection.get("Hunt and Hoard");
  if (hoard) {
    hoard.rows = [featureToggleRow(d, "hoard_on", "hoard_off", "Hunt and Hoard", "The whole module — off by default; same as !hoard on/off. The switches beside it only matter while it's on", d.hoardEnabled), ...hoard.rows];
    if (d.hoardEnabled) hoard.on++;
  }
  const social = bySection.get("Chronicle, oracle & NPCs");
  if (social) {
    social.rows = [chronicleTile, ...social.rows, ...npcTiles];
    social.on += [d.chronicleEnabled, d.npcEnabled, d.npcChatterEnabled].filter(Boolean).length;
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
  const flags = [d.botEnabled, d.marketEnabled, d.autoBanEnabled, d.pointsEnabled];
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
    const enabled = Number(c.enabled ?? 1) !== 0;
    tiles.push(editorTile(id, `!${escapeHtml(c.name)}`, `used ${Number(c.uses ?? 0)}× · ${enabled ? "active" : "off"}`, enabled ? "" : "tile-paused"));
    dialogs.push(editorDialog(id, `<code>!${escapeHtml(c.name)}</code>`, `<form method="post" action="/dashboard/commands" class="row-form">
        ${dashHidden(d.broadcasterId, d.channelKey)}
        <input type="hidden" name="intent" value="save">
        <input type="hidden" name="name" value="${escapeHtml(c.name)}">
        <p class="muted">Used ${Number(c.uses ?? 0)}× — ${enabled ? "active" : "off"}</p>
        <label>Response <textarea name="response" maxlength="400" rows="4">${escapeHtml(c.response ?? "")}</textarea></label>
        <div class="row-controls">
          <label>Cooldown (s) <input type="number" name="cooldown_seconds" min="0" max="${d.maxCooldownSeconds}" value="${cooldownSeconds}"></label>
          <label class="check"><input type="checkbox" name="enabled" ${enabled ? "checked" : ""}> Active</label>
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
    const enabled = Number(t.enabled ?? 1) !== 0;
    tiles.push(editorTile(id, `“${escapeHtml(t.keyword)}”`, `used ${Number(t.uses ?? 0)}× · ${enabled ? "active" : "off"}`, enabled ? "" : "tile-paused"));
    dialogs.push(editorDialog(id, `Trigger: “${escapeHtml(t.keyword)}”`, `<form method="post" action="/dashboard/triggers" class="row-form">
        ${dashHidden(d.broadcasterId, d.channelKey)}
        <input type="hidden" name="intent" value="save">
        <input type="hidden" name="keyword" value="${escapeHtml(t.keyword)}">
        <p class="muted">Used ${Number(t.uses ?? 0)}× — ${enabled ? "active" : "off"}</p>
        <label>Response <textarea name="response" maxlength="400" rows="4">${escapeHtml(t.response ?? "")}</textarea></label>
        <div class="row-controls">
          <label>Cooldown (s) <input type="number" name="cooldown_seconds" min="0" max="${d.maxCooldownSeconds}" value="${cooldownSeconds}"></label>
          <label class="check"><input type="checkbox" name="enabled" ${enabled ? "checked" : ""}> Active</label>
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${SCROLL_HEAD}<title>${escapeHtml(d.broadcasterName)} — GuildScribe Dashboard</title><style>${SCROLL_CSS}${DASH_CSS}</style></head><body>
  ${scrollOpen("gate")}
  <span class="pill">Moderators only</span>
  <h1>${escapeHtml(d.broadcasterName)}'s Dashboard</h1>
  <p class="muted">This link is only good with a matching Twitch login — you need to be a moderator or the broadcaster of this channel.</p>
  ${gateBanner}
  <p><a class="btn" href="${d.loginUrl}">Log in with Twitch</a></p>
  ${scrollClose}
  </body></html>`;
}

export function renderDashboardPage(d: DashboardData): string {
  const features = renderFeaturesSection(d);
  const banner = d.error
    ? `<p class="banner error">${escapeHtml(d.error)}</p>`
    : d.notice
    ? `<p class="banner ok">${escapeHtml(d.notice)}</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${SCROLL_HEAD}<title>${escapeHtml(d.broadcasterName)} — GuildScribe Dashboard</title><style>${SCROLL_CSS}${DASH_CSS}</style></head><body>
  ${scrollOpen()}
  <header class="dash-head"><div><span class="pill">GuildScribe · Channel dashboard</span>
  <h1>${escapeHtml(d.broadcasterName)}'s Dashboard</h1>
  <p class="muted">Manage this channel's bot settings, custom commands, chat triggers, and timed messages. This link is private — anyone holding it can edit this channel; get a fresh one in chat with <code>!dashboard reset</code>.</p></div>
  <span class="head-links"><a class="btn ghost" href="/dashboard/botcheck?channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.channelKey)}">🤖 Bot viewer check</a><a class="btn ghost" href="/dashboard/autoban?channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.channelKey)}">🔨 Auto-ban words</a><a class="btn ghost" href="/guide" target="_blank" rel="noopener">Guild Codex ↗</a></span></header>
  ${banner}
  ${renderDashboardIndex()}
  <div class="board-row">
    ${features.switches}
    ${renderCommandsSection(d)}
    ${renderTriggersSection(d)}
    ${renderTimedMessagesSection(d)}
  </div>
  ${features.groups}
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
    // Boxes take only the height their content needs; pack them masonry-style so a short box
    // doesn't leave a gap beside a tall neighbour (same trick as the Guild Codex cards).
    var grids=[].slice.call(document.querySelectorAll(".board-row,.folders"));
    grids.forEach(function(g){var gap=parseFloat(getComputedStyle(g).rowGap)||16;[].forEach.call(g.children,function(c){c.style.marginBottom=gap+"px"});g.classList.add("masonry")});
    function lay(){grids.forEach(function(g){[].forEach.call(g.children,function(c){c.style.gridRowEnd="span "+Math.ceil((c.getBoundingClientRect().height+parseFloat(c.style.marginBottom))/4)})})}
    lay();
    if(window.ResizeObserver){var ro=new ResizeObserver(lay);grids.forEach(function(g){[].forEach.call(g.children,function(c){ro.observe(c)})})}else{window.addEventListener("resize",lay);all.forEach(function(d){d.addEventListener("toggle",lay)})}
    document.querySelectorAll("[data-all]").forEach(function(b){b.addEventListener("click",function(){var o=b.getAttribute("data-all")==="open";all.forEach(function(d){d.open=o});save()})});
    goHash();
  })();</script>
  ${scrollClose}
  </body></html>`;
}

// GuildScribe — the public /commands?channel=<id> page that !commands links to:
// this channel's own custom commands, chat triggers (customcommands.ts) and
// timed messages (timedmessages.ts), followed by every
// built-in feature the channel has switched on (COMMAND_GROUPS in
// commandgroups.ts, plus the dedicated switches). The per-channel counterpart
// of the Guild Codex (/guide), which documents everything.

import { COMMAND_GROUPS, TOGGLE_REQUIRES } from "./commandgroups.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

export interface ChannelCommandsData {
  customCommands: Array<{ name: string; response: string; uses: number }>;
  /** Enabled keyword triggers; empty when the channel's "triggers" switch is off. */
  triggers: Array<{ keyword: string; response: string; uses: number }>;
  timedMessages: Array<{ message: string; intervalMinutes: number }>;
  /** Command-group switches (db.ts getCommandGroupToggles). */
  groups: Record<string, boolean>;
  /** Dedicated switches, keyed as in DEDICATED_LABELS (points, market, npc). */
  dedicated: Record<string, boolean>;
}

/** Built-in commands that never switch off (see the commandgroups.ts header). */
const ALWAYS_ON = "Help & guides (!help, !start, !guide, !commands, !dndbothelp)";

export function renderChannelCommandsPage(channelName: string, data: ChannelCommandsData, baseUrl: string): string {
  const name = escapeHtml(channelName);
  const isOn = (key: string) => data.groups[key] ?? data.dedicated[key] ?? false;

  const custom = data.customCommands.map((c) => {
    const search = `${c.name} ${c.response}`.toLowerCase();
    return `<tr data-search="${escapeHtml(search)}"><td><code>!${escapeHtml(c.name)}</code></td>` +
      `<td class="small">${escapeHtml(c.response)}</td><td class="num">${c.uses}</td></tr>`;
  }).join("");

  const triggers = data.triggers.map((t) => {
    const search = `${t.keyword} ${t.response}`.toLowerCase();
    return `<tr data-search="${escapeHtml(search)}"><td><code>${escapeHtml(t.keyword)}</code></td>` +
      `<td class="small">${escapeHtml(t.response)}</td><td class="num">${t.uses}</td></tr>`;
  }).join("");

  const timed = data.timedMessages.map((m) => {
    const every = m.intervalMinutes % 60 === 0 ? `${m.intervalMinutes / 60} h` : `${m.intervalMinutes} min`;
    return `<tr data-search="${escapeHtml(m.message.toLowerCase())}"><td class="small">${escapeHtml(m.message)}</td>` +
      `<td class="num">every ${every}</td></tr>`;
  }).join("");

  // Built-in features: one row per switched-on group, by dashboard section.
  const sections = new Map<string, string[]>([["Getting started", [ALWAYS_ON]]]);
  const add = (section: string, label: string) => {
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push(label);
  };
  for (const [key, def] of Object.entries(COMMAND_GROUPS)) {
    if (!isOn(key) || (TOGGLE_REQUIRES[key] ?? []).some((req) => !isOn(req))) continue;
    // Groups with no chat command of their own (passive features like
    // "Earning gold" or "Ad-break alerts") aren't something to type.
    if (!def.label.includes("!")) continue;
    add(def.section, def.label);
  }
  if (data.dedicated.market) add("Gold, leaderboard & giveaways", "Peddler's stall (!stall, !haggle <pitch>, !gear)");
  if (data.dedicated.npc) add("Chronicle, oracle & NPCs", "AI NPCs (!npc)");

  const builtIn = [...sections].map(([section, labels]) =>
    labels.map((label) => {
      const search = `${section} ${label}`.toLowerCase();
      return `<tr data-search="${escapeHtml(search)}"><td class="small muted">${escapeHtml(section)}</td><td>${escapeHtml(label)}</td></tr>`;
    }).join("")
  ).join("");
  const builtInCount = [...sections.values()].reduce((n, l) => n + l.length, 0);

  const customBlock = data.customCommands.length
    ? `<div class="table-wrap"><table class="cmds"><thead><tr><th>Command</th><th>Response</th><th class="num">Uses</th></tr></thead><tbody>${custom}</tbody></table></div>`
    : `<p class="muted">This channel hasn't added any custom commands yet. Mods can add one with <code>!dndbot add &lt;name&gt; &lt;response&gt;</code>.</p>`;

  const triggerBlock = data.triggers.length
    ? `<p class="muted small">No <code>!</code> needed — the bot replies whenever one of these words or phrases shows up in chat.</p><div class="table-wrap"><table class="cmds"><thead><tr><th>Keyword</th><th>Response</th><th class="num">Uses</th></tr></thead><tbody>${triggers}</tbody></table></div>`
    : `<p class="muted">No chat triggers in this channel.</p>`;
  const timedBlock = data.timedMessages.length
    ? `<p class="muted small">Posted automatically while the stream is live.</p><div class="table-wrap"><table class="cmds"><thead><tr><th>Message</th><th class="num">Interval</th></tr></thead><tbody>${timed}</tbody></table></div>`
    : `<p class="muted">No timed messages in this channel.</p>`;

  const body =
    `<span class="pill">Commands</span><h1>${name}</h1><p class="muted">Every command you can use in this channel: its own custom commands, chat triggers and timed messages first, then the GuildScribe features switched on here. Some are mod/broadcaster only — the <a href="${baseUrl}/guide">Guild Codex</a> explains each one in full.</p>` +
    `<div class="stats"><div class="stat"><b>${data.customCommands.length}</b>custom</div><div class="stat"><b>${data.triggers.length}</b>triggers</div><div class="stat"><b>${data.timedMessages.length}</b>timed</div><div class="stat"><b>${builtInCount}</b>built-in features</div></div>` +
    `<div class="controls"><input id="q" class="search" type="search" placeholder="Search commands…" autocomplete="off" aria-label="Search commands"></div>` +
    `<h2 id="custom">Custom commands</h2>${customBlock}` +
    `<h2 id="triggers">Chat triggers</h2>${triggerBlock}` +
    `<h2 id="timed">Timed messages</h2>${timedBlock}` +
    `<h2 id="builtin">Built-in commands</h2><div class="table-wrap"><table class="cmds"><thead><tr><th>Section</th><th>Feature &amp; commands</th></tr></thead><tbody>${builtIn}</tbody></table></div>` +
    `<p class="muted small">Full details: <a href="${baseUrl}/guide">Guild Codex</a></p>` +
    `<script>(function(){var q=document.getElementById("q"),rows=[].slice.call(document.querySelectorAll("table.cmds tbody tr"));` +
    `q.addEventListener("input",function(){var t=q.value.trim().toLowerCase();rows.forEach(function(r){r.hidden=!!t&&r.getAttribute("data-search").indexOf(t)===-1})})})();</script>`;
  return scrollDoc(`${name} — Commands`, body, {
    width: 1000,
    css: `${LEDGER_CSS}table.cmds td{vertical-align:top}table.cmds td.small{word-break:break-word}`,
  });
}

export function channelCommandsUrl(baseUrl: string, broadcasterId: string): string {
  return `${baseUrl}/commands?channel=${encodeURIComponent(broadcasterId)}`;
}

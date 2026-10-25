// GuildScribe — the public /gold?channel=<id> page that !gold list links to:
// every purse in the channel, richest first, like the /roster page but for
// coin only. Its own module to keep pages.ts a manageable size.

import { formatCoins } from "./coins.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

export function renderGoldPage(
  channelName: string,
  purses: { username: string; displayName: string; balance: number }[],
  broadcasterId: string,
  baseUrl: string,
  // Lowercase usernames with a character sheet; their names link to it.
  withCharacter: Set<string> = new Set(),
  // !nick nickname per lowercase username (nick.ts).
  nicknames: Map<string, string> = new Map(),
): string {
  const name = escapeHtml(channelName);
  const total = purses.reduce((sum, p) => sum + p.balance, 0);
  const charLink = (username: string) =>
    `${baseUrl}/?user=${encodeURIComponent(username)}&channel=${encodeURIComponent(broadcasterId)}`;

  // Ties share a rank, matching !gold's "rank" (count of richer purses + 1).
  let rank = 0;
  const rows = purses
    .map((p, i) => {
      if (i === 0 || p.balance !== purses[i - 1].balance) rank = i + 1;
      const nick = nicknames.get(p.username) ?? "";
      const who = withCharacter.has(p.username)
        ? `<a href="${charLink(p.username)}">${escapeHtml(p.displayName)}</a>`
        : escapeHtml(p.displayName);
      const medal = rank === 1 ? " 🥇" : rank === 2 ? " 🥈" : rank === 3 ? " 🥉" : "";
      const search = [p.username, p.displayName, nick].join(" ").toLowerCase();
      return `<tr data-search="${escapeHtml(search)}"><td class="num">${rank}${medal}</td><td>${who}</td><td>${nick ? escapeHtml(nick) : `<span class="muted">—</span>`}</td><td class="num" data-copper="${p.balance}">${escapeHtml(formatCoins(p.balance))}</td></tr>`;
    })
    .join("");
  const table = purses.length
    ? `<div class="table-wrap"><table><thead><tr><th class="num">Rank</th><th>Adventurer</th><th>Nickname</th><th class="num">Gold</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="muted">No coin yet. Chat while the stream is live to start earning.</p>`;

  const stats = `<div class="stats"><div class="stat"><b>${purses.length}</b>purse${purses.length === 1 ? "" : "s"}</div><div class="stat"><b>${escapeHtml(formatCoins(total))}</b>in the channel</div>${purses.length ? `<div class="stat"><b>${escapeHtml(formatCoins(purses[0].balance))}</b>richest</div>` : ""}</div>`;

  return scrollDoc(`${name} — Guild Treasury`, `<span class="pill">Guild treasury</span><h1>${name}</h1><p class="muted">Every adventurer's purse, richest first. 10 cp = 1 sp, 10 sp = 1 gp.</p>${stats}<input id="q" class="search" type="search" placeholder="Search adventurers or nicknames…" autocomplete="off" aria-label="Search purses"><p id="nomatch" class="muted" hidden>No adventurers match that search.</p>${table}<p class="muted colophon">From Twitch chat: <code>!gold</code> · <code>!gold top</code> · <code>!gold give @user &lt;amount&gt;</code> · <a href="${baseUrl}/roster?channel=${encodeURIComponent(broadcasterId)}">Guild roster</a> · <a href="${baseUrl}/guide">Guild Codex</a></p><script>(function(){var q=document.getElementById("q"),none=document.getElementById("nomatch"),items=document.querySelectorAll("[data-search]");if(!q)return;q.addEventListener("input",function(){var t=q.value.trim().toLowerCase(),shown=0;items.forEach(function(el){var hit=!t||el.getAttribute("data-search").indexOf(t)!==-1;el.hidden=!hit;if(hit)shown++});none.hidden=!t||shown>0})})();</script>`, { width: 760, css: `${LEDGER_CSS}table{min-width:420px}` });
}

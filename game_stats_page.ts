// GuildScribe — /dashboard/stats, what !stats shows (game_stats.ts), behind
// the dashboard key + Twitch mod login (dashboard.ts
// handleGameStatsPage/handleGameStatsForm do the auth). Pick the game !stats
// shows, connect the Warframe account, type the stat lines for The Division 2
// and Baldur's Gate 3, and add or remove custom games.

import {
  BUILTIN_GAMES,
  CUSTOM_GAMES_MAX,
  STATS_LINE_MAX,
  WF_PLATFORMS,
  channelGames,
  customGameKey,
  fetchWarframeProfile,
  formatWarframeProfile,
  getGameStatsSettings,
  isCustomKey,
  isWfAccountId,
  listGameLines,
  removeGameLine,
  saveGameStatsSettings,
  setGameLine,
  statsText,
} from "./game_stats.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

type Result = { ok: boolean; message: string } | null;

const cleanLine = (s: string) => s.replace(/\s+/g, " ").trim();

export async function applyGameStatsForm(broadcasterId: string, form: FormData): Promise<Result> {
  const intent = String(form.get("intent") ?? "");
  const lines = await listGameLines(broadcasterId);
  const games = channelGames(lines);
  switch (intent) {
    case "active": {
      const game = games.find((g) => g.key === String(form.get("game") ?? ""));
      if (!game) return { ok: false, message: "Pick a game from the list." };
      await saveGameStatsSettings(broadcasterId, { activeGame: game.key });
      return { ok: true, message: `!stats now shows ${game.name}.` };
    }
    case "warframe": {
      const account = String(form.get("account") ?? "").trim().replace(/^"|"$/g, "");
      const platform = String(form.get("platform") ?? "pc");
      const extra = cleanLine(String(form.get("line") ?? ""));
      if (account && !isWfAccountId(account)) return { ok: false, message: "That doesn't look like a Warframe account ID — it's 24 letters and numbers, like 505875fb1a4d80894a000000." };
      if (!WF_PLATFORMS[platform]) return { ok: false, message: "Pick a platform from the list." };
      if (extra.length > STATS_LINE_MAX) return { ok: false, message: `The extra line is too long (${STATS_LINE_MAX} characters max).` };
      await saveGameStatsSettings(broadcasterId, { wfAccount: account, wfPlatform: platform });
      if (extra) await setGameLine(broadcasterId, "warframe", "Warframe", extra);
      else await removeGameLine(broadcasterId, "warframe");
      if (!account) return { ok: true, message: "Saved. Without an account ID, !stats shows only your extra line for Warframe." };
      const r = await fetchWarframeProfile(account, platform);
      return r.ok
        ? { ok: true, message: `Connected: ${formatWarframeProfile(r.profile)}` }
        : { ok: false, message: `Saved, but ${r.error}. Check the ID and platform.` };
    }
    case "line": {
      const key = String(form.get("game") ?? "");
      const game = games.find((g) => g.key === key && g.key !== "warframe");
      if (!game) return { ok: false, message: "That game isn't on the list." };
      const line = cleanLine(String(form.get("line") ?? ""));
      if (line.length > STATS_LINE_MAX) return { ok: false, message: `That line is too long (${STATS_LINE_MAX} characters max).` };
      if (line) await setGameLine(broadcasterId, game.key, game.name, line);
      else if (isCustomKey(game.key)) return { ok: false, message: "Custom games need a stat line — use Remove to delete one." };
      else await removeGameLine(broadcasterId, game.key);
      return { ok: true, message: `Saved ${game.name}'s stats.` };
    }
    case "add": {
      const name = cleanLine(String(form.get("name") ?? "")).slice(0, 40);
      const line = cleanLine(String(form.get("line") ?? ""));
      const key = customGameKey(name);
      if (key === "c_") return { ok: false, message: "Give the game a name." };
      if (!line) return { ok: false, message: "Type the stats line for the game." };
      if (line.length > STATS_LINE_MAX) return { ok: false, message: `That line is too long (${STATS_LINE_MAX} characters max).` };
      if (games.some((g) => !isCustomKey(g.key) && g.aliases.includes(key.slice(2)))) return { ok: false, message: `${name} is already on the list.` };
      if (!lines.has(key) && games.filter((g) => isCustomKey(g.key)).length >= CUSTOM_GAMES_MAX) return { ok: false, message: `That's the most custom games (${CUSTOM_GAMES_MAX}) — remove one first.` };
      await setGameLine(broadcasterId, key, name, line);
      return { ok: true, message: `Added ${name}. Chat can see it with !stats ${key.slice(2)}.` };
    }
    case "remove": {
      const key = String(form.get("game") ?? "");
      const game = games.find((g) => g.key === key && isCustomKey(g.key));
      if (!game) return { ok: false, message: "Only custom games can be removed." };
      await removeGameLine(broadcasterId, key);
      const s = await getGameStatsSettings(broadcasterId);
      if (s.activeGame === key) await saveGameStatsSettings(broadcasterId, { activeGame: "warframe" });
      return { ok: true, message: `Removed ${game.name}.${s.activeGame === key ? " !stats is back to Warframe." : ""}` };
    }
  }
  return null;
}

export async function renderGameStatsPage(d: {
  broadcasterId: string;
  broadcasterName: string;
  key: string;
  notice?: string;
  error?: string;
}): Promise<string> {
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);
  const [settings, lines] = await Promise.all([getGameStatsSettings(d.broadcasterId), listGameLines(d.broadcasterId)]);
  const games = channelGames(lines);
  const active = games.find((g) => g.key === settings.activeGame) ?? BUILTIN_GAMES[0];
  const preview = await statsText(d.broadcasterId, active.key, settings, lines);
  const lineOf = (key: string) => escapeHtml(lines.get(key)?.line ?? "");
  const form = (inner: string, cls = "") => `<form method="post" action="/dashboard/stats" class="${cls}">${hidden}${inner}</form>`;

  const picker = games.map((g) =>
    `<label class="game${g.key === active.key ? " on" : ""}"><input type="radio" name="game" value="${escapeHtml(g.key)}"${g.key === active.key ? " checked" : ""}><span>${g.emoji} ${escapeHtml(g.name)}</span></label>`
  ).join("");

  const platformOpts = Object.entries(WF_PLATFORMS).map(([k, p]) => `<option value="${k}"${k === settings.wfPlatform ? " selected" : ""}>${p.label}</option>`).join("");

  const lineCard = (key: string, label: string, emoji: string, placeholder: string, removable: boolean) =>
    `<div class="card"><h3>${emoji} ${escapeHtml(label)}${key === active.key ? ` <span class="pill small">on !stats</span>` : ""}</h3>` +
    form(`<input type="hidden" name="game" value="${escapeHtml(key)}"><textarea name="line" rows="2" maxlength="${STATS_LINE_MAX}" placeholder="${escapeHtml(placeholder)}">${lineOf(key)}</textarea><div class="row"><button type="submit" name="intent" value="line" class="ember">Save</button>${removable ? `<button type="submit" name="intent" value="remove" class="ghost">Remove</button>` : ""}</div>`) +
    `</div>`;

  const customs = games.filter((g) => isCustomKey(g.key));
  const body = `<header class="dash-top"><div><span class="pill">Game stats · !stats</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>When chat types <code>!stats</code>, GuildScribe posts your stats for the game picked below. Viewers can still ask for another game, like <code>!stats div2</code>.</p>
<h2>Show on !stats</h2>
${form(`<div class="games">${picker}</div><button type="submit" name="intent" value="active" class="ember">Switch game</button>`)}
<div class="card preview"><span class="muted small">!stats replies right now:</span><div>${escapeHtml(preview)}</div></div>
<h2>Warframe</h2>
<div class="card"><h3>🟦 Warframe profile${active.key === "warframe" ? ` <span class="pill small">on !stats</span>` : ""}</h3>
${form(`<div class="grid"><label>Account ID<input type="text" name="account" value="${escapeHtml(settings.wfAccount)}" placeholder="505875fb1a4d80894a000000" maxlength="26" autocomplete="off" spellcheck="false"></label><label>Platform<select name="platform">${platformOpts}</select></label></div><label>Extra line (optional)<input type="text" name="line" value="${lineOf("warframe")}" maxlength="${STATS_LINE_MAX}" placeholder="e.g. Main: Saryn Prime · Steel Path grind"></label><div class="row"><button type="submit" name="intent" value="warframe" class="ember">Save Warframe</button></div>`)}
<p class="muted small">Your mastery rank, hours played, missions, kills and clan are read live from your public Warframe profile (refreshed every 10 minutes). To find your account ID: sign in at warframe.com, then open <a href="https://www.warframe.com/api/user-data" target="_blank" rel="noopener">warframe.com/api/user-data</a> and copy the value after <code>"user_id":</code>. On PC it's also in <code>EE.log</code> next to "Logged in". Your profile must not be set to private.</p></div>
<h2>Other games</h2>
<p class="muted">These games have no public stats service, so type the line you want chat to see. Update it whenever your numbers change.</p>
<div class="cards">
${lineCard("div2", "The Division 2", "🟠", "e.g. SHD level 1,240 · Gear score 515 · Main build: Striker's Battlegear", false)}
${lineCard("bg3", "Baldur's Gate 3", "🐉", "e.g. Honour Mode Act 2 · Tav: Level 9 Paladin of Vengeance · 3 full runs", false)}
${customs.map((g) => lineCard(g.key, g.name, g.emoji, "Stats line", true)).join("")}
</div>
<h2>Add a game</h2>
${customs.length < CUSTOM_GAMES_MAX
    ? form(`<div class="grid"><label>Game<input type="text" name="name" maxlength="40" placeholder="e.g. Elden Ring" required></label><label>Stats line<input type="text" name="line" maxlength="${STATS_LINE_MAX}" placeholder="e.g. Level 150 · NG+3 · 412 deaths" required></label></div><div class="row"><button type="submit" name="intent" value="add" class="ember">Add game</button></div>`)
    : `<p class="note">That's the most custom games (${CUSTOM_GAMES_MAX}). Remove one to add another.</p>`}
<div class="card"><p class="muted small" style="margin:0">Chat: <code>!stats</code> · ${games.map((g) => `<code>!stats ${escapeHtml(g.aliases[0])}</code>`).join(" · ")}</p></div>`;

  return scrollDoc(`${name} — Game stats`, body, {
    width: 1000,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}.games{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 14px}.game{display:flex;align-items:center;gap:8px;border:1px solid var(--rule);border-radius:999px;padding:6px 14px;cursor:pointer}.game.on,.game:has(input:checked){border-color:currentColor;font-weight:600}.game input{margin:0}.card{margin-top:16px}.card h3{margin:0 0 10px}.preview div{margin-top:4px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:0 16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px}label:not(.game){display:block;margin-bottom:10px}label:not(.game) input,label select,textarea{display:block;width:100%;box-sizing:border-box;margin-top:4px}.row{display:flex;gap:10px;flex-wrap:wrap}.pill.small{font-size:.7rem;vertical-align:middle}`,
  });
}

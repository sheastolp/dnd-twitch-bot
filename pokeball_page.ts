// GuildScribe — /dashboard/pokeballs, the Pokéball advisor's ball list
// (pokeball.ts), behind the dashboard key + Twitch mod login (dashboard.ts
// handlePokeballPage/handlePokeballForm do the auth). Mods teach balls
// chat asked about, add their own, edit or turn off the core ones — the
// way the bestiary has core and learned monsters.

import {
  type Ball,
  BALL_RULES,
  type BallRule,
  ballKey,
  deleteBall,
  isCoreBall,
  isPokeballEnabled,
  listBalls,
  POKEMON_TYPES,
  saveBall,
  setBallStatus,
  setPokeballEnabled,
} from "./pokeball_db.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

const NAME_RE = /^[A-Za-zÀ-ÿ0-9' -]{2,30}$/;

/** What the rule means for this ball, in a few words. */
export function describeRule(b: Pick<Ball, "rule" | "value">): string {
  switch (b.rule) {
    case "types": return `vs ${b.value.split(/[\s,]+/).filter(Boolean).map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(", ")} types`;
    case "heavy": return `vs Pokémon ${b.value} kg+`;
    case "fast": return `vs base Speed ${b.value}+`;
    case "hardcatch": return `vs catch rate ${b.value} or lower`;
    case "easycatch": return `vs catch rate ${b.value} or higher`;
    default: return BALL_RULES[b.rule].label;
  }
}

type Result = { ok: boolean; message: string; edit?: string } | null;

/** Check and normalize the add/edit form. */
function readBall(form: FormData): { ball?: Omit<Ball, "origin" | "seen" | "askedBy" | "updatedAt">; error?: string } {
  const name = String(form.get("name") ?? "").trim().replace(/\s+/g, " ");
  if (!NAME_RE.test(name)) return { error: "Give the ball a name of 2–30 letters, e.g. Dusk Ball." };
  const key = ballKey(name);
  if (key.length < 5) return { error: "That name is too short." };
  const rule = String(form.get("rule") ?? "") as BallRule;
  if (!(rule in BALL_RULES) || rule === "unknown") return { error: "Pick what the ball is good for." };
  let value = String(form.get("value") ?? "").trim().toLowerCase();
  if (rule === "types") {
    const types = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
    const bad = types.filter((t) => !POKEMON_TYPES.includes(t));
    if (!types.length) return { error: "List the types it's good against, e.g. dark, ghost." };
    if (bad.length) return { error: `"${bad[0]}" isn't a Pokémon type. Types: ${POKEMON_TYPES.join(", ")}.` };
    value = types.join(",");
  } else if (BALL_RULES[rule].value) {
    const n = Number(value);
    const max = rule === "heavy" ? 1000 : 255;
    if (!value || !Number.isFinite(n) || n < 0 || n > max) return { error: `${BALL_RULES[rule].value}: enter a number from 0 to ${max}.` };
    value = String(n);
  } else {
    value = "";
  }
  const mult = Number(String(form.get("mult") ?? "").trim() || "1");
  if (!Number.isFinite(mult) || mult <= 0 || mult > 255) return { error: "The multiplier must be a number above 0 and up to 255 (1 = Poké Ball)." };
  const note = String(form.get("note") ?? "").trim().slice(0, 120);
  return { ball: { key, name, rule, value, mult: Math.round(mult * 100) / 100, note, status: "active" } };
}

export async function applyPokeballForm(broadcasterId: string, form: FormData): Promise<Result> {
  const intent = String(form.get("intent") ?? "");
  const key = ballKey(String(form.get("ball") ?? ""));
  if (intent === "module_on" || intent === "module_off") {
    await setPokeballEnabled(broadcasterId, intent === "module_on");
    return { ok: true, message: `Pokéball advisor turned ${intent === "module_on" ? "on" : "off"}.` };
  }
  if (intent === "save") {
    const { ball, error } = readBall(form);
    if (!ball) return { ok: false, message: error!, edit: key || undefined };
    // Renamed while editing? The old entry goes, unless it's a core ball (those stay).
    if (key && key !== ball.key && !isCoreBall(key)) await deleteBall(broadcasterId, key);
    await saveBall(broadcasterId, ball);
    return { ok: true, message: `Saved the ${ball.name}.` };
  }
  if (!key) return null;
  if (intent === "off" || intent === "on") {
    return (await setBallStatus(broadcasterId, key, intent === "on" ? "active" : "off"))
      ? { ok: true, message: intent === "on" ? "Ball turned back on." : "Ball turned off — the advisor won't suggest it." }
      : { ok: false, message: "That ball isn't on the list." };
  }
  if (intent === "delete") {
    const core = isCoreBall(key);
    return (await deleteBall(broadcasterId, key))
      ? { ok: true, message: core ? "Back to the built-in settings for that ball." : "Ball removed." }
      : { ok: false, message: "Nothing to remove." };
  }
  return null;
}

export async function renderPokeballPage(d: {
  broadcasterId: string;
  broadcasterName: string;
  key: string;
  notice?: string;
  error?: string;
  edit?: string;
}): Promise<string> {
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const btn = (intent: string, label: string, ballKeyValue = "", cls = "ghost") =>
    `<form method="post" action="/dashboard/pokeballs" class="inline">${hidden}<input type="hidden" name="intent" value="${intent}">${ballKeyValue ? `<input type="hidden" name="ball" value="${escapeHtml(ballKeyValue)}">` : ""}<button type="submit" class="${cls}">${label}</button></form>`;
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const editLink = (k: string, label: string) => `<a class="btn ghost small-btn" href="/dashboard/pokeballs?${qs}&edit=${encodeURIComponent(k)}#edit">${label}</a>`;
  const name = escapeHtml(d.broadcasterName);
  const [balls, on] = await Promise.all([listBalls(d.broadcasterId), isPokeballEnabled(d.broadcasterId)]);
  const pending = balls.filter((b) => b.status === "pending").sort((a, b) => b.seen - a.seen);
  const known = balls.filter((b) => b.status !== "pending");
  const editing = d.edit ? balls.find((b) => b.key === d.edit) : undefined;
  const fmtDate = (t: number) => (t ? new Date(t).toISOString().slice(0, 10) : "");

  const pendingRows = pending.map((b) =>
    `<tr><td><strong>${escapeHtml(b.name)}</strong><div class="muted small"><code>!pokecatch ${escapeHtml(b.key)}</code></div></td>` +
    `<td class="num">${b.seen}</td><td class="small">${b.askedBy ? escapeHtml(b.askedBy) : `<span class="muted">—</span>`}</td><td class="num small">${fmtDate(b.updatedAt)}</td>` +
    `<td class="num">${editLink(b.key, "Teach")} ${btn("delete", "Dismiss", b.key)}</td></tr>`
  ).join("");

  const origin = (b: Ball) =>
    b.origin === "core" ? `<span class="badge">core</span>` : b.origin === "override" ? `<span class="badge learned">core · edited</span>` : `<span class="badge learned">added</span>`;
  const knownRows = known.map((b) => {
    const search = [b.name, b.key, describeRule(b), b.note, b.origin, b.status].join(" ").toLowerCase();
    const actions = [
      editLink(b.key, "Edit"),
      b.status === "off" ? btn("on", "Turn on", b.key, "ember") : btn("off", "Turn off", b.key),
      b.origin === "custom" ? btn("delete", "Delete", b.key) : b.origin === "override" ? btn("delete", "Reset", b.key) : "",
    ].join(" ");
    return `<tr data-search="${escapeHtml(search)}"${b.status === "off" ? ` class="off"` : ""}><td><strong>${escapeHtml(b.name)}</strong><div class="muted small"><code>!pokecatch ${escapeHtml(b.key)}</code></div></td>` +
      `<td>${escapeHtml(describeRule(b))}</td><td class="num">${b.mult}×</td><td class="small">${b.note ? escapeHtml(b.note) : `<span class="muted">—</span>`}</td>` +
      `<td>${origin(b)}${b.status === "off" ? ` <span class="badge">off</span>` : ""}</td><td class="num actions">${actions}</td></tr>`;
  }).join("");

  // Add / edit form. Teaching a pending ball starts from its name with no rule picked.
  const f = editing ?? { key: "", name: "", rule: "always" as BallRule, value: "", mult: 1, note: "", status: "active" };
  const ruleOptions = (Object.keys(BALL_RULES) as BallRule[]).filter((r) => r !== "unknown")
    .map((r) => `<option value="${r}"${f.rule === r ? " selected" : ""}>${escapeHtml(BALL_RULES[r].label)}${BALL_RULES[r].value ? ` — ${escapeHtml(BALL_RULES[r].value!)}` : ""}</option>`).join("");
  const formTitle = !editing ? "Add a ball" : editing.status === "pending" ? `Teach the ${escapeHtml(editing.name)}` : `Edit the ${escapeHtml(editing.name)}`;
  const form = `<form method="post" action="/dashboard/pokeballs" class="ballform" id="edit">${hidden}<input type="hidden" name="intent" value="save"><input type="hidden" name="ball" value="${escapeHtml(f.key)}">
<label>Name<input type="text" name="name" value="${escapeHtml(f.name)}" placeholder="Dusk Ball" required maxlength="30"></label>
<label>Good for<select name="rule" id="rule">${f.rule === "unknown" ? `<option value="" selected disabled>Pick one…</option>` : ""}${ruleOptions}</select></label>
<label id="valwrap">Value<input type="text" name="value" id="value" value="${escapeHtml(f.value)}" placeholder="dark, ghost"></label>
<label>Catch multiplier<input type="number" name="mult" value="${f.mult}" min="0.1" max="255" step="0.1" required><span class="muted small">1 = Poké Ball, 1.5 = Great, 2 = Ultra, 3.5 = Net Ball on Water/Bug</span></label>
<label>Note <span class="muted small">(optional — shown in chat for timing balls)</span><input type="text" name="note" value="${escapeHtml(f.note)}" maxlength="120" placeholder="Best thrown right away."></label>
<div class="row"><button type="submit" class="ember">${editing ? "Save" : "Add ball"}</button>${editing ? ` <a class="btn ghost" href="/dashboard/pokeballs?${qs}">Cancel</a>` : ""}</div></form>
<p class="muted small">Pokémon types: ${POKEMON_TYPES.join(", ")}.</p>
<script>(function(){var r=document.getElementById("rule"),w=document.getElementById("valwrap"),v=document.getElementById("value"),hint=${JSON.stringify(Object.fromEntries(Object.entries(BALL_RULES).map(([k, x]) => [k, x.value ?? ""])))};function upd(){var h=hint[r.value]||"";w.hidden=!h;v.placeholder=h;v.required=!!h}r.addEventListener("change",upd);upd()})();</script>`;

  const body = `<header class="dash-top"><div><span class="pill">Pokéball advisor · Balls</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>When <strong>PokemonCommunityGame</strong> spawns a Pokémon, GuildScribe looks it up (types, weight, speed, catch rate, legendary) and suggests the ball to throw from this list. Core balls are built in; you can add the balls your game has, edit any of them, or turn some off.</p>
<div class="controls">${on ? btn("module_off", "Turn off") : btn("module_on", "Turn on", "", "ember")}<span>${on ? "<strong>On</strong> — suggesting a ball for every spawn while you're live." : "<strong>Off</strong> — same as <code>!ball on</code> in chat."}</span></div>
<h2>Balls chat asked about</h2>
${pending.length
    ? `<p class="muted">Balls a viewer threw (<code>!pokecatch …</code>) or PokemonCommunityGame mentioned that GuildScribe doesn't know. Teach one and it joins the list below.</p><div class="table-wrap"><table><thead><tr><th>Ball</th><th class="num">Seen</th><th>First used by</th><th class="num">Since</th><th></th></tr></thead><tbody>${pendingRows}</tbody></table></div>`
    : `<p class="note">None — every ball chat has used is on the list.</p>`}
<h2>${formTitle}</h2>
${form}
<h2>Known balls</h2>
<div class="stats"><div class="stat"><b>${known.filter((b) => b.status === "active").length}</b>in use</div><div class="stat"><b>${known.filter((b) => b.origin === "core").length + known.filter((b) => b.origin === "override").length}</b>core</div><div class="stat"><b>${known.filter((b) => b.origin === "custom").length}</b>added</div><div class="stat"><b>${pending.length}</b>unknown</div></div>
<div class="controls"><input id="q" class="search" type="search" placeholder="Search balls…" autocomplete="off" aria-label="Search balls"></div>
<div class="table-wrap"><table id="t"><thead><tr><th>Ball</th><th>Good for</th><th class="num">Multiplier</th><th>Note</th><th>Origin</th><th></th></tr></thead><tbody>${knownRows}</tbody></table></div>
<div class="card"><h2 style="margin-top:0">How the advisor picks</h2>
<p>Of the balls whose “good for” fits the Pokémon, it suggests the <strong>weakest one that still gives a good chance</strong> (catch rate × multiplier at least 60% of 255), so your good balls are kept for hard catches. If none gets there, the strongest one. Balls of 100× or more are only suggested for legendaries. The strongest timing ball is offered as the alternative.</p>
<p class="muted small">Chat: <code>!ball on|off|status</code> (mods) · <code>!ball &lt;Pokémon&gt;</code> asks for a suggestion · <code>!ball balls</code> · <code>!ball unknown</code></p></div>
<script>(function(){var q=document.getElementById("q"),rows=[].slice.call(document.querySelectorAll("#t tbody tr"));q.addEventListener("input",function(){var t=q.value.trim().toLowerCase();rows.forEach(function(r){r.hidden=!!t&&r.getAttribute("data-search").indexOf(t)===-1})})})();</script>`;

  return scrollDoc(`${name} — Pokéballs`, body, {
    width: 1100,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}form.inline{display:inline;margin:0}form.inline button,.small-btn{padding:5px 12px;font-size:.78rem}.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:12px 0}.badge{white-space:nowrap}td{vertical-align:middle}td.actions,td code{white-space:nowrap}tr.off td{opacity:.55}.ballform{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 16px;margin:12px 0}.ballform label{display:flex;flex-direction:column;gap:4px}.ballform .row{grid-column:1/-1}.card{margin-top:22px}`,
  });
}

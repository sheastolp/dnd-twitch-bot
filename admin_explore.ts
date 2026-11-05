// GuildScribe — operator explorer: GET /admin/explore?key=<ADMIN_API_SECRET>
//
// One read-only page for looking around the bot's saved data:
//   - no channel:        every channel the bot knows, with counts, plus a
//                        person search across all channels
//   - ?channel=<id>:     that channel's maps, roster (characters, parties,
//                        nicknames, gold), documents (quotes, reply pages)
//                        and every viewer the bot has saved anything about
//   - &user=<login>:     everything saved about one person — every table
//                        with a username-like column, found from the schema
//                        at request time, so new features show up here
//                        without touching this file
//   - ?user= only:       the same, across every channel
//
// Same gate as /admin/logs (Bearer header or ?key=, hand-decoded so a "+" in
// the secret survives). Tables and columns that hold credentials (tokens,
// OAuth state, dashboard keys, secrets) are never shown.

import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";
import { sqlite } from "./sqlite.ts";
import { escapeHtml } from "./utils.ts";
import { PUBLIC_BASE_URL } from "./config.ts";
import { formatCoins } from "./coins.ts";

/** Columns that name a viewer, most specific first. */
const USER_COLUMNS = ["username", "user_login", "login", "chatter", "owner_key", "user", "viewer", "player", "created_by", "added_by"];
/** Tables and columns never shown: they hold credentials. */
const SECRET_NAME = /token|secret|oauth|password|dashboard_key|api_key|^key$|_key$|refresh|access/i;
/** The broadcasters table carries tokens; channels are listed from it by hand instead. */
const SKIP_TABLES = new Set(["broadcasters", "sqlite_sequence", "schema_meta"]);
const ROW_LIMIT = 200;

type TableInfo = { name: string; columns: string[]; userCol: string | null; hasChannel: boolean };

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function listTables(): Promise<TableInfo[]> {
  const res = await sqlite.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", []);
  const out: TableInfo[] = [];
  for (const r of res.rows as any[]) {
    const name = String(r.name);
    if (SKIP_TABLES.has(name) || name.startsWith("sqlite_") || SECRET_NAME.test(name)) continue;
    const cols = await sqlite.execute(`SELECT name FROM pragma_table_info(?)`, [name]);
    const columns = (cols.rows as any[]).map((c) => String(c.name));
    const userCol = USER_COLUMNS.find((u) => columns.includes(u)) ?? null;
    out.push({ name, columns, userCol, hasChannel: columns.includes("broadcaster_id") });
  }
  return out;
}

function fmtValue(col: string, v: unknown): string {
  if (v === null || v === undefined) return `<span class="small">—</span>`;
  if (SECRET_NAME.test(col)) return `<span class="small">(hidden)</span>`;
  const s = String(v);
  // Millisecond timestamps read better as dates.
  if (/(_at|^at|_seen|time)$/i.test(col) && /^\d{12,13}$/.test(s)) {
    return `<span title="${s}">${escapeHtml(new Date(Number(s)).toISOString().replace("T", " ").slice(0, 16))}</span>`;
  }
  if ((s.startsWith("{") || s.startsWith("[")) && s.length > 2) {
    try {
      const pretty = JSON.stringify(JSON.parse(s), null, 2);
      return `<details><summary>JSON (${s.length} chars)</summary><pre>${escapeHtml(pretty)}</pre></details>`;
    } catch { /* not JSON */ }
  }
  if (s.length > 160) return `<details><summary>${escapeHtml(s.slice(0, 120))}…</summary><pre>${escapeHtml(s)}</pre></details>`;
  return escapeHtml(s);
}

function table(columns: string[], rows: any[], opts: { link?: (r: any) => string | null } = {}): string {
  if (!rows.length) return `<p class="small">Nothing saved.</p>`;
  const head = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("") + (opts.link ? "<th></th>" : "");
  const body = rows.map((r) => {
    const link = opts.link?.(r);
    return `<tr>${columns.map((c) => `<td>${fmtValue(c, r[c])}</td>`).join("")}${opts.link ? `<td>${link ?? ""}</td>` : ""}</tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

async function rows(sql: string, args: unknown[] = []): Promise<any[]> {
  try {
    return (await sqlite.execute(sql, args)).rows as any[];
  } catch (e) {
    console.error("admin explore query failed", sql, e);
    return [];
  }
}

async function channelName(id: string): Promise<string> {
  const [b] = await rows("SELECT login, display_name FROM broadcasters WHERE broadcaster_id = ?", [id]);
  return String(b?.display_name || b?.login || id);
}

// ── Pages ──

async function renderChannels(k: (p: Record<string, string>) => string): Promise<string> {
  const channels = await rows(
    `SELECT b.broadcaster_id, b.login, b.display_name, b.connected,
       (SELECT COUNT(*) FROM characters c WHERE c.broadcaster_id = b.broadcaster_id) AS characters,
       (SELECT COUNT(*) FROM maps m WHERE m.broadcaster_id = b.broadcaster_id) AS maps
     FROM broadcasters b ORDER BY b.connected DESC, characters DESC, b.login ASC`,
  );
  const list = channels.map((c) =>
    `<tr><td><a href="${k({ channel: String(c.broadcaster_id) })}">${escapeHtml(String(c.display_name || c.login || c.broadcaster_id))}</a></td>` +
    `<td><code>${escapeHtml(String(c.broadcaster_id))}</code></td><td>${Number(c.connected) === 1 ? "yes" : "no"}</td>` +
    `<td class="num">${Number(c.characters)}</td><td class="num">${Number(c.maps)}</td></tr>`
  ).join("");
  return `<h1>Explorer</h1>
  <p class="lede">Pick a channel to see its maps, roster and documents, or look a person up across every channel.</p>
  ${personSearch(k, "")}
  <h2>Channels (${channels.length})</h2>
  <div class="table-wrap"><table><thead><tr><th>Channel</th><th>ID</th><th>Connected</th><th class="num">Characters</th><th class="num">Maps</th></tr></thead><tbody>${list || `<tr><td colspan="5">No channels yet.</td></tr>`}</tbody></table></div>`;
}

function personSearch(k: (p: Record<string, string>) => string, channel: string): string {
  const hidden = new URL(k(channel ? { channel } : {}), "http://x").searchParams;
  return `<form class="controls" method="get" action="/admin/explore">
    ${[...hidden].map(([n, v]) => `<input type="hidden" name="${escapeHtml(n)}" value="${escapeHtml(v)}">`).join("")}
    <input class="search" type="search" name="user" placeholder="Twitch login, e.g. tobinashby" autocomplete="off" required>
    <button type="submit">View person${channel ? "" : " (all channels)"}</button>
  </form>`;
}

async function renderChannel(id: string, k: (p: Record<string, string>) => string): Promise<string> {
  const name = await channelName(id);
  const ch = encodeURIComponent(id);
  const [maps, characters, parties, nicks, purses, quotes, replies] = await Promise.all([
    rows("SELECT map_name, width, height, default_terrain, created_by FROM maps WHERE broadcaster_id = ? ORDER BY map_name", [id]),
    rows("SELECT * FROM characters WHERE broadcaster_id = ? ORDER BY username LIMIT 1000", [id]),
    rows("SELECT party_name, username FROM party_members WHERE broadcaster_id = ? ORDER BY party_name, username", [id]),
    rows("SELECT username, nickname FROM viewer_nicknames WHERE broadcaster_id = ?", [id]),
    rows("SELECT * FROM points_balances WHERE broadcaster_id = ?", [id]),
    rows("SELECT quote_no, text, game, added_by, created_at FROM quotes WHERE broadcaster_id = ? ORDER BY quote_no DESC LIMIT ?", [id, ROW_LIMIT]),
    rows("SELECT owner_key, owner_name, id, updated_at FROM reply_links WHERE broadcaster_id = ? ORDER BY updated_at DESC LIMIT ?", [id, ROW_LIMIT]),
  ]);
  const nickBy = new Map(nicks.map((n) => [String(n.username).toLowerCase(), String(n.nickname)]));
  const goldBy = new Map(purses.map((p) => [String(p.username).toLowerCase(), Number(p.balance ?? 0)]));

  const sheet = (c: any) => ({
    race: [c.subrace && c.subrace !== c.race ? c.subrace : "", c.race].filter(Boolean).join(" "),
    cls: c.class ?? "",
    level: c.level ?? "",
    hp: c.hp_current != null ? `${c.hp_current}/${c.hp_max}` : "",
  });
  const rosterRows = characters.map((c) => {
    const u = String(c.username);
    const s = sheet(c);
    return `<tr><td><a href="${k({ channel: id, user: u })}">${escapeHtml(u)}</a></td><td>${escapeHtml(nickBy.get(u.toLowerCase()) ?? "")}</td>` +
      `<td>${escapeHtml(`${s.race} ${s.cls}`.trim())}</td><td class="num">${escapeHtml(String(s.level))}</td><td class="num">${escapeHtml(s.hp)}</td>` +
      `<td class="num">${goldBy.has(u.toLowerCase()) ? formatCoins(goldBy.get(u.toLowerCase())!) : ""}</td>` +
      `<td><a href="${PUBLIC_BASE_URL}/?user=${encodeURIComponent(u)}&channel=${ch}" target="_blank" rel="noopener">sheet</a></td></tr>`;
  }).join("");

  const partyMap = new Map<string, string[]>();
  for (const p of parties) partyMap.set(String(p.party_name), [...(partyMap.get(String(p.party_name)) ?? []), String(p.username)]);
  const partyList = [...partyMap].map(([p, members]) =>
    `<li><span class="who">${escapeHtml(p)}</span> ${members.map((m) => `<a href="${k({ channel: id, user: m })}">${escapeHtml(m)}</a>`).join(", ")}</li>`
  ).join("");

  // Everyone with any saved row in this channel, from every per-viewer table.
  const tables = await listTables();
  const people = new Map<string, number>();
  for (const t of tables) {
    if (!t.userCol || !t.hasChannel) continue;
    for (const r of await rows(`SELECT LOWER(${q(t.userCol)}) AS u, COUNT(*) AS n FROM ${q(t.name)} WHERE broadcaster_id = ? GROUP BY LOWER(${q(t.userCol)})`, [id])) {
      if (!r.u || !/^[a-z0-9_]{1,25}$/.test(String(r.u))) continue;
      people.set(String(r.u), (people.get(String(r.u)) ?? 0) + Number(r.n));
    }
  }
  const peopleList = [...people].sort((a, b) => b[1] - a[1]).map(([u, n]) =>
    `<a class="badge" href="${k({ channel: id, user: u })}">${escapeHtml(u)} · ${n}</a>`
  ).join(" ");

  return `<h1>${escapeHtml(name)}</h1>
  <p><a href="${k({})}">← All channels</a> · Public pages:
    <a href="${PUBLIC_BASE_URL}/roster?channel=${ch}" target="_blank" rel="noopener">roster</a> ·
    <a href="${PUBLIC_BASE_URL}/maps?channel=${ch}" target="_blank" rel="noopener">maps</a> ·
    <a href="${PUBLIC_BASE_URL}/quotes?channel=${ch}" target="_blank" rel="noopener">quotes</a> ·
    <a href="${PUBLIC_BASE_URL}/gold?channel=${ch}" target="_blank" rel="noopener">gold</a> ·
    <a href="${PUBLIC_BASE_URL}/gear?channel=${ch}" target="_blank" rel="noopener">gear</a> ·
    <a href="${PUBLIC_BASE_URL}/bestiary?channel=${ch}" target="_blank" rel="noopener">bestiary</a></p>
  <div class="stats"><div class="stat"><b>${characters.length}</b>characters</div><div class="stat"><b>${partyMap.size}</b>parties</div><div class="stat"><b>${maps.length}</b>maps</div><div class="stat"><b>${quotes.length}</b>quotes</div><div class="stat"><b>${people.size}</b>people with saved info</div></div>
  <h2>People</h2>
  ${personSearch(k, id)}
  <p>${peopleList || `<span class="small">Nobody yet.</span>`}</p>
  <h2>Maps</h2>
  ${table(["map_name", "width", "height", "default_terrain", "created_by"], maps, {
    link: (m) => `<a href="${PUBLIC_BASE_URL}/map?channel=${ch}&map=${encodeURIComponent(String(m.map_name))}" target="_blank" rel="noopener">view</a>`,
  })}
  <h2>Roster</h2>
  <div class="table-wrap"><table><thead><tr><th>Login</th><th>Nickname</th><th>Character</th><th class="num">Lv</th><th class="num">HP</th><th class="num">Gold</th><th></th></tr></thead><tbody>${rosterRows || `<tr><td colspan="7">No characters.</td></tr>`}</tbody></table></div>
  <h3>Parties</h3>
  ${partyList ? `<ul class="list">${partyList}</ul>` : `<p class="small">No parties.</p>`}
  <h2>Documents</h2>
  <h3>Reply pages</h3>
  ${table(["owner_name", "owner_key", "updated_at"], replies, {
    link: (r) => `<a href="${PUBLIC_BASE_URL}/r/${encodeURIComponent(String(r.id))}" target="_blank" rel="noopener">open</a>`,
  })}
  <h3>Quotes</h3>
  ${table(["quote_no", "text", "game", "added_by", "created_at"], quotes)}`;
}

async function renderPerson(user: string, channel: string | null, k: (p: Record<string, string>) => string): Promise<string> {
  const tables = await listTables();
  const sections: string[] = [];
  let total = 0;
  for (const t of tables) {
    if (!t.userCol) continue;
    const where = `LOWER(${q(t.userCol)}) = ?` + (channel && t.hasChannel ? " AND broadcaster_id = ?" : "");
    const args: unknown[] = channel && t.hasChannel ? [user, channel] : [user];
    // Without a channel filter, a table with no broadcaster_id is shared
    // across channels; with one, it still applies to this person.
    const found = await rows(`SELECT * FROM ${q(t.name)} WHERE ${where} LIMIT ?`, [...args, ROW_LIMIT]);
    if (!found.length) continue;
    total += found.length;
    const cols = t.columns.filter((c) => !SECRET_NAME.test(c));
    sections.push(`<h3>${escapeHtml(t.name)} <span class="badge">${found.length}${found.length === ROW_LIMIT ? "+" : ""}</span></h3>${
      table(cols, found, {
        link: t.name === "characters" || t.name === "reply_links"
          ? (r) => t.name === "characters"
            ? `<a href="${PUBLIC_BASE_URL}/?user=${encodeURIComponent(user)}&channel=${encodeURIComponent(String(r.broadcaster_id))}" target="_blank" rel="noopener">sheet</a>`
            : `<a href="${PUBLIC_BASE_URL}/r/${encodeURIComponent(String(r.id))}" target="_blank" rel="noopener">open</a>`
          : undefined,
      })
    }`);
  }
  const where = channel ? await channelName(channel) : "every channel";
  return `<h1>${escapeHtml(user)}</h1>
  <p><a href="${k({})}">← All channels</a>${channel ? ` · <a href="${k({ channel })}">← ${escapeHtml(where)}</a> · <a href="${k({ user })}">This person in every channel</a>` : ""}</p>
  <p class="lede">Everything saved about <b>${escapeHtml(user)}</b> in ${escapeHtml(where)}: ${total} row${total === 1 ? "" : "s"} across ${sections.length} table${sections.length === 1 ? "" : "s"}. Rows keyed by Twitch user id (like whisper preferences) aren't matched by login.</p>
  ${personSearch(k, channel ?? "")}
  ${sections.join("") || `<p>Nothing saved under that login.</p>`}`;
}

/** Handles GET /admin/explore; null for any other path. */
export async function handleAdminExploreRoute(req: Request, url: URL, path: string): Promise<Response | null> {
  if (req.method !== "GET" || path !== "/admin/explore") return null;
  const secret = Deno.env.get("ADMIN_API_SECRET");
  const auth = req.headers.get("Authorization") ?? "";
  const keyMatch = url.search.slice(1).match(/(?:^|&)key=([^&]*)/);
  const keyParam = keyMatch ? decodeURIComponent(keyMatch[1]) : "";
  if (!secret || secret.length < 32 || (auth !== `Bearer ${secret}` && keyParam !== secret)) {
    return new Response("Unauthorized. Append ?key=<ADMIN_API_SECRET> to the URL.", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const k = (p: Record<string, string>) => {
    const s = new URLSearchParams(p);
    if (keyParam) s.set("key", keyParam);
    return `/admin/explore?${s}`;
  };
  const channel = url.searchParams.get("channel")?.trim() || null;
  const user = url.searchParams.get("user")?.trim().replace(/^@/, "").toLowerCase() || null;
  if (channel && !/^\d+$/.test(channel)) return new Response("Invalid channel.", { status: 400 });
  if (user && !/^[a-z0-9_]{1,25}$/.test(user)) return new Response("Invalid login.", { status: 400 });

  const body = user ? await renderPerson(user, channel, k) : channel ? await renderChannel(channel, k) : await renderChannels(k);
  const nav = `<p class="small"><a href="/admin/logs${keyParam ? `?key=${encodeURIComponent(keyParam)}` : ""}">Logs</a> · <a href="/admin/channels${keyParam ? `?key=${encodeURIComponent(keyParam)}` : ""}">Channel connections</a> · <a href="${k({})}">Explorer</a></p>`;
  const css = LEDGER_CSS + `pre{white-space:pre-wrap;word-break:break-word;font-size:.8rem;margin:6px 0 0}details summary{cursor:pointer}td{font-size:.9rem}h3{margin-top:22px}a.badge{text-decoration:none;margin:2px 0}`;
  return new Response(scrollDoc("GuildScribe Explorer", nav + body, { width: 1240, css }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

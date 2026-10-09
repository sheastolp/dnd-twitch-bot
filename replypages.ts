// Reply pages: each viewer's recent replies from the bot.
//
// Every reply to someone's !command is logged on their page. When a reply
// would take more than one chat message, chat gets a one-message summary
// ending in a link to GET /r/<id> instead (the whole battle log for fights —
// see sendChatMessages in twitch.ts); one-message replies are posted as usual
// and logged too.
//
// Each viewer has ONE page per channel: the first reply logged for them mints
// a random, unguessable id, and the link always shows their latest replies
// (newest first, up to MAX_ENTRIES). Long replies with no particular viewer
// (timed messages, merchant posts) share one channel page. Replies older than
// REPLY_PAGE_TTL_MS are dropped, but the link itself is kept for the next one.

import { scrollDoc } from "./scroll_theme.ts";
import { sqlite } from "./sqlite.ts";
import { PUBLIC_BASE_URL } from "./config.ts";

const REPLY_PAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DETAIL_LEN = 20_000;
const CHANNEL_OWNER = "#channel";
const MAX_ENTRIES = 15;

export async function ensureReplyPageTables() {
  // One row per (channel, viewer); owner_key is a lowercase login or
  // CHANNEL_OWNER. Replaces the one-row-per-reply reply_pages table.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS reply_links (
      broadcaster_id TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      owner_name TEXT NOT NULL DEFAULT '',
      id TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, owner_key)
    )`,
  );
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_reply_links_updated ON reply_links(updated_at)`);
  // The replies themselves, several per page. reply_links.summary/detail
  // held the single latest reply before this and are no longer written.
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS reply_log (
      broadcaster_id TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      at INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT ''
    )`,
  );
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_reply_log_owner ON reply_log(broadcaster_id, owner_key, at)`);
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_reply_log_at ON reply_log(at)`);
  await sqlite.execute(`DROP TABLE IF EXISTS reply_pages`);
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

// Cron vals (timed messages, autohunt, merchant) don't run main.ts's schema
// setup, so make sure the table exists before the first save in an isolate.
let tablesReady = false;
let lastCleanup = 0;

/** Logs a reply on `owner`'s page and returns the page link — the same link
 * every time for the same viewer in the same channel. `owner` is a login
 * (any case); omit it for replies that aren't for anyone in particular.
 * `summary` is what chat saw; `detail` the full output (the same text for a
 * one-message reply). */
export async function saveReplyPage(
  broadcasterId: string,
  owner: string | undefined,
  summary: string,
  detail: string,
): Promise<string> {
  if (!tablesReady) {
    await ensureReplyPageTables();
    tablesReady = true;
  }
  const ownerKey = owner ? owner.toLowerCase() : CHANNEL_OWNER;
  const now = Date.now();
  // Drop stale replies (the links stay) — at most every 10 minutes per
  // isolate, off the reply's critical path.
  if (now - lastCleanup > 10 * 60_000) {
    lastCleanup = now;
    sqlite.execute("DELETE FROM reply_log WHERE at < ?", [now - REPLY_PAGE_TTL_MS]).catch(() => {});
  }
  const [link] = await sqlite.batch([
    {
      sql: `INSERT INTO reply_links (broadcaster_id, owner_key, owner_name, id, summary, detail, updated_at) VALUES (?,?,?,?,'','',?)
       ON CONFLICT(broadcaster_id, owner_key) DO UPDATE SET owner_name = excluded.owner_name, updated_at = excluded.updated_at
       RETURNING id`,
      args: [broadcasterId, ownerKey, owner ?? "", newId(), now],
    },
    {
      sql: "INSERT INTO reply_log (broadcaster_id, owner_key, at, summary, detail) VALUES (?,?,?,?,?)",
      args: [broadcasterId, ownerKey, now, summary, detail.slice(0, MAX_DETAIL_LEN)],
    },
    {
      sql: `DELETE FROM reply_log WHERE broadcaster_id = ? AND owner_key = ? AND rowid NOT IN
        (SELECT rowid FROM reply_log WHERE broadcaster_id = ? AND owner_key = ? ORDER BY at DESC, rowid DESC LIMIT ${MAX_ENTRIES})`,
      args: [broadcasterId, ownerKey, broadcasterId, ownerKey],
    },
  ]);
  return `${PUBLIC_BASE_URL}/r/${String(link.rows[0]?.id)}`;
}

/** Deletes a channel's reply pages (on !dndbot leave — they hold chat text). */
export async function purgeReplyPages(broadcasterId: string) {
  await sqlite.execute("DELETE FROM reply_links WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM reply_log WHERE broadcaster_id = ?", [broadcasterId]);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Breaks a chat-shaped reply into readable lines: one per battle round
 * ("R3: …") and one per " | "-separated section. */
function detailLines(detail: string): string[] {
  return detail
    .replace(/\s+(?=R\d+: )/g, "\n")
    .replace(/\s+\|\s+/g, "\n")
    .replace(/\s+—\s+(?=\S)/g, "\n— ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** GET /r/<id>; null for any other path. */
export async function handleReplyPageRoute(req: Request, path: string): Promise<Response | null> {
  const m = path.match(/^\/r\/([A-Za-z0-9_-]{6,32})$/);
  if (req.method !== "GET" || !m) return null;
  const res = await sqlite.execute("SELECT * FROM reply_links WHERE id = ?", [m[1]]);
  const row: any = res.rows[0];
  const html = (status: number, title: string, body: string) =>
    new Response(
      scrollDoc(`${esc(title)} — GuildScribe`, body, { width: 780, css: `.summary{background:linear-gradient(180deg,#e4dcc2,#dccfaa);border:1px solid var(--edge);border-left:4px solid var(--seal);border-radius:5px;padding:14px 16px;color:var(--ink)}.log{list-style:none;padding:0;margin:20px 0}.log li{padding:8px 0;border-bottom:1px dotted var(--rule);color:var(--ink-2)}.log li:last-child{border-bottom:0}h1{font-size:1.6rem}.entry{margin:18px 0;padding-bottom:6px;border-bottom:2px solid var(--rule)}.entry .log{margin:10px 0}.when{margin:0 0 6px;font-size:.82rem;color:var(--ink-3)}` }),
      { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
    );
  if (!row) return html(404, "Not found", `<h1>No such scroll</h1><p class="muted">This link doesn't exist.</p>`);
  const who = row.owner_key === CHANNEL_OWNER ? "the channel" : esc(String(row.owner_name || row.owner_key));
  const since = Date.now() - REPLY_PAGE_TTL_MS;
  const log = await sqlite.execute(
    "SELECT at, summary, detail FROM reply_log WHERE broadcaster_id = ? AND owner_key = ? AND at >= ? ORDER BY at DESC, rowid DESC LIMIT ?",
    [row.broadcaster_id, row.owner_key, since, MAX_ENTRIES],
  );
  const entries: { at: number; summary: string; detail: string }[] = log.rows.map((r: any) => ({
    at: Number(r.at),
    summary: String(r.summary),
    detail: String(r.detail),
  }));
  // A reply saved before reply_log existed lives on the link row itself.
  if (!entries.length && row.detail && Number(row.updated_at) >= since) {
    entries.push({ at: Number(row.updated_at), summary: String(row.summary), detail: String(row.detail) });
  }
  const head = `<span class="pill">Replies</span><h1>Latest replies for ${who}</h1>`;
  if (!entries.length) {
    return html(
      200,
      "Latest replies",
      `${head}<p class="muted">Nothing from the last 24 hours. This link stays the same — the next reply will show up here.</p>`,
    );
  }
  const when = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const body = entries.map((e) => {
    // One-message replies are their own summary; long ones show chat's
    // summary above the full output.
    const lines = detailLines(e.detail);
    const summary = e.summary && e.summary !== e.detail ? `<p class="summary">${esc(e.summary)}</p>` : "";
    const list = lines.length ? `<ul class="log">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "";
    return `<section class="entry"><p class="when">${when(e.at)}</p>${summary}${list}</section>`;
  }).join("");
  return html(
    200,
    "Latest replies",
    `${head}${body}<p class="muted">Newest first · this link always shows the latest ${MAX_ENTRIES} · replies are kept for 24 hours.</p>`,
  );
}

// Detail pages for long replies.
//
// When anything the bot says would take more than one chat message, chat
// gets a one-message summary ending in a link to GET /r/<id>, which shows
// the full output (the whole battle log for fights — see sendChatMessages
// in twitch.ts).
//
// Each viewer has ONE page per channel: the first long reply for them mints
// a random, unguessable id, and every later one overwrites that page's
// content, so the link they already have always shows their latest full
// reply. Replies with no particular viewer (timed messages, merchant posts)
// share one channel page. Content older than REPLY_PAGE_TTL_MS is cleared
// and the page says so, but the link itself is kept for the next reply.

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { PUBLIC_BASE_URL } from "./config.ts";

const REPLY_PAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DETAIL_LEN = 20_000;
const CHANNEL_OWNER = "#channel";

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

/** Stores `owner`'s latest full reply and returns their page link — the same
 * link every time for the same viewer in the same channel. `owner` is a login
 * (any case); omit it for replies that aren't for anyone in particular. */
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
  // Free the space of stale content (the rows and their links stay) — at
  // most every 10 minutes per isolate, off the reply's critical path.
  if (now - lastCleanup > 10 * 60_000) {
    lastCleanup = now;
    sqlite.execute("UPDATE reply_links SET summary = '', detail = '' WHERE updated_at < ? AND detail <> ''", [now - REPLY_PAGE_TTL_MS])
      .catch(() => {});
  }
  const res = await sqlite.execute(
    `INSERT INTO reply_links (broadcaster_id, owner_key, owner_name, id, summary, detail, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(broadcaster_id, owner_key) DO UPDATE SET
       owner_name = excluded.owner_name, summary = excluded.summary, detail = excluded.detail, updated_at = excluded.updated_at
     RETURNING id`,
    [broadcasterId, ownerKey, owner ?? "", newId(), summary, detail.slice(0, MAX_DETAIL_LEN), now],
  );
  return `${PUBLIC_BASE_URL}/r/${String(res.rows[0]?.id)}`;
}

/** Deletes a channel's reply pages (on !dndbot leave — they hold chat text). */
export async function purgeReplyPages(broadcasterId: string) {
  await sqlite.execute("DELETE FROM reply_links WHERE broadcaster_id = ?", [broadcasterId]);
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
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} — GuildScribe</title><style>:root{color-scheme:dark}body{font-family:Georgia,serif;max-width:760px;margin:32px auto;background:#15120f;color:#f4eadb;padding:20px;line-height:1.55}h1{color:#e6a56e;font-size:1.4rem}.summary{background:#211b16;border:1px solid #684632;border-radius:10px;padding:14px 16px}.log{list-style:none;padding:0;margin:20px 0}.log li{padding:7px 0;border-bottom:1px solid #2a231c}.log li:last-child{border-bottom:0}.muted{color:#aa9b8d;font-size:.9rem}a{color:#e6a56e}@media(max-width:600px){body{margin:16px auto;padding:14px}}</style></head><body>${body}</body></html>`,
      { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
    );
  if (!row) return html(404, "Not found", `<h1>📜 No such scroll</h1><p class="muted">This link doesn't exist.</p>`);
  const who = row.owner_key === CHANNEL_OWNER ? "the channel" : esc(String(row.owner_name || row.owner_key));
  const fresh = row.detail && Number(row.updated_at) >= Date.now() - REPLY_PAGE_TTL_MS;
  if (!fresh) {
    return html(
      200,
      "Latest full reply",
      `<h1>📜 Latest full reply for ${who}</h1><p class="muted">Nothing from the last 24 hours. This link stays the same — the next long reply will show up here.</p>`,
    );
  }
  const when = new Date(Number(row.updated_at)).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = detailLines(String(row.detail)).map((l) => `<li>${esc(l)}</li>`).join("");
  return html(
    200,
    "Latest full reply",
    `<h1>📜 Latest full reply for ${who}</h1><p class="summary">${esc(String(row.summary))}</p><ul class="log">${lines}</ul><p class="muted">Posted ${when} · this link always shows the latest one · replies are kept for 24 hours.</p>`,
  );
}

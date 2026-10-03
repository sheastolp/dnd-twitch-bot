// Detail pages for long replies.
//
// When anything the bot says would take more than one chat message, chat
// gets a one-message summary ending in a link to GET /r/<id>, which shows
// the full output (the whole battle log for fights — see sendChatMessages
// in twitch.ts). Pages
// are public but unguessable, and are deleted after REPLY_PAGE_TTL_MS.

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { PUBLIC_BASE_URL } from "./config.ts";

const REPLY_PAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DETAIL_LEN = 20_000;

export async function ensureReplyPageTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS reply_pages (
      id TEXT PRIMARY KEY,
      broadcaster_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS idx_reply_pages_created ON reply_pages(created_at)`);
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
}

// Cron vals (timed messages, autohunt, merchant) don't run main.ts's schema
// setup, so make sure the table exists before the first save in an isolate.
let tablesReady = false;

/** Stores a reply's full output and returns the link to its page. */
export async function saveReplyPage(broadcasterId: string, summary: string, detail: string): Promise<string> {
  if (!tablesReady) {
    await ensureReplyPageTables();
    tablesReady = true;
  }
  const id = newId();
  const now = Date.now();
  await sqlite.execute("DELETE FROM reply_pages WHERE created_at < ?", [now - REPLY_PAGE_TTL_MS]);
  await sqlite.execute(
    "INSERT INTO reply_pages (id, broadcaster_id, summary, detail, created_at) VALUES (?,?,?,?,?)",
    [id, broadcasterId, summary, detail.slice(0, MAX_DETAIL_LEN), now],
  );
  return `${PUBLIC_BASE_URL}/r/${id}`;
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
  const res = await sqlite.execute("SELECT * FROM reply_pages WHERE id = ? AND created_at >= ?", [m[1], Date.now() - REPLY_PAGE_TTL_MS]);
  const row: any = res.rows[0];
  const html = (status: number, title: string, body: string) =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} — GuildScribe</title><style>:root{color-scheme:dark}body{font-family:Georgia,serif;max-width:760px;margin:32px auto;background:#15120f;color:#f4eadb;padding:20px;line-height:1.55}h1{color:#e6a56e;font-size:1.4rem}.summary{background:#211b16;border:1px solid #684632;border-radius:10px;padding:14px 16px}.log{list-style:none;padding:0;margin:20px 0}.log li{padding:7px 0;border-bottom:1px solid #2a231c}.log li:last-child{border-bottom:0}.muted{color:#aa9b8d;font-size:.9rem}a{color:#e6a56e}@media(max-width:600px){body{margin:16px auto;padding:14px}}</style></head><body>${body}</body></html>`,
      { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  if (!row) return html(404, "Not found", `<h1>📜 This scroll has crumbled</h1><p class="muted">Detail pages are kept for 24 hours. This one has expired or never existed.</p>`);
  const when = new Date(Number(row.created_at)).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const lines = detailLines(String(row.detail)).map((l) => `<li>${esc(l)}</li>`).join("");
  return html(
    200,
    "Full reply",
    `<h1>📜 Full reply</h1><p class="summary">${esc(String(row.summary))}</p><ul class="log">${lines}</ul><p class="muted">Posted ${when} · kept for 24 hours.</p>`,
  );
}

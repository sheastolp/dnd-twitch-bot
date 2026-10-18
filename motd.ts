// GuildScribe — message of the day. One message, written by the bot's
// developer, that GuildScribe posts in every connected channel's chat when
// its stream goes live (stream.online in main.ts). No message = nothing is
// posted.
//
// Only the developer can change it: the editor is GET/POST /admin/motd,
// behind ADMIN_API_SECRET like the other /admin pages (?key=… on the URL, a
// form field on POST). Streamers and mods have no way to edit it.
//
// A channel gets it at most once per RESEND_GUARD_MS, so a stream that drops
// and comes back (a second stream.online) doesn't post it twice. Channels
// that are switched off (!dndbot off), blocked or disconnected get nothing.
// Tables `bot_motd` (one row) and `motd_sent`.

import { sqlite } from "./sqlite.ts";
import { getBroadcaster, isChannelBlocked, isChannelEnabled, recordMonitorEvent } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

export const MAX_MOTD_LEN = 450; // Twitch's limit is 500; leaves room for the prefix
const RESEND_GUARD_MS = 60 * 60_000;
const PREFIX = "📜 ";

export async function ensureMotdTables() {
  await sqlite.batch([
    `CREATE TABLE IF NOT EXISTS bot_motd (id INTEGER PRIMARY KEY CHECK (id = 1), message TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS motd_sent (broadcaster_id TEXT PRIMARY KEY, sent_at INTEGER NOT NULL)`,
  ]);
}

export async function purgeMotdData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM motd_sent WHERE broadcaster_id = ?", [broadcasterId]);
}

export async function getMotd(): Promise<{ message: string; updatedAt: number }> {
  const r = (await sqlite.execute("SELECT message, updated_at FROM bot_motd WHERE id = 1")).rows[0] as any;
  return { message: String(r?.message ?? ""), updatedAt: Number(r?.updated_at ?? 0) };
}

async function setMotd(message: string) {
  await sqlite.execute(
    "INSERT INTO bot_motd (id, message, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET message = excluded.message, updated_at = excluded.updated_at",
    [message, Date.now()],
  );
}

/** stream.online (main.ts): posts the message of the day, if there is one. */
export async function onStreamOnlineMotd(broadcasterId: string) {
  const { message } = await getMotd();
  if (!message.trim()) return;
  const [b, enabled, blocked] = await Promise.all([getBroadcaster(broadcasterId), isChannelEnabled(broadcasterId), isChannelBlocked(broadcasterId)]);
  if (!b || Number(b.connected) !== 1 || !enabled || blocked) return;
  const now = Date.now();
  const last = Number(((await sqlite.execute("SELECT sent_at FROM motd_sent WHERE broadcaster_id = ?", [broadcasterId])).rows[0] as any)?.sent_at ?? 0);
  if (now - last < RESEND_GUARD_MS) return;
  await sqlite.execute("INSERT OR REPLACE INTO motd_sent (broadcaster_id, sent_at) VALUES (?, ?)", [broadcasterId, now]);
  try {
    await sendChatMessage(`${PREFIX}${message}`, broadcasterId);
  } catch (e) {
    await recordMonitorEvent("motd_send_failed", `${broadcasterId}: ${String(e)}`);
  }
}

// ── /admin/motd ─────────────────────────────────────────────────────────────

function authorized(key: string): boolean {
  const secret = Deno.env.get("ADMIN_API_SECRET");
  return !!secret && secret.length >= 32 && key === secret;
}

/** ?key= decoded by hand so a "+" in the secret survives (see /admin/logs). */
function keyFromQuery(url: URL): string {
  const m = url.search.slice(1).match(/(?:^|&)key=([^&]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

const unauthorized = () => new Response("Unauthorized. Append ?key=<ADMIN_API_SECRET> to the URL.", { status: 401, headers: { "Cache-Control": "no-store" } });

async function page(key: string, notice = "", error = ""): Promise<Response> {
  const { message, updatedAt } = await getMotd();
  const k = encodeURIComponent(key);
  const hiddenKey = `<input type="hidden" name="key" value="${escapeHtml(key)}">`;
  const body = `<h1>Message of the day</h1>
<p class="lede">Posted once in every connected channel's chat when its stream goes live. Leave it empty and nothing is posted. Only you can change it — this page needs the admin key.</p>
${error ? `<p class="banner error">${escapeHtml(error)}</p>` : notice ? `<p class="banner ok">${escapeHtml(notice)}</p>` : ""}
<form method="post" action="/admin/motd" class="card">${hiddenKey}<input type="hidden" name="intent" value="save">
<label for="motd"><strong>Message</strong> <span class="muted small">(up to ${MAX_MOTD_LEN} characters; chat sees it as “${PREFIX}your message”)</span></label>
<textarea id="motd" name="message" rows="4" maxlength="${MAX_MOTD_LEN}" style="width:100%;margin:8px 0;padding:10px;font:inherit">${escapeHtml(message)}</textarea>
<p class="muted small" id="count"></p>
<button type="submit" class="ember">Save</button></form>
${message ? `<form method="post" action="/admin/motd" onsubmit="return confirm('Clear the message? Nothing will be posted until you write a new one.')">${hiddenKey}<input type="hidden" name="intent" value="clear"><button type="submit" class="ghost">Clear message</button></form>` : ""}
<p class="muted small">${message ? `Live since ${new Date(updatedAt).toISOString().replace("T", " ").slice(0, 16)} UTC. Each channel gets it at most once an hour, so a stream that drops and restarts doesn't see it twice.` : "No message set — channels going live get nothing."}</p>
<p><a href="/admin/channels?key=${k}">Channel connections</a> · <a href="/admin/logs?key=${k}">Operator logs</a></p>
<script>(function(){var t=document.getElementById("motd"),c=document.getElementById("count");function u(){c.textContent=t.value.length+" / ${MAX_MOTD_LEN}"}t.addEventListener("input",u);u()})();</script>`;
  return new Response(scrollDoc("Message of the day — GuildScribe", body, { width: 900, css: LEDGER_CSS }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** GET and POST /admin/motd; null for other paths. */
export async function handleMotdAdminRoute(req: Request, url: URL, path: string): Promise<Response | null> {
  if (path !== "/admin/motd") return null;
  if (req.method === "GET") {
    const key = keyFromQuery(url);
    return authorized(key) ? await page(key) : unauthorized();
  }
  if (req.method === "POST") {
    const form = await req.formData();
    const key = String(form.get("key") ?? "");
    if (!authorized(key)) return unauthorized();
    if (String(form.get("intent")) === "clear") {
      await setMotd("");
      return await page(key, "Cleared — nothing will be posted when streams go live.");
    }
    const message = String(form.get("message") ?? "").replace(/\s+/g, " ").trim();
    if (message.length > MAX_MOTD_LEN) return await page(key, "", `That's ${message.length} characters — keep it to ${MAX_MOTD_LEN}.`);
    await setMotd(message);
    return await page(key, message ? "Saved. It will be posted in each channel the next time it goes live." : "Saved an empty message — nothing will be posted.");
  }
  return null;
}

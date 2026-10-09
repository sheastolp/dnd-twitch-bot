// GET /admin/eventsub — every EventSub subscription Twitch holds for this app
// and where it delivers. Twitch keeps one subscription per event type and
// channel, whatever the callback, so a channel whose subscriptions point at
// another copy of the bot (an old address, a second server) gets its chat
// handled there: replies still post, but they're saved to that copy's
// database. Channels with any subscription delivering elsewhere (or not
// enabled) are flagged, and POST /admin/eventsub/repoint moves them here.
// "Renew all" recreates every subscription of a channel even when it already
// points here: Twitch signs deliveries with the secret a subscription was
// created with, so ones made by another copy (with its own EVENTSUB_SECRET)
// fail verifyEventSub here and are silently dropped.
//
// Same auth as /admin/logs: ?key=<ADMIN_API_SECRET> (a form field on POST).

import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";
import { sqlite } from "./sqlite.ts";
import { recordMonitorEvent } from "./db.ts";
import { PUBLIC_ORIGIN } from "./config.ts";
import { escapeHtml } from "./utils.ts";
import { type EventSubSubscription, listAppEventSubSubscriptions, repointEventSubSubscription } from "./twitch.ts";

const CSS = `.bad{color:var(--seal-dk);font-weight:600}.ok{color:var(--ok)}.mono{font-family:ui-monospace,monospace;font-size:.82rem;word-break:break-all}form.inline{display:inline;margin:0}`;

function authorized(key: string): boolean {
  const secret = Deno.env.get("ADMIN_API_SECRET");
  return !!secret && secret.length >= 32 && key === secret;
}

/** ?key= decoded by hand so a "+" in the secret survives (see /admin/logs). */
function keyFromQuery(url: URL): string {
  const m = url.search.slice(1).match(/(?:^|&)key=([^&]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

function channelOf(s: EventSubSubscription): string {
  return String(s.condition.broadcaster_user_id ?? s.condition.to_broadcaster_user_id ?? "");
}

function deliversHere(s: EventSubSubscription): boolean {
  return s.status === "enabled" && s.callback === PUBLIC_ORIGIN;
}

function doc(title: string, body: string) {
  return new Response(scrollDoc(`${escapeHtml(title)} — GuildScribe`, body, { width: 1140, css: LEDGER_CSS + CSS }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function channelNames(): Promise<Map<string, string>> {
  const res = await sqlite.execute("SELECT broadcaster_id, login, display_name FROM broadcasters");
  return new Map(res.rows.map((r: any) => [String(r.broadcaster_id), String(r.display_name || r.login || r.broadcaster_id)]));
}

/** GET /admin/eventsub and POST /admin/eventsub/repoint; null for other paths. */
export async function handleEventSubAdminRoute(req: Request, url: URL, path: string): Promise<Response | null> {
  if (req.method === "GET" && path === "/admin/eventsub") {
    const key = keyFromQuery(url);
    if (!authorized(key)) return new Response("Unauthorized. Append ?key=<ADMIN_API_SECRET> to the URL.", { status: 401, headers: { "Cache-Control": "no-store" } });
    const [subs, names] = await Promise.all([listAppEventSubSubscriptions(), channelNames()]);
    const byChannel = new Map<string, EventSubSubscription[]>();
    for (const s of subs) {
      const id = channelOf(s);
      if (!byChannel.has(id)) byChannel.set(id, []);
      byChannel.get(id)!.push(s);
    }
    const k = encodeURIComponent(key);
    const channels = [...byChannel.entries()].sort(([a], [b]) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
    const flagged = channels.filter(([, list]) => list.some((s) => !deliversHere(s))).length;
    const rows = channels.map(([id, list]) => {
      const name = escapeHtml(names.get(id) ?? `${id} (not in this database)`);
      const off = list.filter((s) => !deliversHere(s));
      const form = (all: boolean, label: string) =>
        `<form class="inline" method="post" action="/admin/eventsub/repoint"><input type="hidden" name="key" value="${escapeHtml(key)}"><input type="hidden" name="broadcaster_id" value="${escapeHtml(id)}">${all ? `<input type="hidden" name="all" value="1">` : ""}<button type="submit">${label}</button></form>`;
      const action = (off.length ? form(false, `Move ${off.length} here`) + "<br>" : `<span class="ok">all here</span><br>`) +
        form(true, `Renew all ${list.length}`);
      const subRows = list.sort((a, b) => a.type.localeCompare(b.type)).map((s) => {
        const here = deliversHere(s);
        return `<li><b>${escapeHtml(s.type)}</b> · <span class="${s.status === "enabled" ? "ok" : "bad"}">${escapeHtml(s.status)}</span> · <span class="mono ${s.callback === PUBLIC_ORIGIN ? "" : "bad"}">${escapeHtml(s.callback)}</span>${here ? "" : " ⚠"}</li>`;
      }).join("");
      return `<tr><td>${name}<br><span class="muted small">${escapeHtml(id)}</span></td><td><ul class="list">${subRows}</ul></td><td>${action}</td></tr>`;
    }).join("");
    return doc(
      "EventSub subscriptions",
      `<h1>EventSub subscriptions</h1><p class="lede">What Twitch delivers for this app, and where. This server is <code>${escapeHtml(PUBLIC_ORIGIN)}</code>; anything delivering elsewhere or not <b>enabled</b> is marked ⚠. A channel whose <b>channel.chat.message</b> goes elsewhere has its commands answered by that other copy, so its replies, duels and gold are saved there, not here. <b>Renew all</b> recreates a channel's subscriptions with this server's secret — use it when a channel's events all point here but the bot ignores its chat (they were created by another copy with a different <code>EVENTSUB_SECRET</code>, so every delivery fails the signature check).</p><div class="stats"><div class="stat"><b>${subs.length}</b>subscriptions</div><div class="stat"><b>${channels.length}</b>channels</div><div class="stat"><b>${flagged}</b>channels with ⚠</div></div><div class="table-wrap"><table><thead><tr><th>Channel</th><th>Subscriptions</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="3" class="muted">No subscriptions.</td></tr>`}</tbody></table></div><p><a href="/admin/channels?key=${k}">Channel connections</a> · <a href="/admin/logs?key=${k}">Operator logs</a></p>`,
    );
  }

  if (req.method === "POST" && path === "/admin/eventsub/repoint") {
    const form = await req.formData();
    const key = String(form.get("key") ?? "");
    if (!authorized(key)) return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
    const broadcasterId = String(form.get("broadcaster_id") ?? "");
    if (!/^\d+$/.test(broadcasterId)) return new Response("Missing broadcaster_id", { status: 400 });
    const all = form.get("all") === "1";
    const off = (await listAppEventSubSubscriptions()).filter((s) => channelOf(s) === broadcasterId && (all || !deliversHere(s)));
    const lines: string[] = [];
    for (const s of off) {
      try {
        const fresh = await repointEventSubSubscription(s, PUBLIC_ORIGIN);
        const newId = String(fresh.id);
        if (s.type === "channel.chat.message") {
          await sqlite.execute(
            "UPDATE broadcasters SET subscription_id = ?, connected = 1, disconnected_at = NULL, disconnect_reason = NULL WHERE broadcaster_id = ?",
            [newId, broadcasterId],
          );
        } else {
          await sqlite.execute("UPDATE eventsub_extra_subscriptions SET subscription_id = ? WHERE subscription_id = ?", [newId, s.id]);
        }
        lines.push(`<li class="ok">${escapeHtml(s.type)}: ${s.callback === PUBLIC_ORIGIN ? "renewed" : `moved from <span class="mono">${escapeHtml(s.callback)}</span>`} (${escapeHtml(fresh.status ?? "created")})</li>`);
      } catch (e) {
        lines.push(`<li class="bad">${escapeHtml(s.type)}: ${escapeHtml(String(e))}</li>`);
      }
    }
    await recordMonitorEvent("eventsub_repoint", `${broadcasterId}: ${off.length} subscription(s)${all ? " (renew all)" : ""}`).catch(() => {});
    return doc(
      "Subscriptions moved",
      `<h1>Subscriptions moved</h1><ul class="list">${lines.join("") || "<li>Nothing to move — every subscription already delivers here.</li>"}</ul><p class="muted">New subscriptions show as <b>webhook_callback_verification_pending</b> for a moment while Twitch checks this server, then <b>enabled</b>. If one failed, the broadcaster can reconnect at <a href="/connect">/connect</a>.</p><p><a href="/admin/eventsub?key=${encodeURIComponent(key)}">Back to subscriptions</a></p>`,
    );
  }

  return null;
}

// Connection health for a channel: is the chat subscription alive, which
// OAuth scopes did the broadcaster grant, and which extra EventSub
// subscriptions exist. Shown as a card on the channel dashboard and as a
// table on the operator page GET /admin/channels. Everything here is a
// plain DB read — no Twitch API calls — so it stays cheap to render.

import { sqlite } from "./sqlite.ts";
import { getBroadcaster, getExtraEventSubSubscriptions, isChannelBlocked, isChannelEnabled } from "./db.ts";
import { getBroadcasterAdToken } from "./ads_db.ts";
import { escapeHtml } from "./utils.ts";

/** Scopes /connect asks for, with the feature each one powers. /connect
 * builds its request from this list, so the status check can't drift. */
export const CONNECT_SCOPES: Array<{ scope: string; feature: string }> = [
  { scope: "channel:bot", feature: "Chat replies" },
  { scope: "channel:read:subscriptions", feature: "Sub / resub / gift thank-yous" },
  { scope: "channel:read:ads", feature: "!adcheck and ad-break alerts" },
  { scope: "channel:read:redemptions", feature: "Channel-point boons" },
  { scope: "moderator:manage:banned_users", feature: "Auto-ban" },
  { scope: "moderator:read:followers", feature: "Watch-time follower checks" },
  { scope: "moderator:read:chatters", feature: "Watch-time and bot viewer check" },
];

/** Extra EventSub subscriptions /connect creates (eventsub_extra_subscriptions.kind).
 * `scope` is the permission it can't be created without — when that's
 * missing too, the permission line already covers it, so it isn't listed twice.
 * `selfHeals` marks ones the bot recreates on its own when missing (main.ts's
 * stream-status backfill, adalerts.ts's lazy subscribe), so they never
 * call for a reconnect. */
export const EXTRA_SUBSCRIPTIONS: Array<{ kinds: string[]; feature: string; scope?: string; selfHeals?: boolean }> = [
  { kinds: ["sub", "resub", "gift"], feature: "Sub thank-yous", scope: "channel:read:subscriptions" },
  { kinds: ["raid"], feature: "Raid thank-yous" },
  { kinds: ["stream_online", "stream_offline"], feature: "Live / offline tracking", selfHeals: true },
  { kinds: ["ad_break"], feature: "Ad-break alerts", scope: "channel:read:ads", selfHeals: true },
  { kinds: ["redemption"], feature: "Channel-point boons", scope: "channel:read:redemptions" },
];

export type ChannelHealth = "ok" | "partial" | "disconnected" | "blocked";

export interface ChannelStatus {
  broadcasterId: string;
  name: string;
  health: ChannelHealth;
  connected: boolean;
  connectedAt: number | null;
  disconnectedAt: number | null;
  disconnectReason: string | null;
  enabled: boolean;
  blocked: boolean;
  isLive: boolean;
  /** False when no broadcaster token is stored (connected before scopes were requested). */
  hasToken: boolean;
  missingScopes: Array<{ scope: string; feature: string }>;
  /** Only ones a reconnect would fix — self-healing ones are left out. */
  missingSubscriptions: Array<{ kinds: string[]; feature: string; scope?: string; selfHeals?: boolean }>;
}

function computeStatus(
  b: any,
  tokenScope: string | null,
  extraKinds: Set<string>,
  enabled: boolean,
  blocked: boolean,
): ChannelStatus {
  const connected = Number(b.connected) === 1;
  const granted = new Set(String(tokenScope ?? "").split(/\s+/).filter(Boolean));
  const missingScopes = CONNECT_SCOPES.filter((s) => !granted.has(s.scope));
  const missingSubscriptions = EXTRA_SUBSCRIPTIONS.filter(
    (x) => !x.selfHeals && !x.kinds.every((k) => extraKinds.has(k)) && (!x.scope || granted.has(x.scope)),
  );
  const health: ChannelHealth = blocked
    ? "blocked"
    : !connected
    ? "disconnected"
    : missingScopes.length || missingSubscriptions.length
    ? "partial"
    : "ok";
  return {
    broadcasterId: String(b.broadcaster_id),
    name: String(b.display_name || b.login || b.broadcaster_id),
    health,
    connected,
    connectedAt: b.connected_at ? Number(b.connected_at) : null,
    disconnectedAt: b.disconnected_at ? Number(b.disconnected_at) : null,
    disconnectReason: b.disconnect_reason ? String(b.disconnect_reason) : null,
    enabled,
    blocked,
    isLive: Number(b.is_live) === 1,
    hasToken: tokenScope !== null,
    missingScopes,
    missingSubscriptions,
  };
}

/** One channel's status, or null if it has never connected. */
export async function getChannelStatus(broadcasterId: string): Promise<ChannelStatus | null> {
  const b = await getBroadcaster(broadcasterId);
  if (!b) return null;
  const [token, extras, enabled, blocked] = await Promise.all([
    getBroadcasterAdToken(broadcasterId),
    getExtraEventSubSubscriptions(broadcasterId),
    isChannelEnabled(broadcasterId),
    isChannelBlocked(broadcasterId),
  ]);
  return computeStatus(b, token ? String(token.scope ?? "") : null, new Set(extras.map((e) => e.kind)), enabled, blocked);
}

/** Every channel that has ever connected, worst health first — for /admin/channels.
 * Bulk queries rather than four per channel (isChannelEnabled aside, which
 * owns its own default-on rule). */
export async function listChannelStatuses(): Promise<ChannelStatus[]> {
  const [bRes, tRes, xRes, blRes] = await Promise.all([
    sqlite.execute("SELECT * FROM broadcasters"),
    sqlite.execute("SELECT broadcaster_id, scope FROM broadcaster_ad_tokens"),
    sqlite.execute("SELECT broadcaster_id, kind FROM eventsub_extra_subscriptions"),
    sqlite.execute("SELECT broadcaster_id FROM channel_blocks"),
  ]);
  const scopes = new Map<string, string>();
  for (const r of tRes.rows as any[]) scopes.set(String(r.broadcaster_id), String(r.scope ?? ""));
  const kinds = new Map<string, Set<string>>();
  for (const r of xRes.rows as any[]) {
    const id = String(r.broadcaster_id);
    if (!kinds.has(id)) kinds.set(id, new Set());
    kinds.get(id)!.add(String(r.kind));
  }
  const blocked = new Set((blRes.rows as any[]).map((r) => String(r.broadcaster_id)));
  const rows = bRes.rows as any[];
  const enabled = await Promise.all(rows.map((b) => isChannelEnabled(String(b.broadcaster_id))));
  const order: Record<ChannelHealth, number> = { disconnected: 0, blocked: 1, partial: 2, ok: 3 };
  return rows
    .map((b, i) => {
      const id = String(b.broadcaster_id);
      return computeStatus(b, scopes.has(id) ? scopes.get(id)! : null, kinds.get(id) ?? new Set(), enabled[i], blocked.has(id));
    })
    .sort((a, b) => order[a.health] - order[b.health] || a.name.localeCompare(b.name));
}

// ── Rendering ──

const HEALTH_LABEL: Record<ChannelHealth, string> = {
  ok: "✅ Connected",
  partial: "⚠️ Reconnect recommended",
  disconnected: "⛔ Disconnected — reconnect needed",
  blocked: "🚫 Blocked by operator",
};

function when(ms: number | null): string {
  return ms ? escapeHtml(new Date(ms).toLocaleString()) : "—";
}

/** Plain-English explanation of Twitch's revocation status values. */
function reasonText(reason: string | null): string {
  switch (reason) {
    case "authorization_revoked": return "the broadcaster removed the bot's access on Twitch";
    case "user_removed": return "the Twitch account was deleted or suspended";
    case "moderator_removed": return "the bot was unmodded";
    case "version_removed": return "Twitch retired the subscription version";
    case "notification_failures_exceeded": return "Twitch couldn't reach the bot for too long";
    default: return reason ? escapeHtml(reason) : "unknown reason";
  }
}

export const CHANNEL_STATUS_CSS = `.conn{border:1px solid var(--edge);border-left:5px solid var(--gold);border-radius:6px;padding:12px 16px;margin:14px 0;background:#e3d6b0}
.conn.ok{border-left-color:var(--ok)}.conn.disconnected,.conn.blocked{border-left-color:var(--bad);background:var(--bad-bg)}
.conn h2{font-size:1.15rem;margin:0 0 4px}.conn ul{margin:6px 0 4px;padding-left:1.3em}.conn li{margin:2px 0}
.conn .btn{margin-top:6px}
.health{white-space:nowrap;font-weight:600}.health.ok{color:var(--ok)}.health.partial{color:var(--gold)}.health.disconnected,.health.blocked{color:var(--bad)}`;

function missingList(s: ChannelStatus): string {
  const items: string[] = [];
  if (!s.hasToken) items.push("No broadcaster permissions on file — this channel connected before they were requested.");
  else for (const m of s.missingScopes) items.push(`${escapeHtml(m.feature)} <span class="muted">(permission <code>${escapeHtml(m.scope)}</code>)</span>`);
  for (const m of s.missingSubscriptions) items.push(`${escapeHtml(m.feature)} <span class="muted">(Twitch event subscription)</span>`);
  return items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : "";
}

/** The connection card at the top of the channel dashboard. */
export function renderChannelStatusCard(s: ChannelStatus | null, connectUrl: string): string {
  if (!s) {
    return `<section class="conn disconnected" id="sec-connection"><h2>${HEALTH_LABEL.disconnected}</h2><p>This channel has never connected GuildScribe.</p><a class="btn ember" href="${escapeHtml(connectUrl)}">Connect channel</a></section>`;
  }
  const reconnect = `<a class="btn ember" href="${escapeHtml(connectUrl)}">Reconnect channel</a> <span class="muted">The broadcaster must do this while logged in to their own Twitch account. It's safe any time and keeps all data.</span>`;
  const live = s.isLive ? " · 🔴 live now" : "";
  let body: string;
  if (s.health === "blocked") {
    body = `<p>The operator has blocked this channel, so the bot ignores it. Contact support if this is unexpected.</p>`;
  } else if (s.health === "disconnected") {
    body = `<p>The bot stopped hearing this channel's chat on ${when(s.disconnectedAt)} because ${reasonText(s.disconnectReason)}. No commands will work until the broadcaster reconnects.</p>${reconnect}`;
  } else if (s.health === "partial") {
    body = `<p>Chat commands work, but these features are off until the broadcaster reconnects to grant newer permissions:</p>${missingList(s)}${reconnect}`;
  } else {
    body = `<p class="muted">Chat and every permission-based feature are working. Connected ${when(s.connectedAt)}${live}.</p>`;
  }
  const off = s.enabled || s.health === "blocked" ? "" : `<p><strong>Note:</strong> the bot is switched off in this channel (<code>!dndbot on</code> to open it).</p>`;
  return `<section class="conn ${s.health}" id="sec-connection"><h2>${HEALTH_LABEL[s.health]}</h2>${body}${off}</section>`;
}

/** The operator's all-channels table (GET /admin/channels). */
export function renderAdminChannelsPage(list: ChannelStatus[], key: string): string {
  const counts = { ok: 0, partial: 0, disconnected: 0, blocked: 0 } as Record<ChannelHealth, number>;
  for (const s of list) counts[s.health]++;
  const k = encodeURIComponent(key);
  const rows = list.map((s) => {
    const detail = s.health === "disconnected"
      ? `${reasonText(s.disconnectReason)} (${when(s.disconnectedAt)})`
      : s.health === "partial"
      ? [
          !s.hasToken ? "no permissions on file" : s.missingScopes.length ? `missing: ${s.missingScopes.map((m) => escapeHtml(m.feature)).join(", ")}` : "",
          s.missingSubscriptions.length ? `no subscription: ${s.missingSubscriptions.map((m) => escapeHtml(m.feature)).join(", ")}` : "",
        ].filter(Boolean).join("; ")
      : "";
    return `<tr><td><a href="/admin/dashboard-link?channel=${encodeURIComponent(s.broadcasterId)}&key=${k}">${escapeHtml(s.name)}</a><br><span class="muted small">${escapeHtml(s.broadcasterId)}</span></td><td class="health ${s.health}">${HEALTH_LABEL[s.health]}</td><td>${s.enabled ? "on" : "off"}${s.isLive ? " · 🔴" : ""}</td><td>${when(s.connectedAt)}</td><td class="small">${detail || "—"}</td></tr>`;
  }).join("");
  return `<h1>Channel connections</h1>
  <p><a href="/admin/logs?key=${k}">Operator logs</a> · <a href="/">Bot home</a></p>
  <p>${list.length} channel(s): ${counts.ok} connected, ${counts.partial} reconnect recommended, ${counts.disconnected} disconnected, ${counts.blocked} blocked. Click a channel to open its dashboard.</p>
  <div class="table-wrap"><table><thead><tr><th>Channel</th><th>Status</th><th>Bot</th><th>Connected</th><th>Details</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No channels have connected yet.</td></tr>`}</tbody></table></div>`;
}

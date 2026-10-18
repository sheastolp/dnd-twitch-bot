// GuildScribe — /dashboard/mod, the 🛡️ Mod center (behind the dashboard key +
// mod login; dashboard.ts handleModCenterPage/handleModCenterForm do the auth).
// One page for moderators to see and run every automatic moderation feature:
//
//   • Chat right now — Shield Mode and Twitch's chat modes (emote-only,
//     followers-only, subs-only, slow, unique), read live from Twitch and
//     switched with one click.
//   • Protections — on/off for auto-ban, spam filters, the hate-raid shield,
//     follow-bot blocking and the going-live announcement, plus the offline
//     lock's mode. Detailed settings stay on their own pages (🔨 Auto-ban &
//     spam filters, 🤖 Bot viewer check) and are linked.
//   • Quick action — timeout / ban / unban / clear strikes by username.
//   • Follow bots — check or remove bots among the newest followers.
//   • Chatters with strikes, with a Clear button.
//   • Activity — everything the automatic features and mods did, newest first,
//     merged from automod_log, autoban_history, followbot_blocks and
//     mod_actions, filterable by source and username, refreshing itself every
//     30 s; each row has its undo (unban / lift timeout / unblock).
//   • Missing permissions, with a reconnect link.
//
// Everything acts with the broadcaster's own token, like the chat commands.

import { sqlite } from "./sqlite.ts";
import { getBroadcaster, isCommandGroupEnabled, setCommandGroupEnabled } from "./db.ts";
import { getBroadcasterAdToken } from "./ads_db.ts";
import { isAutoBanEnabled, setAutoBanEnabled } from "./autoban.ts";
import { forgetBan, listBans } from "./autoban_history.ts";
import { clearStrikes, getAutoModSettings, listAutoModLog, setAutoModEnabled } from "./automod.ts";
import {
  type ChatSettings, getChatSettings, getLock, getScopedToken, getShieldMode, helix, LOCK_LABELS, type LockMode, patchChatSettings, setOfflineLock, setShieldMode,
  SHIELD_SCOPE, CHAT_SETTINGS_SCOPE,
} from "./stream_guard.ts";
import { BLOCK_SCOPE, listFollowBotBlocks, removeFollowBots, unblockFollower } from "./followbots.ts";
import { listModActions, logModAction } from "./mod_log.ts";
import { banChatUser, getUserIdByLogin } from "./twitch.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

const BAN_SCOPE = "moderator:manage:banned_users";
const BY = "Mod center";
const DAY_MS = 86_400_000;

const PERMISSIONS: Array<{ scope: string; feature: string }> = [
  { scope: BAN_SCOPE, feature: "bans, timeouts and unbans (auto-ban, spam filters, hate-raid shield, quick actions)" },
  { scope: "moderator:manage:chat_messages", feature: "deleting single spam messages" },
  { scope: SHIELD_SCOPE, feature: "Shield Mode (hate-raid shield, offline lock)" },
  { scope: CHAT_SETTINGS_SCOPE, feature: "chat modes (offline lock, the switches below)" },
  { scope: BLOCK_SCOPE, feature: "follow-bot blocking" },
  { scope: "moderator:read:followers", feature: "checking followers for bots" },
];

const CHAT_MODES: Array<{ field: keyof ChatSettings; label: string }> = [
  { field: "emote_mode", label: "Emote-only" },
  { field: "follower_mode", label: "Followers-only" },
  { field: "subscriber_mode", label: "Subscriber-only" },
  { field: "slow_mode", label: "Slow mode" },
  { field: "unique_chat_mode", label: "Unique chat" },
];

const TOGGLES: Array<{ key: string; label: string; help: string }> = [
  { key: "autoban", label: "Auto-ban", help: "Bans anyone using a phrase on the auto-ban list (\"ai viewers\" spam and what it learns)." },
  { key: "automod", label: "Spam filters", help: "Links, caps, symbol walls, emote floods, repeats — warn, then timeouts on the strike ladder." },
  { key: "hateraid", label: "Hate-raid shield", help: "Bans waves of brand-new accounts posting the same thing and turns on Shield Mode." },
  { key: "followbots", label: "Follow-bot blocking", help: "Blocks bot-looking new followers, which removes their follow." },
  { key: "golive", label: "Going-live announcement", help: "Posts title and game at stream start, and warns if chat is locked down." },
];

async function getToggle(broadcasterId: string, key: string): Promise<boolean> {
  if (key === "autoban") return await isAutoBanEnabled(broadcasterId);
  if (key === "automod") return (await getAutoModSettings(broadcasterId)).enabled;
  return await isCommandGroupEnabled(broadcasterId, key);
}

async function setToggle(broadcasterId: string, key: string, on: boolean) {
  if (key === "autoban") await setAutoBanEnabled(broadcasterId, on);
  else if (key === "automod") await setAutoModEnabled(broadcasterId, on);
  else await setCommandGroupEnabled(broadcasterId, key, on);
}

const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const cleanLogin = (v: unknown) => String(v ?? "").trim().replace(/^@/, "").toLowerCase();
const permMsg = (p: string) => p === "no_token" || p === "no_scope" ? "GuildScribe doesn't have that permission yet — the broadcaster needs to reconnect (link at the top)." : "Twitch didn't accept that — try again.";

async function unban(broadcasterId: string, userId: string): Promise<"ok" | "no_token" | "no_scope" | "failed"> {
  const t = await getScopedToken(broadcasterId, BAN_SCOPE);
  if ("problem" in t) return t.problem;
  const r = await helix("DELETE", `/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${broadcasterId}&user_id=${encodeURIComponent(userId)}`, t.token);
  // 400: they weren't banned or timed out (any more) — the outcome the mod wanted.
  return r.ok || r.status === 400 ? "ok" : "failed";
}

// ── Form ────────────────────────────────────────────────────────────────────

export type ModCenterResult = { ok: boolean; message: string; anchor?: string };

export async function applyModCenterForm(broadcasterId: string, form: FormData): Promise<ModCenterResult | null> {
  const intent = String(form.get("intent") ?? "");
  const on = String(form.get("on") ?? "") === "1";

  if (intent === "toggle") {
    const key = String(form.get("feature") ?? "");
    const def = TOGGLES.find((t) => t.key === key);
    if (!def) return { ok: false, message: "Unknown switch." };
    await setToggle(broadcasterId, key, on);
    await logModAction(broadcasterId, { kind: "settings", userId: "", login: "", detail: `${def.label} ${on ? "on" : "off"}`, by: BY });
    return { ok: true, message: `${def.label} is ${on ? "on" : "off"}.`, anchor: "protections" };
  }

  if (intent === "offlinelock") {
    const mode = String(form.get("mode") ?? "off");
    if (mode !== "off" && !(mode in LOCK_LABELS)) return { ok: false, message: "Unknown offline lock mode." };
    await setOfflineLock(broadcasterId, mode === "off" ? null : mode as LockMode);
    await logModAction(broadcasterId, { kind: "offlinelock", userId: "", login: "", detail: mode === "off" ? "off" : LOCK_LABELS[mode as LockMode], by: BY });
    return { ok: true, message: mode === "off" ? "Offline lock is off." : `Offline lock: ${LOCK_LABELS[mode as LockMode]} 5 minutes after the stream ends.`, anchor: "protections" };
  }

  if (intent === "shield") {
    const r = await setShieldMode(broadcasterId, on);
    if (r !== "ok") return { ok: false, message: permMsg(r), anchor: "live" };
    await logModAction(broadcasterId, { kind: "shield", userId: "", login: "", detail: on ? "on" : "off", by: BY });
    return { ok: true, message: `Shield Mode is ${on ? "on" : "off"}.`, anchor: "live" };
  }

  if (intent === "chatmode") {
    const field = String(form.get("field") ?? "") as keyof ChatSettings;
    const def = CHAT_MODES.find((m) => m.field === field);
    if (!def) return { ok: false, message: "Unknown chat mode." };
    const patch: Partial<ChatSettings> = { [field]: on };
    if (on && field === "slow_mode") {
      const secs = Math.round(Number(form.get("seconds") ?? 30));
      if (secs >= 3 && secs <= 120) patch.slow_mode_wait_time = secs;
    }
    if (on && field === "follower_mode") {
      const mins = Math.round(Number(form.get("minutes") ?? 0));
      if (mins >= 0 && mins <= 129600) patch.follower_mode_duration = mins;
    }
    const r = await patchChatSettings(broadcasterId, patch);
    if (r !== "ok") return { ok: false, message: permMsg(r), anchor: "live" };
    await logModAction(broadcasterId, { kind: "chatmode", userId: "", login: "", detail: `${def.label} ${on ? "on" : "off"}`, by: BY });
    return { ok: true, message: `${def.label} is ${on ? "on" : "off"}.`, anchor: "live" };
  }

  if (intent === "action") {
    const login = cleanLogin(form.get("login"));
    const what = String(form.get("what") ?? "");
    const reason = String(form.get("reason") ?? "").trim().slice(0, 200);
    if (!LOGIN_RE.test(login)) return { ok: false, message: "Enter a Twitch username.", anchor: "quick" };
    if (what === "strikes") {
      const had = await clearStrikes(broadcasterId, login);
      if (had) await logModAction(broadcasterId, { kind: "strikes", userId: "", login, detail: "strikes cleared", by: BY });
      return { ok: true, message: had ? `Cleared ${login}'s strikes.` : `${login} had no strikes.`, anchor: "quick" };
    }
    const userId = await getUserIdByLogin(login);
    if (!userId) return { ok: false, message: `There's no Twitch user “${login}”.`, anchor: "quick" };
    if (userId === broadcasterId) return { ok: false, message: "That's the broadcaster.", anchor: "quick" };
    if (what === "unban") {
      const r = await unban(broadcasterId, userId);
      if (r !== "ok") return { ok: false, message: permMsg(r), anchor: "quick" };
      await forgetBan(broadcasterId, userId);
      await logModAction(broadcasterId, { kind: "unban", userId, login, detail: "unbanned / timeout lifted", by: BY });
      return { ok: true, message: `${login} is unbanned (or their timeout is lifted).`, anchor: "quick" };
    }
    const secs = what === "ban" ? 0 : Number(what);
    if (what !== "ban" && !(secs >= 1 && secs <= 1_209_600)) return { ok: false, message: "Pick an action.", anchor: "quick" };
    const t = await getScopedToken(broadcasterId, BAN_SCOPE);
    if ("problem" in t) return { ok: false, message: permMsg(t.problem), anchor: "quick" };
    const r = await banChatUser(t.token, broadcasterId, broadcasterId, userId, reason || `By a moderator (GuildScribe ${BY})`, secs || undefined);
    if (!r.ok) return { ok: false, message: r.status === 400 ? `Twitch wouldn't ${secs ? "time out" : "ban"} ${login} (already banned, or a mod/VIP Twitch protects).` : permMsg("failed"), anchor: "quick" };
    await logModAction(broadcasterId, { kind: secs ? "timeout" : "ban", userId, login, detail: `${secs ? `timed out ${fmtDuration(secs)}` : "banned"}${reason ? ` — ${reason}` : ""}`, by: BY });
    return { ok: true, message: `${login} is ${secs ? `timed out for ${fmtDuration(secs)}` : "banned"}.`, anchor: "quick" };
  }

  if (intent === "unban") {
    let userId = String(form.get("user_id") ?? "");
    const login = cleanLogin(form.get("login"));
    if (!userId && LOGIN_RE.test(login)) userId = (await getUserIdByLogin(login)) ?? "";
    if (!/^\d{1,20}$/.test(userId)) return { ok: false, message: "Couldn't find that account on Twitch.", anchor: "activity" };
    const r = await unban(broadcasterId, userId);
    if (r !== "ok") return { ok: false, message: permMsg(r), anchor: "activity" };
    await forgetBan(broadcasterId, userId);
    await logModAction(broadcasterId, { kind: "unban", userId, login, detail: "unbanned / timeout lifted", by: BY });
    return { ok: true, message: `${login || "They"} can chat again.`, anchor: "activity" };
  }

  if (intent === "unblock") {
    const userId = String(form.get("user_id") ?? "");
    const login = cleanLogin(form.get("login"));
    if (!/^\d{1,20}$/.test(userId)) return { ok: false, message: "Unknown account.", anchor: "activity" };
    const r = await unblockFollower(broadcasterId, userId);
    if (r !== "ok") return { ok: false, message: permMsg(r), anchor: "activity" };
    await logModAction(broadcasterId, { kind: "unblock", userId, login, detail: "unblocked (they'll need to follow again)", by: BY });
    return { ok: true, message: `Unblocked ${login || "them"} — they'll need to follow again.`, anchor: "activity" };
  }

  if (intent === "clearstrikes") {
    const login = cleanLogin(form.get("login"));
    if (!LOGIN_RE.test(login)) return { ok: false, message: "Unknown chatter.", anchor: "strikes" };
    await clearStrikes(broadcasterId, login);
    await logModAction(broadcasterId, { kind: "strikes", userId: "", login, detail: "strikes cleared", by: BY });
    return { ok: true, message: `Cleared ${login}'s strikes.`, anchor: "strikes" };
  }

  if (intent === "checkbots" || intent === "removebots") {
    const r = await removeFollowBots(broadcasterId, intent === "checkbots");
    if ("problem" in r) {
      return { ok: false, message: r.problem === "cooldown" ? `Remove bots can run again in ${r.minutes} min.` : permMsg(r.problem), anchor: "followbots" };
    }
    if (intent === "checkbots") {
      return { ok: true, message: `Checked the newest ${r.scanned} followers: ${r.flagged.length ? `${r.flagged.length} look like bots (${r.flagged.slice(0, 8).join(", ")}${r.flagged.length > 8 ? ", …" : ""}).` : "none look like bots."}`, anchor: "followbots" };
    }
    return { ok: true, message: `Checked the newest ${r.scanned} followers and removed ${r.removed} follow bot${r.removed === 1 ? "" : "s"}.`, anchor: "followbots" };
  }
  return null;
}

// ── Activity feed ───────────────────────────────────────────────────────────

type Src = "filters" | "autoban" | "hateraid" | "followbots" | "mods";
const SRC_LABELS: Record<Src, string> = { filters: "Spam filters", autoban: "Auto-ban", hateraid: "Hate raid", followbots: "Follow bots", mods: "Mods" };
const KIND_LABELS: Record<string, string> = { unban: "unbanned", unblock: "unblocked", shield: "Shield Mode", chatmode: "chat mode", offlinelock: "offline lock", strikes: "strikes cleared", settings: "switch" };
type Row = { at: number; src: Src; login: string; userId: string; action: string; detail: string; undo: "" | "unban" | "unblock"; by: string };

async function activity(broadcasterId: string): Promise<Row[]> {
  const [filters, bans, mods, blocks] = await Promise.all([
    listAutoModLog(broadcasterId, 100),
    listBans(broadcasterId, 100),
    listModActions(broadcasterId, 100),
    listFollowBotBlocks(broadcasterId, 100),
  ]);
  const rows: Row[] = [];
  for (const e of filters) {
    const timed = /^(banned|timed out)/.test(e.action);
    rows.push({ at: e.at, src: "filters", login: e.login, userId: "", action: e.action, detail: `${e.filter}: ${e.message}`, undo: timed ? "unban" : "", by: "GuildScribe" });
  }
  for (const b of bans.refs) {
    if (b.source === "twitch") continue; // imported from Twitch's ban list, not something GuildScribe did
    rows.push({ at: b.bannedAt, src: "autoban", login: b.login, userId: b.userId, action: "banned", detail: [b.reason, b.message].filter(Boolean).join(" — "), undo: "unban", by: "GuildScribe" });
  }
  for (const m of mods) {
    if (m.kind === "hateraid") rows.push({ at: m.at, src: "hateraid", login: m.login, userId: m.userId, action: "banned", detail: m.detail, undo: "unban", by: m.by });
    else if (m.kind === "ban" || m.kind === "timeout") {
      const [action, ...reason] = m.detail.split(" — ");
      rows.push({ at: m.at, src: "mods", login: m.login, userId: m.userId, action, detail: reason.join(" — "), undo: m.userId ? "unban" : "", by: m.by });
    } else rows.push({ at: m.at, src: "mods", login: m.login, userId: m.userId, action: KIND_LABELS[m.kind] ?? m.kind, detail: m.detail, undo: "", by: m.by });
  }
  for (const f of blocks) {
    rows.push({ at: f.blockedAt, src: "followbots", login: f.login, userId: f.userId, action: f.source === "scan" ? "blocked (scan)" : "blocked", detail: f.reasons, undo: "unblock", by: "GuildScribe" });
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, 200);
}

function fmtDuration(s: number): string {
  if (s % 86400 === 0) return `${s / 86400} day${s === 86400 ? "" : "s"}`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < DAY_MS / 1000) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

// ── Page ────────────────────────────────────────────────────────────────────

const CSS = `${LEDGER_CSS}
.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}
.dash-top .links{display:flex;flex-wrap:wrap;gap:8px}
.grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,400px),1fr))}
form.inline{display:inline}
.live-badge{display:inline-block;margin-left:8px;padding:2px 10px;border-radius:999px;font:700 .72rem var(--display);letter-spacing:.1em;vertical-align:middle}
.live-badge.on{background:#b3261e;color:#fff}.live-badge.off{background:#cdbf98;color:var(--ink-3)}
.rows{display:flex;flex-direction:column;gap:2px;margin-top:8px}
.rowline{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px dotted var(--rule)}
.rowline:last-child{border-bottom:0}.rowline .what{flex:1;min-width:0}.rowline .what .small{display:block}
.state{font:700 .72rem var(--display);letter-spacing:.08em;text-transform:uppercase;padding:2px 9px;border-radius:999px;border:1px solid var(--edge);white-space:nowrap}
.state.on{background:var(--ok-bg);color:var(--ok);border-color:#92a470}.state.off{background:#dccea8;color:var(--ink-3)}
.rowline button{padding:6px 12px;font-size:.8rem}
.qa{display:grid;grid-template-columns:1fr 1fr;gap:8px}.qa label{display:flex;flex-direction:column;gap:4px;font-size:.86rem}.qa .full{grid-column:1/-1}
.qa input,.qa select{padding:9px 10px}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:10px 0}
.chips button{padding:5px 12px;font-size:.78rem}.chips button[aria-pressed="false"]{background:transparent;color:var(--seal-dk);border-color:var(--edge);box-shadow:none}
.chips .search{flex:1 1 200px;margin:0;padding:8px 12px;width:auto}
.chips label{font-size:.84rem;display:flex;gap:6px;align-items:center}
#activity-box table{min-width:780px}
td.when{white-space:nowrap}td.detail{overflow-wrap:anywhere;font-size:.86rem;min-width:200px;max-width:420px}
.src{font:700 .68rem var(--display);letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.src.hateraid{color:#b3261e}.src.followbots{color:#5b4fa0}.src.autoban{color:#8a3b12}.src.filters{color:#7a5a12}.src.mods{color:var(--ok)}
td.undo button{padding:5px 10px;font-size:.76rem}
.warnbox{border-color:#c98f78;background:linear-gradient(180deg,#f0d9c8,#e8cbb4)}
.muted-note{color:var(--ink-3);font-size:.86rem}
@media (max-width:640px){.qa{grid-template-columns:1fr}}`;

export async function renderModCenterPage(d: { broadcasterId: string; broadcasterName: string; key: string; notice?: string; error?: string }): Promise<string> {
  const id = d.broadcasterId;
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(id)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const qs = `channel=${encodeURIComponent(id)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);
  const post = (intent: string, label: string, fields: Record<string, string> = {}, cls = "ghost", confirm = "") =>
    `<form method="post" action="/dashboard/mod" class="inline"${confirm ? ` onsubmit="return confirm('${escapeHtml(confirm)}')"` : ""}>${hidden}<input type="hidden" name="intent" value="${intent}">${
      Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join("")}<button type="submit" class="${cls}">${label}</button></form>`;

  const [b, tokenRow, toggles, lock, rows, strikeRows] = await Promise.all([
    getBroadcaster(id),
    getBroadcasterAdToken(id),
    Promise.all(TOGGLES.map((t) => getToggle(id, t.key))),
    getLock(id),
    activity(id),
    sqlite.execute("SELECT login, strikes, last_at FROM automod_strikes WHERE broadcaster_id = ? AND last_at > ? ORDER BY last_at DESC LIMIT 25", [id, Date.now() - DAY_MS]).then((r) => r.rows as any[]),
  ]);
  const granted = new Set(String(tokenRow?.scope ?? "").split(/\s+/).filter(Boolean));
  const [settings, shield] = await Promise.all([getChatSettings(id), granted.has(SHIELD_SCOPE) ? getShieldMode(id) : Promise.resolve(null)]);
  const live = Number(b?.is_live) === 1;

  // Missing permissions
  const missing = PERMISSIONS.filter((p) => !granted.has(p.scope));
  const permCard = missing.length
    ? `<section class="card warnbox" id="permissions"><h3>Missing permissions</h3><p>GuildScribe can't do these yet: ${missing.map((m) => escapeHtml(m.feature)).join("; ")}.</p><p>The <strong>broadcaster</strong> needs to reconnect once and approve the new permissions — it keeps all settings and data.</p><p><a class="btn ember" href="/connect">Reconnect GuildScribe</a></p></section>`
    : "";

  // Stats (last 24 h)
  const day = rows.filter((r) => Date.now() - r.at < DAY_MS);
  const bans = day.filter((r) => r.action.startsWith("banned")).length;
  const timeouts = day.filter((r) => /^(timed out|purged|deleted)/.test(r.action)).length;
  const bots = day.filter((r) => r.src === "followbots").length;
  const raids = new Set(day.filter((r) => r.src === "hateraid").map((r) => Math.floor(r.at / 600_000))).size;
  const stat = (n: number, label: string) => `<div class="stat"><b>${n}</b>${label}</div>`;
  const stats = `<div class="stats" id="stats">${stat(bans, "bans")}${stat(timeouts, "timeouts &amp; deletes")}${stat(bots, "follow bots removed")}${stat(raids, raids === 1 ? "hate raid" : "hate raids")}${stat(strikeRows.length, "chatters with strikes")}<div class="stat muted-note" style="align-self:center">last 24 hours</div></div>`;

  // Chat right now
  const stateTag = (on: boolean | null | undefined) => on === null || on === undefined ? `<span class="state off">unknown</span>` : `<span class="state ${on ? "on" : "off"}">${on ? "on" : "off"}</span>`;
  const shieldLine = `<div class="rowline"><div class="what"><strong>Shield Mode</strong><span class="small muted">Twitch's lockdown: stricter AutoMod, chat restrictions and bans by term.</span></div>${stateTag(shield)}${
    granted.has(SHIELD_SCOPE) ? post("shield", shield ? "Turn off" : "Turn on", { on: shield ? "0" : "1" }, shield ? "ghost" : "ember", shield ? "" : "Turn on Shield Mode now?") : `<span class="muted small">needs permission</span>`}</div>`;
  const modeLines = CHAT_MODES.map((m) => {
    const on = settings ? Boolean(settings[m.field]) : null;
    const extra = m.field === "slow_mode" && settings?.slow_mode ? ` (${settings.slow_mode_wait_time}s)` : m.field === "follower_mode" && settings?.follower_mode ? ` (${settings.follower_mode_duration ?? 0} min)` : "";
    const fields: Record<string, string> = { field: String(m.field), on: on ? "0" : "1" };
    if (m.field === "slow_mode") fields.seconds = "30";
    return `<div class="rowline"><div class="what"><strong>${m.label}</strong>${extra ? `<span class="small muted">${escapeHtml(extra.trim())}</span>` : ""}</div>${stateTag(on)}${
      granted.has(CHAT_SETTINGS_SCOPE) ? post("chatmode", on ? "Turn off" : "Turn on", fields) : `<span class="muted small">needs permission</span>`}</div>`;
  }).join("");
  const liveCard = `<section class="card" id="live"><h3>Chat right now</h3>${settings ? "" : `<p class="muted-note">Couldn't read the chat settings from Twitch.</p>`}<div class="rows">${shieldLine}${modeLines}</div></section>`;

  // Protections
  const toggleLines = TOGGLES.map((t, i) => `<div class="rowline"><div class="what"><strong>${t.label}</strong><span class="small muted">${escapeHtml(t.help)}</span></div>${stateTag(toggles[i])}${post("toggle", toggles[i] ? "Turn off" : "Turn on", { feature: t.key, on: toggles[i] ? "0" : "1" }, toggles[i] ? "ghost" : "ember")}</div>`).join("");
  const lockMode = lock?.enabled ? lock.mode : "off";
  const lockOptions = [["off", "Off"], ...Object.entries(LOCK_LABELS)].map(([v, l]) => `<option value="${v}"${v === lockMode ? " selected" : ""}>${escapeHtml(l)}</option>`).join("");
  const lockLine = `<div class="rowline"><div class="what"><strong>Offline lock</strong><span class="small muted">Locks chat 5 minutes after the stream ends; unlocked when you go live.${lock?.applied ? ` Active now: ${escapeHtml(LOCK_LABELS[lock.applied as LockMode] ?? lock.applied)}.` : ""}</span></div><form method="post" action="/dashboard/mod" class="inline">${hidden}<input type="hidden" name="intent" value="offlinelock"><select name="mode" aria-label="Offline lock mode">${lockOptions}</select> <button type="submit" class="ghost">Save</button></form></div>`;
  const protCard = `<section class="card" id="protections"><h3>Protections</h3><div class="rows">${toggleLines}${lockLine}</div><p class="small" style="margin-bottom:0"><a href="/dashboard/autoban?${qs}">🔨 Auto-ban words</a> · <a href="/dashboard/autoban?${qs}#spam-filters">Spam filter settings</a> · <a href="/dashboard/botcheck?${qs}">🤖 Bot viewer check</a> · <a href="/dashboard/bots?${qs}">🧾 Bot list</a></p></section>`;

  // Quick action
  const quickCard = `<section class="card" id="quick"><h3>Quick action</h3><form method="post" action="/dashboard/mod" class="qa">${hidden}<input type="hidden" name="intent" value="action">
<label>Username<input type="text" name="login" required maxlength="26" autocomplete="off" placeholder="username"></label>
<label>Action<select name="what"><option value="60">Timeout 1 min</option><option value="600" selected>Timeout 10 min</option><option value="3600">Timeout 1 hour</option><option value="86400">Timeout 1 day</option><option value="ban">Ban</option><option value="unban">Unban / lift timeout</option><option value="strikes">Clear spam-filter strikes</option></select></label>
<label class="full">Reason <span class="muted small">(optional, shown to the user by Twitch)</span><input type="text" name="reason" maxlength="200" autocomplete="off"></label>
<div class="full"><button type="submit" class="ember">Apply</button></div></form></section>`;

  // Follow bots
  const fbCard = `<section class="card" id="followbots"><h3>Follow bots</h3><p class="muted-note">Scores the newest 1,000 followers like the bot viewer check (brand-new account, default picture, generated-looking name). Removing blocks them, which removes their follow; undo any row in Activity.</p><p>${post("checkbots", "Check followers")} ${post("removebots", "Remove bots", {}, "ember", "Block every follower that looks like a bot?")}</p></section>`;

  // Strikes
  const strikesTable = strikeRows.length
    ? `<div class="table-wrap"><table><thead><tr><th>Chatter</th><th class="num">Strikes</th><th>Last offense</th><th></th></tr></thead><tbody>${strikeRows.map((r) =>
      `<tr><td>${escapeHtml(String(r.login))}</td><td class="num">${Number(r.strikes)}</td><td class="when" title="${new Date(Number(r.last_at)).toISOString()}">${ago(Number(r.last_at))}</td><td class="undo">${post("clearstrikes", "Clear", { login: String(r.login) })}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="muted-note">Nobody has spam-filter strikes from the last 24 hours.</p>`;

  // Activity
  const srcCounts = new Map<Src, number>();
  for (const r of rows) srcCounts.set(r.src, (srcCounts.get(r.src) ?? 0) + 1);
  const chips = `<div class="chips" role="group" aria-label="Filter activity"><button type="button" data-src="all" aria-pressed="true">All (${rows.length})</button>${
    (Object.keys(SRC_LABELS) as Src[]).filter((s) => srcCounts.get(s)).map((s) => `<button type="button" data-src="${s}" aria-pressed="false">${SRC_LABELS[s]} (${srcCounts.get(s)})</button>`).join("")
  }<input type="search" class="search" id="who" placeholder="Filter by username" aria-label="Filter by username"><label><input type="checkbox" id="autorefresh" checked> Auto-refresh</label></div>`;
  const activityRows = rows.map((r) => {
    const undo = r.undo === "unban"
      ? post("unban", r.action.startsWith("timed out") ? "Lift timeout" : "Unban", { user_id: r.userId, login: r.login }, "ghost", `Unban ${r.login}?`)
      : r.undo === "unblock" ? post("unblock", "Unblock", { user_id: r.userId, login: r.login }, "ghost", `Unblock ${r.login}? They'll need to follow again.`) : "";
    return `<tr data-src="${r.src}" data-who="${escapeHtml(r.login)}"><td class="when" title="${new Date(r.at).toISOString()}">${ago(r.at)}</td><td><span class="src ${r.src}">${SRC_LABELS[r.src]}</span></td><td>${escapeHtml(r.login || "—")}</td><td>${escapeHtml(r.action)}${r.src === "mods" ? `<div class="muted small">${escapeHtml(r.by)}</div>` : ""}</td><td class="detail">${escapeHtml(r.detail.slice(0, 220))}</td><td class="undo">${undo}</td></tr>`;
  }).join("");
  const activityTable = rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Source</th><th>User</th><th>Action</th><th>Detail</th><th></th></tr></thead><tbody id="activity-rows">${activityRows}</tbody></table></div><p class="muted-note" id="none" hidden>Nothing matches that filter.</p>`
    : `<p class="muted-note">Nothing yet. Bans, timeouts, deletes and blocks by GuildScribe or from this page show up here.</p>`;

  const body = `<header class="dash-top"><div><span class="pill">Mod center</span><h1>${name}<span class="live-badge ${live ? "on" : "off"}">${live ? "LIVE" : "OFFLINE"}</span></h1></div><span class="links"><a class="btn ghost" href="/dashboard/autoban?${qs}">🔨 Auto-ban &amp; spam filters</a><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></span></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
${permCard}
${stats}
<div class="grid">${liveCard}${protCard}${quickCard}${fbCard}</div>
<h2 id="strikes">Chatters with strikes</h2>${strikesTable}
<h2 id="activity">Activity</h2>${rows.length ? chips : ""}<div id="activity-box">${activityTable}</div>
<script>
(function(){
  var src="all";
  function apply(){
    var q=(document.getElementById("who")||{}).value||"";q=q.toLowerCase().replace(/^@/,"");
    var rows=document.querySelectorAll("#activity-rows tr"),shown=0;
    [].forEach.call(rows,function(r){var ok=(src==="all"||r.getAttribute("data-src")===src)&&(!q||r.getAttribute("data-who").indexOf(q)>=0);r.hidden=!ok;if(ok)shown++});
    var none=document.getElementById("none");if(none)none.hidden=shown>0||!rows.length;
  }
  document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest(".chips button[data-src]");if(!b)return;src=b.getAttribute("data-src");[].forEach.call(document.querySelectorAll(".chips button[data-src]"),function(x){x.setAttribute("aria-pressed",String(x===b))});apply()});
  var who=document.getElementById("who");if(who)who.addEventListener("input",apply);
  var auto=document.getElementById("autorefresh");
  try{if(localStorage.getItem("modcenter.autorefresh")==="0"&&auto)auto.checked=false}catch(_){}
  if(auto)auto.addEventListener("change",function(){try{localStorage.setItem("modcenter.autorefresh",auto.checked?"1":"0")}catch(_){}});
  setInterval(function(){
    if(!auto||!auto.checked||document.hidden)return;
    var u=new URL(location.href);u.searchParams.delete("notice");u.searchParams.delete("error");
    fetch(u.toString(),{credentials:"same-origin"}).then(function(r){return r.ok?r.text():null}).then(function(html){
      if(!html)return;var doc=new DOMParser().parseFromString(html,"text/html");
      ["activity-box","stats"].forEach(function(id){var a=document.getElementById(id),b=doc.getElementById(id);if(a&&b)a.innerHTML=b.innerHTML});
      apply();
    }).catch(function(){});
  },30000);
})();
</script>`;
  return scrollDoc(`${name} — Mod center`, body, { width: 1200, css: CSS });
}

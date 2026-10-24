// GuildScribe — on-screen alerts: a card and a fanfare on stream for new
// followers, subs, resubs, gift subs, raids, cheers and tips.
//
//   GET /overlay?channel=<id|login>&panel=alerts     the overlay (1920×1080, see-through)
//       &volume=0-100  &sound=0 (card only)  &messages=0 (leave viewers' messages off)
//       &position=top|center|bottom  &seconds=<3-20> (how long each card stays)
//       &test=follow|sub|resub|gift|raid|cheer|tip (plays one on load)
//   GET /overlay/alerts?channel=<id|login>&after=<id> the alerts after <id> (the overlay polls it);
//       &after=-1 (first poll) only answers the newest id, so nothing old replays
//   !alerts                         mod/broadcaster: the overlay link and whether alerts are on
//   !alert test [kind]              mod/broadcaster: send a test alert to the overlay
//   !alert tip <name> <amount> [message]
//                                   mod/broadcaster: show a tip alert by hand (for tips through a
//                                   link that can't report back — see tips.ts)
//
// main.ts calls pushAlert from its EventSub handlers (channel.follow,
// channel.subscribe/.subscription.message/.subscription.gift, channel.raid,
// channel.cheer), after the same connected / enabled / not-blocked checks as
// the chat thank-yous but independent of their switches — a streamer can have
// the card without the chat line, or both. Alerts don't wait for the stream to
// be live, so a streamer can test before going live; the overlay only shows
// alerts newer than when it loaded and at most ALERT_FRESH_MS old, so an OBS
// source that reloads never replays a backlog.
//
// Dashboard switch "alerts" (off by default): off stops new alerts and turns
// the overlay into an empty source that checks back every minute. Each card's
// sound is played by the Sound Bytes synth (soundbytes.ts), so there are no
// audio files to host. Viewer text (names, messages) only ever reaches the
// page through textContent.

import { sqlite } from "./sqlite.ts";
import { createCheerEventSubscription, env, sendChatMessage } from "./twitch.ts";
import { getBroadcaster, getCustomCommand, getExtraEventSubSubscriptions, isChannelBlocked, isChannelEnabled, isCommandGroupEnabled, recordMonitorEvent, saveExtraEventSubSubscription } from "./db.ts";
import { isChannelBot } from "./channel_bots.ts";
import { getBroadcasterAdToken } from "./ads_db.ts";
import { escapeHtml } from "./utils.ts";
import { PUBLIC_BASE_URL } from "./config.ts";
import { SOUND_BYTES, SOUND_SYNTH_JS } from "./soundbytes.ts";

export const ALERT_KINDS = ["follow", "sub", "resub", "gift", "raid", "cheer", "tip"] as const;
export type AlertKind = typeof ALERT_KINDS[number];

/** An alert older than this is never shown (an OBS source that was closed doesn't replay). */
const ALERT_FRESH_MS = 2 * 60_000;
/** Rows are kept a day for the dashboard's "recent alerts", then pruned. */
const ALERT_KEEP_MS = 24 * 60 * 60_000;
const MAX_MESSAGE = 200;
const FOLLOW_ALERTS_PER_MINUTE = 5;
export const CHEER_SCOPE = "bits:read";

export type AlertInput = {
  kind: AlertKind;
  /** Who it's from (display name); "" for an anonymous gifter. */
  name: string;
  /** Months (resub), subs (gift), viewers (raid), bits (cheer). */
  amount?: number;
  /** Sub tier "1000"/"2000"/"3000"; a tip's amount as typed ("$5", "€10"). */
  detail?: string;
  /** The viewer's own words (resub message, cheer message, tip note). */
  message?: string;
};

export async function ensureAlertTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS stream_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, broadcaster_id TEXT NOT NULL, kind TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute("CREATE INDEX IF NOT EXISTS stream_alerts_channel ON stream_alerts (broadcaster_id, id)");
}

export async function purgeAlertData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM stream_alerts WHERE broadcaster_id = ?", [broadcasterId]);
}

/** Cheer emotes ("Cheer100", "Kappa50") are the bits themselves, not words: left off the card. */
const stripCheermotes = (text: string) => text.replace(/(?:^|\s)[A-Za-z]+\d+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();

/** Queues an alert for the channel's overlay; false when alerts are switched off. */
export async function pushAlert(broadcasterId: string, a: AlertInput): Promise<boolean> {
  if (!(await isCommandGroupEnabled(broadcasterId, "alerts"))) return false;
  const now = Date.now();
  const message = (a.kind === "cheer" ? stripCheermotes(a.message ?? "") : String(a.message ?? "").trim()).slice(0, MAX_MESSAGE);
  await sqlite.execute(
    "INSERT INTO stream_alerts (broadcaster_id, kind, name, amount, detail, message, created_at) VALUES (?,?,?,?,?,?,?)",
    [broadcasterId, a.kind, a.name.slice(0, 40), Math.max(0, Math.floor(Number(a.amount ?? 0))), String(a.detail ?? "").slice(0, 20), message, now],
  );
  await sqlite.execute("DELETE FROM stream_alerts WHERE broadcaster_id = ? AND created_at < ?", [broadcasterId, now - ALERT_KEEP_MS]);
  return true;
}

const TIER: Record<string, string> = { "1000": "Tier 1", "2000": "Tier 2", "3000": "Tier 3", prime: "Prime" };
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** What the card says, and which Sound Bytes sound plays with it. */
export function alertCard(a: AlertInput): { icon: string; title: string; line: string; message: string; sound: string } {
  const name = a.name || "An anonymous patron";
  const n = Number(a.amount ?? 0);
  const tier = TIER[String(a.detail ?? "").toLowerCase()] ?? "";
  const message = a.message ?? "";
  switch (a.kind) {
    case "follow": return { icon: "🛡️", title: "New follower", line: `${name} joins the guild!`, message: "", sound: "ding" };
    case "sub": return { icon: "⭐", title: "New subscriber", line: `${name} pledged their sword${tier ? ` · ${tier}` : ""}!`, message: "", sound: "nat20" };
    case "resub": return { icon: "⭐", title: `${plural(Math.max(1, n), "month")} strong`, line: `${name} renewed their oath${tier ? ` · ${tier}` : ""}!`, message, sound: "nat20" };
    case "gift": return { icon: "🎁", title: `${plural(Math.max(1, n), "gift sub")}`, line: `${name} shared the treasure${tier ? ` · ${tier}` : ""}!`, message: "", sound: "coins" };
    case "raid": return { icon: "🐉", title: "Raid!", line: `${name} storms the hall with ${plural(n, "adventurer")}!`, message: "", sound: "roar" };
    case "cheer": return { icon: "💎", title: plural(Math.max(1, n), "bit"), line: `${name} tossed gems to the bard!`, message, sound: "coins" };
    case "tip": return { icon: "🪙", title: a.detail ? `${a.detail} tip` : "A tip", line: `${name} filled the tip jar!`, message, sound: "coins" };
  }
}

/** The overlay's poll. after < 0: just the newest id (nothing old is replayed). */
export async function getAlertsAfter(broadcasterId: string, after: number) {
  if (after < 0) {
    const res = await sqlite.execute("SELECT MAX(id) AS last FROM stream_alerts WHERE broadcaster_id = ?", [broadcasterId]);
    return { last: Number(res.rows[0]?.last ?? 0), alerts: [] };
  }
  const res = await sqlite.execute(
    "SELECT id, kind, name, amount, detail, message, created_at FROM stream_alerts WHERE broadcaster_id = ? AND id > ? ORDER BY id LIMIT 10",
    [broadcasterId, after],
  );
  const rows = res.rows as any[];
  const fresh = Date.now() - ALERT_FRESH_MS;
  const alerts = rows
    .filter((r) => Number(r.created_at) >= fresh && (ALERT_KINDS as readonly string[]).includes(String(r.kind)))
    .map((r) => ({
      id: Number(r.id),
      kind: String(r.kind),
      ...alertCard({ kind: String(r.kind) as AlertKind, name: String(r.name), amount: Number(r.amount), detail: String(r.detail), message: String(r.message) }),
    }));
  return { last: rows.length ? Number(rows[rows.length - 1].id) : after, alerts };
}

// ── EventSub events that need more than pushAlert ───────────────────────────

/** Same gate as main.ts's sub/raid handlers: connected, switched on, not blocked. */
async function channelTakesAlerts(broadcasterId: string): Promise<boolean> {
  const b = await getBroadcaster(broadcasterId);
  if (!b || Number(b.connected) !== 1) return false;
  const [on, blocked] = await Promise.all([isChannelEnabled(broadcasterId), isChannelBlocked(broadcasterId)]);
  return on && !blocked;
}

/** channel.follow (after followbots.ts let it through). An unfollow/refollow
 * loop gets one card a day, and a follow wave at most FOLLOW_ALERTS_PER_MINUTE. */
// deno-lint-ignore no-explicit-any
export async function onFollowAlert(event: any) {
  const broadcasterId = String(event?.broadcaster_user_id ?? "");
  const login = String(event?.user_login ?? "");
  const display = String(event?.user_name ?? login);
  if (!broadcasterId || !login || await isChannelBot(broadcasterId, login, String(event?.user_id ?? ""), env("TWITCH_BOT_ID"))) return;
  if (!(await channelTakesAlerts(broadcasterId))) return;
  const res = await sqlite.execute(
    `SELECT
       (SELECT COUNT(*) FROM stream_alerts WHERE broadcaster_id = ? AND kind = 'follow' AND name = ? COLLATE NOCASE) AS seen,
       (SELECT COUNT(*) FROM stream_alerts WHERE broadcaster_id = ? AND kind = 'follow' AND created_at > ?) AS recent`,
    [broadcasterId, display, broadcasterId, Date.now() - 60_000],
  );
  if (Number(res.rows[0]?.seen ?? 0) > 0 || Number(res.rows[0]?.recent ?? 0) >= FOLLOW_ALERTS_PER_MINUTE) return;
  await pushAlert(broadcasterId, { kind: "follow", name: display });
}

/** channel.cheer: anonymous cheers come without a name. */
// deno-lint-ignore no-explicit-any
export async function onCheerAlert(event: any) {
  const broadcasterId = String(event?.broadcaster_user_id ?? "");
  if (!broadcasterId || !(await channelTakesAlerts(broadcasterId))) return;
  const anonymous = Boolean(event?.is_anonymous);
  await pushAlert(broadcasterId, {
    kind: "cheer",
    name: anonymous ? "" : String(event?.user_name ?? event?.user_login ?? ""),
    amount: Number(event?.bits ?? 0),
    message: String(event?.message ?? ""),
  });
}

// ── Cheers (channel.cheer) ──────────────────────────────────────────────────
// Needs bits:read, an optional /connect scope (channel_status.ts), so
// channels connected before it existed get the subscription lazily when they
// go live, once they've reconnected with the scope — like follow_thanks.ts.

export async function subscribeToCheers(broadcasterId: string, callbackUrl: string) {
  const sub = await createCheerEventSubscription(broadcasterId, callbackUrl);
  await saveExtraEventSubSubscription(broadcasterId, "cheer", sub.id);
}

/** stream.online: subscribe a channel to cheers if its token carries bits:read and it isn't yet. */
export async function ensureCheerSubscription(broadcasterId: string, callbackUrl: string) {
  const extras = await getExtraEventSubSubscriptions(broadcasterId);
  if (extras.some((s) => s.kind === "cheer")) return;
  const token = await getBroadcasterAdToken(broadcasterId);
  if (!String(token?.scope ?? "").split(/\s+/).includes(CHEER_SCOPE)) return;
  try {
    await subscribeToCheers(broadcasterId, callbackUrl);
  } catch (e) {
    await recordMonitorEvent("eventsub_cheer_backfill_failed", `${broadcasterId}: ${String(e)}`);
  }
}

// ── Chat ────────────────────────────────────────────────────────────────────

const TEST_ALERTS: Record<AlertKind, AlertInput> = {
  follow: { kind: "follow", name: "Sir Testalot" },
  sub: { kind: "sub", name: "Sir Testalot", detail: "1000" },
  resub: { kind: "resub", name: "Sir Testalot", amount: 12, detail: "1000", message: "A year in the guild already!" },
  gift: { kind: "gift", name: "Sir Testalot", amount: 5, detail: "1000" },
  raid: { kind: "raid", name: "Sir Testalot", amount: 42 },
  cheer: { kind: "cheer", name: "Sir Testalot", amount: 500, message: "For the bard!" },
  tip: { kind: "tip", name: "Sir Testalot", detail: "$5.00", message: "Buy the party a round." },
};

const overlayLink = (channelKey: string) => `${PUBLIC_BASE_URL}/overlay?channel=${encodeURIComponent(channelKey)}&panel=alerts`;

export async function handleAlertCommand(chatMessage: string, display: string, broadcasterId: string, channelKey: string, isModerator: boolean): Promise<boolean> {
  const match = chatMessage.trim().match(/^!(alerts?)(?:\s+([\s\S]*))?$/i);
  if (!match) return false;
  // A channel's own !alert / !alerts custom command wins.
  if (await getCustomCommand(broadcasterId, match[1].toLowerCase())) return false;
  if (!isModerator) return false;
  const on = await isCommandGroupEnabled(broadcasterId, "alerts");
  const arg = (match[2] ?? "").trim();
  const offNote = "Alerts are off — turn on \"On-screen alerts\" on the dashboard (or !feature alerts on).";

  if (!arg || /^(status|link|help)$/i.test(arg)) {
    await sendChatMessage(`@${display} 🔔 On-screen alerts are ${on ? "on" : "off"}. Add this as an OBS Browser source (1920×1080, tick Control audio via OBS): ${overlayLink(channelKey)} · Test with !alert test [follow|sub|resub|gift|raid|cheer|tip].`, broadcasterId);
    return true;
  }
  const test = arg.match(/^test(?:\s+(\w+))?$/i);
  if (test) {
    if (!on) { await sendChatMessage(`@${display} ${offNote}`, broadcasterId); return true; }
    const kind = (test[1] ?? "follow").toLowerCase() as AlertKind;
    if (!(ALERT_KINDS as readonly string[]).includes(kind)) {
      await sendChatMessage(`@${display} usage: !alert test [${ALERT_KINDS.join("|")}].`, broadcasterId);
      return true;
    }
    await pushAlert(broadcasterId, TEST_ALERTS[kind]);
    await sendChatMessage(`@${display} 🔔 Test ${kind} alert sent — it shows on the alerts overlay within a few seconds.`, broadcasterId);
    return true;
  }
  const tip = arg.match(/^tip\s+@?(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/i);
  if (tip) {
    if (!on) { await sendChatMessage(`@${display} ${offNote}`, broadcasterId); return true; }
    const amount = tip[2];
    if (!/^[$€£¥]?\d{1,7}(?:[.,]\d{1,2})?(?:[$€£¥]|\s?[A-Za-z]{3})?$/.test(amount)) {
      await sendChatMessage(`@${display} usage: !alert tip <name> <amount> [message] — e.g. !alert tip Gandalf $5 Thanks for the stream!`, broadcasterId);
      return true;
    }
    await pushAlert(broadcasterId, { kind: "tip", name: tip[1], detail: amount, message: tip[3] ?? "" });
    await sendChatMessage(`@${display} 🪙 Tip alert for ${tip[1]} (${amount}) sent to the overlay.`, broadcasterId);
    return true;
  }
  await sendChatMessage(`@${display} usage: !alerts (link) · !alert test [kind] · !alert tip <name> <amount> [message].`, broadcasterId);
  return true;
}

// ── The overlay ─────────────────────────────────────────────────────────────

/** See-through until an alert comes in, then a card (and its sound) for a few
 * seconds each, one after another. `always` (setup-page preview) shows a
 * sample card and never polls. */
export function renderAlertsOverlay(channelKey: string, always: boolean): string {
  const cfg = {
    channel: channelKey,
    always,
    tests: Object.fromEntries(ALERT_KINDS.map((k) => [k, { id: 0, kind: k, ...alertCard(TEST_ALERTS[k]) }])),
    // Sound lengths (seconds) for the synth.
    len: Object.fromEntries(SOUND_BYTES.map((s) => [s.id, s.len])),
  };
  const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Alerts · ${escapeHtml(channelKey)}</title><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700;800&family=Inter:wght@500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:transparent;overflow:hidden;height:100%}
body{font-family:Inter,system-ui,sans-serif;color:#f1e6d6}
.stage{position:fixed;left:0;right:0;top:8vh;display:flex;justify-content:center;pointer-events:none}
.center .stage{top:0;bottom:0;align-items:center}
.bottom .stage{top:auto;bottom:8vh}
.card{position:relative;display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;min-width:min(90vw,520px);max-width:min(92vw,860px);padding:26px 40px 24px;border-radius:20px;
  background:linear-gradient(180deg,rgba(40,28,20,.95),rgba(20,15,11,.95));border:2px solid #e0a84a;
  box-shadow:0 14px 44px rgba(0,0,0,.6),0 0 40px rgba(224,168,74,.3);
  transform:translateY(-40px) scale(.85);opacity:0;transition:transform .45s cubic-bezier(.2,1.5,.4,1),opacity .35s}
.bottom .card{transform:translateY(40px) scale(.85)}
.card.show{transform:none;opacity:1}
.card::before,.card::after{content:"";position:absolute;top:50%;width:18px;height:18px;border:2px solid #e0a84a;background:#20160f;transform:translateY(-50%) rotate(45deg)}
.card::before{left:-11px}.card::after{right:-11px}
.icon{font-size:76px;line-height:1;filter:drop-shadow(0 0 18px rgba(245,200,115,.55));animation:none}
.card.show .icon{animation:bob 1.6s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
.title{font-family:Cinzel,serif;font-weight:800;font-size:22px;letter-spacing:.14em;text-transform:uppercase;color:#e6a56e}
.line{font-family:Cinzel,serif;font-weight:700;font-size:38px;line-height:1.15;color:#f5c873;overflow-wrap:anywhere}
.msg{font-size:21px;font-weight:500;color:#e9dcc8;margin-top:6px;max-width:760px;overflow-wrap:anywhere}
.msg:empty{display:none}
.msg::before{content:"“"}.msg::after{content:"”"}
</style></head><body>
<div class="stage"><div class="card" id="card" aria-live="polite"><div class="icon" id="icon"></div><div class="title" id="title"></div><div class="line" id="line"></div><div class="msg" id="msg"></div></div></div>
<script>${SOUND_SYNTH_JS}
(function(){
  const CFG=${cfgJson};
  const q=new URLSearchParams(location.search);
  const volume=Math.max(0,Math.min(100,Number(q.get("volume")??70)||0))/100;
  const sound=q.get("sound")!=="0",messages=q.get("messages")!=="0";
  const secs=Math.max(3,Math.min(20,Number(q.get("seconds"))||7));
  const pos=(q.get("position")||"top").toLowerCase();if(pos==="center"||pos==="bottom")document.body.classList.add(pos);
  const $=(id)=>document.getElementById(id),card=$("card");
  function show(a){$("icon").textContent=a.icon;$("title").textContent=a.title;$("line").textContent=a.line;$("msg").textContent=messages?a.message:"";card.classList.add("show")}
  if(CFG.always){show(CFG.tests.sub);return}
  const MAX_QUEUE=20,queue=[];let playing=false;
  function enqueue(a){if(queue.length>=MAX_QUEUE)return;queue.push(a);if(!playing)next()}
  function next(){const a=queue.shift();if(!a){playing=false;return}playing=true;show(a);
    if(sound&&CFG.len[a.sound])SoundSynth.play(a.sound,CFG.len[a.sound],volume);
    setTimeout(()=>card.classList.remove("show"),secs*1000);setTimeout(next,secs*1000+600)}
  let after=-1;
  async function poll(){try{const r=await fetch("/overlay/alerts?channel="+encodeURIComponent(CFG.channel)+"&after="+after,{cache:"no-store"});
    const d=await r.json();if(d&&d.ok){if(d.off){location.reload();return}after=d.last;(d.alerts||[]).forEach(enqueue)}}catch(e){}}
  poll();setInterval(poll,2500);
  const test=(q.get("test")||"").toLowerCase();
  if(CFG.tests[test])setTimeout(()=>enqueue(CFG.tests[test]),800);
})();
</script></body></html>`;
}

/** Switched off on the dashboard: an empty, transparent source that checks back every minute. */
export const ALERTS_OFF_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>Alerts (off)</title><style>html,body{background:transparent;margin:0}</style></head><body></body></html>`;

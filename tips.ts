// GuildScribe — the tip page: one public page with the streamer's own tip and
// donation links (PayPal.me, Ko-fi, Cash App, a Stripe Payment Link,
// StreamElements/Streamlabs tip pages, …), so chat has one place to go.
//
//   GET /tip/<login>  ·  GET /tip?channel=<id|login>   the public page
//   GET /dashboard/tips · POST /dashboard/tips          the links and a note (dashboard key + mod login; dashboard.ts)
//   !tip / !tips / !donate                              anyone: posts the page link
//
// Money never passes through GuildScribe: each button goes straight to the
// streamer's own page on that service, and the page says so. Because those
// services don't report back here, a tip's on-screen alert is announced by a
// mod with !alert tip <name> <amount> [message] (alerts.ts).
//
// Dashboard switch "tips" (off by default): off hides the page and silences
// !tip. A channel's own !tip/!tips/!donate custom command wins. Only https
// links are saved, and every label and link is escaped on the page.

import { sqlite } from "./sqlite.ts";
import { sendChatMessage } from "./twitch.ts";
import { getCustomCommand, isCommandGroupEnabled } from "./db.ts";
import { escapeHtml } from "./utils.ts";
import { PUBLIC_BASE_URL } from "./config.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

export const MAX_TIP_LINKS = 4;
const MAX_LABEL = 30;
const MAX_NOTE = 400;

type TipLink = { label: string; url: string };
type TipPage = { links: TipLink[]; note: string };

/** Icons (and a default label) for services streamers commonly use. */
const SERVICES: Array<{ re: RegExp; icon: string; name: string }> = [
  { re: /(^|\.)paypal\.(me|com)$/, icon: "💙", name: "PayPal" },
  { re: /(^|\.)ko-fi\.com$/, icon: "☕", name: "Ko-fi" },
  { re: /(^|\.)buymeacoffee\.com$/, icon: "☕", name: "Buy Me a Coffee" },
  { re: /(^|\.)cash\.app$/, icon: "💵", name: "Cash App" },
  { re: /(^|\.)venmo\.com$/, icon: "💸", name: "Venmo" },
  { re: /(^|\.)patreon\.com$/, icon: "🎨", name: "Patreon" },
  { re: /(^|\.)throne\.com$/, icon: "🎁", name: "Throne wishlist" },
  { re: /(^|\.)streamelements\.com$/, icon: "🪙", name: "Tip (StreamElements)" },
  { re: /(^|\.)streamlabs\.com$/, icon: "🪙", name: "Tip (Streamlabs)" },
  { re: /(^|\.)(buy\.)?stripe\.com$/, icon: "💳", name: "Card (Stripe)" },
];

const serviceFor = (url: string) => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SERVICES.find((s) => s.re.test(host)) ?? null;
  } catch (_) {
    return null;
  }
};

export async function ensureTipTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS tip_pages (
      broadcaster_id TEXT PRIMARY KEY, links TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '', updated_at INTEGER
    )`,
  );
}

export async function purgeTipData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM tip_pages WHERE broadcaster_id = ?", [broadcasterId]);
}

async function getTipPage(broadcasterId: string): Promise<TipPage> {
  const r = (await sqlite.execute("SELECT links, note FROM tip_pages WHERE broadcaster_id = ?", [broadcasterId])).rows[0] as any;
  let links: TipLink[] = [];
  try {
    links = (JSON.parse(String(r?.links ?? "[]")) as any[]).map((l) => ({ label: String(l.label ?? ""), url: String(l.url ?? "") })).filter((l) => l.url);
  } catch (_) { /* corrupt JSON — no links */ }
  return { links, note: String(r?.note ?? "") };
}

/** A typed link → a clean https URL, or why it's refused. */
function cleanUrl(raw: string): { url: string } | { error: string } {
  let text = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`; // "paypal.me/name" → https://paypal.me/name
  let u: URL;
  try { u = new URL(text); } catch (_) { return { error: `"${raw.slice(0, 60)}" isn't a link.` }; }
  if (u.protocol !== "https:") return { error: `Links must start with https:// ("${raw.slice(0, 60)}").` };
  if (!u.hostname.includes(".") || u.username || u.password) return { error: `"${raw.slice(0, 60)}" isn't a usable link.` };
  return { url: u.toString() };
}

export const tipPageUrl = (channelKey: string) => `${PUBLIC_BASE_URL}/tip/${encodeURIComponent(channelKey)}`;

// ── Chat ────────────────────────────────────────────────────────────────────

export async function handleTipCommand(chatMessage: string, display: string, broadcasterId: string, channelKey: string, channelName: string): Promise<boolean> {
  const match = chatMessage.trim().match(/^!(tips?|donate)$/i);
  if (!match) return false;
  const [on, custom] = await Promise.all([isCommandGroupEnabled(broadcasterId, "tips"), getCustomCommand(broadcasterId, match[1].toLowerCase())]);
  if (!on || custom) return false;
  const page = await getTipPage(broadcasterId);
  if (!page.links.length) {
    await sendChatMessage(`@${display} ${channelName} hasn't added any tip links yet.`, broadcasterId);
    return true;
  }
  await sendChatMessage(`@${display} 🪙 Support ${channelName} — every bit goes straight to them: ${tipPageUrl(channelKey)}`, broadcasterId);
  return true;
}

// ── Public page ─────────────────────────────────────────────────────────────

const PAGE_CSS = `${LEDGER_CSS}
.tips{display:grid;gap:12px;margin:18px 0}
a.tip{display:flex;align-items:center;gap:14px;padding:16px 20px;border:1px solid var(--edge);border-radius:10px;background:#efe5c8;color:inherit;text-decoration:none;font-size:1.15rem;font-weight:600;transition:transform .15s,box-shadow .15s}
a.tip:hover,a.tip:focus-visible{transform:translateY(-2px);box-shadow:0 6px 16px #6b44182b;border-color:var(--seal)}
a.tip .i{font-size:1.8rem;line-height:1}a.tip .h{margin-left:auto;font-size:.82rem;font-weight:400;color:var(--ink-3);overflow-wrap:anywhere;text-align:right}
.note-box{white-space:pre-line;padding:12px 16px;border-left:3px solid var(--seal);background:#f3ead0;border-radius:4px}
.muted{color:var(--ink-3)}.small{font-size:.86rem}
@media (max-width:520px){a.tip .h{display:none}}`;

export async function renderTipPage(channel: { id: string; name: string }): Promise<{ status: number; html: string }> {
  const name = escapeHtml(channel.name);
  const doc = (body: string) => scrollDoc(`Support ${channel.name}`, body, { width: 640, css: PAGE_CSS });
  if (!(await isCommandGroupEnabled(channel.id, "tips"))) {
    return { status: 404, html: doc(`<h1>${name}</h1><p class="muted">This channel's tip page is switched off.</p>`) };
  }
  const page = await getTipPage(channel.id);
  const buttons = page.links.map((l) => {
    const s = serviceFor(l.url);
    let host = "";
    try { host = new URL(l.url).hostname.replace(/^www\./, ""); } catch (_) { /* saved links always parse */ }
    return `<a class="tip" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer"><span class="i">${s?.icon ?? "🪙"}</span><span>${escapeHtml(l.label || s?.name || "Tip")}</span><span class="h">${escapeHtml(host)}</span></a>`;
  }).join("");
  return {
    status: 200,
    html: doc(`<span class="pill">Tip jar</span><h1>Support ${name}</h1>
${page.note ? `<p class="note-box">${escapeHtml(page.note)}</p>` : `<p>Thanks for wanting to support the stream!</p>`}
${buttons ? `<div class="tips">${buttons}</div>` : `<p class="muted">No tip links have been added yet.</p>`}
<p class="muted small">Each button opens ${name}'s own page on that service, and your tip goes straight to them. GuildScribe never sees or handles any money or payment details.</p>`),
  };
}

// ── Dashboard page (auth is done by the caller; see dashboard.ts) ──────────

export async function applyTipsForm(broadcasterId: string, form: FormData): Promise<{ ok: boolean; message: string }> {
  const links: TipLink[] = [];
  for (let i = 0; i < MAX_TIP_LINKS; i++) {
    const raw = String(form.get(`url${i}`) ?? "").trim();
    const label = String(form.get(`label${i}`) ?? "").trim().slice(0, MAX_LABEL);
    if (!raw) continue;
    const clean = cleanUrl(raw);
    if ("error" in clean) return { ok: false, message: clean.error };
    links.push({ label, url: clean.url });
  }
  const note = String(form.get("note") ?? "").trim().slice(0, MAX_NOTE);
  await sqlite.execute(
    `INSERT INTO tip_pages (broadcaster_id, links, note, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET links = excluded.links, note = excluded.note, updated_at = excluded.updated_at`,
    [broadcasterId, JSON.stringify(links), note, Date.now()],
  );
  return { ok: true, message: links.length ? `Saved ${links.length} tip link${links.length === 1 ? "" : "s"}.` : "Saved — no tip links on the page now." };
}

export async function renderTipsDashboardPage(d: { broadcasterId: string; broadcasterName: string; key: string; channelKey: string; notice?: string; error?: string }): Promise<string> {
  const [page, on] = await Promise.all([getTipPage(d.broadcasterId), isCommandGroupEnabled(d.broadcasterId, "tips")]);
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);
  const publicUrl = tipPageUrl(d.channelKey);
  const rows = Array.from({ length: MAX_TIP_LINKS }, (_, i) => {
    const l = page.links[i];
    return `<div class="row"><label>Button text<input name="label${i}" value="${escapeHtml(l?.label ?? "")}" maxlength="${MAX_LABEL}" placeholder="${i === 0 ? "e.g. Tip with PayPal" : "optional"}"></label>
<label>Link<input name="url${i}" value="${escapeHtml(l?.url ?? "")}" maxlength="300" placeholder="${["https://paypal.me/yourname", "https://ko-fi.com/yourname", "https://cash.app/$yourname", "https://streamelements.com/yourname/tip"][i]}" inputmode="url" autocomplete="off" spellcheck="false"></label></div>`;
  }).join("");
  const body = `<header class="dash-top"><div><span class="pill">Stream · Tip page</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>One page with all your tip and donation links, so chat can find them with <code>!tip</code> (or <code>!donate</code>). Paste the links you already have: PayPal.me, Ko-fi, Cash App, Venmo, a Stripe Payment Link, your StreamElements or Streamlabs tip page, a Throne wishlist and so on. Tips go straight to you through that service. GuildScribe never touches the money.</p>
${on ? `<p class="ok-line">✓ Your page is live: <a href="${escapeHtml(publicUrl)}" target="_blank" rel="noopener">${escapeHtml(publicUrl)}</a></p>` : `<p class="note">The page and <code>!tip</code> are off. Turn on "Tip page" on the dashboard (or type <code>!feature tips on</code>) once your links are in.</p>`}
<form method="post" action="/dashboard/tips"><input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">
<h2>Your links</h2><p class="muted small">Up to ${MAX_TIP_LINKS}. Leave the button text blank to use the service's name. Clear a link to remove it.</p>${rows}
<h2>A note for your viewers <span class="muted small">(optional)</span></h2><textarea name="note" maxlength="${MAX_NOTE}" rows="3" placeholder="e.g. Every tip goes toward a new mic. Thank you!">${escapeHtml(page.note)}</textarea>
<p><button type="submit" class="ember">Save tip page</button></p></form>
<h2>Tip alerts on stream</h2><p>These services don't tell GuildScribe when someone tips, so the alert is announced by hand. A mod types <code>!alert tip &lt;name&gt; &lt;amount&gt; [message]</code>, for example <code>!alert tip Gandalf $5 Thanks for the stream!</code>, and the Alerts overlay shows it with a fanfare. Turn on "On-screen alerts" and add the Alerts overlay from <a href="/overlays?channel=${encodeURIComponent(d.broadcasterId)}" target="_blank" rel="noopener">your overlay page</a>.</p>`;
  return scrollDoc(`${d.broadcasterName} — Tip page`, body, {
    width: 860,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}
.row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:10px;margin:10px 0}.row label{display:flex;flex-direction:column;gap:4px;font-weight:600;font-size:.9rem}.row input{padding:9px 12px;font-weight:400;min-width:0}
textarea{width:100%;padding:9px 12px;font:inherit}.ok-line{color:var(--ok);font-weight:600;overflow-wrap:anywhere}.muted{color:var(--ink-3)}.small{font-size:.86rem}
@media (max-width:560px){.row{grid-template-columns:1fr}}`,
  });
}

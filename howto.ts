// GuildScribe — the how-to guides and the Codex's "suggested pages for mods+".
//
//   GET /howto                      index of every how-to guide
//   GET /howto/<slug>               one step-by-step guide (content in howto_pages*.ts)
//   GET /go/<page>?channel=<login>  roster / bestiary / maps / overlays for a channel
//                                   by Twitch login (those pages take the numeric
//                                   id); with no channel it asks for one.
//
// renderGuideHowtoSection / renderGuideModPagesSection are the two sections
// guide.ts places at the top of the Guild Codex.

import { getBroadcaster, getBroadcasterByLogin } from "./db.ts";
import { escapeHtml } from "./utils.ts";
import { HOWTO_CSS, SCROLL_CSS, SCROLL_HEAD, scrollClose, scrollOpen } from "./scroll_theme.ts";
import { HOWTO_SETUP, type HowtoTopic } from "./howto_pages.ts";
import { HOWTO_PLAY } from "./howto_pages2.ts";

export const HOWTO_TOPICS: HowtoTopic[] = [...HOWTO_SETUP, ...HOWTO_PLAY];

/** Pages /go/<page> can open for a channel, and where each lives. */
const GO_PAGES: Record<string, { label: string; path: string }> = {
  overlays: { label: "OBS overlays", path: "/overlays" },
  roster: { label: "Guild roster", path: "/roster" },
  bestiary: { label: "Bestiary", path: "/bestiary" },
  maps: { label: "Battle maps", path: "/maps" },
};

function shell(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">${SCROLL_HEAD}<title>${escapeHtml(title)}</title><style>${SCROLL_CSS}${HOWTO_CSS}</style></head><body>${scrollOpen()}${body}${scrollClose}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function topicCard(t: HowtoTopic, linkClass = "btn"): string {
  return `<section class="card"><span class="pill">${escapeHtml(t.audience)}</span><h3 style="margin-top:8px">${escapeHtml(t.title)}</h3><p>${escapeHtml(t.summary)}</p><a class="${linkClass}" href="/howto/${t.slug}">Read the guide →</a></section>`;
}

function renderTopicPage(t: HowtoTopic): Response {
  const i = HOWTO_TOPICS.indexOf(t);
  const next = HOWTO_TOPICS[i + 1];
  const pages = (t.pages ?? []).map(([label, href]) => `<a class="btn" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`).join("");
  return shell(
    `${t.title} · GuildScribe how-to`,
    `<div class="crumbs"><a href="/guide">Guild Codex</a> › <a href="/howto">How-to guides</a></div>
<h1>${escapeHtml(t.title)}</h1><span class="pill">For ${escapeHtml(t.audience)}</span><p>${escapeHtml(t.summary)}</p>
<h2>Steps</h2><ol class="steps">${t.steps.map((s) => `<li>${s}</li>`).join("")}</ol>
${t.tips?.length ? `<h2>Good to know</h2><ul class="tips">${t.tips.map((s) => `<li>${s}</li>`).join("")}</ul>` : ""}
${pages ? `<h2>Related pages</h2><p>${pages}</p>` : ""}
<h2>More</h2><p>${t.codex ? `<a class="btn" href="/guide#${t.codex}">Full command reference</a>` : ""}<a class="btn" href="/howto">All how-to guides</a>${next ? `<a class="btn" href="/howto/${next.slug}">Next: ${escapeHtml(next.title)}</a>` : ""}</p>`,
  );
}

function renderHowtoIndex(): Response {
  return shell(
    "How-to guides · GuildScribe",
    `<div class="crumbs"><a href="/guide">Guild Codex</a></div><h1>How-to guides</h1><p>Step-by-step walkthroughs for the guild's features. The <a href="/guide">Guild Codex</a> has the full command reference.</p>
<h2>Setting up &amp; running your channel</h2><div class="grid">${HOWTO_SETUP.map((t) => topicCard(t)).join("")}</div>
<h2>Playing &amp; community</h2><div class="grid">${HOWTO_PLAY.map((t) => topicCard(t)).join("")}</div>`,
  );
}

/** Asks which channel to open a /go page for (no JS needed). */
function renderGoForm(page: string, error?: string): Response {
  const p = GO_PAGES[page];
  return shell(
    `${p.label} · GuildScribe`,
    `<div class="crumbs"><a href="/guide">Guild Codex</a></div><h1>${escapeHtml(p.label)}</h1>
${error ? `<p class="banner error">${escapeHtml(error)}</p>` : ""}<p>Which channel? Type its Twitch login (the name in its twitch.tv URL).</p>
<form method="get" action="/go/${page}"><input name="channel" placeholder="e.g. sheastolp" autocomplete="off" required pattern="[A-Za-z0-9_]{1,25}"> <button type="submit">Open</button></form>`,
    error ? 404 : 200,
  );
}

/** How-to and /go routes; null when the path isn't one of them. */
export async function handleHowtoRoute(req: Request, url: URL, path: string): Promise<Response | null> {
  if (req.method !== "GET") return null;
  if (path === "/howto" || path === "/howto/") return renderHowtoIndex();
  const topic = path.match(/^\/howto\/([a-z0-9-]+)\/?$/);
  if (topic) {
    const t = HOWTO_TOPICS.find((x) => x.slug === topic[1]);
    return t ? renderTopicPage(t) : shell("Guide not found", `<h1>No such guide</h1><p><a href="/howto">See every how-to guide</a>.</p>`, 404);
  }
  const go = path.match(/^\/go\/([a-z]+)\/?$/);
  if (!go) return null;
  if (!GO_PAGES[go[1]]) return shell("Page not found", `<h1>No such page</h1><p><a href="/guide#mod-pages">Back to the suggested pages</a>.</p>`, 404);
  const raw = (url.searchParams.get("channel") ?? "").trim().replace(/^@/, "");
  if (!raw) return renderGoForm(go[1]);
  if (!/^[A-Za-z0-9_]{1,25}$/.test(raw)) return renderGoForm(go[1], "That isn't a valid Twitch login.");
  const b: any = /^\d+$/.test(raw) ? await getBroadcaster(raw) : await getBroadcasterByLogin(raw.toLowerCase());
  if (!b || Number(b.connected) !== 1) return renderGoForm(go[1], `No channel called "${raw}" is connected to GuildScribe.`);
  // /overlays reads nicer with the login; the others only accept the numeric id.
  const channel = go[1] === "overlays" ? String(b.login || b.broadcaster_id) : String(b.broadcaster_id);
  return new Response(null, { status: 302, headers: { Location: `${GO_PAGES[go[1]].path}?channel=${encodeURIComponent(channel)}` } });
}

// ── Guild Codex sections (rendered inside guide.ts's page and styles) ──

export function renderGuideHowtoSection(): string {
  const cards = (list: HowtoTopic[]) =>
    list.map((t) =>
      `<section class="card" id="howto-${t.slug}"><span class="pill">${escapeHtml(t.audience)}</span><h3 style="margin-top:8px">${escapeHtml(t.title)}</h3><p>${escapeHtml(t.summary)}</p><p><a href="/howto/${t.slug}">Read the step-by-step guide →</a></p></section>`
    ).join("");
  return `<h2 id="howto">How-to guides</h2><p>Step-by-step walkthroughs, each on its own page. The sections further down are the full command reference. <a href="/howto">See every guide on one page</a>.</p><h3>Setting up &amp; running your channel</h3><div class="grid">${cards(HOWTO_SETUP)}</div><h3 style="margin-top:22px">Playing &amp; community</h3><div class="grid">${cards(HOWTO_PLAY)}</div>`;
}

/** Web pages worth bookmarking for the broadcaster and moderators. Pages that
 * belong to one channel go through /go/<page>, which the channel box fills in. */
export function renderGuideModPagesSection(): string {
  const item = (title: string, href: string, text: string, label: string, go?: string) =>
    `<section class="card"><h3 style="margin-top:0">${title}</h3><p>${text}</p><p><a href="${href}"${go ? ` data-go="${go}"` : ""}>${label} →</a></p></section>`;
  return `<h2 id="mod-pages">Suggested pages for mods+</h2><p>Pages the broadcaster and moderators will want to bookmark. Enter your channel once and the links below open your channel's pages directly.</p>
<form id="mod-pages-form" class="note" onsubmit="return false" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center"><label for="mod-channel"><strong>Your channel:</strong></label><input id="mod-channel" placeholder="Twitch login, e.g. sheastolp" autocomplete="off" style="min-width:0;width:min(100%,260px)"><span class="muted" id="mod-channel-note">Links ask for it if left blank.</span></form>
<div class="grid">
${item("Web dashboard", "/dashboard/go", "Feature on/off switches plus custom commands, triggers and timed messages. The first time, type <code>!dashboard</code> in chat and log in with Twitch; afterwards this link goes straight there for 12 hours.", "Open my dashboard")}
${item("OBS overlays", "/go/overlays", "Every stream overlay with its URL, suggested size and a live preview. Also posted by <code>!overlays</code>.", "Set up overlays", "overlays")}
${item("Guild roster", "/go/roster", "Every adventurer, party and party member in the channel, with gold and the raid boss's status.", "Open the roster", "roster")}
${item("Bestiary", "/go/bestiary", "Every monster the channel can hunt, its record, and what it has learned from fights.", "Open the bestiary", "bestiary")}
${item("Battle maps", "/go/maps", "The channel's grid maps, each with a live view to share or put on stream.", "Open the maps", "maps")}
${item("Reconnect your channel", "/connect", "Broadcaster only: grants permissions for newly added features. Safe to run any time; nothing is lost.", "Reconnect")}
${item("How-to guides", "/howto", "Every step-by-step guide on one page.", "Browse the guides")}
</div>
<script>(function(){var i=document.getElementById("mod-channel");if(!i)return;var k="gs_mod_channel";try{i.value=localStorage.getItem(k)||""}catch(e){}
function sync(){var v=i.value.trim().replace(/^@/,"");try{localStorage.setItem(k,v)}catch(e){}document.querySelectorAll("a[data-go]").forEach(function(a){a.href="/go/"+a.getAttribute("data-go")+(v?"?channel="+encodeURIComponent(v):"")})}
i.addEventListener("input",sync);sync()})();</script>`;
}

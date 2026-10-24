// GuildScribe — the pages written for people arriving from a search engine,
// plus what crawlers ask for:
//
//   GET /                                       home page (when no ?user=/&channel=, see web_routes.ts)
//   GET /switch-from-streamelements-nightbot    moving over from StreamElements or Nightbot
//   GET /robots.txt, /sitemap.xml
//
// Titles and descriptions use the plain words people search for ("Twitch chat
// bot", "custom commands", "loyalty points"); the guild-hall theme follows in
// parentheses so the page still reads like GuildScribe.

import { page } from "./page_shell.ts";
import { escapeHtml } from "./utils.ts";
import { DISCORD_INVITE_URL, PUBLIC_BASE_URL } from "./config.ts";
import { HOWTO_SETUP } from "./howto_pages.ts";
import { HOWTO_PLAY } from "./howto_pages2.ts";
import { nightbotConnectConfigured } from "./nightbot_import.ts";

export const SWITCH_PATH = "/switch-from-streamelements-nightbot";
// Short spellings people (and other sites) are likely to link to.
const SWITCH_ALIASES = new Set(["/switch", "/streamelements-alternative", "/nightbot-alternative", "/streamelements", "/nightbot"]);

/** Meta description, canonical URL and Open Graph tags for a public page. */
export function seoHead(title: string, description: string, path: string, jsonLd?: unknown): string {
  const url = `${PUBLIC_BASE_URL}${path}`;
  const t = escapeHtml(title), d = escapeHtml(description);
  return `<meta name="description" content="${d}"><link rel="canonical" href="${url}"><meta property="og:type" content="website"><meta property="og:site_name" content="GuildScribe"><meta property="og:title" content="${t}"><meta property="og:description" content="${d}"><meta property="og:url" content="${url}"><meta name="twitter:card" content="summary">` +
    (jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : "");
}

const HOME_TITLE = "GuildScribe — Free Twitch Chat Bot with Custom Commands, Loyalty Points & Giveaways";
const HOME_DESCRIPTION = "Free Twitch chatbot with custom commands, timers, loyalty currency, giveaways, OBS overlays and anti-bot moderation, plus a built-in RPG your chat can play.";

const FEATURES: Array<[string, string, string]> = [
  // [plain name, theme name ("" for none), one line]
  ["Custom commands & chat triggers", "", `Your own <code>!commands</code> and keyword auto-replies, with counters, random picks, dice and live stream info. Nightbot-style <code>$(user)</code> placeholders work too.`],
  ["Timed messages", "", "Recurring announcements that post on their own schedule while you're live."],
  ["Loyalty points", "Gold", "Viewers earn coin by chatting while you're live and spend it on giveaways and the market."],
  ["Giveaways", "", "Free or ticketed giveaways with weighted draws, rerolls and refunds."],
  ["Quotes", "", "Numbered quotes saved with the game and date. Imported quotes keep their numbers."],
  ["Watch time & followage", "", "<code>!watchtime</code> and <code>!followage</code>, including watch-time history from StreamElements."],
  ["OBS overlays", "", "Browser-source overlays for giveaways, leaderboards, the raid boss and the fight under way."],
  ["Spam filters & anti-bot moderation", "", "Link, caps, symbol and repeat filters, automatic bans for “AI viewers” spam, and a bot-viewer check."],
  ["Channel-point rewards", "Boons", "Link rewards to in-chat effects like a robbery shield or a hex."],
  ["Clips, now playing & sound effects", "", "<code>!clip</code> from chat, the current Spotify or Last.fm song on stream, and tavern sound effects."],
  ["Import from StreamElements or Nightbot", "", `Bring your commands, timers and quotes over in a few clicks. <a href="${SWITCH_PATH}">How switching works</a>.`],
  ["A built-in RPG your chat can play", "The guild hall", "D&amp;D 5e characters, dice, duels, monster hunts, a raid boss and battle maps."],
];

const HOME_JSONLD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "GuildScribe",
  applicationCategory: "BusinessApplication",
  applicationSubCategory: "Twitch chat bot",
  operatingSystem: "Web",
  url: `${PUBLIC_BASE_URL}/`,
  description: HOME_DESCRIPTION,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

const HOME_CSS = `<style>.tagline{font-style:italic;color:var(--ink-2)}.cta-sub{display:block;margin-top:6px;font-size:.9rem;color:var(--ink-3)}
.features{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:10px 22px}
.features li{padding:6px 0;border-bottom:1px dotted var(--rule)}.features strong{display:block}.features span{color:var(--ink-3)}</style>`;

export function renderHomePage(): Response {
  const supportUrl = Deno.env.get("SUPPORT_URL");
  const features = FEATURES.map(([name, theme, text]) =>
    `<li><strong>${name}${theme ? ` <span>(${theme})</span>` : ""}</strong>${text}</li>`
  ).join("");
  return page(
    escapeHtml(HOME_TITLE),
    `<h1>GuildScribe</h1><p><strong>A free Twitch chat bot with custom commands, timers, loyalty points, giveaways, OBS overlays and anti-bot moderation, plus a built-in RPG your chat can play.</strong></p><p class="tagline">A D&amp;D guild hall for Twitch — characters, dice, duels, and the codex of rules.</p>
<p><a class="btn ember" href="/connect">Add GuildScribe to your channel</a><span class="cta-sub">Raise the guild banner in your channel. It's free, and every feature starts switched off until you turn it on.</span></p>
<p><strong>After joining:</strong> mod the bot with <code>/mod GuildScribeBot</code> so the scribes can speak.</p>
<p class="note"><strong>Coming from StreamElements or Nightbot?</strong> Import your commands, timers and quotes, and keep your old bot running while you switch. <a href="${SWITCH_PATH}">Switching from StreamElements or Nightbot</a></p>
<h2>What GuildScribe does</h2><ul class="features">${features}</ul>
<p><a href="/guide">Full command list (the Guild Codex)</a> · <a href="/howto">How-to guides</a></p>
<p class="muted" style="font-size:.92rem;opacity:.85"><strong>Already connected?</strong> If GuildScribe has gained new features since you joined, <a href="/connect">reconnect your channel</a> to grant any newly requested permissions. This is safe to do any time and won't duplicate or lose your existing data.</p>
<h2>Visit a guild</h2><form action="/find" method="get" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center"><input name="channel" placeholder="Twitch channel name" aria-label="Twitch channel name" required autocomplete="off"><button type="submit" name="page" value="roster">Roster</button><button type="submit" name="page" value="gold">Gold</button><button type="submit" name="page" value="bestiary">Bestiary</button><button type="submit" name="page" value="gear">Gear</button><button type="submit" name="page" value="commands">Commands</button></form><p><a class="btn ghost" href="/dashboard/start">Mod Dashboard</a> <span class="muted" style="font-size:.92rem;opacity:.85">Log in with Twitch to manage a channel you own or moderate.</span></p><p><a href="${PUBLIC_BASE_URL}/guide">Open the Guild Codex</a> · <a href="/donate">Support the Guild</a> · <a href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener">Discord</a>${supportUrl ? ` · <a href="${escapeHtml(supportUrl)}">Support / Contact</a>` : ""} · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>`,
    seoHead(HOME_TITLE, HOME_DESCRIPTION, "/", HOME_JSONLD) + HOME_CSS,
  );
}

// ── Switching from StreamElements or Nightbot ──

const SWITCH_TITLE = "StreamElements & Nightbot Alternative: How to Switch to GuildScribe (Free Twitch Chatbot)";
const SWITCH_DESCRIPTION = "Looking for a StreamElements or Nightbot alternative? GuildScribe imports your commands, timers and quotes, keeps your StreamElements watch time, accepts $(user) placeholders, and runs alongside your old bot while you switch.";

// [feature, StreamElements, Nightbot, GuildScribe]
const MAPPING: Array<[string, string, string, string]> = [
  ["Custom commands", "Yes", "Yes", `Yes, imported automatically. Cooldowns, on/off state and use counts carry over; aliases become their own commands.`],
  ["Command variables", "<code>${user}</code> style", "<code>$(user)</code> style", `Both: StreamElements variables are translated on import, and <code>$(user)</code>, <code>$(count)</code>, <code>$(touser)</code>, <code>$(random …)</code>, <code>$(math …)</code> and more work as typed.`],
  ["Timers", "Yes", "Yes", "{timers}"],
  ["Quotes", "Yes", "No", "<code>!quote</code>, imported from StreamElements with their numbers kept."],
  ["Loyalty points", "Points", "No", "Gold (<code>!gold</code>), earned by chatting while live."],
  ["Points leaderboard", "<code>!leaderboard</code>", "No", "<code>!gold top</code> (named so it doesn't clash)."],
  ["Giveaways", "Yes", "Yes", "<code>!giveaway</code>, free or paid in gold, with weighted draws and rerolls."],
  ["Watch time", "<code>!watchtime</code>", "No", "<code>!watchtime</code>, including your StreamElements history."],
  ["Followage", "Yes", "Via custom command", "<code>!followage</code>, built in."],
  ["Spam filters", "Yes", "Yes", "Link, caps, symbol, emote and repeat filters with a warn → timeout ladder, plus auto-bans for “AI viewers” spam."],
  ["Channel-point rewards", "Yes", "No", "Linked to in-chat effects with <code>!boon</code>."],
  ["Song requests", "Yes", "Yes", "No. GuildScribe can show what's playing on Spotify or Last.fm, but doesn't take requests."],
  ["Follow / sub alert boxes", "Yes", "No", "No. Thank-yous for follows, subs and raids are posted in chat, not as on-screen alerts."],
  ["Tips & donations", "Yes", "No", "No."],
  ["OBS overlays", "Alerts & widgets", "No", "Overlays for giveaways, leaderboards and chat games."],
  ["Chat games", "Mini-games", "No", "A full D&amp;D 5e RPG: characters, duels, hunts, a raid boss and battle maps."],
];

const SWITCH_FAQ: Array<[string, string]> = [
  ["Is GuildScribe free?", "Yes. There's no paid tier and nothing to install; it runs in the cloud and joins your channel's chat."],
  ["Can I run GuildScribe and StreamElements or Nightbot at the same time?", "Yes. Every GuildScribe feature starts switched off, GuildScribe ignores messages from other bots, and its built-in commands avoid names StreamElements already uses (<code>!gold</code> rather than <code>!points</code>, <code>!gold top</code> rather than <code>!leaderboard</code>, <code>!boon</code> rather than <code>!redeem</code>). Turn features on one at a time and switch the matching ones off in your old bot as you go."],
  ["Will my viewers lose their watch time?", "No. If your channel used StreamElements, <code>!watchtime</code> adds each viewer's StreamElements watch time to what GuildScribe has counted, so totals go back to before the switch."],
  ["Will my Nightbot commands work without changes?", "Most will. GuildScribe understands Nightbot's <code>$(user)</code>, <code>$(touser)</code>, <code>$(count)</code> and <code>$(random …)</code> placeholders. Commands that call outside services with <code>$(urlfetch …)</code> or run code with <code>$(eval …)</code> are flagged on import so you can rewrite them."],
  ["What does GuildScribe not do?", "It has no on-screen follow/sub alert boxes, no tipping or donation page, and no song requests. Keep StreamElements or Streamlabs for alerts and tips; GuildScribe is happy to share the chat."],
];

const SWITCH_CSS = `<style>.table-wrap{overflow-x:auto;border:1px solid var(--edge);border-radius:6px;background:#e7e0ca;margin:14px 0}
table{width:100%;min-width:680px;border-collapse:collapse;font-size:.95rem}td:last-child{min-width:260px}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #cebb8b;vertical-align:top;color:var(--ink-2)}
th{font:700 .72rem var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--seal-dk);background:#d9caa2;border-bottom:2px solid var(--rule)}
tbody tr:nth-child(even){background:#e2d9bd}td:first-child{font-weight:600;color:var(--ink)}
.faq h3{margin-bottom:4px}</style>`;

export function renderSwitchPage(): Response {
  // Nightbot only shares timers through its login, which needs NIGHTBOT_CLIENT_ID/SECRET.
  const nightbotTimers = nightbotConnectConfigured()
    ? "Nightbot timers come over when you log in with Nightbot on the import page."
    : "Nightbot doesn't make timers public, so re-add those as timed messages on the dashboard; it takes a minute per timer.";
  const timersRow = nightbotConnectConfigured() ? "Timed messages, imported from either bot." : "Timed messages, imported from StreamElements.";
  const rows = MAPPING.map(([f, se, nb, gs]) => `<tr><td>${f}</td><td>${se}</td><td>${nb}</td><td>${gs.replace("{timers}", timersRow)}</td></tr>`).join("");
  const faq = SWITCH_FAQ.map(([q, a]) => `<h3>${q}</h3><p>${a}</p>`).join("");
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: SWITCH_FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a.replace(/<[^>]+>/g, "") } })),
  };
  return page(
    escapeHtml(SWITCH_TITLE),
    `<div class="crumbs"><a href="/">GuildScribe</a> › <a href="/howto">How-to guides</a></div>
<h1>Switching from StreamElements or Nightbot</h1>
<p><strong>GuildScribe is a free Twitch chat bot you can move to from StreamElements or Nightbot without starting over.</strong> It imports your custom commands, timers and quotes, keeps your viewers' StreamElements watch time, understands Nightbot's <code>$(user)</code> placeholders, and can run next to your old bot while you switch.</p>
<p><a class="btn ember" href="/connect">Add GuildScribe to your channel</a></p>
<h2>What carries over</h2>
<ul>
<li><strong>Custom commands.</strong> The dashboard's importer reads StreamElements' and Nightbot's public command lists from your Twitch username. Cooldowns, on/off state and use counts come with them, and aliases become commands of their own.</li>
<li><strong>Command variables.</strong> StreamElements' <code>\${user}</code>-style variables are translated for you. Nightbot's <code>$(user)</code>, <code>$(touser)</code>, <code>$(count)</code>, <code>$(random …)</code>, <code>$(math …)</code> and similar placeholders work as typed, so most Nightbot commands paste in with little or no change. Anything that can't be carried over cleanly, such as <code>$(urlfetch …)</code>, is flagged and left unticked for you to review.</li>
<li><strong>Timers.</strong> They become GuildScribe timed messages. StreamElements timers need your StreamElements JWT token, which is used once for the import and never stored. ${nightbotTimers}</li>
<li><strong>Quotes.</strong> StreamElements quotes keep their numbers wherever the number is free, so <code>!quote 42</code> still finds the same line. (Nightbot has no quote book.)</li>
<li><strong>Watch time.</strong> If your channel ran StreamElements, <code>!watchtime</code> includes each viewer's StreamElements history, so totals go back to before GuildScribe joined.</li>
</ul>
<h2>How to switch, step by step</h2>
<ol class="steps">
<li><a href="/connect">Connect GuildScribe</a> as the broadcaster, then type <code>/mod GuildScribeBot</code> in your chat.</li>
<li>Type <code>!dashboard</code> in chat, open the link and log in with Twitch.</li>
<li>Click <strong>⇪ Import from StreamElements / Nightbot</strong>, enter your Twitch username, and review the checklist of commands, timers and quotes.</li>
<li>Untick anything you don't want, then import.</li>
<li>Turn on the features you want under <strong>Bot &amp; feature switches</strong>. Everything starts off, so nothing changes in chat until you say so.</li>
<li>As each GuildScribe feature goes live, switch off the matching command or timer in your old bot so chat doesn't get two answers.</li>
</ol>
<h2>Running both bots during the switch</h2>
<p>You don't have to switch everything in one night. GuildScribe ignores messages from Nightbot, StreamElements and other bots, and its built-in commands use names that don't clash with StreamElements' own: loyalty points are <code>!gold</code> (not <code>!points</code>), the leaderboard is <code>!gold top</code> (not <code>!leaderboard</code>) and channel-point effects use <code>!boon</code> (not <code>!redeem</code>).</p>
<h2>Feature-by-feature comparison</h2>
<div class="table-wrap"><table><thead><tr><th>Feature</th><th>StreamElements</th><th>Nightbot</th><th>GuildScribe</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>What GuildScribe doesn't do</h2>
<p>GuildScribe has no on-screen follow/sub alert boxes, no tipping or donation page, and no song requests. <strong>Keep StreamElements or Streamlabs for alerts and tips</strong>; GuildScribe can take over the chat side next to them.</p>
<h2>Questions</h2><div class="faq">${faq}</div>
<h2>Related guides</h2>
<p><a class="btn" href="/howto/custom-commands">How to make custom commands on Twitch</a><a class="btn" href="/howto/timed-messages">How to set up timed messages on Twitch</a><a class="btn" href="/howto/giveaways">How to run a Twitch giveaway</a><a class="btn" href="/howto/moderation">How to stop spam bots in Twitch chat</a></p>`,
    seoHead(SWITCH_TITLE, SWITCH_DESCRIPTION, SWITCH_PATH, jsonLd) + SWITCH_CSS,
  );
}

// ── Crawlers ──

function sitemap(): string {
  const paths = ["/", SWITCH_PATH, "/guide", "/howto", ...[...HOWTO_SETUP, ...HOWTO_PLAY].map((t) => `/howto/${t.slug}`), "/privacy", "/terms"];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `  <url><loc>${PUBLIC_BASE_URL}${p}</loc></url>`).join("\n")}\n</urlset>\n`;
}

/** Search-facing routes; null when the path isn't one of them. The home page
 * itself is served from web_routes.ts's catch-all GET. */
export function handleSeoRoute(req: Request, path: string): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  if (path === SWITCH_PATH) return renderSwitchPage();
  if (SWITCH_ALIASES.has(path)) return new Response(null, { status: 301, headers: { Location: SWITCH_PATH } });
  if (path === "/robots.txt") {
    // Private, per-viewer and per-channel pages stay out of search results.
    return new Response(`User-agent: *\nDisallow: /dashboard\nDisallow: /admin\nDisallow: /r/\nDisallow: /connect\nAllow: /\n\nSitemap: ${PUBLIC_BASE_URL}/sitemap.xml\n`, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    });
  }
  if (path === "/sitemap.xml") {
    return new Response(sitemap(), { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" } });
  }
  return null;
}

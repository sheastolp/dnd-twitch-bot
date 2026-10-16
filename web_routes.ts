// GuildScribe — every web (non-EventSub) route: health check, static pages,
// broadcaster OAuth connect/callback, character/map/roster pages, the
// per-channel dashboard and the operator /admin routes. Split out of main.ts
// to keep files well under Val Town's per-file size ceiling. Returns null
// when no route matched, so main.ts carries on to the EventSub webhook.

import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";
import { subscribeToAdBreaks } from "./adalerts.ts";
import { INSTANCE, sqlite } from "./sqlite.ts";
import { getCharacter, getBroadcaster, listChannelCharacters, listChannelParties, getBroadcasterByLogin, listShowcaseChannels, getOrCreateDashboardKey, regenerateDashboardKey, blockChannel, unblockChannel, recordMonitorEvent, getMerchantCronStatus, getMerchantOverview, getMonitorEvents, queueEventSubCancellation, getPendingEventSubCancellations, clearPendingEventSubCancellation, saveExtraEventSubSubscription, getExtraEventSubSubscriptions, deleteExtraEventSubSubscriptions, getMap, getMapCells, getMapTokens, listMaps, markStreamStatusSubscribed, isCommandGroupEnabled, getCommandGroupToggles, listCustomCommandsFull, isMerchantEnabled } from "./db.ts";
import { saveBroadcasterAdToken } from "./ads_db.ts";
import { isPointsEnabled, listChannelBalances } from "./points_db.ts";
import { listNicknames } from "./mentions.ts";
import { getRaidRosterStatus, RAID_MIN_CR } from "./raid.ts";
import { getAdaptations, getChannelRoster } from "./bestiary.ts";
import { renderBestiaryPage } from "./bestiary_page.ts";
import { renderGearPage } from "./gear_page.ts";
import { renderChannelCommandsPage } from "./commands_page.ts";
import { isHoardEnabled } from "./hoard_db.ts";
import { isNpcEnabled } from "./social_db.ts";
import { renderPublicQuotesPage } from "./quotes.ts";
import { subscribeToRedemptions } from "./redemptions.ts";
import { renderDashboard, handleDashboardStart, handleDashboardLogin, handleDashboardCallback, handleDashboardCommandsForm, handleDashboardTriggersForm, handleDashboardTimedMessagesForm, handleDashboardFeaturesForm, handleDashboardGo, handleBotCheckPage, handleBotCheckForm, handleAutoBanPage, handleAutoBanForm, handleBotListPage, handleBotListForm, handlePokeballPage, handlePokeballForm, handleSwearJarPage, handleSwearJarForm, handleQuotesPage, handleQuotesForm, handleImportPage, handleImportForm, handleNowPlayingPage, handleNowPlayingForm, handleSpotifyConnect } from "./dashboard.ts";
import { handleSpotifyCallback } from "./nowplaying.ts";
import { env, fetchIsChannelLiveNow, exchangeCode, createChatSubscription, createSubEventSubscriptions, createRaidEventSubscription, createStreamStatusEventSubscriptions, deleteEventSubSubscription } from "./twitch.ts";
import { escapeHtml } from "./utils.ts";
import { page, renderCharacterPage, renderGuidePage, renderMapPage, renderMapListPage, renderRosterPage, renderAdminLogsPage } from "./pages.ts";
import { DISCORD_INVITE_URL, PUBLIC_BASE_URL, PUBLIC_ORIGIN } from "./config.ts";
import { handleBotConnectRoute } from "./whisper.ts";
import { handleReplyPageRoute } from "./replypages.ts";
import { handleEventSubAdminRoute } from "./eventsub_admin.ts";
import { handleOverlayRoute } from "./overlay.ts";
import { CHANNEL_STATUS_CSS, CONNECT_SCOPES, listChannelStatuses, renderAdminChannelsPage } from "./channel_status.ts";
import { handleHowtoRoute } from "./howto.ts";
import { FAVICON_PATHS, handleFavicon } from "./favicon.ts";

async function retryPendingEventSubCancellations() {
  const pending = await getPendingEventSubCancellations(5);
  for (const row of pending) {
    try {
      await deleteEventSubSubscription(String(row.subscription_id));
      await clearPendingEventSubCancellation(String(row.subscription_id));
      await recordMonitorEvent("eventsub_delete_retry_ok", `${row.broadcaster_id}:${row.subscription_id}`);
    } catch (e) {
      await queueEventSubCancellation(String(row.subscription_id), String(row.broadcaster_id), String(e));
      await recordMonitorEvent("eventsub_delete_retry_error", `${row.broadcaster_id}:${String(e)}`);
    }
  }
}


// Where /privacy and /terms send people: SUPPORT_URL, else the guild Discord.
const SUPPORT_URL = Deno.env.get("SUPPORT_URL") ?? "";
const SUPPORT_CONTACT_HTML = SUPPORT_URL
  ? `<a href="${escapeHtml(SUPPORT_URL)}">${escapeHtml(SUPPORT_URL)}</a>`
  : `the operator on the <a href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener">GuildScribe Discord</a>`;

export async function handleWebRoute(req: Request, url: URL, path: string): Promise<Response | null> {
  // ── Static / GET routes ──
  // NOTE: activity logs are intentionally NOT exposed as a public web route.
  // They contain per-channel usernames and command text; the only way to see
  // them is the in-chat `!logs` command, which is restricted to the
  // broadcaster/moderators of that specific channel (see below).
  // Public channel list for tavernworks.dev (fetched cross-origin by its home
  // page). Only Twitch names and live status, the same thing anyone sees in
  // these channels' chat; a channel leaves the list with !dndbot showcase off
  // or the dashboard's "Listed on tavernworks.dev" switch.
  // Tab icon: the bot's Twitch avatar (favicon.ts).
  if (req.method === "GET" && FAVICON_PATHS.has(path)) return await handleFavicon();
  if (req.method === "GET" && path === "/api/channels") {
    try {
      return new Response(JSON.stringify({ channels: await listShowcaseChannels(Deno.env.get("TWITCH_BOT_ID") ?? "") }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
      });
    } catch (e) {
      await recordMonitorEvent("api_channels_error", String(e));
      return new Response(JSON.stringify({ channels: [] }), { status: 503, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
    }
  }
  if (req.method === "GET" && path === "/healthz") {
    try {
      try { await retryPendingEventSubCancellations(); } catch (e) { await recordMonitorEvent("eventsub_retry_loop_error", String(e)); }
      // Newest long-reply save: if a page link from chat is newer than this,
      // another copy of the bot (another database) wrote it.
      const last = await sqlite.execute("SELECT MAX(updated_at) AS t FROM reply_links").catch(() => null);
      const lastReply = Number(last?.rows[0]?.t) || 0;
      return new Response(JSON.stringify({ ok: true, service: "GuildScribe", time: new Date().toISOString(), instance: INSTANCE, last_reply_page: lastReply ? new Date(lastReply).toISOString() : null }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch (e) {
      await recordMonitorEvent("health_error", String(e));
      return new Response(JSON.stringify({ ok: false }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
  }
  if (req.method === "GET" && path === "/privacy") {
    return page("GuildScribe Privacy Policy", `<h1>GuildScribe Privacy Policy</h1>
<h2>What it stores</h2>
<ul>
<li><strong>Channels that connect GuildScribe:</strong> the Twitch login and ID, the streamer's Twitch token (for the permissions shown when connecting: chat, subs, raids, ads, channel points, moderation), connection and EventSub state, and the channel's settings, custom commands, triggers and timed messages. A channel that links Spotify or Last.fm for now-playing also stores that token or username.</li>
<li><strong>Viewers who use it:</strong> Twitch login, display name and ID; characters, parties, gear, coin (points) balances, giveaway entries, fight and roll results; per-viewer watch-time totals (time active in chat while live); the generated fantasy nickname; and an activity log of commands used.</li>
<li><strong>Reply pages:</strong> each viewer's latest command replies, viewable by anyone with that viewer's unlisted link (<code>/r/…</code>), kept 24 hours.</li>
<li><strong>Moderation tools, only for channels that turn them on:</strong> auto-ban keeps the text of messages it banned, the channel's imported Twitch ban list (names and reasons) and spam phrases it learned; bot detection looks at chatters' account age, avatar and name.</li>
<li>Server logs and error records for troubleshooting.</li>
</ul>
<h2>Who it's shared with</h2>
<p>Some features write their replies with an AI model: <code>!haggle</code>, NPC chatter, and replies when someone @-tags the bot. For those, the message (and, for @-tags, the last few exchanges) and the chatter's display name are sent to OpenAI or to an AI model the operator runs themselves. Lookups go to public reference APIs (D&amp;D 5e SRD, PokeAPI, emote services) without viewer data. Nothing is sold or used for ads.</p>
<h2>How it is used</h2>
<p>Only to run the bot in channels that connected it, keep characters and games working, show broadcasters and their moderators their channel's logs and tools, and troubleshoot abuse and errors.</p>
<h2>Retention</h2>
<p>Activity logs are kept for up to 90 days and capped at 5,000 rows per channel. Reply pages last 24 hours. Saving-throw rolls are pruned after 7 days. Game data (characters, coin, settings) stays while the channel uses GuildScribe. OAuth state records expire after 10 minutes.</p>
<h2>Deletion</h2>
<p>The broadcaster can type <code>!dndbot leave purge</code> to disconnect GuildScribe and delete that channel's stored data: characters, parties, coin, giveaways, logs, settings, moderation lists and gameplay state. Disconnecting the app in Twitch Settings → Connections revokes its permissions. Viewers who want their own data removed, or anyone with a question, can contact ${SUPPORT_CONTACT_HTML}.</p>
<p><a href="/">Return to GuildScribe</a> · <a href="/terms">Terms</a></p>`);
  }
  if (req.method === "GET" && (path === "/terms" || path === "/tos")) {
    return page("GuildScribe Terms of Service", `<h1>GuildScribe Terms of Service</h1><p>GuildScribe is a free, fan-made Twitch utility for D&amp;D-style character and chat gameplay, offered as-is. It is not affiliated with Twitch, Wizards of the Coast, or any game publisher. Use it lawfully and respectfully, and follow Twitch's rules and the streamer/channel's rules.</p><p>Do not use the bot to harass, spam, abuse, evade moderation, or interfere with other users. Channel owners are responsible for deciding whether the bot is appropriate for their community, and for how they configure moderation tools such as auto-ban.</p><p>Coin, gear, characters and other in-game items have no real-world value and can't be exchanged for money. Some replies are written by AI and may be wrong or odd.</p><p>The service may be changed, limited, suspended, or removed at any time. Gameplay data and generated results are not guaranteed to be preserved.</p><p>Report abuse or ask for help: ${SUPPORT_CONTACT_HTML}.</p><p><a href="/">Return to GuildScribe</a> · <a href="/privacy">Privacy</a></p>`);
  }
  // Per-channel command list (the page !commands links to): that channel's
  // custom commands plus the built-in features it has switched on. Same
  // trust model as /bestiary. Without ?channel= it is the Guild Codex.
  if (req.method === "GET" && path === "/commands" && url.searchParams.has("channel")) {
    const channelId = url.searchParams.get("channel");
    if (!channelId || !/^\d+$/.test(channelId)) return new Response("Missing or invalid channel.", { status: 400 });
    const broadcaster = await getBroadcaster(channelId);
    if (!broadcaster || Number(broadcaster.connected) !== 1) return new Response("Command list unavailable for this channel.", { status: 404 });
    const [commands, groups, points, market, hoard, npc] = await Promise.all([
      listCustomCommandsFull(channelId),
      getCommandGroupToggles(channelId),
      isPointsEnabled(channelId),
      isMerchantEnabled(channelId),
      isHoardEnabled(channelId),
      isNpcEnabled(channelId),
    ]);
    const customCommands = commands
      .filter((c: any) => Number(c.enabled ?? 1) === 1)
      .map((c: any) => ({ name: String(c.name), response: String(c.response ?? ""), uses: Number(c.uses ?? 0) }));
    const channelName = String(broadcaster.display_name || broadcaster.login || "This channel");
    return new Response(renderChannelCommandsPage(channelName, { customCommands, groups, dedicated: { points, market, hoard, npc } }, PUBLIC_BASE_URL), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (req.method === "GET" && (path === "/guide" || path === "/commands")) {
    return page(
      "GuildScribe Codex",
      renderGuidePage(),
    );
  }
  if (req.method === "GET" && (path === "/donate" || path === "/donations")) {
    return page(
      "Support the Guild",
      `<h1>Support the Guild</h1><p>If GuildScribe has served your campaign, you can leave a tribute so the scribes may keep the halls open.</p><h2>Join the Guild Discord</h2><p>Questions, bug reports, feature ideas, or just want to hang out with fellow adventurers? The guild hall has a Discord.</p><p><a class="btn ember" href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener">Join the GuildScribe Discord</a></p><h2>Ethereum (ETH)</h2><p><code class="address">0x422413678AdFC67d3d9AB545FE4e1ec1D00197fd</code></p><p>Send ETH on the Ethereum network. Verify the address and network in your wallet before confirming.</p><h2>Bitcoin (BTC)</h2><p><code class="address">3JYo1Vwyh6aQENzXoi16rA9mXZuZQVL1rN</code></p><p>Send BTC on the Bitcoin network. Verify the address carefully before confirming.</p><p><a href="/">Return to the Guild Hall</a></p><style>.address{display:block;word-break:break-all;padding:12px;font-size:.95rem}</style>`,
    );
  }

  // Full output of a long reply, linked from its one-message chat summary.
  if (path.startsWith("/r/")) {
    const replyPage = await handleReplyPageRoute(req, path);
    if (replyPage) return replyPage;
  }

  // Bot account grants its whisper scope (one-time operator setup; see whisper.ts).
  if (path.startsWith("/connect-bot")) {
    const botRoute = await handleBotConnectRoute(req, url, path);
    if (botRoute) return botRoute;
  }

  if (req.method === "GET" && path === "/connect") {
    const state = crypto.randomUUID();
    await sqlite.execute("INSERT INTO oauth_states (state,expires_at) VALUES (?,?)", [
      state,
      Date.now() + 10 * 60 * 1000,
    ]);
    const auth = new URL("https://id.twitch.tv/oauth2/authorize");
    auth.search = new URLSearchParams({
      client_id: env("TWITCH_CLIENT_ID"),
      redirect_uri: `${PUBLIC_ORIGIN}/callback`,
      response_type: "code",
      scope: CONNECT_SCOPES.map((s) => s.scope).join(" "),
      state,
    }).toString();
    return Response.redirect(auth.toString(), 302);
  }

  if (req.method === "GET" && path === "/callback") {
    const error = url.searchParams.get("error");
    if (error) {
      return page(
        "Twitch connection cancelled",
        `<h1>Connection cancelled</h1><p>${escapeHtml(url.searchParams.get("error_description") ?? error)}</p>`,
      );
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return new Response("Missing OAuth code or state", { status: 400 });
    const check = await sqlite.execute("SELECT * FROM oauth_states WHERE state = ? AND expires_at > ?", [
      state,
      Date.now(),
    ]);
    if (!check.rows.length) return new Response("Invalid or expired OAuth state", { status: 400 });
    await sqlite.execute("DELETE FROM oauth_states WHERE state = ?", [state]);
    try {
      const token = await exchangeCode(code, `${PUBLIC_ORIGIN}/callback`);
      const userRes = await fetch("https://api.twitch.tv/helix/users", {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          "Client-Id": env("TWITCH_CLIENT_ID"),
        },
      });
      if (!userRes.ok) throw new Error(`Could not identify broadcaster: ${userRes.status}`);
      const user = (await userRes.json()).data[0];

      // Reconnecting an already-connected channel (e.g. to pick up a newly
      // requested scope) would otherwise try to create a duplicate
      // channel.chat.message subscription with the same type/condition/
      // callback, which Twitch rejects — clean up anything from a prior
      // connection first so this is safe to run repeatedly.
      const existing = await getBroadcaster(user.id);
      if (existing) {
        if (existing.subscription_id) {
          try {
            await deleteEventSubSubscription(String(existing.subscription_id));
          } catch (e) {
            await recordMonitorEvent("eventsub_reconnect_cleanup_failed", `${user.id}: ${String(e)}`);
          }
        }
        for (const extra of await getExtraEventSubSubscriptions(user.id)) {
          try {
            await deleteEventSubSubscription(extra.subscription_id);
          } catch (e) {
            await recordMonitorEvent("eventsub_reconnect_cleanup_failed", `${user.id}: ${extra.kind}: ${String(e)}`);
          }
        }
        await deleteExtraEventSubSubscriptions(user.id);
      }

      const sub = await createChatSubscription(user.id, PUBLIC_ORIGIN);
      await sqlite.execute(
        "INSERT OR REPLACE INTO broadcasters (broadcaster_id,login,display_name,subscription_id,connected_at,connected,disconnected_at,disconnect_reason) VALUES (?,?,?,?,?,?,?,?)",
        [user.id, user.login, user.display_name, sub.id, Date.now(), 1, null, null],
      );
      // Best-effort: powers !adcheck's real Twitch ad-schedule lookup.
      // Requires channel:read:ads, now requested above, but a save failure
      // here should never block the core chat connection — !adcheck simply
      // falls back to the manually-logged !adslogged timestamp until the
      // channel reconnects.
      try {
        await saveBroadcasterAdToken(
          user.id,
          token.access_token,
          token.refresh_token,
          Array.isArray(token.scope) ? token.scope.join(" ") : String(token.scope ?? ""),
          Date.now() + Math.max(0, Number(token.expires_in ?? 0) * 1000 - 60_000),
        );
      } catch (e) {
        await recordMonitorEvent("ad_token_save_failed", `${user.id}: ${String(e)}`);
      }
      // Best-effort: powers the D&D-themed !hug-style new-sub/resub thank
      // you. Requires channel:read:subscriptions, which is now requested
      // above, but shouldn't block the core chat connection if it fails
      // (e.g. a re-auth that hasn't re-granted the scope yet).
      try {
        const { newSub, resub, gift } = await createSubEventSubscriptions(user.id, PUBLIC_ORIGIN);
        await saveExtraEventSubSubscription(user.id, "sub", newSub.id);
        await saveExtraEventSubSubscription(user.id, "resub", resub.id);
        await saveExtraEventSubSubscription(user.id, "gift", gift.id);
      } catch (e) {
        await recordMonitorEvent("eventsub_sub_subscription_failed", `${user.id}: ${String(e)}`);
      }
      // Best-effort: powers the D&D-themed raid thank-you. channel.raid
      // needs no extra OAuth scope (to_broadcaster_user_id is public data),
      // so this should reliably succeed, but it's kept non-blocking and
      // independent of the sub subscriptions above just in case.
      try {
        const raidSub = await createRaidEventSubscription(user.id, PUBLIC_ORIGIN);
        await saveExtraEventSubSubscription(user.id, "raid", raidSub.id);
      } catch (e) {
        await recordMonitorEvent("eventsub_raid_subscription_failed", `${user.id}: ${String(e)}`);
      }
      // Best-effort: powers the "quiet while offline" check (see main
      // dispatch above and the two cron files). Also needs no extra OAuth
      // scope. Seed broadcasters.is_live with one direct lookup right away
      // so it isn't stuck at the default (offline) until the first future
      // stream.online/offline event — after that, these subscriptions keep
      // it current with no further Twitch API calls.
      try {
        const { online, offline } = await createStreamStatusEventSubscriptions(user.id, PUBLIC_ORIGIN);
        await saveExtraEventSubSubscription(user.id, "stream_online", online.id);
        await saveExtraEventSubSubscription(user.id, "stream_offline", offline.id);
        await markStreamStatusSubscribed(user.id, await fetchIsChannelLiveNow(user.id));
      } catch (e) {
        await recordMonitorEvent("eventsub_stream_status_subscription_failed", `${user.id}: ${String(e)}`);
      }
      // Best-effort: ad-break start alerts (adalerts.ts). Needs
      // channel:read:ads, requested above; adalerts.ts retries lazily.
      try {
        await subscribeToAdBreaks(user.id, PUBLIC_ORIGIN);
      } catch (e) {
        await recordMonitorEvent("eventsub_ad_break_subscription_failed", `${user.id}: ${String(e)}`);
      }
      // Best-effort: channel-point rewards that shield/hex players (see
      // redemptions.ts). Needs channel:read:redemptions, requested above.
      try {
        await subscribeToRedemptions(user.id, PUBLIC_ORIGIN);
      } catch (e) {
        await recordMonitorEvent("eventsub_redemption_subscription_failed", `${user.id}: ${String(e)}`);
      }
      return page(
        "Twitch connected",
        existing
          ? `<h1>The Guild renews your banner</h1><p>${escapeHtml(user.display_name)}'s connection to GuildScribe has been refreshed — any new permissions are now granted.</p><p><a href="/guide">Open the Guild Codex</a></p>`
          : `<h1>The Guild accepts your banner</h1><p>${escapeHtml(user.display_name)} is now connected to GuildScribe. The scribes will answer in that channel once the EventSub rite is complete.</p><p><strong>Important:</strong> In Twitch chat, run <code>/mod GuildScribeBot</code> so the guild can hear and answer reliably.</p><p><a href="/guide">Open the Guild Codex</a></p>`,
      );
    } catch (e) {
      console.error(e);
      await recordMonitorEvent("oauth_callback_failed", String(e));
      return page("Connection failed", `<h1>Connection failed</h1><p>GuildScribe could not complete the Twitch connection. Please try again or use the support link on the home page.</p>`);
    }
  }

  // OBS browser-source overlays (/overlays setup page, /overlay, /overlay/data)
  // — see overlay.ts. Same public, connected-channel-only model as /roster.
  // Step-by-step how-to guides and /go/<page> channel shortcuts — see howto.ts.
  if (path.startsWith("/howto") || path.startsWith("/go/")) {
    const howto = await handleHowtoRoute(req, url, path);
    if (howto) return howto;
  }
  if (path.startsWith("/overlay")) {
    const overlay = await handleOverlayRoute(req, url, path);
    if (overlay) return overlay;
  }

  if (req.method === "GET" && path === "/maps") {
    const channelId = url.searchParams.get("channel");
    if (!channelId || !/^\d+$/.test(channelId)) return new Response("Missing or invalid channel.", { status: 400 });
    const broadcaster = await getBroadcaster(channelId);
    if (!broadcaster || Number(broadcaster.connected) !== 1) return new Response("Maps unavailable for this channel.", { status: 404 });
    const maps = await listMaps(channelId);
    return new Response(renderMapListPage(maps, channelId, PUBLIC_BASE_URL), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (req.method === "GET" && path === "/map") {
    const channelId = url.searchParams.get("channel");
    const mapName = url.searchParams.get("map");
    if (!channelId || !/^\d+$/.test(channelId)) return new Response("Missing or invalid channel.", { status: 400 });
    if (!mapName) return new Response("Missing map name.", { status: 400 });
    const broadcaster = await getBroadcaster(channelId);
    if (!broadcaster || Number(broadcaster.connected) !== 1) return new Response("Map unavailable for this channel.", { status: 404 });
    const map = await getMap(channelId, mapName);
    if (!map) return new Response("No map found with that name in this channel.", { status: 404 });
    const [cells, tokens] = await Promise.all([getMapCells(channelId, mapName), getMapTokens(channelId, mapName)]);
    return new Response(renderMapPage(map, cells, tokens, PUBLIC_BASE_URL), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Public roster: every saved character plus every party and its members for
  // one channel — the page the !roster chat command links to. Same trust model
  // as /maps (the channel must be connected). Must stay above the catch-all GET
  // block further down.
  // Public quote book (quotes.ts) — the page !quotes links to. Same trust model as /roster.
  if (req.method === "GET" && path === "/quotes") {
    const channelId = url.searchParams.get("channel");
    if (!channelId || !/^\d+$/.test(channelId)) return new Response("Missing or invalid channel.", { status: 400 });
    const broadcaster = await getBroadcaster(channelId);
    if (!broadcaster || Number(broadcaster.connected) !== 1) return new Response("Quotes unavailable for this channel.", { status: 404 });
    const channelName = String(broadcaster.display_name || broadcaster.login || "This channel");
    return new Response(await renderPublicQuotesPage(channelId, channelName), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (req.method === "GET" && path === "/roster") {
    const channelId = url.searchParams.get("channel");
    if (!channelId || !/^\d+$/.test(channelId)) return new Response("Missing or invalid channel.", { status: 400 });
    const broadcaster = await getBroadcaster(channelId);
    if (!broadcaster || Number(broadcaster.connected) !== 1) return new Response("Roster unavailable for this channel.", { status: 404 });
    const ROSTER_LIMIT = 1000;
    const [fetched, parties, goldOn, raidOn, nickRows] = await Promise.all([
      listChannelCharacters(channelId, ROSTER_LIMIT + 1),
      listChannelParties(channelId),
      isPointsEnabled(channelId),
      isCommandGroupEnabled(channelId, "raid"),
      listNicknames(channelId),
    ]);
    const nicknames = new Map(nickRows.map((n) => [n.username.toLowerCase(), n.nickname]));
    // Raid card only while the channel has the raid quest switched on.
    const raid = raidOn ? await getRaidRosterStatus(channelId) : null;
    // Gold column only while the channel has gold on (!gold on/off).
    const gold = goldOn ? await listChannelBalances(channelId) : undefined;
    const truncated = fetched.length > ROSTER_LIMIT;
    const characters = truncated ? fetched.slice(0, ROSTER_LIMIT) : fetched;
    const channelName = String(broadcaster.display_name || broadcaster.login || "This channel");
    return new Response(renderRosterPage(channelName, characters, parties, channelId, PUBLIC_BASE_URL, truncated, gold, raid, nicknames), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Public bestiary: every monster the channel can hunt right now (core +
  // learned) with its record and adaptation — the page !bestiary links to.
  // Same trust model as /roster.
  if (req.method === "GET" && path === "/bestiary") {
    const channelId = url.searchParams.get("channel");
    if (!channelId || !/^\d+$/.test(channelId)) return new Response("Missing or invalid channel.", { status: 400 });
    const broadcaster = await getBroadcaster(channelId);
    if (!broadcaster || Number(broadcaster.connected) !== 1) return new Response("Bestiary unavailable for this channel.", { status: 404 });
    const [roster, adapt] = await Promise.all([getChannelRoster(channelId), getAdaptations(channelId)]);
    const channelName = String(broadcaster.display_name || broadcaster.login || "This channel");
    return new Response(renderBestiaryPage(channelName, roster, adapt, RAID_MIN_CR, PUBLIC_BASE_URL), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Public gear list: every item the peddler can sell, its effect, and which
  // heroes in the channel carry it. Same trust model as /bestiary.
  if (req.method === "GET" && path === "/gear") {
    const channelId = url.searchParams.get("channel");
    if (!channelId || !/^\d+$/.test(channelId)) return new Response("Missing or invalid channel.", { status: 400 });
    const broadcaster = await getBroadcaster(channelId);
    if (!broadcaster || Number(broadcaster.connected) !== 1) return new Response("Gear list unavailable for this channel.", { status: 404 });
    const characters = await listChannelCharacters(channelId, 1000);
    const channelName = String(broadcaster.display_name || broadcaster.login || "This channel");
    return new Response(renderGearPage(channelName, channelId, characters, PUBLIC_BASE_URL), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Per-channel dashboard for custom commands/chat triggers/timed messages
  // (see dashboard.ts). Capability-token auth via ?key=, handed out in chat
  // with !dashboard — not an operator route, so no ADMIN_API_SECRET here.
  // Also requires a live Twitch-login mod session cookie; renderDashboard
  // shows a login gate instead of the real page when that's missing.
  if (req.method === "GET" && path === "/dashboard") {
    return await renderDashboard(url.searchParams.get("channel"), url.searchParams.get("key"), req.headers.get("Cookie"), PUBLIC_ORIGIN, {
      notice: url.searchParams.get("notice") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
    });
  }
  if (req.method === "GET" && path === "/dashboard/botcheck") {
    // Bot viewer check (botdetect.ts) — same key + mod-login gate as /dashboard.
    return await handleBotCheckPage(url, req.headers.get("Cookie"));
  }
  if (req.method === "GET" && path === "/dashboard/music") {
    // Now playing settings (nowplaying.ts) — same gate.
    return await handleNowPlayingPage(url, req.headers.get("Cookie"));
  }
  if (req.method === "GET" && path === "/dashboard/music/spotify") {
    return await handleSpotifyConnect(url, req.headers.get("Cookie"));
  }
  if (req.method === "GET" && path === "/spotify/callback") {
    // Spotify's OAuth return; trusted by its one-time state, created behind the dashboard gate.
    return await handleSpotifyCallback(url);
  }
  if (req.method === "GET" && path === "/dashboard/pokeballs") {
    // The Pokéball advisor's ball list (pokeball_page.ts) — same gate.
    return await handlePokeballPage(url, req.headers.get("Cookie"));
  }
  if (req.method === "GET" && path === "/dashboard/swearjar") {
    // The swear jar's word list (swearjar_page.ts) — same gate.
    return await handleSwearJarPage(url, req.headers.get("Cookie"));
  }
  if (req.method === "GET" && path === "/dashboard/bots") {
    // The channel's bot list (channel_bots.ts) — same gate.
    return await handleBotListPage(url, req.headers.get("Cookie"));
  }
  if (req.method === "GET" && path === "/dashboard/autoban") {
    // Auto-ban word list + ignore list (autoban_page.ts) — same gate.
    return await handleAutoBanPage(url, req.headers.get("Cookie"));
  }
  if (req.method === "GET" && path === "/dashboard/quotes") {
    // The quote book (quotes.ts) — same gate.
    return await handleQuotesPage(url, req.headers.get("Cookie"));
  }
  if (req.method === "GET" && path === "/dashboard/import") {
    // StreamElements import (se_import.ts) — same gate.
    return await handleImportPage(url, req.headers.get("Cookie"));
  }
  if (req.method === "GET" && path === "/dashboard/go") {
    // Guide cards' "Dashboard switch" links (see handleDashboardGo).
    return await handleDashboardGo(url.searchParams.get("toggle"), req.headers.get("Cookie"), PUBLIC_ORIGIN);
  }
  // Home page "Mod Dashboard" link: Twitch login first, then pick a channel.
  if (req.method === "GET" && path === "/dashboard/start") {
    return await handleDashboardStart(PUBLIC_ORIGIN);
  }
  // Home page "Find a channel" form: Twitch channel name -> that channel's
  // public roster, bestiary, gear list or command list (all need the numeric broadcaster id).
  if (req.method === "GET" && path === "/find") {
    const login = String(url.searchParams.get("channel") ?? "").trim().replace(/^@/, "").toLowerCase();
    const wanted = url.searchParams.get("page");
    const target = wanted === "bestiary" || wanted === "gear" || wanted === "commands" ? wanted : "roster";
    const back = `<p><a href="/">Return to the Guild Hall</a></p>`;
    if (!/^[a-z0-9_]{1,25}$/.test(login)) {
      return page("Channel not found", `<h1>Channel not found</h1><p>Enter a Twitch channel name, like <code>stonedsheamus</code>.</p>${back}`);
    }
    const b = await getBroadcasterByLogin(login);
    if (!b || Number((b as any).connected) !== 1) {
      return page("Channel not found", `<h1>Channel not found</h1><p><strong>${escapeHtml(login)}</strong> doesn't have GuildScribe connected.</p>${back}`);
    }
    return new Response(null, { status: 302, headers: { Location: `/${target}?channel=${encodeURIComponent(String((b as any).broadcaster_id))}` } });
  }
  if (req.method === "GET" && path === "/dashboard/login") {
    return await handleDashboardLogin(url.searchParams.get("channel"), url.searchParams.get("key"), PUBLIC_ORIGIN);
  }
  if (req.method === "GET" && path === "/dashboard/callback") {
    return await handleDashboardCallback(
      url.searchParams.get("code"),
      url.searchParams.get("state"),
      url.searchParams.get("error"),
      PUBLIC_ORIGIN,
    );
  }

  // Operator-only visibility into the open-stall merchant cron: is it
  // ticking, and did the last tick post cleanly? Backed by
  // merchant_cron_status (one row, updated every tick) plus the most recent
  // merchant-related monitor_events for error detail/history.
  // NOTE: these two admin routes must stay above the generic `if
  // (req.method === "GET")` catch-all just below — that block matches any
  // GET request regardless of path, so anything placed after it is
  // unreachable (this previously broke both admin routes silently: they
  // fell through to the homepage instead of running).
  if (req.method === "GET" && path === "/admin/merchant/status") {
    const secret = Deno.env.get("ADMIN_API_SECRET");
    const auth = req.headers.get("Authorization") ?? "";
    if (!secret || secret.length < 32 || auth !== `Bearer ${secret}`) {
      return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    const status = await getMerchantCronStatus();
    const recentEvents = await getMonitorEvents("merchant", 25);
    const now = Date.now();
    const lastRunAt = status ? Number((status as any).last_run_at ?? 0) : 0;
    // No CRON schedule is stored here (that lives in Val Town's UI), so
    // "stale" is a heuristic: no successful tick in the last 20 minutes,
    // which comfortably exceeds any sane Val Town cron interval.
    const staleMs = 20 * 60_000;
    const stale = !lastRunAt || now - lastRunAt > staleMs;
    return new Response(
      JSON.stringify({
        ok: !stale && (!status || Number((status as any).last_posts_failed ?? 0) === 0),
        stale,
        seconds_since_last_run: lastRunAt ? Math.round((now - lastRunAt) / 1000) : null,
        status,
        recent_events: recentEvents,
      }),
      { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  }

  // Operator-only, browser-viewable logs page: merchant cron health,
  // per-channel merchant diagnostics, and recent monitor_events, all in one
  // place instead of digging through raw JSON or Val Town's run history.
  // Browsers can't set an Authorization header on a plain navigation, so
  // this accepts the same secret as a ?key= query param instead (still
  // requires ADMIN_API_SECRET, still never logged anywhere but here).
  if (req.method === "GET" && path === "/admin/logs") {
    const secret = Deno.env.get("ADMIN_API_SECRET");
    const auth = req.headers.get("Authorization") ?? "";
    // NOTE: deliberately NOT using url.searchParams.get("key") here.
    // URLSearchParams follows the application/x-www-form-urlencoded
    // convention where a literal "+" in the query string is decoded as a
    // space — so a secret containing "+" (common in random base64-ish
    // secrets) would silently fail to match after that decoding, even
    // though the key pasted into the URL was correct. Extracting it by hand
    // and decoding only %XX escapes (via decodeURIComponent, which leaves
    // "+" alone) avoids that trap.
    const keyMatch = url.search.slice(1).match(/(?:^|&)key=([^&]*)/);
    const keyParam = keyMatch ? decodeURIComponent(keyMatch[1]) : "";
    const authorized = !!secret && secret.length >= 32 && (auth === `Bearer ${secret}` || keyParam === secret);
    if (!authorized) {
      return new Response("Unauthorized. Append ?key=<ADMIN_API_SECRET> to the URL.", {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const kindFilter = url.searchParams.get("kind") ?? "";
    const [status, overview, events] = await Promise.all([
      getMerchantCronStatus(),
      getMerchantOverview(),
      getMonitorEvents(kindFilter || undefined, 100),
    ]);
    const body = renderAdminLogsPage({ status, overview, events, kindFilter, key: keyParam });
    return new Response(
      scrollDoc("GuildScribe Operator Logs", body, { width: 1140, head: `<meta http-equiv="refresh" content="30">`, css: LEDGER_CSS }),
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
    );
  }

  // Where Twitch delivers each channel's events (eventsub_admin.ts).
  if (path === "/admin/eventsub" || path === "/admin/eventsub/repoint") {
    const routed = await handleEventSubAdminRoute(req, url, path);
    if (routed) return routed;
  }

  // Every connected channel's connection health (see channel_status.ts):
  // disconnected, missing newer permissions, or fine. Same auth as /admin/logs.
  if (req.method === "GET" && path === "/admin/channels") {
    const secret = Deno.env.get("ADMIN_API_SECRET");
    const auth = req.headers.get("Authorization") ?? "";
    const keyMatch = url.search.slice(1).match(/(?:^|&)key=([^&]*)/);
    const keyParam = keyMatch ? decodeURIComponent(keyMatch[1]) : "";
    const authorized = !!secret && secret.length >= 32 && (auth === `Bearer ${secret}` || keyParam === secret);
    if (!authorized) {
      return new Response("Unauthorized. Append ?key=<ADMIN_API_SECRET> to the URL.", {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const list = await listChannelStatuses();
    if (url.searchParams.get("json") === "1") {
      return new Response(JSON.stringify({ ok: true, channels: list }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    return new Response(
      scrollDoc("GuildScribe Channel Connections", renderAdminChannelsPage(list, keyParam), { width: 1140, css: LEDGER_CSS + CHANNEL_STATUS_CSS }),
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
    );
  }

  // Operator escape hatch: mint/fetch a channel's dashboard link without
  // needing the bot online in chat — !dashboard (dashboard.ts) is the normal
  // path, but that requires a live Twitch chat listener, so it's useless
  // exactly when someone most wants to check in (bot down/disconnected).
  // Same auth as /admin/logs: Bearer header or ?key=, hand-decoded to dodge
  // the "+" -> space query-string trap (see note on /admin/logs above).
  // channel= accepts either the numeric broadcaster_id or the Twitch login.
  if (req.method === "GET" && path === "/admin/dashboard-link") {
    const secret = Deno.env.get("ADMIN_API_SECRET");
    const auth = req.headers.get("Authorization") ?? "";
    const keyMatch = url.search.slice(1).match(/(?:^|&)key=([^&]*)/);
    const keyParam = keyMatch ? decodeURIComponent(keyMatch[1]) : "";
    const authorized = !!secret && secret.length >= 32 && (auth === `Bearer ${secret}` || keyParam === secret);
    if (!authorized) {
      return new Response("Unauthorized. Append ?key=<ADMIN_API_SECRET> to the URL.", {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const channelParam = url.searchParams.get("channel");
    if (!channelParam) {
      return new Response("Missing ?channel=<broadcaster_id or twitch login>.", { status: 400 });
    }
    const broadcaster = /^\d+$/.test(channelParam)
      ? await getBroadcaster(channelParam)
      : await getBroadcasterByLogin(channelParam);
    if (!broadcaster) {
      return new Response("No channel found for that id/login.", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const broadcasterId = (broadcaster as any).broadcaster_id as string;
    const reset = url.searchParams.get("reset") === "1";
    const dashKey = reset ? await regenerateDashboardKey(broadcasterId) : await getOrCreateDashboardKey(broadcasterId);
    const link = `${PUBLIC_ORIGIN}/dashboard?channel=${broadcasterId}&key=${dashKey}`;
    // Default behavior: redirect straight to the live dashboard page, since
    // that's what someone opening this in a browser actually wants. Append
    // &json=1 to get the {ok, broadcaster_id, login, link} JSON instead
    // (e.g. for scripting/automation).
    if (url.searchParams.get("json") === "1") {
      return new Response(
        JSON.stringify({ ok: true, broadcaster_id: broadcasterId, login: (broadcaster as any).login ?? null, link }),
        { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }
    return new Response(null, { status: 302, headers: { Location: link, "Cache-Control": "no-store" } });
  }

  // NOTE: the block below matches *any* GET request that reaches this point
  // (it only checks req.method, not path) so it must stay below every other
  // specific GET route above it, including /map and /maps — otherwise it
  // swallows those requests and returns "Missing character user."
  if (req.method === "GET") {
    const username = url.searchParams.get("user");
    const channelId = url.searchParams.get("channel");
    if (!username && !channelId) {
      return page(
        "D&D Twitch Bot",
        `<h1>GuildScribe</h1><p>A D&amp;D guild hall for Twitch — characters, dice, duels, and the codex of rules.</p><p><a class="btn ember" href="/connect">Raise the Guild Banner in My Channel</a></p><p><strong>After joining:</strong> mod the bot with <code>/mod GuildScribeBot</code> so the scribes can speak.</p><p class="muted" style="font-size:.92rem;opacity:.85"><strong>Already connected?</strong> If GuildScribe has gained new features since you joined, <a href="/connect">reconnect your channel</a> to grant any newly requested permissions. This is safe to do any time and won't duplicate or lose your existing data.</p><h2>Visit a guild</h2><form action="/find" method="get" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center"><input name="channel" placeholder="Twitch channel name" aria-label="Twitch channel name" required autocomplete="off"><button type="submit" name="page" value="roster">Roster</button><button type="submit" name="page" value="bestiary">Bestiary</button><button type="submit" name="page" value="gear">Gear</button><button type="submit" name="page" value="commands">Commands</button></form><p><a class="btn ghost" href="/dashboard/start">Mod Dashboard</a> <span class="muted" style="font-size:.92rem;opacity:.85">Log in with Twitch to manage a channel you own or moderate.</span></p><p><a href="${PUBLIC_BASE_URL}/guide">Open the Guild Codex</a> · <a href="/donate">Support the Guild</a> · <a href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener">Discord</a>${Deno.env.get("SUPPORT_URL") ? ` · <a href="${escapeHtml(Deno.env.get("SUPPORT_URL")!)}">Support / Contact</a>` : ""} · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>`,
      );
    }
    if (!username) return new Response("Missing character user.", { status: 400 });
    if (!channelId || !/^\d+$/.test(channelId)) return new Response("Missing or invalid channel.", { status: 400 });
    const broadcaster = await getBroadcaster(channelId);
    if (!broadcaster || Number(broadcaster.connected) !== 1) return new Response("Character page unavailable for this channel.", { status: 404 });
    const c = await getCharacter(username.toLowerCase(), channelId);
    if (!c) return new Response("No character found for that user in this channel.", { status: 404 });
    return new Response(renderCharacterPage(c), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (req.method === "POST" && path.startsWith("/admin/channels/")) {
    const secret = Deno.env.get("ADMIN_API_SECRET");
    const auth = req.headers.get("Authorization") ?? "";
    if (!secret || secret.length < 32 || auth !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
    const match = path.match(/^\/admin\/channels\/(\d+)\/(disable|enable)$/);
    if (!match) return new Response("Not found", { status: 404 });
    const broadcasterId = match[1];
    if (match[2] === "disable") {
      await blockChannel(broadcasterId, "operator override");
      await recordMonitorEvent("operator_disable", broadcasterId);
      return new Response(JSON.stringify({ ok: true, broadcaster_id: broadcasterId, blocked: true }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    await unblockChannel(broadcasterId);
    await recordMonitorEvent("operator_enable", broadcasterId);
    return new Response(JSON.stringify({ ok: true, broadcaster_id: broadcasterId, blocked: false }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  // Per-channel web dashboard for custom commands/triggers/timed messages —
  // see dashboard.ts. Auth is the dashboard_key form field, not an operator
  // secret, so unlike /admin/* above these don't check ADMIN_API_SECRET.
  if (req.method === "POST" && path === "/dashboard/commands") {
    return await handleDashboardCommandsForm(await req.formData(), PUBLIC_ORIGIN, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/triggers") {
    return await handleDashboardTriggersForm(await req.formData(), PUBLIC_ORIGIN, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/timedmessages") {
    return await handleDashboardTimedMessagesForm(await req.formData(), PUBLIC_ORIGIN, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/botcheck") {
    return await handleBotCheckForm(await req.formData(), PUBLIC_ORIGIN, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/music") {
    return await handleNowPlayingForm(await req.formData(), PUBLIC_ORIGIN, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/pokeballs") {
    return await handlePokeballForm(await req.formData(), PUBLIC_ORIGIN, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/swearjar") {
    return await handleSwearJarForm(await req.formData(), PUBLIC_ORIGIN, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/bots") {
    return await handleBotListForm(await req.formData(), PUBLIC_ORIGIN, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/autoban") {
    return await handleAutoBanForm(await req.formData(), PUBLIC_ORIGIN, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/quotes") {
    return await handleQuotesForm(await req.formData(), PUBLIC_ORIGIN, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/import") {
    return await handleImportForm(await req.formData(), PUBLIC_ORIGIN, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/features") {
    return await handleDashboardFeaturesForm(await req.formData(), PUBLIC_ORIGIN, req.headers.get("Cookie"));
  }
  return null;
}

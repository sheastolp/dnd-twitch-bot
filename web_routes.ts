// GuildScribe — every web (non-EventSub) route: health check, static pages,
// broadcaster OAuth connect/callback, character/map/roster pages, the
// per-channel dashboard and the operator /admin routes. Split out of main.ts
// to keep files well under Val Town's per-file size ceiling. Returns null
// when no route matched, so main.ts carries on to the EventSub webhook.

import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { getCharacter, getBroadcaster, listChannelCharacters, listChannelParties, getBroadcasterByLogin, getOrCreateDashboardKey, regenerateDashboardKey, blockChannel, unblockChannel, recordMonitorEvent, getMerchantCronStatus, getMerchantOverview, getMonitorEvents, queueEventSubCancellation, getPendingEventSubCancellations, clearPendingEventSubCancellation, saveExtraEventSubSubscription, getExtraEventSubSubscriptions, deleteExtraEventSubSubscriptions, getMap, getMapCells, getMapTokens, listMaps, markStreamStatusSubscribed, isCommandGroupEnabled } from "./db.ts";
import { saveBroadcasterAdToken } from "./ads_db.ts";
import { isPointsEnabled, listChannelBalances } from "./points_db.ts";
import { getRaidRosterStatus, RAID_MIN_CR } from "./raid.ts";
import { getAdaptations, getChannelRoster } from "./bestiary.ts";
import { renderBestiaryPage } from "./bestiary_page.ts";
import { subscribeToRedemptions } from "./redemptions.ts";
import { renderDashboard, handleDashboardLogin, handleDashboardCallback, handleDashboardCommandsForm, handleDashboardTriggersForm, handleDashboardTimedMessagesForm, handleDashboardFeaturesForm, handleDashboardGo } from "./dashboard.ts";
import { env, fetchIsChannelLiveNow, exchangeCode, createChatSubscription, createSubEventSubscriptions, createRaidEventSubscription, createStreamStatusEventSubscriptions, deleteEventSubSubscription } from "./twitch.ts";
import { escapeHtml } from "./utils.ts";
import { page, renderCharacterPage, renderGuidePage, renderMapPage, renderMapListPage, renderRosterPage, renderAdminLogsPage } from "./pages.ts";
import { PUBLIC_BASE_URL } from "./config.ts";
import { handleBotConnectRoute } from "./whisper.ts";
import { handleReplyPageRoute } from "./replypages.ts";
import { handleOverlayRoute } from "./overlay.ts";
import { handleHowtoRoute } from "./howto.ts";

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


export async function handleWebRoute(req: Request, url: URL, path: string): Promise<Response | null> {
  // ── Static / GET routes ──
  // NOTE: activity logs are intentionally NOT exposed as a public web route.
  // They contain per-channel usernames and command text; the only way to see
  // them is the in-chat `!logs` command, which is restricted to the
  // broadcaster/moderators of that specific channel (see below).
  if (req.method === "GET" && path === "/healthz") {
    try {
      try { await retryPendingEventSubCancellations(); } catch (e) { await recordMonitorEvent("eventsub_retry_loop_error", String(e)); }
      await sqlite.execute("SELECT 1");
      return new Response(JSON.stringify({ ok: true, service: "GuildScribe", time: new Date().toISOString() }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch (e) {
      await recordMonitorEvent("health_error", String(e));
      return new Response(JSON.stringify({ ok: false }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
  }
  if (req.method === "GET" && path === "/privacy") {
    return page("GuildScribe Privacy Policy", `<h1>GuildScribe Privacy Policy</h1><p>GuildScribe receives Twitch usernames/user IDs, channel IDs, command text, character/party/gameplay data, coin (points) balances and giveaway entries for channels that turn those on, per-viewer watch-time totals (time active in chat while a stream is live), and basic connection/subscription state when a channel connects the bot.</p><h2>How it is used</h2><p>Data is used only to operate the Twitch bot, keep characters and parties working, troubleshoot abuse/errors, and provide channel activity logs to that channel's broadcaster/moderators.</p><h2>Retention</h2><p>Activity logs are kept for up to 90 days and are capped at 5,000 rows per channel. Character and party data remains while a channel uses GuildScribe unless the channel requests deletion. OAuth state records expire after 10 minutes. Connection records are removed when a channel disconnects.</p><h2>Deletion</h2><p>The connected broadcaster can use <code>!dndbot leave purge</code> to disconnect and request deletion of that channel's stored characters, parties, coin balances, giveaway entries, logs, and gameplay state. For other deletion requests, contact ${escapeHtml(Deno.env.get("SUPPORT_URL") ?? "the project operator through the support link on the home page")}.</p><p><a href="/">Return to GuildScribe</a></p>`);
  }
  if (req.method === "GET" && (path === "/terms" || path === "/tos")) {
    return page("GuildScribe Terms of Service", `<h1>GuildScribe Terms of Service</h1><p>GuildScribe is a fan-made Twitch utility for D&amp;D-style character and chat gameplay. Use it lawfully and respectfully, and follow Twitch's rules and the streamer/channel's rules.</p><p>Do not use the bot to harass, spam, abuse, evade moderation, or interfere with other users. Channel owners are responsible for deciding whether the bot is appropriate for their community.</p><p>The service may be changed, limited, suspended, or removed at any time. Gameplay data and generated results are not guaranteed to be preserved.</p><p>Report abuse or request account/channel assistance through the support contact on the home page.</p><p><a href="/">Return to GuildScribe</a></p>`);
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
      `<h1>Support the Guild</h1><p>If GuildScribe has served your campaign, you can leave a tribute so the scribes may keep the halls open.</p><h2>Ethereum (ETH)</h2><p><code class="address">0x422413678AdFC67d3d9AB545FE4e1ec1D00197fd</code></p><p>Send ETH on the Ethereum network. Verify the address and network in your wallet before confirming.</p><h2>Bitcoin (BTC)</h2><p><code class="address">3JYo1Vwyh6aQENzXoi16rA9mXZuZQVL1rN</code></p><p>Send BTC on the Bitcoin network. Verify the address carefully before confirming.</p><p><a href="/">Return to the Guild Hall</a></p><style>.address{display:block;word-break:break-all;padding:12px;font-size:.95rem}</style>`,
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
      redirect_uri: `${url.origin}/callback`,
      response_type: "code",
      scope: "channel:bot channel:read:subscriptions channel:read:ads channel:read:redemptions moderator:manage:banned_users moderator:read:followers moderator:read:chatters",
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
      const token = await exchangeCode(code, `${url.origin}/callback`);
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

      const sub = await createChatSubscription(user.id, url.origin);
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
        const { newSub, resub, gift } = await createSubEventSubscriptions(user.id, url.origin);
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
        const raidSub = await createRaidEventSubscription(user.id, url.origin);
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
        const { online, offline } = await createStreamStatusEventSubscriptions(user.id, url.origin);
        await saveExtraEventSubSubscription(user.id, "stream_online", online.id);
        await saveExtraEventSubSubscription(user.id, "stream_offline", offline.id);
        await markStreamStatusSubscribed(user.id, await fetchIsChannelLiveNow(user.id));
      } catch (e) {
        await recordMonitorEvent("eventsub_stream_status_subscription_failed", `${user.id}: ${String(e)}`);
      }
      // Best-effort: channel-point rewards that shield/hex players (see
      // redemptions.ts). Needs channel:read:redemptions, requested above.
      try {
        await subscribeToRedemptions(user.id, url.origin);
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
  if (req.method === "GET" && path === "/roster") {
    const channelId = url.searchParams.get("channel");
    if (!channelId || !/^\d+$/.test(channelId)) return new Response("Missing or invalid channel.", { status: 400 });
    const broadcaster = await getBroadcaster(channelId);
    if (!broadcaster || Number(broadcaster.connected) !== 1) return new Response("Roster unavailable for this channel.", { status: 404 });
    const ROSTER_LIMIT = 1000;
    const [fetched, parties, goldOn, raidOn] = await Promise.all([
      listChannelCharacters(channelId, ROSTER_LIMIT + 1),
      listChannelParties(channelId),
      isPointsEnabled(channelId),
      isCommandGroupEnabled(channelId, "raid"),
    ]);
    // Raid card only while the channel has the raid quest switched on.
    const raid = raidOn ? await getRaidRosterStatus(channelId) : null;
    // Gold column only while the channel has gold on (!gold on/off).
    const gold = goldOn ? await listChannelBalances(channelId) : undefined;
    const truncated = fetched.length > ROSTER_LIMIT;
    const characters = truncated ? fetched.slice(0, ROSTER_LIMIT) : fetched;
    const channelName = String(broadcaster.display_name || broadcaster.login || "This channel");
    return new Response(renderRosterPage(channelName, characters, parties, channelId, PUBLIC_BASE_URL, truncated, gold, raid), {
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

  // Per-channel dashboard for custom commands/chat triggers/timed messages
  // (see dashboard.ts). Capability-token auth via ?key=, handed out in chat
  // with !dashboard — not an operator route, so no ADMIN_API_SECRET here.
  // Also requires a live Twitch-login mod session cookie; renderDashboard
  // shows a login gate instead of the real page when that's missing.
  if (req.method === "GET" && path === "/dashboard") {
    return await renderDashboard(url.searchParams.get("channel"), url.searchParams.get("key"), req.headers.get("Cookie"), url.origin, {
      notice: url.searchParams.get("notice") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
    });
  }
  if (req.method === "GET" && path === "/dashboard/go") {
    // Guide cards' "Dashboard switch" links (see handleDashboardGo).
    return await handleDashboardGo(url.searchParams.get("toggle"), req.headers.get("Cookie"), url.origin);
  }
  if (req.method === "GET" && path === "/dashboard/login") {
    return await handleDashboardLogin(url.searchParams.get("channel"), url.searchParams.get("key"), url.origin);
  }
  if (req.method === "GET" && path === "/dashboard/callback") {
    return await handleDashboardCallback(
      url.searchParams.get("code"),
      url.searchParams.get("state"),
      url.searchParams.get("error"),
      url.origin,
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
    const link = `${url.origin}/dashboard?channel=${broadcasterId}&key=${dashKey}`;
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
        `<h1>GuildScribe</h1><p>A D&amp;D guild hall for Twitch — characters, dice, duels, and the codex of rules.</p><p><a class="btn" href="/connect">Raise the Guild Banner in My Channel</a></p><p><strong>After joining:</strong> mod the bot with <code>/mod GuildScribeBot</code> so the scribes can speak.</p><p class="muted" style="font-size:.92rem;opacity:.85"><strong>Already connected?</strong> If GuildScribe has gained new features since you joined, <a href="/connect">reconnect your channel</a> to grant any newly requested permissions. This is safe to do any time and won't duplicate or lose your existing data.</p><p><a href="${PUBLIC_BASE_URL}/guide">Open the Guild Codex</a> · <a href="/donate">Support the Guild</a>${Deno.env.get("SUPPORT_URL") ? ` · <a href="${escapeHtml(Deno.env.get("SUPPORT_URL")!)}">Support / Contact</a>` : ""}</p>`,
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
    return await handleDashboardCommandsForm(await req.formData(), url.origin, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/triggers") {
    return await handleDashboardTriggersForm(await req.formData(), url.origin, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/timedmessages") {
    return await handleDashboardTimedMessagesForm(await req.formData(), url.origin, req.headers.get("Cookie"));
  }
  if (req.method === "POST" && path === "/dashboard/features") {
    return await handleDashboardFeaturesForm(await req.formData(), url.origin, req.headers.get("Cookie"));
  }
  return null;
}

// GuildScribe — Twitch D&D bot entry point
// Val Town / Deno HTTP handler

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

import {
  ensureTables,
  getCharacter,
  saveCharacter,
  adjustHp,
  backupCharacter,
  loadBackup,
  resetCharacter,
  getConnections,
  isChannelEnabled,
  setChannelEnabled,
  recordActivity,
  getRecentLogs,
  getBroadcaster,
  listChannelCharacters,
  listChannelParties,
  getBroadcasterByLogin,
  getOrCreateDashboardKey,
  regenerateDashboardKey,
  markBroadcasterDisconnected,
  disconnectBroadcasterData,
  purgeChannelData,
  isChannelBlocked,
  blockChannel,
  unblockChannel,
  recordMonitorEvent,
  getMerchantCronStatus,
  getMerchantOverview,
  getMonitorEvents,
  checkCommandRateLimit,
  checkGoodnightCooldown,
  claimEventSubMessage,
  queueEventSubCancellation,
  getPendingEventSubCancellations,
  clearPendingEventSubCancellation,
  saveExtraEventSubSubscription,
  getExtraEventSubSubscriptions,
  deleteExtraEventSubSubscriptions,
  getMap,
  getMapCells,
  getMapTokens,
  listMaps,
  saveCreationSession,
  isCommandGroupEnabled,
  setBroadcasterLiveStatus,
  markStreamStatusSubscribed,
} from "./db.ts";
import {
  ensureSocialTables,
  recordDiceRollEvent,
  getDiceLeaderboard,
  getDiceStatsForUser,
} from "./social_db.ts";
import { handleMapCommand } from "./maps.ts";
import { handleMerchantCommand } from "./merchant.ts";
import { handleHaggleCommand } from "./haggle.ts";
import { handleAdCommand } from "./ads.ts";
import {
  disconnectAdToken,
  ensureAdTables,
  purgeAdData,
  saveBroadcasterAdToken,
} from "./ads_db.ts";
import { handleOracleCommand } from "./oracle.ts";
import { handleChronicleCommand, maybeChronicleQuote, recordChronicleBotMessage } from "./chronicle.ts";
import { handlePointsCommand, maybeAwardChatPoints } from "./points.ts";
import { handleRobCommand } from "./rob.ts";
import { handleAutohuntCommand } from "./autohunt.ts";
import { ensureHuntCooldownTables, handleHuntCooldownCommand, purgeHuntCooldownData } from "./huntcooldown.ts";
import { ensureAutohuntTables, purgeAutohuntData } from "./autohunt_db.ts";
import { disconnectPointsData, ensurePointsTables, purgePointsData } from "./points_db.ts";
import { ensureAutoBanTables, handleAutoBanCommand, maybeAutoBan, purgeAutoBanData } from "./autoban.ts";
import { handleNpcCommand, maybeNpcChatter, recordNpcChatterBotMessage } from "./npcs.ts";
import {
  handleCustomCommandManagement,
  handleCustomCommandInvocation,
  handleTriggerMatch,
} from "./customcommands.ts";
import { handleTimedMessageCommand } from "./timedmessages.ts";
import {
  handleDashboardCommand,
  renderDashboard,
  handleDashboardLogin,
  handleDashboardCallback,
  handleDashboardCommandsForm,
  handleDashboardTriggersForm,
  handleDashboardTimedMessagesForm,
  handleDashboardFeaturesForm,
} from "./dashboard.ts";
import {
  generateCharacter,
  handleCreationCommand,
  adjustLevel,
} from "./characters.ts";
import {
  handleDuelCommand,
  handleMonsterDuelCommand,
  handlePartyCommand,
  handlePartyDuelCommand,
  handleInitiativeCommand,
} from "./combat.ts";
import { lookup5e, formatSpellSections, formatLookup } from "./lookups.ts";
import {
  env,
  sendChatMessage,
  sendChatMessages,
  sendSpellSections,
  fetchIsChannelLiveNow,
  exchangeCode,
  createChatSubscription,
  createSubEventSubscriptions,
  createRaidEventSubscription,
  createStreamStatusEventSubscriptions,
  verifyEventSub,
  deleteEventSubSubscription,
} from "./twitch.ts";
import {
  formatRaceName,
  formatStatLine,
  escapeHtml,
  rollDice,
  rollFate,
  rollHug,
  renderShmash,
  rollNewSubThankYou,
  rollResubThankYou,
  rollGiftSubThankYou,
  rollRaidThankYou,
  resolveCheckKind,
  modifier,
  isBotAccount,
  hasModeratorBadge,
  logRowText,
  isGoodnightMessage,
  goodnightReply,
  groupForCommand,
} from "./utils.ts";
import { classes } from "./data.ts";
import { chatHelpText } from "./help.ts";
import { page, renderCharacterPage, renderGuidePage, renderMapPage, renderMapListPage, renderRosterPage, renderAdminLogsPage } from "./pages.ts";
import { rollBG3Character, rollBG3Companion, rollBG3Origin, rollBG3Loot, rollBG3Camp, handleBg3Command } from "./bg3.ts";
import { findBg3Entry, formatBg3Entry, parseBg3LookupQuery, bg3CategoryList } from "./bg3lookup.ts";

// Public HTTP trigger URL for this val (used for guide links in chat).
// OAuth redirects and character page links still use the request origin dynamically.
const PUBLIC_BASE_URL = Deno.env.get("PUBLIC_BASE_URL") ?? "https://guildscribe.val.run";

// Durable per-channel/user throttling is stored in SQLite so it survives restarts
// and remains consistent if the deployment scales beyond one warm instance.
const COMMAND_COOLDOWN_MS = Math.max(250, Number(Deno.env.get("COMMAND_COOLDOWN_MS") ?? "1200"));
const GOODNIGHT_COOLDOWN_MS = Math.max(30_000, Number(Deno.env.get("GOODNIGHT_COOLDOWN_MS") ?? "300000"));

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

async function sendWelcomeMessage(display: string, broadcasterId: string) {
  await sendChatMessages(
    `@${display} Welcome to the Guild Hall, adventurer! 📜 Create your legend with !createchar or !newchar, check your parchment with !char, gather a company with !party create <name>, and consult the archives with !dndbothelp. Full guild codex: ${PUBLIC_BASE_URL}/guide`,
    broadcasterId,
  );
}

/** One-time, best-effort backfill for a channel that connected before the
 * "quiet while offline" feature existed (stream_status_subscribed = 0), so
 * it doesn't need to disconnect/reconnect to get it. Creates the
 * stream.online/offline subscriptions, seeds is_live with one direct Twitch
 * lookup, and flips stream_status_subscribed so this never runs again for
 * that channel. Called lazily, only the first time a message would
 * otherwise be silenced as "offline" — never on the normal hot path once a
 * channel is caught up. */
async function backfillStreamStatusSubscription(broadcasterId: string, baseUrl: string) {
  try {
    const { online, offline } = await createStreamStatusEventSubscriptions(broadcasterId, baseUrl);
    await saveExtraEventSubSubscription(broadcasterId, "stream_online", online.id);
    await saveExtraEventSubSubscription(broadcasterId, "stream_offline", offline.id);
    await markStreamStatusSubscribed(broadcasterId, await fetchIsChannelLiveNow(broadcasterId));
  } catch (e) {
    await recordMonitorEvent("eventsub_stream_status_backfill_failed", `${broadcasterId}: ${String(e)}`);
    // Leave stream_status_subscribed at 0 so this is retried on the next
    // otherwise-silenced message rather than getting stuck failed forever.
  }
}

// Schema setup is ~90 sequential SQLite round-trips (CREATE TABLE IF NOT
// EXISTS, ALTER TABLE probes, migrations). It only needs to run once per
// isolate, not on every request — so memoize the promise. If it fails, clear
// the memo so the next request retries instead of caching the failure.
let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      // db.ts first (other files' tables don't depend on it, but its
      // migrations are the slow/ordered part); the rest are independent.
      await ensureTables();
      await Promise.all([
        ensureAdTables(),
        ensureAutoBanTables(),
        ensureSocialTables(),
        ensurePointsTables(),
        ensureAutohuntTables(),
        ensureHuntCooldownTables(),
      ]);
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

async function handleRequest(req: Request): Promise<Response> {
  await ensureSchema();
  const url = new URL(req.url);
  const path = url.pathname;

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
    return page("GuildScribe Privacy Policy", `<h1>GuildScribe Privacy Policy</h1><p>GuildScribe receives Twitch usernames/user IDs, channel IDs, command text, character/party/gameplay data, coin (points) balances and giveaway entries for channels that turn those on, and basic connection/subscription state when a channel connects the bot.</p><h2>How it is used</h2><p>Data is used only to operate the Twitch bot, keep characters and parties working, troubleshoot abuse/errors, and provide channel activity logs to that channel's broadcaster/moderators.</p><h2>Retention</h2><p>Activity logs are kept for up to 90 days and are capped at 5,000 rows per channel. Character and party data remains while a channel uses GuildScribe unless the channel requests deletion. OAuth state records expire after 10 minutes. Connection records are removed when a channel disconnects.</p><h2>Deletion</h2><p>The connected broadcaster can use <code>!dndbot leave purge</code> to disconnect and request deletion of that channel's stored characters, parties, coin balances, giveaway entries, logs, and gameplay state. For other deletion requests, contact ${escapeHtml(Deno.env.get("SUPPORT_URL") ?? "the project operator through the support link on the home page")}.</p><p><a href="/">Return to GuildScribe</a></p>`);
  }
  if (req.method === "GET" && (path === "/terms" || path === "/tos")) {
    return page("GuildScribe Terms of Service", `<h1>GuildScribe Terms of Service</h1><p>GuildScribe is a fan-made Twitch utility for D&amp;D-style character and chat gameplay. Use it lawfully and respectfully, and follow Twitch's rules and the streamer/channel's rules.</p><p>Do not use the bot to harass, spam, abuse, evade moderation, or interfere with other users. Channel owners are responsible for deciding whether the bot is appropriate for their community.</p><p>The service may be changed, limited, suspended, or removed at any time. Gameplay data and generated results are not guaranteed to be preserved.</p><p>Report abuse or request account/channel assistance through the support contact on the home page.</p><p><a href="/">Return to GuildScribe</a></p>`);
  }
  if (req.method === "GET" && (path === "/guide" || path === "/commands")) {
    return page(
      "GuildScribe Codex",
      `<h1>GuildScribe Codex</h1><p class="intro">The guild’s book of rites — every command for adventurers at the table.</p>${renderGuidePage()}`,
    );
  }
  if (req.method === "GET" && (path === "/donate" || path === "/donations")) {
    return page(
      "Support the Guild",
      `<h1>Support the Guild</h1><p>If GuildScribe has served your campaign, you can leave a tribute so the scribes may keep the halls open.</p><h2>Ethereum (ETH)</h2><p><code class="address">0x422413678AdFC67d3d9AB545FE4e1ec1D00197fd</code></p><p>Send ETH on the Ethereum network. Verify the address and network in your wallet before confirming.</p><h2>Bitcoin (BTC)</h2><p><code class="address">3JYo1Vwyh6aQENzXoi16rA9mXZuZQVL1rN</code></p><p>Send BTC on the Bitcoin network. Verify the address carefully before confirming.</p><p><a href="/">Return to the Guild Hall</a></p><style>.address{display:block;word-break:break-all;background:#111;border:1px solid #444;padding:12px;border-radius:6px;color:#9fe870}</style>`,
    );
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
      scope: "channel:bot channel:read:subscriptions channel:read:ads moderator:manage:banned_users",
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
    const [fetched, parties] = await Promise.all([listChannelCharacters(channelId, ROSTER_LIMIT + 1), listChannelParties(channelId)]);
    const truncated = fetched.length > ROSTER_LIMIT;
    const characters = truncated ? fetched.slice(0, ROSTER_LIMIT) : fetched;
    const channelName = String(broadcaster.display_name || broadcaster.login || "This channel");
    return new Response(renderRosterPage(channelName, characters, parties, channelId, PUBLIC_BASE_URL, truncated), {
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
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="30"><title>GuildScribe Operator Logs</title><style>:root{color-scheme:dark}body{font-family:Georgia,serif;max-width:1100px;margin:32px auto;background:#15120f;color:#f4eadb;padding:20px}h1{color:#e6a56e;margin-bottom:4px}a{color:#e6a56e}</style></head><body>${body}</body></html>`,
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
        `<h1>GuildScribe</h1><p>A D&amp;D guild hall for Twitch — characters, dice, duels, and the codex of rules.</p><p><a href="/connect">Raise the Guild Banner in My Channel</a></p><p><strong>After joining:</strong> mod the bot with <code>/mod GuildScribeBot</code> so the scribes can speak.</p><p class="muted" style="font-size:.92rem;opacity:.85"><strong>Already connected?</strong> If GuildScribe has gained new features since you joined, <a href="/connect">reconnect your channel</a> to grant any newly requested permissions. This is safe to do any time and won't duplicate or lose your existing data.</p><p><a href="${PUBLIC_BASE_URL}/guide">Open the Guild Codex</a> · <a href="/donate">Support the Guild</a>${Deno.env.get("SUPPORT_URL") ? ` · <a href="${escapeHtml(Deno.env.get("SUPPORT_URL")!)}">Support / Contact</a>` : ""}</p>`,
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

  if (req.method !== "POST") return new Response("OK");

  // ── EventSub webhook ──
  const rawBody = await req.text();
  if (!(await verifyEventSub(req, rawBody))) return new Response("Invalid signature", { status: 403 });
  const messageId = req.headers.get("Twitch-Eventsub-Message-Id") ?? "";
  if (!(await claimEventSubMessage(messageId))) return new Response("OK");
  const messageType = req.headers.get("Twitch-Eventsub-Message-Type");
  const body = JSON.parse(rawBody);

  if (messageType === "webhook_callback_verification") {
    return new Response(body.challenge, { headers: { "Content-Type": "text/plain" } });
  }

  if (messageType === "notification") {
    const subscriptionType = String(body.subscription?.type ?? "");

    if (
      subscriptionType === "channel.subscribe" ||
      subscriptionType === "channel.subscription.message" ||
      subscriptionType === "channel.subscription.gift"
    ) {
      const subBroadcasterId: string = body.event?.broadcaster_user_id ?? "";
      const subUserLogin: string = body.event?.user_login ?? "";
      const subDisplay: string = body.event?.user_name ?? subUserLogin;
      const tier: string | undefined = body.event?.tier;
      const isAnonymousGifter = subscriptionType === "channel.subscription.gift" && Boolean(body.event?.is_anonymous);
      if (!subBroadcasterId || (!isAnonymousGifter && isBotAccount(subUserLogin, body.event?.user_id ?? "", env("TWITCH_BOT_ID")))) {
        return new Response("OK");
      }
      const subConnection = await getBroadcaster(subBroadcasterId);
      if (!subConnection || Number(subConnection.connected) !== 1) return new Response("OK");
      if (await isChannelBlocked(subBroadcasterId)) return new Response("OK");
      if (!(await isChannelEnabled(subBroadcasterId))) return new Response("OK");
      // Subs/resubs/gifts can land while the channel is offline — stay quiet
      // rather than thanking someone into an empty, offline chat. is_live is
      // kept current by the stream.online/offline notifications below, so
      // this reuses the connection row already fetched above (no extra call).
      if (Number(subConnection.is_live) !== 1) return new Response("OK");

      // A gift batch fires ONE channel.subscription.gift (with the total)
      // plus one channel.subscribe (is_gift=true) per recipient. Only the
      // batch event gets a thank-you, so a 10-gift bomb is one message
      // instead of eleven.
      if (subscriptionType === "channel.subscribe" && body.event?.is_gift) return new Response("OK");

      const thankYou =
        subscriptionType === "channel.subscribe"
          ? rollNewSubThankYou(subDisplay, tier)
          : subscriptionType === "channel.subscription.gift"
            ? rollGiftSubThankYou(isAnonymousGifter ? null : subDisplay, Number(body.event?.total ?? 1), tier)
            : rollResubThankYou(subDisplay, Number(body.event?.cumulative_months ?? 1), tier);
      if (thankYou) await sendChatMessage(thankYou, subBroadcasterId);
      return new Response("OK");
    }

    if (subscriptionType === "channel.raid") {
      // channel.raid fires on the *receiving* channel's condition
      // (to_broadcaster_user_id), so the "from" fields identify the raider.
      const raidBroadcasterId: string = body.event?.to_broadcaster_user_id ?? "";
      const raiderLogin: string = body.event?.from_broadcaster_user_login ?? "";
      const raiderId: string = body.event?.from_broadcaster_user_id ?? "";
      const raiderDisplay: string = body.event?.from_broadcaster_user_name ?? raiderLogin;
      const viewers = Number(body.event?.viewers ?? 0);
      if (!raidBroadcasterId || isBotAccount(raiderLogin, raiderId, env("TWITCH_BOT_ID"))) {
        return new Response("OK");
      }
      const raidConnection = await getBroadcaster(raidBroadcasterId);
      if (!raidConnection || Number(raidConnection.connected) !== 1) return new Response("OK");
      if (await isChannelBlocked(raidBroadcasterId)) return new Response("OK");
      if (!(await isChannelEnabled(raidBroadcasterId))) return new Response("OK");
      // Stay quiet rather than thanking a raider into an offline channel
      // (reuses raidConnection.is_live already fetched above).
      if (Number(raidConnection.is_live) !== 1) return new Response("OK");
      await sendChatMessage(rollRaidThankYou(raiderDisplay, viewers), raidBroadcasterId);
      return new Response("OK");
    }

    // Stream going live/offline — just keeps broadcasters.is_live current so
    // every other check above/below (and the merchant/timed-message crons)
    // can read it as a plain column instead of calling Twitch on every
    // message. No chat reply of its own.
    if (subscriptionType === "stream.online" || subscriptionType === "stream.offline") {
      const liveBroadcasterId: string = body.event?.broadcaster_user_id ?? "";
      if (liveBroadcasterId) {
        await setBroadcasterLiveStatus(liveBroadcasterId, subscriptionType === "stream.online");
      }
      return new Response("OK");
    }

    const chatMessage: string = body.event?.message?.text ?? "";
    const chatter: string = body.event?.chatter_user_login ?? "";
    const display: string = body.event?.chatter_user_name ?? chatter;
    const chatterId: string = body.event?.chatter_user_id ?? "";
    const moderatorId: string = body.event?.moderator_user_id ?? "";
    const eventBroadcasterId: string = body.event?.broadcaster_user_id ?? "";
    const broadcasterId: string = eventBroadcasterId;
    const isModerator =
      chatterId === broadcasterId ||
      chatterId === eventBroadcasterId ||
      chatterId === moderatorId ||
      hasModeratorBadge(body.event);
    const baseUrl = url.origin;

    if (isBotAccount(chatter, chatterId, env("TWITCH_BOT_ID"))) {
      // Bot messages (Nightbot, StreamElements, GuildScribe itself, etc.)
      // never get processed as commands, quoted by the chronicle, or replied
      // to by random NPC chatter, but they still count as chat activity
      // toward each feature's own minimum-messages gate.
      await recordChronicleBotMessage(broadcasterId);
      await recordNpcChatterBotMessage(broadcasterId);
      return new Response("OK");
    }

    // Only process events for an actively connected broadcaster. This makes a
    // stale EventSub subscription harmless after disconnect/offboarding.
    // The connection row and the operator blocklist are independent reads —
    // fetch them concurrently instead of back-to-back.
    const [connection, blocked] = await Promise.all([
      getBroadcaster(broadcasterId),
      isChannelBlocked(broadcasterId),
    ]);
    if (!connection || Number(connection.connected) !== 1) return new Response("OK");

    // Operator blocklist always wins.
    if (blocked) return new Response("OK");

    // Auto-ban "ai viewers" spam (see autoban.ts). Runs before the
    // offline-quiet gate below so spammers are banned even when the stream
    // is offline; the announcement itself stays quiet while offline. Off by
    // default per channel (!autoban on). Mods/broadcaster are exempt.
    if (
      await maybeAutoBan(chatMessage, display, chatterId, broadcasterId, isModerator, Number(connection.is_live) === 1, baseUrl)
    ) return new Response("OK");

    // Stay quiet in chat while the channel is offline — but let the
    // broadcaster/mods keep using every command normally so they can test
    // GuildScribe without going live. Ambient/scheduled sends that don't come
    // from a specific chat message (sub/raid thank-yous above, merchant ads
    // and timed messages in their own cron files) are gated the same way,
    // with no mod exception since there's no "requesting user" for those.
    // connection.is_live is a plain column already fetched above — kept
    // current by the stream.online/offline notifications below, so this
    // check costs nothing extra (no Twitch API call in this hot path) for a
    // channel that's already caught up.
    // Exception: !roster only posts a read-only link to the roster page, so it
    // answers anyone even while offline (viewers browse the roster between streams).
    const offlineExempt = /^!roster$/i.test(chatMessage);
    if (!isModerator && !offlineExempt && Number(connection.is_live) !== 1) {
      // Channel connected before this feature existed — one-time backfill,
      // then re-check; every later message for this channel skips straight
      // to the column read above.
      if (Number(connection.stream_status_subscribed) !== 1) {
        await backfillStreamStatusSubscription(broadcasterId, url.origin);
        const refreshed = await getBroadcaster(broadcasterId);
        if (!refreshed || Number(refreshed.is_live) !== 1) return new Response("OK");
      } else {
        return new Response("OK");
      }
    }

    // Broadcaster-only disconnect/offboarding. `purge` additionally deletes channel data.
    const leaveMatch = chatMessage.trim().match(/^!dndbot\s+leave(?:\s+(purge))?$/i);
    if (leaveMatch) {
      if (chatterId !== broadcasterId && chatterId !== eventBroadcasterId) {
        await sendChatMessage(`@${display} only the broadcaster can disconnect GuildScribe.`, broadcasterId);
        return new Response("OK");
      }
      const purge = Boolean(leaveMatch[1]);
      const connection = await getBroadcaster(broadcasterId);
      try {
        if (connection?.subscription_id) await deleteEventSubSubscription(String(connection.subscription_id));
      } catch (e) {
        await queueEventSubCancellation(String(connection.subscription_id), broadcasterId, String(e));
        await recordMonitorEvent("eventsub_delete_error", `${broadcasterId}: cancellation queued for retry`);
      }
      for (const extra of await getExtraEventSubSubscriptions(broadcasterId)) {
        try {
          await deleteEventSubSubscription(extra.subscription_id);
        } catch (e) {
          await queueEventSubCancellation(extra.subscription_id, broadcasterId, String(e));
          await recordMonitorEvent("eventsub_delete_error", `${broadcasterId}: ${extra.kind} cancellation queued for retry`);
        }
      }
      await sendChatMessage(`@${display} GuildScribe is disconnecting from this channel${purge ? " and purging its stored guild data" : ""}.`, broadcasterId);
      await purgeAutohuntData(broadcasterId); // hunts stop with the bot, purge or not
      await purgeHuntCooldownData(broadcasterId, purge);
      if (purge) {
        await purgeChannelData(broadcasterId);
        await purgeAdData(broadcasterId);
        await purgeAutoBanData(broadcasterId);
        await purgePointsData(broadcasterId);
      } else {
        await disconnectBroadcasterData(broadcasterId, false);
        await disconnectPointsData(broadcasterId);
        await disconnectAdToken(broadcasterId);
      }
      return new Response("OK");
    }

    // Channel enable/disable toggle
    const botToggle = chatMessage.trim().match(/^!dndbot\s+(on|off|status)$/i);
    if (botToggle) {
      if (!isModerator) {
        await sendChatMessage(
          `@${display} only the broadcaster or a moderator can change the bot setting.`,
          broadcasterId,
        );
      } else if (botToggle[1].toLowerCase() === "status") {
        await sendChatMessage(
          `@${display} The guild hall is currently ${(await isChannelEnabled(broadcasterId)) ? "open" : "closed"} in this channel.`,
          broadcasterId,
        );
      } else {
        const enabled = botToggle[1].toLowerCase() === "on";
        await setChannelEnabled(broadcasterId, enabled);
        await sendChatMessage(
          `@${display} The guild hall is now ${enabled ? "open" : "closed"} in this channel. ${enabled ? "Adventurers may petition the scribes." : "The doors are barred until a steward reopens them."}`,
          broadcasterId,
        );
      }
      return new Response("OK");
    }

    if (!(await isChannelEnabled(broadcasterId))) return new Response("OK");

    if (chatMessage.startsWith("!")) {
      // Throttle non-mod command spam before it reaches any handler or the DB.
      if (!isModerator && !(await checkCommandRateLimit(broadcasterId, chatter, COMMAND_COOLDOWN_MS))) return new Response("OK");
      const commandWord = chatMessage.split(/\s+/)[0].toLowerCase();
      await recordActivity(chatter, broadcasterId, commandWord, chatMessage);
      // Dashboard-controlled feature groups (see COMMAND_GROUPS in
      // utils.ts). Silent no-op when disabled, same as the master
      // isChannelEnabled check just above — features with their own
      // dedicated toggle (market/chronicle/npc) and !dashboard itself are
      // deliberately excluded from COMMAND_GROUPS so they're unaffected.
      const group = groupForCommand(commandWord.replace(/^!/, ""));
      if (group && !(await isCommandGroupEnabled(broadcasterId, group))) return new Response("OK");
    } else if (Number(connection.is_live) === 1) {
      // Copper for chatting (see points.ts): plain messages only, live only,
      // and a silent no-op unless the channel turned gold on (!gold on).
      await maybeAwardChatPoints(chatMessage, chatter, display, broadcasterId);
    }

    // Command handlers (return true if handled)
    if (await handleCreationCommand(chatter, display, broadcasterId, chatMessage)) return new Response("OK");
    if (await handleBg3Command(chatter, display, broadcasterId, chatMessage, baseUrl)) return new Response("OK");
    if (await handleInitiativeCommand(chatMessage, broadcasterId, display, isModerator, chatter)) return new Response("OK");
    if (await handlePartyCommand(chatMessage, chatter, display, broadcasterId)) return new Response("OK");
    if (await handlePartyDuelCommand(chatMessage, chatter, display, broadcasterId)) return new Response("OK");
    // Monster first: only claims exact "!dndduel" / "!dndduel attack" / "!dndduel monster …"
    // so player-vs-player "!dndduel @user" still falls through to handleDuelCommand.
    if (await handleMonsterDuelCommand(chatMessage, chatter, display, broadcasterId)) return new Response("OK");
    if (await handleDuelCommand(chatMessage, chatter, display, broadcasterId)) return new Response("OK");
    if (await handleMapCommand(chatMessage, chatter, display, broadcasterId, isModerator, baseUrl)) return new Response("OK");
    if (await handleCustomCommandManagement(chatMessage, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleTimedMessageCommand(chatMessage, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleDashboardCommand(chatMessage, display, broadcasterId, isModerator, baseUrl)) return new Response("OK");
    if (await handleMerchantCommand(chatMessage, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleHaggleCommand(chatMessage, chatter, display, broadcasterId)) return new Response("OK");
    if (await handleChronicleCommand(chatMessage, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handlePointsCommand(chatMessage, chatter, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleRobCommand(chatMessage, chatter, display, broadcasterId)) return new Response("OK");
    if (await handleAutohuntCommand(chatMessage, chatter, display, broadcasterId)) return new Response("OK");
    if (await handleHuntCooldownCommand(chatMessage, chatter, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleAutoBanCommand(chatMessage, display, isModerator, broadcasterId, baseUrl)) return new Response("OK");
    if (
      await handleNpcCommand(chatMessage, chatter, display, broadcasterId, isModerator)
    ) return new Response("OK");
    if (
      await handleAdCommand(chatMessage, display, broadcasterId, isModerator, baseUrl)
    ) return new Response("OK");
    if (await handleOracleCommand(chatMessage, chatter, display, broadcasterId)) return new Response("OK");

    if (chatMessage === "!logs") {
      if (!isModerator) {
        await sendChatMessage(`@${display} only the broadcaster or a moderator can use !logs.`, broadcasterId);
      } else {
        const logs = await getRecentLogs(broadcasterId, 8);
        await sendChatMessages(
          logs.length
            ? `@${display} Recent activity: ${logs.reverse().map(logRowText).join(" || ")}`
            : `@${display} no activity has been logged yet.`,
          broadcasterId,
        );
      }
    } else if (chatMessage === "!connections") {
      if (!isModerator) {
        await sendChatMessage(
          `@${display} only the broadcaster or a moderator can use !connections.`,
          broadcasterId,
        );
      } else {
        const names = await getConnections();
        await sendChatMessages(
          `@${display} Connected channels (${names.length}): ${names.length ? names.join(", ") : "none"}`,
          broadcasterId,
        );
      }
    } else if (chatMessage === "!help") {
      await sendWelcomeMessage(display, broadcasterId);
    } else if (chatMessage === "!link" || chatMessage === "!guide") {
      await sendChatMessage(
        `@${display} 📜 Guild Codex (full command guide): ${PUBLIC_BASE_URL}/guide`,
        broadcasterId,
      );
    } else if (/^!dndbothelp(?:\s+\w+)?$/i.test(chatMessage)) {
      const category = chatMessage.split(/\s+/)[1]?.toLowerCase();
      const help = chatHelpText(category, PUBLIC_BASE_URL);
      await sendChatMessages(`@${display} ${help}`, broadcasterId);
    } else if (/^!levelup(?:\s+\S+)*$/i.test(chatMessage)) {
      // !levelup [+/-N] | !levelup @user [+/-N] | !levelup [+/-N] @user (mod only)
      const args = chatMessage.split(/\s+/).slice(1);
      let delta = 1;
      let levelTarget: string | null = null;
      let validArgs = true;
      if (args.length > 2) validArgs = false;
      for (const arg of args) {
        if (/^[+-]\d+$/.test(arg)) delta = Number.parseInt(arg, 10);
        else if (/^@?\w+$/.test(arg) && levelTarget === null) levelTarget = arg.replace(/^@/, "").toLowerCase();
        else validArgs = false;
      }
      if (!isModerator) {
        await sendChatMessage(
          `@${display} only the broadcaster or a moderator can use !levelup.`,
          broadcasterId,
        );
      } else if (!validArgs) {
        await sendChatMessage(
          `@${display} use !levelup, !levelup +2, !levelup @user, or !levelup @user -1`,
          broadcasterId,
        );
      } else {
        const targetUser = levelTarget || chatter;
        const forSomeoneElse = targetUser !== chatter;
        const subject = forSomeoneElse ? `@${targetUser}` : "you";
        const result = await adjustLevel(targetUser, delta, broadcasterId);
        if ("error" in result) {
          const errorText =
            result.error === "no character"
              ? forSomeoneElse
                ? `@${targetUser} doesn't have a character yet — try !createchar @${targetUser}`
                : "you don't have a character yet — try !createchar"
              : result.error === "max level"
                ? `${subject === "you" ? "you're" : `${subject} is`} already level 20`
                : result.error === "min level"
                  ? `${subject === "you" ? "you're" : `${subject} is`} already level 1`
                  : "use !levelup, !levelup +2, !levelup @user, or !levelup @user -1";
          await sendChatMessage(`@${display} ${errorText}`, broadcasterId);
        } else {
          const direction = result.delta > 0 ? "advanced" : "reduced";
          const hpChange = result.hpGain >= 0 ? `HP +${result.hpGain}` : `HP ${result.hpGain}`;
          await sendChatMessage(
            `@${display} ${forSomeoneElse ? `@${targetUser}'s level` : "level"} ${direction} from ${result.oldLevel} to ${result.c.level}; ${hpChange}, HP ${result.c.hpCurrent}/${result.c.hpMax}, Prof +${result.c.proficiency}.${result.asi}`,
            broadcasterId,
          );
        }
      }
    } else if (/^!(spell|item|class|feat|ability|race|subrace|rule|rules|monster)(?:\s+.*)?$/i.test(chatMessage)) {
      const match = chatMessage.match(
        /^!(spell|item|class|feat|ability|race|subrace|rule|rules|monster)(?:\s+(.+?))?(?:\s+\+(\d+))?$/i,
      )!;
      const kind = match[1].toLowerCase();
      const query = (match[2] ?? "").trim();
      const bonus = match[3] ? Math.min(20, Number.parseInt(match[3], 10)) : null;

      // Incomplete command — suggest syntax + examples
      if (!query) {
        const usage: Record<string, string> = {
          spell: "Usage: !spell <name> [+N]. Example: !spell fireball or !spell cure wounds +1",
          item: "Usage: !item <name> [+N]. Example: !item longsword or !item longsword +1",
          class: "Usage: !class <name>. Example: !class wizard",
          feat: "Usage: !feat <name>. Example: !feat alert",
          ability: "Usage: !ability <score>. Example: !ability strength or !ability dex",
          race: "Usage: !race <name>. Example: !race elf",
          subrace: "Usage: !subrace <name>. Example: !subrace high elf",
          rule: "Usage: !rule <topic>. Example: !rule advantage or !rule casting a spell",
          rules: "Usage: !rules <topic>. Example: !rules magic or !rules combat",
          monster: "Usage: !monster <name>. Example: !monster goblin or !monster adult red dragon",
        };
        await sendChatMessage(`@${display} ${usage[kind] ?? `Usage: !${kind} <query>`}`, broadcasterId);
      } else {
        const data = await lookup5e(kind, query);
        if (data && kind === "spell") {
          await sendSpellSections(formatSpellSections(data, bonus), display, broadcasterId);
        } else {
          const isRule = kind === "rule" || kind === "rules";
          const isMonster = kind === "monster";
          await sendChatMessages(
            data
              ? `@${display} ${formatLookup(kind, data, bonus)}`
              : `@${display} couldn't find that ${kind}. Try e.g. !spell fireball, !item longsword, or !rule advantage`,
            broadcasterId,
            isRule ? { maxParts: 3 } : isMonster ? { maxParts: 2 } : undefined,
          );
        }
      }
    } else if (/^!bg3lookup(?:\s+.*)?$/i.test(chatMessage)) {
      const raw = chatMessage.replace(/^!bg3lookup\s*/i, "").trim();
      if (!raw) {
        await sendChatMessage(
          `@${display} Usage: !bg3lookup <name>. Example: !bg3lookup astarion or !bg3lookup shadow-cursed lands. Narrow by category with !bg3lookup <category> <name> (e.g. !bg3lookup faction zhentarim). Categories: ${bg3CategoryList()}`,
          broadcasterId,
        );
      } else {
        const { category, query: term } = parseBg3LookupQuery(raw);
        const entry = findBg3Entry(term, category);
        await sendChatMessages(
          entry
            ? `@${display} ${formatBg3Entry(entry)}`
            : `@${display} couldn't find "${term}" in the BG3 knowledgebase. Try e.g. !bg3lookup astarion, !bg3lookup moonrise towers, or !bg3lookup faction zhentarim`,
          broadcasterId,
        );
      }
    } else if (/^!(?:roll|r|d20)(?:\s+.*)?$/i.test(chatMessage)) {
      // Support: !d20 | !d20 @user | !roll | !roll @user 2d6+3 | !r 4d8
      // | !roll dex (saving throw) | !roll stealth (skill check) — both pull
      // the modifier from the roller's (or @target's) saved character.
      let rest = chatMessage.replace(/^!(?:roll|r|d20)\s*/i, "").trim();
      let rollTarget: string | null = null;
      const targetMatch = rest.match(/^@(\S+)\s*(.*)$/);
      if (targetMatch) {
        rollTarget = targetMatch[1].replace(/[,:]+$/, "");
        rest = targetMatch[2].trim();
      }

      const checkKind = rest ? resolveCheckKind(rest) : null;

      // Fate question: "!roll is enya going to die this time?" — only once rest
      // has already failed to resolve as a saving throw/skill check, isn't
      // targeted at another user (that path stays reserved for dice rolls),
      // and reads like a question rather than a mistyped ability/dice
      // expression (contains a space, or ends in "?").
      const isFateQuestion =
        !checkKind && !rollTarget && !!rest && !/^\d+d\d+([+-]\d+)?$/i.test(rest) && (/\s/.test(rest) || /\?$/.test(rest));

      if (isFateQuestion) {
        await sendChatMessage(`@${display} ${rollFate(rest)}`, broadcasterId);
      } else {
        let expression: string;
        let label: string | undefined;
        let checkOwnerMissing: string | null = null;

        if (checkKind) {
          const owner = (rollTarget || chatter).toLowerCase();
          const c = await getCharacter(owner, broadcasterId);
          if (!c) {
            checkOwnerMissing = owner;
            expression = "1d20";
          } else {
            const abilityMod = modifier(c.scores[checkKind.ability]);
            const proficient = checkKind.type === "save" && classes[c.cls].savingThrows.includes(checkKind.ability);
            const total = abilityMod + (proficient ? c.proficiency : 0);
            expression = `1d20${total === 0 ? "" : total > 0 ? `+${total}` : `${total}`}`;
            label = checkKind.label;
          }
        } else {
          expression = rest || "1d20";
        }

        if (checkOwnerMissing) {
          await sendChatMessage(
            checkOwnerMissing === chatter
              ? `@${display} you don't have a character yet — try !createchar`
              : `@${display} @${checkOwnerMissing} doesn't have a character yet.`,
            broadcasterId,
          );
        } else {
          const result = rollDice(expression, label);
          if (!result) {
            await sendChatMessage(
              `@${display} that's not a valid roll — try !roll, !r, !d20, !roll 2d6+3, !roll dex, !roll stealth, or !roll <question>?`,
              broadcasterId,
            );
          } else {
            if (result.rawD20 === 20 || result.rawD20 === 1) {
              await recordDiceRollEvent(
                broadcasterId,
                chatter,
                display,
                result.rawD20 === 20 ? "nat20" : "nat1",
              );
            }
            if (rollTarget) {
              await sendChatMessage(`@${display} rolled for @${rollTarget}: ${result.text}`, broadcasterId);
            } else {
              await sendChatMessage(`@${display} ${result.text}`, broadcasterId);
            }
          }
        }
      }
    } else if (/^!rollcall(?:\s+.*)?$/i.test(chatMessage)) {
      // !rollcall [nat1|nat20] [hour|day|week] — natural 1/20 standings
      // logged from !roll/!r/!d20 (see recordDiceRollEvent above). Kind
      // defaults to nat20; with no time frame given, shows a compact top-3
      // across all three windows in one line, otherwise a bigger top-5 for
      // just the requested window.
      //
      // !rollcall @user [hour|day|week] — one player's own nat1 AND nat20
      // counts instead of the channel-wide top list. No kind filter here
      // since the point is seeing both side by side for that person.
      const rawArgs = chatMessage.replace(/^!rollcall\s*/i, "").trim();
      const targetMatch = rawArgs.match(/@(\S+)/);
      const targetDisplay = targetMatch ? targetMatch[1].replace(/[,:]+$/, "") : null;
      const targetUser = targetDisplay ? targetDisplay.toLowerCase() : null;
      const lbWords = rawArgs.replace(/@\S+/g, "").toLowerCase().split(/\s+/).filter(Boolean);
      const windowMs: Record<"hour" | "day" | "week", number> = {
        hour: 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
      };
      const windowAliases: Record<string, "hour" | "day" | "week"> = {
        hour: "hour", "1hr": "hour", "1h": "hour",
        day: "day", "1d": "day",
        week: "week", "1w": "week",
      };
      const requestedWindow = lbWords.map((w) => windowAliases[w]).find(Boolean);

      if (targetUser) {
        if (requestedWindow) {
          const stats = await getDiceStatsForUser(broadcasterId, targetUser, Date.now() - windowMs[requestedWindow]);
          await sendChatMessage(
            `@${display} 🎲 @${targetDisplay}'s rolls (past ${requestedWindow}): 🌟 Nat20 x${stats.nat20} | 💀 Nat1 x${stats.nat1}`,
            broadcasterId,
          );
        } else {
          const [hourStats, dayStats, weekStats] = await Promise.all([
            getDiceStatsForUser(broadcasterId, targetUser, Date.now() - windowMs.hour),
            getDiceStatsForUser(broadcasterId, targetUser, Date.now() - windowMs.day),
            getDiceStatsForUser(broadcasterId, targetUser, Date.now() - windowMs.week),
          ]);
          await sendChatMessage(
            `@${display} 🎲 @${targetDisplay}'s rolls — 🌟 Nat20 (Hour ${hourStats.nat20}, Day ${dayStats.nat20}, Week ${weekStats.nat20}) | 💀 Nat1 (Hour ${hourStats.nat1}, Day ${dayStats.nat1}, Week ${weekStats.nat1})`,
            broadcasterId,
          );
        }
      } else {
        const kind: "nat1" | "nat20" = lbWords.includes("nat1") || lbWords.includes("1") ? "nat1" : "nat20";
        const label = kind === "nat20" ? "Natural 20" : "Natural 1";
        const emoji = kind === "nat20" ? "🌟" : "💀";
        const formatEntries = (rows: { displayName: string; count: number }[]) =>
          rows.length ? rows.map((r) => `${r.displayName} x${r.count}`).join(", ") : "none yet";

        if (requestedWindow) {
          const rows = await getDiceLeaderboard(broadcasterId, kind, Date.now() - windowMs[requestedWindow], 5);
          await sendChatMessage(
            `@${display} ${emoji} ${label} leaderboard (past ${requestedWindow}): ${formatEntries(rows)}`,
            broadcasterId,
          );
        } else {
          const [hourRows, dayRows, weekRows] = await Promise.all([
            getDiceLeaderboard(broadcasterId, kind, Date.now() - windowMs.hour, 3),
            getDiceLeaderboard(broadcasterId, kind, Date.now() - windowMs.day, 3),
            getDiceLeaderboard(broadcasterId, kind, Date.now() - windowMs.week, 3),
          ]);
          await sendChatMessages(
            `@${display} ${emoji} ${label} leaderboard — Hour: ${formatEntries(hourRows)} | Day: ${formatEntries(dayRows)} | Week: ${formatEntries(weekRows)}. Try !rollcall ${
              kind === "nat20" ? "nat1" : "nat20"
            }, !rollcall ${kind} week for a bigger top 5, or !rollcall @user for one player's stats.`,
            broadcasterId,
          );
        }
      }
    } else if (chatMessage === "!bg3roll") {
      await sendChatMessage(rollBG3Character(display), broadcasterId);
    } else if (chatMessage === "!bg3companion") {
      await sendChatMessage(rollBG3Companion(display), broadcasterId);
    } else if (chatMessage === "!bg3origin") {
      await sendChatMessage(rollBG3Origin(display), broadcasterId);
    } else if (chatMessage === "!bg3loot") {
      await sendChatMessage(rollBG3Loot(display), broadcasterId);
    } else if (chatMessage === "!bg3camp") {
      await sendChatMessage(rollBG3Camp(display), broadcasterId);
    } else if (/^!hug(?:\s+@?\S+)?$/i.test(chatMessage)) {
      const hugMatch = chatMessage.match(/^!hug(?:\s+@?(\S+))?$/i)!;
      const hugTarget = hugMatch[1] ? hugMatch[1].toLowerCase().replace(/[,:]+$/, "") : null;
      await sendChatMessage(rollHug(display, hugTarget), broadcasterId);
    } else if (/^!shmash(?:\s+@?\S+)?$/i.test(chatMessage)) {
      // Purely cosmetic (no HP/game state touched) — pulls each side's
      // character (race/class) when they have one saved, plain username
      // otherwise, and falls back to a comedic target when none is given.
      const shmashMatch = chatMessage.match(/^!shmash(?:\s+@?(\S+))?$/i)!;
      const shmashTarget = shmashMatch[1] ? shmashMatch[1].toLowerCase().replace(/[,:]+$/, "") : null;
      const actorChar = await getCharacter(chatter, broadcasterId);
      const actorDesc = actorChar
        ? `@${display}'s ${formatRaceName(actorChar.race, actorChar.subrace)} ${actorChar.cls}`
        : `@${display}`;
      if (!shmashTarget) {
        await sendChatMessage(renderShmash(actorDesc), broadcasterId);
      } else if (shmashTarget === chatter) {
        await sendChatMessage(renderShmash(actorDesc, null, true), broadcasterId);
      } else {
        const targetChar = await getCharacter(shmashTarget, broadcasterId);
        const targetDesc = targetChar
          ? `@${shmashTarget}'s ${formatRaceName(targetChar.race, targetChar.subrace)} ${targetChar.cls}`
          : `@${shmashTarget}`;
        await sendChatMessage(renderShmash(actorDesc, targetDesc), broadcasterId);
      }
    } else if (/^!createchar(?:\s+@?\S+)?$/i.test(chatMessage)) {
      const createMatch = chatMessage.match(/^!createchar(?:\s+@?(\S+))?$/i)!;
      const createTarget = createMatch[1] ? createMatch[1].toLowerCase() : null;
      if (createTarget && createTarget !== chatter && !isModerator) {
        await sendChatMessage(
          `@${display} only the broadcaster or a moderator can create a character for someone else.`,
          broadcasterId,
        );
      } else {
        const targetUser = createTarget || chatter;
        const existing = await getCharacter(targetUser, broadcasterId);
        if (existing) {
          await saveCreationSession(
            { username: chatter, step: "confirm_createchar", targetUser },
            broadcasterId,
          );
          const forSomeoneElse = targetUser !== chatter;
          await sendChatMessage(
            `@${display} ⚠️ ${forSomeoneElse ? `@${targetUser} already has` : "you already have"} an active ${formatRaceName(existing.race, existing.subrace)} ${existing.cls} (Level ${existing.level}). Reply !answer yes to overwrite with a new random character, or !answer no to keep it.`,
            broadcasterId,
          );
        } else {
          const c = generateCharacter(targetUser);
          await saveCharacter(c, broadcasterId);
          await sendChatMessage(
            `@${display} created a level 1 ${formatRaceName(c.race, c.subrace)} ${c.cls}! ${formatStatLine(c)} — ${baseUrl}/?user=${targetUser}&channel=${broadcasterId}`,
            broadcasterId,
          );
        }
      }
    } else if (/^!char(?:\s+@?\S+)?$/i.test(chatMessage)) {
      const charMatch = chatMessage.match(/^!char(?:\s+@?(\S+))?$/i)!;
      const targetUser = charMatch[1] ? charMatch[1].toLowerCase().replace(/[,:]+$/, "") : chatter;
      const c = await getCharacter(targetUser, broadcasterId);
      if (c) {
        const label = targetUser === chatter ? "" : `@${targetUser} `;
        await sendChatMessage(
          `@${display} ${label}${formatRaceName(c.race, c.subrace)} ${c.cls} — ${formatStatLine(c)} — ${baseUrl}/?user=${targetUser}&channel=${broadcasterId}`,
          broadcasterId,
        );
      } else {
        await sendChatMessage(
          targetUser === chatter
            ? `@${display} you don't have a character yet — try !createchar`
            : `@${display} @${targetUser} doesn't have a character yet.`,
          broadcasterId,
        );
      }
    } else if (/^!roster$/i.test(chatMessage)) {
      await sendChatMessage(
        `@${display} 📜 The guild roster — every adventurer and party in this channel: ${baseUrl}/roster?channel=${broadcasterId}`,
        broadcasterId,
      );
    } else if (chatMessage.startsWith("!hp ")) {
      const delta = Number.parseInt(chatMessage.slice(4).trim());
      if (Number.isNaN(delta)) {
        await sendChatMessage(`@${display} use !hp +5 or !hp -3`, broadcasterId);
      } else {
        const c = await adjustHp(chatter, delta, broadcasterId);
        await sendChatMessage(
          c
            ? `@${display} HP: ${c.hpCurrent}/${c.hpMax}`
            : `@${display} you don't have a character yet — try !createchar`,
          broadcasterId,
        );
      }
    } else if (chatMessage === "!savechar") {
      await sendChatMessage(
        (await backupCharacter(chatter, broadcasterId))
          ? `@${display} character saved!`
          : `@${display} no character to save — try !createchar`,
        broadcasterId,
      );
    } else if (chatMessage === "!loadchar") {
      const c = await loadBackup(chatter, broadcasterId);
      await sendChatMessage(
        c
          ? `@${display} character loaded! ${formatStatLine(c)} — ${baseUrl}/?user=${chatter}&channel=${broadcasterId}`
          : `@${display} no saved backup found — try !savechar first`,
        broadcasterId,
      );
    } else if (/^!resetchar(?:\s+@?\S+)?$/i.test(chatMessage)) {
      const resetMatch = chatMessage.match(/^!resetchar(?:\s+@?(\S+))?$/i)!;
      const resetTarget = resetMatch[1] ? resetMatch[1].toLowerCase().replace(/[,:]+$/, "") : null;
      if (resetTarget && resetTarget !== chatter && !isModerator) {
        // Mod gate: only the broadcaster/mods may reset someone else's character.
        await sendChatMessage(
          `@${display} only the broadcaster or a moderator can reset a character for someone else.`,
          broadcasterId,
        );
      } else if (resetTarget && resetTarget !== chatter) {
        // Targeted reset (mod/broadcaster): confirm the target actually has a character first.
        const existing = await getCharacter(resetTarget, broadcasterId);
        if (!existing) {
          await sendChatMessage(`@${display} @${resetTarget} has no character to reset.`, broadcasterId);
        } else {
          await resetCharacter(resetTarget, broadcasterId);
          await sendChatMessage(
            `@${display} reset @${resetTarget}'s character — they can use !createchar to roll a new one`,
            broadcasterId,
          );
        }
      } else {
        await resetCharacter(chatter, broadcasterId);
        await sendChatMessage(
          `@${display} character reset — use !createchar to roll a new one`,
          broadcasterId,
        );
      }
    } else if (chatMessage.startsWith("!")) {
      // Nothing built-in matched — try a chat-authored custom command.
      await handleCustomCommandInvocation(chatMessage, display, broadcasterId);
    } else if (isGoodnightMessage(chatMessage)) {
      // Plain-chat "goodnight" detection (not a "!" command). Cooldown per
      // channel so a wave of goodnights from many viewers only draws one reply.
      if (await checkGoodnightCooldown(broadcasterId, GOODNIGHT_COOLDOWN_MS)) {
        await sendChatMessage(goodnightReply(), broadcasterId);
      }
    } else {
      // Plain (non-"!") chat — check passive keyword triggers first (part
      // of the "custom" dashboard group); only roll the chronicle's random
      // quote-back (then NPC chatter) if no trigger already replied, so a
      // single message never draws two separate unprompted replies.
      const triggerFired = (await isCommandGroupEnabled(broadcasterId, "custom"))
        ? await handleTriggerMatch(chatMessage, display, broadcasterId)
        : false;
      if (!triggerFired) {
        const chronicleFired = await maybeChronicleQuote(chatMessage, display, broadcasterId);
        if (!chronicleFired) {
          await maybeNpcChatter(chatMessage, display, broadcasterId);
        }
      }
    }
  }

  if (messageType === "revocation") {
    const broadcasterId = String(
      body.subscription?.condition?.broadcaster_user_id ??
        body.subscription?.condition?.to_broadcaster_user_id ??
        "",
    );
    const subscriptionId = String(body.subscription?.id ?? "");
    const subscriptionType = String(body.subscription?.type ?? "");
    if (broadcasterId) {
      if (subscriptionType === "channel.chat.message") {
        await markBroadcasterDisconnected(broadcasterId, String(body.subscription?.status ?? "revoked"), subscriptionId);
      } else {
        // A revoked subscribe/resub/gift/raid subscription only disables
        // that extra thank-you feature for this channel — the rest of the
        // bot, including chat commands, keeps working.
        await deleteExtraEventSubSubscriptions(broadcasterId);
      }
      await recordMonitorEvent("eventsub_revocation", `${broadcasterId}:${subscriptionType}:${subscriptionId}`);
    }
  }
  return new Response("OK");
}

// TWITCH_BOT_ID must be the numeric Twitch user ID belonging to TWITCH_BOT_TOKEN.


export default async function (req: Request): Promise<Response> {
  try {
    return await handleRequest(req);
  } catch (e) {
    try { await recordMonitorEvent("unhandled_error", String(e)); } catch (_) {}
    console.error("GuildScribe request failed", e);
    return new Response("Internal server error", { status: 500 });
  }
}

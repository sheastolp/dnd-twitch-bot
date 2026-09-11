// GuildScribe — Twitch D&D bot entry point
// Val Town / Deno HTTP handler
//

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

import {
  adjustHp,
  backupCharacter,
  blockChannel,
  checkCommandRateLimit,
  checkGoodnightCooldown,
  claimEventSubMessage,
  clearPendingEventSubCancellation,
  createDashboardSession,
  deleteDashboardSession,
  deleteExtraEventSubSubscriptions,
  disconnectBroadcasterData,
  ensureTables,
  getBroadcaster,
  getCharacter,
  getConnectedBroadcastersByIds,
  getConnections,
  getDashboardSession,
  getExtraEventSubSubscriptions,
  getMap,
  getMapCells,
  getMapTokens,
  getMerchantCronStatus,
  getMerchantOverview,
  getMonitorEvents,
  getPendingEventSubCancellations,
  getRecentLogs,
  isChannelBlocked,
  isChannelEnabled,
  isChronicleEnabled,
  isMerchantEnabled,
  listMaps,
  loadBackup,
  markBroadcasterDisconnected,
  purgeChannelData,
  queueEventSubCancellation,
  recordActivity,
  recordMonitorEvent,
  resetCharacter,
  saveCharacter,
  saveCreationSession,
  saveExtraEventSubSubscription,
  setChannelEnabled,
  setChronicleEnabled,
  setMerchantEnabled,
  unblockChannel,
  updateDashboardSessionToken,
} from "./db.ts";
import { handleMapCommand } from "./maps.ts";
import { handleMerchantCommand, randomMerchantIntervalMs } from "./merchant.ts";
import { handleChronicleCommand, maybeChronicleQuote, recordChronicleBotMessage } from "./chronicle.ts";
import {
  handleCustomCommandInvocation,
  handleCustomCommandManagement,
  handleTriggerMatch,
} from "./customcommands.ts";
import {
  adjustLevel,
  generateCharacter,
  handleCreationCommand,
} from "./characters.ts";
import {
  handleDuelCommand,
  handleInitiativeCommand,
  handleMonsterDuelCommand,
  handlePartyCommand,
  handlePartyDuelCommand,
} from "./combat.ts";
import { formatLookup, formatSpellSections, lookup5e } from "./lookups.ts";
import {
  createChatSubscription,
  createRaidEventSubscription,
  createSubEventSubscriptions,
  deleteEventSubSubscription,
  env,
  exchangeCode,
  getModeratedChannelIds,
  getSelfUser,
  refreshUserToken,
  sendChatMessage,
  sendChatMessages,
  sendSpellSections,
  verifyEventSub,
} from "./twitch.ts";
import {
  escapeHtml,
  formatRaceName,
  formatStatLine,
  getCookie,
  goodnightReply,
  hasModeratorBadge,
  isBotAccount,
  isGoodnightMessage,
  logRowText,
  modifier,
  resolveCheckKind,
  rollDice,
  rollFate,
  rollGiftedSubWelcome,
  rollGiftSubThankYou,
  rollHug,
  rollNewSubThankYou,
  rollRaidThankYou,
  rollResubThankYou,
  sessionCookie,
} from "./utils.ts";
import { classes } from "./data.ts";
import {
  page,
  renderAdminLogsPage,
  renderCharacterPage,
  renderDashboardEmptyPage,
  renderDashboardPicker,
  renderDashboardStatusPage,
  renderGuidePage,
  renderMapListPage,
  renderMapPage,
} from "./pages.ts";
import {
  handleBg3Command,
  rollBG3Camp,
  rollBG3Character,
  rollBG3Companion,
  rollBG3Loot,
  rollBG3Origin,
} from "./bg3.ts";
import {
  bg3CategoryList,
  findBg3Entry,
  formatBg3Entry,
  parseBg3LookupQuery,
} from "./bg3lookup.ts";

// Public HTTP trigger URL for this val (used for guide links in chat).
// OAuth redirects and character page links still use the request origin dynamically.
const PUBLIC_BASE_URL = Deno.env.get("PUBLIC_BASE_URL") ??
  "https://guildscribe.val.run";

// /dashboard login session cookie. 30 days — long enough a mod doesn't have
// to re-auth every visit; the underlying Twitch access token is refreshed
// transparently well before then (see getManageableChannelsForSession).
const DASHBOARD_SESSION_COOKIE = "gs_session";
const DASHBOARD_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// Durable per-channel/user throttling is stored in SQLite so it survives restarts
// and remains consistent if the deployment scales beyond one warm instance.
const COMMAND_COOLDOWN_MS = Math.max(
  250,
  Number(Deno.env.get("COMMAND_COOLDOWN_MS") ?? "1200"),
);
const GOODNIGHT_COOLDOWN_MS = Math.max(
  30_000,
  Number(Deno.env.get("GOODNIGHT_COOLDOWN_MS") ?? "300000"),
);

async function retryPendingEventSubCancellations() {
  const pending = await getPendingEventSubCancellations(5);
  for (const row of pending) {
    try {
      await deleteEventSubSubscription(String(row.subscription_id));
      await clearPendingEventSubCancellation(String(row.subscription_id));
      await recordMonitorEvent(
        "eventsub_delete_retry_ok",
        `${row.broadcaster_id}:${row.subscription_id}`,
      );
    } catch (e) {
      await queueEventSubCancellation(
        String(row.subscription_id),
        String(row.broadcaster_id),
        String(e),
      );
      await recordMonitorEvent(
        "eventsub_delete_retry_error",
        `${row.broadcaster_id}:${String(e)}`,
      );
    }
  }
}

async function sendWelcomeMessage(display: string, broadcasterId: string) {
  await sendChatMessages(
    `@${display} Welcome to the Guild Hall, adventurer! 📜 Create your legend with !createchar or !newchar, check your parchment with !char, gather a company with !party create <name>, and consult the archives with !dndbothelp. Full guild codex: ${PUBLIC_BASE_URL}/guide`,
    broadcasterId,
  );
}

// Resolves a /dashboard session cookie into the viewer's identity and the
// GuildScribe-connected channels they're actually allowed to manage —
// channels they broadcast themselves, plus channels Twitch says they
// moderate, intersected with what's currently connected. Recomputed on
// every dashboard view/toggle (not cached) so a demotion in Twitch takes
// effect immediately rather than trusting a stale session claim.
// Returns null if there's no session or it's no longer valid.
async function getManageableChannelsForSession(req: Request): Promise<{
  sessionId: string;
  userId: string;
  login: string;
  displayName: string;
  channels: any[];
} | null> {
  const sessionId = getCookie(req, DASHBOARD_SESSION_COOKIE);
  if (!sessionId) return null;
  const session = await getDashboardSession(sessionId);
  if (!session) return null;

  let accessToken = String(session.access_token);
  // Refresh a minute early so we never spend a request's worth of Twitch
  // API calls on a token that expires mid-flight.
  if (Date.now() > Number(session.token_expires_at) - 60_000) {
    if (!session.refresh_token) {
      await deleteDashboardSession(sessionId);
      return null;
    }
    try {
      const refreshed = await refreshUserToken(String(session.refresh_token));
      accessToken = refreshed.access_token;
      const expiresAt = Date.now() + Number(refreshed.expires_in ?? 0) * 1000;
      await updateDashboardSessionToken(
        sessionId,
        accessToken,
        refreshed.refresh_token ?? String(session.refresh_token),
        expiresAt,
      );
    } catch (_e) {
      // Refresh token revoked/expired — the viewer needs to sign in again.
      await deleteDashboardSession(sessionId);
      return null;
    }
  }

  const moderatedIds = await getModeratedChannelIds(accessToken, String(session.user_id));
  const candidateIds = [...moderatedIds, String(session.user_id)];
  const channels = await getConnectedBroadcastersByIds(candidateIds);
  return {
    sessionId,
    userId: String(session.user_id),
    login: String(session.login),
    displayName: String(session.display_name || session.login),
    channels,
  };
}

// Single source of truth for every module the Guild Dashboard can toggle.
// Adding a new switch (e.g. a future module) means adding one entry here —
// the status page, the toggle handler, and validation all read from this
// list instead of hardcoding module names in three places.
const DASHBOARD_MODULES: {
  key: string;
  label: string;
  description: string;
  isEnabled: (broadcasterId: string) => Promise<boolean>;
  setEnabled: (broadcasterId: string, enabled: boolean) => Promise<void>;
}[] = [
  {
    key: "bot",
    label: "Guild hall (bot)",
    description: "The scribes answer commands in this channel at all.",
    isEnabled: isChannelEnabled,
    setEnabled: setChannelEnabled,
  },
  {
    key: "market",
    label: "Open-stall merchant",
    description: "A threadbare peddler drops by every so often with a sales pitch.",
    isEnabled: isMerchantEnabled,
    setEnabled: (broadcasterId, enabled) =>
      setMerchantEnabled(broadcasterId, enabled, enabled ? Date.now() + randomMerchantIntervalMs() : null),
  },
  {
    key: "chronicle",
    label: "Chronicle",
    description: "Occasionally quotes a plain chat message back with a D&D-flavored reply.",
    isEnabled: isChronicleEnabled,
    setEnabled: setChronicleEnabled,
  },
];

async function handleRequest(req: Request): Promise<Response> {
  await ensureTables();
  const url = new URL(req.url);
  const path = url.pathname;

  // ── Static / GET routes ──
  // NOTE: activity logs are intentionally NOT exposed as a public web route.
  // They contain per-channel usernames and command text; the only way to see
  // them is the in-chat `!logs` command, which is restricted to the
  // broadcaster/moderators of that specific channel (see below).
  if (req.method === "GET" && path === "/healthz") {
    try {
      try {
        await retryPendingEventSubCancellations();
      } catch (e) {
        await recordMonitorEvent("eventsub_retry_loop_error", String(e));
      }
      await sqlite.execute("SELECT 1");
      return new Response(
        JSON.stringify({
          ok: true,
          service: "GuildScribe",
          time: new Date().toISOString(),
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (e) {
      await recordMonitorEvent("health_error", String(e));
      return new Response(JSON.stringify({ ok: false }), {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }
  }
  if (req.method === "GET" && path === "/privacy") {
    return page(
      "GuildScribe Privacy Policy",
      `<h1>GuildScribe Privacy Policy</h1><p>GuildScribe receives Twitch usernames/user IDs, channel IDs, command text, character/party/gameplay data, and basic connection/subscription state when a channel connects the bot.</p><h2>How it is used</h2><p>Data is used only to operate the Twitch bot, keep characters and parties working, troubleshoot abuse/errors, and provide channel activity logs to that channel's broadcaster/moderators.</p><h2>Retention</h2><p>Activity logs are kept for up to 90 days and are capped at 5,000 rows per channel. Character and party data remains while a channel uses GuildScribe unless the channel requests deletion. OAuth state records expire after 10 minutes. Connection records are removed when a channel disconnects.</p><h2>Deletion</h2><p>The connected broadcaster can use <code>!dndbot leave purge</code> to disconnect and request deletion of that channel's stored characters, parties, logs, and gameplay state. For other deletion requests, contact ${
        escapeHtml(
          Deno.env.get("SUPPORT_URL") ??
            "the project operator through the support link on the home page",
        )
      }.</p><p><a href="/">Return to GuildScribe</a></p>`,
    );
  }
  if (req.method === "GET" && (path === "/terms" || path === "/tos")) {
    return page(
      "GuildScribe Terms of Service",
      `<h1>GuildScribe Terms of Service</h1><p>GuildScribe is a fan-made Twitch utility for D&amp;D-style character and chat gameplay. Use it lawfully and respectfully, and follow Twitch's rules and the streamer/channel's rules.</p><p>Do not use the bot to harass, spam, abuse, evade moderation, or interfere with other users. Channel owners are responsible for deciding whether the bot is appropriate for their community.</p><p>The service may be changed, limited, suspended, or removed at any time. Gameplay data and generated results are not guaranteed to be preserved.</p><p>Report abuse or request account/channel assistance through the support contact on the home page.</p><p><a href="/">Return to GuildScribe</a></p>`,
    );
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
    await sqlite.execute(
      "INSERT INTO oauth_states (state,expires_at) VALUES (?,?)",
      [
        state,
        Date.now() + 10 * 60 * 1000,
      ],
    );
    const auth = new URL("https://id.twitch.tv/oauth2/authorize");
    auth.search = new URLSearchParams({
      client_id: env("TWITCH_CLIENT_ID"),
      redirect_uri: `${url.origin}/callback`,
      response_type: "code",
      scope: "channel:bot channel:read:subscriptions",
      state,
    }).toString();
    return Response.redirect(auth.toString(), 302);
  }

  if (req.method === "GET" && path === "/callback") {
    const error = url.searchParams.get("error");
    if (error) {
      return page(
        "Twitch connection cancelled",
        `<h1>Connection cancelled</h1><p>${
          escapeHtml(url.searchParams.get("error_description") ?? error)
        }</p>`,
      );
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return new Response("Missing OAuth code or state", { status: 400 });
    }
    const check = await sqlite.execute(
      "SELECT * FROM oauth_states WHERE state = ? AND expires_at > ?",
      [
        state,
        Date.now(),
      ],
    );
    if (!check.rows.length) {
      return new Response("Invalid or expired OAuth state", { status: 400 });
    }
    await sqlite.execute("DELETE FROM oauth_states WHERE state = ?", [state]);
    try {
      const token = await exchangeCode(code, `${url.origin}/callback`);
      const userRes = await fetch("https://api.twitch.tv/helix/users", {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          "Client-Id": env("TWITCH_CLIENT_ID"),
        },
      });
      if (!userRes.ok) {
        throw new Error(`Could not identify broadcaster: ${userRes.status}`);
      }
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
            await recordMonitorEvent(
              "eventsub_reconnect_cleanup_failed",
              `${user.id}: ${String(e)}`,
            );
          }
        }
        for (const extra of await getExtraEventSubSubscriptions(user.id)) {
          try {
            await deleteEventSubSubscription(extra.subscription_id);
          } catch (e) {
            await recordMonitorEvent(
              "eventsub_reconnect_cleanup_failed",
              `${user.id}: ${extra.kind}: ${String(e)}`,
            );
          }
        }
        await deleteExtraEventSubSubscriptions(user.id);
      }

      const sub = await createChatSubscription(user.id, url.origin);
      await sqlite.execute(
        "INSERT OR REPLACE INTO broadcasters (broadcaster_id,login,display_name,subscription_id,connected_at,connected,disconnected_at,disconnect_reason) VALUES (?,?,?,?,?,?,?,?)",
        [
          user.id,
          user.login,
          user.display_name,
          sub.id,
          Date.now(),
          1,
          null,
          null,
        ],
      );
      // Best-effort: powers the D&D-themed !hug-style new-sub/resub thank
      // you. Requires channel:read:subscriptions, which is now requested
      // above, but shouldn't block the core chat connection if it fails
      // (e.g. a re-auth that hasn't re-granted the scope yet).
      try {
        const { newSub, resub, gift } = await createSubEventSubscriptions(
          user.id,
          url.origin,
        );
        await saveExtraEventSubSubscription(user.id, "sub", newSub.id);
        await saveExtraEventSubSubscription(user.id, "resub", resub.id);
        await saveExtraEventSubSubscription(user.id, "gift", gift.id);
      } catch (e) {
        await recordMonitorEvent(
          "eventsub_sub_subscription_failed",
          `${user.id}: ${String(e)}`,
        );
      }
      // Best-effort: powers the D&D-themed raid thank-you. channel.raid
      // needs no extra OAuth scope (to_broadcaster_user_id is public data),
      // so this should reliably succeed, but it's kept non-blocking and
      // independent of the sub subscriptions above just in case.
      try {
        const raidSub = await createRaidEventSubscription(user.id, url.origin);
        await saveExtraEventSubSubscription(user.id, "raid", raidSub.id);
      } catch (e) {
        await recordMonitorEvent(
          "eventsub_raid_subscription_failed",
          `${user.id}: ${String(e)}`,
        );
      }
      return page(
        "Twitch connected",
        existing
          ? `<h1>The Guild renews your banner</h1><p>${
            escapeHtml(user.display_name)
          }'s connection to GuildScribe has been refreshed — any new permissions are now granted.</p><p><a href="/guide">Open the Guild Codex</a></p>`
          : `<h1>The Guild accepts your banner</h1><p>${
            escapeHtml(user.display_name)
          } is now connected to GuildScribe. The scribes will answer in that channel once the EventSub rite is complete.</p><p><strong>Important:</strong> In Twitch chat, run <code>/mod GuildScribeBot</code> so the guild can hear and answer reliably.</p><p><a href="/guide">Open the Guild Codex</a></p>`,
      );
    } catch (e) {
      console.error(e);
      await recordMonitorEvent("oauth_callback_failed", String(e));
      return page(
        "Connection failed",
        `<h1>Connection failed</h1><p>GuildScribe could not complete the Twitch connection. Please try again or use the support link on the home page.</p>`,
      );
    }
  }

  // Mod/broadcaster-only status page with on/off switches for each module
  // (bot, market, chronicle). Separate login from the bot-connect flow above
  // — this one signs the *viewer* in with Twitch (not the broadcaster
  // granting the bot access) so we can check their moderator status.
  if (req.method === "GET" && path === "/dashboard") {
    const session = await getManageableChannelsForSession(req);
    if (!session) {
      const state = crypto.randomUUID();
      await sqlite.execute(
        "INSERT INTO oauth_states (state,expires_at) VALUES (?,?)",
        [state, Date.now() + 10 * 60 * 1000],
      );
      const auth = new URL("https://id.twitch.tv/oauth2/authorize");
      auth.search = new URLSearchParams({
        client_id: env("TWITCH_CLIENT_ID"),
        redirect_uri: `${url.origin}/dashboard/callback`,
        response_type: "code",
        scope: "user:read:moderated_channels",
        state,
      }).toString();
      return Response.redirect(auth.toString(), 302);
    }

    if (!session.channels.length) {
      return page("Guild Dashboard", renderDashboardEmptyPage(session.displayName));
    }

    const channelId = url.searchParams.get("channel");
    const selected = channelId
      ? session.channels.find((c: any) => String(c.broadcaster_id) === channelId)
      : null;

    if (!selected) {
      if (session.channels.length === 1) {
        return Response.redirect(
          `${url.origin}/dashboard?channel=${encodeURIComponent(session.channels[0].broadcaster_id)}`,
          302,
        );
      }
      return page("Guild Dashboard", renderDashboardPicker(session.displayName, session.channels));
    }

    const broadcasterId = String(selected.broadcaster_id);
    const [moduleStates, blocked] = await Promise.all([
      Promise.all(DASHBOARD_MODULES.map((m) => m.isEnabled(broadcasterId))),
      isChannelBlocked(broadcasterId),
    ]);
    return page(
      "Guild Dashboard",
      renderDashboardStatusPage({
        displayName: session.displayName,
        channel: selected,
        blocked,
        showSwitcher: session.channels.length > 1,
        modules: DASHBOARD_MODULES.map((m, i) => ({
          key: m.key,
          label: m.label,
          description: m.description,
          enabled: moduleStates[i],
        })),
      }),
    );
  }

  if (req.method === "GET" && path === "/dashboard/callback") {
    const error = url.searchParams.get("error");
    if (error) {
      return page(
        "Sign-in cancelled",
        `<h1>Sign-in cancelled</h1><p>${
          escapeHtml(url.searchParams.get("error_description") ?? error)
        }</p><p><a href="/dashboard">Try again</a></p>`,
      );
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return new Response("Missing OAuth code or state", { status: 400 });
    }
    const check = await sqlite.execute(
      "SELECT * FROM oauth_states WHERE state = ? AND expires_at > ?",
      [state, Date.now()],
    );
    if (!check.rows.length) {
      return new Response("Invalid or expired OAuth state", { status: 400 });
    }
    await sqlite.execute("DELETE FROM oauth_states WHERE state = ?", [state]);
    try {
      const token = await exchangeCode(code, `${url.origin}/dashboard/callback`);
      const user = await getSelfUser(token.access_token);
      const sessionId = crypto.randomUUID();
      await createDashboardSession({
        sessionId,
        userId: user.id,
        login: user.login,
        displayName: user.display_name,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        tokenExpiresAt: Date.now() + Number(token.expires_in ?? 0) * 1000,
      });
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${url.origin}/dashboard`,
          "Set-Cookie": sessionCookie(DASHBOARD_SESSION_COOKIE, sessionId, DASHBOARD_SESSION_MAX_AGE_SECONDS),
        },
      });
    } catch (e) {
      console.error(e);
      await recordMonitorEvent("dashboard_oauth_callback_failed", String(e));
      return page(
        "Sign-in failed",
        `<h1>Sign-in failed</h1><p>GuildScribe could not complete Twitch sign-in. Please try again.</p><p><a href="/dashboard">Try again</a></p>`,
      );
    }
  }

  if (req.method === "GET" && path === "/dashboard/logout") {
    const sessionId = getCookie(req, DASHBOARD_SESSION_COOKIE);
    if (sessionId) await deleteDashboardSession(sessionId);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${url.origin}/dashboard`,
        "Set-Cookie": sessionCookie(DASHBOARD_SESSION_COOKIE, "", 0),
      },
    });
  }

  if (req.method === "POST" && path === "/dashboard/toggle") {
    const session = await getManageableChannelsForSession(req);
    if (!session) return Response.redirect(`${url.origin}/dashboard`, 302);

    const form = await req.formData();
    const broadcasterId = String(form.get("channel") ?? "");
    const moduleKey = String(form.get("module") ?? "");
    const enabled = String(form.get("enabled") ?? "") === "1";
    const allowed = session.channels.some((c: any) => String(c.broadcaster_id) === broadcasterId);
    const module = DASHBOARD_MODULES.find((m) => m.key === moduleKey);
    if (!allowed || !module) {
      return Response.redirect(`${url.origin}/dashboard`, 302);
    }

    await module.setEnabled(broadcasterId, enabled);
    await recordMonitorEvent(
      "dashboard_toggle",
      `${broadcasterId}: ${moduleKey}=${enabled ? "on" : "off"} by ${session.login}`,
    );
    return Response.redirect(
      `${url.origin}/dashboard?channel=${encodeURIComponent(broadcasterId)}`,
      302,
    );
  }

  if (req.method === "GET" && path === "/maps") {
    const channelId = url.searchParams.get("channel");
    if (!channelId || !/^\d+$/.test(channelId)) {
      return new Response("Missing or invalid channel.", { status: 400 });
    }
    const broadcaster = await getBroadcaster(channelId);
    if (!broadcaster || Number(broadcaster.connected) !== 1) {
      return new Response("Maps unavailable for this channel.", {
        status: 404,
      });
    }
    const maps = await listMaps(channelId);
    return new Response(renderMapListPage(maps, channelId, PUBLIC_BASE_URL), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (req.method === "GET" && path === "/map") {
    const channelId = url.searchParams.get("channel");
    const mapName = url.searchParams.get("map");
    if (!channelId || !/^\d+$/.test(channelId)) {
      return new Response("Missing or invalid channel.", { status: 400 });
    }
    if (!mapName) return new Response("Missing map name.", { status: 400 });
    const broadcaster = await getBroadcaster(channelId);
    if (!broadcaster || Number(broadcaster.connected) !== 1) {
      return new Response("Map unavailable for this channel.", { status: 404 });
    }
    const map = await getMap(channelId, mapName);
    if (!map) {
      return new Response("No map found with that name in this channel.", {
        status: 404,
      });
    }
    const [cells, tokens] = await Promise.all([
      getMapCells(channelId, mapName),
      getMapTokens(channelId, mapName),
    ]);
    return new Response(renderMapPage(map, cells, tokens, PUBLIC_BASE_URL), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
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
      return new Response("Unauthorized", {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      });
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
        ok: !stale &&
          (!status || Number((status as any).last_posts_failed ?? 0) === 0),
        stale,
        seconds_since_last_run: lastRunAt
          ? Math.round((now - lastRunAt) / 1000)
          : null,
        status,
        recent_events: recentEvents,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
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
    const authorized = !!secret && secret.length >= 32 &&
      (auth === `Bearer ${secret}` || keyParam === secret);
    if (!authorized) {
      return new Response(
        "Unauthorized. Append ?key=<ADMIN_API_SECRET> to the URL.",
        {
          status: 401,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    const kindFilter = url.searchParams.get("kind") ?? "";
    const [status, overview, events] = await Promise.all([
      getMerchantCronStatus(),
      getMerchantOverview(),
      getMonitorEvents(kindFilter || undefined, 100),
    ]);
    const body = renderAdminLogsPage({
      status,
      overview,
      events,
      kindFilter,
      key: keyParam,
    });
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="30"><title>GuildScribe Operator Logs</title><style>:root{color-scheme:dark}body{font-family:Georgia,serif;max-width:1100px;margin:32px auto;background:#15120f;color:#f4eadb;padding:20px}h1{color:#e6a56e;margin-bottom:4px}a{color:#e6a56e}</style></head><body>${body}</body></html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
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
        `<h1>GuildScribe</h1><p>A D&amp;D guild hall for Twitch — characters, dice, duels, and the codex of rules.</p><p><a href="/connect">Raise the Guild Banner in My Channel</a></p><p><strong>After joining:</strong> mod the bot with <code>/mod GuildScribeBot</code> so the scribes can speak.</p><p class="muted" style="font-size:.92rem;opacity:.85"><strong>Already connected?</strong> If GuildScribe has gained new features since you joined, <a href="/connect">reconnect your channel</a> to grant any newly requested permissions. This is safe to do any time and won't duplicate or lose your existing data.</p><p class="muted" style="font-size:.92rem;opacity:.85"><strong>Moderators:</strong> <a href="/dashboard">open the Guild Dashboard</a> to switch modules on or off for your channel.</p><p><a href="${PUBLIC_BASE_URL}/guide">Open the Guild Codex</a> · <a href="/donate">Support the Guild</a>${
          Deno.env.get("SUPPORT_URL")
            ? ` · <a href="${
              escapeHtml(Deno.env.get("SUPPORT_URL")!)
            }">Support / Contact</a>`
            : ""
        }</p>`,
      );
    }
    if (!username) {
      return new Response("Missing character user.", { status: 400 });
    }
    if (!channelId || !/^\d+$/.test(channelId)) {
      return new Response("Missing or invalid channel.", { status: 400 });
    }
    const broadcaster = await getBroadcaster(channelId);
    if (!broadcaster || Number(broadcaster.connected) !== 1) {
      return new Response("Character page unavailable for this channel.", {
        status: 404,
      });
    }
    const c = await getCharacter(username.toLowerCase(), channelId);
    if (!c) {
      return new Response("No character found for that user in this channel.", {
        status: 404,
      });
    }
    return new Response(renderCharacterPage(c), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (req.method === "POST" && path.startsWith("/admin/channels/")) {
    const secret = Deno.env.get("ADMIN_API_SECRET");
    const auth = req.headers.get("Authorization") ?? "";
    if (!secret || secret.length < 32 || auth !== `Bearer ${secret}`) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const match = path.match(/^\/admin\/channels\/(\d+)\/(disable|enable)$/);
    if (!match) return new Response("Not found", { status: 404 });
    const broadcasterId = match[1];
    if (match[2] === "disable") {
      await blockChannel(broadcasterId, "operator override");
      await recordMonitorEvent("operator_disable", broadcasterId);
      return new Response(
        JSON.stringify({
          ok: true,
          broadcaster_id: broadcasterId,
          blocked: true,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    }
    await unblockChannel(broadcasterId);
    await recordMonitorEvent("operator_enable", broadcasterId);
    return new Response(
      JSON.stringify({
        ok: true,
        broadcaster_id: broadcasterId,
        blocked: false,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  if (req.method !== "POST") return new Response("OK");

  // ── EventSub webhook ──
  const rawBody = await req.text();
  if (!(await verifyEventSub(req, rawBody))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const messageId = req.headers.get("Twitch-Eventsub-Message-Id") ?? "";
  if (!(await claimEventSubMessage(messageId))) return new Response("OK");
  const messageType = req.headers.get("Twitch-Eventsub-Message-Type");
  const body = JSON.parse(rawBody);

  if (messageType === "webhook_callback_verification") {
    return new Response(body.challenge, {
      headers: { "Content-Type": "text/plain" },
    });
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
      const isAnonymousGifter =
        subscriptionType === "channel.subscription.gift" &&
        Boolean(body.event?.is_anonymous);
      if (
        !subBroadcasterId ||
        (!isAnonymousGifter &&
          isBotAccount(
            subUserLogin,
            body.event?.user_id ?? "",
            env("TWITCH_BOT_ID"),
          ))
      ) {
        return new Response("OK");
      }
      const subConnection = await getBroadcaster(subBroadcasterId);
      if (!subConnection || Number(subConnection.connected) !== 1) {
        return new Response("OK");
      }
      if (await isChannelBlocked(subBroadcasterId)) return new Response("OK");
      if (!(await isChannelEnabled(subBroadcasterId))) {
        return new Response("OK");
      }

      const thankYou = subscriptionType === "channel.subscribe"
        ? (body.event?.is_gift
          ? rollGiftedSubWelcome(subDisplay, tier)
          : rollNewSubThankYou(subDisplay, tier))
        : subscriptionType === "channel.subscription.gift"
        ? rollGiftSubThankYou(
          isAnonymousGifter ? null : subDisplay,
          Number(body.event?.total ?? 1),
          tier,
        )
        : rollResubThankYou(
          subDisplay,
          Number(body.event?.cumulative_months ?? 1),
          tier,
        );
      if (thankYou) await sendChatMessage(thankYou, subBroadcasterId);
      return new Response("OK");
    }

    if (subscriptionType === "channel.raid") {
      // channel.raid fires on the *receiving* channel's condition
      // (to_broadcaster_user_id), so the "from" fields identify the raider.
      const raidBroadcasterId: string = body.event?.to_broadcaster_user_id ??
        "";
      const raiderLogin: string = body.event?.from_broadcaster_user_login ?? "";
      const raiderId: string = body.event?.from_broadcaster_user_id ?? "";
      const raiderDisplay: string = body.event?.from_broadcaster_user_name ??
        raiderLogin;
      const viewers = Number(body.event?.viewers ?? 0);
      if (
        !raidBroadcasterId ||
        isBotAccount(raiderLogin, raiderId, env("TWITCH_BOT_ID"))
      ) {
        return new Response("OK");
      }
      const raidConnection = await getBroadcaster(raidBroadcasterId);
      if (!raidConnection || Number(raidConnection.connected) !== 1) {
        return new Response("OK");
      }
      if (await isChannelBlocked(raidBroadcasterId)) return new Response("OK");
      if (!(await isChannelEnabled(raidBroadcasterId))) {
        return new Response("OK");
      }
      await sendChatMessage(
        rollRaidThankYou(raiderDisplay, viewers),
        raidBroadcasterId,
      );
      return new Response("OK");
    }

    const chatMessage: string = body.event?.message?.text ?? "";
    const chatter: string = body.event?.chatter_user_login ?? "";
    const display: string = body.event?.chatter_user_name ?? chatter;
    const chatterId: string = body.event?.chatter_user_id ?? "";
    const moderatorId: string = body.event?.moderator_user_id ?? "";
    const eventBroadcasterId: string = body.event?.broadcaster_user_id ?? "";
    const broadcasterId: string = eventBroadcasterId;
    const isModerator = chatterId === broadcasterId ||
      chatterId === eventBroadcasterId ||
      chatterId === moderatorId ||
      hasModeratorBadge(body.event);
    const baseUrl = url.origin;

    if (isBotAccount(chatter, chatterId, env("TWITCH_BOT_ID"))) {
      // Bot messages (Nightbot, StreamElements, GuildScribe itself, etc.)
      // never get processed as commands or quoted by the chronicle, but they
      // still count as chat activity toward its minimum-messages gate.
      await recordChronicleBotMessage(broadcasterId);
      return new Response("OK");
    }

    // Only process events for an actively connected broadcaster. This makes a
    // stale EventSub subscription harmless after disconnect/offboarding.
    const connection = await getBroadcaster(broadcasterId);
    if (!connection || Number(connection.connected) !== 1) {
      return new Response("OK");
    }

    // Operator blocklist always wins.
    if (await isChannelBlocked(broadcasterId)) return new Response("OK");

    // Broadcaster-only disconnect/offboarding. `purge` additionally deletes channel data.
    const leaveMatch = chatMessage.trim().match(
      /^!dndbot\s+leave(?:\s+(purge))?$/i,
    );
    if (leaveMatch) {
      if (chatterId !== broadcasterId && chatterId !== eventBroadcasterId) {
        await sendChatMessage(
          `@${display} only the broadcaster can disconnect GuildScribe.`,
          broadcasterId,
        );
        return new Response("OK");
      }
      const purge = Boolean(leaveMatch[1]);
      const connection = await getBroadcaster(broadcasterId);
      try {
        if (connection?.subscription_id) {
          await deleteEventSubSubscription(String(connection.subscription_id));
        }
      } catch (e) {
        await queueEventSubCancellation(
          String(connection.subscription_id),
          broadcasterId,
          String(e),
        );
        await recordMonitorEvent(
          "eventsub_delete_error",
          `${broadcasterId}: cancellation queued for retry`,
        );
      }
      for (const extra of await getExtraEventSubSubscriptions(broadcasterId)) {
        try {
          await deleteEventSubSubscription(extra.subscription_id);
        } catch (e) {
          await queueEventSubCancellation(
            extra.subscription_id,
            broadcasterId,
            String(e),
          );
          await recordMonitorEvent(
            "eventsub_delete_error",
            `${broadcasterId}: ${extra.kind} cancellation queued for retry`,
          );
        }
      }
      await sendChatMessage(
        `@${display} GuildScribe is disconnecting from this channel${
          purge ? " and purging its stored guild data" : ""
        }.`,
        broadcasterId,
      );
      if (purge) await purgeChannelData(broadcasterId);
      else await disconnectBroadcasterData(broadcasterId, false);
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
          `@${display} The guild hall is currently ${
            (await isChannelEnabled(broadcasterId)) ? "open" : "closed"
          } in this channel.`,
          broadcasterId,
        );
      } else {
        const enabled = botToggle[1].toLowerCase() === "on";
        await setChannelEnabled(broadcasterId, enabled);
        await sendChatMessage(
          `@${display} The guild hall is now ${
            enabled ? "open" : "closed"
          } in this channel. ${
            enabled
              ? "Adventurers may petition the scribes."
              : "The doors are barred until a steward reopens them."
          }`,
          broadcasterId,
        );
      }
      return new Response("OK");
    }

    if (!(await isChannelEnabled(broadcasterId))) return new Response("OK");

    if (chatMessage.startsWith("!")) {
      // Throttle non-mod command spam before it reaches any handler or the DB.
      if (
        !isModerator &&
        !(await checkCommandRateLimit(
          broadcasterId,
          chatter,
          COMMAND_COOLDOWN_MS,
        ))
      ) return new Response("OK");
      await recordActivity(
        chatter,
        broadcasterId,
        chatMessage.split(/\s+/)[0].toLowerCase(),
        chatMessage,
      );
    }

    // Command handlers (return true if handled)
    if (
      await handleCreationCommand(chatter, display, broadcasterId, chatMessage)
    ) return new Response("OK");
    if (
      await handleBg3Command(
        chatter,
        display,
        broadcasterId,
        chatMessage,
        baseUrl,
      )
    ) return new Response("OK");
    if (
      await handleInitiativeCommand(
        chatMessage,
        broadcasterId,
        display,
        isModerator,
        chatter,
      )
    ) return new Response("OK");
    if (
      await handlePartyCommand(chatMessage, chatter, display, broadcasterId)
    ) return new Response("OK");
    if (
      await handlePartyDuelCommand(chatMessage, chatter, display, broadcasterId)
    ) return new Response("OK");
    // Monster first: only claims exact "!dndduel" / "!dndduel attack" / "!dndduel monster …"
    // so player-vs-player "!dndduel @user" still falls through to handleDuelCommand.
    if (
      await handleMonsterDuelCommand(
        chatMessage,
        chatter,
        display,
        broadcasterId,
      )
    ) return new Response("OK");
    if (await handleDuelCommand(chatMessage, chatter, display, broadcasterId)) {
      return new Response("OK");
    }
    if (
      await handleMapCommand(
        chatMessage,
        chatter,
        display,
        broadcasterId,
        isModerator,
        baseUrl,
      )
    ) return new Response("OK");
    if (
      await handleCustomCommandManagement(
        chatMessage,
        display,
        broadcasterId,
        isModerator,
      )
    ) return new Response("OK");
    if (
      await handleMerchantCommand(
        chatMessage,
        display,
        broadcasterId,
        isModerator,
      )
    ) return new Response("OK");
    if (
      await handleChronicleCommand(
        chatMessage,
        display,
        broadcasterId,
        isModerator,
      )
    ) return new Response("OK");

    if (chatMessage === "!logs") {
      if (!isModerator) {
        await sendChatMessage(
          `@${display} only the broadcaster or a moderator can use !logs.`,
          broadcasterId,
        );
      } else {
        const logs = await getRecentLogs(broadcasterId, 8);
        await sendChatMessages(
          logs.length
            ? `@${display} Recent activity: ${
              logs.reverse().map(logRowText).join(" || ")
            }`
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
          `@${display} Connected channels (${names.length}): ${
            names.length ? names.join(", ") : "none"
          }`,
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
      const help = category === "dice"
        ? "🎲 Fate's dice: !d20 | !d20 @user | !roll | !r | !roll NdS[+/-M] (e.g. !roll 2d6+3) | !roll @user [NdS[+/-M]] | !roll <ability> saving throw (e.g. !roll dex) | !roll <skill> check (e.g. !roll stealth) — uses your saved character | !roll <question>? for a D&D-flavored yes/no verdict (e.g. !roll is enya going to die this time?) | !bg3roll for a random Baldur's Gate 3 style character | !bg3companion for a random BG3 companion match | !bg3origin to be cast as a random Origin Character | !bg3loot for a random BG3-style magic item drop | !bg3camp for a random camp-night vignette"
        : category === "settings"
        ? "🏛️ Guild stewards (mod/broadcaster): !dndbot on | !dndbot off | !dndbot status | !dndbot leave [purge] | !market on | !market off | !market status (off by default) | !chronicle on | !chronicle off | !chronicle status (off by default) | !help | !guide | !link"
        : category === "character"
        ? "⚔️ Adventurer's parchment: !createchar | !createchar @user (mod) | !newchar | !bg3 (random race/class, you choose BG3 point-buy scores) | !answer <choice> | !cancel | !char | !char @user | !levelup [+/-N] | !hp [+/-N] | !savechar | !loadchar | !resetchar"
        : category === "party"
        ? "🛡️ Guild company: !party create <name> | !party join <name> | !party invite @user [name] | !party accept/decline [name] | !party list [name] (roster + members) | !party leave <name> | !party disband <name>"
        : category === "combat"
        ? "⚔️ Arena & wilds: !dndduel @user (auto) | !dndduel classic @user | !dndduel accept/decline/attack/status/end | !dndduel (auto monster) | !dndduel monster (classic) | !dndduel party A B | !dndduel party classic A B | !dndduel party accept/decline/attack/status/end | !dndduel party hunt <party> | !dndduel party hunt classic <party> | !dndduel party hunt attack/status/end | !turn start | !turn roll | !turn add <name> <init> | !turn show | !turn next | !turn prev | !turn remove <name> | !turn end"
        : category === "lookup"
        ? "📚 Guild archives: !spell <name> [+N] | !item <name> [+N] | !class <name> | !feat <name> | !ability <score> | !race <name> | !subrace <name> | !monster <name> | !rule <topic> | !rules <topic> (e.g. !spell fireball, !rules magic, !monster goblin) | !bg3lookup <name> — BG3 companions/origins/classes/races/locations/factions/deities/villains/items (e.g. !bg3lookup astarion, !bg3lookup moonrise towers)"
        : category === "maps"
        ? "🗺️ Battle maps: !map create <name> [WxH] [template] (mod) | !map templates | !map list | !map view <name> | !map delete <name> / !map remove <name> (mod) | !map terrains | !map fill <name> <terrain> (mod) | !map paint <name> <x> <y> <terrain> (mod) | !map addchar <name> [x y] | !map addchar <name> @user [x y] (mod) | !map move <name> <x> <y> | !map move <name> @user <x> <y> (mod) | !map removechar <name> [@user]"
        : category === "custom"
        ? "🛠️ Custom commands & triggers: !dndbot add <name> <response> | !dndbot edit <name> <response> | !dndbot remove <name> | !dndbot cooldown <name> <seconds> | !dndbot list | !trigger add <keyword> <response> | !trigger remove <keyword> | !trigger cooldown <keyword> <seconds> | !trigger list — add/edit/remove/cooldown are mod-only, list is open to everyone"
        : `📜 Guild Codex chapters: dice | character | party | combat | lookup | maps | custom | settings. Example: !dndbothelp party — full book: ${PUBLIC_BASE_URL}/guide`;
      await sendChatMessages(`@${display} ${help}`, broadcasterId);
    } else if (/^!levelup(?:\s+([+-]\d+))?$/i.test(chatMessage)) {
      const match = chatMessage.match(/^!levelup(?:\s+([+-]\d+))?$/i)!;
      const delta = match[1] ? Number.parseInt(match[1], 10) : 1;
      const result = await adjustLevel(chatter, delta, broadcasterId);
      if ("error" in result) {
        const errorText = result.error === "no character"
          ? "you don't have a character yet — try !createchar"
          : result.error === "max level"
          ? "you're already level 20"
          : result.error === "min level"
          ? "you're already level 1"
          : "use !levelup, !levelup +2, or !levelup -1";
        await sendChatMessage(`@${display} ${errorText}`, broadcasterId);
      } else {
        const direction = result.delta > 0 ? "advanced" : "reduced";
        const hpChange = result.hpGain >= 0
          ? `HP +${result.hpGain}`
          : `HP ${result.hpGain}`;
        await sendChatMessage(
          `@${display} level ${direction} from ${result.oldLevel} to ${result.c.level}; ${hpChange}, HP ${result.c.hpCurrent}/${result.c.hpMax}, Prof +${result.c.proficiency}.${result.asi}`,
          broadcasterId,
        );
      }
    } else if (
      /^!(spell|item|class|feat|ability|race|subrace|rule|rules|monster)(?:\s+.*)?$/i
        .test(chatMessage)
    ) {
      const match = chatMessage.match(
        /^!(spell|item|class|feat|ability|race|subrace|rule|rules|monster)(?:\s+(.+?))?(?:\s+\+(\d+))?$/i,
      )!;
      const kind = match[1].toLowerCase();
      const query = (match[2] ?? "").trim();
      const bonus = match[3]
        ? Math.min(20, Number.parseInt(match[3], 10))
        : null;

      // Incomplete command — suggest syntax + examples
      if (!query) {
        const usage: Record<string, string> = {
          spell:
            "Usage: !spell <name> [+N]. Example: !spell fireball or !spell cure wounds +1",
          item:
            "Usage: !item <name> [+N]. Example: !item longsword or !item longsword +1",
          class: "Usage: !class <name>. Example: !class wizard",
          feat: "Usage: !feat <name>. Example: !feat alert",
          ability:
            "Usage: !ability <score>. Example: !ability strength or !ability dex",
          race: "Usage: !race <name>. Example: !race elf",
          subrace: "Usage: !subrace <name>. Example: !subrace high elf",
          rule:
            "Usage: !rule <topic>. Example: !rule advantage or !rule casting a spell",
          rules:
            "Usage: !rules <topic>. Example: !rules magic or !rules combat",
          monster:
            "Usage: !monster <name>. Example: !monster goblin or !monster adult red dragon",
        };
        await sendChatMessage(
          `@${display} ${usage[kind] ?? `Usage: !${kind} <query>`}`,
          broadcasterId,
        );
      } else {
        const data = await lookup5e(kind, query);
        if (data && kind === "spell") {
          await sendSpellSections(
            formatSpellSections(data, bonus),
            display,
            broadcasterId,
          );
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
      const isFateQuestion = !checkKind && !rollTarget && !!rest &&
        !/^\d+d\d+([+-]\d+)?$/i.test(rest) &&
        (/\s/.test(rest) || /\?$/.test(rest));

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
            const proficient = checkKind.type === "save" &&
              classes[c.cls].savingThrows.includes(checkKind.ability);
            const total = abilityMod + (proficient ? c.proficiency : 0);
            expression = `1d20${
              total === 0 ? "" : total > 0 ? `+${total}` : `${total}`
            }`;
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
          } else if (rollTarget) {
            await sendChatMessage(
              `@${display} rolled for @${rollTarget}: ${result}`,
              broadcasterId,
            );
          } else {
            await sendChatMessage(`@${display} ${result}`, broadcasterId);
          }
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
      const hugTarget = hugMatch[1]
        ? hugMatch[1].toLowerCase().replace(/[,:]+$/, "")
        : null;
      await sendChatMessage(rollHug(display, hugTarget), broadcasterId);
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
            `@${display} ⚠️ ${
              forSomeoneElse ? `@${targetUser} already has` : "you already have"
            } an active ${
              formatRaceName(existing.race, existing.subrace)
            } ${existing.cls} (Level ${existing.level}). Reply !answer yes to overwrite with a new random character, or !answer no to keep it.`,
            broadcasterId,
          );
        } else {
          const c = generateCharacter(targetUser);
          await saveCharacter(c, broadcasterId);
          await sendChatMessage(
            `@${display} created a level 1 ${
              formatRaceName(c.race, c.subrace)
            } ${c.cls}! ${formatStatLine(c)} — ${baseUrl}/?user=${targetUser}`,
            broadcasterId,
          );
        }
      }
    } else if (/^!char(?:\s+@?\S+)?$/i.test(chatMessage)) {
      const charMatch = chatMessage.match(/^!char(?:\s+@?(\S+))?$/i)!;
      const targetUser = charMatch[1]
        ? charMatch[1].toLowerCase().replace(/[,:]+$/, "")
        : chatter;
      const c = await getCharacter(targetUser, broadcasterId);
      if (c) {
        const label = targetUser === chatter ? "" : `@${targetUser} `;
        await sendChatMessage(
          `@${display} ${label}${
            formatRaceName(c.race, c.subrace)
          } ${c.cls} — ${formatStatLine(c)} — ${baseUrl}/?user=${targetUser}`,
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
    } else if (chatMessage.startsWith("!hp ")) {
      const delta = Number.parseInt(chatMessage.slice(4).trim());
      if (Number.isNaN(delta)) {
        await sendChatMessage(
          `@${display} use !hp +5 or !hp -3`,
          broadcasterId,
        );
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
          ? `@${display} character loaded! ${
            formatStatLine(c)
          } — ${baseUrl}/?user=${chatter}`
          : `@${display} no saved backup found — try !savechar first`,
        broadcasterId,
      );
    } else if (chatMessage === "!resetchar") {
      await resetCharacter(chatter, broadcasterId);
      await sendChatMessage(
        `@${display} character reset — use !createchar to roll a new one`,
        broadcasterId,
      );
    } else if (chatMessage.startsWith("!")) {
      // Nothing built-in matched — try a chat-authored custom command.
      await handleCustomCommandInvocation(chatMessage, display, broadcasterId);
    } else if (isGoodnightMessage(chatMessage)) {
      // Plain-chat "goodnight" detection (not a "!" command). Cooldown per
      // channel so a wave of goodnights from many viewers only draws one reply.
      if (await checkGoodnightCooldown(broadcasterId, GOODNIGHT_COOLDOWN_MS)) {
        await sendChatMessage(goodnightReply(display), broadcasterId);
      }
    } else {
      // Plain (non-"!") chat — check passive keyword triggers first; only
      // roll the chronicle's random quote-back if no trigger already replied.
      const triggerFired = await handleTriggerMatch(chatMessage, display, broadcasterId);
      if (!triggerFired) {
        await maybeChronicleQuote(chatMessage, display, broadcasterId);
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
        await markBroadcasterDisconnected(
          broadcasterId,
          String(body.subscription?.status ?? "revoked"),
          subscriptionId,
        );
      } else {
        // A revoked subscribe/resub/gift/raid subscription only disables
        // that extra thank-you feature for this channel — the rest of the
        // bot, including chat commands, keeps working.
        await deleteExtraEventSubSubscriptions(broadcasterId);
      }
      await recordMonitorEvent(
        "eventsub_revocation",
        `${broadcasterId}:${subscriptionType}:${subscriptionId}`,
      );
    }
  }
  return new Response("OK");
}

// TWITCH_BOT_ID must be the numeric Twitch user ID belonging to TWITCH_BOT_TOKEN.

export default async function (req: Request): Promise<Response> {
  try {
    return await handleRequest(req);
  } catch (e) {
    try {
      await recordMonitorEvent("unhandled_error", String(e));
    } catch (_) {}
    console.error("GuildScribe request failed", e);
    return new Response("Internal server error", { status: 500 });
  }
}
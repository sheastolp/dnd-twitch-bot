// GuildScribe — Twitch D&D bot entry point
// Val Town / Deno HTTP handler

import { ensureTables, isChannelEnabled, setChannelEnabled, recordActivity, getBroadcaster, markBroadcasterDisconnected, disconnectBroadcasterData, purgeChannelData, isChannelBlocked, recordMonitorEvent, checkCommandRateLimit, claimEventSubMessage, queueEventSubCancellation, saveExtraEventSubSubscription, getExtraEventSubSubscriptions, deleteExtraEventSubSubscriptionById, isCommandGroupEnabled, setCommandGroupEnabled, setBroadcasterLiveStatus, markStreamStatusSubscribed, SCHEMA_HELPERS, sqlite } from "./db.ts";
import { ensureSocialTables } from "./social_db.ts";
import { PUBLIC_ORIGIN } from "./config.ts";
import { handleMapCommand } from "./maps.ts";
import { handleMerchantCommand } from "./merchant.ts";
import { handleHaggleCommand } from "./haggle.ts";
import { handleAdCommand } from "./ads.ts";
import { disconnectAdToken, ensureAdTables, purgeAdData } from "./ads_db.ts";
import { handleOracleCommand } from "./oracle.ts";
import { handleChronicleCommand, recordChronicleBotMessage } from "./chronicle.ts";
import { handlePointsCommand, maybeAwardChatPoints } from "./points.ts";
import { handleRobCommand } from "./rob.ts";
import { defer, ensureWhisperTables, runRequestScope, setReplyInitiator } from "./whisper.ts";
import { ensureReplyPageTables, purgeReplyPages } from "./replypages.ts";
import { handleWhisperTestCommand } from "./whispertest.ts";
import { ensureBattleLogTables } from "./battle_log.ts";
import { ensureSavingThrowTables, purgeSavingThrowData, resetSavingThrowTally } from "./savingthrows.ts";
import { ensureSwearJarTables, handleJarCommand, maybeChargeSwearJar, purgeSwearJarData } from "./swearjar.ts";
import { checkFeatureLock, handleBoonCommand, handleRedemptionEvent } from "./redemptions.ts";
import { disconnectRedemptionData, ensureRedemptionTables, purgeRedemptionData } from "./redemptions_db.ts";
import { handleAutohuntCommand } from "./autohunt.ts";
import { ensureBestiaryTables, getChannelRoster, handleBestiaryCommand, purgeBestiaryData } from "./bestiary.ts";
import { ensureRaidTables, handleRaidCommand, maybeLaunchRaidSafe, onRaidStreamStatus, purgeRaidData } from "./raid.ts";
import { ensureHuntCooldownTables, handleHuntCooldownCommand, purgeHuntCooldownData } from "./huntcooldown.ts";
import { ensureViewerNameTables, purgeViewerNames, recordViewerName } from "./mentions.ts";
import { handleNickCommand } from "./nick.ts";
import { ensureAutohuntTables, purgeAutohuntData } from "./autohunt_db.ts";
import { disconnectPointsData, ensurePointsTables, migrateToCopper, purgePointsData } from "./points_db.ts";
import { ensureAutoBanTables, handleAutoBanCommand, maybeAutoBan, purgeAutoBanData } from "./autoban.ts";
import { ensureBotDetectTables, handleBotCheckCommand, purgeBotDetectData } from "./botdetect.ts";
import { ensureChannelBotTables, isChannelBot, purgeChannelBotData } from "./channel_bots.ts";
import { ensureNowPlayingTables, purgeNowPlayingData } from "./nowplaying.ts";
import { ensureChannelOptionTables, purgeChannelOptions } from "./channel_options.ts";
import { handleHoardCommand } from "./hoard.ts";
import { ensureHoardTables, purgeHoardData } from "./hoard_db.ts";
import { ensureAdAlertTables, maybeAdHeadsUp, onAdBreakBegin, purgeAdAlertData } from "./adalerts.ts";
import { ensureWatchtimeTables, handleWatchtimeCommand, purgeWatchtimeData, trackWatchtime } from "./watchtime.ts";
import { handleNpcCommand, recordNpcChatterBotMessage } from "./npcs.ts";
import { handleCustomCommandManagement } from "./customcommands.ts";
import { handleTimedMessageCommand } from "./timedmessages.ts";
import { handleDashboardCommand } from "./dashboard.ts";
import { handleCreationCommand } from "./characters.ts";
import { handleDuelCommand, handleMonsterDuelCommand, handlePartyCommand, handlePartyDuelCommand, handleInitiativeCommand } from "./combat.ts";
import { env, sendChatMessage, fetchIsChannelLiveNow, createStreamStatusEventSubscriptions, verifyEventSub, deleteEventSubSubscription } from "./twitch.ts";
import { hasModeratorBadge } from "./utils.ts";
import { rollNewSubThankYou, rollResubThankYou, rollGiftSubThankYou, rollRaidThankYou } from "./flavor_events.ts";
import { groupForMessage } from "./commandgroups.ts";
import { page } from "./pages.ts";
import { handleBg3Command } from "./bg3.ts";
import { handleWebRoute } from "./web_routes.ts";
import { handleBuiltinChatCommand } from "./chat_builtin.ts";
import { ensureChecklistTables, handleChecklistCommand, onChecklistStreamOnline, purgeChecklistData } from "./checklist.ts";
import { ensureSoundByteTables, handleSoundByteCommand, purgeSoundByteData } from "./soundbytes.ts";

// Public HTTP trigger URL for this val (used for guide links in chat).
// OAuth redirects and character page links still use the request origin dynamically.

// Durable per-channel/user throttling is stored in SQLite so it survives restarts
// and remains consistent if the deployment scales beyond one warm instance.
const COMMAND_COOLDOWN_MS = Math.max(250, Number(Deno.env.get("COMMAND_COOLDOWN_MS") ?? "1200"));

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
//
// Even once per isolate is a lot: a cold isolate would make its first chat
// reply wait on all ~90. So the full setup also records a fingerprint of
// the setup code itself in schema_meta, and a later cold isolate whose code
// matches skips straight past it with a single read. Editing any function
// below changes the fingerprint, so the next request reruns the setup.
const SCHEMA_FUNCTIONS: Array<() => Promise<unknown>> = [
  ensureAdTables,
  ensureAutoBanTables,
  ensureBotDetectTables,
  ensureChannelBotTables,
  ensureNowPlayingTables,
  ensureChannelOptionTables,
  ensureAdAlertTables,
  ensureSocialTables,
  ensurePointsTables,
  ensureSwearJarTables,
  ensureWhisperTables,
  ensureReplyPageTables,
  ensureAutohuntTables,
  ensureRedemptionTables,
  ensureHuntCooldownTables,
  ensureRaidTables,
  ensureViewerNameTables,
  ensureWatchtimeTables,
  ensureBestiaryTables,
  ensureChecklistTables,
  ensureSoundByteTables,
  ensureHoardTables,
  ensureBattleLogTables,
  ensureSavingThrowTables,
];

async function schemaFingerprint(): Promise<string> {
  const source = [ensureTables, ...SCHEMA_HELPERS, migrateToCopper, ...SCHEMA_FUNCTIONS].map((f) => f.toString()).join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const fingerprint = await schemaFingerprint();
      try {
        const res = await sqlite.execute("SELECT fingerprint FROM schema_meta WHERE id = 1");
        if (String(res.rows[0]?.fingerprint ?? "") === fingerprint) return;
      } catch (_) { /* no schema_meta yet: run the full setup */ }
      // db.ts first (other files' tables don't depend on it, but its
      // migrations are the slow/ordered part); the rest are independent.
      await ensureTables();
      await Promise.all(SCHEMA_FUNCTIONS.map((ensure) => ensure()));
      await sqlite.execute(
        "CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL, updated_at INTEGER)",
      );
      await sqlite.execute("INSERT OR REPLACE INTO schema_meta (id, fingerprint, updated_at) VALUES (1, ?, ?)", [fingerprint, Date.now()]);
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

/** A request failed on a missing table/column: the schema is behind the
 * code somehow (e.g. a table dropped by hand). Forget the fingerprint so the
 * next request runs the full setup instead of trusting it. */
async function invalidateSchemaOnMissingTable(e: unknown) {
  if (!/no such (?:table|column)/i.test(String(e))) return;
  schemaReady = null;
  await sqlite.execute("DELETE FROM schema_meta").catch(() => {});
}

async function handleRequest(req: Request): Promise<Response> {
  await ensureSchema();
  const url = new URL(req.url);
  const path = url.pathname;

  const routed = await handleWebRoute(req, url, path);
  if (routed) return routed;

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
      if (!subBroadcasterId || (!isAnonymousGifter && await isChannelBot(subBroadcasterId, subUserLogin, body.event?.user_id ?? "", env("TWITCH_BOT_ID")))) {
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
      if (!raidBroadcasterId || await isChannelBot(raidBroadcasterId, raiderLogin, raiderId, env("TWITCH_BOT_ID"))) {
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
        await onRaidStreamStatus(liveBroadcasterId, subscriptionType === "stream.online", body.event?.started_at);
        // A new stream starts a fresh saving throws tally (savingthrows.ts).
        if (subscriptionType === "stream.online") await resetSavingThrowTally(liveBroadcasterId);
        // Start-of-stream checklist for the streamer (checklist.ts).
        if (subscriptionType === "stream.online" && !(await isChannelBlocked(liveBroadcasterId))) {
          await onChecklistStreamOnline(liveBroadcasterId);
        }
      }
      return new Response("OK");
    }

    // A real Twitch ad break just started (adalerts.ts): log it and tell chat.
    if (subscriptionType === "channel.ad_break.begin") {
      try { await onAdBreakBegin(body.event); } catch (e) { await recordMonitorEvent("ad_break_event_error", String(e)); }
      return new Response("OK");
    }

    if (subscriptionType === "channel.channel_points_custom_reward_redemption.add") {
      try { await handleRedemptionEvent(body.event); } catch (e) { await recordMonitorEvent("redemption_error", String(e)); }
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
    const baseUrl = PUBLIC_ORIGIN;

    if (await isChannelBot(broadcasterId, chatter, chatterId, env("TWITCH_BOT_ID"))) {
      // Bot messages (Nightbot, StreamElements, GuildScribe itself, etc.)
      // never get processed as commands, quoted by the chronicle, or replied
      // to by random NPC chatter, but they still count as chat activity
      // toward each feature's own minimum-messages gate.
      await Promise.all([recordChronicleBotMessage(broadcasterId), recordNpcChatterBotMessage(broadcasterId)]);
      return new Response("OK");
    }

    // Only process events for an actively connected broadcaster. This makes a
    // stale EventSub subscription harmless after disconnect/offboarding.
    // The connection row and the operator blocklist are independent reads —
    // fetch them concurrently instead of back-to-back.
    // channelOn is only needed further down, but fetching it here in the
    // same round-trip batch saves a sequential query on every message.
    const [connection, blocked, channelOn] = await Promise.all([
      getBroadcaster(broadcasterId),
      isChannelBlocked(broadcasterId),
      isChannelEnabled(broadcasterId),
    ]);
    if (!connection || Number(connection.connected) !== 1) return new Response("OK");

    // Operator blocklist always wins.
    if (blocked) return new Response("OK");

    // Auto-ban "ai viewers" spam (see autoban.ts). Runs before the
    // offline-quiet gate below so spammers are banned even when the stream
    // is offline; the announcement itself stays quiet while offline. Off by
    // default per channel (!autoban on). Mods/broadcaster are exempt.
    if (
      await maybeAutoBan(chatMessage, display, chatter, chatterId, broadcasterId, isModerator, Number(connection.is_live) === 1, baseUrl)
    ) return new Response("OK");

    // Stay quiet in chat while the channel is offline — but let mod+ (the
    // broadcaster, lead moderators and moderators; see hasModeratorBadge in
    // utils.ts) keep using every command normally so they can test
    // GuildScribe without going live. Ambient/scheduled sends that don't come
    // from a specific chat message (sub/raid thank-yous above, merchant ads
    // and timed messages in their own cron files) are gated the same way,
    // with no mod exception since there's no "requesting user" for those.
    // connection.is_live is a plain column already fetched above — kept
    // current by the stream.online/offline notifications below, so this
    // check costs nothing extra (no Twitch API call in this hot path) for a
    // channel that's already caught up.
    // Exception: !roster / !bestiary / !gear list only post a read-only link to their web
    // page, so they answer anyone even while offline (viewers browse between streams).
    const offlineExempt = /^!(?:roster|bestiary|gear\s+(?:list|all|page))$/i.test(chatMessage);
    if (!isModerator && !offlineExempt && Number(connection.is_live) !== 1) {
      // Channel connected before this feature existed — one-time backfill,
      // then re-check; every later message for this channel skips straight
      // to the column read above.
      if (Number(connection.stream_status_subscribed) !== 1) {
        await backfillStreamStatusSubscription(broadcasterId, PUBLIC_ORIGIN);
        const refreshed = await getBroadcaster(broadcasterId);
        if (!refreshed || Number(refreshed.is_live) !== 1) return new Response("OK");
      } else {
        return new Response("OK");
      }
    }

    // A "!command" reply long enough to need 3+ chat messages is whispered
    // to this chatter instead, with a one-line summary in chat (whisper.ts).
    // Plain chat (triggers, chronicle, NPC chatter) always replies in chat.
    if (chatMessage.trim().startsWith("!")) setReplyInitiator({ userId: chatterId, login: chatter, display, broadcasterId });

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
      await purgeRaidData(broadcasterId, purge);
      await purgeViewerNames(broadcasterId);
      await purgeReplyPages(broadcasterId);
      await purgeNowPlayingData(broadcasterId); // Spotify tokens go with the bot, purge or not
      if (purge) {
        await purgeChannelData(broadcasterId);
        await purgeAdData(broadcasterId);
        await purgeAutoBanData(broadcasterId);
        await purgeBotDetectData(broadcasterId);
        await purgeChannelBotData(broadcasterId);
        await purgeChannelOptions(broadcasterId);
        await purgeAdAlertData(broadcasterId);
        await purgePointsData(broadcasterId);
        await purgeSwearJarData(broadcasterId);
        await purgeRedemptionData(broadcasterId);
        await purgeWatchtimeData(broadcasterId);
        await purgeBestiaryData(broadcasterId);
        await purgeChecklistData(broadcasterId);
        await purgeSoundByteData(broadcasterId);
        await purgeHoardData(broadcasterId);
        await purgeSavingThrowData(broadcasterId);
      } else {
        await disconnectBroadcasterData(broadcasterId, false);
        await disconnectPointsData(broadcasterId);
        await disconnectRedemptionData(broadcasterId);
        await disconnectAdToken(broadcasterId);
      }
      return new Response("OK");
    }

    // Public channel list on tavernworks.dev (the "showcase" command group,
    // also on the dashboard). Matched before the group check so it can't be
    // swallowed by the "customcmds" switch that shares the !dndbot word.
    const showcaseToggle = chatMessage.trim().match(/^!dndbot\s+showcase(?:\s+(on|off|status))?$/i);
    if (showcaseToggle) {
      const action = (showcaseToggle[1] ?? "status").toLowerCase();
      if (action === "status") {
        const listed = await isCommandGroupEnabled(broadcasterId, "showcase");
        await sendChatMessage(`@${display} This channel is ${listed ? "listed" : "not listed"} on tavernworks.dev.`, broadcasterId);
      } else if (!isModerator) {
        await sendChatMessage(`@${display} only the broadcaster or a moderator can change that setting.`, broadcasterId);
      } else {
        const on = action === "on";
        await setCommandGroupEnabled(broadcasterId, "showcase", on);
        await sendChatMessage(
          `@${display} ${on ? "This channel is now listed on tavernworks.dev." : "This channel is no longer listed on tavernworks.dev."} (The site refreshes within a few minutes.)`,
          broadcasterId,
        );
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

    if (!channelOn) return new Response("OK");

    // Bookkeeping the reply doesn't depend on runs alongside it (defer —
    // awaited before the response is returned) instead of in front of it.
    defer(maybeLaunchRaidSafe(broadcasterId)); // due raid musters launch on any chat message
    // Watch-time clock (see watchtime.ts): every message while live, commands included.
    if (Number(connection.is_live) === 1) defer(trackWatchtime(broadcasterId, chatter, display));
    // Ad-break heads-up (adalerts.ts): at most one schedule check a minute per channel.
    if (Number(connection.is_live) === 1) defer(maybeAdHeadsUp(broadcasterId, baseUrl));

    if (chatMessage.startsWith("!")) {
      // Throttle non-mod command spam before it reaches any handler or the DB.
      // !jar / !fine (swear jar) are deliberately exempt: no cooldown on their trigger.
      // The rate limit, the dashboard group switch and channel-point hexes
      // are independent lookups — run them together, then apply them in order.
      // Dashboard-controlled feature groups (see COMMAND_GROUPS in
      // utils.ts) are a silent no-op when disabled, same as the master
      // isChannelEnabled check just above — features with their own
      // dedicated toggle (market/chronicle/npc) and !dashboard itself are
      // deliberately excluded from COMMAND_GROUPS so they're unaffected.
      const group = groupForMessage(chatMessage, /^!dndduel\s/i.test(chatMessage) ? await getChannelRoster(broadcasterId) : undefined);
      const rateLimited = !isModerator && !/^!(?:jar|fine)(?:\s|$)/i.test(chatMessage);
      const [allowed, groupOn, hexNotice] = await Promise.all([
        rateLimited ? checkCommandRateLimit(broadcasterId, chatter, COMMAND_COOLDOWN_MS) : true,
        group ? isCommandGroupEnabled(broadcasterId, group) : true,
        checkFeatureLock(chatMessage, chatter, broadcasterId), // channel-point "can't use <feature>" hexes
      ]);
      // Throttle non-mod command spam before it reaches any handler.
      // !jar / !fine (swear jar) are deliberately exempt: no cooldown on their trigger.
      if (!allowed) return new Response("OK");
      const commandWord = chatMessage.split(/\s+/)[0].toLowerCase();
      defer(recordActivity(chatter, broadcasterId, commandWord, chatMessage));
      defer(recordViewerName(broadcasterId, chatter, display)); // for battle-log short names
      if (!groupOn) return new Response("OK");
      if (hexNotice) {
        await sendChatMessage(`@${display} ${hexNotice}`, broadcasterId);
        return new Response("OK");
      }
    } else if (Number(connection.is_live) === 1) {
      // Copper for chatting (see points.ts): plain messages only, live only,
      // and a silent no-op unless the channel turned gold on (!gold on).
      // Silent bookkeeping, so it runs alongside the reply (see defer above).
      defer((async () => {
        if (await isCommandGroupEnabled(broadcasterId, "chatgold")) await maybeAwardChatPoints(chatMessage, chatter, display, broadcasterId);
      })());
    }

    // Swear jar (see swearjar.ts): plain chat only. Takes 2 cp of gold per
    // swear word and announces it; never consumes the message, so the rest of
    // the chat handling (triggers, goodnight, etc.) still runs. Failures here
    // must never break normal chat handling.
    // Runs alongside the trigger/goodnight/chronicle handling below rather
    // than in front of it (see defer above).
    if (!chatMessage.startsWith("!")) {
      defer((async () => {
        if (!(await isCommandGroupEnabled(broadcasterId, "jar"))) return;
        try { await maybeChargeSwearJar(chatMessage, chatter, display, broadcasterId); }
        catch (e) { await recordMonitorEvent("swearjar_error", String(e)); }
      })());
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
    if (await handleChecklistCommand(chatMessage, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleMerchantCommand(chatMessage, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleHaggleCommand(chatMessage, chatter, display, broadcasterId)) return new Response("OK");
    if (await handleChronicleCommand(chatMessage, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handlePointsCommand(chatMessage, chatter, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleJarCommand(chatMessage, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleRobCommand(chatMessage, chatter, display, broadcasterId)) return new Response("OK");
    if (await handleWatchtimeCommand(chatMessage, chatter, chatterId, display, broadcasterId, baseUrl)) return new Response("OK");
    if (await handleNickCommand(chatMessage, chatter, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleBoonCommand(chatMessage, chatter, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleAutohuntCommand(chatMessage, chatter, display, broadcasterId)) return new Response("OK");
    // Hunt and Hoard (hoard.ts): off by default; its words fall through when
    // it's off or the channel has its own custom command of the same name.
    if (await handleHoardCommand(chatMessage, chatter, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleBestiaryCommand(chatMessage, chatter, display, broadcasterId, isModerator, baseUrl)) return new Response("OK");
    if (await handleHuntCooldownCommand(chatMessage, chatter, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleRaidCommand(chatMessage, chatter, display, broadcasterId, isModerator)) return new Response("OK");
    if (await handleAutoBanCommand(chatMessage, display, isModerator, broadcasterId, baseUrl)) return new Response("OK");
    if (await handleBotCheckCommand(chatMessage, display, isModerator, broadcasterId, baseUrl)) return new Response("OK");
    if (await handleWhisperTestCommand(chatMessage, chatterId, display, broadcasterId, isModerator, baseUrl)) return new Response("OK");
    if (
      await handleNpcCommand(chatMessage, chatter, display, broadcasterId, isModerator)
    ) return new Response("OK");
    if (
      await handleAdCommand(chatMessage, display, broadcasterId, isModerator, baseUrl)
    ) return new Response("OK");
    if (await handleOracleCommand(chatMessage, chatter, display, broadcasterId)) return new Response("OK");
    if (await handleSoundByteCommand(chatMessage, display, broadcasterId, isModerator)) return new Response("OK");

    await handleBuiltinChatCommand({ chatMessage, chatter, display, broadcasterId, isModerator, baseUrl });
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
        // A revoked extra subscription (sub/raid/ad break/…) only disables
        // that one feature — the rest of the bot keeps working. Forget just
        // that subscription: wiping every row would hide the still-active
        // ones from the status card and from the next reconnect's cleanup.
        await deleteExtraEventSubSubscriptionById(subscriptionId);
      }
      await recordMonitorEvent("eventsub_revocation", `${broadcasterId}:${subscriptionType}:${subscriptionId}`);
    }
  }
  return new Response("OK");
}

// TWITCH_BOT_ID must be the numeric Twitch user ID belonging to TWITCH_BOT_TOKEN.

export default async function (req: Request): Promise<Response> {
  try {
    return await runRequestScope(() => handleRequest(req));
  } catch (e) {
    await invalidateSchemaOnMissingTable(e);
    try { await recordMonitorEvent("unhandled_error", String(e)); } catch (_) {}
    console.error("GuildScribe request failed", e);
    // An OBS browser source keeps whatever page it first loaded, so a
    // transient failure on /overlay would stick until someone refreshes it.
    // Send a blank, transparent page that reloads itself instead.
    if (req.method === "GET" && new URL(req.url).pathname === "/overlay") {
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>GuildScribe overlay</title><style>html,body{background:transparent;margin:0}</style></head><body></body></html>`,
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "5" } },
      );
    }
    return new Response("Internal server error", { status: 500 });
  }
}

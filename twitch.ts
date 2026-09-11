// =============================================================================
//  twitch.ts — connects to Twitch chat over EventSub WebSocket, dispatches
//  !commands, and periodically posts merchant ads / quest board updates /
//  checks for newly onboarded channels — all within one bounded time
//  window (see runForWindow), since GitHub Actions kills any job after 6
//  hours. bot.ts calls this once per scheduled workflow run.
// =============================================================================
import { Commands, applyQuestProgress } from "./commands.ts";
import { Merchant, ItemLore, AutoHunt, AutoHuntSession } from "./game.ts";
import { QuestBoard } from "./quests.ts";
import * as Store from "./storeClient.ts";
import { roleFromBadges, isModOrBroadcaster, Badge } from "./permissions.ts";
import { getUser, createChatMessageSubscription, sendChatMessage, refreshAccessToken, getLiveChannels, HelixUser } from "./helix.ts";

const BOT_USERNAME = (Deno.env.get("TWITCH_BOT_USERNAME") || "").toLowerCase();
const HOME_CHANNEL = (Deno.env.get("TWITCH_CHANNEL") || "").toLowerCase().replace(/^#/, "");

if (!BOT_USERNAME || !HOME_CHANNEL) {
  console.error("Missing TWITCH_BOT_USERNAME or TWITCH_CHANNEL env vars.");
}

const COMMAND_DEFS: { name: keyof typeof Commands; triggers: string[] }[] = [
  { name: "help", triggers: ["!help"] },
  { name: "start", triggers: ["!start"] },
  { name: "createchar", triggers: ["!enlist"] },
  { name: "character", triggers: ["!chars", "!ledger"] },
  { name: "hunt", triggers: ["!hunt"] },
  { name: "autohunt", triggers: ["!autohunt", "!auto"] },
  { name: "autohuntstop", triggers: ["!autohuntstop", "!autostop"] },
  { name: "autohuntstatus", triggers: ["!autohuntstatus", "!autostatus"] },
  { name: "rest", triggers: ["!rest"] },
  { name: "merchant", triggers: ["!merchant", "!shop"] },
  { name: "coinpurse", triggers: ["!coinpurse", "!purse"] },
  { name: "buy", triggers: ["!buy"] },
  { name: "inventory", triggers: ["!inventory", "!inv"] },
  { name: "item", triggers: ["!item", "!iteminfo"] },
  { name: "use", triggers: ["!use"] },
  { name: "drop", triggers: ["!drop"] },
  { name: "sell", triggers: ["!sell"] },
  { name: "resetchar", triggers: ["!discharge"] },
  { name: "quests", triggers: ["!quests", "!questboard", "!board"] },
  { name: "lurk", triggers: ["!lurk"] },
];

const triggerMap = new Map<string, keyof typeof Commands>();
for (const def of COMMAND_DEFS) {
  for (const trigger of def.triggers) triggerMap.set(trigger, def.name);
}

// Which feature-flag section (see the /admin panel) gates each command.
// Commands not listed here (!help, !start, the !clerk* admin commands) are
// never gated.
const COMMAND_FEATURE: Partial<Record<keyof typeof Commands, string>> = {
  createchar: "characters",
  character: "characters",
  resetchar: "characters",
  hunt: "combat",
  autohunt: "combat",
  autohuntstop: "combat",
  autohuntstatus: "combat",
  rest: "combat",
  merchant: "shop",
  buy: "shop",
  coinpurse: "shop",
  inventory: "shop",
  item: "shop",
  use: "shop",
  drop: "shop",
  sell: "shop",
  quests: "quests",
};

const ADMIN_TRIGGERS = new Set(["!clerkjoin", "!clerkleave", "!clerkchannels"]);

const SEND_DELAY_MS = 1500;
const PERIODIC_CHECK_MS = 10 * 1000; // how often we check "is it time to post an ad / sync channels / is the budget up"
const CHANNEL_SYNC_MS = 3 * 60 * 1000; // how often to check for newly onboarded channels

// Auto-announcement spacing (see maybePostPeriodicUpdates / channelReadyForAnnouncement):
// a channel must see this many chat lines OR this much time pass since its
// last auto-announcement before it's eligible for another one — of ANY of
// the four types below. That shared gate is what keeps them from clumping.
const CHANNEL_MIN_MESSAGES_BETWEEN_ANNOUNCEMENTS = 5;
const CHANNEL_MIN_MS_BETWEEN_ANNOUNCEMENTS = 30 * 60 * 1000; // 30 minutes

export async function runForWindow(budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const TOKEN_REFRESH_MS = 3 * 60 * 60 * 1000; // proactively refresh every 3h so a 4h token never expires mid-run

  // Get a known-fresh token before we even try to connect — the token
  // saved in secrets could easily be hours old by the time this run starts.
  await refreshAccessToken();
  let lastTokenRefreshAt = Date.now();

  let ws: WebSocket;
  let sessionId: string | null = null;
  let botUser: HelixUser | null = null;
  let lastChannelSyncAt = 0;
  let lastAutohuntCheckAt = 0;
  const AUTOHUNT_CHECK_MS = 30 * 1000; // independent of CHANNEL_SYNC_MS so timed hunts fire close to schedule
  const featureFlagsByChannel = new Map<string, Record<string, boolean>>();
  const channelUsers = new Map<string, HelixUser>();
  const channelMsgCountSinceAnnouncement = new Map<string, number>(); // real chat lines seen per channel since its last auto-announcement
  const channelLastAnnouncementAt = new Map<string, number>(); // when that channel last heard ANY auto-announcement
  const outbox: { channel: string; text: string }[] = [];
  let draining = false;

  function queueSay(channel: string, text: string) {
    const MAX = 480;
    if (text.length <= MAX) {
      outbox.push({ channel, text });
    } else {
      for (let i = 0; i < text.length; i += MAX) outbox.push({ channel, text: text.slice(i, i + MAX) });
    }
    drainOutbox();
  }

  async function drainOutbox() {
    if (draining) return;
    draining = true;
    while (outbox.length) {
      const { channel, text } = outbox.shift()!;
      const broadcaster = channelUsers.get(channel);
      if (broadcaster && botUser) {
        await sendChatMessage(broadcaster.id, botUser.id, text);
      }
      await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    }
    draining = false;
  }

  async function joinChannel(loginName: string): Promise<boolean> {
    const name = loginName.toLowerCase();
    if (channelUsers.has(name)) return true;
    if (!botUser || !sessionId) return false;
    const user = await getUser(name);
    if (!user) return false;
    const ok = await createChatMessageSubscription(user.id, botUser.id, sessionId);
    if (!ok) return false;
    channelUsers.set(name, user);
    return true;
  }

  function flagsFor(channel: string): Record<string, boolean> {
    return featureFlagsByChannel.get(channel) || {}; // empty map reads as "everything enabled" below
  }

  function channelReadyForAnnouncement(channel: string): boolean {
    const sinceLast = Date.now() - (channelLastAnnouncementAt.get(channel) || 0);
    const msgsSince = channelMsgCountSinceAnnouncement.get(channel) || 0;
    return msgsSince >= CHANNEL_MIN_MESSAGES_BETWEEN_ANNOUNCEMENTS || sinceLast >= CHANNEL_MIN_MS_BETWEEN_ANNOUNCEMENTS;
  }

  function recordChannelAnnouncement(channel: string) {
    channelMsgCountSinceAnnouncement.set(channel, 0);
    channelLastAnnouncementAt.set(channel, Date.now());
  }

  async function refreshFeatureFlags() {
    for (const channel of channelUsers.keys()) {
      try {
        featureFlagsByChannel.set(channel, await Store.getFeatureFlags(channel));
      } catch (err) {
        console.error(`Failed to load feature flags for #${channel}:`, err);
      }
    }
  }

  async function handleGameCommand(channel: string, username: string, trigger: string, args: string[]) {
    const commandName = triggerMap.get(trigger);
    if (!commandName) return;
    const featureKey = COMMAND_FEATURE[commandName];
    if (featureKey && flagsFor(channel)[featureKey] === false) {
      queueSay(channel, `@${username} that part of the Clerk's ledger is closed for now — check back later.`);
      return;
    }
    try {
      const reply = await Commands[commandName](username, username, args, channel);
      if (reply) queueSay(channel, reply);
    } catch (err) {
      console.error(`Error running ${trigger} for ${username} in #${channel}:`, err);
      queueSay(channel, `@${username} the Clerk's quill slips and the ink smudges running ${trigger} — try again in a moment.`);
    }
  }

  async function handleAdminCommand(channel: string, username: string, badges: Badge[], trigger: string, args: string[]) {
    const role = roleFromBadges(badges);
    const allowed = isModOrBroadcaster(role);

    if (trigger === "!clerkchannels") {
      const channels = await Store.getChannels();
      const list = [HOME_CHANNEL, ...channels].join(", ");
      queueSay(channel, `@${username} the Clerk currently keeps ledgers open in: ${list}.`);
      return;
    }

    if (!allowed) {
      queueSay(channel, `@${username} only a moderator or the broadcaster may direct the Clerk's travels.`);
      return;
    }

    const target = (args[0] || "").toLowerCase().replace(/^#/, "").trim();
    if (!target) {
      queueSay(channel, `@${username} to which town shall the Clerk travel? Try "${trigger} <channel name>".`);
      return;
    }

    if (trigger === "!clerkjoin") {
      if (target === HOME_CHANNEL || channelUsers.has(target)) {
        queueSay(channel, `@${username} the Clerk already keeps a ledger open in #${target}.`);
        return;
      }
      const ok = await joinChannel(target);
      if (!ok) {
        queueSay(
          channel,
          `@${username} the Clerk couldn't set up a desk in #${target} — that channel's broadcaster needs to grant this bot's Client ID the "channel:bot" permission first (send them the /onboard link).`
        );
        return;
      }
      await Store.addChannel(target, username);
      queueSay(channel, `@${username} very good — the Clerk has set up a desk in #${target}.`);
    } else if (trigger === "!clerkleave") {
      if (target === HOME_CHANNEL) {
        queueSay(channel, `@${username} the Clerk's home ledger stays put — that one isn't up for removal here.`);
        return;
      }
      if (!channelUsers.has(target)) {
        queueSay(channel, `@${username} the Clerk isn't currently serving #${target}.`);
        return;
      }
      await Store.removeChannel(target);
      channelUsers.delete(target);
      queueSay(
        channel,
        `@${username} understood — the Clerk will stop replying in #${target}. (The underlying Twitch subscription is left in place; remove it from the dev console if you want it fully revoked.)`
      );
    }
  }

async function handleChatMessageEvent(event: any) {
  const channel = (event.broadcaster_user_login || "").toLowerCase();
  const sourceChannel = (event.source_broadcaster_user_login || channel).toLowerCase();

  // Twitch Shared Chat: while this channel is in a shared-chat session with
  // another streamer, EventSub relays EVERY message in the combined feed to
  // us under broadcaster_user_login = this channel — even messages typed in
  // the other streamer's chat. source_broadcaster_user_login says where a
  // message really came from. If it doesn't match the channel we're
  // subscribed to, this is a relayed copy of someone else's chat: skip it
  // so a foreign channel's chatters can't trigger commands or replies here.
  // If that other channel is itself onboarded, its own direct subscription
  // delivers the same message with source === destination and handles it
  // there instead.
  if (sourceChannel !== channel) return;

  const username = (event.chatter_user_login || "").toLowerCase();
  const text = String(event.message?.text || "").trim();
  const badges: Badge[] = event.badges || [];

  if (!channel || !username) return;
  if (botUser && username === botUser.login.toLowerCase()) return;

  // Count every real chat line (not just commands) toward the per-channel
  // announcement-spacing gate — see channelReadyForAnnouncement().
  channelMsgCountSinceAnnouncement.set(channel, (channelMsgCountSinceAnnouncement.get(channel) || 0) + 1);

  if (!text.startsWith("!")) return;

  const [rawTrigger, ...args] = text.split(/\s+/);
  const trigger = rawTrigger.toLowerCase();

  if (ADMIN_TRIGGERS.has(trigger)) {
    await handleAdminCommand(channel, username, badges, trigger, args);
    return;
  }
  await handleGameCommand(channel, username, trigger, args);
}

  async function maybePostPeriodicUpdates() {
    await refreshFeatureFlags();

    // Only the Clerk's unprompted, periodic lines are held back for
    // offline channels — a real !command from a lingering chatter still
    // gets a reply regardless of live status.
    const liveChannels = await getLiveChannels([...channelUsers.keys()]);

    // Sends `text` to every live channel that has `flagKey` enabled AND is
    // ready to hear another unprompted line (channelReadyForAnnouncement).
    // Shared across all four announcement types below — posting one kind
    // resets the clock the others check too, which is what keeps them from
    // clumping together in any one channel.
    function announceToChannels(flagKey: string, text: string) {
      for (const channel of channelUsers.keys()) {
        if (flagsFor(channel)[flagKey] === false) continue;
        if (!liveChannels.has(channel)) continue;
        if (!channelReadyForAnnouncement(channel)) continue;
        queueSay(channel, text);
        recordChannelAnnouncement(channel);
      }
    }

    // Fully rerolls the stall's offers on a jittered ~8-12 minute cadence
    // (matching the original codex script's Merchant.AD_INTERVAL_MS /
    // AD_JITTER_MS), rather than just advertising whatever's already there.
    // The stall itself is shared across every channel; each channel's
    // merchant_ads toggle (and live status, and announcement readiness)
    // only controls whether THAT channel hears about it.
    const lastRestockRaw = await Store.getMeta("last_merchant_restock_at");
    const lastRestock = lastRestockRaw ? parseInt(lastRestockRaw, 10) : 0;
    const restockThreshold = Merchant.AD_INTERVAL_MS + Math.floor(Math.random() * Merchant.AD_JITTER_MS);
    if (Date.now() - lastRestock >= restockThreshold) {
      const offers = Merchant.rollOffers();
      await Store.saveMerchantOffers(offers);
      const desc = Merchant.describeOffers(offers);
      const announcement = "🛒 The stall has turned over its wares! " + desc +
        ". Say !buy <#|item name> to purchase, or !merchant to see it again later.";
      announceToChannels("merchant_ads", announcement);
      await Store.setMeta("last_merchant_restock_at", String(Date.now()));
    }

    const lastQuestRaw = await Store.getMeta("last_quest_refresh_at");
    const lastQuest = lastQuestRaw ? parseInt(lastQuestRaw, 10) : 0;
    if (Date.now() - lastQuest >= QuestBoard.BOARD_REFRESH_MS) {
      const board = QuestBoard.rollBoard();
      await Store.saveQuestBoard(board);
      const desc = QuestBoard.describeBoard(board);
      const announcement = "📜 The Clerk posts a fresh set of bounties: " + desc +
        ". Say !hunt <monster name> to take one on, or !quests to check your progress.";
      announceToChannels("quest_ads", announcement);
      await Store.setMeta("last_quest_refresh_at", String(Date.now()));
    }

    // Ambient flavor: every ~12-18 minutes, the Clerk shares a little story
    // about one of the wares currently sitting on the stall.
    const lastStoryRaw = await Store.getMeta("last_item_story_at");
    const lastStory = lastStoryRaw ? parseInt(lastStoryRaw, 10) : 0;
    const storyThreshold = 12 * 60 * 1000 + Math.floor(Math.random() * 6 * 60 * 1000);
    if (Date.now() - lastStory >= storyThreshold) {
      const currentOffers = await Store.getMerchantOffers();
      const pickedOffer = ItemLore.pickOffer(currentOffers);
      if (pickedOffer) {
        const story = "📖 " + ItemLore.story(pickedOffer);
        announceToChannels("item_lore", story);
      }
      await Store.setMeta("last_item_story_at", String(Date.now()));
    }

    // Gentle nudge for newcomers: every ~25-40 minutes, a soft reminder
    // that !start / !enlist exists, for anyone who's been lurking without
    // realizing there's a game going.
    const lastNudgeRaw = await Store.getMeta("last_start_nudge_at");
    const lastNudge = lastNudgeRaw ? parseInt(lastNudgeRaw, 10) : 0;
    const nudgeThreshold = 25 * 60 * 1000 + Math.floor(Math.random() * 15 * 60 * 1000);
    if (Date.now() - lastNudge >= nudgeThreshold) {
      const nudge = "New around here? Say !start for a quick status check, or !enlist <name> " +
        "(or !enlist random) to join in whenever you're ready. !help has the full charter if you're curious.";
      announceToChannels("start_nudge", nudge);
      await Store.setMeta("last_start_nudge_at", String(Date.now()));
    }
  }

  // Checked on its own short cadence (independent of the 3-minute channel
  // sync) so timed autohunts fire close to their scheduled time without
  // waiting on the slower periodic-updates gate. Sessions are persisted
  // (see Store.getAutohuntSessions), so a restart between workflow runs
  // just resumes from where the schedule left off rather than losing
  // progress or fast-forwarding through missed time.
  async function processAutohuntSessions() {
    const sessions = await Store.getAutohuntSessions();
    if (!sessions.length) return;
    const remaining: AutoHuntSession[] = [];
    let changed = false;
    for (const session of sessions) {
      if (AutoHunt.isExpired(session)) {
        changed = true;
        const c = await Store.getCharacter(session.username);
        if (c) queueSay(session.channel, "@" + session.username + " " + AutoHunt.summary(c, session, "time's up"));
        continue;
      }
      if (!AutoHunt.isDue(session)) {
        remaining.push(session);
        continue;
      }
      const c = await Store.getCharacter(session.username);
      if (!c) { changed = true; continue; } // character discharged mid-session — drop it silently
      const { message, monsterWon } = AutoHunt.tick(c, session);
      const questMsg = monsterWon ? await applyQuestProgress(c, monsterWon, 1) : "";
      await Store.saveCharacter(c);
      changed = true;
      queueSay(session.channel, "@" + session.username + " " + message + questMsg);
      remaining.push(session);
    }
    if (changed) await Store.saveAutohuntSessions(remaining);
  }

  // Picks up channels onboarded via the one-click /onboard flow mid-run,
  // without waiting for the next scheduled workflow to start.
  async function syncChannels() {
    const extraChannels = await Store.getChannels();
    for (const channel of extraChannels) {
      if (channelUsers.has(channel)) continue;
      const ok = await joinChannel(channel);
      if (ok) {
        console.log(`Joined newly onboarded channel: #${channel}`);
        queueSay(channel, `The Wandering Clerk has set up a desk here! Type !help to see everything the Clerk can do.`);
      }
    }
  }

  async function onSessionReady() {
    botUser = await getUser(BOT_USERNAME);
    if (!botUser) {
      console.error("Could not resolve the bot's own Twitch user id for", BOT_USERNAME);
      return;
    }
    const extraChannels = await Store.getChannels();
    for (const channel of [HOME_CHANNEL, ...extraChannels]) {
      const ok = await joinChannel(channel);
      if (!ok) {
        console.error(`Failed to subscribe to chat for #${channel} — has that broadcaster granted this Client ID the channel:bot permission?`);
      }
    }
    lastChannelSyncAt = Date.now();
    await maybePostPeriodicUpdates();
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(budgetTimer);
      resolve();
    };

    ws = new WebSocket("wss://eventsub.wss.twitch.tv/ws");

    ws.onmessage = (rawEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(String(rawEvent.data));
      } catch (err) {
        console.error("Failed to parse EventSub message:", err);
        return;
      }
      const type = msg.metadata?.message_type;

      if (type === "session_welcome") {
        sessionId = msg.payload.session.id;
        console.log("EventSub session established:", sessionId);
        onSessionReady().catch((err) => console.error("onSessionReady error:", err));
      } else if (type === "session_reconnect") {
        console.log("EventSub asked us to reconnect — ending this run early; the next scheduled run will reconnect.");
        try { ws.close(); } catch { /* ignore */ }
      } else if (type === "notification") {
        if (msg.metadata.subscription_type === "channel.chat.message") {
          handleChatMessageEvent(msg.payload.event).catch((err) => console.error("handleChatMessageEvent error:", err));
        }
      } else if (type === "revocation") {
        console.warn("An EventSub subscription was revoked:", msg.payload);
      }
    };

    ws.onclose = () => {
      console.warn("EventSub connection closed; ending this run.");
      finish();
    };

    ws.onerror = (err) => {
      console.error("EventSub socket error:", err);
    };

    const budgetTimer = setInterval(async () => {
      if (Date.now() >= deadline) {
        try { ws.close(); } catch { /* ignore */ }
        await drainOutbox();
        finish();
        return;
      }
      if (botUser && sessionId && Date.now() - lastChannelSyncAt >= CHANNEL_SYNC_MS) {
        lastChannelSyncAt = Date.now();
        syncChannels().catch((err) => console.error("syncChannels error:", err));
        maybePostPeriodicUpdates().catch((err) => console.error("maybePostPeriodicUpdates error:", err));
      }
      if (Date.now() - lastAutohuntCheckAt >= AUTOHUNT_CHECK_MS) {
        lastAutohuntCheckAt = Date.now();
        processAutohuntSessions().catch((err) => console.error("processAutohuntSessions error:", err));
      }
      if (Date.now() - lastTokenRefreshAt >= TOKEN_REFRESH_MS) {
        lastTokenRefreshAt = Date.now();
        refreshAccessToken().catch((err) => console.error("proactive refreshAccessToken error:", err));
      }
    }, PERIODIC_CHECK_MS);
  });
}
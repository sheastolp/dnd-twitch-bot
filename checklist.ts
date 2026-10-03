// Start-of-stream checklist — a reminder for the streamer the moment the
// stream goes live (stream.online, see main.ts): their own to-do items
// ("turn on alerts", "post in Discord"…) plus a one-line summary of which
// GuildScribe features are switched on, so a forgotten !market off or a
// closed guild hall shows up before chat notices.
//
// Sent as a whisper to the broadcaster when the bot has whisper access
// (whisper.ts); otherwise posted once in chat, @-ing the broadcaster.
// On by default per channel; !checklist off stops the go-live reminder
// (the items are kept, and !checklist still shows them on demand).
//
// !checklist                 show it now (mod/broadcaster)
// !checklist add <item>      add an item (mod/broadcaster)
// !checklist remove <n>      remove item n (mod/broadcaster)
// !checklist clear           remove every item (mod/broadcaster)
// !checklist on|off|status   go-live reminder switch (mod/broadcaster)

import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import { getBroadcaster, isChannelEnabled, isCommandGroupEnabled, isMerchantEnabled, listCustomTriggers, listTimedMessages, recordMonitorEvent } from "./db.ts";
import { isChronicleEnabled, isNpcEnabled } from "./social_db.ts";
import { isPointsEnabled } from "./points_db.ts";
import { isAutoBanEnabled } from "./autoban.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import { sendWhisperParts, WHISPER_MAX } from "./whisper.ts";
import { splitChatMessage } from "./utils.ts";

const MAX_ITEMS = 15;
const MAX_ITEM_LENGTH = 120;

export async function ensureChecklistTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS stream_checklist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, broadcaster_id TEXT NOT NULL, item TEXT NOT NULL, created_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute("CREATE INDEX IF NOT EXISTS idx_checklist_channel ON stream_checklist_items(broadcaster_id)");
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS stream_checklist_settings (
      broadcaster_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER
    )`,
  );
}

async function listItems(broadcasterId: string): Promise<string[]> {
  const res = await sqlite.execute("SELECT item FROM stream_checklist_items WHERE broadcaster_id = ? ORDER BY id ASC", [broadcasterId]);
  return res.rows.map((r: any) => String(r.item));
}

async function isReminderEnabled(broadcasterId: string): Promise<boolean> {
  const res = await sqlite.execute("SELECT enabled FROM stream_checklist_settings WHERE broadcaster_id = ?", [broadcasterId]);
  return !res.rows.length || Number(res.rows[0].enabled) === 1;
}

async function setReminderEnabled(broadcasterId: string, enabled: boolean) {
  await sqlite.execute(
    "INSERT OR REPLACE INTO stream_checklist_settings (broadcaster_id, enabled, updated_at) VALUES (?,?,?)",
    [broadcasterId, enabled ? 1 : 0, Date.now()],
  );
}

/** Wipes the channel's checklist — called from !dndbot leave purge. */
export async function purgeChecklistData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM stream_checklist_items WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM stream_checklist_settings WHERE broadcaster_id = ?", [broadcasterId]);
}

/** "Guild hall open · gold on · market off · …" — every switch a streamer
 * might have left in the wrong position, read in one parallel batch. */
async function featureSummary(broadcasterId: string): Promise<string> {
  const [hall, gold, market, chronicle, npcs, autoban, jar, raid, timed, triggers] = await Promise.all([
    isChannelEnabled(broadcasterId),
    isPointsEnabled(broadcasterId),
    isMerchantEnabled(broadcasterId),
    isChronicleEnabled(broadcasterId),
    isNpcEnabled(broadcasterId),
    isAutoBanEnabled(broadcasterId),
    isCommandGroupEnabled(broadcasterId, "jar"),
    isCommandGroupEnabled(broadcasterId, "raid"),
    listTimedMessages(broadcasterId),
    listCustomTriggers(broadcasterId),
  ]);
  const onOff = (on: boolean) => (on ? "on" : "off");
  const activeTimed = timed.filter((r: any) => Number(r.enabled ?? 1) === 1).length;
  const activeTriggers = triggers.filter((r: any) => Number(r.enabled ?? 1) === 1).length;
  if (!hall) return "⚠️ the guild hall is CLOSED (!dndbot on to open it) — every GuildScribe command is off";
  return [
    "guild hall open",
    `gold ${onOff(gold)}`,
    `market ${onOff(market)}`,
    `chronicle ${onOff(chronicle)}`,
    `NPCs ${onOff(npcs)}`,
    `autoban ${onOff(autoban)}`,
    `swear jar ${onOff(jar)}`,
    `raid quest ${onOff(raid)}`,
    `${activeTimed} timed message${activeTimed === 1 ? "" : "s"}`,
    `${activeTriggers} trigger${activeTriggers === 1 ? "" : "s"}`,
  ].join(" · ");
}

async function buildChecklist(broadcasterId: string): Promise<string> {
  const [items, summary] = await Promise.all([listItems(broadcasterId), featureSummary(broadcasterId)]);
  const list = items.length
    ? items.map((item, i) => `☐ ${i + 1}. ${item}`).join(" | ")
    : "no items yet — add your own with !checklist add <item>";
  return `📋 Stream checklist: ${list} | 🏛️ GuildScribe: ${summary}`;
}

/** stream.online hook (main.ts): whisper the broadcaster their checklist,
 * or post it in chat if the bot can't whisper. Never throws. */
export async function onChecklistStreamOnline(broadcasterId: string) {
  try {
    const conn = await getBroadcaster(broadcasterId);
    if (!conn || Number(conn.connected) !== 1) return;
    if (!(await isReminderEnabled(broadcasterId))) return;
    const text = await buildChecklist(broadcasterId);
    if (await sendWhisperParts(broadcasterId, splitChatMessage(text, WHISPER_MAX))) return;
    const name = String(conn.display_name || conn.login || "").trim();
    await sendChatMessages(name ? `@${name} ${text}` : text, broadcasterId);
  } catch (e) {
    await recordMonitorEvent("checklist_error", `${broadcasterId}: ${String(e)}`);
  }
}

/** Handles !checklist. Returns true if it consumed the message. */
export async function handleChecklistCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!checklist(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/i);
  if (!m) return false;
  const say = (text: string) => sendChatMessage(`@${display} ${text}`, broadcasterId);
  if (!isModerator) {
    await say("only the broadcaster or a moderator can use the stream checklist.");
    return true;
  }
  const sub = (m[1] ?? "").toLowerCase();
  const arg = (m[2] ?? "").trim();

  if (!sub || sub === "show" || sub === "list") {
    await sendChatMessages(`@${display} ${await buildChecklist(broadcasterId)}`, broadcasterId);
  } else if (sub === "add") {
    if (!arg) {
      await say("usage: !checklist add <item>, e.g. !checklist add turn on alerts");
    } else if ((await listItems(broadcasterId)).length >= MAX_ITEMS) {
      await say(`the checklist is full (${MAX_ITEMS} items) — !checklist remove <n> to make room.`);
    } else {
      const item = arg.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, MAX_ITEM_LENGTH);
      await sqlite.execute(
        "INSERT INTO stream_checklist_items (broadcaster_id, item, created_at) VALUES (?,?,?)",
        [broadcasterId, item, Date.now()],
      );
      await say(`added to the stream checklist: ${item}`);
    }
  } else if (sub === "remove" || sub === "delete") {
    const n = Number.parseInt(arg, 10);
    const res = await sqlite.execute("SELECT id, item FROM stream_checklist_items WHERE broadcaster_id = ? ORDER BY id ASC", [broadcasterId]);
    const row = Number.isInteger(n) && n >= 1 ? res.rows[n - 1] : undefined;
    if (!row) {
      await say(res.rows.length ? `usage: !checklist remove <1-${res.rows.length}>` : "the checklist has no items to remove.");
    } else {
      await sqlite.execute("DELETE FROM stream_checklist_items WHERE id = ?", [row.id]);
      await say(`removed from the stream checklist: ${row.item}`);
    }
  } else if (sub === "clear") {
    await sqlite.execute("DELETE FROM stream_checklist_items WHERE broadcaster_id = ?", [broadcasterId]);
    await say("the stream checklist is now empty.");
  } else if (sub === "on" || sub === "off") {
    await setReminderEnabled(broadcasterId, sub === "on");
    await say(
      sub === "on"
        ? "the stream checklist will be sent to the broadcaster each time the stream goes live."
        : "the go-live checklist reminder is off (items are kept; !checklist still shows them).",
    );
  } else if (sub === "status") {
    const [on, items] = await Promise.all([isReminderEnabled(broadcasterId), listItems(broadcasterId)]);
    await say(`go-live checklist reminder is ${on ? "on" : "off"} · ${items.length} item${items.length === 1 ? "" : "s"}.`);
  } else {
    await say("usage: !checklist [add <item> | remove <n> | clear | on | off | status]");
  }
  return true;
}

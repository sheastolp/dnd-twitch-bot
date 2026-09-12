// Timed messages — recurring announcements a mod/streamer schedules from
// chat (or the web dashboard, see dashboard.ts/pages.ts), posted on a
// rotating interval by timedmessages_cron.ts (a separate Val Town cron
// trigger, same shape as merchant_cron.ts — see that file's header).
//
//   !timedmsg add <minutes> <message>   (mod) schedule a new recurring post
//   !timedmsg edit <id> <message>       (mod) change an existing one's text
//   !timedmsg interval <id> <minutes>   (mod) change how often it posts
//   !timedmsg enable <id>               (mod)
//   !timedmsg disable <id>              (mod) pause without deleting
//   !timedmsg remove <id>               (mod) delete
//   !timedmsg list                      anyone — list configured messages
//
// Responses support a small placeholder subset (there's no chatter to
// address, unlike custom commands/triggers):
//   {count}          how many times this message has now been posted
//   {random:a|b|c}   picks one option at random (max 5 per response)

import { pick, compactText } from "./utils.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import {
  addTimedMessage,
  editTimedMessage,
  setTimedMessageInterval,
  setTimedMessageEnabled,
  deleteTimedMessage,
  listTimedMessages,
} from "./db.ts";

export const MAX_TIMED_MESSAGE_LEN = 400;
export const MIN_INTERVAL_MINUTES = Math.max(1, Number(Deno.env.get("TIMED_MESSAGE_MIN_INTERVAL_MINUTES") ?? "10"));
export const MAX_INTERVAL_MINUTES = Math.max(MIN_INTERVAL_MINUTES, Number(Deno.env.get("TIMED_MESSAGE_MAX_INTERVAL_MINUTES") ?? "10080")); // default cap 1 week
const MAX_RANDOM_BLOCKS = 5;

export function parseIntervalMinutes(raw: string | undefined | number): number | null {
  const minutes = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(minutes) && minutes >= MIN_INTERVAL_MINUTES && minutes <= MAX_INTERVAL_MINUTES ? minutes : null;
}

export function sanitizeTimedMessageText(raw: unknown): string {
  return compactText(raw, MAX_TIMED_MESSAGE_LEN);
}

/** Renders a timed message's stored text, resolving {random:...} and {count}. */
export function renderTimedMessage(response: string, count: number): string {
  let randomBlocks = 0;
  let out = response.replace(/\{random:([^{}]{1,200})\}/gi, (_match, options: string) => {
    randomBlocks++;
    if (randomBlocks > MAX_RANDOM_BLOCKS) return "";
    const choices = options.split("|").map((s) => s.trim()).filter(Boolean);
    return choices.length ? pick(choices) : "";
  });
  out = out.replaceAll("{count}", String(count ?? ""));
  return out;
}

async function requireModerator(display: string, broadcasterId: string, isModerator: boolean) {
  if (isModerator) return true;
  await sendChatMessage(`@${display} only the broadcaster or a moderator can manage timed messages.`, broadcasterId);
  return false;
}

function describeRow(r: any): string {
  const state = Number(r.enabled) ? "on" : "paused";
  const preview = String(r.message ?? "").slice(0, 40);
  return `#${r.id} [${state}, every ${r.interval_minutes}m]: ${preview}${String(r.message ?? "").length > 40 ? "…" : ""}`;
}

/**
 * Handles !timedmsg add/edit/interval/enable/disable/remove/list. Returns
 * false if the message isn't a !timedmsg command at all.
 */
export async function handleTimedMessageCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  if (!/^!timedmsg(?:\s|$)/i.test(chatMessage)) return false;
  const parts = chatMessage.trim().split(/\s+/);
  const action = (parts[1] ?? "").toLowerCase();

  if (action === "list" || action === "") {
    const rows = await listTimedMessages(broadcasterId);
    await sendChatMessages(
      rows.length
        ? `@${display} Timed messages (${rows.length}): ${rows.map(describeRow).join(" || ")}`
        : `@${display} no timed messages yet.${isModerator ? " Add one with !timedmsg add <minutes> <message>." : ""}`,
      broadcasterId,
    );
    return true;
  }

  if (action === "add") {
    if (!(await requireModerator(display, broadcasterId, isModerator))) return true;
    const match = chatMessage.match(/^!timedmsg\s+add\s+(\d+)\s+([\s\S]+)$/i);
    const minutes = match ? parseIntervalMinutes(match[1]) : null;
    const message = match ? sanitizeTimedMessageText(match[2]) : "";
    if (!match || minutes === null) {
      await sendChatMessage(
        `@${display} usage: !timedmsg add <minutes ${MIN_INTERVAL_MINUTES}-${MAX_INTERVAL_MINUTES}> <message>`,
        broadcasterId,
      );
      return true;
    }
    if (!message) {
      await sendChatMessage(`@${display} give the timed message some text, e.g. !timedmsg add 30 Don't forget to follow the guild!`, broadcasterId);
      return true;
    }
    const result = await addTimedMessage(broadcasterId, message, minutes, display);
    if (!result.ok) {
      await sendChatMessage(
        `@${display} this channel's timed message limit (${result.max}) is reached — remove one with !timedmsg remove <id> first.`,
        broadcasterId,
      );
      return true;
    }
    await sendChatMessage(`@${display} added timed message #${result.id}, posting every ${minutes} minute(s).`, broadcasterId);
    return true;
  }

  if (action === "edit") {
    if (!(await requireModerator(display, broadcasterId, isModerator))) return true;
    const match = chatMessage.match(/^!timedmsg\s+edit\s+(\d+)\s+([\s\S]+)$/i);
    const id = match ? Number.parseInt(match[1], 10) : NaN;
    const message = match ? sanitizeTimedMessageText(match[2]) : "";
    if (!match || !message) {
      await sendChatMessage(`@${display} usage: !timedmsg edit <id> <message>`, broadcasterId);
      return true;
    }
    const updated = await editTimedMessage(broadcasterId, id, message);
    await sendChatMessage(
      updated ? `@${display} updated timed message #${id}.` : `@${display} no timed message #${id} in this channel.`,
      broadcasterId,
    );
    return true;
  }

  if (action === "interval") {
    if (!(await requireModerator(display, broadcasterId, isModerator))) return true;
    const id = Number.parseInt(parts[2] ?? "", 10);
    const minutes = parseIntervalMinutes(parts[3]);
    if (!Number.isFinite(id) || minutes === null) {
      await sendChatMessage(
        `@${display} usage: !timedmsg interval <id> <minutes ${MIN_INTERVAL_MINUTES}-${MAX_INTERVAL_MINUTES}>`,
        broadcasterId,
      );
      return true;
    }
    const updated = await setTimedMessageInterval(broadcasterId, id, minutes);
    await sendChatMessage(
      updated ? `@${display} timed message #${id} now posts every ${minutes} minute(s).` : `@${display} no timed message #${id} in this channel.`,
      broadcasterId,
    );
    return true;
  }

  if (action === "enable" || action === "disable") {
    if (!(await requireModerator(display, broadcasterId, isModerator))) return true;
    const id = Number.parseInt(parts[2] ?? "", 10);
    if (!Number.isFinite(id)) {
      await sendChatMessage(`@${display} usage: !timedmsg ${action} <id>`, broadcasterId);
      return true;
    }
    const updated = await setTimedMessageEnabled(broadcasterId, id, action === "enable");
    await sendChatMessage(
      updated
        ? `@${display} timed message #${id} is now ${action === "enable" ? "active" : "paused"}.`
        : `@${display} no timed message #${id} in this channel.`,
      broadcasterId,
    );
    return true;
  }

  if (action === "remove" || action === "delete") {
    if (!(await requireModerator(display, broadcasterId, isModerator))) return true;
    const id = Number.parseInt(parts[2] ?? "", 10);
    if (!Number.isFinite(id)) {
      await sendChatMessage(`@${display} usage: !timedmsg remove <id>`, broadcasterId);
      return true;
    }
    const removed = await deleteTimedMessage(broadcasterId, id);
    await sendChatMessage(
      removed ? `@${display} removed timed message #${id}.` : `@${display} no timed message #${id} in this channel.`,
      broadcasterId,
    );
    return true;
  }

  await sendChatMessage(
    `@${display} Timed messages: !timedmsg add <minutes> <message> | !timedmsg edit <id> <message> | !timedmsg interval <id> <minutes> | !timedmsg enable/disable <id> | !timedmsg remove <id> | !timedmsg list — all but list are mod-only`,
    broadcasterId,
  );
  return true;
}

// The shot counter — how many shots (the drinking kind) the streamer has
// taken this stream. Mods pour, everyone can look, and the OBS "Shots"
// overlay (overlay.ts, panel=shots) shows the running count.
//
//   !shot                 add one shot (mod/broadcaster)
//   !shot +N / !shot -N   add or take away N (mod)
//   !shot undo            take the last one back (mod)
//   !shot set N           set the count (mod)
//   !shot reset           back to 0 (mod)
//   !shots                this stream's count (anyone)
//
// A non-mod's !shot just answers with the count, so viewers can't pad it.
// The count starts over at 0 whenever a new stream goes live
// (stream_status.ts), but not on a reconnect inside the grace period.
// Mod-only with no dashboard switch, like !checklist.

import { sqlite } from "./sqlite.ts";
import { sendChatMessage } from "./twitch.ts";
import { pick } from "./utils.ts";

export const MAX_SHOTS = 999;

export async function ensureShotTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS shot_counter (
      broadcaster_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    )`,
  );
}

export async function getShotCount(broadcasterId: string): Promise<number> {
  const res = await sqlite.execute("SELECT count FROM shot_counter WHERE broadcaster_id = ?", [broadcasterId]);
  return Number(res.rows[0]?.count ?? 0);
}

/** Adds `delta` (negative to take away), kept within 0..MAX_SHOTS. Returns the new count. */
export async function adjustShots(broadcasterId: string, delta: number): Promise<number> {
  await sqlite.execute(
    `INSERT INTO shot_counter (broadcaster_id, count, updated_at)
     VALUES (?, MIN(?, MAX(0, ?)), ?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET
       count = MIN(?, MAX(0, count + ?)),
       updated_at = excluded.updated_at`,
    [broadcasterId, MAX_SHOTS, delta, Date.now(), MAX_SHOTS, delta],
  );
  return getShotCount(broadcasterId);
}

export async function setShots(broadcasterId: string, count: number): Promise<number> {
  const n = Math.min(MAX_SHOTS, Math.max(0, Math.floor(count)));
  await sqlite.execute(
    `INSERT INTO shot_counter (broadcaster_id, count, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`,
    [broadcasterId, n, Date.now()],
  );
  return n;
}

/** stream.online (stream_status.ts): a new stream starts at 0. */
export async function resetShotsForNewStream(broadcasterId: string): Promise<void> {
  await setShots(broadcasterId, 0).catch(() => {});
}

export async function purgeShotData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM shot_counter WHERE broadcaster_id = ?", [broadcasterId]);
}

const plural = (n: number) => `${n} shot${n === 1 ? "" : "s"}`;

const POUR_LINES = [
  (n: number) => `🥃 Down the hatch! That's ${plural(n)} this stream.`,
  (n: number) => `🥃 The barkeep pours another — ${plural(n)} and counting.`,
  (n: number) => `🥃 Bottoms up! Shot #${n} of the night.`,
  (n: number) => `🥃 A toast to the guild! ${plural(n)} so far.`,
];

/** Handles !shot / !shots; returns true when the message was one of them. */
export async function handleShotCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!(shots?)(?:\s+(.*))?$/i);
  if (!m) return false;
  const word = m[1].toLowerCase();
  const arg = (m[2] ?? "").trim().toLowerCase();

  if (word === "shots" || !isModerator) {
    const n = await getShotCount(broadcasterId);
    const tail = word === "shot" && !isModerator ? " (only the broadcaster or a moderator can pour one)" : "";
    await sendChatMessage(`@${display} 🥃 ${plural(n)} taken this stream.${tail}`, broadcasterId);
    return true;
  }

  if (!arg) {
    await sendChatMessage(pick(POUR_LINES)(await adjustShots(broadcasterId, 1)), broadcasterId);
    return true;
  }
  if (arg === "undo") {
    const n = await adjustShots(broadcasterId, -1);
    await sendChatMessage(`@${display} 🥃 Took one back — ${plural(n)} this stream.`, broadcasterId);
    return true;
  }
  if (arg === "reset") {
    await setShots(broadcasterId, 0);
    await sendChatMessage(`@${display} 🥃 Shot counter reset to 0.`, broadcasterId);
    return true;
  }
  const delta = arg.match(/^([+-])\s*(\d{1,3})$/);
  if (delta) {
    const n = await adjustShots(broadcasterId, (delta[1] === "-" ? -1 : 1) * Number(delta[2]));
    await sendChatMessage(`@${display} 🥃 ${plural(n)} this stream.`, broadcasterId);
    return true;
  }
  const set = arg.match(/^set\s+(\d{1,3})$/);
  if (set) {
    const n = await setShots(broadcasterId, Number(set[1]));
    await sendChatMessage(`@${display} 🥃 Shot counter set to ${n}.`, broadcasterId);
    return true;
  }
  await sendChatMessage(`@${display} usage: !shot | !shot +N / -N | !shot undo | !shot set N | !shot reset | !shots`, broadcasterId);
  return true;
}

// The shot counter (shots.ts) switches itself on from the stream title: a
// title with the channel's shots.titleWord ("drunk" by default — "drunk
// hollow knight") turns the counter on, and once the title stops saying it,
// the counter goes back off — but only if GuildScribe was the one that turned
// it on. shots.titleWord "off" turns this off.
//
// A person flipping the switch by hand (dashboard, !feature shots on/off,
// Mod center) wins for the rest of that stream: db.ts setCommandGroupEnabled
// records it in shot_title_auto.manual, and this leaves the switch alone
// until the next stream starts (onShotTitleStreamOnline clears it).
//
// Checked when a stream goes live (stream_status.ts) and every 2 minutes
// while live (server.ts), so a mid-stream title change is picked up. The
// title comes from Helix Get Channel Information (twitch.ts getChannelInfo).

import { sqlite } from "./sqlite.ts";
import { getChannelInfo, sendChatMessage } from "./twitch.ts";
import { isChannelBlocked, isChannelEnabled, isCommandGroupEnabled, setCommandGroupEnabled } from "./db.ts";
import { optWord } from "./channel_options.ts";
import { shotWords } from "./shots.ts";

/** Whether the title has `word` as a whole word ("#Drunk", "DRUNK!" count; "drunken" doesn't). */
export function titleHasWord(title: string, word: string): boolean {
  const norm = ` ${title.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
  return !!word && norm.includes(` ${word.toLowerCase()} `);
}

type AutoState = { autoOn: boolean; manual: "on" | "off" | null };

async function getState(broadcasterId: string): Promise<AutoState> {
  const { rows } = await sqlite.execute("SELECT auto_on, manual FROM shot_title_auto WHERE broadcaster_id = ?", [broadcasterId]);
  const r = (rows as any[])[0];
  const manual = r?.manual === "on" || r?.manual === "off" ? r.manual : null;
  return { autoOn: Number(r?.auto_on ?? 0) === 1, manual };
}

async function setAutoOn(broadcasterId: string, autoOn: boolean) {
  await sqlite.execute(
    `INSERT INTO shot_title_auto (broadcaster_id, auto_on) VALUES (?, ?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET auto_on = excluded.auto_on`,
    [broadcasterId, autoOn ? 1 : 0],
  );
}

/** What to do, given the title match, the switch, and who last touched it. */
export function decide(match: boolean, shotsOn: boolean, s: AutoState): "on" | "off" | null {
  if (match && !shotsOn && s.manual !== "off") return "on";
  if (!match && shotsOn && s.autoOn && s.manual !== "on") return "off";
  return null;
}

/** Checks one channel's title and flips the shot counter if it should. */
export async function checkShotTitle(broadcasterId: string, title?: string): Promise<void> {
  const word = (await optWord(broadcasterId, "shots.titleWord")).toLowerCase();
  if (!word || word === "off") return;
  if (title === undefined) {
    const info = await getChannelInfo(broadcasterId);
    if (!info) return; // Twitch didn't answer; try again next tick
    title = info.title;
  }
  const [shotsOn, state] = await Promise.all([isCommandGroupEnabled(broadcasterId, "shots"), getState(broadcasterId)]);
  const action = decide(titleHasWord(title, word), shotsOn, state);
  if (!action) return;

  await setCommandGroupEnabled(broadcasterId, "shots", action === "on", { auto: true });
  await setAutoOn(broadcasterId, action === "on");
  console.log(`[shots] ${broadcasterId}: title ${action === "on" ? "says" : "no longer says"} "${word}" — shot counter ${action}.`);
  if (!(await isChannelEnabled(broadcasterId)) || (await isChannelBlocked(broadcasterId))) return;
  const w = await shotWords(broadcasterId);
  await sendChatMessage(
    action === "on"
      ? `🥃 The title says "${word}", so the ${w.one} counter is on! Mods add one with !${w.one}, anyone can check with !${w.many}. (Mods: !feature shots off to turn it off.)`
      : `🥃 The title doesn't say "${word}" any more, so the ${w.one} counter is off.`,
    broadcasterId,
  );
}

/** stream.online: a new stream forgets last stream's manual choice, then checks the title. */
export async function onShotTitleStreamOnline(broadcasterId: string): Promise<void> {
  await sqlite.execute("UPDATE shot_title_auto SET manual = NULL, manual_at = NULL WHERE broadcaster_id = ?", [broadcasterId]);
  await checkShotTitle(broadcasterId);
}

/** Every 2 minutes (server.ts): every live channel's title. */
export async function runShotTitleCheck(): Promise<void> {
  const { rows } = await sqlite.execute(`SELECT broadcaster_id FROM broadcasters WHERE is_live = 1 AND connected = 1`);
  for (const r of rows as any[]) {
    try {
      await checkShotTitle(String(r.broadcaster_id));
    } catch (e) {
      console.error(`shot title check failed for ${r.broadcaster_id}:`, e);
    }
  }
}

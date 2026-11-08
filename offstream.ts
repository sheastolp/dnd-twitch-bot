// The off-stream invite: GuildScribe stays quiet for viewers while a channel
// is offline (main.ts). The first time a viewer tries a command there while
// it's offline, the bot whispers them, once ever, that their adventure can
// go on off stream in Wake in Verrowen on Tavernworks.
//
// "Once" is per viewer across every channel, kept in the database so a
// restart doesn't send it again. The row is written before the whisper is
// sent, so a viewer who blocks whispers isn't retried on every command.

import { sqlite } from "./sqlite.ts";
import { getBroadcaster, getCharacter } from "./db.ts";
import { sendWhisperParts, WHISPER_MAX } from "./whisper.ts";
import { splitChatMessage } from "./utils.ts";

export const VERROWEN_URL = "https://tavernworks.dev/verrowen/";

export async function ensureOffstreamTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS offstream_invites (
      user_id TEXT PRIMARY KEY,
      broadcaster_id TEXT NOT NULL,
      sent_at INTEGER NOT NULL
    )`,
  );
}

/** The whisper itself. `hero` is "your Elf Wizard" when they have a character there. */
export function offstreamInviteText(channel: string, hero: string | null): string {
  const who = hero ? `${hero} doesn't` : "your adventure doesn't";
  return `📜 ${channel} is offline, so the guild hall is quiet until the next stream. But ${who} have to wait: ` +
    `continue off stream in Wake in Verrowen on Tavernworks, ${VERROWEN_URL} (I'll only mention this once.)`;
}

/** Whispers the off-stream invite if this viewer has never had it. Never throws. */
export async function maybeOffstreamInvite(userId: string, login: string, broadcasterId: string): Promise<void> {
  try {
    const res = await sqlite.execute(
      "INSERT OR IGNORE INTO offstream_invites (user_id, broadcaster_id, sent_at) VALUES (?, ?, ?)",
      [userId, broadcasterId, Date.now()],
    );
    if (!res.rowsAffected) return;
    const [b, c]: any[] = await Promise.all([
      getBroadcaster(broadcasterId),
      getCharacter(login.toLowerCase(), broadcasterId).catch(() => null),
    ]);
    const channel = String(b?.display_name || b?.login || "The stream");
    const hero = c?.race && c?.cls ? `your ${c.race} ${c.cls}` : null;
    const text = offstreamInviteText(channel, hero);
    await sendWhisperParts(userId, splitChatMessage(text, WHISPER_MAX).filter((p) => p.trim()));
  } catch (e) {
    console.error("offstream invite failed", e);
  }
}

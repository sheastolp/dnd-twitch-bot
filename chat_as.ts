// Sending chat AS the streamer, for things they trigger by voice (voice
// Pokéball throws in pokeball.ts, !join / !rally in voice_commands.ts): the
// message has to come from their account, not GuildScribe's, so other bots
// and games count it as theirs.
//
// Uses the broadcaster's own token (stored on /connect in
// broadcaster_ad_tokens, refreshed by ads.ts getValidAdToken), which needs
// the optional user:write:chat permission. Without it, chat is told (at most
// every NO_TOKEN_WARN_MS) that the streamer should reconnect.

import { getBroadcasterAdToken } from "./ads_db.ts";
import { getValidAdToken } from "./ads.ts";
import { sendChatMessage, sendChatMessageAsBroadcaster } from "./twitch.ts";

/** The Twitch permission sending chat as the streamer needs. */
export const CHAT_AS_SCOPE = "user:write:chat";
/** At most one "I need permission" message per channel this often. */
const NO_TOKEN_WARN_MS = 30 * 60_000;
const lastNoTokenWarn = new Map<string, number>();

/** Whether the streamer granted the permission to send chat as them. */
export async function hasChatAsScope(broadcasterId: string): Promise<boolean> {
  const row = await getBroadcasterAdToken(broadcasterId).catch(() => null);
  return !!row && String(row.scope ?? "").split(/\s+/).includes(CHAT_AS_SCOPE);
}

/** "reconnect" advice for a status line, or null when the permission is there. */
export async function chatAsProblem(broadcasterId: string): Promise<string | null> {
  return (await hasChatAsScope(broadcasterId))
    ? null
    : `the streamer needs to reconnect on /connect and allow "${CHAT_AS_SCOPE}" so I can type it as them`;
}

/**
 * Sends `message` in chat as the streamer. "sent" when Twitch posted it,
 * "no-permission" when there's no user:write:chat (chat gets `warning`, at
 * most every 30 min), "refused" when Twitch didn't post it.
 */
export async function sendAsStreamer(broadcasterId: string, message: string, warning: string): Promise<"sent" | "no-permission" | "refused"> {
  const token = (await hasChatAsScope(broadcasterId)) ? await getValidAdToken(broadcasterId) : null;
  if (!token) {
    const now = Date.now();
    if (now - (lastNoTokenWarn.get(broadcasterId) ?? 0) >= NO_TOKEN_WARN_MS) {
      lastNoTokenWarn.set(broadcasterId, now);
      await sendChatMessage(`${warning} The streamer needs to reconnect on /connect and allow "${CHAT_AS_SCOPE}".`, broadcasterId);
    }
    return "no-permission";
  }
  return (await sendChatMessageAsBroadcaster(token, broadcasterId, message)) ? "sent" : "refused";
}

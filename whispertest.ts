// !whispertest (mod/broadcaster): whispers the caller a test message and
// reports Twitch's answer in chat, so a broken whisper setup (no bot token,
// missing scope, unverified phone, blocked whispers…) says exactly why.
// Full setup state: GET /connect-bot/status.

import { sendChatMessage } from "./twitch.ts";
import { explainWhisperFailure, sendWhisperPartsDetailed } from "./whisper.ts";

export async function handleWhisperTestCommand(
  chatMessage: string,
  chatterId: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
  baseUrl: string,
): Promise<boolean> {
  if (!/^!whispertest$/i.test(chatMessage.trim())) return false;
  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can run the whisper test.`, broadcasterId);
    return true;
  }
  const r = await sendWhisperPartsDetailed(chatterId, ["📜 GuildScribe whisper test — if you can read this, whispers work!"]);
  await sendChatMessage(
    r.ok
      ? `@${display} ✅ whisper sent — check your whispers. If nothing arrived, check your Twitch whisper settings.`
      : `@${display} ❌ whisper failed: ${explainWhisperFailure(r)}. Details: ${baseUrl}/connect-bot/status`,
    broadcasterId,
  );
  return true;
}

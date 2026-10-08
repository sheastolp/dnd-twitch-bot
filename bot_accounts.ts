// GuildScribe — which chat accounts are bots. Bots are left out everywhere
// the bot talks about real viewers: they never run commands, earn gold or
// watch time, get picked by !oracle, get thanked for subs/raids, show up in
// !botcheck counts, or play The Endless Delve.
//
// An account counts as a bot when ANY of these is true:
//   • it's GuildScribe itself (TWITCH_BOT_ID)
//   • its login ends in "bot" (nightbot, sery_bot, …)
//   • it's in KNOWN_BOT_ACCOUNTS or MY_BOT_ACCOUNTS below
//   • it's in the optional BOT_USERNAMES env var (comma-separated)

// ─── Add your own bots here ─────────────────────────────────────────────
// Twitch login names (the name in the channel URL), lowercase, one per line,
// in quotes with a comma after each. Example:
//   export const MY_BOT_ACCOUNTS = [
//     "kofistreambot",
//     "some_helper",
//   ];
export const MY_BOT_ACCOUNTS: string[] = [
];
// ─────────────────────────────────────────────────────────────────────────

/** Common chat bots, recognized out of the box. */
export const KNOWN_BOT_ACCOUNTS: string[] = [
  "nightbot",
  "streamelements",
  "streamlabs",
  "moobot",
  "fossabot",
  "wizebot",
  "deepbot",
  "coebot",
  "ankhbot",
  "soundalerts",
  "botrixoficial",
  "pokemoncommunitygame",
];

/** Every listed bot login (both lists plus BOT_USERNAMES), lowercase. */
export function listedBotAccounts(): string[] {
  const fromEnv = (Deno.env.get("BOT_USERNAMES") ?? "").split(",");
  return [...new Set([...KNOWN_BOT_ACCOUNTS, ...MY_BOT_ACCOUNTS, ...fromEnv].map((x) => x.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
}

export function isBotAccount(username: string, userId: string, botUserId: string): boolean {
  const normalized = username.toLowerCase();
  return (Boolean(userId) && userId === botUserId) || normalized.endsWith("bot") || listedBotAccounts().includes(normalized);
}

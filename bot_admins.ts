// Bot admins — Twitch logins with every privilege GuildScribe has, in every
// connected channel, whether or not they hold a role there:
//   • chat: counted as a moderator for every command (main.ts isModerator),
//     which also exempts them from auto-ban / auto-mod
//   • web dashboard: let in to any connected channel's dashboard, and the
//     login-first picker (/dashboard/start) lists every connected channel
//   • merchant sales: may post in any connected channel
//   • operator pages: /admin/* opens after a Twitch login at /admin/login,
//     no ADMIN_API_SECRET needed (operator_auth.ts)
//
// Logins are lowercase. Twitch logins come from Twitch itself (EventSub
// chatter_user_login, or the OAuth viewer identity), so they can't be faked
// from chat. Removing a name here revokes everything on the next restart,
// including an open /admin session.

const BOT_ADMIN_LOGINS = new Set(["stonedsheamus"]);

export function isBotAdminLogin(login: string | null | undefined): boolean {
  return !!login && BOT_ADMIN_LOGINS.has(login.toLowerCase());
}

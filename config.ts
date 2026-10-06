// Shared runtime configuration.

// Public URL for this val (guildscribe.tavernworks.dev). Used for chat links
// AND for every URL handed to Twitch (OAuth redirect_uri, EventSub callbacks),
// so connecting always lands on the custom domain no matter which host the
// request came in on (guildscribe.val.run, or a proxy that forwards to it).
export const PUBLIC_BASE_URL = Deno.env.get("PUBLIC_BASE_URL") ?? "https://guildscribe.tavernworks.dev";
/** PUBLIC_BASE_URL normalized to scheme://host (no trailing slash/path). */
export const PUBLIC_ORIGIN = new URL(PUBLIC_BASE_URL).origin;

// Shared runtime configuration.

// Public HTTP trigger URL for this val (used for guide links in chat).
// OAuth redirects and character page links still use the request origin dynamically.
export const PUBLIC_BASE_URL = Deno.env.get("PUBLIC_BASE_URL") ?? "https://guildscribe.val.run";

// The browser-tab icon for every GuildScribe page: the bot account's own
// Twitch profile picture (TWITCH_BOT_ID, else TWITCH_BOT_LOGIN), looked up
// with Helix Get Users on the app token and served from /favicon.ico and
// /favicon.png (scroll_theme.ts's SCROLL_HEAD links the latter). Without a
// route of its own, /favicon.ico fell through to an HTML page and the tab
// showed whatever icon the browser had on hand (Cloudflare's). The image is kept in memory for a day; while Twitch can't
// be reached the route answers 404 with no-store so a miss isn't cached.

import { env, getAppToken } from "./twitch.ts";

export const FAVICON_PATHS = new Set(["/favicon.ico", "/favicon.png"]);

const TTL_MS = 24 * 60 * 60_000;
let cached: { body: ArrayBuffer; type: string; at: number } | null = null;

async function fetchAvatar(): Promise<{ body: ArrayBuffer; type: string } | null> {
  const id = Deno.env.get("TWITCH_BOT_ID")?.trim();
  const login = (Deno.env.get("TWITCH_BOT_LOGIN") ?? "guildscribebot").trim().replace(/^@/, "").toLowerCase();
  const query = id ? `id=${encodeURIComponent(id)}` : `login=${encodeURIComponent(login)}`;
  const res = await fetch(`https://api.twitch.tv/helix/users?${query}`, {
    headers: { Authorization: `Bearer ${await getAppToken()}`, "Client-Id": env("TWITCH_CLIENT_ID") },
  });
  if (!res.ok) return null;
  const url = String((await res.json())?.data?.[0]?.profile_image_url ?? "");
  if (!url) return null;
  const img = await fetch(url);
  if (!img.ok) return null;
  return { body: await img.arrayBuffer(), type: img.headers.get("Content-Type") ?? "image/png" };
}

export async function handleFavicon(): Promise<Response> {
  if (!cached || Date.now() - cached.at > TTL_MS) {
    try {
      const fresh = await fetchAvatar();
      if (fresh) cached = { ...fresh, at: Date.now() };
    } catch { /* keep serving the old copy, if any */ }
  }
  if (!cached) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(cached.body, { headers: { "Content-Type": cached.type, "Cache-Control": "public, max-age=86400" } });
}

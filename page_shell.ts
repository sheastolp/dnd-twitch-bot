// The shared HTML shell for every web page. Its own module so pages.ts and
// dashboard_page.ts can both use it without importing each other.

import { SCROLL_CSS, SCROLL_HEAD, scrollClose, scrollOpen } from "./scroll_theme.ts";

/** `head` is extra trusted markup for <head> (meta description, canonical…). */
export function page(title: string, body: string, head = "") {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">${SCROLL_HEAD}${head}<title>${title}</title><style>${SCROLL_CSS}</style></head><body>${scrollOpen()}${body}${scrollClose}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// The shared HTML shell for every web page. Its own module so pages.ts and
// dashboard_page.ts can both use it without importing each other.

export function page(title: string, body: string) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:sans-serif;max-width:700px;margin:40px auto;background:#1a1a1a;color:#eee;padding:24px}a,button{background:#9147ff;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;border:0;font-size:1rem}h1{color:#ffd700}</style></head><body>${body}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

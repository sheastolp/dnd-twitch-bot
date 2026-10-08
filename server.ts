// GuildScribe — the always-on process on the Yoga laptop.
//
// Serves main.ts's HTTP handler (EventSub webhooks, OAuth, dashboard, overlays,
// guide) on 127.0.0.1:PORT, where the Cloudflare Tunnel delivers
// guildscribe.tavernworks.dev, and runs the four scheduled jobs that used to
// be Val Town cron triggers.
//
//   deno task start    (see deno.json; the systemd unit runs the same thing)

import handler from "./main.ts";
import runMerchant from "./merchant_cron.ts";
import runTimedMessages from "./timedmessages_cron.ts";
import runAutohunt from "./autohunt_cron.ts";
import runWatchtime from "./watchtime_cron.ts";
import { PUBLIC_ORIGIN } from "./config.ts";

const PORT = Number(Deno.env.get("PORT") || 8801);
const HOST = Deno.env.get("HOST") || "127.0.0.1";

/** Runs `job` every `minutes`, never two at once; a failure is logged and the next tick tries again. */
function every(name: string, minutes: number, job: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await job();
    } catch (e) {
      console.error(`${name} failed:`, e);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 30_000); // first run shortly after start-up
  setInterval(tick, minutes * 60_000);
}

const cronMinutes = (name: string, fallback: number) => Number(Deno.env.get(name) || fallback);
every("merchant_cron", cronMinutes("MERCHANT_CRON_MINUTES", 5), () => runMerchant());
every("timedmessages_cron", cronMinutes("TIMEDMESSAGES_CRON_MINUTES", 5), () => runTimedMessages());
every("autohunt_cron", cronMinutes("AUTOHUNT_CRON_MINUTES", 5), () => runAutohunt());
every("watchtime_cron", cronMinutes("WATCHTIME_CRON_MINUTES", 5), () => runWatchtime());

Deno.serve({ port: PORT, hostname: HOST }, (req) => {
  // The tunnel hands requests over as plain http://127.0.0.1; give the handler
  // the public https URL the visitor actually used.
  const url = new URL(req.url);
  const publicUrl = new URL(url.pathname + url.search, PUBLIC_ORIGIN);
  return handler(new Request(publicUrl, req));
});

// !wow:forever — countdown to the launch of World of Warcraft: Forever.
//
// Standalone, no DB or external API. Launch time per Blizzard's
// announcement: November 4, 2026 at 3:00 PM PST (23:00 UTC).

export const WOW_FOREVER_LAUNCH = Date.UTC(2026, 10, 4, 23, 0, 0);

/** "9d 4h 12m", dropping leading zero units; minutes always shown. */
function formatSpan(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (d || h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

/** One chat message: time left until launch, or how long it's been live. */
export function wowForeverCountdown(display: string, now = Date.now()): string {
  const left = WOW_FOREVER_LAUNCH - now;
  if (left > 60_000) {
    return `@${display} ⏳ World of Warcraft: Forever launches in ${formatSpan(left)} — Nov 4, 2026 at 3:00 PM PST (23:00 UTC).`;
  }
  if (left > 0) return `@${display} ⏳ World of Warcraft: Forever launches in under a minute! Get those launchers open!`;
  const live = now - WOW_FOREVER_LAUNCH;
  if (live < 86_400_000) return `@${display} 🎉 World of Warcraft: Forever is LIVE — launched ${formatSpan(live)} ago. Go go go!`;
  const days = Math.floor(live / 86_400_000);
  return `@${display} 🎉 World of Warcraft: Forever is live — it launched ${days} day${days === 1 ? "" : "s"} ago (Nov 4, 2026).`;
}

// GuildScribe — Val Town's std/sqlite with a short retry on transient failures.
//
// When the SQLite service answers with an HTTP error (rate limited, briefly
// overloaded), the libSQL client inside std/sqlite trips over the response
// and throws `TypeError: resp.body?.cancel is not a function` instead of the
// real error. Without a retry, that one blip fails the whole request — a chat
// command, an EventSub message, an overlay poll. Request-level HTTP errors
// come back before any statement runs, so trying again is safe.
//
// SQL errors (constraint, missing table, syntax) are never retried: they'd
// fail the same way again, and callers such as invalidateSchemaOnMissingTable
// in main.ts rely on seeing them straight away.
//
// Every module imports `sqlite` from here instead of from std/sqlite directly.

import { sqlite as raw } from "https://esm.town/v/std/sqlite/main.ts";

const RETRY_DELAYS_MS = [250, 800];

/** Errors that mean the service didn't take the request, not that the SQL was wrong. */
export function isTransientDbError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e);
  return /body\?\.cancel is not a function|\b(429|502|503|504)\b|too many requests|rate limit|service unavailable|bad gateway|gateway timeout/i.test(msg);
}

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientDbError(e)) throw e;
      const wait = RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 150);
      console.warn(`sqlite: transient error, retrying in ${wait} ms (${String((e as any)?.message ?? e).slice(0, 120)})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export const sqlite = {
  execute: ((...args: Parameters<typeof raw.execute>) => withRetry(() => raw.execute(...args))) as typeof raw.execute,
  batch: ((...args: Parameters<typeof raw.batch>) => withRetry(() => raw.batch(...args))) as typeof raw.batch,
};

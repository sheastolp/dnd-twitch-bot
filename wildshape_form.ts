// A Druid's active !wildshape form, for fights. getCharacter (db.ts) attaches
// it as `wildForm`, and combat_abilities.ts fights with it. Kept apart from
// wildshape.ts, which itself loads characters through db.ts.

import { sqlite } from "./sqlite.ts";
import type { WildForm } from "./types.ts";

/** The form `username` is in right now, or null (none, worn off, or no table yet). */
export async function activeWildForm(broadcasterId: string, username: string, now = Date.now()): Promise<WildForm | null> {
  try {
    const res = await sqlite.execute(
      "SELECT form, form_until, form_fight FROM wild_shapes WHERE broadcaster_id = ? AND username = ?",
      [broadcasterId, username],
    );
    const r: any = res.rows[0];
    if (!r?.form || !r.form_fight || Number(r.form_until) <= now) return null;
    return JSON.parse(String(r.form_fight));
  } catch {
    return null;
  }
}

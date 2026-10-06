// GuildScribe — the saving throws tally. Every saving throw rolled in chat
// (`!roll dex`, `!roll @user wis`, optionally against a DC: `!roll dex dc15`
// or `!roll dex 15`) is logged here, and the theme's Be right back and Just
// chatting scenes show this stream's tally under their card: saved / failed
// for each ability, plus the latest roll (overlay_scenes.ts).
//
// A roll saves when its total meets the DC (DEFAULT_DC when chat didn't name
// one). "This stream" starts on stream.online, or when a mod types
// `!saves reset`; before either has happened the tally covers FALLBACK_MS.
// `!saves` posts the tally in chat. Both ride on the `rollchecks` dashboard
// switch (Saves & skill checks), which also hides the overlay tally.
//
// Never throws from recordSavingThrow — bookkeeping must not break a roll.

import { sqlite } from "./sqlite.ts";
import { abilityNames } from "./data.ts";
import type { Ability } from "./types.ts";

export const DEFAULT_DC = 10;
const FALLBACK_MS = 12 * 3_600_000;
/** Older rows are pruned now and then; the tally never looks back this far. */
const KEEP_MS = 7 * 86_400_000;
const lastPrune = new Map<string, number>();

export async function ensureSavingThrowTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS saving_throw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, broadcaster_id TEXT NOT NULL, username TEXT NOT NULL,
      display_name TEXT NOT NULL, ability TEXT NOT NULL, raw INTEGER NOT NULL, total INTEGER NOT NULL,
      dc INTEGER NOT NULL, created_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS saving_throw_events_channel ON saving_throw_events (broadcaster_id, created_at)`);
  await sqlite.execute(`CREATE TABLE IF NOT EXISTS saving_throw_settings (broadcaster_id TEXT PRIMARY KEY, since INTEGER NOT NULL)`);
}

const missingTable = (e: unknown) => /no such table/i.test(String((e as any)?.message ?? e));

async function withTable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!missingTable(e)) throw e;
    await ensureSavingThrowTables();
    return await run();
  }
}

/** Logs one saving throw. `who` is whose save it was (the @target when rolled for someone). */
export async function recordSavingThrow(
  broadcasterId: string,
  who: { username: string; displayName: string },
  ability: Ability,
  raw: number,
  total: number,
  dc: number,
): Promise<void> {
  try {
    const now = Date.now();
    await withTable(() =>
      sqlite.execute(
        "INSERT INTO saving_throw_events (broadcaster_id, username, display_name, ability, raw, total, dc, created_at) VALUES (?,?,?,?,?,?,?,?)",
        [broadcasterId, who.username.toLowerCase(), who.displayName.slice(0, 40), ability, raw, total, dc, now],
      )
    );
    if (now - (lastPrune.get(broadcasterId) ?? 0) < 60 * 60_000) return;
    lastPrune.set(broadcasterId, now);
    await sqlite.execute("DELETE FROM saving_throw_events WHERE broadcaster_id = ? AND created_at < ?", [broadcasterId, now - KEEP_MS]);
  } catch (e) {
    console.error("recordSavingThrow failed", e);
  }
}

/** Starts a fresh tally: on stream.online, and from `!saves reset`. Never throws. */
export async function resetSavingThrowTally(broadcasterId: string, at = Date.now()): Promise<void> {
  try {
    await withTable(() =>
      sqlite.execute(
        "INSERT INTO saving_throw_settings (broadcaster_id, since) VALUES (?, ?) ON CONFLICT(broadcaster_id) DO UPDATE SET since = excluded.since",
        [broadcasterId, at],
      )
    );
  } catch (e) {
    console.error("resetSavingThrowTally failed", e);
  }
}

export type SaveTally = {
  since: number;
  dc: number;
  passed: number;
  failed: number;
  nat20: number;
  nat1: number;
  abilities: Array<{ ability: string; passed: number; failed: number }>;
  latest: { name: string; ability: string; total: number; dc: number; passed: boolean; raw: number } | null;
};

export async function getSavingThrowTally(broadcasterId: string): Promise<SaveTally> {
  return await withTable(async () => {
    const set = await sqlite.execute("SELECT since FROM saving_throw_settings WHERE broadcaster_id = ?", [broadcasterId]);
    const since = Number(set.rows[0]?.since ?? 0) || Date.now() - FALLBACK_MS;
    const [agg, last] = await Promise.all([
      sqlite.execute(
        `SELECT ability, SUM(CASE WHEN total >= dc THEN 1 ELSE 0 END) AS passed, SUM(CASE WHEN total < dc THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN raw = 20 THEN 1 ELSE 0 END) AS nat20, SUM(CASE WHEN raw = 1 THEN 1 ELSE 0 END) AS nat1
         FROM saving_throw_events WHERE broadcaster_id = ? AND created_at >= ? GROUP BY ability`,
        [broadcasterId, since],
      ),
      sqlite.execute(
        "SELECT display_name, ability, raw, total, dc FROM saving_throw_events WHERE broadcaster_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 1",
        [broadcasterId, since],
      ),
    ]);
    const by = new Map((agg.rows as any[]).map((r) => [String(r.ability), r]));
    const out: SaveTally = { since, dc: DEFAULT_DC, passed: 0, failed: 0, nat20: 0, nat1: 0, abilities: [], latest: null };
    for (const ability of abilityNames) {
      const r: any = by.get(ability);
      const passed = Number(r?.passed ?? 0), failed = Number(r?.failed ?? 0);
      out.passed += passed;
      out.failed += failed;
      out.nat20 += Number(r?.nat20 ?? 0);
      out.nat1 += Number(r?.nat1 ?? 0);
      out.abilities.push({ ability: ability.toUpperCase(), passed, failed });
    }
    const l: any = last.rows[0];
    if (l) {
      const total = Number(l.total), dc = Number(l.dc);
      out.latest = { name: String(l.display_name), ability: String(l.ability).toUpperCase(), total, dc, passed: total >= dc, raw: Number(l.raw) };
    }
    return out;
  });
}

/** The tally as one chat line, for `!saves`. */
export function savingThrowTallyText(t: SaveTally): string {
  const n = t.passed + t.failed;
  if (!n) return `🛡️ No saving throws yet this stream — try !roll dex (or !roll wis dc15 against a DC).`;
  const per = t.abilities.filter((a) => a.passed + a.failed).map((a) => `${a.ability} ✔${a.passed} ✘${a.failed}`).join(" | ");
  const crits = t.nat20 || t.nat1 ? ` · 🌟 Nat20 x${t.nat20} · 💀 Nat1 x${t.nat1}` : "";
  return `🛡️ Saving throws this stream: ✔ ${t.passed} saved, ✘ ${t.failed} failed (of ${n})${crits} — ${per}`;
}

export async function purgeSavingThrowData(broadcasterId: string) {
  for (const table of ["saving_throw_events", "saving_throw_settings"]) {
    await sqlite.execute(`DELETE FROM ${table} WHERE broadcaster_id = ?`, [broadcasterId]).catch((e) => {
      if (!missingTable(e)) throw e;
    });
  }
}

// GuildScribe — recent battle results for the OBS battle tracker.
//
// Most fights are auto-resolved in a single message (solo and party hunts,
// auto duels, !autohunt bouts, !hunt, raids, robberies), so they never sit in
// the duels/monster_duels tables the tracker reads for fights under way.
// Each of those endings calls recordBattle, and the tracker shows the last
// few as "Recent battles" (overlay.ts loadRecentBattles).
//
// Kept small: at most KEEP rows per channel, trimmed now and then. Never
// throws — bookkeeping must not break a fight.

import { sqlite } from "./sqlite.ts";

export type BattleKind = "hunt" | "partyhunt" | "autohunt" | "raid" | "duel" | "partyduel" | "rob";
export type BattleOutcome = "win" | "loss" | "retreat";

export type BattleEntry = {
  kind: BattleKind;
  /** The hero, party or (PvP) winner. */
  side: string;
  /** The monster, boss or (PvP) loser. */
  foe: string;
  outcome: BattleOutcome;
  /** Short extra, e.g. "+50 XP" or "took 3 sp". */
  note?: string;
};

const KEEP = 30;
const lastPrune = new Map<string, number>();

export async function ensureBattleLogTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS battle_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, broadcaster_id TEXT NOT NULL, kind TEXT NOT NULL,
      side TEXT NOT NULL, foe TEXT NOT NULL, outcome TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute(`CREATE INDEX IF NOT EXISTS battle_log_channel ON battle_log (broadcaster_id, id)`);
}

const missingTable = (e: unknown) => /no such table/i.test(String((e as any)?.message ?? e));

async function withTable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!missingTable(e)) throw e;
    await ensureBattleLogTables();
    return await run();
  }
}

export async function recordBattle(broadcasterId: string, b: BattleEntry): Promise<void> {
  try {
    await withTable(() =>
      sqlite.execute(
        "INSERT INTO battle_log (broadcaster_id, kind, side, foe, outcome, note, created_at) VALUES (?,?,?,?,?,?,?)",
        [broadcasterId, b.kind, b.side.slice(0, 60), b.foe.slice(0, 60), b.outcome, (b.note ?? "").slice(0, 60), Date.now()],
      )
    );
    const now = Date.now();
    if (now - (lastPrune.get(broadcasterId) ?? 0) < 5 * 60_000) return;
    lastPrune.set(broadcasterId, now);
    await sqlite.execute(
      `DELETE FROM battle_log WHERE broadcaster_id = ? AND id NOT IN
         (SELECT id FROM battle_log WHERE broadcaster_id = ? ORDER BY id DESC LIMIT ${KEEP})`,
      [broadcasterId, broadcasterId],
    );
  } catch (e) {
    console.error("recordBattle failed", e);
  }
}

/** The channel's latest results, newest first, no older than `withinMs`. */
export async function getRecentBattles(
  broadcasterId: string,
  limit: number,
  withinMs: number,
): Promise<Array<BattleEntry & { at: number }>> {
  try {
    const res = await withTable(() =>
      sqlite.execute(
        "SELECT kind, side, foe, outcome, note, created_at FROM battle_log WHERE broadcaster_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?",
        [broadcasterId, Date.now() - withinMs, limit],
      )
    );
    return (res.rows as any[]).map((r) => ({
      kind: String(r.kind) as BattleKind,
      side: String(r.side),
      foe: String(r.foe),
      outcome: String(r.outcome) as BattleOutcome,
      note: r.note ? String(r.note) : undefined,
      at: Number(r.created_at),
    }));
  } catch (e) {
    console.error("getRecentBattles failed", e);
    return [];
  }
}

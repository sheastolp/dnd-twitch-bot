// Shared combat helpers: challenge/idle timeouts, idle-fight forfeits, the
// PvP duel resolver used by duels and !rob.
// Split out of combat.ts (which re-exports it) to keep every file well
// under Val Town's per-file size ceiling.

import { duelNarration } from "./narration.ts";
import { BattleLog, fighterLine, simulateAttack } from "./battle.ts";
import { getCharacter, sqlite } from "./db.ts";
import { sendChatMessage } from "./twitch.ts";

export const withArticle = (name: string) => `${/^[aeiou]/i.test(name) ? "an" : "a"} ${name}`;

// A pending challenge (!dndduel @user / !dndduel party <a> <b>) must be
// accepted within this window or it silently expires — capped at 5 minutes
// regardless of env override so a forgotten challenge never lingers.
export const DUEL_ACCEPT_TIMEOUT_MS = Math.min(
  300_000,
  Math.max(30_000, Number(Deno.env.get("DUEL_ACCEPT_TIMEOUT_MS") ?? "300000")),
);

// Any *active* classic (turn-based) duel — 1v1, party vs party, solo vs
// monster, or party hunt — auto-forfeits to the non-idle side if nobody acts
// for this long. This keeps a duel abandoned mid-stream (or a character
// deleted mid-fight) from blocking that channel's dueling forever until the
// next stream.
export const DUEL_IDLE_TIMEOUT_MS = Math.max(
  60_000,
  Number(Deno.env.get("DUEL_IDLE_TIMEOUT_MS") ?? "600000"),
);

export function isChallengeExpired(createdAt: unknown): boolean {
  return Date.now() - Number(createdAt) > DUEL_ACCEPT_TIMEOUT_MS;
}

export function isDuelIdle(updatedAt: unknown): boolean {
  return Date.now() - Number(updatedAt) > DUEL_IDLE_TIMEOUT_MS;
}

/** Auto-forfeits an idle 1v1 classic duel. Returns true if it forfeited. */
export async function forfeitIfIdleDuel(broadcasterId: string, active: any): Promise<boolean> {
  if (!active || !isDuelIdle(active.updated_at)) return false;
  const idle = active.current_turn;
  const winner = idle === active.challenger ? active.defender : active.challenger;
  await sqlite.execute("DELETE FROM duels WHERE broadcaster_id = ?", [broadcasterId]);
  await sendChatMessage(
    `⌛ The duel between ${active.challenger} and ${active.defender} went idle waiting on ${idle} — ${winner} wins by forfeit! ${duelNarration("victory")}`,
    broadcasterId,
  );
  return true;
}

/** Auto-forfeits an idle solo vs. monster classic duel. */
export async function forfeitIfIdleMonsterDuel(broadcasterId: string, active: any): Promise<boolean> {
  if (!active || !isDuelIdle(active.updated_at)) return false;
  await sqlite.execute("DELETE FROM monster_duels WHERE broadcaster_id = ?", [broadcasterId]);
  await sendChatMessage(
    `⌛ ${active.player}'s duel with ${active.monster_name} went idle too long and was abandoned. The beast melts back into the shadows.`,
    broadcasterId,
  );
  return true;
}

/** Auto-forfeits an idle party vs. party classic duel. */
export async function forfeitIfIdlePartyDuel(broadcasterId: string, active: any): Promise<boolean> {
  if (!active || !isDuelIdle(active.updated_at)) return false;
  const idleMembers = active.current_side === "challenger" ? active.challenger_members : active.defender_members;
  const idleName = idleMembers?.[active.current_index] ??
    (active.current_side === "challenger" ? active.challenger_party : active.defender_party);
  const winnerParty = active.current_side === "challenger" ? active.defender_party : active.challenger_party;
  await sqlite.execute("DELETE FROM party_duels WHERE broadcaster_id = ?", [broadcasterId]);
  await sendChatMessage(
    `⌛ The party duel between ${active.challenger_party} and ${active.defender_party} went idle waiting on ${idleName} — ${winnerParty} wins by forfeit! ${duelNarration("victory")}`,
    broadcasterId,
  );
  return true;
}

/** Auto-forfeits an idle classic party hunt (party vs. shared monster). */
export async function forfeitIfIdlePartyHunt(broadcasterId: string, active: any): Promise<boolean> {
  if (!active || !isDuelIdle(active.updated_at)) return false;
  await sqlite.execute("DELETE FROM party_monster_duels WHERE broadcaster_id = ?", [broadcasterId]);
  await sendChatMessage(
    `⌛ Party ${active.party_name}'s hunt for ${active.monster_name} went idle too long and was abandoned.`,
    broadcasterId,
  );
  return true;
}

export async function duelSummary(d: any) {
  const a = await getCharacter(d.challenger, d.broadcaster_id);
  const b = await getCharacter(d.defender, d.broadcaster_id);
  return `Duel: ${d.challenger} ${d.challenger_hp}/${
    a?.hpMax ?? "?"
  } HP vs ${d.defender} ${d.defender_hp}/${
    b?.hpMax ?? "?"
  } HP. Turn: ${d.current_turn}.`;
}

/** Auto-resolve a 1v1 duel. Returns chat-ready summary lines. Exported so
 * !rob (rob.ts) fights with exactly the same engine as !dndduel. */
export function resolvePlayerDuel(
  aName: string,
  bName: string,
  aChar: any,
  bChar: any,
): { winner: string; log: string; fullLog: string; rounds: number } {
  const hp: Record<string, number> = {
    [aName]: aChar.hpMax,
    [bName]: bChar.hpMax,
  };
  const maxRounds = 20; // 40 swings, same cap as before
  const battle = new BattleLog();
  battle.describe(fighterLine(aName, aChar, aChar.hpMax, 10));
  battle.describe(fighterLine(bName, bChar, bChar.hpMax, 10));
  battle.describe(`${aName} swings first each round; ${bName} answers if still standing.`);
  let rounds = 0;
  while (hp[aName] > 0 && hp[bName] > 0 && rounds < maxRounds) {
    rounds++;
    battle.nextRound();
    // aName always swings first; bName answers if still standing.
    battle.strike(simulateAttack(aName, bName, aChar, bChar, hp));
    if (hp[bName] > 0) {
      battle.strike(simulateAttack(bName, aName, bChar, aChar, hp));
    }
  }
  const winner = hp[aName] > 0 ? aName : bName;
  const shown = battle.render();
  const log = [
    `${aName} (${aChar.hpMax} HP) vs ${bName} (${bChar.hpMax} HP) — auto-resolved in ${rounds} round${
      rounds === 1 ? "" : "s"
    }.`,
    shown,
    `— ${winner} wins! ${duelNarration("victory")} Final: ${aName} ${
      hp[aName]
    }/${aChar.hpMax} HP, ${bName} ${hp[bName]}/${bChar.hpMax} HP.`,
  ].join(" ");
  // fullLog: every round, uncut, for the reply's detail page (replypages.ts).
  return { winner, log, fullLog: log.replace(shown, battle.renderDetailed()), rounds };
}

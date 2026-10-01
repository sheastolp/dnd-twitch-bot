// Shared auto-resolve battle engine for combat.ts (duels, party hunts, !rob)
// and autohunt.ts: the swing-by-swing chat log (BattleLog) and the solo
// hero-vs-monster fight (simulateMonsterFight). Split out of combat.ts, which
// is close to Val Town's per-file size ceiling (a push with an oversized file
// is rejected and the deploy silently stays on old code).

import { combatStats } from "./utils.ts";

// Auto solo monster duels (bare !dndduel / !dndduel <name>) are decided by the
// actual dice, not a fixed win rate: the odds come from the real matchup
// (character vs. the level-scaled monster), so a goblin is a fair bet for a
// novice, a dragon is a death wish, and every fight can still turn on a
// natural 20. The only nudge fate gives is FATE_STAYS_HAND below.
//
// Once per fight, when a blow would drop the hero to 0 HP, they roll a d20;
// this number or higher and fate stays its hand, leaving them on 1 HP.
const FATE_STAYS_HAND_DC = 18;

// ---------------------------------------------------------------------------
// Auto-resolve battle log
//
// Every auto-resolved fight (solo monster duel, party hunt, PvP duel, party
// duel, !rob) records its swings through this one helper so chat reads the
// same way everywhere: who swung at whom, whether it landed (roll vs AC),
// how much it did, and how much HP the target has left. Swings are grouped
// into numbered rounds, and any rounds trimmed for chat length are shown as
// an explicit "…R4–R7…" gap instead of silently vanishing.
// ---------------------------------------------------------------------------

/** One resolved swing. */
interface Strike {
  actor: string;
  target: string;
  hit: boolean;
  crit: boolean;
  fumble: boolean; // natural 1
  roll: number; // raw d20
  total: number; // roll + bonuses
  ac: number; // what it had to beat
  damage: number;
  targetHp: number; // HP after the blow
  targetMax: number;
}

function fmtStrike(s: Strike): string {
  const check = `${s.total} vs AC ${s.ac}`;
  if (s.fumble) return `${s.actor} fumbles (nat 1)`;
  if (!s.hit) return `${s.actor} misses ${s.target} [${check}]`;
  const verb = s.crit ? "💥 CRITS" : "hits";
  const tail = s.targetHp <= 0
    ? ` — ${s.target} falls!`
    : ` (${s.target} ${s.targetHp}/${s.targetMax} HP)`;
  return `${s.actor} ${verb} ${s.target} [${s.crit ? "nat 20" : check}] for ${s.damage}${tail}`;
}

export class BattleLog {
  private rounds: { lines: string[]; notable: boolean }[] = [];

  /** Start a new round (call once per round, before its first swing). */
  nextRound() {
    this.rounds.push({ lines: [], notable: false });
  }

  get roundCount() {
    return this.rounds.length;
  }

  /** Record a swing. Crits, fumbles and knockouts mark the round notable. */
  strike(s: Strike) {
    if (!this.rounds.length) this.nextRound();
    const r = this.rounds[this.rounds.length - 1];
    r.lines.push(fmtStrike(s));
    if (s.crit || s.fumble || s.targetHp <= 0) r.notable = true;
  }

  /** Record a free-form event line (e.g. fate intervening). */
  note(line: string, notable = true) {
    if (!this.rounds.length) this.nextRound();
    const r = this.rounds[this.rounds.length - 1];
    r.lines.push(line);
    if (notable) r.notable = true;
  }

  /**
   * Render for chat within a character budget: the opening rounds in full,
   * then the most dramatic rounds (crits, fumbles, knockouts, fate), and
   * always the final round. Anything skipped is shown as a "…R4–R7…" gap.
   */
  render(budget = 1300): string {
    const texts = this.rounds.map((r, i) =>
      `R${i + 1}: ${r.lines.join(" · ")}`
    );
    const n = texts.length;
    if (!n) return "";
    const keep = new Set<number>();
    let used = 0;
    const add = (i: number) => {
      if (keep.has(i)) return;
      keep.add(i);
      used += texts[i].length + 3;
    };
    // Reserve the finale, then fill the opening up to half the budget.
    add(n - 1);
    for (let i = 0; i < n - 1; i++) {
      if (i > 0 && used + texts[i].length + 3 > budget / 2) break;
      add(i);
    }
    // Spend what's left on dramatic rounds.
    for (let i = 0; i < n; i++) {
      if (keep.has(i) || !this.rounds[i].notable) continue;
      if (used + texts[i].length + 3 > budget) continue;
      add(i);
    }
    const out: string[] = [];
    let prev = -1;
    for (const i of [...keep].sort((a, b) => a - b)) {
      if (i - prev > 1) {
        const from = prev + 2;
        const to = i;
        out.push(from === to ? `…R${from}…` : `…R${from}–R${to}…`);
      }
      out.push(texts[i]);
      prev = i;
    }
    return out.join(" | ");
  }
}

/** Simulate one attack; mutates hp map. Returns the structured result. */
export function simulateAttack(
  attackerName: string,
  defenderName: string,
  attacker: { proficiency: number; scores: Record<string, number> },
  defender: { proficiency: number; scores: Record<string, number> },
  hp: Record<string, number>,
): Strike {
  const stats = combatStats(attacker as any);
  const targetStats = combatStats(defender as any);
  const roll = 1 + Math.floor(Math.random() * 20);
  const total = roll + stats.mod + attacker.proficiency;
  const critical = roll === 20;
  const hit = critical || (roll !== 1 && total >= targetStats.attack);
  const dice = critical
    ? 1 + Math.floor(Math.random() * stats.die) +
      (1 + Math.floor(Math.random() * stats.die))
    : 1 + Math.floor(Math.random() * stats.die);
  const damage = hit ? Math.max(1, dice + stats.mod) : 0;
  if (hit) hp[defenderName] = Math.max(0, (hp[defenderName] ?? 0) - damage);
  return {
    actor: attackerName,
    target: defenderName,
    hit,
    crit: critical,
    fumble: roll === 1,
    roll,
    total,
    ac: targetStats.attack,
    damage,
    targetHp: hp[defenderName] ?? 0,
    targetMax: Number((defender as any).hpMax ?? hp[defenderName] ?? 0),
  };
}

/**
 * Auto-resolve one solo hero-vs-monster fight with the real dice. Shared by
 * the chat command (!dndduel / !dndduel <monster>) and the autohunt
 * (autohunt.ts) so both fight with exactly the same engine and odds.
 * Pure simulation: no DB writes, no chat. `username` is the display label
 * used in the battle log.
 */
export function simulateMonsterFight(c: any, username: string, monster: any) {
  let playerHp = c.hpMax;
  let monsterHp = monster.hp;
  const pStats = combatStats(c);
  // Slightly forgiving AC for stream pacing
  const playerAc = 11 + pStats.mod + c.proficiency;
  const battle = new BattleLog();
  let swings = 0;
  // High enough that even a long slog against a big monster is settled by
  // the dice; the cap only exists to guarantee the loop ends.
  const maxSwings = 100;
  const dmgDie = 10; // heroes hit a bit harder vs monsters than PvP d8
  let fateUsed = false;

  while (playerHp > 0 && monsterHp > 0 && swings < maxSwings) {
    swings++;
    battle.nextRound();
    const roll = 1 + Math.floor(Math.random() * 20);
    const total = roll + pStats.mod + c.proficiency + 1; // +1 to-hit bias
    const critical = roll === 20;
    const hit = critical || (roll !== 1 && total >= monster.ac);
    const dice = critical
      ? 1 + Math.floor(Math.random() * dmgDie) + 1 +
        Math.floor(Math.random() * dmgDie)
      : 1 + Math.floor(Math.random() * dmgDie);
    const damage = hit ? Math.max(1, dice + pStats.mod + 1) : 0;
    if (hit) monsterHp = Math.max(0, monsterHp - damage);
    battle.strike({
      actor: username,
      target: monster.name,
      hit,
      crit: critical,
      fumble: roll === 1,
      roll,
      total,
      ac: monster.ac,
      damage,
      targetHp: monsterHp,
      targetMax: monster.hp,
    });
    if (monsterHp <= 0) break;
    const mRoll = 1 + Math.floor(Math.random() * 20);
    const mTotal = mRoll + monster.attack;
    const mHit = mRoll !== 1 && (mRoll === 20 || mTotal >= playerAc);
    const mDice = 1 + Math.floor(Math.random() * monster.die);
    const mDamage = mHit ? Math.max(1, mDice + monster.bonus) : 0;
    if (mHit) playerHp = Math.max(0, playerHp - mDamage);
    let fateSaved = false;
    if (playerHp <= 0 && !fateUsed) {
      fateUsed = true;
      if (1 + Math.floor(Math.random() * 20) >= FATE_STAYS_HAND_DC) {
        playerHp = 1;
        fateSaved = true;
      }
    }
    battle.strike({
      actor: monster.name,
      target: username,
      hit: mHit,
      crit: mRoll === 20,
      fumble: mRoll === 1,
      roll: mRoll,
      total: mTotal,
      ac: playerAc,
      damage: mDamage,
      // Show the blow's true result even when fate then rescues the hero.
      targetHp: fateSaved ? 0 : playerHp,
      targetMax: c.hpMax,
    });
    if (fateSaved) {
      battle.note(`✨ fate stays its hand — ${username} is left at 1 HP`);
    }
  }

  // Only reachable if the swing cap is hit with both sides standing: the one
  // in better shape (by share of HP left) is the last one on its feet.
  if (playerHp > 0 && monsterHp > 0) {
    const playerWins = playerHp / c.hpMax >= monsterHp / monster.hp;
    battle.note(
      playerWins
        ? `${monster.name} falters, spent, as ${username} stands firm`
        : `${username} falters, spent, as ${monster.name} presses on`,
    );
    if (playerWins) monsterHp = 0;
    else playerHp = 0;
  }
  return {
    won: monsterHp <= 0 && playerHp > 0,
    playerHp,
    monsterHp,
    rounds: battle.roundCount,
    battle,
  };
}


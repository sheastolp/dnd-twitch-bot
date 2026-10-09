// Shared auto-resolve battle engine for combat.ts (duels, party hunts, !rob)
// and autohunt.ts: the swing-by-swing chat log (BattleLog) and the solo
// hero-vs-monster fight (simulateMonsterFight). Split out of combat.ts, which
// is close to Val Town's per-file size ceiling (a push with an oversized file
// is rejected and the deploy silently stays on old code).

import { attackAbility, combatStats, heroAc, modifier } from "./utils.ts";

// Auto solo monster duels (bare !dndduel / !dndduel <name>) are decided by the
// actual dice, not a fixed win rate: the odds come from the real matchup
// (character vs. the level-scaled monster), so a goblin is a fair bet for a
// novice, a dragon is a death wish, and every fight can still turn on a
// natural 20. The only nudge fate gives is FATE_STAYS_HAND below.
//
// Once per fight, when a blow would drop the hero to 0 HP, they roll a d20 +
// their CON modifier; this number or higher and fate stays its hand, leaving
// them on 1 HP.
const FATE_STAYS_HAND_DC = 18;

// ---------------------------------------------------------------------------
// Auto-resolve battle log
//
// Every auto-resolved fight (solo monster duel, party hunt, PvP duel, party
// duel, !rob) records its swings through this one helper so chat reads the
// same way everywhere: who swung at whom, whether it landed,
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
  /** How the target's AC is worked out, shown on the first round only. */
  acWhy?: string;
  // Extra detail for the full-reply page only (renderDetailed): what was
  // added to the d20, the damage dice rolled and what was added to them, and
  // the target's HP before the blow.
  atk?: Mods;
  dmgDice?: number[];
  dmgDie?: number;
  dmgMods?: Mods;
  hpBefore?: number;
}

/** Labelled modifiers, e.g. [["DEX", 3], ["prof", 2]]. */
export type Mods = Array<[string, number]>;

/** Which ability a hero fights with (see attackAbility in utils.ts: the
 * casting stat for spellcasters, else the higher of STR/DEX) — "DEX 16". */
export function fightingAbility(c: { scores: Record<string, number>; cls?: string }): { name: string; score: number } {
  const name = attackAbility(c as any);
  return { name, score: Number(c.scores?.[name] ?? 10) };
}

/** Rolls `count` dice of `sides`, returning each result. */
export function rollDice(count: number, sides: number): number[] {
  return Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
}

const signed = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n)}`;
const modsText = (mods: Mods) => mods.filter(([, v]) => v !== 0).map(([label, v]) => ` ${signed(v)} ${label}`).join("");

/** Every number behind one swing, for the full-reply page — terse, since a
 * page shows one of these per swing: "Bob → Goblin: 17 +3 STR +2 prof = 22
 * vs AC 13 (stat block) → HIT by 9 · 1d10 (3) +3 STR = 6 · Goblin 20→14/20". */
function fmtStrikeDetailed(s: Strike): string {
  const actor = s.actor === YOU ? "You" : s.actor;
  const target = s.target === YOU ? "you" : s.target;
  const targetCap = s.target === YOU ? "You" : s.target;
  const atk = s.atk ? modsText(s.atk) : (s.total - s.roll ? ` ${signed(s.total - s.roll)}` : "");
  const ac = `AC ${s.ac}${s.acWhy ? ` (${s.acWhy})` : ""}`;
  let out = `${actor} → ${target}: ${s.roll}${atk} = ${s.total} vs ${ac}`;
  if (s.fumble) return `${out} → nat 1, FUMBLE`;
  if (!s.hit) return `${out} → MISS by ${s.ac - s.total}`;
  out += s.crit ? " → nat 20, CRIT" : s.total === s.ac ? " → HIT (exact)" : ` → HIT by ${s.total - s.ac}`;
  if (s.dmgDice?.length) {
    const raw = s.dmgDice.reduce((a, b) => a + b, 0) + (s.dmgMods ?? []).reduce((a, [, v]) => a + v, 0);
    out += ` · ${s.dmgDice.length}d${s.dmgDie} (${s.dmgDice.join("+")})${modsText(s.dmgMods ?? [])} = ${s.damage}${raw < s.damage ? " (min 1)" : ""}`;
  } else {
    out += ` · ${s.damage} dmg`;
  }
  out += s.hpBefore !== undefined ? ` · ${targetCap} ${s.hpBefore}→${s.targetHp}/${s.targetMax}` : ` · ${targetCap} ${s.targetHp}/${s.targetMax}`;
  if (s.targetHp <= 0) out += " 💀";
  return out;
}

/** Pass as the hero's label to narrate the viewer in the second person
 * ("You hit the Goblin", "the Goblin hits you") instead of repeating their
 * name, which Twitch boxes on every appearance. */
export const YOU = "you";

/** "10 base +2 DEX +3 CON +2 prof" — how an AC is built from its parts. */
export function acWhy(base: number, parts: Mods): string {
  return `${base} base${parts.map(([label, v]) => ` ${v < 0 ? "-" : "+"}${Math.abs(v)} ${label}`).join("")}`;
}

/** A hero's fight stats for the full-reply page: level, class, HP, AC (and
 * how it's built), attack and damage. `hp` is their HP going in. */
export function fighterLine(
  name: string,
  c: any,
  hp: number,
  acBase: number,
  opts: { die?: number; edge?: number } = {},
): string {
  const stats = combatStats(c);
  const a = fightingAbility(c);
  const die = opts.die ?? stats.die;
  const edge = opts.edge ?? 0;
  const edgeText = edge ? ` +${edge} edge (hunter's edge)` : "";
  return `${name}: Lv ${c.level ?? "?"} ${c.cls ?? "hero"}, ${hp}/${c.hpMax} HP, AC ${heroAc(c, acBase).ac} (${heroAcWhy(acBase, c)}), ` +
    `attack d20 ${signed(stats.mod)} ${a.name} +${c.proficiency} prof${edgeText}, ` +
    `damage 1d${die} ${signed(stats.mod)} ${a.name}${edge ? ` +${edge} edge` : ""}.`;
}

/** acWhy for a hero, naming the abilities their AC comes from. */
export function heroAcWhy(base: number, c: { proficiency: number; scores: Record<string, number>; cls?: string }): string {
  return acWhy(base, heroAc(c as any, base).parts);
}

/** A monster's AC comes straight from its bestiary entry. */
export const MONSTER_AC_WHY = "stat block";

function fmtStrike(s: Strike, showAc = false): string {
  // Compact on purpose: rolls vs AC are left out so a whole fight fits in
  // one or two chat messages instead of a wall of text. The first round
  // (showAc) spells out each roll vs AC and how that AC is determined.
  const ac = showAc
    ? ` [${s.total} vs AC ${s.ac}${s.acWhy ? ` (${s.acWhy})` : ""}]`
    : "";
  const you = s.actor === YOU;
  const actor = you ? "You" : s.actor;
  if (s.fumble) return `${actor} ${you ? "fumble" : "fumbles"}${showAc ? ` [nat 1 vs AC ${s.ac}${s.acWhy ? ` (${s.acWhy})` : ""}]` : ""}`;
  if (!s.hit) return `${actor} ${you ? "miss" : "misses"}${showAc ? ` ${s.target}${ac}` : ""}`;
  const verb = s.crit ? (you ? "💥crit" : "💥crits") : (you ? "hit" : "hits");
  const tail = s.targetHp <= 0
    ? ` — ${s.target} ${s.target === YOU ? "fall" : "falls"}!`
    : ` (${s.targetHp}/${s.targetMax})`;
  return `${actor} ${verb} ${s.target}${s.crit && showAc ? ` [nat 20 vs AC ${s.ac}${s.acWhy ? ` (${s.acWhy})` : ""}]` : ac} ${s.damage}${tail}`;
}

export class BattleLog {
  private rounds: { lines: string[]; details: string[]; notable: boolean }[] = [];
  private intro: string[] = [];

  /** Start a new round (call once per round, before its first swing). */
  nextRound() {
    this.rounds.push({ lines: [], details: [], notable: false });
  }

  /** A line shown only on the full-reply page, before round 1 (e.g. each
   * fighter's stats). */
  describe(line: string) {
    this.intro.push(line);
  }

  /** A line shown only on the full-reply page, in the current round. */
  explain(line: string) {
    if (!this.rounds.length) this.nextRound();
    this.rounds[this.rounds.length - 1].details.push(line);
  }

  /** Every round and every number, for the full-reply page (no budget).
   * One " | "-separated line per swing, each tagged with its round. */
  renderDetailed(): string {
    return [
      ...this.intro,
      ...this.rounds.flatMap((r, i) => r.details.map((d) => `R${i + 1}: ${d}`)),
    ].join(" | ");
  }

  get roundCount() {
    return this.rounds.length;
  }

  /** Record a swing. Crits, fumbles and knockouts mark the round notable. */
  strike(s: Strike) {
    if (!this.rounds.length) this.nextRound();
    const r = this.rounds[this.rounds.length - 1];
    r.lines.push(fmtStrike(s, this.rounds.length === 1));
    r.details.push(fmtStrikeDetailed(s));
    if (s.crit || s.fumble || s.targetHp <= 0) r.notable = true;
  }

  /** Record a free-form event line (e.g. fate intervening). */
  note(line: string, notable = true) {
    if (!this.rounds.length) this.nextRound();
    const r = this.rounds[this.rounds.length - 1];
    r.lines.push(line);
    r.details.push(line);
    if (notable) r.notable = true;
  }

  /**
   * Render for chat within a character budget: the opening rounds in full,
   * then the most dramatic rounds (crits, fumbles, knockouts, fate), and
   * always the final round. Anything skipped is shown as a "…R4–R7…" gap.
   */
  render(budget = 450): string {
    const texts = this.rounds.map((r, i) =>
      `R${i + 1}: ${r.lines.join(", ")}`
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
  attacker: { proficiency: number; scores: Record<string, number>; cls?: string },
  defender: { proficiency: number; scores: Record<string, number>; cls?: string },
  hp: Record<string, number>,
): Strike {
  const stats = combatStats(attacker as any);
  const targetAc = heroAc(defender as any, 10).ac;
  const ability = stats.ability;
  const roll = 1 + Math.floor(Math.random() * 20);
  const total = roll + stats.toHit;
  const critical = roll === 20;
  const hit = critical || (roll !== 1 && total >= targetAc);
  const rolls = rollDice(critical ? 2 : 1, stats.die);
  const dice = rolls.reduce((a, b) => a + b, 0);
  const damage = hit ? Math.max(1, dice + stats.mod) : 0;
  const hpBefore = hp[defenderName] ?? 0;
  if (hit) hp[defenderName] = Math.max(0, (hp[defenderName] ?? 0) - damage);
  return {
    actor: attackerName,
    target: defenderName,
    hit,
    crit: critical,
    fumble: roll === 1,
    roll,
    total,
    ac: targetAc,
    damage,
    targetHp: hp[defenderName] ?? 0,
    targetMax: Number((defender as any).hpMax ?? hp[defenderName] ?? 0),
    acWhy: heroAcWhy(10, defender),
    atk: [[ability, stats.mod], ["prof", attacker.proficiency]],
    dmgDice: hit ? rolls : undefined,
    dmgDie: stats.die,
    dmgMods: [[ability, stats.mod]],
    hpBefore,
  };
}

/**
 * Auto-resolve one solo hero-vs-monster fight with the real dice. Shared by
 * the chat command (!dndduel / !dndduel <monster>) and the autohunt
 * (autohunt.ts) so both fight with exactly the same engine and odds.
 * Pure simulation: no DB writes, no chat. `username` is the display label
 * used in the battle log.
 */
/** `opts.startHp` starts the hero wounded (Hunt and Hoard keeps HP between
 * hunts, see hoard.ts); every other fight starts at full HP. */
export function simulateMonsterFight(c: any, username: string, monster: any, opts: { startHp?: number } = {}) {
  let playerHp = Math.max(1, Math.min(c.hpMax, Math.floor(opts.startHp ?? c.hpMax)));
  let monsterHp = monster.hp;
  const pStats = combatStats(c);
  // Slightly forgiving AC for stream pacing
  const playerAc = heroAc(c, 11).ac;
  const battle = new BattleLog();
  let swings = 0;
  // High enough that even a long slog against a big monster is settled by
  // the dice; the cap only exists to guarantee the loop ends.
  const maxSwings = 100;
  const dmgDie = 10; // heroes hit a bit harder vs monsters than PvP d8
  let fateUsed = false;
  const ability = pStats.ability;
  const conMod = modifier(Number(c.scores?.CON ?? 10));
  const label = username === YOU ? "You" : username;
  battle.describe(
    `${label}: Lv ${c.level ?? "?"} ${c.cls ?? "hero"}, ${playerHp < c.hpMax ? `${playerHp}/` : ""}${c.hpMax} HP, AC ${playerAc} (${heroAcWhy(11, c)}), ` +
      `attack d20 ${signed(pStats.mod)} ${ability} +${c.proficiency} prof +1 edge (hunter's edge), damage 1d${dmgDie} ${signed(pStats.mod)} ${ability} +1 edge.`,
  );
  battle.describe(
    `${monster.name}: CR ${monster.cr ?? "?"}, ${monster.hp} HP, AC ${monster.ac} (stat block), attack d20 + ${monster.attack}, damage 1d${monster.die} ${signed(monster.bonus)}.`,
  );

  while (playerHp > 0 && monsterHp > 0 && swings < maxSwings) {
    swings++;
    battle.nextRound();
    const roll = 1 + Math.floor(Math.random() * 20);
    const total = roll + pStats.toHit + 1; // +1 to-hit bias
    const critical = roll === 20;
    const hit = critical || (roll !== 1 && total >= monster.ac);
    const rolls = rollDice(critical ? 2 : 1, dmgDie);
    const dice = rolls.reduce((a, b) => a + b, 0);
    const damage = hit ? Math.max(1, dice + pStats.mod + 1) : 0;
    const monsterHpBefore = monsterHp;
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
      acWhy: MONSTER_AC_WHY,
      atk: [[ability, pStats.mod], ["prof", c.proficiency], ["edge", 1]],
      dmgDice: hit ? rolls : undefined,
      dmgDie,
      dmgMods: [[ability, pStats.mod], ["edge", 1]],
      hpBefore: monsterHpBefore,
    });
    if (monsterHp <= 0) break;
    const mRoll = 1 + Math.floor(Math.random() * 20);
    const mTotal = mRoll + monster.attack;
    const mHit = mRoll !== 1 && (mRoll === 20 || mTotal >= playerAc);
    const mDice = 1 + Math.floor(Math.random() * monster.die);
    const mDamage = mHit ? Math.max(1, mDice + monster.bonus) : 0;
    const playerHpBefore = playerHp;
    if (mHit) playerHp = Math.max(0, playerHp - mDamage);
    let fateSaved = false;
    let fateRoll = 0;
    if (playerHp <= 0 && !fateUsed) {
      fateUsed = true;
      fateRoll = 1 + Math.floor(Math.random() * 20);
      if (fateRoll + conMod >= FATE_STAYS_HAND_DC) {
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
      acWhy: heroAcWhy(11, c),
      atk: [["atk", monster.attack]],
      dmgDice: mHit ? [mDice] : undefined,
      dmgDie: monster.die,
      dmgMods: [["bonus", monster.bonus]],
      hpBefore: playerHpBefore,
    });
    if (fateSaved) {
      battle.note(`✨ fate stays its hand — ${username === YOU ? "you are" : username + " is"} left at 1 HP`);
      battle.explain(`(Fate's roll, d20 ${fateRoll} ${signed(conMod)} CON = ${fateRoll + conMod}, met DC ${FATE_STAYS_HAND_DC}: once per fight, a blow that would drop the hero leaves them at 1 HP instead.)`);
    }
  }

  // Only reachable if the swing cap is hit with both sides standing: the one
  // in better shape (by share of HP left) is the last one on its feet.
  if (playerHp > 0 && monsterHp > 0) {
    const playerWins = playerHp / c.hpMax >= monsterHp / monster.hp;
    battle.note(
      playerWins
        ? `${monster.name} falters, spent, as ${username === YOU ? "you stand" : username + " stands"} firm`
        : `${username === YOU ? "you falter" : username + " falters"}, spent, as ${monster.name} presses on`,
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


// Duels, party combat, monster duels, and initiative tracker

import { pickMonsterForLevel } from "./data.ts";
import { combatStats, duelNarration, firstAlive, modifier } from "./utils.ts";
import {
  createPartyInvite,
  deletePartyInvite,
  getCharacter,
  getDuel,
  getEncounter,
  getMonsterDuel,
  getParty,
  getPartyDuel,
  getPartyInvite,
  getPartyInvites,
  getPartyMembers,
  getPartyMonsterDuel,
  saveEncounter,
  sqlite,
  withColumnHeal,
} from "./db.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import { awardMonsterXp } from "./characters.ts";

// Target win rate for the challenger in auto solo monster duels (bare
// !dndduel). Chosen once per fight before simulating; the sim below is
// nudged onto that outcome afterward so the rate holds regardless of which
// monster/stat matchup got picked for that fight. Does not affect classic
// (turn-based) monster duels, PvP duels (!dndduel @user), or party hunts.
const AUTO_DUEL_PLAYER_WIN_RATE = 0.6;

// A pending challenge (!dndduel @user / !dndduel party <a> <b>) must be
// accepted within this window or it silently expires — capped at 5 minutes
// regardless of env override so a forgotten challenge never lingers.
const DUEL_ACCEPT_TIMEOUT_MS = Math.min(
  300_000,
  Math.max(30_000, Number(Deno.env.get("DUEL_ACCEPT_TIMEOUT_MS") ?? "300000")),
);

// Any *active* classic (turn-based) duel — 1v1, party vs party, solo vs
// monster, or party hunt — auto-forfeits to the non-idle side if nobody acts
// for this long. This keeps a duel abandoned mid-stream (or a character
// deleted mid-fight) from blocking that channel's dueling forever until the
// next stream.
const DUEL_IDLE_TIMEOUT_MS = Math.max(
  60_000,
  Number(Deno.env.get("DUEL_IDLE_TIMEOUT_MS") ?? "600000"),
);

function isChallengeExpired(createdAt: unknown): boolean {
  return Date.now() - Number(createdAt) > DUEL_ACCEPT_TIMEOUT_MS;
}

function isDuelIdle(updatedAt: unknown): boolean {
  return Date.now() - Number(updatedAt) > DUEL_IDLE_TIMEOUT_MS;
}

/** Auto-forfeits an idle 1v1 classic duel. Returns true if it forfeited. */
async function forfeitIfIdleDuel(broadcasterId: string, active: any): Promise<boolean> {
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
async function forfeitIfIdleMonsterDuel(broadcasterId: string, active: any): Promise<boolean> {
  if (!active || !isDuelIdle(active.updated_at)) return false;
  await sqlite.execute("DELETE FROM monster_duels WHERE broadcaster_id = ?", [broadcasterId]);
  await sendChatMessage(
    `⌛ ${active.player}'s duel with ${active.monster_name} went idle too long and was abandoned. The beast melts back into the shadows.`,
    broadcasterId,
  );
  return true;
}

/** Auto-forfeits an idle party vs. party classic duel. */
async function forfeitIfIdlePartyDuel(broadcasterId: string, active: any): Promise<boolean> {
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
async function forfeitIfIdlePartyHunt(broadcasterId: string, active: any): Promise<boolean> {
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

/** Simulate one attack; mutates hp map. Returns a short log line. */
function simulateAttack(
  attackerName: string,
  defenderName: string,
  attacker: { proficiency: number; scores: Record<string, number> },
  defender: { proficiency: number; scores: Record<string, number> },
  hp: Record<string, number>,
): string {
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
  if (critical) {
    return `${attackerName} CRIT ${damage}→${defenderName}(${
      hp[defenderName]
    }HP)`;
  }
  if (hit) {
    return `${attackerName} hit ${damage}→${defenderName}(${
      hp[defenderName]
    }HP)`;
  }
  return `${attackerName} miss`;
}

/** Auto-resolve a 1v1 duel. Returns chat-ready summary lines. */
function resolvePlayerDuel(
  aName: string,
  bName: string,
  aChar: any,
  bChar: any,
): { winner: string; log: string; rounds: number } {
  const hp: Record<string, number> = {
    [aName]: aChar.hpMax,
    [bName]: bChar.hpMax,
  };
  const maxRounds = 40;
  const highlights: string[] = [];
  let rounds = 0;
  let turn = aName;
  while (hp[aName] > 0 && hp[bName] > 0 && rounds < maxRounds) {
    rounds++;
    const attackerName = turn;
    const defenderName = turn === aName ? bName : aName;
    const attacker = turn === aName ? aChar : bChar;
    const defender = turn === aName ? bChar : aChar;
    const line = simulateAttack(
      attackerName,
      defenderName,
      attacker,
      defender,
      hp,
    );
    // Keep crits, finishing blows, and a sample of early hits
    if (
      line.includes("CRIT") || hp[defenderName] <= 0 || highlights.length < 6
    ) {
      highlights.push(line);
    }
    turn = defenderName;
  }
  const winner = hp[aName] > 0 ? aName : bName;
  const log = [
    `${aName} ${aChar.hpMax}HP vs ${bName} ${bChar.hpMax}HP — auto-resolved in ${rounds} swings.`,
    highlights.join(" · "),
    `${winner} wins! ${duelNarration("victory")} Final: ${aName} ${
      hp[aName]
    }HP, ${bName} ${hp[bName]}HP.`,
  ].join(" ");
  return { winner, log, rounds };
}

/**
 * When a player tries !dndduel accept/decline with no pending PvP challenge
 * waiting on them, check whether they're actually mid-fight somewhere else
 * (solo monster, PvP classic, party duel, or party hunt) and nudge them
 * toward the right next command instead of leaving them with a dead end.
 */
async function noPendingChallengeNudge(
  broadcasterId: string,
  username: string,
  display: string,
): Promise<string> {
  const monsterActive = await getMonsterDuel(broadcasterId);
  if (monsterActive && monsterActive.player === username) {
    return `@${display} no pending duel challenge waiting on you — but your fight with ${monsterActive.monster_name} is already underway! Press on with !dndduel attack, check the field with !dndduel monster status, or retreat with !dndduel monster end.`;
  }

  const pvpActive = await getDuel(broadcasterId);
  if (pvpActive && (pvpActive.challenger === username || pvpActive.defender === username)) {
    const foe = pvpActive.challenger === username ? pvpActive.defender : pvpActive.challenger;
    return `@${display} no pending duel challenge waiting on you — you're already blade-to-blade with ${foe}! Use !dndduel attack on your turn, !dndduel status to check the field, or !dndduel end to withdraw.`;
  }

  const huntActive = await getPartyMonsterDuel(broadcasterId);
  if (huntActive && huntActive.members.includes(username)) {
    return `@${display} no pending duel challenge waiting on you — your party is already deep in a hunt against ${huntActive.monster_name}! Use !dndduel party hunt attack on your turn, or !dndduel party hunt status to check the field.`;
  }

  const partyDuelActive = await getPartyDuel(broadcasterId);
  if (
    partyDuelActive &&
    (partyDuelActive.challenger_members.includes(username) ||
      partyDuelActive.defender_members.includes(username))
  ) {
    return `@${display} no pending duel challenge waiting on you — your party duel is already underway! Use !dndduel party attack on your turn, or !dndduel party status to check the field.`;
  }

  return `@${display} you have no pending duel challenge.`;
}

export async function handleDuelCommand(
  chatMessage: string,
  username: string,
  display: string,
  broadcasterId: string,
) {
  if (!/^!dndduel(?:\s|$)/i.test(chatMessage)) return false;
  const parts = chatMessage.trim().split(/\s+/);
  const action = (parts[1] ?? "status").toLowerCase();
  let active = await getDuel(broadcasterId);
  if (await forfeitIfIdleDuel(broadcasterId, active)) active = null;

  if (action === "accept" || action === "decline") {
    const res = await sqlite.execute(
      "SELECT challenger, defender, mode, created_at FROM duel_challenges WHERE broadcaster_id = ? AND defender = ? ORDER BY created_at DESC LIMIT 1",
      [broadcasterId, username],
    );
    if (!res.rows.length) {
      await sendChatMessage(
        await noPendingChallengeNudge(broadcasterId, username, display),
        broadcasterId,
      );
      return true;
    }
    const challenge = res.rows[0];
    await sqlite.execute(
      "DELETE FROM duel_challenges WHERE broadcaster_id = ? AND defender = ?",
      [
        broadcasterId,
        username,
      ],
    );
    if (isChallengeExpired(challenge.created_at)) {
      await sendChatMessage(
        `@${display} that duel challenge from ${challenge.challenger} expired after 5 minutes — ask for a new one with !dndduel @user.`,
        broadcasterId,
      );
      return true;
    }
    const mode = String(challenge.mode || "auto").toLowerCase() === "classic"
      ? "classic"
      : "auto";
    if (action === "decline") {
      await sendChatMessage(
        `@${display} duel declined. ${duelNarration("decline")}`,
        broadcasterId,
      );
      return true;
    }
    const challenger = await getCharacter(challenge.challenger, broadcasterId);
    const defender = await getCharacter(username, broadcasterId);
    if (!challenger || !defender) {
      await sendChatMessage(
        `@${display} both players need saved characters before dueling.`,
        broadcasterId,
      );
      return true;
    }
    if (mode === "classic") {
      // Turn-based: store active duel; players use !dndduel attack.
      await sqlite.execute(
        "INSERT OR REPLACE INTO duels (broadcaster_id,challenger,defender,current_turn,challenger_hp,defender_hp,active,updated_at) VALUES (?,?,?,?,?,?,1,?)",
        [
          broadcasterId,
          challenge.challenger,
          username,
          challenge.challenger,
          challenger.hpMax,
          defender.hpMax,
          Date.now(),
        ],
      );
      await sendChatMessage(
        `@${display} accepted classic duel! ${challenge.challenger} goes first. ${
          duelNarration("accept")
        } Use !dndduel attack on your turn, or !dndduel status / !dndduel end.`,
        broadcasterId,
      );
      return true;
    }
    // Auto-resolve mode
    await sqlite.execute("DELETE FROM duels WHERE broadcaster_id = ?", [
      broadcasterId,
    ]);
    const result = resolvePlayerDuel(
      String(challenge.challenger),
      username,
      challenger,
      defender,
    );
    await sendChatMessages(
      `@${display} accepted! ${duelNarration("accept")} ${result.log}`,
      broadcasterId,
    );
    return true;
  }

  if (action === "end" || action === "cancel") {
    if (
      active && (active.challenger === username || active.defender === username)
    ) {
      await sqlite.execute("DELETE FROM duels WHERE broadcaster_id = ?", [
        broadcasterId,
      ]);
      await sendChatMessage(`@${display} duel ended.`, broadcasterId);
    } else {
      await sendChatMessage(`@${display} no duel to end.`, broadcasterId);
    }
    return true;
  }

  if (action === "status" || action === "show") {
    await sendChatMessage(
      active
        ? `@${display} ${await duelSummary(active)}`
        : `@${display} no active duel. Challenge someone with !dndduel @username.`,
      broadcasterId,
    );
    return true;
  }

  if (action === "attack") {
    if (!active) {
      await sendChatMessage(
        `@${display} no active duel. Challenge someone with !dndduel @username.`,
        broadcasterId,
      );
      return true;
    }
    if (active.current_turn !== username) {
      await sendChatMessage(
        `@${display} it is ${active.current_turn}'s turn.`,
        broadcasterId,
      );
      return true;
    }
    const attacker = await getCharacter(username, broadcasterId);
    const targetName = active.challenger === username
      ? active.defender
      : active.challenger;
    const target = await getCharacter(targetName, broadcasterId);
    if (!attacker || !target) {
      await sendChatMessage(
        `@${display} both duel characters must still exist.`,
        broadcasterId,
      );
      return true;
    }
    const stats = combatStats(attacker);
    const targetStats = combatStats(target);
    const roll = 1 + Math.floor(Math.random() * 20);
    const total = roll + stats.mod + attacker.proficiency;
    const critical = roll === 20;
    const hit = critical || (roll !== 1 && total >= targetStats.attack);
    const dice = critical
      ? 1 + Math.floor(Math.random() * stats.die) +
        (1 + Math.floor(Math.random() * stats.die))
      : 1 + Math.floor(Math.random() * stats.die);
    const damage = hit ? Math.max(1, dice + stats.mod) : 0;
    if (active.challenger === username) {
      active.defender_hp = Math.max(0, active.defender_hp - damage);
    } else active.challenger_hp = Math.max(0, active.challenger_hp - damage);
    const defeated = active.challenger_hp <= 0 || active.defender_hp <= 0;
    const result = `${username} rolled ${roll}${
      critical ? " CRITICAL" : ""
    } + ${
      stats.mod + attacker.proficiency
    } = ${total} vs AC ${targetStats.attack}: ${
      hit ? `hit for ${damage} damage` : "miss"
    }. ${duelNarration(critical ? "critical" : hit ? "hit" : "miss")}`;
    if (defeated) {
      const winner = active.challenger_hp > 0
        ? active.challenger
        : active.defender;
      await sqlite.execute("DELETE FROM duels WHERE broadcaster_id = ?", [
        broadcasterId,
      ]);
      await sendChatMessage(
        `@${display} ${result} ${winner} wins the duel! ${
          duelNarration("victory")
        }`,
        broadcasterId,
      );
    } else {
      active.current_turn = targetName;
      await sqlite.execute(
        "UPDATE duels SET current_turn = ?, challenger_hp = ?, defender_hp = ?, updated_at = ? WHERE broadcaster_id = ?",
        [
          active.current_turn,
          active.challenger_hp,
          active.defender_hp,
          Date.now(),
          broadcasterId,
        ],
      );
      await sendChatMessages(
        `@${display} ${result} ${await duelSummary(active)}`,
        broadcasterId,
      );
    }
    return true;
  }

  // Challenge: !dndduel @user (auto) | !dndduel classic @user | !dndduel turn @user
  let mode: "auto" | "classic" = "auto";
  let targetRaw = "";
  if (action === "classic" || action === "turn" || action === "manual") {
    mode = "classic";
    targetRaw = parts.slice(2).join(" ");
  } else if (action === "auto" || action === "quick") {
    mode = "auto";
    targetRaw = parts.slice(2).join(" ");
  } else {
    // Bare "!dndduel @user" — default auto
    targetRaw = parts.slice(1).join(" ");
  }
  const targetName = targetRaw.replace(/^@/, "").toLowerCase().replace(
    /[,:]+$/,
    "",
  );
  if (
    !targetName ||
    [
      "party",
      "monster",
      "accept",
      "decline",
      "attack",
      "status",
      "show",
      "end",
      "cancel",
    ].includes(targetName)
  ) {
    await sendChatMessage(
      `@${display} Duels: !dndduel @user (auto) | !dndduel classic @user (turn-based) | !dndduel accept | !dndduel decline | !dndduel attack | !dndduel status | !dndduel end`,
      broadcasterId,
    );
    return true;
  }
  if (active) {
    await sendChatMessage(
      `@${display} a classic duel is already active in this channel. Finish it or !dndduel end.`,
      broadcasterId,
    );
    return true;
  }
  const target = await getCharacter(targetName, broadcasterId);
  const own = await getCharacter(username, broadcasterId);
  if (!own || !target) {
    await sendChatMessage(
      `@${display} both players need saved characters before issuing a challenge.`,
      broadcasterId,
    );
    return true;
  }
  if (targetName === username.toLowerCase()) {
    await sendChatMessage(
      `@${display} you cannot duel yourself.`,
      broadcasterId,
    );
    return true;
  }
  await sqlite.execute(
    "INSERT OR REPLACE INTO duel_challenges (broadcaster_id,challenger,defender,created_at,mode) VALUES (?,?,?,?,?)",
    [broadcasterId, username, targetName, Date.now(), mode],
  );
  if (mode === "classic") {
    await sendChatMessage(
      `@${display} challenged @${targetName} to a classic turn-based duel! ${
        duelNarration("challenge")
      } @${targetName}, type !dndduel accept or !dndduel decline within 5 minutes.`,
      broadcasterId,
    );
  } else {
    await sendChatMessage(
      `@${display} challenged @${targetName} to a quick auto-duel! ${
        duelNarration("challenge")
      } @${targetName}, type !dndduel accept or !dndduel decline within 5 minutes.`,
      broadcasterId,
    );
  }
  return true;
}

export async function monsterDuelText(d: any) {
  return `${d.player} vs ${d.monster_name} (CR ${d.monster_cr}) — Player HP ${
    d.player_hp ?? "?"
  }; Monster HP ${d.monster_hp}/${d.monster_hp_max}; AC ${d.monster_ac}; turn: ${d.current_turn}.`;
}

export async function handleMonsterDuelCommand(
  chatMessage: string,
  username: string,
  display: string,
  broadcasterId: string,
) {
  const normalized = chatMessage.trim().toLowerCase();
  if (
    !(
      normalized === "!dndduel" ||
      normalized === "!dndduel attack" ||
      normalized === "!dndduel monster" ||
      normalized === "!dndduel monster classic" ||
      normalized === "!dndduel monster attack" ||
      normalized === "!dndduel monster status" ||
      normalized === "!dndduel monster end"
    )
  ) {
    return false;
  }

  let active = await getMonsterDuel(broadcasterId);
  if (await forfeitIfIdleMonsterDuel(broadcasterId, active)) active = null;

  if (
    normalized === "!dndduel attack" ||
    normalized === "!dndduel monster status" ||
    normalized === "!dndduel monster end" ||
    normalized === "!dndduel monster attack"
  ) {
    if (!active || active.player !== username) {
      await sendChatMessage(
        `@${display} you do not have an active monster duel.`,
        broadcasterId,
      );
      return true;
    }
    if (normalized.endsWith("status")) {
      await sendChatMessage(
        `@${display} ${await monsterDuelText(active)}`,
        broadcasterId,
      );
      return true;
    }
    if (normalized.endsWith("end")) {
      await sqlite.execute(
        "DELETE FROM monster_duels WHERE broadcaster_id = ?",
        [broadcasterId],
      );
      await sendChatMessage(
        `@${display} the monster duel ends. The dungeon master calls it a tactical retreat.`,
        broadcasterId,
      );
      return true;
    }
  }

  // Classic turn-based monster: !dndduel monster [classic]
  if (
    normalized === "!dndduel monster" ||
    normalized === "!dndduel monster classic"
  ) {
    if (active && active.player === username) {
      await sendChatMessage(
        `@${display} ${await monsterDuelText(active)} Use !dndduel attack.`,
        broadcasterId,
      );
      return true;
    }
    const c = await getCharacter(username, broadcasterId);
    if (!c) {
      await sendChatMessage(
        `@${display} create a character first with !createchar, then !dndduel monster.`,
        broadcasterId,
      );
      return true;
    }
    const monster = pickMonsterForLevel(c.level);
    await sqlite.execute(
      "INSERT OR REPLACE INTO monster_duels (broadcaster_id,player,monster_name,monster_cr,monster_ac,monster_hp,monster_hp_max,monster_attack,monster_damage_die,monster_damage_bonus,current_turn,active,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        broadcasterId,
        username,
        monster.name,
        monster.cr,
        monster.ac,
        monster.hp,
        monster.hp,
        monster.attack,
        monster.die,
        monster.bonus,
        "player",
        1,
        Date.now(),
      ],
    );
    await sendChatMessage(
      `@${display} classic monster fight! ${monster.name} (CR ${monster.cr}) AC ${monster.ac}, HP ${monster.hp}. Your HP: ${c.hpMax}. ${
        duelNarration("challenge")
      } Use !dndduel attack.`,
      broadcasterId,
    );
    return true;
  }

  // Auto monster: bare !dndduel
  if (normalized === "!dndduel") {
    const c = await getCharacter(username, broadcasterId);
    if (!c) {
      await sendChatMessage(
        `@${display} create a character first with !createchar, then challenge the wilds with !dndduel.`,
        broadcasterId,
      );
      return true;
    }
    const monster = pickMonsterForLevel(c.level);
    let playerHp = c.hpMax;
    let monsterHp = monster.hp;
    const pStats = combatStats(c);
    // Slightly forgiving AC for stream pacing
    const playerAc = 11 + pStats.mod + c.proficiency;
    const highlights: string[] = [];
    let swings = 0;
    const maxSwings = 40;
    const dmgDie = 10; // heroes hit a bit harder vs monsters than PvP d8

    // Decide the outcome up front so the win rate is exact regardless of the
    // specific monster/stat matchup; the rolls below still drive the blow-by-
    // blow narration.
    const playerShouldWin = Math.random() < AUTO_DUEL_PLAYER_WIN_RATE;

    while (playerHp > 0 && monsterHp > 0 && swings < maxSwings) {
      swings++;
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
      if (critical || monsterHp <= 0 || highlights.length < 4) {
        highlights.push(
          hit
            ? `${username}${
              critical ? " CRIT" : ""
            } ${damage}→${monster.name}(${monsterHp})`
            : `${username} miss`,
        );
      }
      if (monsterHp <= 0) break;
      const mRoll = 1 + Math.floor(Math.random() * 20);
      const mTotal = mRoll + monster.attack;
      const mHit = mRoll !== 1 && (mRoll === 20 || mTotal >= playerAc);
      const mDice = 1 + Math.floor(Math.random() * monster.die);
      const mDamage = mHit ? Math.max(1, mDice + monster.bonus) : 0;
      if (mHit) playerHp = Math.max(0, playerHp - mDamage);
      if (mRoll === 20 || playerHp <= 0 || highlights.length < 8) {
        highlights.push(
          mHit
            ? `${monster.name} ${mDamage}→${username}(${playerHp})`
            : `${monster.name} miss`,
        );
      }
    }

    // If the natural rolls didn't land on the chosen outcome (mutual
    // knockout, or the fight timed out at maxSwings without a clean winner),
    // resolve the last exchange in the chosen winner's favor so the target
    // win rate actually holds over many duels.
    const playerNaturallyWon = monsterHp <= 0 && playerHp > 0;
    if (playerShouldWin !== playerNaturallyWon) {
      if (playerShouldWin) {
        monsterHp = 0;
        if (playerHp <= 0) playerHp = Math.max(1, Math.floor(c.hpMax * 0.15));
        highlights.push(
          `${username} turns the tide with a decisive final blow→${monster.name}(0)`,
        );
      } else {
        playerHp = 0;
        if (monsterHp <= 0) {
          monsterHp = Math.max(1, Math.floor(monster.hp * 0.15));
        }
        highlights.push(
          `${monster.name} turns the tide with a decisive final blow→${username}(0)`,
        );
      }
    }

    await sqlite.execute("DELETE FROM monster_duels WHERE broadcaster_id = ?", [
      broadcasterId,
    ]);
    const won = monsterHp <= 0 && playerHp > 0;
    let xpNote = "";
    if (won) {
      const xp = await awardMonsterXp(username, monster.cr, broadcasterId);
      if (xp) {
        xpNote = ` +${xp.gained} XP (total ${xp.total})${
          xp.leveledTo ? ` — leveled to ${xp.leveledTo}!` : ""
        }`;
      }
    }
    await sendChatMessages(
      `@${display} the D20 of Fate summons a ${monster.name} (CR ${monster.cr}, AC ${monster.ac}, HP ${monster.hp})! ${
        duelNarration("challenge")
      } Auto-resolved (${swings} exchanges): ${highlights.join(" · ")} — ${
        won
          ? `${username} defeats ${monster.name}! ${
            duelNarration("victory")
          }${xpNote}`
          : `${monster.name} wins. ${duelNarration("defeat")}`
      } Final HP: you ${playerHp}/${c.hpMax}, ${monster.name} ${monsterHp}/${monster.hp}.`,
      broadcasterId,
    );
    return true;
  }

  if (
    (normalized === "!dndduel attack" ||
      normalized === "!dndduel monster attack") &&
    active &&
    active.player === username
  ) {
    if (active.current_turn !== "player") {
      await sendChatMessage(
        `@${display} the monster is still acting.`,
        broadcasterId,
      );
      return true;
    }
    const player = await getCharacter(username, broadcasterId);
    if (!player) {
      await sendChatMessage(
        `@${display} your character no longer exists.`,
        broadcasterId,
      );
      return true;
    }
    const pStats = combatStats(player);
    const playerHp = Number(active.player_hp ?? player.hpMax);
    const roll = 1 + Math.floor(Math.random() * 20);
    const toHitBonus = pStats.mod + player.proficiency + 1;
    const total = roll + toHitBonus;
    const critical = roll === 20;
    const hit = critical || (roll !== 1 && total >= Number(active.monster_ac));
    const dmgDie = 10;
    const dice = critical
      ? 1 + Math.floor(Math.random() * dmgDie) + 1 +
        Math.floor(Math.random() * dmgDie)
      : 1 + Math.floor(Math.random() * dmgDie);
    const damage = hit ? Math.max(1, dice + pStats.mod + 1) : 0;
    active.monster_hp = Math.max(0, Number(active.monster_hp) - damage);
    const playerResult =
      `${username} attacks ${active.monster_name}: d20 ${roll}${
        critical ? " CRITICAL" : ""
      } + ${toHitBonus} = ${total} vs AC ${active.monster_ac}; ${
        hit ? `hit for ${damage} damage` : "miss"
      }. ${duelNarration(critical ? "critical" : hit ? "hit" : "miss")}`;
    if (active.monster_hp <= 0) {
      await sqlite.execute(
        "DELETE FROM monster_duels WHERE broadcaster_id = ?",
        [broadcasterId],
      );
      const xp = await awardMonsterXp(
        username,
        String(active.monster_cr ?? "1"),
        broadcasterId,
      );
      const xpNote = xp
        ? ` +${xp.gained} XP (total ${xp.total})${
          xp.leveledTo ? ` — leveled to ${xp.leveledTo}!` : ""
        }`
        : "";
      await sendChatMessage(
        `@${display} ${playerResult} ${active.monster_name} is defeated! ${
          duelNarration("victory")
        }${xpNote}`,
        broadcasterId,
      );
      return true;
    }
    const monsterRoll = 1 + Math.floor(Math.random() * 20);
    const monsterTotal = monsterRoll + Number(active.monster_attack);
    const playerAc = 11 + pStats.mod + player.proficiency;
    const monsterHit = monsterRoll !== 1 &&
      (monsterRoll === 20 || monsterTotal >= playerAc);
    const monsterDice = 1 +
      Math.floor(Math.random() * Number(active.monster_damage_die));
    const monsterDamage = monsterHit
      ? Math.max(1, monsterDice + Number(active.monster_damage_bonus))
      : 0;
    const nextPlayerHp = Math.max(0, playerHp - monsterDamage);
    active.player_hp = nextPlayerHp;
    const monsterResult =
      `${active.monster_name} retaliates: d20 ${monsterRoll} + ${active.monster_attack} = ${monsterTotal} vs AC ${playerAc}; ${
        monsterHit ? `hit for ${monsterDamage} damage` : "miss"
      }. ${duelNarration(monsterHit ? "hit" : "miss")}`;
    if (nextPlayerHp <= 0) {
      await sqlite.execute(
        "DELETE FROM monster_duels WHERE broadcaster_id = ?",
        [broadcasterId],
      );
      await sendChatMessages(
        `@${display} ${playerResult} ${monsterResult} ${
          duelNarration("defeat")
        } ${active.monster_name} wins this encounter.`,
        broadcasterId,
      );
    } else {
      // Wrapped in withColumnHeal: this UPDATE is the exact query that's
      // intermittently failed with "no such column: player_hp" even though
      // ensureTables() is supposed to keep this column present — see the
      // comment on that migration in db.ts. This heals in place instead of
      // throwing and leaving the player mid-duel with no reply.
      await withColumnHeal("monster_duels", "player_hp", "INTEGER", () =>
        sqlite.execute(
          "UPDATE monster_duels SET player_hp = ?, monster_hp = ?, current_turn = ?, updated_at = ? WHERE broadcaster_id = ?",
          [nextPlayerHp, active.monster_hp, "player", Date.now(), broadcasterId],
        )
      );
      await sendChatMessages(
        `@${display} ${playerResult} ${monsterResult} ${await monsterDuelText({
          ...active,
          player_hp: nextPlayerHp,
        })}`,
        broadcasterId,
      );
    }
    return true;
  }

  return false;
}

export async function partySummary(broadcasterId: string, partyName: string) {
  const party = await getParty(broadcasterId, partyName);
  if (!party) return `party ${partyName} was not found`;
  const members = await getPartyMembers(broadcasterId, partyName);
  return `${party.party_name} (leader ${party.owner}): ${
    members.length ? members.join(", ") : "no members"
  }`;
}

export async function handlePartyCommand(
  chatMessage: string,
  username: string,
  display: string,
  broadcasterId: string,
) {
  if (!/^!party(?:\s|$)/i.test(chatMessage)) return false;
  // Twitch logins are case-insensitive; always normalize for storage/lookup.
  const me = username.toLowerCase();
  const parts = chatMessage.trim().split(/\s+/);
  const action = (parts[1] ?? "list").toLowerCase();
  const sanitizeParty = (raw: string) =>
    (raw ?? "").replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const name = sanitizeParty(parts[2] ?? "");

  if (action === "create") {
    if (!name) {
      await sendChatMessage(
        `@${display} use !party create <party-name>.`,
        broadcasterId,
      );
      return true;
    }
    if (await getParty(broadcasterId, name)) {
      await sendChatMessage(
        `@${display} that party already exists.`,
        broadcasterId,
      );
      return true;
    }
    // Creator is always owner AND a member so they can invite immediately.
    await sqlite.execute(
      "INSERT INTO parties (broadcaster_id,party_name,owner,created_at) VALUES (?,?,?,?)",
      [broadcasterId, name, me, Date.now()],
    );
    await sqlite.execute(
      "INSERT OR IGNORE INTO party_members (broadcaster_id,party_name,username,joined_at) VALUES (?,?,?,?)",
      [broadcasterId, name, me, Date.now()],
    );
    await sendChatMessage(
      `@${display} party ${name} created. You are the leader and a member. Invite with !party invite @user ${name}`,
      broadcasterId,
    );
    return true;
  }

  if (action === "join") {
    const party = await getParty(broadcasterId, name);
    if (!party) {
      await sendChatMessage(
        `@${display} party ${name} was not found.`,
        broadcasterId,
      );
    } else if (!(await getCharacter(me, broadcasterId))) {
      await sendChatMessage(
        `@${display} create a character before joining a party.`,
        broadcasterId,
      );
    } else {
      await sqlite.execute(
        "INSERT OR IGNORE INTO party_members (broadcaster_id,party_name,username,joined_at) VALUES (?,?,?,?)",
        [broadcasterId, name, me, Date.now()],
      );
      await sendChatMessage(`@${display} joined party ${name}.`, broadcasterId);
    }
    return true;
  }

  if (action === "leave") {
    if (!name) {
      await sendChatMessage(
        `@${display} use !party leave <party-name>.`,
        broadcasterId,
      );
      return true;
    }
    const party = await getParty(broadcasterId, name);
    if (!party) {
      await sendChatMessage(
        `@${display} party ${name} was not found.`,
        broadcasterId,
      );
    } else if (String(party.owner).toLowerCase() === me) {
      await sendChatMessage(
        `@${display} leaders must use !party disband ${name}.`,
        broadcasterId,
      );
    } else {
      await sqlite.execute(
        "DELETE FROM party_members WHERE broadcaster_id = ? AND party_name = ? AND username = ?",
        [broadcasterId, name, me],
      );
      await sendChatMessage(`@${display} left party ${name}.`, broadcasterId);
    }
    return true;
  }

  if (action === "invite") {
    const target = (parts[2] ?? "").replace(/^@/, "").toLowerCase().replace(
      /[,:]+$/,
      "",
    );
    let partyName = sanitizeParty(parts[3] ?? "");

    // If party name omitted, use a party this user owns (or is the only member of).
    if (target && !partyName) {
      const owned = await sqlite.execute(
        "SELECT party_name FROM parties WHERE broadcaster_id = ? AND lower(owner) = ? ORDER BY created_at ASC",
        [broadcasterId, me],
      );
      if (owned.rows.length === 1) {
        partyName = String(owned.rows[0].party_name);
      } else {
        const membership = await sqlite.execute(
          "SELECT party_name FROM party_members WHERE broadcaster_id = ? AND lower(username) = ? ORDER BY party_name",
          [broadcasterId, me],
        );
        if (membership.rows.length === 1) {
          partyName = String(membership.rows[0].party_name);
        }
      }
    }

    if (!target || !partyName) {
      await sendChatMessage(
        `@${display} use !party invite @user <party-name> (party name optional if you only lead/belong to one party).`,
        broadcasterId,
      );
      return true;
    }

    const party = await getParty(broadcasterId, partyName);
    if (!party) {
      await sendChatMessage(
        `@${display} party ${partyName} was not found.`,
        broadcasterId,
      );
      return true;
    }

    // Repair: if this user is the owner but missing from members, add them.
    const ownerName = String(party.owner).toLowerCase();
    if (ownerName === me) {
      await sqlite.execute(
        "INSERT OR IGNORE INTO party_members (broadcaster_id,party_name,username,joined_at) VALUES (?,?,?,?)",
        [broadcasterId, partyName, me, Date.now()],
      );
    }

    const members = (await getPartyMembers(broadcasterId, partyName)).map((m) =>
      m.toLowerCase()
    );
    const isOwner = ownerName === me;
    const isMember = members.includes(me);
    if (!isOwner && !isMember) {
      await sendChatMessage(
        `@${display} only a party member or the leader can invite someone to that party.`,
        broadcasterId,
      );
      return true;
    }
    if (target === me) {
      await sendChatMessage(
        `@${display} you are already in party ${partyName}.`,
        broadcasterId,
      );
      return true;
    }
    if (!(await getCharacter(target, broadcasterId))) {
      await sendChatMessage(
        `@${display} that player needs a saved character first.`,
        broadcasterId,
      );
      return true;
    }
    // Require the invitee's consent — don't add them straight to the roster.
    await createPartyInvite(broadcasterId, partyName, target, me);
    await sendChatMessage(
      `@${display} invited @${target} to party ${partyName}. @${target}: reply !party accept${
        partyName ? ` ${partyName}` : ""
      } or !party decline${partyName ? ` ${partyName}` : ""}.`,
      broadcasterId,
    );
    return true;
  }

  if (action === "accept" || action === "decline") {
    let partyName = sanitizeParty(parts[2] ?? "");
    if (!partyName) {
      const invites = await getPartyInvites(broadcasterId, me);
      if (invites.length === 1) {
        partyName = String(invites[0].party_name);
      } else if (invites.length > 1) {
        await sendChatMessage(
          `@${display} you have pending invites to: ${
            invites.map((i: any) => i.party_name).join(", ")
          }. Use !party ${action} <party-name>.`,
          broadcasterId,
        );
        return true;
      }
    }
    if (!partyName) {
      await sendChatMessage(
        `@${display} you have no pending party invites.`,
        broadcasterId,
      );
      return true;
    }
    const invite = await getPartyInvite(broadcasterId, me, partyName);
    if (!invite) {
      await sendChatMessage(
        `@${display} you have no pending invite to party ${partyName}.`,
        broadcasterId,
      );
      return true;
    }
    await deletePartyInvite(broadcasterId, partyName, me);
    if (action === "decline") {
      await sendChatMessage(
        `@${display} declined the invite to party ${partyName}.`,
        broadcasterId,
      );
      return true;
    }
    const party = await getParty(broadcasterId, partyName);
    if (!party) {
      await sendChatMessage(
        `@${display} party ${partyName} no longer exists.`,
        broadcasterId,
      );
      return true;
    }
    await sqlite.execute(
      "INSERT OR IGNORE INTO party_members (broadcaster_id,party_name,username,joined_at) VALUES (?,?,?,?)",
      [broadcasterId, partyName, me, Date.now()],
    );
    await sendChatMessage(
      `@${display} joined party ${partyName}.`,
      broadcasterId,
    );
    return true;
  }

  if (action === "disband") {
    const party = await getParty(broadcasterId, name);
    if (!party) {
      await sendChatMessage(
        `@${display} party ${name} was not found.`,
        broadcasterId,
      );
    } else if (String(party.owner).toLowerCase() !== me) {
      await sendChatMessage(
        `@${display} only the party leader can disband that party.`,
        broadcasterId,
      );
    } else {
      await sqlite.execute(
        "DELETE FROM party_members WHERE broadcaster_id = ? AND party_name = ?",
        [
          broadcasterId,
          name,
        ],
      );
      await sqlite.execute(
        "DELETE FROM parties WHERE broadcaster_id = ? AND party_name = ?",
        [
          broadcasterId,
          name,
        ],
      );
      await sendChatMessage(
        `@${display} party ${name} disbanded.`,
        broadcasterId,
      );
    }
    return true;
  }

  if (action === "list" || action === "show") {
    if (name) {
      await sendChatMessages(
        `@${display} ${await partySummary(broadcasterId, name)}.`,
        broadcasterId,
      );
    } else {
      const res = await sqlite.execute(
        "SELECT party_name FROM party_members WHERE broadcaster_id = ? AND lower(username) = ? ORDER BY party_name",
        [broadcasterId, me],
      );
      if (!res.rows.length) {
        await sendChatMessage(
          `@${display} you are not in any parties. Create one with !party create <name>.`,
          broadcasterId,
        );
      } else {
        const summaries: string[] = [];
        for (const row of res.rows) {
          summaries.push(
            await partySummary(broadcasterId, String(row.party_name)),
          );
        }
        await sendChatMessages(
          `@${display} your parties — ${summaries.join(" | ")}`,
          broadcasterId,
        );
      }
    }
    return true;
  }

  await sendChatMessage(
    `@${display} Party: !party create <name> | !party join <name> | !party invite @user <name> | !party accept/decline [name] | !party list [name] | !party leave <name> | !party disband <name>.`,
    broadcasterId,
  );
  return true;
}

export async function partyDuelText(d: any) {
  const left = d.challenger_members.map((n: string) =>
    `${n} ${d.challenger_hp[n] ?? 0} HP`
  ).join(", ");
  const right = d.defender_members.map((n: string) =>
    `${n} ${d.defender_hp[n] ?? 0} HP`
  ).join(", ");
  const active = d.current_side === "challenger"
    ? d.challenger_members[d.current_index]
    : d.defender_members[d.current_index];
  return `Party duel ${d.challenger_party} [${left}] vs ${d.defender_party} [${right}]. Turn: ${
    active ?? "none"
  }.`;
}

export async function handlePartyDuelCommand(
  chatMessage: string,
  username: string,
  display: string,
  broadcasterId: string,
) {
  if (!/^!dndduel\s+party(?:\s|$)/i.test(chatMessage)) return false;
  const parts = chatMessage.trim().split(/\s+/);
  const sub = (parts[2] ?? "").toLowerCase();
  let active = await getPartyDuel(broadcasterId);
  if (await forfeitIfIdlePartyDuel(broadcasterId, active)) active = null;
  const me = username.toLowerCase();

  // ── Party vs monster (hunt): party fights one scaled monster together ──
  // !dndduel party hunt <party>              → auto
  // !dndduel party hunt classic <party>      → turn-based
  // !dndduel party hunt attack|status|end
  if (sub === "hunt") {
    const huntAction = (parts[3] ?? "").toLowerCase();
    let partyHunt = await getPartyMonsterDuel(broadcasterId);
    if (await forfeitIfIdlePartyHunt(broadcasterId, partyHunt)) partyHunt = null;

    if (huntAction === "status" || huntAction === "show") {
      if (!partyHunt) {
        await sendChatMessage(
          `@${display} no active party hunt. Start with !dndduel party hunt <party-name>.`,
          broadcasterId,
        );
        return true;
      }
      const roster = partyHunt.members
        .map((n: string) => `${n} ${partyHunt.member_hp[n] ?? 0}HP`)
        .join(", ");
      const turn = partyHunt.members[partyHunt.current_index] ?? "?";
      await sendChatMessage(
        `@${display} Party hunt ${partyHunt.party_name} vs ${partyHunt.monster_name} (CR ${partyHunt.monster_cr}) HP ${partyHunt.monster_hp}/${partyHunt.monster_hp_max} AC ${partyHunt.monster_ac}. Party: [${roster}]. Turn: ${turn}.`,
        broadcasterId,
      );
      return true;
    }

    if (huntAction === "end" || huntAction === "cancel") {
      if (!partyHunt) {
        await sendChatMessage(
          `@${display} no active party hunt.`,
          broadcasterId,
        );
        return true;
      }
      if (!partyHunt.members.map((m: string) => m.toLowerCase()).includes(me)) {
        await sendChatMessage(
          `@${display} only a hunting party member can end this hunt.`,
          broadcasterId,
        );
        return true;
      }
      await sqlite.execute(
        "DELETE FROM party_monster_duels WHERE broadcaster_id = ?",
        [broadcasterId],
      );
      await sendChatMessage(
        `@${display} party hunt ended. The party retreats.`,
        broadcasterId,
      );
      return true;
    }

    if (huntAction === "attack") {
      if (!partyHunt) {
        await sendChatMessage(
          `@${display} no active party hunt. Start with !dndduel party hunt classic <party-name>.`,
          broadcasterId,
        );
        return true;
      }
      const attackerName = partyHunt.members[partyHunt.current_index];
      if (!attackerName || attackerName.toLowerCase() !== me) {
        await sendChatMessage(
          `@${display} it is ${attackerName ?? "someone else"}'s turn.`,
          broadcasterId,
        );
        return true;
      }
      if ((partyHunt.member_hp[attackerName] ?? 0) <= 0) {
        await sendChatMessage(
          `@${display} you are down and cannot attack.`,
          broadcasterId,
        );
        return true;
      }
      const attacker = await getCharacter(attackerName, broadcasterId);
      if (!attacker) {
        await sendChatMessage(
          `@${display} your character no longer exists.`,
          broadcasterId,
        );
        return true;
      }
      const stats = combatStats(attacker);
      const roll = 1 + Math.floor(Math.random() * 20);
      const total = roll + stats.mod + attacker.proficiency;
      const critical = roll === 20;
      const hit = critical ||
        (roll !== 1 && total >= Number(partyHunt.monster_ac));
      const dice = critical
        ? 1 + Math.floor(Math.random() * 8) + 1 + Math.floor(Math.random() * 8)
        : 1 + Math.floor(Math.random() * 8);
      const damage = hit ? Math.max(1, dice + stats.mod) : 0;
      partyHunt.monster_hp = Math.max(0, Number(partyHunt.monster_hp) - damage);
      const playerResult =
        `${attackerName} attacks ${partyHunt.monster_name}: d20 ${roll}${
          critical ? " CRITICAL" : ""
        } + ${
          stats.mod + attacker.proficiency
        } = ${total} vs AC ${partyHunt.monster_ac}; ${
          hit ? `hit for ${damage}` : "miss"
        }. ${duelNarration(critical ? "critical" : hit ? "hit" : "miss")}`;

      if (partyHunt.monster_hp <= 0) {
        await sqlite.execute(
          "DELETE FROM party_monster_duels WHERE broadcaster_id = ?",
          [broadcasterId],
        );
        const xpNotes: string[] = [];
        for (const n of partyHunt.members) {
          if ((partyHunt.member_hp[n] ?? 0) > 0) {
            const xp = await awardMonsterXp(
              n,
              String(partyHunt.monster_cr),
              broadcasterId,
            );
            if (xp) xpNotes.push(`${n}+${xp.gained}`);
          }
        }
        await sendChatMessages(
          `@${display} ${playerResult} ${partyHunt.monster_name} falls! ${
            duelNarration("victory")
          } XP: ${xpNotes.join(", ") || "none"}.`,
          broadcasterId,
        );
        return true;
      }

      // Monster strikes a random living party member after each player attack
      const living = partyHunt.members.filter((n: string) =>
        (partyHunt.member_hp[n] ?? 0) > 0
      );
      const targetName = living[Math.floor(Math.random() * living.length)] ??
        attackerName;
      const targetChar = await getCharacter(targetName, broadcasterId);
      const tStats = targetChar
        ? combatStats(targetChar)
        : { mod: 0, attack: 10 };
      const playerAc = 10 + tStats.mod + (targetChar?.proficiency ?? 2);
      const mRoll = 1 + Math.floor(Math.random() * 20);
      const mTotal = mRoll + Number(partyHunt.monster_attack);
      const mHit = mRoll !== 1 && (mRoll === 20 || mTotal >= playerAc);
      const mDice = 1 +
        Math.floor(Math.random() * Number(partyHunt.monster_damage_die));
      const mDamage = mHit
        ? Math.max(1, mDice + Number(partyHunt.monster_damage_bonus))
        : 0;
      if (mHit) {
        partyHunt.member_hp[targetName] = Math.max(
          0,
          (partyHunt.member_hp[targetName] ?? 0) - mDamage,
        );
      }
      const monsterResult =
        `${partyHunt.monster_name} strikes ${targetName}: d20 ${mRoll} + ${partyHunt.monster_attack} = ${mTotal} vs AC ${playerAc}; ${
          mHit ? `hit for ${mDamage}` : "miss"
        }.`;

      const stillAlive = partyHunt.members.some((n: string) =>
        (partyHunt.member_hp[n] ?? 0) > 0
      );
      if (!stillAlive) {
        await sqlite.execute(
          "DELETE FROM party_monster_duels WHERE broadcaster_id = ?",
          [broadcasterId],
        );
        await sendChatMessages(
          `@${display} ${playerResult} ${monsterResult} ${
            duelNarration("defeat")
          } The party is wiped.`,
          broadcasterId,
        );
        return true;
      }

      // Advance to next living member
      let idx = partyHunt.current_index;
      for (let i = 0; i < partyHunt.members.length; i++) {
        idx = (idx + 1) % partyHunt.members.length;
        if ((partyHunt.member_hp[partyHunt.members[idx]] ?? 0) > 0) break;
      }
      partyHunt.current_index = idx;
      await sqlite.execute(
        "UPDATE party_monster_duels SET member_hp = ?, monster_hp = ?, current_index = ?, updated_at = ? WHERE broadcaster_id = ?",
        [
          JSON.stringify(partyHunt.member_hp),
          partyHunt.monster_hp,
          partyHunt.current_index,
          Date.now(),
          broadcasterId,
        ],
      );
      const roster = partyHunt.members.map((n: string) =>
        `${n} ${partyHunt.member_hp[n]}HP`
      ).join(", ");
      await sendChatMessages(
        `@${display} ${playerResult} ${monsterResult} Monster HP ${partyHunt.monster_hp}/${partyHunt.monster_hp_max}. Party: [${roster}]. Next: ${
          partyHunt.members[partyHunt.current_index]
        }.`,
        broadcasterId,
      );
      return true;
    }

    // Start hunt: !dndduel party hunt [classic] <party-name>
    let classic = false;
    let partyName = "";
    if (
      huntAction === "classic" || huntAction === "turn" ||
      huntAction === "manual"
    ) {
      classic = true;
      partyName = (parts[4] ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
    } else {
      partyName = huntAction.replace(/[^a-z0-9_-]/g, "");
    }
    if (!partyName) {
      await sendChatMessage(
        `@${display} Party hunt: !dndduel party hunt <party> (auto) | !dndduel party hunt classic <party> | !dndduel party hunt attack | status | end`,
        broadcasterId,
      );
      return true;
    }
    if (partyHunt) {
      await sendChatMessage(
        `@${display} a party hunt is already active. Use !dndduel party hunt status or end.`,
        broadcasterId,
      );
      return true;
    }
    const party = await getParty(broadcasterId, partyName);
    const members = await getPartyMembers(broadcasterId, partyName);
    if (!party || !members.length) {
      await sendChatMessage(
        `@${display} party ${partyName} was not found or has no members.`,
        broadcasterId,
      );
      return true;
    }
    if (
      String(party.owner).toLowerCase() !== me &&
      !members.map((m) => m.toLowerCase()).includes(me)
    ) {
      await sendChatMessage(
        `@${display} only a party member can start a hunt for that party.`,
        broadcasterId,
      );
      return true;
    }

    const chars: Record<string, any> = {};
    const memberHp: Record<string, number> = {};
    let levelSum = 0;
    for (const n of members) {
      const c = await getCharacter(n, broadcasterId);
      if (c) {
        chars[n] = c;
        memberHp[n] = c.hpMax;
        levelSum += c.level;
      }
    }
    const livingMembers = members.filter((n) => chars[n]);
    if (livingMembers.length < 1) {
      await sendChatMessage(
        `@${display} at least one party member needs a saved character.`,
        broadcasterId,
      );
      return true;
    }
    const avgLevel = Math.max(1, Math.round(levelSum / livingMembers.length));
    // Scale monster gently for group size (still player-favored).
    const monster = pickMonsterForLevel(avgLevel);
    const sizeScale = 0.5 + livingMembers.length * 0.22; // 1p~0.72, 2p~0.94, 3p~1.16
    monster.hp = Math.max(10, Math.round(monster.hp * sizeScale));
    monster.attack = Math.max(
      2,
      monster.attack + Math.floor((livingMembers.length - 1) / 3),
    );

    if (!classic) {
      // Auto-resolve: each living member attacks, then monster hits a random member
      let monsterHp = monster.hp;
      const hp = { ...memberHp };
      const highlights: string[] = [];
      let swings = 0;
      const maxSwings = 100;
      while (
        monsterHp > 0 && livingMembers.some((n) => hp[n] > 0) &&
        swings < maxSwings
      ) {
        swings++;
        for (const n of livingMembers) {
          if (hp[n] <= 0 || monsterHp <= 0) continue;
          const stats = combatStats(chars[n]);
          const roll = 1 + Math.floor(Math.random() * 20);
          const total = roll + stats.mod + chars[n].proficiency;
          const critical = roll === 20;
          const hit = critical || (roll !== 1 && total >= monster.ac);
          const dice = critical
            ? 1 + Math.floor(Math.random() * 8) + 1 +
              Math.floor(Math.random() * 8)
            : 1 + Math.floor(Math.random() * 8);
          const damage = hit ? Math.max(1, dice + stats.mod) : 0;
          if (hit) monsterHp = Math.max(0, monsterHp - damage);
          if (critical || monsterHp <= 0 || highlights.length < 10) {
            highlights.push(
              hit ? `${n}${critical ? " CRIT" : ""} ${damage}` : `${n} miss`,
            );
          }
        }
        if (monsterHp <= 0) break;
        const living = livingMembers.filter((n) => hp[n] > 0);
        if (!living.length) break;
        const victim = living[Math.floor(Math.random() * living.length)];
        const vStats = combatStats(chars[victim]);
        const playerAc = 10 + vStats.mod + chars[victim].proficiency;
        const mRoll = 1 + Math.floor(Math.random() * 20);
        const mTotal = mRoll + monster.attack;
        const mHit = mRoll !== 1 && (mRoll === 20 || mTotal >= playerAc);
        const mDice = 1 + Math.floor(Math.random() * monster.die);
        const mDamage = mHit ? Math.max(1, mDice + monster.bonus) : 0;
        if (mHit) hp[victim] = Math.max(0, hp[victim] - mDamage);
        if (mRoll === 20 || hp[victim] <= 0 || highlights.length < 14) {
          highlights.push(
            mHit
              ? `${monster.name}→${victim} ${mDamage}`
              : `${monster.name} miss`,
          );
        }
      }
      const partyWon = monsterHp <= 0 && livingMembers.some((n) => hp[n] > 0);
      const xpNotes: string[] = [];
      if (partyWon) {
        for (const n of livingMembers) {
          if (hp[n] > 0) {
            const xp = await awardMonsterXp(n, monster.cr, broadcasterId);
            if (xp) {
              xpNotes.push(
                `${n}+${xp.gained}${xp.leveledTo ? `→Lv${xp.leveledTo}` : ""}`,
              );
            }
          }
        }
      }
      const roster = livingMembers.map((n) => `${n}:${hp[n]}`).join(", ");
      await sendChatMessages(
        `@${display} party ${partyName} hunts a ${monster.name} (CR ${monster.cr}, AC ${monster.ac}, HP ${monster.hp})! ${
          duelNarration("challenge")
        } Auto (${swings} rounds): ${highlights.join(" · ")} — ${
          partyWon
            ? `Victory! ${duelNarration("victory")} XP: ${xpNotes.join(", ")}`
            : `Defeat. ${duelNarration("defeat")}`
        } Final party HP [${roster}]; monster ${monsterHp}/${monster.hp}.`,
        broadcasterId,
      );
      return true;
    }

    // Classic party hunt
    await sqlite.execute(
      "INSERT OR REPLACE INTO party_monster_duels (broadcaster_id,party_name,members,member_hp,current_index,monster_name,monster_cr,monster_ac,monster_hp,monster_hp_max,monster_attack,monster_damage_die,monster_damage_bonus,active,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)",
      [
        broadcasterId,
        partyName,
        JSON.stringify(livingMembers),
        JSON.stringify(
          Object.fromEntries(livingMembers.map((n) => [n, memberHp[n]])),
        ),
        0,
        monster.name,
        monster.cr,
        monster.ac,
        monster.hp,
        monster.hp,
        monster.attack,
        monster.die,
        monster.bonus,
        Date.now(),
      ],
    );
    await sendChatMessage(
      `@${display} classic party hunt! ${partyName} vs ${monster.name} (CR ${monster.cr}) AC ${monster.ac}, HP ${monster.hp}. ${
        livingMembers[0]
      } goes first. ${
        duelNarration("challenge")
      } Use !dndduel party hunt attack.`,
      broadcasterId,
    );
    return true;
  }

  if (sub === "accept" || sub === "decline") {
    const res = await sqlite.execute(
      "SELECT * FROM party_duel_challenges WHERE broadcaster_id = ? AND defender_owner = ? ORDER BY created_at DESC LIMIT 1",
      [broadcasterId, username],
    );
    if (!res.rows.length) {
      await sendChatMessage(
        `@${display} no party duel challenge is waiting for you.`,
        broadcasterId,
      );
      return true;
    }
    const challenge = res.rows[0];
    await sqlite.execute(
      "DELETE FROM party_duel_challenges WHERE broadcaster_id = ? AND defender_owner = ?",
      [
        broadcasterId,
        username,
      ],
    );
    if (isChallengeExpired(challenge.created_at)) {
      await sendChatMessage(
        `@${display} that party duel challenge from ${challenge.challenger_party} expired after 5 minutes — ask for a new one with !dndduel party <yours> <theirs>.`,
        broadcasterId,
      );
      return true;
    }
    const mode = String(challenge.mode || "auto").toLowerCase() === "classic"
      ? "classic"
      : "auto";
    if (sub === "decline") {
      await sendChatMessage(
        `@${display} party duel declined. ${duelNarration("decline")}`,
        broadcasterId,
      );
      return true;
    }
    const attackers = await getPartyMembers(
      broadcasterId,
      challenge.challenger_party,
    );
    const defenders = await getPartyMembers(
      broadcasterId,
      challenge.defender_party,
    );
    const aChars: Record<string, any> = {};
    const dChars: Record<string, any> = {};
    const aHp: Record<string, number> = {};
    const dHp: Record<string, number> = {};
    for (const n of attackers) {
      const c = await getCharacter(n, broadcasterId);
      if (c) {
        aChars[n] = c;
        aHp[n] = c.hpMax;
      }
    }
    for (const n of defenders) {
      const c = await getCharacter(n, broadcasterId);
      if (c) {
        dChars[n] = c;
        dHp[n] = c.hpMax;
      }
    }
    if (
      !attackers.length ||
      !defenders.length ||
      Object.keys(aHp).length !== attackers.length ||
      Object.keys(dHp).length !== defenders.length
    ) {
      await sendChatMessage(
        `@${display} both parties need at least one member with a saved character.`,
        broadcasterId,
      );
      return true;
    }

    if (mode === "classic") {
      await sqlite.execute(
        "INSERT OR REPLACE INTO party_duels (broadcaster_id,challenger_party,defender_party,current_side,current_index,challenger_members,defender_members,challenger_hp,defender_hp,active,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)",
        [
          broadcasterId,
          challenge.challenger_party,
          challenge.defender_party,
          "challenger",
          0,
          JSON.stringify(attackers),
          JSON.stringify(defenders),
          JSON.stringify(aHp),
          JSON.stringify(dHp),
          Date.now(),
        ],
      );
      await sendChatMessage(
        `@${display} classic party duel accepted! ${challenge.challenger_party} goes first. ${
          duelNarration("accept")
        } Use !dndduel party attack [@target].`,
        broadcasterId,
      );
      return true;
    }

    // Auto-resolve party duel
    const highlights: string[] = [];
    let side: "challenger" | "defender" = "challenger";
    let swings = 0;
    const maxSwings = 80;
    while (
      attackers.some((n) => aHp[n] > 0) &&
      defenders.some((n) => dHp[n] > 0) &&
      swings < maxSwings
    ) {
      swings++;
      const atkMembers = side === "challenger" ? attackers : defenders;
      const atkHp = side === "challenger" ? aHp : dHp;
      const atkChars = side === "challenger" ? aChars : dChars;
      const defMembers = side === "challenger" ? defenders : attackers;
      const defHp = side === "challenger" ? dHp : aHp;
      const defChars = side === "challenger" ? dChars : aChars;
      const attackerName = atkMembers.find((n) => atkHp[n] > 0);
      const defenderName = defMembers.find((n) => defHp[n] > 0);
      if (!attackerName || !defenderName) break;
      const line = simulateAttack(
        attackerName,
        defenderName,
        atkChars[attackerName],
        defChars[defenderName],
        defHp,
      );
      if (
        line.includes("CRIT") || defHp[defenderName] <= 0 ||
        highlights.length < 8
      ) {
        highlights.push(line);
      }
      side = side === "challenger" ? "defender" : "challenger";
    }
    const challengerAlive = attackers.some((n) => aHp[n] > 0);
    const winnerParty = challengerAlive
      ? challenge.challenger_party
      : challenge.defender_party;
    const left = attackers.map((n) => `${n}:${aHp[n]}`).join(",");
    const right = defenders.map((n) => `${n}:${dHp[n]}`).join(",");
    await sqlite.execute("DELETE FROM party_duels WHERE broadcaster_id = ?", [
      broadcasterId,
    ]);
    await sendChatMessages(
      `@${display} party duel accepted! ${
        duelNarration("accept")
      } ${challenge.challenger_party} vs ${challenge.defender_party} auto-resolved (${swings} swings). ${
        highlights.join(" · ")
      } — ${winnerParty} wins! ${
        duelNarration("victory")
      } HP [${left}] vs [${right}]`,
      broadcasterId,
    );
    return true;
  }

  if (sub === "status" || sub === "show") {
    active = active ?? null;
    await sendChatMessage(
      active
        ? `@${display} ${await partyDuelText(active)}`
        : `@${display} no active party duel.`,
      broadcasterId,
    );
    return true;
  }

  if (sub === "end") {
    if (!active) {
      await sendChatMessage(`@${display} no active party duel.`, broadcasterId);
    } else {
      const all = [...active.challenger_members, ...active.defender_members];
      const member = all.includes(username);
      const ownerA =
        (await getParty(broadcasterId, active.challenger_party))?.owner ===
          username;
      const ownerB =
        (await getParty(broadcasterId, active.defender_party))?.owner ===
          username;
      if (!member && !ownerA && !ownerB) {
        await sendChatMessage(
          `@${display} only a party member or leader can end this duel.`,
          broadcasterId,
        );
      } else {
        await sqlite.execute(
          "DELETE FROM party_duels WHERE broadcaster_id = ?",
          [broadcasterId],
        );
        await sendChatMessage(`@${display} party duel ended.`, broadcasterId);
      }
    }
    return true;
  }

  if (sub === "attack") {
    if (!active) {
      await sendChatMessage(`@${display} no active party duel.`, broadcasterId);
      return true;
    }
    const members = active.current_side === "challenger"
      ? active.challenger_members
      : active.defender_members;
    const ownHp = active.current_side === "challenger"
      ? active.challenger_hp
      : active.defender_hp;
    const enemyMembers = active.current_side === "challenger"
      ? active.defender_members
      : active.challenger_members;
    const enemyHp = active.current_side === "challenger"
      ? active.defender_hp
      : active.challenger_hp;
    const attackerName = members[active.current_index];
    if (attackerName !== username) {
      await sendChatMessage(
        `@${display} it is ${attackerName}'s turn.`,
        broadcasterId,
      );
      return true;
    }
    const attacker = await getCharacter(attackerName, broadcasterId);
    const targetQuery = parts[3]?.replace(/^@/, "").toLowerCase();
    const targetName =
      targetQuery && enemyMembers.includes(targetQuery) &&
        enemyHp[targetQuery] > 0
        ? targetQuery
        : enemyMembers.find((n: string) => enemyHp[n] > 0);
    const target = targetName
      ? await getCharacter(targetName, broadcasterId)
      : null;
    if (!attacker || !target || !targetName) {
      await sendChatMessage(
        `@${display} no living target remains.`,
        broadcasterId,
      );
      return true;
    }
    const stats = combatStats(attacker);
    const targetStats = combatStats(target);
    const roll = 1 + Math.floor(Math.random() * 20);
    const total = roll + stats.mod + attacker.proficiency;
    const critical = roll === 20;
    const hit = critical || (roll !== 1 && total >= targetStats.attack);
    const dice = critical
      ? 1 + Math.floor(Math.random() * 8) + (1 + Math.floor(Math.random() * 8))
      : 1 + Math.floor(Math.random() * 8);
    const damage = hit ? Math.max(1, dice + stats.mod) : 0;
    enemyHp[targetName] = Math.max(0, enemyHp[targetName] - damage);
    const result = `${attackerName} rolled ${roll}${
      critical ? " CRITICAL" : ""
    } + ${
      stats.mod + attacker.proficiency
    } = ${total} vs AC ${targetStats.attack}: ${
      hit ? `hit ${targetName} for ${damage} damage` : "miss"
    }. ${duelNarration(critical ? "critical" : hit ? "hit" : "miss")}`;
    const defeated = enemyMembers.every((n: string) => Number(enemyHp[n]) <= 0);
    if (defeated) {
      const winner = active.current_side === "challenger"
        ? active.challenger_party
        : active.defender_party;
      await sqlite.execute("DELETE FROM party_duels WHERE broadcaster_id = ?", [
        broadcasterId,
      ]);
      await sendChatMessage(
        `@${display} ${result} ${winner} wins the party duel! ${
          duelNarration("victory")
        }`,
        broadcasterId,
      );
    } else {
      const nextSide = active.current_side === "challenger"
        ? "defender"
        : "challenger";
      const nextMembers = nextSide === "challenger"
        ? active.challenger_members
        : active.defender_members;
      const nextHp = nextSide === "challenger"
        ? active.challenger_hp
        : active.defender_hp;
      active.current_side = nextSide;
      active.current_index = firstAlive(nextMembers, nextHp);
      await sqlite.execute(
        "UPDATE party_duels SET current_side = ?, current_index = ?, challenger_hp = ?, defender_hp = ?, updated_at = ? WHERE broadcaster_id = ?",
        [
          active.current_side,
          active.current_index,
          JSON.stringify(active.challenger_hp),
          JSON.stringify(active.defender_hp),
          Date.now(),
          broadcasterId,
        ],
      );
      await sendChatMessages(
        `@${display} ${result} ${await partyDuelText(active)}`,
        broadcasterId,
      );
    }
    return true;
  }

  // Challenge: !dndduel party <yours> <theirs> (auto)
  //            !dndduel party classic <yours> <theirs> (turn-based)
  let partyMode: "auto" | "classic" = "auto";
  let challengerParty = "";
  let defenderParty = "";
  const p2 = (parts[2] ?? "").toLowerCase();
  const p3 = (parts[3] ?? "").toLowerCase();
  const p4 = (parts[4] ?? "").toLowerCase();
  if (p2 === "classic" || p2 === "turn" || p2 === "manual") {
    partyMode = "classic";
    challengerParty = p3;
    defenderParty = p4;
  } else if (p2 === "auto" || p2 === "quick") {
    partyMode = "auto";
    challengerParty = p3;
    defenderParty = p4;
  } else {
    challengerParty = p2;
    defenderParty = p3;
  }
  if (!challengerParty || !defenderParty) {
    await sendChatMessage(
      `@${display} Party duels: !dndduel party <yours> <theirs> (auto) | !dndduel party classic <yours> <theirs> (turn-based) | !dndduel party accept | !dndduel party decline`,
      broadcasterId,
    );
    return true;
  }
  if (active) {
    await sendChatMessage(
      `@${display} a classic party duel is already active in this channel.`,
      broadcasterId,
    );
    return true;
  }
  const ownParty = await getParty(broadcasterId, challengerParty);
  const targetParty = await getParty(broadcasterId, defenderParty);
  const ownMembers = ownParty
    ? await getPartyMembers(broadcasterId, challengerParty)
    : [];
  if (
    !ownParty || !targetParty ||
    String(ownParty.owner).toLowerCase() !== username.toLowerCase() ||
    !ownMembers.length
  ) {
    await sendChatMessage(
      `@${display} you must lead a non-empty party, and both parties must exist.`,
      broadcasterId,
    );
    return true;
  }
  if (String(targetParty.owner).toLowerCase() === username.toLowerCase()) {
    await sendChatMessage(
      `@${display} you cannot challenge your own party.`,
      broadcasterId,
    );
    return true;
  }
  await sqlite.execute(
    "INSERT OR REPLACE INTO party_duel_challenges (broadcaster_id,challenger_party,defender_party,challenger_owner,defender_owner,created_at,mode) VALUES (?,?,?,?,?,?,?)",
    [
      broadcasterId,
      challengerParty,
      defenderParty,
      username,
      targetParty.owner,
      Date.now(),
      partyMode,
    ],
  );
  await sendChatMessage(
    `@${display} party ${challengerParty} challenged party ${defenderParty} to a ${
      partyMode === "classic" ? "classic turn-based" : "quick auto"
    } duel! ${
      duelNarration("challenge")
    } @${targetParty.owner}, use !dndduel party accept or !dndduel party decline within 5 minutes.`,
    broadcasterId,
  );
  return true;
}

export function encounterText(e: any) {
  const order = e.entries
    .map((x: any, i: number) =>
      `${
        i === e.currentIndex && e.active ? "▶" : "•"
      } ${x.name} ${x.initiative}`
    )
    .join(" | ");
  return `Initiative R${e.round}: ${order || "no combatants"}`;
}

export async function handleInitiativeCommand(
  chatMessage: string,
  broadcasterId: string,
  display: string,
  isModerator: boolean,
  username: string,
) {
  if (!chatMessage.toLowerCase().startsWith("!turn")) return false;
  const parts = chatMessage.trim().split(/\s+/);
  const action = (parts[1] ?? "show").toLowerCase();

  // Everyone can roll their own initiative; every other action stays mod-only.
  if (action !== "roll" && !isModerator) {
    await sendChatMessage(
      `@${display} only the broadcaster or a moderator can manage initiative.`,
      broadcasterId,
    );
    return true;
  }
  let e = await getEncounter(broadcasterId);

  if (action === "start") {
    e = { broadcasterId, round: 1, currentIndex: 0, active: true, entries: [] };
    await saveEncounter(e);
    await sendChatMessage(
      `@${display} combat started! Everyone type !turn roll to roll for initiative. Add monsters/NPCs with !turn add <name> <initiative>.`,
      broadcasterId,
    );
    return true;
  }

  if (action === "end" || action === "clear") {
    if (e) {
      await sqlite.execute("DELETE FROM encounters WHERE broadcaster_id = ?", [
        broadcasterId,
      ]);
    }
    await sendChatMessage(
      `@${display} combat ended and initiative cleared.`,
      broadcasterId,
    );
    return true;
  }

  if (!e || !e.active) {
    await sendChatMessage(
      `@${display} no active encounter. ${isModerator ? "Start one with !turn start." : "Ask a moderator to start one with !turn start."}`,
      broadcasterId,
    );
    return true;
  }

  if (action === "roll") {
    const existing = e.entries.find((x: any) => x.name.toLowerCase() === username.toLowerCase());
    if (existing?.rolled) {
      await sendChatMessage(
        `@${display} you already rolled ${existing.initiative} for initiative this encounter.`,
        broadcasterId,
      );
      return true;
    }
    const character = await getCharacter(username, broadcasterId);
    const dex = character ? modifier(character.scores.DEX) : 0;
    const d20 = 1 + Math.floor(Math.random() * 20);
    const initiative = d20 + dex;
    if (existing) {
      existing.initiative = initiative;
      existing.dex = dex;
      existing.rolled = true;
    } else {
      e.entries.push({ name: username, initiative, dex, rolled: true });
    }
    e.entries.sort((a: any, b: any) => b.initiative - a.initiative || (b.dex ?? 0) - (a.dex ?? 0));
    e.currentIndex = 0;
    await saveEncounter(e);
    await sendChatMessages(
      `@${display} rolled ${d20}${dex ? (dex > 0 ? `+${dex}` : dex) : ""} = ${initiative} for initiative! ${encounterText(e)}`,
      broadcasterId,
    );
    return true;
  }

  if (action === "add") {
    const match = chatMessage.match(/^!turn\s+add\s+(.+?)\s+(\d+)$/i);
    const initiative = match ? Number(match[2]) : NaN;
    if (
      !match || !Number.isInteger(initiative) || initiative < 0 ||
      initiative > 50
    ) {
      await sendChatMessage(
        `@${display} use !turn add <name> <initiative>, such as !turn add Goblin 15.`,
        broadcasterId,
      );
      return true;
    }
    const name = match[1].replace(/^@/, "").trim();
    const existing = e.entries.find((x: any) =>
      x.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) existing.initiative = initiative;
    else e.entries.push({ name, initiative });
    e.entries.sort((a: any, b: any) => b.initiative - a.initiative);
    e.currentIndex = 0;
    await saveEncounter(e);
    await sendChatMessages(`@${display} ${encounterText(e)}`, broadcasterId);
    return true;
  }

  if (action === "remove") {
    const name = parts.slice(2).join(" ").replace(/^@/, "");
    e.entries = e.entries.filter((x: any) =>
      x.name.toLowerCase() !== name.toLowerCase()
    );
    e.currentIndex = Math.min(
      e.currentIndex,
      Math.max(0, e.entries.length - 1),
    );
    await saveEncounter(e);
    await sendChatMessages(`@${display} ${encounterText(e)}`, broadcasterId);
    return true;
  }

  if (action === "next" || action === "prev") {
    if (!e.entries.length) {
      await sendChatMessage(
        `@${display} add combatants first with !turn add <name> <initiative>.`,
        broadcasterId,
      );
      return true;
    }
    const step = action === "next" ? 1 : -1;
    const nextIndex = e.currentIndex + step;
    if (nextIndex >= e.entries.length) {
      e.currentIndex = 0;
      e.round += 1;
    } else if (nextIndex < 0) {
      e.currentIndex = e.entries.length - 1;
      e.round = Math.max(1, e.round - 1);
    } else e.currentIndex = nextIndex;
    await saveEncounter(e);
    await sendChatMessages(`@${display} ${encounterText(e)}`, broadcasterId);
    return true;
  }

  if (action === "show" || action === "list") {
    await sendChatMessages(`@${display} ${encounterText(e)}`, broadcasterId);
    return true;
  }

  await sendChatMessage(
    `@${display} Initiative: !turn start | !turn roll | !turn add <name> <initiative> | !turn show | !turn next | !turn prev | !turn remove <name> | !turn end`,
    broadcasterId,
  );
  return true;
}
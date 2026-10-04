// Party duels (!dndduel party A B) and party hunts (!dndduel party hunt …).
// Split out of combat.ts (which re-exports it) to keep every file well
// under Val Town's per-file size ceiling.

import { findMonsterByName } from "./data.ts";
import { getChannelRoster, recordMonsterOutcome, summonMonster, tierTag } from "./bestiary.ts";
import { combatStats, firstAlive } from "./utils.ts";
import { duelNarration } from "./narration.ts";
import { BattleLog, fighterLine, fightingAbility, heroAcWhy, MONSTER_AC_WHY, rollDice, simulateAttack } from "./battle.ts";
import { getCharacter, getParty, getPartyDuel, getPartyMembers, getPartyMonsterDuel, sqlite } from "./db.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import { awardMonsterXp } from "./characters.ts";
import { awardMonsterLoot, lootSummary, partyLootNote } from "./loot.ts";
import { fightSummary, hpLeft } from "./whisper.ts";
import { claimHunt } from "./huntcooldown.ts";
import { settleWounds, startHp, woundsOn } from "./hoard_combat.ts";
import { creditBounty } from "./hoard.ts";
import { withArticle, isChallengeExpired, forfeitIfIdlePartyDuel, forfeitIfIdlePartyHunt } from "./combat_shared.ts";

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
  // !dndduel party hunt <party> [monster]          → auto
  // !dndduel party hunt classic <party> [monster]  → turn-based
  // !dndduel party hunt attack|status|end
  // A monster name (multi-word ok, e.g. "adult red dragon") targets that
  // bestiary entry instead of a random level-scaled pick.
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
      // Retreating keeps the wounds taken so far (Hunt and Hoard).
      const wounds = await woundsOn(broadcasterId);
      for (const n of partyHunt.members) await settleWounds(broadcasterId, n, partyHunt.member_hp[n] ?? 0, wounds);
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
        } = ${total} vs AC ${partyHunt.monster_ac} → ${
          hit
            ? `hit for ${damage} (${partyHunt.monster_name} ${partyHunt.monster_hp}/${partyHunt.monster_hp_max} HP)`
            : "miss"
        }. ${duelNarration(critical ? "critical" : hit ? "hit" : "miss")}`;

      if (partyHunt.monster_hp <= 0) {
        await sqlite.execute(
          "DELETE FROM party_monster_duels WHERE broadcaster_id = ?",
          [broadcasterId],
        );
        const learnNote = await recordMonsterOutcome(broadcasterId, String(partyHunt.monster_name), true, attacker.level);
        const wounds = await woundsOn(broadcasterId);
        for (const n of partyHunt.members) await settleWounds(broadcasterId, n, partyHunt.member_hp[n] ?? 0, wounds); // before XP
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
        const lootNote = partyLootNote(
          await awardMonsterLoot(
            partyHunt.members.filter((n: string) => (partyHunt.member_hp[n] ?? 0) > 0),
            String(partyHunt.monster_cr),
            broadcasterId,
          ),
        );
        let bountyNote = "";
        for (const n of partyHunt.members) {
          if ((partyHunt.member_hp[n] ?? 0) > 0) bountyNote ||= await creditBounty(broadcasterId, n, String(partyHunt.monster_name));
        }
        await sendChatMessages(
          `@${display} ${playerResult} ${partyHunt.monster_name} falls! ${
            duelNarration("victory")
          } XP: ${xpNotes.join(", ") || "none"}.${lootNote}${bountyNote}${learnNote}${wounds ? " 🩸 Wounds carry over." : ""}`,
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
        `${partyHunt.monster_name} strikes ${targetName}: d20 ${mRoll} + ${partyHunt.monster_attack} = ${mTotal} vs AC ${playerAc} → ${
          mHit
            ? `hit for ${mDamage} (${targetName} ${partyHunt.member_hp[targetName]}/${targetChar?.hpMax ?? "?"} HP)`
            : "miss"
        }.`;

      const stillAlive = partyHunt.members.some((n: string) =>
        (partyHunt.member_hp[n] ?? 0) > 0
      );
      if (!stillAlive) {
        await sqlite.execute(
          "DELETE FROM party_monster_duels WHERE broadcaster_id = ?",
          [broadcasterId],
        );
        const learnNote = await recordMonsterOutcome(broadcasterId, String(partyHunt.monster_name), false, attacker.level);
        const wounds = await woundsOn(broadcasterId);
        for (const n of partyHunt.members) await settleWounds(broadcasterId, n, 0, wounds);
        await sendChatMessages(
          `@${display} ${playerResult} ${monsterResult} ${
            duelNarration("defeat")
          } The party is wiped.${learnNote}${wounds ? " 🩸 Everyone limps away at 1 HP." : ""}`,
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
    let monsterNameArg = "";
    if (
      huntAction === "classic" || huntAction === "turn" ||
      huntAction === "manual"
    ) {
      classic = true;
      partyName = (parts[4] ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
      monsterNameArg = parts.slice(5).join(" ").trim();
    } else {
      partyName = huntAction.replace(/[^a-z0-9_-]/g, "");
      monsterNameArg = parts.slice(4).join(" ").trim();
    }
    if (!partyName) {
      await sendChatMessage(
        `@${display} Party hunt: !dndduel party hunt <party> [monster] (auto) | !dndduel party hunt classic <party> [monster] | !dndduel party hunt attack | status | end`,
        broadcasterId,
      );
      return true;
    }
    // Resolve the target up front so a typo is reported before anything else
    // (and before a party-membership message), without starting a hunt.
    const namedBase = monsterNameArg ? findMonsterByName(monsterNameArg, await getChannelRoster(broadcasterId)) : undefined;
    if (monsterNameArg && !namedBase) {
      await sendChatMessage(
        `@${display} no bestiary match for "${monsterNameArg}". Try !monster <name> to check the spelling (or teach it to the bestiary), !bestiary for the list, or leave it off for a random foe.`,
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

    // Hunt and Hoard wounds (hoard_combat.ts): with the module on, members
    // start at their current HP and anyone at 1 HP sits this hunt out.
    const wounds = await woundsOn(broadcasterId);
    const chars: Record<string, any> = {};
    const memberHp: Record<string, number> = {};
    const benched: string[] = [];
    for (const n of members) {
      const c = await getCharacter(n, broadcasterId);
      if (c) {
        chars[n] = c;
        memberHp[n] = await startHp(broadcasterId, c, wounds);
        if (wounds && memberHp[n] <= 1) benched.push(n);
      }
    }
    const livingMembers = members.filter((n) => chars[n] && !benched.includes(n));
    if (livingMembers.length < 1) {
      await sendChatMessage(
        benched.length
          ? `@${display} every hero in ${partyName} is too wounded to hunt (1 HP) — !rest or drink a potion (!use) first.`
          : `@${display} at least one party member needs a saved character.`,
        broadcasterId,
      );
      return true;
    }
    const benchNote = benched.length ? ` (${benched.join(", ")} too wounded to join.)` : "";
    const levelSum = livingMembers.reduce((t, n) => t + Number(chars[n].level ?? 1), 0);
    const avgLevel = Math.max(1, Math.round(levelSum / livingMembers.length));
    // Scale monster gently for group size (still player-favored). A named
    // target is scaled to the party's average level the same way a random
    // pick is; the group-size tweak below applies to both.
    // From the channel's live bestiary, level-scaled then adapted (bestiary.ts).
    const summoned = await summonMonster(broadcasterId, avgLevel, namedBase ? namedBase.name : null);
    if (!summoned) return true; // unreachable: namedBase was just resolved
    const monster = summoned;
    const sizeScale = 0.5 + livingMembers.length * 0.22; // 1p~0.72, 2p~0.94, 3p~1.16
    monster.hp = Math.max(10, Math.round(monster.hp * sizeScale));
    monster.attack = Math.max(
      2,
      monster.attack + Math.floor((livingMembers.length - 1) / 3),
    );

    // One cooldown for all hunting, per hero: every member of the company
    // must be clear, and all of them are stamped together.
    if (!(await claimHunt(broadcasterId, livingMembers, display, { self: username }))) return true;

    if (!classic) {
      // Auto-resolve: each living member attacks, then monster hits a random member
      let monsterHp = monster.hp;
      const hp = { ...memberHp };
      const battle = new BattleLog();
      for (const n of livingMembers) battle.describe(fighterLine(n, chars[n], hp[n], 10));
      battle.describe(
        `${monster.name}: CR ${monster.cr}, ${monster.hp} HP (scaled ×${sizeScale.toFixed(2)} for a party of ${livingMembers.length}), AC ${monster.ac} (stat block), ` +
          `attack d20 + ${monster.attack}, damage 1d${monster.die} + ${monster.bonus}; strikes one random standing member after each round of party attacks.`,
      );
      let swings = 0;
      const maxSwings = 100;
      while (
        monsterHp > 0 && livingMembers.some((n) => hp[n] > 0) &&
        swings < maxSwings
      ) {
        swings++;
        battle.nextRound();
        for (const n of livingMembers) {
          if (hp[n] <= 0 || monsterHp <= 0) continue;
          const stats = combatStats(chars[n]);
          const ability = fightingAbility(chars[n]).name;
          const roll = 1 + Math.floor(Math.random() * 20);
          const total = roll + stats.mod + chars[n].proficiency;
          const critical = roll === 20;
          const hit = critical || (roll !== 1 && total >= monster.ac);
          const rolls = rollDice(critical ? 2 : 1, 8);
          const dice = rolls.reduce((x, y) => x + y, 0);
          const damage = hit ? Math.max(1, dice + stats.mod) : 0;
          const monsterHpBefore = monsterHp;
          if (hit) monsterHp = Math.max(0, monsterHp - damage);
          battle.strike({
            actor: n,
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
            atk: [[ability, stats.mod], ["prof", chars[n].proficiency]],
            dmgDice: hit ? rolls : undefined,
            dmgDie: 8,
            dmgMods: [[ability, stats.mod]],
            hpBefore: monsterHpBefore,
          });
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
        const victimHpBefore = hp[victim];
        if (mHit) hp[victim] = Math.max(0, hp[victim] - mDamage);
        battle.strike({
          actor: monster.name,
          target: victim,
          hit: mHit,
          crit: mRoll === 20,
          fumble: mRoll === 1,
          roll: mRoll,
          total: mTotal,
          ac: playerAc,
          damage: mDamage,
          targetHp: hp[victim],
          targetMax: Number(chars[victim].hpMax ?? memberHp[victim] ?? 0),
          acWhy: heroAcWhy(10, chars[victim]),
          atk: [["atk", monster.attack]],
          dmgDice: mHit ? [mDice] : undefined,
          dmgDie: monster.die,
          dmgMods: [["bonus", monster.bonus]],
          hpBefore: victimHpBefore,
        });
      }
      const partyWon = monsterHp <= 0 && livingMembers.some((n) => hp[n] > 0);
      const learnNote = await recordMonsterOutcome(broadcasterId, monster.name, partyWon, avgLevel);
      for (const n of livingMembers) await settleWounds(broadcasterId, n, hp[n], wounds); // before XP
      const xpNotes: string[] = [];
      let lootNote = "";
      let loot = "";
      let bountyNote = "";
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
        const paid = await awardMonsterLoot(livingMembers.filter((n) => hp[n] > 0), monster.cr, broadcasterId);
        lootNote = partyLootNote(paid);
        loot = lootSummary(paid);
        for (const n of livingMembers) if (hp[n] > 0) bountyNote ||= await creditBounty(broadcasterId, n, monster.name);
      }
      const roster = livingMembers.map((n) => `${n}:${hp[n]}`).join(", ");
      const shownLog = battle.render(700);
      const msg =
        `@${display} party ${partyName} hunts ${withArticle(monster.name)} (CR ${monster.cr}${tierTag(monster.tier)}, AC ${monster.ac}, HP ${monster.hp})! ${
          duelNarration("challenge")
        } Auto-resolved in ${battle.roundCount} round${
          battle.roundCount === 1 ? "" : "s"
        }: ${shownLog} — ${
          partyWon
            ? `Victory! ${duelNarration("victory")} XP: ${xpNotes.join(", ")}.${lootNote}${bountyNote}`
            : `Defeat. ${duelNarration("defeat")}`
        } Final party HP [${roster}]; monster ${monsterHp}/${monster.hp}.${learnNote}${wounds ? " 🩸 Wounds carry over (nobody drops below 1 HP)." : ""}${benchNote}`;
      await sendChatMessages(
        msg,
        broadcasterId,
        {
          detail: msg.replace(shownLog, battle.renderDetailed()),
          names: livingMembers,
          summary: fightSummary({
            fighter: `party ${partyName}`,
            enemy: monster.name,
            outcome: partyWon ? "Victory!" : `Defeat — ${monster.name} wins.`,
            hp: hpLeft([
              ...livingMembers.map((n): [string, number, number] => [n, hp[n], Number(chars[n].hpMax ?? memberHp[n] ?? 0)]),
              [monster.name, monsterHp, monster.hp],
            ]),
            loot,
          }),
        },
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
      `@${display} classic party hunt! ${partyName} vs ${monster.name} (CR ${monster.cr}${tierTag(monster.tier)}) AC ${monster.ac}, HP ${monster.hp}. ${
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

    // Auto-resolve party duel. One round = each side's front-line fighter
    // (first member still standing) swings once, challenger first.
    const battle = new BattleLog();
    for (const n of attackers) battle.describe(`[${challenge.challenger_party}] ${fighterLine(n, aChars[n], aHp[n], 10)}`);
    for (const n of defenders) battle.describe(`[${challenge.defender_party}] ${fighterLine(n, dChars[n], dHp[n], 10)}`);
    let rounds = 0;
    const maxRounds = 40; // 80 swings, same cap as before
    while (
      attackers.some((n) => aHp[n] > 0) &&
      defenders.some((n) => dHp[n] > 0) &&
      rounds < maxRounds
    ) {
      rounds++;
      battle.nextRound();
      for (const side of ["challenger", "defender"] as const) {
        const atkMembers = side === "challenger" ? attackers : defenders;
        const atkHp = side === "challenger" ? aHp : dHp;
        const atkChars = side === "challenger" ? aChars : dChars;
        const defMembers = side === "challenger" ? defenders : attackers;
        const defHp = side === "challenger" ? dHp : aHp;
        const defChars = side === "challenger" ? dChars : aChars;
        const attackerName = atkMembers.find((n) => atkHp[n] > 0);
        const defenderName = defMembers.find((n) => defHp[n] > 0);
        if (!attackerName || !defenderName) break;
        battle.strike(
          simulateAttack(
            attackerName,
            defenderName,
            atkChars[attackerName],
            defChars[defenderName],
            defHp,
          ),
        );
      }
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
    const shownLog = battle.render(700);
    const msg =
      `@${display} party duel accepted! ${
        duelNarration("accept")
      } ${challenge.challenger_party} vs ${challenge.defender_party} auto-resolved in ${rounds} round${
        rounds === 1 ? "" : "s"
      }. ${shownLog} — ${winnerParty} wins! ${
        duelNarration("victory")
      } HP [${left}] vs [${right}]`;
    await sendChatMessages(
      msg,
      broadcasterId,
      {
        detail: msg.replace(shownLog, battle.renderDetailed()),
        names: [...attackers, ...defenders],
        summary: fightSummary({
          fighter: `party ${challenge.challenger_party}`,
          enemy: `party ${challenge.defender_party}`,
          outcome: `${winnerParty} wins!`,
          hp: hpLeft([
            ...attackers.map((n): [string, number, number] => [n, aHp[n], Number(aChars[n]?.hpMax ?? 0)]),
            ...defenders.map((n): [string, number, number] => [n, dHp[n], Number(dChars[n]?.hpMax ?? 0)]),
          ]),
        }),
      },
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
    const result = `${attackerName} attacks ${targetName}: d20 ${roll}${
      critical ? " CRITICAL" : ""
    } + ${
      stats.mod + attacker.proficiency
    } = ${total} vs AC ${targetStats.attack} → ${
      hit
        ? `hit for ${damage} (${targetName} ${enemyHp[targetName]}/${target.hpMax} HP)`
        : "miss"
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

// Solo monster duels: !dndduel, !dndduel <monster>, !dndduel monster [classic].
// Split out of combat.ts (which re-exports it) to keep every file well
// under Val Town's per-file size ceiling.

import { findMonsterByName } from "./data.ts";
import { getChannelRoster, recordMonsterOutcome, summonMonster, tierTag } from "./bestiary.ts";
import { combatStats } from "./utils.ts";
import { duelNarration } from "./narration.ts";
import { simulateMonsterFight } from "./battle.ts";
import { getCharacter, getMonsterDuel, sqlite } from "./db.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import { awardMonsterXp } from "./characters.ts";
import { awardMonsterLoot, lootSummary, soloLootNote } from "./loot.ts";
import { fightSummary, hpLeft } from "./whisper.ts";
import { claimHunt } from "./huntcooldown.ts";
import { withArticle, forfeitIfIdleMonsterDuel } from "./combat_shared.ts";
import { settleWounds, startHp, tooWoundedText, woundNote, woundsOn } from "./hoard_combat.ts";
import { creditBounty } from "./hoard.ts";

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
  const trimmed = chatMessage.trim();
  const normalized = trimmed.toLowerCase();

  const isControlCommand =
    normalized === "!dndduel" ||
    normalized === "!dndduel attack" ||
    normalized === "!dndduel monster" ||
    normalized === "!dndduel monster classic" ||
    normalized === "!dndduel monster attack" ||
    normalized === "!dndduel monster status" ||
    normalized === "!dndduel monster end";

  // Optional named-monster target:
  //   !dndduel <name>                 → auto, only claimed if the name
  //                                      resolves to a bestiary entry (so
  //                                      "!dndduel @user" still falls
  //                                      through to the PvP challenge parser)
  //   !dndduel monster <name>         → auto, always claimed — this form can
  //                                      only ever mean a monster fight
  //   !dndduel monster classic <name> → classic, always claimed likewise
  let monsterNameArg: string | null = null;
  let namedMode: "auto" | "classic" | null = null;
  if (!isControlCommand) {
    let m = trimmed.match(/^!dndduel\s+monster\s+classic\s+(.+)$/i);
    if (m) {
      monsterNameArg = m[1].trim();
      namedMode = "classic";
    } else if ((m = trimmed.match(/^!dndduel\s+monster\s+(.+)$/i))) {
      monsterNameArg = m[1].trim();
      namedMode = "auto";
    } else if ((m = trimmed.match(/^!dndduel\s+(.+)$/i))) {
      const rest = m[1].trim();
      const restLower = rest.toLowerCase();
      const reserved = [
        "party",
        "accept",
        "decline",
        "attack",
        "status",
        "show",
        "end",
        "cancel",
        "classic",
        "turn",
        "manual",
        "auto",
        "quick",
      ];
      if (
        rest && !rest.startsWith("@") && !reserved.includes(restLower) &&
        findMonsterByName(rest, await getChannelRoster(broadcasterId))
      ) {
        monsterNameArg = rest;
        namedMode = "auto";
      }
    }
  }

  if (!isControlCommand && !monsterNameArg) return false;

  let active = await getMonsterDuel(broadcasterId);
  if (await forfeitIfIdleMonsterDuel(broadcasterId, active)) active = null;

  if (
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
      // Retreating keeps the wounds taken so far (Hunt and Hoard).
      if (active.player_hp != null) await settleWounds(broadcasterId, username, Number(active.player_hp), await woundsOn(broadcasterId));
      await sendChatMessage(
        `@${display} the monster duel ends. The dungeon master calls it a tactical retreat.`,
        broadcasterId,
      );
      return true;
    }
  }

  // Classic turn-based monster: !dndduel monster [classic] [name]
  if (
    normalized === "!dndduel monster" ||
    normalized === "!dndduel monster classic" ||
    namedMode === "classic"
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
    // Hunt and Hoard wounds (hoard_combat.ts): start hurt if the module is on.
    const wounds = await woundsOn(broadcasterId);
    const hp0 = await startHp(broadcasterId, c, wounds);
    const hurt = tooWoundedText("your hero", hp0, c.hpMax, wounds);
    if (hurt) {
      await sendChatMessage(`@${display} ${hurt}`, broadcasterId);
      return true;
    }
    // Level-scaled from the channel's live bestiary, then adapted (bestiary.ts).
    const monster = await summonMonster(broadcasterId, c.level, monsterNameArg);
    if (!monster) {
      await sendChatMessage(
        `@${display} no bestiary match for "${monsterNameArg}". Try !monster <name> to check the spelling (or teach it to the bestiary), !bestiary for the list, or !dndduel monster classic for a random foe.`,
        broadcasterId,
      );
      return true;
    }
    if (!(await claimHunt(broadcasterId, [username], display, { self: username }))) return true;
    await sqlite.execute(
      "INSERT OR REPLACE INTO monster_duels (broadcaster_id,player,monster_name,monster_cr,monster_ac,monster_hp,monster_hp_max,monster_attack,monster_damage_die,monster_damage_bonus,current_turn,active,updated_at,player_hp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
        hp0,
      ],
    );
    await sendChatMessage(
      `@${display} classic monster fight! ${monster.name} (CR ${monster.cr}${tierTag(monster.tier)}) AC ${monster.ac}, HP ${monster.hp}. Your HP: ${hp0 < c.hpMax ? `${hp0}/` : ""}${c.hpMax}. ${
        duelNarration("challenge")
      } Use !dndduel attack.`,
      broadcasterId,
    );
    return true;
  }

  // Auto monster: bare !dndduel [name] | !dndduel monster [name]
  if (normalized === "!dndduel" || (namedMode === "auto" && monsterNameArg)) {
    const c = await getCharacter(username, broadcasterId);
    if (!c) {
      await sendChatMessage(
        `@${display} create a character first with !createchar, then challenge the wilds with !dndduel.`,
        broadcasterId,
      );
      return true;
    }
    const wounds = await woundsOn(broadcasterId);
    const hp0 = await startHp(broadcasterId, c, wounds);
    const hurt = tooWoundedText("your hero", hp0, c.hpMax, wounds);
    if (hurt) {
      await sendChatMessage(`@${display} ${hurt}`, broadcasterId);
      return true;
    }
    // Level-scaled from the channel's live bestiary, then adapted (bestiary.ts).
    const monster = await summonMonster(broadcasterId, c.level, monsterNameArg);
    if (!monster) {
      await sendChatMessage(
        `@${display} no bestiary match for "${monsterNameArg}". Try !monster <name> to check the spelling (or teach it to the bestiary), !bestiary for the list, or !dndduel for a random foe.`,
        broadcasterId,
      );
      return true;
    }
    if (!(await claimHunt(broadcasterId, [username], display, { self: username }))) return true;
    const fight = simulateMonsterFight(c, username, monster, { startHp: hp0 });
    const { playerHp, monsterHp, battle } = fight;
    await sqlite.execute("DELETE FROM monster_duels WHERE broadcaster_id = ?", [
      broadcasterId,
    ]);
    const won = monsterHp <= 0 && playerHp > 0;
    const learnNote = await recordMonsterOutcome(broadcasterId, monster.name, won, c.level);
    await settleWounds(broadcasterId, username, playerHp, wounds); // before XP (level-ups raise HP)
    let xpNote = "";
    let lootNote = "";
    let loot = "";
    let bountyNote = "";
    if (won) {
      const xp = await awardMonsterXp(username, monster.cr, broadcasterId);
      if (xp) {
        xpNote = ` +${xp.gained} XP (total ${xp.total})${
          xp.leveledTo ? ` — leveled to ${xp.leveledTo}!` : ""
        }`;
      }
      const paid = await awardMonsterLoot([username], monster.cr, broadcasterId);
      lootNote = soloLootNote(paid);
      loot = lootSummary(paid);
      bountyNote = await creditBounty(broadcasterId, username, monster.name);
    }
    const shownLog = battle.render();
    const msg =
      `@${display} the D20 of Fate summons ${withArticle(monster.name)} (CR ${monster.cr}${tierTag(monster.tier)}, AC ${monster.ac}, HP ${monster.hp})! ${
        duelNarration("challenge")
      } Auto-resolved in ${battle.roundCount} round${
        battle.roundCount === 1 ? "" : "s"
      } (${username} vs ${monster.name}): ${shownLog} — ${
        won
          ? `${username} defeats ${monster.name}! ${
            duelNarration("victory")
          }${xpNote}${lootNote}${bountyNote}`
          : `${monster.name} wins. ${duelNarration("defeat")}`
      } Final HP: you ${playerHp}/${c.hpMax}, ${monster.name} ${monsterHp}/${monster.hp}.${learnNote}${woundNote(playerHp, c.hpMax, wounds)}`;
    await sendChatMessages(
      msg,
      broadcasterId,
      {
        detail: msg.replace(shownLog, battle.renderDetailed()),
        names: [username],
        summary: fightSummary({
          fighter: display,
          enemy: monster.name,
          outcome: won ? `${display} wins!` : `${monster.name} wins.`,
          hp: hpLeft([[display, playerHp, c.hpMax], [monster.name, monsterHp, monster.hp]]),
          loot,
        }),
      },
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
      } + ${toHitBonus} = ${total} vs AC ${active.monster_ac} → ${
        hit
          ? `hit for ${damage} (${active.monster_name} ${active.monster_hp}/${active.monster_hp_max} HP)`
          : "miss"
      }. ${duelNarration(critical ? "critical" : hit ? "hit" : "miss")}`;
    if (active.monster_hp <= 0) {
      await sqlite.execute(
        "DELETE FROM monster_duels WHERE broadcaster_id = ?",
        [broadcasterId],
      );
      const learnNote = await recordMonsterOutcome(broadcasterId, String(active.monster_name), true, player.level);
      const wounds = await woundsOn(broadcasterId);
      await settleWounds(broadcasterId, username, playerHp, wounds); // before XP (level-ups raise HP)
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
      const lootNote = soloLootNote(
        await awardMonsterLoot([username], String(active.monster_cr ?? "1"), broadcasterId),
      );
      const bountyNote = await creditBounty(broadcasterId, username, String(active.monster_name));
      await sendChatMessage(
        `@${display} ${playerResult} ${active.monster_name} is defeated! ${
          duelNarration("victory")
        }${xpNote}${lootNote}${bountyNote}${learnNote}${woundNote(playerHp, player.hpMax, wounds)}`,
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
      `${active.monster_name} strikes back at ${username}: d20 ${monsterRoll} + ${active.monster_attack} = ${monsterTotal} vs AC ${playerAc} → ${
        monsterHit
          ? `hit for ${monsterDamage} (${username} ${nextPlayerHp}/${player.hpMax} HP)`
          : "miss"
      }. ${duelNarration(monsterHit ? "hit" : "miss")}`;
    if (nextPlayerHp <= 0) {
      await sqlite.execute(
        "DELETE FROM monster_duels WHERE broadcaster_id = ?",
        [broadcasterId],
      );
      const learnNote = await recordMonsterOutcome(broadcasterId, String(active.monster_name), false, player.level);
      const wounds = await woundsOn(broadcasterId);
      await settleWounds(broadcasterId, username, 0, wounds);
      await sendChatMessages(
        `@${display} ${playerResult} ${monsterResult} ${
          duelNarration("defeat")
        } ${active.monster_name} wins this encounter.${learnNote}${woundNote(0, player.hpMax, wounds)}`,
        broadcasterId,
      );
    } else {
      await sqlite.execute(
        "UPDATE monster_duels SET player_hp = ?, monster_hp = ?, current_turn = ?, updated_at = ? WHERE broadcaster_id = ?",
        [nextPlayerHp, active.monster_hp, "player", Date.now(), broadcasterId],
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

// Solo monster duels: !dndduel, !dndduel <monster>, !dndduel monster [classic].
// Split out of combat.ts (which re-exports it) to keep every file well
// under Val Town's per-file size ceiling.

import { findMonsterByName } from "./data.ts";
import { getChannelRoster, recordMonsterOutcome, summonMonster, tierTag } from "./bestiary.ts";
import { recordBattle } from "./battle_log.ts";
import { duelNarration } from "./narration.ts";
import { BattleLog, simulateMonsterFight } from "./battle.ts";
import { classicText, heroFighter, heroTurn, monsterFighter, monsterTurn } from "./combat_abilities.ts";
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
    await recordBattle(broadcasterId, { kind: "hunt", side: display, foe: monster.name, outcome: won ? "win" : "loss" });
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
    const playerHp = Number(active.player_hp ?? player.hpMax);
    // Classic turns keep no state between commands, so only always-on
    // abilities apply (combat_abilities.ts). Same d10 and hunter's edge as
    // the auto fight.
    const hero = heroFighter(username, player, playerHp, 11, { stateless: true, minDie: 10, edge: 1 });
    const foe = monsterFighter(
      {
        name: String(active.monster_name), ac: Number(active.monster_ac), attack: Number(active.monster_attack),
        die: Number(active.monster_damage_die), bonus: Number(active.monster_damage_bonus),
      },
      Number(active.monster_hp),
      Number(active.monster_hp_max),
    );
    const strikes = heroTurn(hero, () => (foe.hp > 0 ? foe : undefined), new BattleLog(), 2);
    active.monster_hp = foe.hp;
    const best = strikes.find((x) => x.crit) ?? strikes.find((x) => x.hit);
    const playerResult = `${classicText(strikes)} ${duelNarration(best?.crit ? "critical" : best ? "hit" : "miss")}`;
    if (active.monster_hp <= 0) {
      await sqlite.execute(
        "DELETE FROM monster_duels WHERE broadcaster_id = ?",
        [broadcasterId],
      );
      const learnNote = await recordMonsterOutcome(broadcasterId, String(active.monster_name), true, player.level);
      await recordBattle(broadcasterId, { kind: "hunt", side: display, foe: String(active.monster_name), outcome: "win" });
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
    const strikeBack = monsterTurn(foe, hero, new BattleLog(), 2);
    const nextPlayerHp = hero.hp;
    active.player_hp = nextPlayerHp;
    const monsterResult = `${classicText([strikeBack])} ${duelNarration(strikeBack.hit ? "hit" : "miss")}`;
    if (nextPlayerHp <= 0) {
      await sqlite.execute(
        "DELETE FROM monster_duels WHERE broadcaster_id = ?",
        [broadcasterId],
      );
      const learnNote = await recordMonsterOutcome(broadcasterId, String(active.monster_name), false, player.level);
      await recordBattle(broadcasterId, { kind: "hunt", side: display, foe: String(active.monster_name), outcome: "loss" });
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

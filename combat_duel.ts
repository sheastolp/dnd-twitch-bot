// Player-vs-player duels: !dndduel @user (auto) and !dndduel classic @user.
// Split out of combat.ts (which re-exports it) to keep every file well
// under Val Town's per-file size ceiling.

import { BattleLog } from "./battle.ts";
import { classicText, heroFighter, heroTurn } from "./combat_abilities.ts";
import { duelNarration } from "./narration.ts";
import { getCharacter, getDuel, sqlite } from "./db.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import { fightSummary, hpLeft } from "./whisper.ts";
import { isChallengeExpired, forfeitIfIdleDuel, duelSummary, resolvePlayerDuel } from "./combat_shared.ts";
import { recordBattle } from "./battle_log.ts";

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
        `@${display} you have no pending duel challenge.`,
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
    const loser = result.winner === username ? String(challenge.challenger) : display;
    await recordBattle(broadcasterId, {
      kind: "duel",
      side: result.winner === username ? display : String(challenge.challenger),
      foe: loser,
      outcome: "win",
    });
    const intro = `@${display} accepted! ${duelNarration("accept")} `;
    await sendChatMessages(
      intro + result.log,
      broadcasterId,
      {
        detail: intro + result.fullLog,
        names: [String(challenge.challenger), username],
        summary: fightSummary({
          fighter: String(challenge.challenger),
          enemy: display,
          outcome: `${result.winner} wins!`,
          hp: hpLeft([
            [String(challenge.challenger), result.hp[String(challenge.challenger)], Number(challenger?.hpMax ?? 0)],
            [display, result.hp[username], Number(defender?.hpMax ?? 0)],
          ]),
        }),
      },
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
    // Classic turns keep no state between commands, so only always-on
    // abilities apply (combat_abilities.ts).
    const mine = active.challenger === username ? "challenger_hp" : "defender_hp";
    const theirs = active.challenger === username ? "defender_hp" : "challenger_hp";
    const me = heroFighter(username, attacker, Number(active[mine]), 10, { stateless: true });
    const foe = heroFighter(targetName, target, Number(active[theirs]), 10, { stateless: true });
    const strikes = heroTurn(me, () => (foe.hp > 0 ? foe : undefined), new BattleLog(), 2);
    active[theirs] = foe.hp;
    const defeated = active.challenger_hp <= 0 || active.defender_hp <= 0;
    const best = strikes.find((x) => x.crit) ?? strikes.find((x) => x.hit);
    const result = `${classicText(strikes)} ${duelNarration(best?.crit ? "critical" : best ? "hit" : "miss")}`;
    if (defeated) {
      const winner = active.challenger_hp > 0
        ? active.challenger
        : active.defender;
      await recordBattle(broadcasterId, {
        kind: "duel",
        side: String(winner),
        foe: String(winner === active.challenger ? active.defender : active.challenger),
        outcome: "win",
      });
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

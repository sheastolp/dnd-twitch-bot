// Duels, party combat, monster duels, and initiative tracker.
// The command handlers live in combat_*.ts (split for Val Town's per-file
// size ceiling); this module re-exports them and holds the initiative tracker.

import { modifier } from "./utils.ts";
import { getCharacter, getEncounter, saveEncounter, sqlite } from "./db.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";

export { duelSummary, resolvePlayerDuel } from "./combat_shared.ts";
export { handleDuelCommand } from "./combat_duel.ts";
export { handleMonsterDuelCommand, monsterDuelText } from "./combat_monster.ts";
export { handlePartyCommand, partySummary } from "./combat_party.ts";
export { handlePartyDuelCommand, partyDuelText } from "./combat_partyduel.ts";

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

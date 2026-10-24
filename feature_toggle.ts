// !feature — one chat command for every on/off switch on the dashboard, so a
// mod can flip any of them without opening the page.
//
//   !feature                       usage (anyone)
//   !feature <name> [status]       is it on? (anyone)
//   !feature <name> on|off         flip it (mod/broadcaster)
//   !feature list                  every switch and its state (mod/broadcaster)
//
// <name> is a switch's dashboard key (the #toggle-<key> anchor: "hunts",
// "points", "npcchatter"), one of its commands ("hug", "!rob", "goldboard"),
// or a short alias below ("gold", "merchant", "spam"). Switching goes through
// the dashboard's own setSwitch, so the merchant's first visit, group
// inheritance etc. behave exactly as on the page. Features with their own
// richer toggle (!dndbot on, !market on, !autoban on, …) keep it; this is the
// catch-all for the ~90 command groups that never had one.
//
// Handled before main.ts's "bot is off" early return so `!feature bot on`
// works like !dndbot on; while the bot is off only mods get a reply.

import { sendChatMessage } from "./twitch.ts";
import { COMMAND_GROUPS, DEDICATED_LABELS, groupForMessage, TOGGLE_REQUIRES, toggleLabel, requiredLabel } from "./commandgroups.ts";
import { loadSwitchStates, setSwitch } from "./dashboard.ts";
import { splitChatMessage } from "./utils.ts";

const ALIASES: Record<string, string> = {
  guildscribe: "bot", gold: "points", coin: "points", merchant: "market", stall: "market", haggle: "market",
  spam: "automod", spamfilters: "automod", filters: "automod", npcs: "npc", chatter: "npcchatter",
  ball: "pokeball", golivechecklist: "checklist", botlist: "botcheckauto", sounds: "soundbytes", sound: "soundbytes",
  quote: "quotes", hunt: "hunts", duel: "duels", map: "maps", clip: "clips", so: "shoutout",
  babushka: "mentionreply", hoard: "hunts", shop: "hunts", followers: "followthanks", subs: "subthanks",
  rally: "raid", shot: "shots",
};

const isSwitch = (key: string) => key in COMMAND_GROUPS || key in DEDICATED_LABELS;

/** A typed name → switch key, or null. */
export function resolveSwitch(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/^!/, "").replace(/[\s_-]+/g, "");
  if (!name) return null;
  if (isSwitch(name)) return name;
  if (ALIASES[name]) return ALIASES[name];
  const group = groupForMessage(`!${name}`);
  return group && isSwitch(group) ? group : null;
}

/** Returns true if the message was a !feature command. */
export async function handleFeatureCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
  channelOn: boolean,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!features?(?:\s+(.+?))?(?:\s+(on|off|status))?\s*$/i);
  if (!m) return false;
  if (!channelOn && !isModerator) return true;
  const name = (m[1] ?? "").trim();
  const action = (m[2] ?? "status").toLowerCase();

  if (!name) {
    await sendChatMessage(
      `@${display} Usage: !feature <name> on|off|status — any dashboard switch, by its name or one of its commands (e.g. !feature hug off, !feature rob on, !feature gold status). Mods: !feature list shows them all.`,
      broadcasterId,
    );
    return true;
  }

  if (name.toLowerCase() === "list") {
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a moderator can list the switches.`, broadcasterId);
      return true;
    }
    const states = await loadSwitchStates(broadcasterId);
    const keys = [...Object.keys(DEDICATED_LABELS), ...Object.keys(COMMAND_GROUPS)];
    const on = keys.filter((k) => states[k]), off = keys.filter((k) => !states[k]);
    const text = `On: ${on.join(", ") || "none"}. Off: ${off.join(", ") || "none"}.`;
    for (const part of splitChatMessage(text, 450)) await sendChatMessage(part, broadcasterId);
    return true;
  }

  const key = resolveSwitch(name);
  if (!key) {
    await sendChatMessage(`@${display} I don't know a switch called "${name.slice(0, 40)}". Try a command it covers (!feature hug off) or see !feature list.`, broadcasterId);
    return true;
  }
  const label = toggleLabel(key);

  if (action === "status") {
    const states = await loadSwitchStates(broadcasterId);
    await sendChatMessage(`@${display} ${label} is ${states[key] ? "on" : "off"}.${isModerator ? ` Switch it with !feature ${key} ${states[key] ? "off" : "on"}.` : ""}`, broadcasterId);
    return true;
  }

  if (!isModerator) {
    await sendChatMessage(`@${display} only the broadcaster or a moderator can switch ${label} ${action}.`, broadcasterId);
    return true;
  }

  const enabled = action === "on";
  await setSwitch(broadcasterId, key, enabled);
  let note = "";
  if (enabled) {
    const states = await loadSwitchStates(broadcasterId);
    const missing = [...(TOGGLE_REQUIRES[key] ?? []), ...(key === "bot" ? [] : ["bot"])].filter((r) => !states[r]);
    if (missing.length) note = ` Heads-up — it also needs ${missing.map((r) => `${requiredLabel(r)} (!feature ${r} on)`).join(" and ")}.`;
  }
  await sendChatMessage(`@${display} ${label} is now ${enabled ? "on" : "off"}.${note}`, broadcasterId);
  return true;
}

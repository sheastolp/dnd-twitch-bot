// Dashboard feature groups (COMMAND_GROUPS) and which group a chat command
// belongs to (groupForMessage).
// Split out of utils.ts to keep every file well under Val Town's per-file
// size ceiling.

import { resolveCheckKind } from "./utils.ts";
import { findMonsterByName, type SoloMonster } from "./data.ts";

// ── Dashboard feature groups ──────────────────────────────────────────────
// Per-channel command toggles surfaced on the web dashboard
// (see dashboard.ts / pages.ts renderFeaturesSection). Each group's
// `commands` are the exact lowercased first-word tokens (without "!") that
// belong to it, matched against the first word of an incoming chat message.
//
// Deliberately NOT in any group here — they already have their own
// dedicated on/off switch (isChannelEnabled, isMerchantEnabled,
// isChronicleEnabled, isNpcEnabled in db.ts), or must always keep working:
//   - !dndbot on/off/status — the dashboard's master bot switch.
//   - !market on/off/status — merchant flavor ads, own dashboard toggle.
//   - !haggle <message> — bargains over the merchant's current listing;
//     gated by the same !market toggle rather than its own, so it's excluded
//     here too (see haggle.ts / isMerchantEnabled in db.ts). It also spends
//     and charges coin for agreed prices when coin is on (points_db.ts),
//     which has no effect on this exclusion.
//   - !stall — read-only view of the current listing and the asker's haggle
//     attempts left; gated by the same !market toggle as !haggle (haggle.ts).
//   - !chronicle on/off/status — passive quote-back, own dashboard toggle.
//   - !autoban on/off/status — "ai viewers" spam auto-ban (autoban.ts), own
//     per-channel toggle; broadcaster-only so it isn't a dashboard group.
//   - !npc ... — AI NPC chatter, own dashboard toggle.
//   - !checklist ... — the streamer's start-of-stream checklist
//     (checklist.ts), mod/broadcaster only with its own on/off.
//   - The gold system as a whole (isPointsEnabled in points_db.ts, on by
//     default) is its own switch; !gold on/off/status and the mod balance
//     tools (!gold add/remove/set) are never grouped so they stay reachable.
//     The individual gold cards (purse, gifting, leaderboard, giveaways,
//     swear jar, boons, chat earnings) each have a group below on top of it.
//   - !dashboard [reset] — must stay reachable even with "custom" off, or a
//     steward could lock themselves out of the page that turns things back on.
//   - !help, !guide, !link, !dndbothelp — always available so players can
//     see why other commands aren't responding.
// !dndbot's *management* subcommands (add/edit/remove/list/cooldown) share
// the "dndbot" word with the master switch, but only reach the "customcmds"
// group check below because on/off/status are matched and returned first.
//
// One group per Guild Codex card (pages.ts renderGuidePage), so every card
// links to exactly one switch (#toggle-<key> on the dashboard, reached from
// the guide via /dashboard/go). `section` only sets the dashboard heading.
// `parent` is the older, coarser group a key was split out of: until a new
// group is switched for the first time it inherits the parent's saved state
// (db.ts isCommandGroupEnabled), so a channel that had e.g. "combat" off
// keeps duels, hunts, rob etc. off after the split.
// Commands that share one first word across several cards (!roll, !dndduel,
// !gold, !jar, !boon, !map, !party) are told apart by groupForMessage below.
export interface CommandGroup {
  label: string;
  section: string;
  commands: string[];
  parent?: string;
}

export const COMMAND_GROUPS: Record<string, CommandGroup> = {
  // Adventurer's parchment
  charfun: { section: "Adventurer's parchment", label: "For fun (!shmash)", commands: ["shmash"] },
  charprogress: { section: "Adventurer's parchment", label: "Manage progress (!levelup, !hp)", commands: ["levelup", "hp"], parent: "character" },
  charsaves: { section: "Adventurer's parchment", label: "Save and restore (!savechar, !loadchar, !resetchar)", commands: ["savechar", "loadchar", "resetchar"], parent: "character" },
  charcreate: { section: "Adventurer's parchment", label: "Create and view (!newchar, !createchar, !char, !roster)", commands: ["newchar", "createchar", "char", "roster"], parent: "character" },
  streamstats: { section: "Adventurer's parchment", label: "Stream stats (!watchtime, !followage, !nick)", commands: ["watchtime", "followage", "nick"], parent: "misc" },
  // Fate's dice
  d20: { section: "Fate's dice", label: "D20 of Fate (!d20, bare !roll / !r)", commands: ["d20"], parent: "dice" },
  diceroll: { section: "Fate's dice", label: "Dice expressions (!roll NdS, !roll @user)", commands: [], parent: "dice" },
  rollchecks: { section: "Fate's dice", label: "Saves & skill checks (!roll dex, !roll stealth)", commands: [], parent: "dice" },
  rollfate: { section: "Fate's dice", label: "Ask fate (!roll <question>?)", commands: [], parent: "dice" },
  rollcall: { section: "Fate's dice", label: "Roll call (!rollcall)", commands: ["rollcall"], parent: "misc" },
  // Baldur's Gate 3
  bg3char: { section: "Baldur's Gate 3", label: "Roll a character, saved (!bg3)", commands: ["bg3"], parent: "character" },
  bg3roll: { section: "Baldur's Gate 3", label: "Roll a character, flavor only (!bg3roll)", commands: ["bg3roll"], parent: "bg3flavor" },
  bg3companion: { section: "Baldur's Gate 3", label: "Companion & origin (!bg3companion, !bg3origin)", commands: ["bg3companion", "bg3origin"], parent: "bg3flavor" },
  bg3loot: { section: "Baldur's Gate 3", label: "Loot & camp (!bg3loot, !bg3camp)", commands: ["bg3loot", "bg3camp"], parent: "bg3flavor" },
  bg3lookup: { section: "Baldur's Gate 3", label: "Knowledgebase (!bg3lookup)", commands: ["bg3lookup"], parent: "bg3flavor" },
  // Guild archives
  rules: { section: "Guild archives", label: "Spells, classes & rules (!rules, !spell, !class, !feat, !monster)", commands: ["rules", "rule", "spell", "class", "feat", "monster"], parent: "archives" },
  items: { section: "Guild archives", label: "Equipment and abilities (!item, !ability)", commands: ["item", "ability"], parent: "archives" },
  races: { section: "Guild archives", label: "Races (!race, !subrace)", commands: ["race", "subrace"], parent: "archives" },
  // Arena, wilds & the company
  turn: { section: "Arena, wilds & the company", label: "Initiative tracker (!turn)", commands: ["turn"], parent: "combat" },
  party: { section: "Arena, wilds & the company", label: "Parties (!party)", commands: ["party"], parent: "combat" },
  duels: { section: "Arena, wilds & the company", label: "Player duels (!dndduel @user)", commands: [], parent: "combat" },
  hunts: { section: "Arena, wilds & the company", label: "Monster hunts (!dndduel [monster])", commands: [], parent: "combat" },
  partyduels: { section: "Arena, wilds & the company", label: "Party duels (!dndduel party)", commands: [], parent: "combat" },
  partyhunts: { section: "Arena, wilds & the company", label: "Party hunts (!dndduel party hunt)", commands: [], parent: "combat" },
  autohunt: { section: "Arena, wilds & the company", label: "Autohunt (!autohunt)", commands: ["autohunt", "autohuntstatus", "autohuntstop"], parent: "combat" },
  huntcooldown: { section: "Arena, wilds & the company", label: "Hunting cooldown (!huntcooldown)", commands: ["huntcooldown", "huntcd"], parent: "combat" },
  raid: { section: "Arena, wilds & the company", label: "Raid quest (!raid)", commands: ["raid"], parent: "combat" },
  bestiary: { section: "Arena, wilds & the company", label: "Bestiary (!bestiary — huntable monsters & what they've learned)", commands: ["bestiary"], parent: "combat" },
  // Chronicle, oracle & NPCs (chronicle and NPCs have their own switches)
  oracle: { section: "Chronicle, oracle & NPCs", label: "Oracle (!oracle)", commands: ["oracle"], parent: "dice" },
  // Gold, leaderboard & giveaways (needs the gold switch on as well)
  chatgold: { section: "Gold, leaderboard & giveaways", label: "Earning gold (copper for chatting)", commands: [] },
  goldcheck: { section: "Gold, leaderboard & giveaways", label: "Your purse (!gold, !gold @user)", commands: [] },
  goldgive: { section: "Gold, leaderboard & giveaways", label: "Gifting (!gold give)", commands: [] },
  leaderboard: { section: "Gold, leaderboard & giveaways", label: "Leaderboard (!gold top, !goldboard)", commands: ["goldboard"] },
  giveaways: { section: "Gold, leaderboard & giveaways", label: "Giveaways (!giveaway)", commands: ["giveaway"] },
  rob: { section: "Gold, leaderboard & giveaways", label: "Robbing (!rob)", commands: ["rob"], parent: "combat" },
  jar: { section: "Gold, leaderboard & giveaways", label: "Swear jar (!jar, auto-fines for swearing)", commands: [] },
  jarfine: { section: "Gold, leaderboard & giveaways", label: "Fine the streamer (!fine)", commands: ["fine"] },
  jarwords: { section: "Gold, leaderboard & giveaways", label: "Jar vocabulary (!jar words, !jar forget)", commands: [] },
  jargiveaway: { section: "Gold, leaderboard & giveaways", label: "Jar giveaway (!jar giveaway)", commands: [] },
  boonsetup: { section: "Gold, leaderboard & giveaways", label: "Link channel-point rewards (!boon add/remove/clear)", commands: [] },
  boonstatus: { section: "Gold, leaderboard & giveaways", label: "Reward status (!boon list, !boon status)", commands: [] },
  // Custom commands & triggers
  customcmds: { section: "Custom commands & triggers", label: "Custom commands (!dndbot add/edit/remove/cooldown/list)", commands: ["dndbot"], parent: "custom" },
  triggers: { section: "Custom commands & triggers", label: "Chat triggers (!trigger, passive keyword triggers)", commands: ["trigger"], parent: "custom" },
  vars: { section: "Custom commands & triggers", label: "Variables (!var)", commands: ["var"], parent: "custom" },
  timedmsgs: { section: "Custom commands & triggers", label: "Timed messages (!timedmsg)", commands: ["timedmsg"], parent: "custom" },
  // Battle maps
  maps: { section: "Battle maps", label: "Create & view maps (!map create/list/view/delete)", commands: ["map"] },
  maptemplates: { section: "Battle maps", label: "Map templates (!map templates)", commands: [], parent: "maps" },
  mapterrain: { section: "Battle maps", label: "Edit the terrain (!map terrains/fill/paint)", commands: [], parent: "maps" },
  maptokens: { section: "Battle maps", label: "Place & move characters (!map addchar/move/removechar)", commands: [], parent: "maps" },
  // Onboarding and support
  botcheck: { section: "Onboarding and support", label: "Bot viewer check (!botcheck)", commands: ["botcheck"] },
  ads: { section: "Onboarding and support", label: "Ad-break tracking (!adcheck, !adslogged)", commands: ["adcheck", "adslogged"], parent: "misc" },
  adalerts: { section: "Onboarding and support", label: "Ad-break alerts (heads-up before ads, notice when they start)", commands: [] },
  // Everything else
  misc: { section: "Other", label: "Misc (!hug, !logs, !connections)", commands: ["hug", "logs", "connections"] },
};

const COMMAND_TO_GROUP: Record<string, string> = Object.fromEntries(
  Object.entries(COMMAND_GROUPS).flatMap(([group, def]) => def.commands.map((c) => [c, group])),
);

const DUEL_CONTROLS = new Set(["accept", "decline", "attack", "status", "show", "end", "cancel"]);

/**
 * Which dashboard group (if any) a "!" chat message belongs to — the first
 * word, refined by subcommand for words shared across several guide cards.
 * Returns null for anything that must stay reachable (steward on/off
 * switches, mod balance tools, and the shared accept/attack/status/end
 * controls of a fight already under way).
 */
export function groupForMessage(
  message: string,
  // The channel's live bestiary (bestiary.ts getChannelRoster), so a
  // `!dndduel <learned monster>` counts as a hunt, not a PvP duel.
  roster?: SoloMonster[],
): string | null {
  const parts = message.trim().toLowerCase().split(/\s+/);
  const word = (parts[0] ?? "").replace(/^!/, "");
  const sub = parts[1] ?? "";
  switch (word) {
    case "d20":
      return "d20";
    case "roll":
    case "r": {
      // Mirrors the !roll dispatch in main.ts.
      let rest = message.trim().replace(/^!(?:roll|r)\s*/i, "").trim();
      let target = false;
      const t = rest.match(/^@(\S+)\s*(.*)$/);
      if (t) {
        target = true;
        rest = t[2].trim();
      }
      if (!rest) return target ? "diceroll" : "d20";
      if (resolveCheckKind(rest)) return "rollchecks";
      if (!target && !/^\d+d\d+([+-]\d+)?$/i.test(rest) && (/\s/.test(rest) || /\?$/.test(rest))) return "rollfate";
      return "diceroll";
    }
    case "dndduel": {
      if (sub === "party") {
        if (parts[2] === "hunt") return DUEL_CONTROLS.has(parts[3] ?? "") ? null : "partyhunts";
        return DUEL_CONTROLS.has(parts[2] ?? "") ? null : "partyduels";
      }
      if (!sub) return "hunts";
      if (sub === "monster") return DUEL_CONTROLS.has(parts[2] ?? "") ? null : "hunts";
      if (DUEL_CONTROLS.has(sub)) return null;
      if (sub.startsWith("@") || ["classic", "turn", "manual", "auto", "quick"].includes(sub)) return "duels";
      return findMonsterByName(parts.slice(1).join(" "), roster) ? "hunts" : "duels";
    }
    case "party":
      return sub === "hunt" ? "partyhunts" : "party";
    case "gold":
      if (["on", "off", "status", "add", "remove", "set"].includes(sub)) return null;
      if (sub === "top") return "leaderboard";
      if (sub === "give") return "goldgive";
      return "goldcheck";
    case "jar":
      if (sub === "words" || sub === "forget") return "jarwords";
      if (sub === "giveaway") return "jargiveaway";
      return "jar";
    case "boon":
      return ["add", "remove", "clear"].includes(sub) ? "boonsetup" : "boonstatus";
    case "map":
      if (sub === "templates") return "maptemplates";
      if (["terrains", "fill", "paint"].includes(sub)) return "mapterrain";
      if (["addchar", "move", "removechar"].includes(sub)) return "maptokens";
      return "maps";
  }
  return COMMAND_TO_GROUP[word] ?? null;
}

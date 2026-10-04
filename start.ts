// Chat text for `!start [topic]` — the new player's quick-start guide.
//
// Pure data like help.ts: no imports, no side effects. Each page fits in a
// single chat message (CHAT_MAX in twitch.ts, 300 characters, with room for
// the "@name " prefix) so it posts straight into chat instead of becoming a
// summary + link (see LONG_REPLY_PARTS in whisper.ts). `topic` is the lowercased word after !start, or undefined for
// the bare command, which gives the overview.

export function startGuideText(topic: string | undefined, publicBaseUrl: string): string {
  switch (topic) {
    case "char":
    case "character":
      return "📜 1/5 Your hero: !createchar for an instant level 1 hero, !newchar to pick race + class step by step, or !bg3 for BG3-style. !char shows your sheet. !savechar keeps a backup. Next: !start dice";
    case "dice":
    case "roll":
      return "🎲 2/5 Dice: !d20 quick roll | !roll 2d6+3 any dice | !roll stealth or !roll dex for a check/save with your sheet | !roll <question>? for an omen. Nat 1s & 20s go on !rollcall. Next: !start fight";
    case "fight":
    case "combat":
    case "hunt":
      return "⚔️ 3/5 Fights: !dndduel hunts a monster (or !dndduel goblin) for XP + loot — XP levels you up. !bestiary lists foes. !dndduel @user = PvP for glory. !autohunt 30m hunts on its own. Join !raid bosses! Next: !start party";
    case "party":
    case "company":
      return "🛡️ 4/5 Companies: !party create <name> | !party join <name> | !party invite @user | !party list. Then !party hunt <name> sends the whole company after a monster to share the spoils. Next: !start coin";
    case "coin":
    case "gold":
      return "💰 5/5 Coin: earn copper by chatting while live + monster loot. !gold = your purse, !goldboard = richest, !gold give @user 5sp to share. Haggle with the peddler (!stall, !haggle) when the market's open. Welcome to the guild!";
    default:
      return `🏰 Getting started: 1) !createchar makes your hero 2) !char shows it 3) !roll tests fate 4) !dndduel hunts monsters for XP 5) !party create <name> to team up. Step help: !start char|dice|fight|party|coin — Codex: ${publicBaseUrl}/guide`;
  }
}

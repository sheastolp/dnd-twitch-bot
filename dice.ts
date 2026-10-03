// Dice expressions for !roll / !d20 (rollDice).
// Split out of utils.ts to keep every file well under Val Town's per-file
// size ceiling.

import { modifier } from "./utils.ts";

export function rollDice(input = "1d20", customLabel?: string) {
  const expression = input.trim() || "1d20";
  const m = expression.match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  const n = +m[1],
    sides = +m[2],
    mod = m[3] ? +m[3] : 0;
  if (n > 100 || sides > 1000) return null;
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
  const rawTotal = rolls.reduce((a, b) => a + b, 0);
  const total = rawTotal + mod;
  const label = customLabel ?? (expression.toLowerCase() === "1d20" ? "D20 of Fate" : "Dice roll");
  const rawD20 = n === 1 && sides === 20 ? rolls[0] : null;
  const puns =
    rawD20 === 20
      ? [
          "Natural 20! The bards are already writing the song.",
          "Critical success! Even the dice wanted to be legendary.",
          "The gods have stamped this roll approved.",
          "A natural 20—today, the dungeon fears you.",
          "Fate has opened the treasure chest of victory.",
          "Nat 20! Somewhere, a DM sighs and adjusts the encounter.",
          "The dice rolled a max and immediately regretted nothing.",
          "A perfect roll, straight from the vault of legends.",
          "Natural 20—roll for damage, roll for glory.",
          "The universe itself cast Bless on this roll.",
          "That's a nat 20, framed and hung in the guild hall.",
          "Twenty out of twenty—the dice have no notes.",
          "A roll so good it should require a saving throw to believe.",
          "Natural 20! The crit fairy has visited.",
          "The d20 landed face-up and smug about it.",
          "A flawless roll worthy of its own campaign arc.",
          "Nat 20—even the monsters are taking notes.",
          "The dice rolled max and struck a pose.",
          "That's the kind of roll adventurers dream about.",
          "Natural 20! Somewhere, a bard grabs their lute.",
        ]
      : rawD20 === 1
        ? [
            "Natural 1! The floor wins this round.",
            "Critical fumble! Somewhere, a goblin just gained confidence.",
            "The dice have requested a short rest.",
            "A natural 1—excellent roleplay opportunity incoming.",
            "Fate rolled a banana peel under your boots.",
            "Nat 1—the DM is already smiling.",
            "The d20 rolled over and played dead.",
            "A critical fumble worthy of the blooper reel.",
            "That roll owes the party an apology.",
            "Natural 1! Even the mimics are laughing.",
            "The dice just cast Fumble on themselves.",
            "A one, a shrug, and a very awkward silence.",
            "The floor has never looked so inviting.",
            "Nat 1—time to check the fumble table.",
            "That's going straight into the tavern's blooper reel.",
            "The d20 chose chaos, and chaos chose you.",
            "A critical whiff for the ages.",
            "Natural 1! The goblins are taking notes for once.",
            "The dice tripped over their own pips.",
            "That roll just volunteered for a plot twist.",
          ]
        : total >= 17
          ? [
              "That roll arrived wearing a hero's cape.",
              "The adventure is leaning dramatically in your favor.",
              "Even the dungeon master raised an eyebrow at that one.",
              "A mighty swing of the fate hammer.",
              "The prophecy is looking unusually promising.",
              "That's a roll worth bragging about at camp.",
              "The dice are clearly rooting for you tonight.",
              "A strong roll, straight out of a highlight reel.",
              "Fortune favors the bold, and apparently you too.",
              "The stars aligned nicely for that one.",
              "That roll deserves its own toast at the tavern.",
              "A hearty result—the bards approve.",
              "The dice rolled high and struck a heroic pose.",
              "That's the kind of roll legends are built on.",
              "A confident roll, worthy of the front lines.",
              "The dungeon's odds just got a little worse.",
              "That roll practically glows with good fortune.",
              "A strong showing—the party's counting on more of these.",
              "The dice decided to be generous today.",
              "A roll fit for a chosen one.",
            ]
          : total <= 4
            ? [
                "That roll took a wrong turn at the tavern.",
                "The dungeon master is trying very hard not to smile.",
                "Fate has assigned you a side quest.",
                "The dice are demanding better snacks.",
                "That result has strong mimic-energy.",
                "The dice rolled low and immediately apologized.",
                "That's a roll better left out of the campaign log.",
                "A rough one—even the goblins felt bad.",
                "The dice seem to be having an off night.",
                "That roll wandered off the beaten path.",
                "A humble result, character-building at best.",
                "The dungeon's odds just got a little better.",
                "That roll needs a long rest and a pep talk.",
                "Not every roll can be legendary, apparently.",
                "The dice rolled low and hid behind the DM screen.",
                "A roll destined for the blooper reel.",
                "That result has 'try again' written all over it.",
                "The prophecy did not see that one coming, unfortunately.",
                "A roll that even the party's cleric can't fix.",
                "That's the kind of roll bards leave out of the song.",
              ]
            : [
                "Fate has spoken—no rerolling destiny.",
                "The dungeon master may now pretend this was planned.",
                "That roll wandered in from a side quest.",
                "Somewhere, a bard is composing a song about this.",
                "Your modifiers are doing the heavy lifting.",
                "The goblins are taking notes.",
                "The prophecy remains open.",
                "Fate rolled over and asked for advantage.",
                "The initiative order has noticed you.",
                "A perfectly serviceable bit of adventuring.",
                "The dice have offered a plot twist.",
                "The tavern is buying the next round.",
                "The campaign continues, one roll at a time.",
                "A solidly average result—the dungeon shrugs.",
                "The dice landed right in the middle of the story.",
                "Not legendary, not disastrous—just adventuring.",
                "The DM nods and moves the story along.",
                "A roll that keeps the plot moving forward.",
                "The party's chronicler notes it and carries on.",
                "That's a roll fit for a Tuesday quest.",
              ];
  const pun = puns[Math.floor(Math.random() * puns.length)];
  const text = `🎲 ${label}: ${expression} → [${rolls.join(", ")}]${mod ? (mod > 0 ? `+${mod}` : mod) : ""} = ${total}. ${pun}`;
  // rawD20 is the unmodified die face (1-20) whenever exactly one d20 was
  // rolled — a flat bonus (e.g. "1d20+5" for an ability check) doesn't
  // change it, since the modifier isn't part of the natural result. null for
  // anything that isn't a single d20 (e.g. 2d6, 4d8). Callers use this to
  // log leaderboard events without re-parsing the formatted text.
  return { text, rawD20 };
}

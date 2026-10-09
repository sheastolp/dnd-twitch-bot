// GuildScribe — the step-by-step how-to guides (GET /howto/<slug>), part 2:
// gameplay and community features. Part 1 (howto_pages.ts) covers channel
// setup; howto.ts renders both. Bodies are static, trusted HTML.

import type { HowtoTopic } from "./howto_pages.ts";

export const HOWTO_PLAY: HowtoTopic[] = [
  {
    slug: "first-character",
    title: "Start your adventure",
    audience: "Everyone",
    summary: "Make a character, hunt your first monster, level up and join a party.",
    steps: [
      `Make a character. <code>!createchar</code> rolls one instantly; <code>!newchar</code> walks you through race, class and scores (answer with <code>!answer &lt;choice&gt;</code>); <code>!bg3</code> rolls a Baldur's Gate 3 style hero you finish with point-buy.`,
      `Check your sheet with <code>!char</code>. It links to a full character page.`,
      `Hunt: <code>!dndduel</code> sends you against a monster scaled to your level, or name one: <code>!dndduel goblin</code>. Slain monsters give <strong>XP</strong> and a little coin.`,
      `Got a few minutes? <code>!autohunt 30m</code> sends your hero hunting on its own and reports back.`,
      `Team up: <code>!party create crew</code>, invite friends with <code>!party invite @friend crew</code>, then hunt together with <code>!party hunt crew</code>.`,
      `Duel a friend for glory (no XP) with <code>!dndduel @friend</code>.`,
    ],
    tips: [
      `<code>!savechar</code> keeps a backup and <code>!loadchar</code> restores it.`,
      `There's a short hunting cooldown between hunts; <code>!huntcd</code> shows yours.`,
      `<code>!roster</code> lists every adventurer and party; <code>!bestiary</code> lists every monster you can hunt.`,
    ],
    codex: "parchment",
    pages: [["Guild roster", "/go/roster"], ["Bestiary", "/go/bestiary"], ["Gear", "/go/gear"]],
  },
  {
    slug: "gold",
    title: "Earn and spend gold",
    audience: "Everyone",
    summary: "How viewers earn coin, what it buys, and how to check the leaderboard.",
    steps: [
      `Chat while the stream is live: every minute you chat earns copper. Monster kills drop coin too.`,
      `<code>!gold</code> shows your purse and rank; <code>!gold top</code> shows the richest adventurers.`,
      `Spend it: haggle with the peddler (<code>!haggle</code>), buy giveaway tickets (<code>!giveaway enter 3</code>), or gift a friend (<code>!gold give @friend 5sp</code>).`,
      `Feeling bold? <code>!rob @user</code> fights them for 1–9% of the loser's coin, so a failed robbery costs you.`,
    ],
    tips: [
      `Coins follow 5e rates: 10 cp = 1 sp, 10 sp = 1 gp. Amounts can be typed as <code>50</code>, <code>5sp</code>, <code>1gp</code> or <code>1gp 2sp</code>.`,
      `Mods: <code>!gold on</code>/<code>off</code> switches the whole coin system (on by default); <code>!gold add</code>/<code>remove</code>/<code>set @user &lt;amount&gt;</code> fix balances.`,
    ],
    codex: "gold",
  },
  {
    slug: "raid",
    title: "Run the raid quest",
    audience: "Everyone",
    summary: "Gather up to six heroes against this stream's raid boss, whose HP carries over between raids.",
    steps: [
      `When the stream goes live, the bot posts a raid quest: a powerful boss (CR 13+) with five times its usual HP.`,
      `Anyone with a saved character types <code>!rally</code> to sound the war horn. Others type <code>!rally</code> to join the muster, up to 6 raiders.`,
      `The party charges a minute later, or right away when full. The muster's leader or a mod can launch early with <code>!rally go</code>.`,
      `The boss keeps its wounds between raids. When it falls, everyone who struck it this stream gets its full XP and a share of a big hoard.`,
      `<code>!rally status</code> shows the boss's HP and when the next raid can muster.`,
    ],
    tips: [
      `Mods: <code>!rally cooldown 5m</code> sets the wait between raids (default 10 minutes); <code>!rally new</code> posts a fresh quest if the bot joined mid-stream.`,
      `Put the boss's HP bar on stream with the <code>raid</code> overlay (<a href="/howto/overlays">Add OBS overlays</a>).`,
    ],
    codex: "arena",
  },
  {
    slug: "market",
    title: "Open the peddler's market",
    audience: "Mods+",
    summary: "Turn on the traveling peddler, whose wares viewers can haggle for with real coin.",
    steps: [
      `Turn it on with <code>!market on</code> (it's off by default). <code>!market status</code> checks it.`,
      `Every so often while you're live, a peddler posts a sales pitch for one item and its price.`,
      `Viewers check the current ware with <code>!stall</code> and bargain with <code>!haggle &lt;pitch&gt;</code>, e.g. <code>!haggle five copper and a song?</code>. Each viewer gets three tries per item.`,
      `If the peddler agrees, the buyer pays that price in coin and the item's small bonus goes onto their character sheet. <code>!gear</code> lists a sheet's gear.`,
    ],
    tips: [
      `With gold switched off, haggling is free banter and nothing changes hands.`,
      `Show the current ware on stream with the <code>merchant</code> overlay.`,
    ],
    codex: "onboarding",
  },
  {
    slug: "maps",
    title: "Build a battle map",
    audience: "Mods+",
    summary: "Make a grid map from a template, paint terrain, and let players place their own tokens.",
    steps: [
      `Create one, optionally from a template: <code>!map create tavern1 12x10 tavern</code>. <code>!map templates</code> lists the layouts (tavern, dungeon, forest_clearing, graveyard, cave, arena).`,
      `Paint terrain: <code>!map paint tavern1 4 2 wall</code>, or reset everything with <code>!map fill tavern1 grass</code>. <code>!map terrains</code> lists the options. Coordinates start at (1,1) in the top-left.`,
      `Players add their own hero with <code>!map addchar tavern1 3 3</code> and move it with <code>!map move tavern1 4 3</code>.`,
      `Share it: <code>!map view tavern1</code> posts a link to the live, auto-refreshing map page.`,
    ],
    tips: [
      `Mods can place or move anyone's token by adding <code>@user</code>. Water, walls, mountains, lava and void block tokens.`,
    ],
    codex: "maps",
    pages: [["Battle maps", "/go/maps"]],
  },
  {
    slug: "npcs",
    title: "Add AI-voiced NPCs",
    audience: "Mods+",
    summary: "Create in-character NPCs your chat can talk to, and optionally let them chime in on their own.",
    steps: [
      `Turn NPCs on with <code>!npc on</code> (off by default).`,
      `Create one with a personality: <code>!npc add Barliman a gruff, forgetful innkeeper who loves gossip</code>.`,
      `Viewers talk to it with <code>!npc talk Barliman what's the news?</code>. <code>!npc list</code> shows who's available.`,
      `Optional: <code>!npc chatter on</code> lets NPCs chime into chat now and then without being asked.`,
    ],
    tips: [
      `Change or delete one with <code>!npc edit &lt;name&gt; &lt;personality&gt;</code> and <code>!npc remove &lt;name&gt;</code>.`,
      `<code>!chronicle on</code> is a lighter touch: it occasionally quotes a chat message back with a D&amp;D-flavored reply.`,
    ],
    codex: "extras",
  },
  {
    slug: "moderation",
    title: "Keep chat tidy: swear jar, auto-ban & nicknames",
    audience: "Mods+",
    summary: "Fine swearing into a jar, ban fake-viewer spam automatically, and give viewers short battle-log names.",
    steps: [
      `The <strong>swear jar</strong> is automatic: each swear word costs the chatter 2 cp, announced in chat. <code>!jar</code> shows the total; <code>!fine</code> fines the streamer.`,
      `Mods can fine a viewer with <code>!jar +5sp @user</code>, take coin out with <code>!jar -1gp</code>, and once a week hand the whole jar to a random recent chatter with <code>!jar giveaway</code>.`,
      `The jar learns your channel's own swears. Review them with <code>!jar words</code> and veto one with <code>!jar forget &lt;word&gt;</code>.`,
      `Turn on <code>!autoban on</code> to permanently ban anyone (not mods) who posts "ai viewers" spam. It's off by default and needs the broadcaster to have <a href="/connect">reconnected</a> once.`,
      `Give someone a short name for battle logs and replies: <code>!nick @felivore Fel</code>. <code>!nick list</code> shows them all.`,
    ],
    tips: [
      `Put the jar total on stream with the <code>jar</code> overlay.`,
    ],
    codex: "gold",
  },
];

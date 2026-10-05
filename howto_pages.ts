// GuildScribe — the step-by-step how-to guides (GET /howto/<slug>), part 1:
// setting up and running the channel. Part 2 (howto_pages2.ts) covers the
// gameplay/community guides. howto.ts renders both and links them from the
// Guild Codex. Bodies are static, trusted HTML.

export type HowtoTopic = {
  slug: string;
  title: string;
  /** Who it's for, shown as a pill: "Streamers", "Mods+" or "Everyone". */
  audience: string;
  /** One sentence for the index cards. */
  summary: string;
  steps: string[];
  tips?: string[];
  /** Codex section anchor (on /guide) with the full command reference. */
  codex?: string;
  /** Related pages, as [label, href]; "{channel}" is filled in by /go. */
  pages?: Array<[string, string]>;
};

export const HOWTO_SETUP: HowtoTopic[] = [
  {
    slug: "connect",
    title: "Connect GuildScribe to your channel",
    audience: "Streamers",
    summary: "Raise the guild banner in your channel, give the bot a voice, and reconnect when new features arrive.",
    steps: [
      `Open the <a href="/">GuildScribe home page</a> and click <strong>Raise the Guild Banner in My Channel</strong> (or go straight to <a href="/connect">/connect</a>).`,
      `Log in to Twitch <strong>as the broadcaster</strong> and approve the permissions. They cover chat, sub and raid thank-yous, ad-break checks, channel-point rewards, the auto-ban, followage and the chat list for watch time.`,
      `In your Twitch chat, type <code>/mod GuildScribeBot</code> so the bot can hear and answer reliably.`,
      `Type <code>!help</code> in chat to check the bot answers, then <code>!guide</code> to post the Codex link for your viewers.`,
      `When GuildScribe gains a feature that needs a new permission, <a href="/connect">reconnect</a> the same way. It's safe to run any time and never duplicates or loses your data.`,
    ],
    tips: [
      `While you're offline, the bot ignores regular viewers. Mods and the broadcaster can still use every command, so you can test without going live.`,
      `<code>!dndbot off</code> closes the guild hall for a while; <code>!dndbot leave</code> disconnects; <code>!dndbot leave purge</code> also deletes the channel's characters, gold and logs (broadcaster only).`,
    ],
    codex: "onboarding",
  },
  {
    slug: "dashboard",
    title: "Use the web dashboard",
    audience: "Mods+",
    summary: "Switch features on and off and manage custom commands, triggers and timed messages from a browser.",
    steps: [
      `In your Twitch chat, type <code>!dashboard</code>. Only the broadcaster and moderators can. The bot posts a private link.`,
      `Open the link and click <strong>Log in with Twitch</strong>. GuildScribe checks, right then, that your account is a moderator or the broadcaster of that channel.`,
      `Use the <strong>Bot &amp; feature switches</strong> to turn whole features (gold, raids, hunts, the market…) on or off. Viewers' commands for a switched-off feature go quiet.`,
      `Add, edit or delete custom commands, chat triggers and timed messages with the forms instead of chat syntax.`,
      `After you've logged in once, the <strong>⚙ Dashboard switch</strong> links on every Codex card jump straight to the matching switch for the next 12 hours.`,
    ],
    tips: [
      `If the link leaks, <code>!dashboard reset</code> retires it and issues a new one. A leaked link is useless to non-mods anyway, because of the Twitch login check.`,
    ],
    codex: "custom",
    pages: [["Open my dashboard", "/dashboard/go"]],
  },
  {
    slug: "overlays",
    title: "Add OBS overlays",
    audience: "Streamers",
    summary: "Put the raid boss, live battles, the giveaway, leaderboards and more on stream as transparent browser sources.",
    steps: [
      `Type <code>!overlays</code> in chat (mods+), or open the <a href="/go/overlays">overlay setup page</a> and enter your channel. It lists every overlay with its URL, a suggested size and a live preview.`,
      `In OBS, add a <strong>Browser</strong> source to your scene.`,
      `Paste an overlay URL and set the width and height shown next to it. Leave OBS's default custom CSS as it is; the background is already transparent.`,
      `Position it, and you're done. Overlays refresh themselves every few seconds and hide while they have nothing to show.`,
    ],
    tips: [
      `<strong>Which overlay?</strong> <code>status</code> is a slim strip for a screen edge; <code>raid</code>, <code>battle</code>, <code>giveaway</code>, <code>merchant</code> and <code>jar</code> show live state; <code>gold</code>, <code>dice</code> and <code>guild</code> are leaderboards and summaries; <code>all</code> stacks everything and <code>rotate</code> cycles through one at a time.`,
      `URL extras: <code>&amp;scale=1.5</code>, <code>&amp;align=right</code> or <code>center</code>, <code>&amp;refresh=10</code>, <code>&amp;limit=3</code>, <code>&amp;window=week</code> (dice), <code>&amp;cycle=20</code> (rotate), and <code>&amp;always=1</code> to show a placeholder while positioning.`,
      `Overlays for features switched off on your dashboard stay hidden.`,
      `<strong>Words on Stream replacement:</strong> the theme's Be right back and Just chatting scenes play <strong>The Endless Delve</strong> in their big window — an idle dungeon crawl your chat powers just by chatting (<code>fireball</code> and <code>bless</code> in chat are spells; <code>!delve</code> explains it). It needs no extra source; add <code>&amp;idle=0</code> to the theme link to keep the window for Words on Stream instead, or use the <code>idle</code> overlay on its own.`,
    ],
    pages: [["Overlay setup page", "/go/overlays"]],
  },
  {
    slug: "stream-day",
    title: "Get ready for each stream",
    audience: "Streamers",
    summary: "Your go-live checklist, what the bot does automatically when you go live, and ad-break reminders.",
    steps: [
      `Add your own to-dos once: <code>!checklist add turn on alerts</code>, <code>!checklist add post in Discord</code>. <code>!checklist</code> shows the list and <code>!checklist remove &lt;n&gt;</code> drops one. Then switch the go-live reminder on with <code>!checklist on</code> (it's off by default).`,
      `When you go live (with the reminder on and at least one item), GuildScribe whispers you that checklist plus a one-line summary of which features are on (gold, market, chronicle, NPCs, auto-ban, swear jar, raid quest, timed messages, triggers). If it can't whisper, it posts once in chat.`,
      `At the same moment the bot posts this stream's <strong>raid quest</strong> (if the raid switch is on). See <a href="/howto/raid">Run the raid quest</a>.`,
      `During the stream, GuildScribe warns chat a few minutes before Twitch's next scheduled ad break and posts a short notice when one starts (dashboard switch: <em>Ad-break alerts</em>). <code>!adcheck</code> (mods) shows when the last ad ran and when the next one is due, so you can plan around it.`,
    ],
    tips: [
      `<code>!checklist off</code> stops the go-live reminder but keeps your items.`,
      `When you go offline the bot goes quiet for viewers until next time, and this stream's raid quest is retired.`,
    ],
    codex: "onboarding",
  },
  {
    slug: "custom-commands",
    title: "Make custom commands & chat triggers",
    audience: "Mods+",
    summary: "Add your own !commands and keyword auto-replies, with placeholders for names, dice and live channel info.",
    steps: [
      `Create a command: <code>!dndbot add socials Find us at twitch.tv/{channel}!</code>. Anyone can now type <code>!socials</code>.`,
      `Change or remove it with <code>!dndbot edit socials &lt;new text&gt;</code> and <code>!dndbot remove socials</code>; pause it with <code>!dndbot disable socials</code>.`,
      `Create a trigger, which fires when a word appears anywhere in chat with no <code>!</code>: <code>!trigger add "nat 20" 🎉 {user} rolled greatness!</code>. Quote keywords with spaces.`,
      `Tune cooldowns with <code>!dndbot cooldown &lt;name&gt; &lt;seconds&gt;</code> (default 5s) and <code>!trigger cooldown &lt;keyword&gt; &lt;seconds&gt;</code> (default 15s).`,
      `Prefer forms? Do all of this on the <a href="/howto/dashboard">web dashboard</a>.`,
    ],
    tips: [
      `Handy placeholders: <code>{user}</code>, <code>{target}</code> (first @mention), <code>{args}</code>, <code>{count}</code>, <code>{random:a|b|c}</code>, <code>{randnum:1-100}</code>, <code>{d20}</code>, <code>{math:(3+4)*2}</code>, <code>{game}</code>, <code>{title}</code>, <code>{uptime}</code>.`,
      `Custom names can't reuse a built-in command word.`,
    ],
    codex: "custom",
  },
  {
    slug: "timed-messages",
    title: "Schedule timed messages",
    audience: "Mods+",
    summary: "Recurring announcements that post themselves on their own schedule while you're live.",
    steps: [
      `Add one: <code>!timedmsg add 30 Don't forget to follow and make a character with !createchar!</code> posts every 30 minutes.`,
      `<code>!timedmsg list</code> shows each message's id, interval and on/off state.`,
      `Edit with <code>!timedmsg edit &lt;id&gt; &lt;text&gt;</code>, change the pace with <code>!timedmsg interval &lt;id&gt; &lt;minutes&gt;</code>, pause with <code>!timedmsg disable &lt;id&gt;</code>, or delete with <code>!timedmsg remove &lt;id&gt;</code>.`,
    ],
    tips: [
      `Each message keeps its own clock, so several messages rotate instead of firing together. Timing is approximate (within about 15 minutes).`,
      `Messages support <code>{count}</code> and <code>{random:a|b|c}</code>, and only post while you're live.`,
    ],
    codex: "custom",
  },
  {
    slug: "channel-points",
    title: "Link channel-point rewards",
    audience: "Streamers",
    summary: "Let viewers spend channel points on a robbery shield or to hex someone out of a feature.",
    steps: [
      `If you connected before this feature existed, <a href="/connect">reconnect</a> once so GuildScribe can see redemptions.`,
      `Create the reward in Twitch as usual. For a hex, tick <strong>Require viewer to enter text</strong>.`,
      `Link it by its exact title. Shield (the redeemer can't be robbed): <code>!boon add shield 30 Guard Duty</code>. Hex (lock someone out of a feature): <code>!boon add lockout 10 Curse a Rival</code>.`,
      `Viewers redeem it. For a hex they type <code>&lt;user&gt; &lt;feature&gt;</code>, e.g. <code>bob rob</code>. Features: <code>rob</code>, <code>haggle</code>, <code>duel</code>, <code>autohunt</code>, <code>dice</code>, <code>gold</code>.`,
      `Check with <code>!boon list</code> and <code>!boon status [@user]</code>; unlink with <code>!boon remove &lt;title&gt;</code>; lift everything on someone with <code>!boon clear @user</code>.`,
    ],
    tips: [
      `Buying the same effect again adds time, up to 2 hours. The broadcaster, the bot and the redeemer can't be hexed.`,
      `GuildScribe can't refund rewards it didn't create (a Twitch rule), so a mod refunds a malformed redemption from the rewards queue.`,
    ],
    codex: "gold",
  },
  {
    slug: "giveaways",
    title: "Run a giveaway",
    audience: "Mods+",
    summary: "Open a free or ticketed giveaway, draw a weighted winner, and reroll or refund if needed.",
    steps: [
      `Make sure gold is on (<code>!gold status</code>); it is by default.`,
      `Open it: <code>!giveaway start Steam key</code> for a free one, or <code>!giveaway start cost=5sp max=5 Steam key</code> for tickets at 5 sp each, up to 5 per viewer (no spaces inside the cost).`,
      `Viewers enter with <code>!giveaway enter</code> or <code>!giveaway enter 3</code>. <code>!giveaway</code> shows the prize and counts.`,
      `Draw with <code>!giveaway draw</code>. The winner is weighted by tickets and entries close.`,
      `Winner didn't answer? <code>!giveaway reroll</code> draws again without them. Call it off with <code>!giveaway cancel</code>, which refunds every ticket.`,
    ],
    tips: [
      `Show it on stream with the <code>giveaway</code> overlay; it shows the winners for ten minutes after the draw. See <a href="/howto/overlays">Add OBS overlays</a>.`,
      `The swear jar has its own weekly giveaway: <code>!jar giveaway</code>.`,
    ],
    codex: "gold",
  },
];

# GuildScribe — Guild Hall for Twitch D&D

*Part of the **GuildForge** suite — Forge your stream. Command your chat.*

**GuildScribe** is a Dungeons & Dragons 5e (2014 SRD-style) **guild hall** that lives in Twitch chat.  
Adventurers create characters, form companies, consult the archives, roll fate's dice, duel in the arena, and hunt monsters in the wilds.

Runs on **Val Town** (Deno) with **SQLite** persistence and Twitch **EventSub** + Helix chat.

**Live codex (command guide):** set `PUBLIC_BASE_URL` in `main.ts`, then open `{PUBLIC_BASE_URL}/guide`  
Chat: `!guide` or `!link` posts that same URL.

---

## Features at a glance

| Pillar | What the guild offers |
|--------|------------------------|
| **Parchment** | Characters with level, XP, HP, race/class, save/load |
| **Company** | Parties with invite, roster (members listed), disband |
| **Archives** | Spells, items, classes, feats, races, **rules** (+ public links), plus a standalone **Baldur's Gate 3 knowledgebase** (`!bg3lookup`) for companions, origins, classes, races, locations, factions, deities, villains, and legendary items |
| **Fate's dice** | `!d20`, `!roll`, roll for another adventurer, `!bg3roll`/`!bg3companion`/`!bg3origin`/`!bg3loot`/`!bg3camp` for Baldur's Gate 3 flavor |
| **Arena & wilds** | Auto/classic PvP, solo monsters, party duels, **party hunts** |
| **Maps** | Grid battle maps with paintable terrain (grass, water, wall, lava, and more), ready-made layout templates (tavern, dungeon, forest clearing, graveyard, cave, arena), a live visual web view, and character tokens that adventurers place and move themselves |
| **XP** | From **monster** victories only (not PvP) |
| **Subs** | D&D-themed auto thank-you in chat for new subs, renewals, and gift subs — including a welcome for the recipient and (unless anonymous) a shout-out to the gifter (requires `channel:read:subscriptions`) |
| **Raids** | D&D-themed auto thank-you in chat when another channel raids in, naming the raiding channel and party size — no extra OAuth scope needed |
| **Stewards** | Channel on/off, disconnect/purge, in-chat activity logs, OAuth connect |
| **Custom commands** | Broadcasters/mods add their own `!commands` and passive keyword triggers from chat, no code required |
| **NPC characters** | AI-voiced NPCs with an author-defined personality — chat with them via `!npc talk`, or let one randomly chime into chat unprompted with `!npc chatter on`. **Off by default**, toggled per channel with `!npc on`/`off`/`status` *(mod)*. Each channel can build its own roster, plus a shared "global" roster as a fallback |
| **Passive chat** | Detects plain-chat "goodnight" messages and sends the room off with a themed reply |
| **Market** | An open-stall merchant periodically posts a one-line D&D-flavored sales pitch in chat. **Off by default**, toggled per channel with `!market on`/`off`/`status` *(mod)*; flavor only, no coin or inventory state |
| **Chronicle** | Randomly quotes a plain chat message back with a one-line D&D-flavored reply. **Off by default**, toggled per channel with `!chronicle on`/`off`/`status` *(mod)*; low odds per message, a per-channel cooldown, and a minimum-activity threshold keep it rare — bot messages count toward that activity but are never quoted |
| **Ad reminders** | `!adcheck` *(mod)* reports Twitch's real ad-schedule status (next ad, duration, snoozes left, time since last ad) with a ⚠️ reminder once too long has passed; `!adslogged` *(mod)* manually marks an ad break for channels without the `channel:read:ads` scope granted yet. Not the same feature as Market above, which is flavor text only |

---

## Module map

| File | Role |
|------|------|
| **main.ts** | HTTP entry, OAuth, EventSub, **command router** — Val Town HTTP trigger |
| **merchant.ts** | `!market on/off/status` toggle + open-stall merchant ad flavor generator (no DB writes beyond the toggle) |
| **merchant.cron.ts** | Posts a merchant ad to every channel that's due — Val Town **cron trigger** |
| **chronicle.ts** | `!chronicle on/off/status` toggle + the random chat-quoting roll/flavor generator (no cron — fires inline off the plain-chat message path) |
| **ads.ts** | `!adcheck`/`!adslogged` — real Twitch ad-schedule status + manual fallback tracking (uses the broadcaster's own `channel:read:ads` token, refreshed as needed) |
| **types.ts** | Shared types |
| **data.ts** | Races, classes, level-scaled monsters, lookup map |
| **utils.ts** | Dice, formatting, narration, Central Time helpers (`formatCentralDateTime`/`Clock`/`Date`) |
| **db.ts** | SQLite schema + persistence |
| **characters.ts** | Generation, XP, leveling, `!newchar` wizard |
| **bg3.ts** | `!bg3roll`, `!bg3companion`, `!bg3origin`, `!bg3loot`, `!bg3camp` — standalone Baldur's Gate 3 flavor generators (no DB); `!bg3` — random race/class + player-chosen BG3 point-buy scores, saved via db.ts |
| **bg3data.ts** | Static Baldur's Gate 3 knowledgebase — companions, origins, classes, races, locations, factions, deities, villains, legendary items |
| **bg3lookup.ts** | `!bg3lookup` — search + formatting over the `bg3data.ts` knowledgebase (no DB, no external API — it's hand-curated, unlike `lookups.ts`) |
| **combat.ts** | Duels, parties, hunts, initiative |
| **customcommands.ts** | `!dndbot add/edit/remove/cooldown/list` custom commands and `!trigger` passive keyword auto-responses |
| **npcs.ts** | AI-voiced NPC characters — roster CRUD, LLM reply generation (`generateNpcReply`), the `!npc` Twitch command, and random unprompted chatter (`maybeNpcChatter`) |
| **maps.ts** | `!map` — create/list/view/delete grid battle maps, paint/fill terrain, and place/move/remove character tokens |
| **lookups.ts** | dnd5eapi + formatting + reference links |
| **twitch.ts** | Tokens (app + broadcaster user tokens, refresh), multi-part chat send, ad-schedule fetch |
| **pages.ts** | Guild Codex HTML, logs, character sheet UI, battle map view/list pages, operator admin logs page |
| **README.md** | This document |

---

## Setup (Val Town)

1. Upload all modules into one Val project.
2. Point the **HTTP trigger** at **`main.ts`**.
2a. Point a **cron trigger** at **`merchant.cron.ts`** (every 5-10 minutes is plenty — the merchant's own per-channel posting cadence is randomized independently, see `MERCHANT_MIN_INTERVAL_MINUTES`/`MERCHANT_MAX_INTERVAL_MINUTES` below). The market is off by default in every channel regardless of whether this trigger is set up; without it, `!market on` will simply never produce a post.
3. Environment variables:

| Variable | Purpose |
|----------|---------|
| `TWITCH_CLIENT_ID` | Twitch app client ID |
| `TWITCH_CLIENT_SECRET` | Twitch app secret |
| `TWITCH_BOT_ID` | Bot account numeric user ID |
| `EVENTSUB_SECRET` | EventSub signature secret |
| `BOT_USERNAMES` | *(optional)* Extra bot logins to ignore |
| `MAX_PARTIES_PER_CHANNEL` | *(optional)* Party cap per channel; default 50 |
| `MAX_CHARACTERS_PER_CHANNEL` | *(optional)* Character cap per channel; default 500 |
| `MAX_MAPS_PER_CHANNEL` | *(optional)* Battle map cap per channel; default 25 |
| `MAX_CUSTOM_COMMANDS_PER_CHANNEL` | *(optional)* Custom `!dndbot` command cap per channel; default 100 |
| `MAX_CUSTOM_TRIGGERS_PER_CHANNEL` | *(optional)* Custom `!trigger` cap per channel; default 50 |
| `ADMIN_API_SECRET` | **Required for operator override**; secret bearer token for `/admin/channels/<broadcaster_id>/(disable|enable)`, `/admin/merchant/status`, and `/admin/logs` |
| `SUPPORT_URL` | *(recommended)* Support/contact URL shown in the privacy policy and home page |
| `PUBLIC_BASE_URL` | *(recommended)* Public HTTPS URL used in chat links; must match the deployed Val URL |
| `COMMAND_COOLDOWN_MS` | *(optional)* Durable per-channel/user command cooldown; default 1200ms |
| `GOODNIGHT_COOLDOWN_MS` | *(optional)* Durable per-channel cooldown between "goodnight" auto-replies; default 300000ms (5 min), floor 30000ms |
| `CHAT_GLOBAL_MIN_INTERVAL_MS` | *(optional)* Global bot-account chat-send spacing; default 1600ms. Lower only after Twitch confirms the account's applicable limit/verification. |
| `MERCHANT_MIN_INTERVAL_MINUTES` | *(optional)* Shortest gap between open-stall merchant ads in a channel with `!market on`; default 25, floor 5 |
| `MERCHANT_MAX_INTERVAL_MINUTES` | *(optional)* Longest gap between open-stall merchant ads; default 60, floored at the min above |
| `CHRONICLE_QUOTE_CHANCE_PERCENT` | *(optional)* Odds (0-100) that any single qualifying plain chat message gets chronicled in a channel with `!chronicle on`; default 3 |
| `CHRONICLE_COOLDOWN_MS` | *(optional)* Durable per-channel cooldown between chronicle quotes; default 600000ms (10 min), floor 30000ms |
| `CHRONICLE_MIN_MESSAGES` | *(optional)* Minimum chat messages (any account, bots included) since the last chronicle quote before another can fire; default 15 |
| `PRIMARY_BROADCASTER_ID` | *(optional)* Twitch broadcaster ID allowed to manage the shared "global" NPC roster via `!npc global add/edit/remove`; unset means no channel can write to it |
| `NPC_MODEL` | *(optional)* OpenAI model used for NPC replies; default `gpt-4o-mini` |
| `MAX_NPCS_PER_OWNER` | *(optional)* NPC roster cap per channel; default 25 |
| `NPC_CHATTER_CHANCE_PERCENT` | *(optional)* Odds (0-100) that any single qualifying plain chat message triggers a random NPC chime-in in a channel with `!npc chatter on`; default 4 |
| `NPC_CHATTER_COOLDOWN_MS` | *(optional)* Durable per-channel cooldown between random NPC chime-ins; default 900000ms (15 min), floor 60000ms |
| `NPC_CHATTER_MIN_MESSAGES` | *(optional)* Minimum chat messages (any account, bots included) since the last chime-in before another can fire; default 20 |
| `AD_REMINDER_MINUTES` | *(optional)* Minutes since the last known ad break before `!adcheck` flags a ⚠️ reminder; default 20 |

4. Twitch Developer Console → OAuth Redirect URLs must include **both**:  
   `https://<your-val>.web.val.run/callback` (bot connect flow)  
   `https://<your-val>.web.val.run/dashboard/callback` (mod/broadcaster login for the Guild Dashboard — see below)  
   (or your custom domain's equivalents, e.g. `https://guildscribe.val.run/callback` and `https://guildscribe.val.run/dashboard/callback`)
5. Set `PUBLIC_BASE_URL` as an environment variable to your public HTTPS URL (used by `!guide` / `!link`). This deployment defaults to `https://guildscribe.val.run` when the env var isn't set.
6. Open the Val URL → **Raise the Guild Banner** → authorize.
7. In channel chat: `/mod YourBotName`

The OAuth flow requests `channel:bot channel:read:subscriptions channel:read:ads` — the sub scope powers the sub/resub thank-you (see below), and the ads scope powers `!adcheck`'s real Twitch ad-schedule lookup (see below). **Channels that connected before one of these scopes was added need to reconnect** (the home page and guide both have a "reconnect" link — both point at `/connect`, same as the initial connect button) for the corresponding feature to start working; the rest of the bot is unaffected either way. `/connect` → `/callback` is idempotent: reconnecting an already-connected channel cleans up its old EventSub subscriptions first, so it's safe to run any time GuildScribe gains a feature that needs a new permission, without duplicating subscriptions or losing existing character/party data.

### Guild Dashboard (`/dashboard`)

A separate, mod/broadcaster-gated web page with on/off switches for each module (bot, open-stall merchant, chronicle, NPC characters, NPC random chatter) — an alternative to `!dndbot on/off`, `!market on/off`, `!chronicle on/off`, `!npc on/off`, `!npc chatter on/off` in chat.

This is a **different Twitch login from `/connect`**: `/connect` authorizes the *bot* against a broadcaster's channel (`channel:bot` scope); `/dashboard` signs in the *viewer* so GuildScribe can check whether they moderate or broadcast a connected channel, using the `user:read:moderated_channels` scope and Twitch's Get Moderated Channels endpoint. Signing into the dashboard grants no bot permissions and doesn't touch `channel:bot` at all.

- `GET /dashboard` redirects to Twitch sign-in if there's no session cookie; afterward it shows a channel picker (if the viewer moderates/broadcasts more than one connected channel) or goes straight to the single channel's switches.
- Moderator status is re-checked against the Twitch API on every dashboard view and every toggle — a demotion in Twitch takes effect immediately rather than trusting a cached claim.
- Sessions live in the `dashboard_sessions` table (access + refresh token, never exposed to the browser — only an opaque session id is cookied) and last up to 30 days, refreshing the underlying Twitch token transparently.
- `GET /dashboard/logout` clears the session.
- The module list is data-driven: `DASHBOARD_MODULES` in `main.ts` is the single source of truth (key, label, description, and the `isEnabled`/`setEnabled` functions to call). Adding a future module's switch to the dashboard means adding one entry to that array — the status page, the toggle handler, and key validation all read from it, so nothing else needs to change.

Delete any old **`http.ts`** entry file after switching the trigger to `main.ts`.

---

## Chat commands (full index)

### Guild hall & help
| Command | Description |
|---------|-------------|
| `!help` | Guild hall welcome + path to begin |
| `!guide` / `!link` | **Posts the Guild Codex URL** (`/guide`) |
| `!dndbothelp` | Codex chapters: dice, character, party, combat, lookup, maps, custom, settings |
| `!dndbothelp <chapter>` | Detailed syntax for that chapter |

### Adventurer's parchment (character)
| Command | Description |
|---------|-------------|
| `!createchar` | Instant level 1 character |
| `!createchar @user` | Create for another *(mod)* |
| `!newchar` | Guided wizard |
| `!bg3` | Random BG3-style race + class, then you assign ability scores via BG3 point-buy (base 8, cap 15, 27-point budget); saves and links the character |
| `!answer <choice>` | Wizard answer (also used to reply to `!bg3` prompts) |

Every adventurer keeps exactly one active character and one saved backup per channel. `!createchar`, `!newchar`, and `!bg3` all warn before overwriting an existing active character — reply `!answer yes` to confirm the overwrite or `!answer no` to keep what you have.
| `!cancel` | Cancel wizard / `!bg3` creation |
| `!char` / `!char @user` | Sheet summary (level, **XP**, stats, HP) |
| `!levelup` / `!levelup +/-N` | Adjust level |
| `!hp` / `!hp +/-N` | Show or change HP |
| `!savechar` / `!loadchar` / `!resetchar` | Backup / restore / reset |

### Fate's dice
| Command | Description |
|---------|-------------|
| `!d20` | Roll a d20 |
| `!d20 @user` | Roll for another adventurer |
| `!roll` / `!r` | Default 1d20 |
| `!roll 2d6+3` | Custom expression |
| `!roll @user 4d8` | Roll for someone |
| `!roll dex` / `!roll strength` | **Saving throw** — uses your saved character's ability modifier (+ proficiency if your class is proficient in that save) |
| `!roll stealth` / `!roll animal handling` | **Skill check** — uses your saved character's modifier for that skill's ability |
| `!roll @user dex` / `!roll @user stealth` | Saving throw / skill check using `@user`'s saved character instead of your own |
| `!roll <question>?` | D&D-flavored yes/no fate verdict, e.g. `!roll is enya going to die this time?` |
| `!bg3roll` | Random Baldur's Gate 3 style character: race/subrace, class/subclass, background, alignment, BG3-style point-buy scores, and an origin hook |
| `!bg3companion` | Rolls which BG3 companion you're traveling with (role, blurb, and an iconic line) |
| `!bg3origin` | Casts you as one of the six canonical BG3 Origin Characters (or the Dark Urge) for this run, with their hook |
| `!bg3loot` | Random magic item drop with a BG3-style rarity tier (Common → Legendary) |
| `!bg3camp` | Random camp-night vignette featuring one of the BG3 companions |
| `!rollcall` | Natural 20 leaderboard, top 3 for the past hour/day/week in one line |
| `!rollcall nat1` | Natural 1 leaderboard instead of nat 20 |
| `!rollcall nat20 week` / `!rollcall nat1 hour` | One time frame only (`hour`, `day`, or `week`), top 5 instead of top 3 |
| `!rollcall @user` | One player's own nat 20 **and** nat 1 counts across hour/day/week, instead of the channel-wide top list |
| `!rollcall @user week` | Same, but just the one time frame |

### Dice roller leaderboard
Every plain `1d20` roll from `!d20`/`!roll`/`!r` — including ability saving throws and skill checks, since those are `1d20` plus a modifier under the hood — is checked for a natural 1 or natural 20 and logged per channel. `!roll 2d6+3` and other multi-die expressions aren't "natural" rolls and are never logged. `!rollcall` (optionally `nat1` or `nat20`, defaulting to `nat20`) with no time frame shows a compact top 3 across all three windows at once; add `hour`, `day`, or `week` to see a bigger top 5 for just that window. Standings are per-channel and per-username (one entry per player even if their display name's capitalization has changed). Add `@user` instead to look up one player directly — `!rollcall @user` shows their own nat 20 **and** nat 1 counts side by side across all three windows (no need to pick a kind), and `!rollcall @user week` narrows it to one window.

### Guild archives (lookups)
| Command | Example |
|---------|---------|
| `!spell <name> [+N]` | `!spell fireball` |
| `!item <name> [+N]` | `!item longsword +1` |
| `!class` / `!feat` / `!ability` / `!race` / `!subrace` | `!class wizard` |
| `!monster <name>` | `!monster goblin`, `!monster adult red dragon` |
| `!rule` / `!rules <topic>` | `!rules magic`, `!rule advantage` |
| `!bg3lookup <name>` | `!bg3lookup astarion`, `!bg3lookup moonrise towers`, `!bg3lookup faction zhentarim` |

- Bare commands (`!rules` alone) → usage + examples  
- Rules: up to **3** chat messages, **link first** in the response, always a D&D Beyond **search link** (hardcoded Free Rules chapter URLs were dropped — they'd started returning 403s)  
- Other lookups include reference links where applicable, also shown first in the response  
- `!bg3lookup` is a separate, hand-curated **Baldur's Gate 3 knowledgebase** (companions, origins, classes, races, locations, factions, deities, villains, legendary items) — not the D&D 5e SRD data the other lookups use. Optionally narrow the search with a leading category keyword, e.g. `!bg3lookup companion karlach` or `!bg3lookup location grymforge`. Bare `!bg3lookup` lists the recognized categories. Each hit links to a `bg3.wiki` search for that name.  

### Guild company (parties)
| Command | Description |
|---------|-------------|
| `!party create <name>` | Found a company (you are leader **and** member) |
| `!party join <name>` | Join |
| `!party invite @user [name]` | Invite (name optional if you only have one party) |
| `!party accept [name]` / `decline [name]` | Invited user answers (name optional if only one pending invite) |
| `!party list` | **Your parties with leaders and members** |
| `!party list <name>` | One company roster |
| `!party leave <name>` | Leave |
| `!party disband <name>` | Leader dissolves the company |

### Player duels & hunts
| Command | Description |
|---------|-------------|
| `!dndduel @user` | Auto PvP challenge |
| `!dndduel classic @user` | Turn-based PvP |
| `!dndduel accept` / `decline` | Answer challenge |
| `!dndduel attack` / `status` / `end` | Classic turn / status / end |
| `!dndduel` | Auto **solo monster** (level-scaled) |
| `!dndduel monster` | Classic solo monster |
| `!dndduel party A B` | Auto party vs party |
| `!dndduel party classic A B` | Classic party vs party |
| `!dndduel party accept` / `decline` / `attack` / `status` / `end` | Party duel flow |
| `!dndduel party hunt <party> [monster]` | Auto **company vs monster** — random encounter, or a specific bestiary entry if you name one |
| `!dndduel party hunt classic <party> [monster]` | Classic hunt — same optional targeting |
| `!dndduel party hunt attack` / `status` / `end` | Hunt turns |

**XP** is granted only when a **monster** falls (solo or party hunt). PvP awards none.

**Targeted hunts:** the optional `[monster]` on `!dndduel party hunt` matches the same way as `!monster <name>` — an exact name wins, otherwise the first bestiary entry whose name contains what you typed (case-insensitive), e.g. `!dndduel party hunt myparty remorhaz` or `!dndduel party hunt classic myparty adult red dragon`. The named monster is still scaled to the party's average level exactly like a random pick — naming one only picks *which* monster, not its stats. If nothing matches, the bot tells you and the hunt doesn't start; leave the monster name off for a random, level-appropriate pick.

**Timeouts:** a pending challenge (`accept`/`decline`) expires after 5 minutes if unanswered. Any active classic (turn-based) duel — 1v1, party vs. party, or a party hunt — auto-forfeits to the non-idle side if nobody acts for 10 minutes, so an abandoned duel can't block that channel's dueling into the next stream. Both windows are checked lazily the next time anyone runs a `!dndduel` command in that channel (no idle duel needs to be manually ended first).

### Initiative tracker
| Command | Description |
|---------|-------------|
| `!turn start` … `!turn end` | Initiative tracker *(start/add/show/next/prev/remove/end are mod-only; `!turn roll` is open to any player, rolls 1d20+DEX)* |

### Custom commands & triggers
Shares the `!dndbot` word used by [Stewards](#stewards-settings) below, but different subcommands (`add`/`edit`/`remove`/`cooldown`/`list` vs. `on`/`off`/`status`/`leave`), so there's no collision.

| Command | Description |
|---------|-------------|
| `!dndbot add <name> <response>` | Create `!<name>` *(mod)* |
| `!dndbot edit <name> <response>` | Change an existing custom command *(mod)* |
| `!dndbot remove <name>` | Delete a custom command *(mod)* |
| `!dndbot cooldown <name> <seconds>` | Per-command cooldown, 0-3600s; default 5s *(mod)* |
| `!dndbot list` | List configured custom command names |
| `!trigger add <keyword> <response>` | Fire `<response>` whenever `<keyword>` appears in chat, no `!` needed *(mod)* — quote multi-word keywords |
| `!trigger remove <keyword>` | Delete a trigger *(mod)* |
| `!trigger cooldown <keyword> <seconds>` | Per-trigger cooldown, 0-3600s; default 15s *(mod)* |
| `!trigger list` | List configured trigger keywords |

#### Response placeholders
Drop any of these into a `!dndbot add`/`edit` or `!trigger add` response and they're filled in when it fires:

| Placeholder | Expands to |
|---|---|
| `{user}` | Display name of whoever triggered it |
| `{target}` | First `@mention` in a `!command`'s arguments (falls back to `{user}` for triggers, which have no arguments) |
| `{count}` | How many times this command/trigger has now fired |
| `{args}` | Everything typed after the command name (a `!command`'s own arguments) or, for a `!trigger`, the whole chat message that set it off — empty string if there's nothing to capture |
| `{random:a\|b\|c}` | Picks one option at random (max 5 per response) |
| `{randnum:MIN-MAX}` | A random whole number in that inclusive range, e.g. `{randnum:1-100}` (max 5 per response; `MIN`/`MAX` can be negative, e.g. `{randnum:-5-5}`) |
| `{d4}` `{d6}` `{d8}` `{d10}` `{d12}` `{d20}` `{d100}` | Shorthand for a single roll of that standard die, e.g. `{d20}` → 1-20 (max 10 per response combined) |
| `{channel}` | This channel's display name (falls back to "the channel" if it can't be looked up) |
| `{time}` | Current time, HH:MM Central Time (CST/CDT, DST-aware) |
| `{date}` | Current date, YYYY-MM-DD (Central Time) |
| `{sender}` | Same as `{user}` |
| `{touser}` | First word of the command's arguments with any leading `@` stripped, or `{user}` if there wasn't one |
| `{game}` | The channel's current game/category (falls back to "no game set") |
| `{title}` / `{status}` | The channel's current stream title (falls back to "no title set") |
| `{uptime}` | How long the channel has been live, e.g. "2h 15m" (falls back to "offline") |
| `{repeat:N\|text}` | Repeats `text` N times, space-separated, e.g. `{repeat:3\|Ho}` (N capped 1-20) |
| `{math:expression}` | Evaluates simple arithmetic, e.g. `{math:(3+4)*2}` — only digits, `+ - * / ( ) .` and spaces are allowed (max 5 per response) |
| `{twitchemotes}` | This channel's active Twitch subscriber emotes (up to 15, space-separated) |
| `{7tvemotes}` | This channel's active 7TV emotes (up to 15) |
| `{bttvemotes}` | This channel's active BetterTTV emotes (up to 15) |
| `{ffzemotes}` | This channel's active FrankerFaceZ emotes (up to 15) |

Example: `!dndbot add loot You dig through the rubble and find {randnum:1-50} gold, {user}! {random:Lucky|Not bad|Could be worse}.` Example: `!dndbot add attack {user} swings for {d8} damage!` Example: `!dndbot add live {channel} is playing {game} — "{title}" — live for {uptime}!` Custom command/trigger names can't reuse a built-in command word, and each channel has a configurable cap on how many of each it can store.

Not supported (would need new setup this bot doesn't have): changing the stream's game/title from chat or redeeming channel-point rewards (both need a broadcaster OAuth scope no connected channel has granted yet), a saved-quote system, named counters separate from a command's own use count (`{count}` already covers that), `$(if)`-style conditionals, and anything needing a paid third-party API key (stock prices, weather) that isn't configured in this project. AI chat replies **are** supported — see [NPC characters](#npc-characters) below, a separate system from custom commands.

### NPC characters
AI-voiced characters with an author-defined personality, powered by an LLM call per message (Val Town's built-in `std/openai` — no API key setup required). **Off by default per channel**, same pattern as the merchant and chronicle. Each Twitch channel gets its own roster; a shared **global** roster (managed only from the channel set as `PRIMARY_BROADCASTER_ID`) acts as a fallback for anyone who hasn't defined a same-named NPC locally. Conversation memory is kept per channel/character so an NPC remembers the last several exchanges.

| Command | Description |
|---------|-------------|
| `!npc on` / `off` | Enable or disable NPCs in this channel. **Off by default** *(mod)* |
| `!npc status` | Check whether NPCs are currently enabled in this channel (open to everyone) |
| `!npc chatter on` / `off` | Let a random NPC chime into plain chat unprompted. **Off by default**, also requires `!npc on` *(mod)* |
| `!npc chatter status` | Check whether random chatter is currently enabled (open to everyone) |
| `!npc list` | List NPCs available in this channel (own roster + global fallback) |
| `!npc add <name> <personality>` | Create a channel-scoped NPC *(mod)* |
| `!npc edit <name> <personality>` | Change an existing NPC's personality *(mod)* |
| `!npc remove <name>` | Delete a channel-scoped NPC *(mod)* |
| `!npc talk <name> <message>` | Talk to an NPC — it replies in character |
| `!npc global add/edit/remove ...` | Same, but manages the shared global roster *(PRIMARY_BROADCASTER_ID's channel only)* |

Turning NPCs off with `!npc off` doesn't delete the roster or any character's conversation memory — it just makes the whole `!npc` command (except `on`/`off`/`status`) unreachable until turned back on. `generateNpcReply()` in `npcs.ts` is written platform-agnostic (the roster's `ownerKey` isn't assumed to be a Twitch id) so another chat surface could reuse it later without changes here — none is wired up today.

**Random chatter** (`!npc chatter on`) mirrors the chronicle's random quote-back almost exactly: a low-odds roll against every qualifying plain chat message (min length, no links, at least two words), gated by a per-channel cooldown and a minimum-activity threshold since the last chime-in — so it's an occasional flourish, not a running commentary. On a hit, a random NPC from the channel's own roster (not the global fallback) replies to the message in character, using the same conversation memory as `!npc talk`. It needs both `!npc on` and `!npc chatter on`, and at least one NPC in `!npc list`, to ever fire.

Per-channel NPC state (on/off, chatter on/off, roster size, total uses) is visible to the operator on the [admin logs page](#operator-side-launch-requirements) at `/admin/logs`, next to the merchant's own overview table.

### Battle maps
| Command | Description |
|---------|-------------|
| `!map create <name> [WxH] [template]` | Create a grid map, default 10x8 up to 20x20, optionally stamped with a preset layout *(mod)* |
| `!map templates` | List available layout templates (tavern, dungeon, forest_clearing, graveyard, cave, arena) with their default size and description |
| `!map list` | List maps in this channel |
| `!map view <name>` | Post a link to the live, auto-refreshing map page |
| `!map delete <name>` / `!map remove <name>` | Delete a map, its terrain, and all its tokens *(mod)* |
| `!map terrains` | List terrain types (some block tokens: water, wall, mountain, lava, void) |
| `!map fill <name> <terrain>` | Reset the whole grid to one terrain *(mod)* |
| `!map paint <name> <x> <y> <terrain>` | Set a single cell's terrain, e.g. `!map paint dungeon1 4 2 wall` *(mod)* |
| `!map addchar <name> [x y]` | Place your saved character on the map |
| `!map addchar <name> @user [x y]` | Place someone else's character *(mod)* |
| `!map move <name> <x> <y>` | Move your token |
| `!map move <name> @user <x> <y>` | Move someone else's token *(mod)* |
| `!map removechar <name> [@user]` | Remove a character from the map (`@user` requires mod) |

Coordinates are 1-indexed from the top-left, `(1,1)`. Creating a map, editing terrain, and moving *someone else's* token require broadcaster/mod status — same trust model as parties and duels. Placing and moving your own character is open to everyone with a saved character. The map view (`!map view <name>`) is a read-only web page; there's no public write endpoint, so editing always goes through chat.

### Stewards (settings)
| Command | Description |
|---------|-------------|
| `!dndbot on` / `off` / `status` | Open or close the guild hall in this channel *(mod)* |
| `!dndbot leave` | Broadcaster-only: cancel EventSub and disconnect this channel |
| `!dndbot leave purge` | Broadcaster-only: disconnect and purge this channel's stored characters/parties/logs/gameplay state |
| `!market on` / `off` | Enable or disable the open-stall merchant's periodic ads. **Off by default** *(mod)* |
| `!market status` | Check whether the merchant is currently active in this channel (open to everyone) |
| `!adcheck` | Report Twitch's real ad-schedule status — next ad, duration, snoozes left, time since the last ad, with a ⚠️ reminder once it's overdue *(mod)* |
| `!adslogged` | Manually mark an ad break just run — fallback for channels that haven't (re)granted `channel:read:ads` yet *(mod)* |
| `!chronicle on` / `off` | Enable or disable the chronicle's random chat-quoting. **Off by default** *(mod)* |
| `!chronicle status` | Check whether the chronicle is currently active in this channel (open to everyone) |
| `!npc on` / `off` | Enable or disable AI-voiced NPC characters in this channel. **Off by default** *(mod)* |
| `!npc status` | Check whether NPCs are currently enabled in this channel (open to everyone) |
| `!npc chatter on` / `off` | Let a random NPC chime into plain chat unprompted. **Off by default** *(mod)* |
| `!npc chatter status` | Check whether random NPC chatter is currently enabled (open to everyone) |

### Passive chat (no command needed)
| Trigger | Description |
|---------|-------------|
| "goodnight" / "gn" / "gnite" / "nighty night" / etc. | Bot replies with a themed send-off. One reply per channel per cooldown window (`GOODNIGHT_COOLDOWN_MS`, default 5 min) so a wave of goodnights from chat only draws a single response. |
| Any plain chat message (when `!chronicle on`) | Small random chance (`CHRONICLE_QUOTE_CHANCE_PERCENT`, default 3%) per qualifying message of being quoted back with a D&D-flavored reply. Skips very short messages, single-word/emote spam, and links. Gated by a per-channel cooldown (`CHRONICLE_COOLDOWN_MS`, default 10 min) and a minimum-activity threshold (`CHRONICLE_MIN_MESSAGES`, default 15 messages since the last quote) so it can't fire back-to-back or in a dead-quiet channel. Bot accounts (Nightbot, StreamElements, GuildScribe itself, etc.) count toward that message minimum but are never selected as the one quoted. |
| Any plain chat message (when `!npc on` AND `!npc chatter on`) | Same shape as the chronicle roll above (`NPC_CHATTER_CHANCE_PERCENT` default 4%, `NPC_CHATTER_COOLDOWN_MS` default 15 min, `NPC_CHATTER_MIN_MESSAGES` default 20), but instead of quoting the message back, a random NPC from the channel's own roster replies to it in character — using the same conversation memory `!npc talk` does. Needs at least one NPC in `!npc list` to ever fire. |

---

## How the pieces link

```
Chat !guide / !link  ──►  PUBLIC_BASE_URL/guide  (Guild Codex web page)
Chat !dndbothelp     ──►  Same chapters as Codex + this README
Home page            ──►  OAuth connect + link to Codex + Support the Guild
!logs (chat only)    ──►  Activity scrolls, scoped to that channel, mods/broadcaster only
!party list          ──►  Rosters used by !dndduel party / party hunt
!createchar / !char  ──►  Required for duels, hunts, party invite targets
Monster wins         ──►  XP on parchment (!char shows Lv + XP)
!map create/paint    ──►  Grid + terrain, edited by mods only
!map addchar / move  ──►  Character tokens, placed/moved by their owner (mod for others)
!map view <name>     ──►  Live read-only web page at PUBLIC_BASE_URL/map
```

---

## HTTP routes

| Path | Purpose |
|------|---------|
| `GET /` | Guild hall — info page, links to `/connect` |
| `GET /connect` | Starts Twitch OAuth — generates state, redirects straight to Twitch's authorize page (no intermediate GuildScribe page) |
| `GET /callback` | Twitch OAuth return |
| `GET /dashboard` | Guild Dashboard — mod/broadcaster-only module on/off switches; redirects to Twitch sign-in if not already logged in |
| `GET /dashboard/callback` | Twitch OAuth return for the dashboard's viewer login (separate from `/callback` above) |
| `GET /dashboard/logout` | Clears the dashboard session cookie |
| `POST /dashboard/toggle` | Flips one module for one channel; requires a valid dashboard session and re-verified mod/broadcaster status |
| `GET /guide` · `/commands` | **Guild Codex** |
| `GET /donate` | Support the Guild |
| `GET /privacy` | Privacy policy |
| `GET /terms` · `/tos` | Short Terms of Service |
| `GET /healthz` | Health check for uptime monitors |
| `GET /admin/merchant/status` | Operator-only JSON: merchant cron health (last run, posts ok/failed, recent merchant-related events) |
| `GET /admin/logs` | Operator-only, browser-viewable page: merchant cron status, per-channel merchant overview, recent monitor events |
| `POST /admin/channels/<id>/disable` | Operator-only channel block |
| `POST /admin/channels/<id>/enable` | Operator-only unblock |
| `GET /?channel=<broadcaster_id>&user=<username>` | Channel-scoped character sheet |
| `GET /maps?channel=<broadcaster_id>` | List a channel's battle maps |
| `GET /map?channel=<broadcaster_id>&map=<name>` | Live, auto-refreshing visual battle map (terrain grid + character tokens); read-only — editing happens via chat |
| `POST /` | EventSub (chat + webhooks) |

---

## XP & monsters

- Start: level 1, 0 XP  
- Monster CR → XP; thresholds can auto-level  
- Monsters chosen by **level** (and party size on hunts), with win-friendly balance — or targeted by name on a party hunt (`!dndduel party hunt <party> <monster>`), still scaled to the party's level the same way  
- Large solo roster across CR bands  

---

## Pre-launch checklist

### Code-side security

- [x] OAuth state validation with 10-minute expiry and one-time consumption
- [x] EventSub HMAC signature validation
- [x] EventSub timestamp/replay protection
- [x] Channel-scoped characters, backups, and creation sessions
- [x] Channel-scoped activity-log retention (90 days / 5,000 rows)
- [x] Broadcaster-only disconnect and purge
- [x] EventSub cancellation retry queue
- [x] Twitch-side revocation marks the broadcaster disconnected
- [x] Operator blocklist with secret bearer authentication (32+ character secret required)
- [x] SQL parameterization and HTML escaping for user-controlled values
- [x] Durable per-channel/user command cooldown
- [x] Global outbound chat queue for shared bot-account rate-limit protection
- [x] Production error responses avoid returning raw exception details
- [x] Chat command text is not written to application logs
- [x] `/healthz` is cache-disabled and suitable for external monitoring
- [x] Operator admin routes (`/admin/merchant/status`, `/admin/logs`, `/admin/channels/...`) require a 32+ character `ADMIN_API_SECRET` bearer token (or `?key=` for the browser-viewable logs page)

### Operator-side launch requirements

- [ ] Set production secrets/environment variables
- [ ] Configure an external uptime monitor/alert destination
- [ ] Set a real support URL
- [ ] Set the exact public URL and Twitch OAuth redirect (`/callback`)
- [ ] Complete Twitch's current bot verification/rate-limit process
- [ ] Test `!dndbot leave` and `!dndbot leave purge` on a disposable channel
- [ ] Test Twitch-side EventSub revocation
- [ ] Test the operator disable/enable endpoints
- [ ] Test two channels with the same viewer username and confirm characters/wizards remain isolated
- [ ] Notify already-connected channels to reconnect so `channel:read:subscriptions` is granted and sub/resub thank-yous start firing (existing chat functionality is unaffected either way)

---

## License / content

Mechanics and lookups use the **D&D 5e SRD** via public APIs and free reference sites.  
GuildScribe is a fan-made Twitch utility and is **not** affiliated with Wizards of the Coast or Twitch.


## Launch / operations checklist

- **Disconnect:** `!dndbot leave` is broadcaster-only, deletes the broadcaster connection record, and attempts to cancel its EventSub subscription. `!dndbot leave purge` additionally removes channel parties, logs, encounters, duel state, channel character associations, and characters/backups that are no longer associated with another channel.
- **EventSub revocation:** Twitch revocations now mark the broadcaster disconnected, so `!connections` only reports live connections.
- **Privacy/ToS:** `/privacy` and `/terms` are public and linked from the Codex. Activity logs are pruned per channel to 5,000 rows and 90 days.
- **Operator override:** keep `ADMIN_API_SECRET` private. Use `POST /admin/channels/<broadcaster_id>/disable` with `Authorization: Bearer <secret>` to block one channel without relying on Twitch roles. `GET /admin/merchant/status` and `GET /admin/logs` (same secret) give visibility into the merchant cron's health without digging through Val Town's run history.
- **Per-channel caps:** set `MAX_PARTIES_PER_CHANNEL`, `MAX_CHARACTERS_PER_CHANNEL`, and `MAX_MAPS_PER_CHANNEL` as needed.
- **Monitoring:** point an external uptime monitor at `/healthz`; application errors/revocations are also retained in a small internal `monitor_events` table, and merchant cron ticks are tracked in `merchant_cron_status`.
- **Support:** set `SUPPORT_URL` to the project's real support channel/email/form before launch.
- **Twitch bot verification:** verification is a Twitch-side application process and cannot be completed from the code. Before multi-channel launch, apply in the Twitch Developer Console using the current Twitch developer requirements/rate limits. The codebase is now structured so the shared bot can be operated/limited safely while that process is pending.

### Data ownership and security note

Character records, backups, and creation sessions are now **tenant-scoped by `(broadcaster_id, username)`**. A viewer can have a separate character in every channel and cannot retrieve or modify another channel's character by changing a username. Existing legacy character tables are migrated into the channel-scoped schema using the historical `channel_characters` associations; unassociated legacy records are not exposed.

EventSub webhook signatures are checked with HMAC, timestamps older than 10 minutes are rejected, and Twitch message IDs are de-duplicated for 24 hours to prevent replay processing. Chat commands use a durable SQLite per-channel/user cooldown, while outgoing chat sends use a global bot-account queue to reduce shared-account throttling risk.

If an EventSub cancellation fails during `!dndbot leave`, the subscription ID is retained in a minimal pending-cancellation queue and retried by `/healthz`; the broadcaster row and channel data can still be removed immediately.

The public character sheet is channel-scoped and requires a currently connected broadcaster: `/?channel=<broadcaster_id>&user=<username>` (without the space). This prevents the old global `?user=` route from crossing tenants.

### Pre-public operational items

- Set `ADMIN_API_SECRET` to a random value of at least 32 characters.
- Set `SUPPORT_URL` to a real support destination.
- Set `PUBLIC_BASE_URL` to the exact public HTTPS URL.
- Configure an external uptime monitor against `/healthz`; the endpoint also retries transient EventSub cancellations.
- Review the current Twitch developer/bot verification requirements and complete Twitch's verification process separately. Code cannot grant Twitch verification.
- Keep the conservative `CHAT_GLOBAL_MIN_INTERVAL_MS=1600` until Twitch confirms the account's applicable chat rate limit; lower it only with that confirmation.

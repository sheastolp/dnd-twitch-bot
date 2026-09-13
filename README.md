# GuildScribe — Guild Hall for Twitch D&D

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
| **Fate's dice** | `!d20`, `!roll`, roll for another adventurer, `!rollcall` natural 1/20 leaderboard, `!oracle` names a random chatter, `!bg3roll`/`!bg3companion`/`!bg3origin`/`!bg3loot`/`!bg3camp` for Baldur's Gate 3 flavor |
| **Arena & wilds** | Auto/classic PvP, solo monsters, party duels, **party hunts** |
| **Maps** | Grid battle maps with paintable terrain (grass, water, wall, lava, and more), ready-made layout templates (tavern, dungeon, forest clearing, graveyard, cave, arena), a live visual web view, and character tokens that adventurers place and move themselves |
| **XP** | From **monster** victories only (not PvP) |
| **Subs** | D&D-themed auto thank-you in chat for new subs, renewals, and gift subs — including a welcome for the recipient and (unless anonymous) a shout-out to the gifter (requires `channel:read:subscriptions`) |
| **Raids** | D&D-themed auto thank-you in chat when another channel raids in, naming the raiding channel and party size — no extra OAuth scope needed |
| **Stewards** | Channel on/off, disconnect/purge, in-chat activity logs, OAuth connect |
| **Custom commands** | Broadcasters/mods add their own `!commands` and passive keyword triggers from chat, no code required |
| **Timed messages** | Broadcasters/mods schedule recurring announcements (`!timedmsg`) that post automatically on their own rotating interval |
| **Web dashboard** | `!dashboard` hands out a private link for managing custom commands, triggers, and timed messages from a browser instead of chat syntax |
| **Passive chat** | Detects plain-chat "goodnight" messages and sends the room off with a themed reply |
| **Market** | An open-stall merchant periodically posts a one-line D&D-flavored sales pitch in chat. **Off by default**, toggled per channel with `!market on`/`off`/`status` *(mod)*; flavor only, no coin or inventory state |

---

## Module map

| File | Role |
|------|------|
| **main.ts** | HTTP entry, OAuth, EventSub, **command router** — Val Town HTTP trigger |
| **merchant.ts** | `!market on/off/status` toggle + open-stall merchant ad flavor generator (no DB writes beyond the toggle) |
| **merchant_cron.ts** | Posts a merchant ad to every channel that's due — Val Town **cron trigger** |
| **ads.ts** / **ads_db.ts** | `!adcheck` / `!adslogged` — real Twitch commercial-break tracking via the broadcaster's own ad-schedule token (distinct from merchant.ts's flavor-only "ads") |
| **oracle.ts** | `!oracle <question>` — names a random recent chatter as the "answer" |
| **chronicle.ts** | `!chronicle on/off/status` — occasionally quotes a plain chat message back with a D&D-flavored reply |
| **npcs.ts** | `!npc ...` — AI-voiced NPC characters, channel-scoped or global, plus optional passive chatter |
| **types.ts** | Shared types |
| **data.ts** | Races, classes, level-scaled monsters, lookup map |
| **utils.ts** | Dice, formatting, narration |
| **db.ts** | SQLite schema + persistence |
| **characters.ts** | Generation, XP, leveling, `!newchar` wizard |
| **bg3.ts** | `!bg3roll`, `!bg3companion`, `!bg3origin`, `!bg3loot`, `!bg3camp` — standalone Baldur's Gate 3 flavor generators (no DB); `!bg3` — random race/class + player-chosen BG3 point-buy scores, saved via db.ts |
| **bg3data.ts** | Static Baldur's Gate 3 knowledgebase — companions, origins, classes, races, locations, factions, deities, villains, legendary items |
| **bg3lookup.ts** | `!bg3lookup` — search + formatting over the `bg3data.ts` knowledgebase (no DB, no external API — it's hand-curated, unlike `lookups.ts`) |
| **combat.ts** | Duels, parties, hunts, initiative |
| **customcommands.ts** | `!dndbot add/edit/remove/cooldown/list` custom commands and `!trigger` passive keyword auto-responses |
| **timedmessages.ts** | `!timedmsg add/edit/interval/enable/disable/remove/list` recurring announcements |
| **timedmessages_cron.ts** | Posts every timed message that's due — Val Town **cron trigger**, same shape as `merchant_cron.ts` |
| **dashboard.ts** | `!dashboard [reset]` — mints/rotates the per-channel web dashboard link, and the GET/POST `/dashboard` route handlers |
| **maps.ts** | `!map` — create/list/view/delete grid battle maps, paint/fill terrain, and place/move/remove character tokens |
| **lookups.ts** | dnd5eapi + formatting + reference links |
| **twitch.ts** | Tokens, multi-part chat send |
| **pages.ts** | Guild Codex HTML, logs, character sheet UI, battle map view/list pages, operator admin logs page, web dashboard page |
| **README.md** | This document |

---

## Setup (Val Town)

1. Upload all modules into one Val project.
2. Point the **HTTP trigger** at **`main.ts`**.
2a. Point a **cron trigger** at **`merchant_cron.ts`** (every 5-10 minutes is plenty — the merchant's own per-channel posting cadence is randomized independently, see `MERCHANT_MIN_INTERVAL_MINUTES`/`MERCHANT_MAX_INTERVAL_MINUTES` below). The market is off by default in every channel regardless of whether this trigger is set up; without it, `!market on` will simply never produce a post.
2b. Point a **cron trigger** at **`timedmessages_cron.ts`** (every 5-10 minutes is plenty — each timed message schedules its own next-post time independently, see `!timedmsg add`). Without this trigger, `!timedmsg add` will store messages but they'll never post.
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
| `MAX_TIMED_MESSAGES_PER_CHANNEL` | *(optional)* Timed message cap per channel; default 20 |
| `TIMED_MESSAGE_MIN_INTERVAL_MINUTES` | *(optional)* Shortest allowed interval for a timed message; default 10 |
| `TIMED_MESSAGE_MAX_INTERVAL_MINUTES` | *(optional)* Longest allowed interval for a timed message; default 10080 (1 week), floored at the min above |
| `ADMIN_API_SECRET` | **Required for operator override**; secret bearer token for `/admin/channels/<broadcaster_id>/(disable|enable)`, `/admin/merchant/status`, and `/admin/logs` |
| `SUPPORT_URL` | *(recommended)* Support/contact URL shown in the privacy policy and home page |
| `PUBLIC_BASE_URL` | *(recommended)* Public HTTPS URL used in chat links; must match the deployed Val URL |
| `COMMAND_COOLDOWN_MS` | *(optional)* Durable per-channel/user command cooldown; default 1200ms |
| `GOODNIGHT_COOLDOWN_MS` | *(optional)* Durable per-channel cooldown between "goodnight" auto-replies; default 300000ms (5 min), floor 30000ms |
| `CHAT_GLOBAL_MIN_INTERVAL_MS` | *(optional)* Global bot-account chat-send spacing; default 1600ms. Lower only after Twitch confirms the account's applicable limit/verification. |
| `MERCHANT_MIN_INTERVAL_MINUTES` | *(optional)* Shortest gap between open-stall merchant ads in a channel with `!market on`; default 25, floor 5 |
| `MERCHANT_MAX_INTERVAL_MINUTES` | *(optional)* Longest gap between open-stall merchant ads; default 60, floored at the min above |
| `AD_REMINDER_MINUTES` | *(optional)* How often `!adcheck` re-flags a stale/missing ad break; default 20 |
| `CHRONICLE_QUOTE_CHANCE_PERCENT` | *(optional)* Odds any single qualifying chat message gets chronicled; default 3 |
| `CHRONICLE_COOLDOWN_MS` | *(optional)* Minimum gap between chronicle quotes in a channel; default 600000ms (10 min), floor 30000ms |
| `CHRONICLE_MIN_MESSAGES` | *(optional)* Chat messages required since the last quote before another can fire; default 15 |
| `MAX_NPCS_PER_OWNER` | *(optional)* NPC roster cap per channel (or the global roster); default 25 |
| `NPC_MODEL` | *(optional)* LLM model used for `!npc talk` replies; default gpt-4o-mini |
| `NPC_CHATTER_CHANCE_PERCENT` | *(optional)* Odds any single qualifying chat message triggers unprompted NPC chatter |
| `NPC_CHATTER_COOLDOWN_MS` | *(optional)* Minimum gap between unprompted NPC chatter in a channel |
| `NPC_CHATTER_MIN_MESSAGES` | *(optional)* Chat messages required since the last NPC chime-in before another can fire |
| `PRIMARY_BROADCASTER_ID` | *(optional)* Broadcaster id allowed to manage the shared "global" NPC roster with `!npc global add/edit/remove` |
| `DUEL_ACCEPT_TIMEOUT_MS` | *(optional)* How long a `!dndduel` challenge stays open before expiring; default 300000ms (5 min), floor 30000ms |
| `DUEL_IDLE_TIMEOUT_MS` | *(optional)* How long an active duel can sit idle before it's considered abandoned; default 600000ms (10 min) |

4. Twitch Developer Console → add **both** OAuth Redirect URLs exactly:  
   `https://<your-val>.web.val.run/callback` (broadcaster connect flow) and  
   `https://<your-val>.web.val.run/dashboard/callback` (viewer "log in with Twitch" check for the web dashboard — see below; the dashboard's login step will fail with a Twitch redirect_uri mismatch error until this second one is added)
5. Set `PUBLIC_BASE_URL` as an environment variable to your public HTTPS URL (used by `!guide` / `!link`). This deployment defaults to `https://guildscribe.val.run` when the env var isn't set.
6. Open the Val URL → **Raise the Guild Banner** → authorize.
7. In channel chat: `/mod YourBotName`

The OAuth flow requests `channel:bot channel:read:subscriptions channel:read:ads` — `channel:read:subscriptions` powers the sub/resub thank-you (see below), and `channel:read:ads` powers `!adcheck`'s real Twitch ad-schedule lookup (falls back to the manually-logged `!adslogged` timestamp without it). **Channels that connected before these scopes were added need to reconnect** (the home page and guide both have a "reconnect" link — both point at `/connect`, same as the initial connect button) for new-sub/resub thank-yous and real ad-schedule checks to start working; the rest of the bot is unaffected either way. `/connect` → `/callback` is idempotent: reconnecting an already-connected channel cleans up its old EventSub subscriptions first, so it's safe to run any time GuildScribe gains a feature that needs a new permission, without duplicating subscriptions or losing existing character/party data.

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

### Arena & wilds (combat)
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
| `!dndduel party hunt <party>` | Auto **company vs monster** |
| `!dndduel party hunt classic <party>` | Classic hunt |
| `!dndduel party hunt attack` / `status` / `end` | Hunt turns |
| `!turn start` … `!turn end` | Initiative tracker *(start/add/show/next/prev/remove/end are mod-only; `!turn roll` is open to any player, rolls 1d20+DEX)* |

**XP** is granted only when a **monster** falls (solo or party hunt). PvP awards none.

**Timeouts:** a pending challenge (`accept`/`decline`) expires after 5 minutes if unanswered. Any active classic (turn-based) duel — 1v1, party vs. party, or a party hunt — auto-forfeits to the non-idle side if nobody acts for 10 minutes, so an abandoned duel can't block that channel's dueling into the next stream. Both windows are checked lazily the next time anyone runs a `!dndduel` command in that channel (no idle duel needs to be manually ended first).

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

Custom command/trigger names can't reuse a built-in command word, and each channel has a configurable cap on how many of each it can store.

#### Response placeholders

| Placeholder | Meaning |
|---|---|
| `{user}` / `{sender}` | Display name of whoever triggered it |
| `{target}` | First `@mention` in a command's arguments (commands only; falls back to `{user}`) |
| `{touser}` | First word of the arguments, `@` stripped (falls back to `{user}`) |
| `{args}` | Everything after the command, or the whole message for a trigger |
| `{count}` | How many times this command/trigger has now fired |
| `{random:a\|b\|c}` | Picks one option at random (max 5 per response) |
| `{randnum:MIN-MAX}` | Random integer in range, negatives allowed, e.g. `{randnum:-5-10}` |
| `{d4}` `{d6}` `{d8}` `{d10}` `{d12}` `{d20}` `{d100}` | Shorthand die-roll expansions |
| `{repeat:N\|text}` | Repeats `text` back-to-back `N` times (capped at 10) |
| `{math:expr}` | Evaluates a numeric expression — digits, `+ - * / % ( ) .` only, e.g. `{math:(3+4)*2}` |
| `{channel}` | Broadcaster's display name |
| `{time}` / `{date}` | Current UTC time (`HH:MM`) / date (`YYYY-MM-DD`) |
| `{game}` `{title}` `{status}` `{uptime}` | Live channel info via Twitch Helix (existing app token, no new scope); `{status}` is `live`/`offline`, `{uptime}` is `offline` when not live |
| `{twitchemotes}` `{7tvemotes}` `{bttvemotes}` `{ffzemotes}` | A random emote from that provider's set for this channel (public, unauthenticated APIs) |

Every placeholder that needs a network or DB call is only resolved when it actually appears in the response text.

### Timed messages
Recurring announcements, posted automatically by a separate cron trigger (`timedmessages_cron.ts`) rather than in response to anything in chat. Each message keeps its own schedule, so several messages with different intervals in the same channel rotate independently instead of firing together.

| Command | Description |
|---------|-------------|
| `!timedmsg add <minutes> <message>` | Schedule a new recurring message *(mod)* |
| `!timedmsg edit <id> <message>` | Change an existing message's text *(mod)* |
| `!timedmsg interval <id> <minutes>` | Change how often it posts *(mod)* |
| `!timedmsg enable <id>` / `disable <id>` | Resume or pause without deleting *(mod)* |
| `!timedmsg remove <id>` | Delete a timed message *(mod)* |
| `!timedmsg list` | List configured timed messages, their id, interval, and on/off state |

Responses support `{count}` (times posted so far) and `{random:a|b|c}`. Interval is minutes, bounded by `TIMED_MESSAGE_MIN_INTERVAL_MINUTES`/`TIMED_MESSAGE_MAX_INTERVAL_MINUTES` (default 10-10080); actual precision is capped by how often the `timedmessages_cron.ts` trigger itself ticks (Val Town's cron minimum is 15 minutes), same slop already accepted for the open-stall merchant.

### Web dashboard
| Command | Description |
|---------|-------------|
| `!dashboard` | Post a private link to this channel's web dashboard *(mod)* |
| `!dashboard reset` | Invalidate the old link (if it leaked) and issue a new one *(mod)* |

The dashboard (`GET /dashboard?channel=<id>&key=<dashboard_key>`) is a plain-HTML page for adding, editing, and deleting custom commands, chat triggers, and timed messages with forms instead of chat syntax. Two independent layers gate access to it:

1. **The link itself.** The `key` is a per-channel capability token (see `db.ts`'s `dashboard_key` column) — it's only ever handed out via the mod-gated `!dashboard` command, never posted automatically or shown to everyone.
2. **A live Twitch login.** Opening the link (even with a valid key) first shows a "Log in with Twitch" gate. Logging in checks — at that moment, via Twitch's Get Moderated Channels API — whether the logged-in account is actually a moderator or the broadcaster of *that* channel. Only then does a signed, channel-scoped session cookie (12-hour expiry) unlock the actual management UI. This means a screenshotted or leaked link is useless to anyone who isn't currently a mod of that channel on Twitch, even though it still requires the OAuth redirect URI in step 4 above.

The login step requests the `user:read:moderated_channels` scope from the *viewer*, separate from the broadcaster's own `channel:bot channel:read:subscriptions` connect-flow scopes.

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

### Passive chat (no command needed)
| Trigger | Description |
|---------|-------------|
| "goodnight" / "gn" / "gnite" / "nighty night" / etc. | Bot replies with a themed send-off. One reply per channel per cooldown window (`GOODNIGHT_COOLDOWN_MS`, default 5 min) so a wave of goodnights from chat only draws a single response. |

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
| `GET /guide` · `/commands` | **Guild Codex** |
| `GET /donate` | Support the Guild |
| `GET /privacy` | Privacy policy |
| `GET /terms` · `/tos` | Short Terms of Service |
| `GET /healthz` | Health check for uptime monitors |
| `GET /admin/merchant/status` | Operator-only JSON: merchant cron health (last run, posts ok/failed, recent merchant-related events) |
| `GET /admin/logs` | Operator-only, browser-viewable page: merchant cron status, per-channel merchant overview, recent monitor events |
| `GET /dashboard` | Per-channel web dashboard for custom commands/triggers/timed messages — requires `?channel=<id>&key=<dashboard_key>`, handed out in chat via `!dashboard` (not an operator route, no `ADMIN_API_SECRET`) |
| `GET /dashboard/login` | Starts the dashboard's viewer-side Twitch login (moderator check) |
| `GET /dashboard/callback` | Twitch OAuth return for the dashboard login — verifies mod status, sets the session cookie |
| `POST /dashboard/commands` · `/dashboard/triggers` · `/dashboard/timedmessages` | Dashboard form submissions (add/save/delete) — same `channel`+`key`+session-cookie auth as the GET route above, redirects back to the dashboard with a flash notice |
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
- Monsters chosen by **level** (and party size on hunts), with win-friendly balance  
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

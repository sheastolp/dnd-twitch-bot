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
| **Arena & wilds** | Auto/classic PvP, solo monsters, party duels, **party hunts**, and `!rob @user` robbery duels that move coin |
| **Maps** | Grid battle maps with paintable terrain (grass, water, wall, lava, and more), ready-made layout templates (tavern, dungeon, forest clearing, graveyard, cave, arena), a live visual web view, and character tokens that adventurers place and move themselves |
| **XP & loot** | From **monster** victories only (not PvP): XP, plus a small coin drop scaled to the monster's CR while coin is on |
| **Subs** | D&D-themed auto thank-you in chat for new subs, renewals, and gift subs — including a welcome for the recipient and (unless anonymous) a shout-out to the gifter (requires `channel:read:subscriptions`) |
| **Raids** | D&D-themed auto thank-you in chat when another channel raids in, naming the raiding channel and party size — no extra OAuth scope needed |
| **Stewards** | Channel on/off, disconnect/purge, in-chat activity logs, OAuth connect |
| **Custom commands** | Broadcasters/mods add their own `!commands` and passive keyword triggers from chat, no code required |
| **Timed messages** | Broadcasters/mods schedule recurring announcements (`!timedmsg`) that post automatically on their own rotating interval |
| **OBS overlays** | `!overlays` *(mod)* links a setup page of transparent, auto-updating Browser-source panels: status bar, raid boss HP, live battle tracker, giveaway, peddler's stall, swear jar, coin and roll-call leaderboards, guild summary — singly, stacked, or rotating — plus a **full stream theme**: one 1920×1080 source with a torn-parchment frame around a see-through game window, the channel title, fading "Tavern Talk" chat, a d20 badge and the status strip |
| **Web dashboard** | `!dashboard` hands out a private link for managing custom commands, triggers, and timed messages from a browser instead of chat syntax |
| **Passive chat** | Detects plain-chat "goodnight" messages and sends the room off with a themed reply |
| **Coin & giveaways** | Viewers earn **copper** by chatting while the stream is live, shown as gold, silver and copper (10 cp = 1 sp, 10 sp = 1 gp). `!gold` balance + rank, `!gold top` / `!goldboard` leaderboard, `!gold give` gifting, mod-run `!giveaway` draws with optional paid, weighted tickets, and real coin prices for `!haggle`. **On by default**, toggled per channel with `!gold on/off` or the web dashboard |
| **Market** | An open-stall merchant periodically posts a one-line D&D-flavored sales pitch in chat. **Off by default**, toggled per channel with `!market on`/`off`/`status` *(mod)*; every ware carries a small stat bonus that goes onto the buyer's character sheet when bought with `!haggle` (see **gear.ts**); `!gear [@user]` lists a sheet's gear |
| **Haggle** | `!haggle <pitch>` bargains with whichever peddler is currently listed from the market — an AI-voiced, sassy, in-character verdict. Rides on the `!market` toggle, three attempts per viewer per listing. It's a real purchase in **coin**: the peddler's listed price, your offer, and the price he agrees to all count, and a deal is paid for on the spot. A refusal costs nothing. `!stall` (open to everyone, read-only) shows the item currently on offer, its price, and how many haggle attempts you have left on it. Free banter if a channel turns gold off |
| **Hunt and Hoard** | The Wandering Clerk's hunting-and-shopping game as a module (**off by default**, `!hoard on`). `!hunt` the channel's bestiary with your GuildScribe character on the same engine, XP, loot and cooldown as `!dndduel` — but HP carries between hunts (heal with `!rest`, potions or slow regen). A shared bounty board (`!bounties`), a merchant stall of potions and peddler gear (`!shop`/`!buy`), a potion pack (`!inv`/`!use`/`!sell`/`!drop`), `!purse`, `!ledger`, and a "Next:" hint on most replies |

---

## Module map

| File | Role |
|------|------|
| **main.ts** | HTTP entry, OAuth, EventSub, **command router** — Val Town HTTP trigger |
| **replypages.ts** | Detail pages for long replies: stores each viewer's latest full reply (`reply_links`, one fixed link per viewer per channel, content kept 24 hours) and serves `GET /r/<id>` |
| **whisper.ts** | Long replies by whisper: per-request "who ran this command" context (AsyncLocalStorage), the bot's own user token for Helix Send Whisper (`bot_user_tokens`), the `/connect-bot` OAuth routes, and the one-line chat summary |
| **web_routes.ts** | Every web route (health, static pages, OAuth connect/callback, character/map/roster pages, dashboard, `/admin/*`); `main.ts` calls it first and falls through to EventSub when nothing matched |
| **chat_builtin.ts** | Built-in chat commands without their own module (`!logs`, `!help`, lookups, dice, `!createchar`, `!char`, …), custom-command invocation, and plain-chat replies (goodnight, triggers, chronicle, NPC chatter) |
| **config.ts** | Shared runtime config (`PUBLIC_BASE_URL`) |
| **merchant.ts** | `!market on/off/status` toggle + open-stall merchant ad flavor generator (no DB writes beyond the toggle) |
| **merchant_cron.ts** | Posts a merchant ad to every channel that's due — Val Town **cron trigger** — and records the current listing for `!haggle` |
| **gear.ts** | The peddler's wares and the permanent bonus each grants (ability score, max HP, speed); `applyGear` writes a bought item onto the character sheet, `gearHpBonus` keeps gear HP through level changes |
| **haggle.ts** | `!haggle <pitch>` — AI-voiced sassy haggling over the merchant's current listing (see `merchant_listings` in db.ts); no API key setup needed, uses Val Town's built-in `std/openai`, same as npcs.ts |
| **ads.ts** / **ads_db.ts** | `!adcheck` / `!adslogged` — real Twitch commercial-break tracking via the broadcaster's own ad-schedule token (distinct from merchant.ts's flavor-only "ads") |
| **oracle.ts** | `!oracle <question>` — names a random recent chatter as the "answer" |
| **checklist.ts** | `!checklist [add <item> / remove <n> / clear / on / off / status]` — the streamer's start-of-stream checklist: on `stream.online` it whispers the broadcaster their own items plus a one-line summary of which GuildScribe features are on (falls back to one chat message if the bot can't whisper); mod/broadcaster only, reminder on by default |
| **autoban.ts** | `!autoban on/off/status` — permanently bans non-mod chatters whose message matches the channel's auto-ban phrase list (seeded with "ai viewers") and announces it; mod/broadcaster toggle (chat or dashboard "Bot & feature switches"), off by default; bans use the broadcaster's stored token (`moderator:manage:banned_users`) |
| **autoban_words.ts** | Per-channel auto-ban phrase list (`autoban_words`: default / added / learned, active / pending / off, ban counts), ignore list (`autoban_ignored`) and learning mode (`autoban_learn`: auto / suggest / off). Matching normalizes case, accents, invisible characters and spelled-out domains ("grow dot com"), then matches each phrase loosely as whole words — look-alikes (v1ewers, $ub$, Al for AI, Cyrillic/Greek/small-caps letters, vv/rn/ph/|<), stretched letters (viiiewers) and letters broken up by junk (v.i.e.w.e.r.s, aiviewers) — with a linear-time matcher so crafted messages can't stall it. Entries written as `/regex/` (flags i/m/s/u) are regular expressions, checked on save: must compile, mustn't match everyday chat, no nested repeats or back-references. Learning: domains in banned messages become active phrases at once; other messages that score as promo spam (domain + "viewers"/"followers"/"grow your stream"...) become pending suggestions, auto-activated once 2 different chatters send them (auto mode) or approved by a mod (suggest mode). Common real sites are never learned. All purged by `!dndbot leave purge` |
| **autoban_history.ts** | Auto-ban's ban history, used as a reference for new bans (`autoban_history`, `autoban_history_sync`). Every auto-ban is recorded with its message; the channel's Twitch ban list (Helix Get Banned Users, permanent bans only — names and reasons) is imported from `/dashboard/autoban` on demand and at most every 6 h when the page is opened. When no phrase matches, a message that repeats a banned one (after stripping @mentions, digits, punctuation and look-alikes: identical, contained, or ≥ 70% word overlap) or a numbered login with the same stem as a banned account plus a promo-looking message is banned in *auto* learning mode, queued for review in *suggest* mode, ignored when learning is *off*. Mods can forget references |
| **autoban_page.ts** | `/dashboard/autoban` (behind the dashboard key + mod login): view/add/edit/turn off/delete phrases, approve or reject learned spam, set the learning mode, add/remove ignored users, and review/import/forget the ban history |
| **hoard.ts** | Hunt and Hoard commands (`!hoard`, `!hunt`, `!rest`, `!ledger`, `!bounties`/`!quests`, `!shop`/`!merchant`, `!buy`, `!inv`, `!use`, `!sell`, `!drop`, `!purse`), ported from the standalone Hunt & Hoard bot onto GuildScribe's systems: characters (no separate `!enlist`), `summonMonster` (bestiary scaling + adaptation, and `recordMonsterOutcome`), `simulateMonsterFight` with a `startHp` so HP carries over (stored in the sheet's `hpCurrent`, never below 1), `claimHunt`, `awardMonsterXp`, `awardMonsterLoot`, the gold wallet, and `applyGear` for gear bought at the stall. Passive regen 3 HP / 15 min (caught up on the next command). `creditBounty` is also called by autohunt.ts for each bout won. Off by default (`!hoard on`, mod); while off — or when a per-card switch is off, or the channel has an enabled custom command of the same name — its words fall through untouched |
| **dashboard_links.ts** | Linked switches on the dashboard: gold-bordered *Needs …* links, tile notes, *Required by* links and folder notes drawn from `TOGGLE_REQUIRES` (commandgroups.ts) |
| **hoard_combat.ts** | Hunt and Hoard inside GuildScribe's combat: `woundsOn` (module open), `startHp` (current HP after regen, or full when off), `settleWounds` (write leftover HP back, min 1 — called before `awardMonsterXp`), `tooWoundedText`, `restIfLow` (autohunt), `woundNote`, plus the regen clock (`applyRegen`/`loadHero`). Used by combat_monster.ts, combat_partyduel.ts, autohunt.ts and raid.ts; all no-ops while the module is off |
| **hoard_db.ts** | Hunt and Hoard storage: `hoard_settings` (on/off), `hoard_players` (potion pack, bounty progress, regen clock), `hoard_stall` (3 offers of potions + peddler gear from gear.ts, 5% legendary; turns over every 20 min; each ware sells once — `claimOffer` marks it `soldTo` with a compare-and-swap so two buyers can't both get it, and the slot stays sold until the turnover), `hoard_board` (3 bounties from the roster's CR ≤ 3 end, reposted every 30 min, a fulfilled one replaced at once). Purged by `!dndbot leave purge` |
| **hoard_data.ts** | Hunt and Hoard tables: the six healing potions (prices in copper), stall merchants, item-lore lines, and tuning (refresh times, regen, rest share, sell-back share) |
| **guide_hoard.ts** | The Codex's "Hunt and Hoard" section (cards `card-hoard`, `card-hoardhunt`, `card-hoardbounties`, `card-hoardshop`), spliced in after the arena section |
| **botdetect.ts** | `!botcheck` — counts chatters that look like follow/view-bots (new account, default avatar, generated-looking name; known service bots, the broadcaster and GuildScribe excluded). `!botcheck ignore/unignore <user>` (mod) manages a per-channel ignore list (own table `botcheck_ignored`, purged by `!dndbot leave purge`). Full list with reasons at `/dashboard/botcheck`, behind the dashboard key + mod login. Uses Get Chatters via the broadcaster's stored token (`moderator:read:chatters`); scans are cached 60 s per channel. Heuristic only — nothing is banned |
| **adalerts.ts** | Automatic ad-break awareness while live (dashboard switch `adalerts`, on by default): a one-time chat **heads-up** `AD_HEADS_UP_MINUTES` (default 3) before Twitch's next scheduled ad (Get Ad Schedule; checked on chat activity, at most once a minute per channel, since Val Town crons can't tick faster than 15 min), and a **start notice** from the `channel.ad_break.begin` EventSub that also logs the break for `!adcheck`. Uses the broadcaster's `channel:read:ads` token; channels connected before this get the subscription created lazily, no reconnect needed. Own table `ad_alerts` |
| **loot.ts** | Coin dropped by slain monsters (solo fights and party hunts), scaled by CR and split among surviving hunters; called from `combat.ts` next to each XP award |
| **redemptions.ts** / **redemptions_db.ts** | Channel-point rewards that touch the game: `!boon` links a reward (by title) to a **robbery shield** or a **"can't use <feature>" lockout**; the EventSub `channel.channel_points_custom_reward_redemption.add` handler applies it, `rob.ts` honors the shield, and `main.ts` blocks hexed commands before any handler runs. Needs `channel:read:redemptions` (reconnect once) |
| **rob.ts** | `!rob @user` — robbery duel: both saved characters fight via the shared `resolvePlayerDuel` in `combat.ts`; the loser pays the winner 1–9% of their coin. Cooldowns live in `points_db.ts` (`rob_cooldowns`) |
| **swearjar.ts** | The swear jar: `!jar` total, `!jar +N` / `!jar -N` (subtract is mod-only, no cooldown), and automatic collection — each swear word in a plain chat message moves 2 cp (`SWEAR_COST_COPPER`) from the chatter's gold into the jar and announces it. Word list and detection live at the top of the file; table `swear_jar` is created by `ensureSwearJarTables()` |
| **nick.ts** | `!nick @user <nickname>` / `!nick remove @user` (mod) and `!nick list` — per-channel battle-log nicknames; table `viewer_nicknames` lives in `mentions.ts` and is purged by `!dndbot leave purge` |
| **watchtime.ts** | `!watchtime [@user]` — per-channel watch-time clock (StreamElements-style: counts everyone in the chat list while live via a 15-minute `watchtime_cron.ts` poll of Get Chatters, `moderator:read:chatters`; chat messages also advance it, so channels without the scope still work) and `!followage [@user]` — follow age via Helix Get Channel Followers using the broadcaster's stored token (`moderator:read:followers`). Own table `watchtime_stats`; purged by `!dndbot leave purge` |
| **points.ts** / **points_db.ts** / **coins.ts** | `!gold`, `!goldboard`, `!giveaway` — copper earned from live chat (shown as gp/sp/cp), the coin leaderboard, and giveaways; `!gold on/off/status` toggle (on by default). `points_db.ts` holds persistence (`points_settings`, `points_balances`, `giveaways`, `giveaway_entries`); `coins.ts` has the copper/silver/gold formatting and parsing shared with `haggle.ts` |
| **chronicle.ts** | `!chronicle on/off/status` — occasionally quotes a plain chat message back with a D&D-flavored reply |
| **npcs.ts** | `!npc ...` — AI-voiced NPC characters, channel-scoped or global, plus optional passive chatter |
| **types.ts** | Shared types |
| **data.ts** | Races, classes, level-scaled monsters, lookup map |
| **utils.ts** | Dice, formatting, narration |
| **narration.ts** / **dice.ts** / **flavor.ts** / **flavor_events.ts** | Duel narration lines, `!roll` dice expressions, fate/oracle/hug/shmash flavor, and sub/raid thank-yous + goodnight replies |
| **commandgroups.ts** | Dashboard feature groups (`COMMAND_GROUPS`) and `groupForMessage` |
| **db.ts** | SQLite schema + persistence |
| **db_schema.ts** / **db_custom.ts** / **db_merchant.ts** / **db_maps.ts** | Schema + migrations, custom commands/triggers/variables/timed messages, merchant state, battle maps — all re-exported from `db.ts` |
| **characters.ts** | Generation, XP, leveling, `!newchar` wizard |
| **bg3.ts** | `!bg3roll`, `!bg3companion`, `!bg3origin`, `!bg3loot`, `!bg3camp` — standalone Baldur's Gate 3 flavor generators (no DB); `!bg3` — random race/class + player-chosen BG3 point-buy scores, saved via db.ts |
| **bg3data.ts** | Static Baldur's Gate 3 knowledgebase — companions, origins, classes, races, locations, factions, deities, villains, legendary items |
| **bg3lookup.ts** | `!bg3lookup` — search + formatting over the `bg3data.ts` knowledgebase (no DB, no external API — it's hand-curated, unlike `lookups.ts`) |
| **combat.ts** | Duels, parties, hunts, initiative |
| **combat_shared.ts** / **combat_duel.ts** / **combat_monster.ts** / **combat_party.ts** / **combat_partyduel.ts** | Shared timeouts/forfeits/PvP resolver, PvP duels, solo monster duels, `!party`, party duels + party hunts — re-exported from `combat.ts`, which keeps the initiative tracker |
| **bestiary.ts** / **bestiary_page.ts** | The living bestiary: per-channel roster (core + learned monsters), monster adaptation from fight outcomes, `!bestiary`, and the `/bestiary?channel=<id>` page |
| **raid.ts** | The stream's raid quest — posted on `stream.online`, `!raid` musters a temporary party against a high-level boss whose HP persists between raids, with a per-channel raid cooldown |
| **customcommands.ts** | `!dndbot add/edit/remove/cooldown/enable/disable/list` custom commands and `!trigger` passive keyword auto-responses |
| **timedmessages.ts** | `!timedmsg add/edit/interval/enable/disable/remove/list` recurring announcements |
| **timedmessages_cron.ts** | Posts every timed message that's due — Val Town **cron trigger**, same shape as `merchant_cron.ts` |
| **howto.ts** / **howto_pages.ts** / **howto_pages2.ts** | Step-by-step how-to guides (`/howto`, `/howto/<slug>`; topics live in the two `howto_pages` files), the Codex's **How-to guides** and **Suggested pages for mods+** sections, and `/go/<page>?channel=<login>` shortcuts that open a channel's roster, bestiary, maps or overlays by Twitch login |
| **overlay.ts** / **overlay_page.ts** | OBS overlays: `/overlays` setup page, `/overlay?panel=<name>` transparent browser sources, and the `/overlay/data` JSON they poll (`getOverlayData` gathers raid, fights, giveaway, merchant, jar, leaderboards and guild summary, honoring the channel's dashboard switches); `!overlays` (mod, in chat_builtin.ts) posts the link |
| **overlay_theme.ts** | The full-screen theme overlay (`/overlay?panel=theme`): parchment sheet masked around a torn-edged 1440×810 game window at (64, 112), title, "Tavern Talk" chat read straight from Twitch IRC as an anonymous guest (fades after `&fade` seconds, honours deletions/timeouts, `&hide`/`&hidecmds`), d20 badge or `&logo=<url>`, and the status strip in an iframe; scales itself to any canvas size |
| **dashboard.ts** | `!dashboard [reset]` — mints/rotates the per-channel web dashboard link, and the GET/POST `/dashboard` route handlers |
| **maps.ts** | `!map` — create/list/view/delete grid battle maps, paint/fill terrain, and place/move/remove character tokens |
| **lookups.ts** | dnd5eapi + formatting + reference links |
| **twitch.ts** | Tokens, multi-part chat send |
| **pages.ts** | Guild Codex HTML, logs, character sheet UI, battle map view/list pages, operator admin logs page, web dashboard page |
| **dashboard_page.ts** / **page_shell.ts** / **guide_arena.ts** / **guide_custom.ts** | Web dashboard page, the shared HTML shell, and the second/third parts of the Guild Codex page (`guide.ts` stitches them together) |
| **README.md** | This document |

---

**File size rule:** Val Town rejects any file over roughly 80 KB ("File is too large" — the deploy then silently stays on old code). Keep every file at or under **44 KB (55% of that)**; when one grows past it, split it into a new module rather than trimming. Check with `wc -c *.ts | sort -rn | head`.

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
| `HUNT_LOOT_MULTIPLIER` | *(optional)* Scales the coin dropped by slain monsters; default 1, 0 disables monster loot |
| `ROB_COOLDOWN_SECONDS` | *(optional)* Seconds a player must wait between `!rob` attempts; default 300, floor 10 |
| `ROB_PROTECT_SECONDS` | *(optional)* Seconds a player is left alone after being targeted by `!rob`, win or lose; default 600, 0 disables |
| `POINTS_PER_MESSAGE` | *(optional)* Copper earned per qualifying chat message; default 1, range 1–1000 |
| `POINTS_EARN_COOLDOWN_SECONDS` | *(optional)* Seconds a viewer must wait between earning copper; default 60, floor 10 |
| `CHRONICLE_MIN_MESSAGES` | *(optional)* Chat messages required since the last quote before another can fire; default 15 |
| `MAX_NPCS_PER_OWNER` | *(optional)* NPC roster cap per channel (or the global roster); default 25 |
| `NPC_MODEL` | *(optional)* LLM model used for `!npc talk` replies; default gpt-4o-mini |
| `NPC_CHATTER_CHANCE_PERCENT` | *(optional)* Odds any single qualifying chat message triggers unprompted NPC chatter |
| `NPC_CHATTER_COOLDOWN_MS` | *(optional)* Minimum gap between unprompted NPC chatter in a channel |
| `NPC_CHATTER_MIN_MESSAGES` | *(optional)* Chat messages required since the last NPC chime-in before another can fire |
| `HAGGLE_MODEL` | *(optional)* LLM model used for `!haggle` replies; default gpt-4o-mini |
| `PRIMARY_BROADCASTER_ID` | *(optional)* Broadcaster id allowed to manage the shared "global" NPC roster with `!npc global add/edit/remove` |
| `DUEL_ACCEPT_TIMEOUT_MS` | *(optional)* How long a `!dndduel` challenge stays open before expiring; default 300000ms (5 min), floor 30000ms |
| `DUEL_IDLE_TIMEOUT_MS` | *(optional)* How long an active duel can sit idle before it's considered abandoned; default 600000ms (10 min) |

4. Twitch Developer Console → add **both** OAuth Redirect URLs exactly:  
   `https://<your-val>.web.val.run/callback` (broadcaster connect flow) and  
   `https://<your-val>.web.val.run/dashboard/callback` (viewer "log in with Twitch" check for the web dashboard — see below; the dashboard's login step will fail with a Twitch redirect_uri mismatch error until this second one is added)
5. Set `PUBLIC_BASE_URL` as an environment variable to your public HTTPS URL (used by `!guide` / `!link`). This deployment defaults to `https://guildscribe.val.run` when the env var isn't set.
6. Open the Val URL → **Raise the Guild Banner** → authorize.
7. In channel chat: `/mod YourBotName`
8. *(optional, for whispers)* Add a third OAuth Redirect URL, `https://<your-val>.web.val.run/connect-bot/callback`, then log in to Twitch **as the bot account** and open `https://<your-val>.web.val.run/connect-bot`. That grants the bot's own `user:manage:whispers` scope (stored in `bot_user_tokens`, refreshed automatically; any other account is turned away). The bot account needs a verified phone number for Twitch to allow whispers. **Troubleshooting:** open `https://<your-val>.web.val.run/connect-bot/status` (shows whether a token is stored, which account it belongs to, its scopes, and Twitch's answer to the last whisper attempt), or run `!whispertest` in chat as a mod — it whispers you and posts Twitch's exact reason if it fails. Until this is done, long replies still get their chat summary and detail-page link, just no whisper — see *Long replies become a one-message summary + link* below.

The OAuth flow requests `channel:bot channel:read:subscriptions channel:read:ads channel:read:redemptions moderator:manage:banned_users` — `channel:read:redemptions` powers channel-point shield/hex rewards (see *Channel-point rewards* under Gold), `channel:read:subscriptions` powers the sub/resub thank-you (see below), `channel:read:ads` powers `!adcheck`'s real Twitch ad-schedule lookup (falls back to the manually-logged `!adslogged` timestamp without it), and `moderator:manage:banned_users` lets `!autoban` ban "ai viewers" spammers (without it, auto-ban stays inert and tells the broadcaster to reconnect). **Channels that connected before these scopes were added need to reconnect** (the home page and guide both have a "reconnect" link — both point at `/connect`, same as the initial connect button) for new-sub/resub thank-yous and real ad-schedule checks to start working; the rest of the bot is unaffected either way. `/connect` → `/callback` is idempotent: reconnecting an already-connected channel cleans up its old EventSub subscriptions first, so it's safe to run any time GuildScribe gains a feature that needs a new permission, without duplicating subscriptions or losing existing character/party data.

Delete any old **`http.ts`** entry file after switching the trigger to `main.ts`.

**Long replies become a one-message summary + link:** anything the bot would say in **more than one chat message** is posted as a single message instead: a one-paragraph summary ending in a link to a page with the full output (`GET /r/<id>` — `replypages.ts`, used by `sendChatMessages`/`sendSpellSections` in `twitch.ts`). This covers command replies, passive replies and scheduled/cron posts alike. Each viewer has **one link per channel** that always shows their latest full reply — the same link is reused every time and its content is replaced (replies not addressed to anyone, like timed messages, share one channel link); content older than 24 hours is cleared, but the link keeps working for the next reply. Ordinary replies are summarized by their opening sentences (up to ~220 characters), and a link the reply exists to deliver (e.g. `!guide`, `!dashboard`) is kept in the summary. Auto-resolved fights (solo hunts, PvP duels, party hunts, party duels, raids, `!rob`) get a fight summary — who fought, the enemy, the outcome, everyone's remaining HP and the loot — and their page shows the **uncut** battle log in full detail: each fighter's stats up front (level, class, HP, AC and how it's built, attack and damage bonuses), then every swing as one compact line with the d20 roll and each bonus, the target's AC and its breakdown, the hit/miss margin, crits and fumbles, the damage dice and bonuses, and the target's HP before→after (e.g. `R2: Bob → Goblin: 18 +3 STR +2 prof +1 edge = 24 vs AC 13 (stat block) → HIT by 11 · 1d10 (7) +3 STR +1 edge = 11 · Goblin 12→1/20`), e.g. `@Bob ⚔️ Bob vs Goblin — Bob wins! ❤️ HP left: Bob 20/28, Goblin 0/20. 🪙 Loot: 2 sp 3 cp. 📜 Full battle log: https://…/r/abc123`. When the reply answers someone's `!command` and the bot has whisper access (step 8), the full reply is also whispered to them. If the detail page can't be saved, the reply is posted in full as before.

---

## Chat commands (full index)

### Guild hall & help
| Command | Description |
|---------|-------------|
| `!help` | Guild hall welcome + path to begin |
| `!guide` / `!link` | **Posts the Guild Codex URL** (`/guide`) |
| `!dndbothelp` | Codex chapters: dice, character, party, combat, lookup, maps, gold, custom, settings |
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
| `!roster` | Link to the **guild roster** web page — every adventurer, party and party member in the channel (searchable), with each adventurer's gold while the channel has gold on, and the current raid quest (boss, HP bar, muster/cooldown status, top damage) while the raid quest is switched on |
| `!overlays` | *(mod)* Link to this channel's **OBS overlay** setup page — every overlay URL with its suggested Browser-source size and a live preview |
| `!levelup` / `!levelup +/-N` | Adjust level |
| `!hp` / `!hp +/-N` | Show or change HP |
| `!savechar` / `!loadchar` / `!resetchar` | Backup / restore / reset |
| `!resetchar @user` | Reset another player's character *(mod)* |
| `!shmash` / `!shmash @user` | Just-for-fun narrated smash using your character against a target's (or a random comedic target if none given) — no HP/game state touched |
| `!watchtime` / `!watchtime @user` | How long a viewer has been around: a clock that runs while the viewer is in chat and the stream is live, lurkers included (needs the `watchtime_cron.ts` cron and the broadcaster to reconnect for `moderator:read:chatters`; without it, only time around chat messages counts — gaps over `WATCHTIME_SESSION_GAP_MINUTES`, default 15, aren't counted). Starts from deploy |
| `!botcheck` / `!botcheck ignore <user>` / `!botcheck unignore <user>` | How many chatters right now look like follow/view-bots (count only in chat; mods see the full list on the dashboard's 🤖 Bot viewer check page). `ignore`/`unignore` are mod/broadcaster and keep real viewers off the list. Needs `moderator:read:chatters` (reconnect once). Nothing is banned automatically |
| `!followage` / `!followage @user` | How long a viewer has followed the channel, from Twitch's Get Channel Followers. Needs the `moderator:read:followers` scope — the broadcaster must reconnect once |

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
| `!bestiary` | Link to this channel's **bestiary page** — every monster that can be hunted right now (core + learned), with stats, encounter levels, record and adaptation. Works offline like `!roster` |
| `!bestiary <monster>` | One monster's stat block, record here and what it has learned |
| `!bestiary learn <monster>` | Teach the bestiary a monster from the 5e API (anyone; a **mod** can also re-teach one that was forgotten) |
| `!bestiary forget <monster>` / `!bestiary reset <monster\|all>` | **Mod:** strike a learned monster (blocked from re-learning) / clear what monsters have learned from fights |
| `!dndduel [monster]` | Auto **solo monster** — random level-scaled foe, or name one (e.g. `!dndduel goblin`) |
| `!dndduel monster [classic] [monster]` | Classic solo monster, optionally named |
| `!dndduel party A B` | Auto party vs party |
| `!dndduel party classic A B` | Classic party vs party |
| `!dndduel party accept` / `decline` / `attack` / `status` / `end` | Party duel flow |
| `!dndduel party hunt <party> [monster]` | Auto **company vs monster** — random level-scaled foe, or name one (e.g. `!dndduel party hunt crew beholder`) |
| `!dndduel party hunt classic <party> [monster]` | Classic hunt (same optional monster name) |
| `!dndduel party hunt attack` / `status` / `end` | Hunt turns |
| `!party hunt …` | Alias for `!dndduel party hunt …` — accepts every form above (e.g. `!party hunt crew`, `!party hunt classic crew`, `!party hunt attack`) |
| `!autohunt [duration]` | **Timed solo hunt** — your saved hero fights a level-scaled monster about every 5 minutes (same dice engine, XP and loot as `!dndduel`). Duration is `20m`, `1h`, `1h30m` or a bare number of minutes; default 15m, allowed 10m–2h. Bouts are settled in batches with one chat report each time |
| `!autohunt status` / `!autohuntstatus` | Progress so far (settles anything already due) |
| `!autohunt stop` / `!autohuntstop` | Recall the hero early and post the trip total |
| `!huntcooldown` / `!huntcd` | Show the channel's hunting cooldown and your own remaining wait (anyone) |
| `!huntcooldown <time\|off>` | **Mod/broadcaster:** set the cooldown — `90`, `90s`, `5m`, `1m30s`, `1h`, or `off`/`0`; max 1 hour |
| `!raid` | **Raid quest** — sound the war horn against this stream's raid boss, or join the open muster. Needs a saved hero; up to 6 raiders, the party charges a minute after the horn (or when full) |
| `!raid go` / `!raid status` | Launch the muster early (its leader or a mod) / boss HP, muster and cooldown |
| `!raid cooldown [time\|off]` | Show the raid cooldown; **mods** set it (`90s`, `10m`, `1h`, `off`; max 2 hours, default 10m) |
| `!raid new` | **Mod:** post a fresh raid quest now (e.g. the bot joined mid-stream) |
| `!rob @user` | **Robbery duel:** your saved character fights theirs (same auto engine as `!dndduel @user`, no accept step). The loser pays the winner a random **1–9%** of the loser's coin (min 1 cp) — so a failed robbery costs the robber. Needs coin on; see *Robbing* under Gold, leaderboard & giveaways |
| `!turn start` … `!turn end` | Initiative tracker *(start/add/show/next/prev/remove/end are mod-only; `!turn roll` is open to any player, rolls 1d20+DEX)* |

**XP** is granted only when a **monster** falls (solo or party hunt). PvP awards none.

**Loot:** every monster kill (solo fights and party hunts, classic or auto) also drops a small amount of coin while coin is on, paid next to the XP and shown in the victory message (e.g. `🪙 Loot: +2 sp 3 cp.`). The drop is the monster's XP value ÷ 10 with ±25% variation, at least 1 cp — roughly 2 sp for a CR 1 monster and 1 gp 8 sp for CR 5. A party hunt drops **one hoard that the surviving members split** (everyone gets at least 1 cp), so a bigger company doesn't multiply the payout. PvP (`!dndduel @user`, `!rob`) drops none. Scale it with `HUNT_LOOT_MULTIPLIER` (0 turns loot off); `!gold off` pauses it along with the rest of the coin system.

**Autohunt:** `!autohunt` sends your hero out for a set time. Val Town has no always-on process, so a hunt is a stored schedule whose due bouts are *settled* — simulated with the real dice, paid out, and reported in one chat message — whenever the autohunt cron (`autohunt_cron.ts`, set it to every 15 minutes in Val Town) runs or the hunter uses `!autohunt` / `status` / `stop`. Settling is claimed atomically, so a bout is never paid twice. Only live channels are settled by the cron. Unlike Hunt & Hoard there is no auto-rest: heroes start every fight at full HP, so a loss just forfeits that bout's XP and loot. Limits: one hunt per viewer, 10 hunters per channel (`AUTOHUNT_MAX_ACTIVE`), bout length `AUTOHUNT_BOUT_MINUTES` (default 5). Hunts end when the bot leaves the channel. To avoid pinging the same viewer all hunt, the first **2** unprompted reports (from the cron) @-tag the hunter and later ones use their plain name; anything the hunter asks for with `!autohunt` / `status` / `stop` always tags them. Controlled by the same dashboard toggle as the rest of *Arena & company*.

**Hunting cooldown:** one per-channel cooldown covers *all* hunting — solo monster fights (`!dndduel`, `!dndduel <monster>`, `!dndduel monster [classic]`), party hunts, and `!autohunt`. It is per hero and starts when a hunt starts; a party hunt checks and stamps **every member** of the company, so a party can't dodge it by rotating who types the command (if any member is cooling down, the hunt doesn't start and nobody is stamped). PvP duels and `!rob` are not hunts and aren't affected. Autohunt bouts are spaced by the bout length *or* the cooldown, whichever is longer, and each bout restarts the hero's cooldown for manual hunts. The default is **2 minutes** (`HUNT_COOLDOWN_SECONDS`, 0 = off); a mod's `!huntcooldown <time|off>` is stored per channel and overrides it. Cooldown timestamps are cleared on `!dndbot leave`; the channel's setting is removed with `leave purge`.

**Raid quest:** when `stream.online` arrives, `raid.ts` posts ONE raid quest for that stream (deduped on the stream's `started_at`, so a redelivered event never posts twice): a random CR 13+ boss with doubled HP. `!raid` opens a muster for a temporary party; when it launches, every raider swings each round and the boss strikes back once plus one legendary action per two raiders. Its HP carries over between raids, and when it falls every hero who struck it during the stream gets its full XP and a share of a hoard 5× a normal drop. A per-channel **raid cooldown** (separate from the hunting cooldown) blocks a new muster after each launch. Val Town has no always-on process, so a muster whose minute is up is launched by the next chat message in the channel, or by the autohunt cron as a fallback. The quest is retired on `stream.offline`. Tunable env: `RAID_COOLDOWN_SECONDS` (600), `RAID_MUSTER_SECONDS` (60), `RAID_PARTY_MAX` (6), `RAID_MIN_CR` (13), `RAID_HP_MULTIPLIER` (2), `RAID_LOOT_MULTIPLIER` (5).

**Monster learning (`bestiary.ts`):** monsters learn in two ways, per channel. *New monsters:* a successful `!monster <name>` lookup (or `!bestiary learn <name>`) of a creature that isn't huntable yet converts its dnd5eapi stat block into the bot's one-swing format (best attack's to-hit; its damage folded into one die ≤ d20 plus a bonus with the same average) and stores it in `monster_learned`. *Adaptation:* every solo duel (auto/classic), party hunt (auto/classic), autohunt bout and raid outcome (slain or routed) updates the species' row in `monster_adaptation`: pressure = pressure × 0.97 + (win ? 1 − expected : −expected), where *expected* is the designed hero win rate for that level (~90% at L1 → ~65% at L20). The adaptation tier follows pressure with a one-point dead band, from −3 to +5; each tier is ±1 to hit and ±8% HP, every second tier ±1 AC and ±1 damage, applied **after** level scaling and its caps so it always takes effect. A tier change adds a 🧠 line to the fight result, and fights show the tier next to CR (e.g. `CR 1/4 🧠+2`). **Dynamic sizing:** every consumer reads the channel's live roster (`getChannelRoster` — core table + learned, cached 30 s per isolate): random picks (`pickMonsterForLevel`'s CR band and fallback are derived from the roster, not fixed numbers), named targets, autohunt, raid bosses (`pickRaidBoss`), the dashboard's hunt-vs-duel routing and the `/bestiary?channel=<id>` page. Both tables are removed by `!dndbot leave purge`.

**Name limit:** Twitch highlights a chatter's name every time it appears, with or without `@`, so within one response (a single chat message, a multi-part reply, or a summary) each chatter's name appears in full at most 2 times — later appearances use their short label (nickname, or one word of the name, as below). **Nicknames set with `!nick` are used in every reply**, not just battle logs: plain mentions of the name become the nickname, while `@tags` keep the real name so they still ping (nicknames are cached per channel for up to a minute) (`mentions.ts`, applied in `sendChatMessages` across all parts). Bare names are left alone in ordinary replies. Inside auto-resolved fights (solo, party hunt, PvP, party duel, `!rob`), every bare fighter name is replaced by **one complete word** of their display name so Twitch doesn't box it on every swing: the first word, split on capitals, underscores, digits and hyphens (`StonedSheamus` → `Stoned`, `xX_DragonSlayer_Xx` → `Dragon`). Display capitalization comes from the reply's own `@tag`, and from a small `viewer_names` table filled whenever someone runs a command (per channel; removed by `!dndbot leave`). If a name has no findable word boundary (all-lowercase single token never seen with capitals), or two fighters would get the same word, it falls back to its first few letters with no ellipsis (`felivore` → `Feli`; length is `SHORT_NAME_LETTERS`, default 4, set 3 for `Fel`), lengthened one letter at a time until fighters differ. A mod can override any name with `!nick @user <nickname>` (stored per channel in `viewer_nicknames`, handled in `nick.ts`; `!nick remove @user`, `!nick list`), which wins over the `NAME_ALIASES` env var and the built-in alias table. The reply's own `@tag` keeps the full name.

**Battle logs:** every auto-resolved fight prints each swing as `attacker hits target [roll vs AC] for N (target HP/max)`, grouped into rounds (`R1: … | R2: …`); crits show `💥 CRITS`, fumbles `fumbles (nat 1)`, and rounds trimmed for chat length show as `…R4–R7…`. Classic turn messages show the target's remaining HP the same way.

**Timeouts:** a pending challenge (`accept`/`decline`) expires after 5 minutes if unanswered. Any active classic (turn-based) duel — 1v1, party vs. party, or a party hunt — auto-forfeits to the non-idle side if nobody acts for 10 minutes, so an abandoned duel can't block that channel's dueling into the next stream. Both windows are checked lazily the next time anyone runs a `!dndduel` command in that channel (no idle duel needs to be manually ended first).

### Hunt and Hoard

**Wounds across all combat:** while the module is open, every monster fight — `!hunt`, `!dndduel` solo and party hunts (auto and classic), `!autohunt` and raids — starts at the hero's current HP and writes the leftover HP back (never below 1). Heroes at 1 HP are refused (solo) or sit out (party hunts, raids) until they `!rest` or drink a potion; `!autohunt` rests a low hero to 80% instead of fighting that bout; retreating from a classic fight (`end`) keeps the wounds taken. Every monster kill in those fights also counts toward the bounty board. PvP is unaffected. With the module closed, all of this is off and fights start at full HP as before (hoard_combat.ts).

**Off by default** — a mod opens it with `!hoard on` (or the dashboard's *Hunt and Hoard* folder, which also has one switch per Codex card). While it's off, or if the channel has its own enabled custom command of the same name, these words do nothing and the custom command answers.

| Command | Description |
|---|---|
| `!hoard on` / `off` / `status` | **Mod/broadcaster** open or close the module (`status` is open to everyone). Closing keeps potions and bounty progress |
| `!hoard` | Your Hunt and Hoard sheet and a "Next:" hint |
| `!hunt [monster]` | Hunt a level-fit monster from the bestiary, or a named one. Same engine, scaling, adaptation, XP, loot and hunting cooldown as `!dndduel`. Needs more than 1 HP |
| `!rest` | Recover to 80% of max HP. You also regain 3 HP every 15 minutes |
| `!ledger [@user]` | Level, race/class, HP, AC, XP, coin, potions and gear count |
| `!bounties` / `!quests` | The shared bounty board (3 "slay N of X" postings, CR ≤ 3) and your progress. Every monster kill counts (`!hunt`, `!dndduel` solo/party hunts, `!autohunt`, a slain raid boss); first to finish is paid coin (sometimes a potion) and the posting is replaced |
| `!shop` / `!merchant [#\|name]` | The stall's 3 wares (potions and peddler gear, rarely a legendary), or one ware's details and lore. Sold slots show who bought them; turns over every 20 minutes |
| `!buy <#\|name>` / `!buy 1 3` / `!buy all` | Buy with coin (gold must be on) — one ware, several (`1 3` or `1,3`), or everything left. Each ware sells **once**: the first buyer gets it and the slot stays sold until the stall turns over (every 20 min). Unaffordable, already-owned or already-sold wares are skipped and listed. Gear goes onto your sheet permanently, like a `!haggle` purchase; potions go into your pack |
| `!inv` / `!inventory` | Your potions, and how much gear is on your sheet |
| `!use <potion>` | Drink a potion (bare `!use potion` drinks your smallest) |
| `!sell <potion>` / `!drop <potion>` | Sell a potion back for half its price, or throw it away. Gear can't be sold |
| `!purse` / `!coinpurse` | Your coin and the cheapest ware it can buy |

### Gold, leaderboard & giveaways
**On by default.** A mod or the broadcaster can turn it off with `!gold off` (or the **Gold, leaderboard & giveaways** switch on the web dashboard) and back on with `!gold on`. While on, viewers earn **copper** for chatting **while the stream is live** and a small coin drop for every monster they slay (solo or on a party hunt — see *Loot* under Arena & wilds) (plain messages only, `POINTS_PER_MESSAGE` copper once per `POINTS_EARN_COOLDOWN_SECONDS`, default 1 cp a minute). Balances are per channel and are kept when the system is switched off; `!dndbot leave` keeps them, and `!dndbot leave purge` deletes all balances and giveaways.

**Coins.** Everything is stored as whole copper and shown as gold, silver and copper using the 5e rates: **10 cp = 1 sp, 10 sp = 1 gp** (so 100 cp = 1 gp), e.g. `1 gp 2 sp 3 cp`. Wherever a command takes an amount you can type `50` (bare numbers are copper), `5sp`, `1gp`, or a mix such as `1gp 2sp 3cp` or `1g2s3c`. The same coins pay for `!haggle` and giveaway tickets.

The command is `!gold` and the leaderboard lives under `!gold top` on purpose: `!points` and `!leaderboard` are already claimed by StreamElements and other bots (the same collision that turned the dice leaderboard into `!rollcall`).

| Command | Description |
|---------|-------------|
| `!gold` | Your purse and rank |
| `!gold @user` | Someone else's purse and rank |
| `!gold top [N]` / `!goldboard [N]` | Richest adventurers (default 5, max 10) |
| `!gold give @user <amount>` | Gift some of your coin, e.g. `!gold give @friend 5sp` |
| `!gold add` / `remove` / `set @user <amount>` | Adjust a balance, e.g. `!gold add @friend 2gp` *(mod)* |
| `!jar` | **Swear jar:** shows the total, plus when the jar was last given away (who won and how much). Swearing in chat automatically costs 2 cp per word (paid from your gold, needs coin on) and the bot announces it. No cooldown |
| `!jar +<amount>` | Add coin to the jar by hand, e.g. `!jar +8`, `!jar +5sp` |
| `!jar +<amount> @user` | Fine a viewer: moves that much of *their* gold (whatever they can afford) into the jar *(mod)* |
| `!jar -<amount>` | Take coin out of the jar *(mod)* |
| `!jar giveaway` | Give the **whole jar** to a random chatter from the past week (paid into their gold, never the streamer) and empty it *(mod)*. Limited to **once every 7 days**; an empty jar or empty pool doesn't use up the week |
| `!jar words` / `!jar forget <word>` | *(mod)* See the words the jar has **learned** in this channel, or veto one. The jar learns by itself: an unknown word used right next to swearing, 5+ times by 3+ different chatters, and almost never otherwise (60%+ of its uses), starts charging. Emotes, common words and links are never learned; a charge for a learned word names it in chat |
| `!fine` | Fine the streamer one swear word (2 cp from the streamer's gold into the jar). Anyone can use it, no cooldown |
| `!gold on` / `off` | Turn coin, the leaderboard, giveaways and paid haggling on or off; on by default *(mod)* |
| `!gold status` | Check whether it's on (open to everyone) |
| `!giveaway` | Current giveaway, ticket price and entry counts |
| `!giveaway enter [tickets]` | Enter; free giveaways are one entry, paid ones cost coin per ticket up to the per-person cap |
| `!giveaway start [cost=<amount>] [max=N] <prize>` | Open a giveaway, e.g. `!giveaway start cost=5sp max=5 Steam key` (no spaces inside the cost) *(mod)* |
| `!giveaway draw` | Pick a winner (weighted by tickets) and close entries *(mod)* |
| `!giveaway reroll` | Draw again, excluding anyone already drawn *(mod)* |
| `!giveaway cancel` | Call it off and refund every ticket *(mod)* |

Only one giveaway exists per channel at a time; starting a new one replaces the previous (closed) one. When the system is off, `!gold` and `!giveaway` commands are silent except `!gold on/off/status`.

#### Robbing (`!rob`)
`!rob @player` turns a pickpocket attempt into a fight. Your saved character and theirs are put through the same auto-resolved duel as `!dndduel @user` (there is **no accept step** — a robbery isn't a polite challenge — but a coin flip decides who swings first, so it's a fair fight). When it ends, the **loser** pays the **winner** a random whole-number **1–9%** of the *loser's own* coin, rounded down but at least 1 cp. Win and you lift a slice of their purse; lose and you pay them a fine out of yours.

- Both players need a saved character (`!createchar` / `!newchar` / `!bg3`) and must actually carry coin — the robber needs some to risk, and the target needs something worth stealing.
- Only coin moves. Characters aren't hurt and earn no XP.
- Cooldowns stop abuse: a robber waits `ROB_COOLDOWN_SECONDS` (default 5 min) between attempts, and a target is left alone for `ROB_PROTECT_SECONDS` (default 10 min) after being targeted, win or lose.
- `!rob` is silent while coin is off (`!gold off`). It also belongs to the dashboard's **Arena & company** command group, so a steward can switch robbing off there while leaving the rest of the coin system on.

#### Channel-point rewards (`!boon`)
A streamer can make Twitch channel-point rewards act on the game. Create the reward in Twitch as usual, then link it by its **exact title** (case ignored):

| Command | What it does |
|---|---|
| `!boon add shield <minutes> <reward title>` | Redeeming it gives the **redeemer** a robbery shield: nobody can `!rob` them for that long *(mod)* |
| `!boon add lockout <minutes> <reward title>` | Redeeming it **hexes another viewer**: they can't use a chosen feature for that long *(mod)*. Make the reward **require viewer input**; the redeemer types `<user> <feature>`, e.g. `bob rob` |
| `!boon remove <reward title>` | Unlink a reward *(mod)* |
| `!boon clear @user` | Lift every active shield/hex on someone *(mod — for mistakes or abuse)* |
| `!boon list` | Which rewards are linked and what they do |
| `!boon status [@user]` | Active shields/hexes on you or someone else |

Lockable features: `rob`, `haggle`, `duel` (all `!dndduel` plus `!party hunt`), `autohunt` (starting one; `status`/`stop` still work), `dice` (`!roll`/`!r`/`!d20`), `gold` (`!gold`, `!goldboard`, `!giveaway`). Several spellings are accepted (`robbery`, `duels`, `coins`, …).

- **One-time setup:** the broadcaster must [reconnect](/connect) so GuildScribe is granted `channel:read:redemptions` and can subscribe to redemptions. Nothing else about the channel changes.
- Buying the same effect while it's active **adds** to the remaining time, capped at 2 hours per effect.
- The broadcaster, the bot and yourself can't be hexed. A malformed lockout (no target/feature) is reported in chat. GuildScribe can't refund redemptions of rewards it didn't create (a Twitch rule), so a mod refunds those from the rewards queue.
- Effects are stored per channel and vanish by themselves; `!dndbot leave` clears active effects, `leave purge` also removes the reward links. Named `!boon` rather than `!redeem` because StreamElements already uses `!redeem`.

**Upgrading from the first gold version:** balances and giveaway prices written back when 1 chat message earned "1 gold" are converted once, automatically, on the next request (×100, so 1 old gold becomes 1 gp). A fresh install has nothing to convert.

### Custom commands & triggers
Shares the `!dndbot` word used by [Stewards](#stewards-settings) below, but different subcommands (`add`/`edit`/`remove`/`cooldown`/`enable`/`disable`/`list` vs. `on`/`off`/`status`/`leave`), so there's no collision.

| Command | Description |
|---------|-------------|
| `!dndbot add <name> <response>` | Create `!<name>` *(mod)* |
| `!dndbot edit <name> <response>` | Change an existing custom command *(mod)* |
| `!dndbot remove <name>` | Delete a custom command *(mod)* |
| `!dndbot cooldown <name> <seconds>` | Per-command cooldown, 0-3600s; default 5s *(mod)* |
| `!dndbot enable <name>` / `disable <name>` | Turn one custom command on/off without deleting it *(mod)* |
| `!dndbot list` | List configured custom command names (disabled ones marked `(off)`) |
| `!trigger add <keyword> <response>` | Fire `<response>` whenever `<keyword>` appears in chat, no `!` needed *(mod)* — quote multi-word keywords |
| `!trigger remove <keyword>` | Delete a trigger *(mod)* |
| `!trigger cooldown <keyword> <seconds>` | Per-trigger cooldown, 0-3600s; default 15s *(mod)* |
| `!trigger enable <keyword>` / `disable <keyword>` | Turn one trigger on/off without deleting it *(mod)* |
| `!trigger list` | List configured trigger keywords (disabled ones marked `(off)`) |

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

The dashboard (`GET /dashboard?channel=<id>&key=<dashboard_key>`) is a plain-HTML page for adding, editing, and deleting custom commands, chat triggers, and timed messages with forms instead of chat syntax, plus the on/off switches for the bot's features (including **Gold, leaderboard & giveaways**). Two independent layers gate access to it:

1. **The link itself.** The `key` is a per-channel capability token (see `db.ts`'s `dashboard_key` column) — it's only ever handed out via the mod-gated `!dashboard` command, never posted automatically or shown to everyone.
2. **A live Twitch login.** Opening the link (even with a valid key) first shows a "Log in with Twitch" gate. Logging in checks — at that moment, via Twitch's Get Moderated Channels API — whether the logged-in account is actually a moderator or the broadcaster of *that* channel. Only then does a signed, channel-scoped session cookie (12-hour expiry) unlock the actual management UI. This means a screenshotted or leaked link is useless to anyone who isn't currently a mod of that channel on Twitch, even though it still requires the OAuth redirect URI in step 4 above.

**Linked switches.** Some switches only work when another one is on too — every gold card needs the Gold switch, Hunt and Hoard's cards need its master switch (and its stall needs Gold), AI NPC chatter needs AI NPCs, and the map sub-cards need *Create & view maps*. Those dependencies live in one map (`TOGGLE_REQUIRES` in commandgroups.ts) and are shown everywhere: the switches others depend on get a **gold border**; a dependent switch's window has gold-bordered *Needs: …* links (with live On/Off) that jump to the required switch; its tile shows *needs 🪙 Gold* while that switch is off; folders list what their switches depend on; and every Guild Codex card gets a matching *🔗 Needs: … switch* link beside its own switch link. (dashboard_links.ts).

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
| `!dndbot leave purge` | Broadcaster-only: disconnect and purge this channel's stored characters/parties/gold balances/giveaways/logs/gameplay state |
| `!market on` / `off` | Enable or disable the open-stall merchant's periodic ads. **Off by default** *(mod)* |
| `!market status` | Check whether the merchant is currently active in this channel (open to everyone) |

`!haggle <pitch>` (open to everyone, e.g. `!haggle come on, five copper is robbery`) rides on this same toggle — it bargains over whatever the merchant last listed, with an AI-voiced, sassy in-character verdict. No listing yet, or the market's off? It says so instead of calling the AI. Three attempts per viewer per listing.

**Haggling is a real purchase in coin.** While coin is on (the default), the numbers in the haggle decide what changes hands. The listing's price (e.g. "1 silver 2 copper" = 12 cp), any offer named in your pitch (`!haggle come on, five copper is robbery` offers 5 cp), and the price the peddler agrees to in his reply are all used: the peddler ends with a machine-read `DEAL <copper>` or `NO DEAL` tag (stripped before chat sees it), and on a deal you pay that price on the spot. The price is clamped between your offer and the sticker price, so he can never charge more than listed or accept less than you asked. A refusal, a silly trade demand, or an AI failure costs nothing. If you can't afford the lowest price your pitch could settle at, he won't start haggling and your attempt isn't used up; if he agrees to a price above your purse, there's no sale. The wares themselves stay flavor (no inventory). With coin switched off (`!gold off`), haggling is free banter and nothing is charged.

**Quiet while offline:** GuildScribe tracks each channel's live/offline status via Twitch's `stream.online`/`stream.offline` EventSub events (pushed to the bot, not polled — no extra Twitch API call on chat messages). While a channel is offline, regular viewers' commands and ambient chat (goodnight replies, chronicle quotes, NPC chatter, sub/raid thank-yous, merchant ads, timed messages) are silently skipped — **mod+** — the broadcaster, lead moderators and moderators (anyone with the `broadcaster`, `lead_moderator` or `moderator` chat badge) — can still use every command normally so they can test the bot without going live. The same mod+ set counts as a moderator for every mod-only command. `!dndbot leave`/`leave purge` and `!dndbot on`/`off`/`status` are unaffected by this check. Channels connected before this feature shipped get caught up automatically (a one-time backfill the first time they'd otherwise be silenced) — no need to disconnect/reconnect.

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
!roster              ──►  Read-only web page of all characters + parties at /roster?channel=<id>
```

---

## HTTP routes

| Path | Purpose |
|------|---------|
| `GET /` | Guild hall — info page, links to `/connect` |
| `GET /connect` | Starts Twitch OAuth — generates state, redirects straight to Twitch's authorize page (no intermediate GuildScribe page) |
| `GET /callback` | Twitch OAuth return |
| `GET /r/<id>` | A viewer's latest full reply (anything longer than one chat message), linked from its one-message chat summary; one fixed link per viewer per channel, content kept 24 hours |
| `GET /connect-bot` · `/connect-bot/callback` · `/connect-bot/status` | One-time operator step: the bot account grants `user:manage:whispers` so long replies can be whispered; only the `TWITCH_BOT_ID` account is accepted |
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
| `GET /roster?channel=<broadcaster_id>` | Every saved character, plus every party and its members, for a connected channel (linked by `!roster`) |
| `GET /howto` · `/howto/<slug>` | How-to guide index and individual step-by-step guides (connect, dashboard, overlays, stream day, custom commands, timed messages, channel points, giveaways, first character, gold, raid, market, maps, NPCs, moderation), linked from the top of `/guide` |
| `GET /go/<overlays\|roster\|bestiary\|maps>?channel=<login>` | Redirects to that page for a connected channel by Twitch login (asks for the channel when it's missing); used by the Codex's *Suggested pages for mods+* |
| `GET /overlays?channel=<id or login>` | OBS overlay setup page: each panel's URL, suggested size and a live preview (linked by `!overlays`) |
| `GET /overlay?channel=<id or login>&panel=<name>` | One transparent OBS Browser-source overlay. Panels: `status`, `raid`, `battle`, `giveaway`, `merchant`, `jar`, `gold`, `dice`, `guild`, `all`, `rotate`. Extras: `scale`, `side=right` (hang from the right — anchored to the right edge and mirrored: text, HP bars draining to the right, list numbers, turn markers and status-bar chips flip; the setup page has a checkbox per overlay), `from=bottom` (feed from the bottom up — anchored to the bottom edge, first panel lowest and the rest stacking upward; also a checkbox per overlay), `align=right/center` (just moves the column), `refresh` (s), `limit`, `window=hour/day/week` (dice), `cycle` (s, rotate), `always=1` |
| `GET /overlay/data?channel=<id or login>&panels=<a,b>` | The JSON the overlays poll; public and read-only like `/roster`, only for connected channels, and switched-off features come back `null` |
| `GET /map?channel=<broadcaster_id>&map=<name>` | Live, auto-refreshing visual battle map (terrain grid + character tokens); read-only — editing happens via chat |
| `POST /` | EventSub (chat + webhooks) |

---

## XP & monsters

- Start: level 1, 0 XP  
- Monster CR → XP; thresholds can auto-level  
- Monster CR → a small coin drop (XP ÷ 10, ±25%), split among surviving hunters  
- Monsters chosen by **level** (and party size on hunts), with win-friendly balance; auto solo duels are settled by the real dice, not a fixed win rate — the odds come from the actual matchup (roughly 80–90% wins against a level-appropriate foe early on, tapering toward even at level 20), once per fight a d20 of 18+ lets a hero who would drop to 0 HP cling on at 1 HP, and a mismatch (a novice naming a dragon) is a genuine loss. Bosses far above your level are meant for **party hunts**: a lone hero has no real shot at a beholder, but a big enough company does  
- Large solo roster across CR bands (CR 1/8 through 17), including:
  - **Beholder kin** — Gazer, Spectator, Gauth, Beholder Zombie, Death Kiss, Beholder, Xanathar, Death Tyrant
  - **Dragons** — chromatic and metallic wyrmlings, young dragons and adult dragons (e.g. `Adult Red Dragon`, `Young Silver Dragon`, `Green Dragon Wyrmling`), plus Pseudodragon and Dragon Turtle
  - **Baldur's Gate 3** — Intellect Devourer, Githyanki Warrior/Knight, Hook Horror, Auntie Ethel, Drider, Ulitharid, Elder Brain and more
  - **Published campaigns** — Curse of Strahd, Tomb of Annihilation, Descent into Avernus, Out of the Abyss, Princes of the Apocalypse, Waterdeep: Dragon Heist, Ghosts of Saltmarsh and others
- The roster grows per channel: `!monster <name>` teaches the bestiary any 5e API monster it doesn't have yet, and monsters adapt from their fights (see *Monster learning* above). `!bestiary` links the full, current list  
- Random picks (`!dndduel`, party hunts) stay within the level-appropriate CR band; the high-CR entries (roughly CR 7+) are only fought by name: `!dndduel <name>` / `!dndduel monster [classic] <name>` solo, or `!dndduel party hunt [classic] <party> <name>` with a company, e.g. `!dndduel party hunt crew beholder`. Names match exactly first, then by substring; a few generic words are pinned (`dragon`, `black dragon`, `blue`, `devil`, `hag`, `fire`, etc.) so they keep resolving to the same entry  

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

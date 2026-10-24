// GuildScribe — HTML for the OBS overlays (see overlay.ts for the routes and
// data). Each overlay is a transparent page that polls /overlay/data and
// redraws itself, so OBS needs nothing but a Browser Source pointed at it.
// Everything viewer-supplied (names, prizes, item text) goes into the page
// through textContent, never innerHTML.

import { escapeHtml } from "./utils.ts";
import { scrollDoc } from "./scroll_theme.ts";
import { SCENES } from "./overlay_scenes.ts";
import { BODY_FONTS, DEFAULT_PRESET, HEADING_FONTS, LOOK_FONTS_JSON, LOOK_PRESETS, LOOK_PRESETS_JSON, type LookFont } from "./overlay_style.ts";

/** Every overlay panel: what it shows and a sensible OBS browser-source size. */
export const OVERLAY_PANELS: Record<string, { label: string; blurb: string; width: number; height: number }> = {
  theme: { label: "Full stream theme", blurb: "Your whole layout in one source, in five scenes — Gameplay, Starting soon, Be right back, Just chatting and Ending soon (pick below; add one OBS Browser source per scene). Gameplay is a parchment sheet with a torn-edged window for your game, your channel name across the top, Tavern Talk chat down the right (lines run top-down and fade after 30 s — change with &fade=<seconds>, 0 keeps them — with the goldboard of the richest adventurers along its bottom; &goldboard=0 to drop it), a d20 emblem (or your own image or PNGtuber) bottom-left, and the status strip along the bottom with a rotating \"Next:\" suggestion (&status=0 to drop it). Put it above your game capture, and place your sources where the list below says. The Be right back and Just chatting scenes put your stream title under the channel name (follows your Twitch title; &subtitle=<text> to pin your own, &subtitle=0 to hide) and add a window playing The Endless Delve — the idle game your chat plays, in place of Words on Stream (&idle=0 leaves the window empty for a source of your own) — a Dungeon Gate for pop-up overlays like Tangia dungeons, a Battle Tracker (the fight under way, the raid boss and recent results, drawn by the theme — &tracker=0 to leave it empty), and a Saving Throws tally under the Be right back / Just chatting card: every saving throw chat rolls this stream (!save dex, !save wis dc15 — rolled against the bot's d20 unless a DC is named — and plain !save) as saved / failed per ability, plus the latest roll; it starts fresh when you go live or on !saves reset (&saves=0 to drop it). Starting soon and Ending soon share the Be right back layout: Starting soon swaps the card for a big \"Starting Soon\" countdown (no Saving Throws tally — it would only be empty), and Ending soon has an \"Ending Soon\" card with farewell lines, the stream's Saving Throws tally under it as a recap, and &raid=<channel> for a \"Raiding … next\" line. Extras there: &minutes=<n> for a countdown (Starting in / Back in / Ending in), or &at=<HH:MM> to count down to a time of day (your PC's clock — it keeps the same deadline if OBS reloads the source), &text=<line> for your own line instead of the rotating ones (&brbtext= still works), &topic=<text>, &gate=<label>. Your title is your Twitch name, kept up to date. The gem beside it glows red while you're live and turns grey when you're offline. Every scene also has Sound Bytes built in: the sounds chat sets off with !sound play from the theme itself, with their card popping up over the sheet (in the Dungeon Gate in Be right back and Just chatting) — only from the scene that's showing, so they never double up between scenes (tick Control audio via OBS on the source; &volume=0-100, &caption=0 for sound only, &sounds=0 to leave it out if you use the stand-alone Sound Bytes source instead). Extras: &title=<text> to write your own, &hide=nightbot,streamelements to leave bots out of chat, &hidecmds=1 to leave out !commands. The emblem — the d20, your own image, or a PNGtuber that swaps to its talking image — reacts to your mic: dim when you're quiet, bright and glowing when you talk. Set it up below, and start OBS with --enable-media-stream (add it to the end of the OBS shortcut's Target) so browser sources may use the mic. Colours and the sheet itself are yours too: the 🎨 Look box above picks a preset (Moonlit Keep, Elven Grove, Frostfell, Hellforge, Arcane Tower — each with its own colours and fonts), any colour, heading and text fonts, your own sheet image and whether the scroll rollers show.", width: 1920, height: 1080 },
  status: { label: "Status bar", blurb: "One slim strip: live dot, raid boss HP, fight in progress, giveaway, the peddler's ware and the swear jar. Made for the top or bottom edge of the screen. Add &next=1 for a rotating \"Next:\" suggestion — the command that fits what's happening (join the raid, take your turn, enter the giveaway…) or a way in for newcomers.", width: 1920, height: 70 },
  raid: { label: "Raid boss", blurb: "This stream's raid boss with its HP bar, the muster/cooldown state, and the top damage dealers.", width: 520, height: 300 },
  battle: { label: "Battle tracker", blurb: "Whatever fight is under way — arena duel, monster hunt, party duel or party hunt — with live HP bars and whose turn it is, this stream's raid boss (HP, muster state and top raiders), plus the last few results from the past 45 minutes (auto hunts and duels, !autohunt bouts, raids, robberies) with the session's win/loss tally. Hidden when there's no raid boss and nobody has fought lately.", width: 560, height: 420 },
  giveaway: { label: "Giveaway", blurb: "The open giveaway's prize, entrants and tickets, then the winners for ten minutes after the draw. Hidden otherwise.", width: 520, height: 200 },
  merchant: { label: "Peddler's stall", blurb: "The ware the open-stall merchant is currently hawking and its price (needs !market on).", width: 520, height: 180 },
  jar: { label: "Swear jar", blurb: "The swear jar's running total; it bounces whenever someone pays in.", width: 360, height: 110 },
  shots: { label: "Shots taken", blurb: "A small counter of the shots you've taken this stream — mods add one with !shot (!shot undo, !shot +N / -N, !shot set N, !shot reset); chat checks it with !shots. It pops whenever the count goes up and starts over at 0 when you go live. Needs the Shot counter switched on; counting drinks or sips instead? Change the word in Quick setup on your dashboard and the heading (and the commands) follow.", width: 340, height: 130 },
  gold: { label: "Coin leaderboard", blurb: "The channel's richest adventurers (needs gold on).", width: 400, height: 300 },
  dice: { label: "Roll call", blurb: "Natural 20 and natural 1 leaders. Add &window=hour or &window=week (default: day).", width: 520, height: 260 },
  guild: { label: "Guild summary", blurb: "How many adventurers and parties the guild has, plus its highest-level heroes.", width: 460, height: 320 },
  all: { label: "Everything (stacked)", blurb: "Every panel that has something to show, stacked in one column.", width: 560, height: 1080 },
  music: { label: "Now playing", blurb: "The song you're playing — from Spotify, or Apple Music and YouTube through Last.fm — with cover art and (Spotify) a progress bar. Set the source up on your dashboard's 🎵 Now playing page. Hidden while nothing plays. Also available inside the theme: tick \"Now playing\" on the theme card (&music=1).", width: 520, height: 120 },
  idle: { label: "The Endless Delve (idle game)", blurb: "An idle game your chat plays together — a drop-in for Words on Stream. The guild's party fights its way down an endless dungeon on its own; any chat message joins the chatter's hero to the party and lands a strike, \"fireball\" in chat is a big hit and \"bless\" doubles damage. Bosses every 10 floors, a quartermaster who spends the gold, and renown when the party retreats. Saved heroes show their class and hit harder. Works on its own in any scene — add it as a Browser source at 1280 × 720 (any 16:9 size works). The theme's Be right back and Just chatting scenes have it built in too, and every copy you have open plays the same game: one runs it and the rest mirror it live, so chat counts once and progress never splits. Progress is kept in OBS between streams. Tune it (boss timer, spell words…) or switch it off under Quick setup on your dashboard. Mods: !delve reset in chat starts it over.", width: 1280, height: 720 },
  sounds: { label: "Sound Bytes", blurb: "Tavern sound effects chat sets off with !sound <name> — nat 20 fanfare, sad-trombone nat 1, dice, sword clash, coins, level up, fireball, healing light, drumroll, dragon roar, tavern bell — with a card at the bottom of the screen while each plays. Every sound is made live in the browser, so there's nothing to download. Already built into every scene of the Full stream theme — add this stand-alone source only to scenes without the theme (or put &sounds=0 on the theme link), or sounds will play twice. Tick Control audio via OBS on the Browser source so they show up in your mixer. Sounds take turns (up to five wait in line); mods set the channel-wide gap with !sound cooldown <seconds|off> (default 15 s). Your own custom commands and triggers play a sound too when their response starts with 🔊 and a sound name, e.g. !dndbot add crit 🔊 nat20 CRITICAL HIT from {user}! Extras: &volume=0-100 (default 70), &caption=0 for sound only, &test=nat20 to play one on load and check OBS audio, &debug=1 to keep the connection status on screen.", width: 1920, height: 1080 },
  alerts: { label: "Alerts", blurb: "A card and a fanfare on stream for every new follower, sub, resub (with their message), gift sub, raid and cheer, plus tips you announce with !alert tip <name> <amount> [message]. Turn on \"On-screen alerts\" on the dashboard first; your chat thank-yous keep their own switches. Alerts take turns, one every few seconds. Cheer alerts need one reconnect to GuildScribe (it asks Twitch for bits:read). Test it with !alert test [follow|sub|resub|gift|raid|cheer|tip] or by adding &test=sub to the link. Tick Control audio via OBS on the Browser source. Extras: &volume=0-100 (default 70), &sound=0 for the card only, &messages=0 to leave viewers' messages off the card, &position=top|center|bottom, &seconds=3-20 for how long each card stays (default 7).", width: 1920, height: 1080 },
  rotate: { label: "Everything (rotating)", blurb: "One panel at a time, cycling through whichever have something to show. Change the pace with &cycle=<seconds> (default 12).", width: 560, height: 440 },
};

const STYLE = `
:root{--ink:#f4eadb;--muted:#cbb9a6;--gold:#e6a56e;--edge:#b97545;--card:rgba(21,18,15,.84);--good:#7fd17a;--warn:#e8c25a;--bad:#e0604f}
*{box-sizing:border-box}html,body{margin:0;background:transparent;overflow:hidden}
body{font-family:Georgia,"Times New Roman",serif;color:var(--ink);text-shadow:0 1px 2px #000c;padding:10px}
#root{transform-origin:top left;display:flex;flex-direction:column;gap:12px;width:max-content;max-width:100%}
body.right #root{margin-left:auto;transform-origin:top right;align-items:flex-end}
body.center #root{margin:0 auto;transform-origin:top center;align-items:center}
.card{background:var(--card);border:1px solid var(--edge);border-radius:12px;padding:14px 16px;min-width:300px;max-width:540px;box-shadow:0 8px 22px #0007}
.card h2{margin:0 0 8px;font-size:1.1rem;color:var(--gold);letter-spacing:.02em;display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.card h2 small{color:var(--muted);font-size:.78rem;font-weight:normal}
.big{font-size:1.5rem;font-weight:bold}.big.shots{font-size:2.6rem;line-height:1;text-align:center}.muted{color:var(--muted);font-size:.88rem}.hint{color:var(--gold);font:600 .8rem ui-monospace,monospace;margin-top:6px}
.bar{position:relative;height:16px;background:#000a;border:1px solid #0009;border-radius:8px;overflow:hidden;margin:4px 0}
.bar>i{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,#3e9e48,var(--good));transition:width .8s ease,background .4s}
.bar.mid>i{background:linear-gradient(90deg,#b0882a,var(--warn))}.bar.low>i{background:linear-gradient(90deg,#9e2f24,var(--bad))}
.bar>b{position:absolute;inset:0;text-align:center;font:700 .74rem/16px ui-monospace,monospace}
.bar.boss{height:24px}.bar.boss>b{line-height:24px;font-size:.85rem}
.hit{animation:hit .6s ease}
.row{display:flex;justify-content:space-between;gap:14px;padding:2px 0}.row span:last-child{color:var(--gold);white-space:nowrap}
ol{margin:0;padding-left:1.4em}ol li{padding:1px 0}
.fighter{margin:6px 0}.fighter .name{font-size:.92rem}
.fighter.turn .name::before{content:"▶ ";color:var(--gold)}.fighter.down{opacity:.45}.fighter.down .name::after{content:" 💀"}
.recent .row{align-items:baseline}.recent .row>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.recent .win{color:var(--good)}.recent .loss{color:var(--bad)}.recent .retreat{color:var(--warn)}.recent .note{color:var(--muted);font-size:.82rem}
.side+.side{margin-top:8px;padding-top:6px;border-top:1px dashed #68463299}.side>.label{color:var(--gold);font-size:.82rem;text-transform:uppercase;letter-spacing:.08em}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.strip{display:flex;gap:10px;align-items:center;flex-wrap:nowrap;background:var(--card);border:1px solid var(--edge);border-radius:999px;padding:8px 16px;width:max-content;max-width:100%;overflow:hidden;white-space:nowrap;box-shadow:0 6px 18px #0007}
.chip{display:inline-flex;gap:6px;align-items:center;font-size:.98rem}.chip+.chip{border-left:1px solid #68463299;padding-left:10px}
.next .step{display:inline-flex;gap:0;align-items:baseline;max-width:620px;overflow:hidden;text-overflow:ellipsis;transition:opacity .4s}.next .step.swap{opacity:0}
.next code{color:var(--gold);font:600 .95rem ui-monospace,monospace}.next .why{margin-left:.35em;color:var(--muted);overflow:hidden;text-overflow:ellipsis}
.dot{width:10px;height:10px;border-radius:50%;background:#777}.dot.live{background:#e91916;box-shadow:0 0 8px #e91916;animation:pulse 1.6s infinite}
.mini{display:inline-block;width:90px;height:9px;background:#000a;border-radius:5px;overflow:hidden;vertical-align:middle}.mini>i{display:block;height:100%;background:var(--bad);transition:width .8s}
.bump{animation:bump .7s ease}
.fade{animation:in .6s ease}
/* &side=right — hang from the right: anchored to the right edge and mirrored inside. */
body.mirror #root{margin-left:auto;transform-origin:top right;align-items:flex-end}
body.mirror.center #root{margin:0 auto;transform-origin:top center;align-items:center}
body.mirror .card{text-align:right}
body.mirror .card h2,body.mirror .row,body.mirror .chip{flex-direction:row-reverse}
body.mirror .bar>i{inset:0 0 0 auto;background:linear-gradient(270deg,#3e9e48,var(--good))}
body.mirror .bar.mid>i{background:linear-gradient(270deg,#b0882a,var(--warn))}body.mirror .bar.low>i{background:linear-gradient(270deg,#9e2f24,var(--bad))}
body.mirror ol{list-style:none;padding:0;counter-reset:n}body.mirror ol li{counter-increment:n;display:flex;flex-direction:row-reverse;align-items:baseline;gap:6px}
body.mirror ol li::before{content:counter(n) ".";color:var(--muted)}body.mirror ol li>.row{flex:1}
body.mirror .fighter.turn .name::before{content:none}body.mirror .fighter.turn .name::after{content:" ◀";color:var(--gold)}
body.mirror .fighter.down .name::after{content:none}body.mirror .fighter.down .name::before{content:"💀 "}
body.mirror .cols{direction:rtl}body.mirror .cols>*{direction:ltr}
body.mirror .strip{flex-direction:row-reverse;margin-left:auto}
body.mirror .chip+.chip{border-left:0;padding-left:0;border-right:1px solid #68463299;padding-right:10px}
body.mirror .mini>i{margin-left:auto}
/* &from=bottom — feed from the bottom up: anchored to the bottom edge, first panel lowest, later ones stack above it. */
body.bottom{height:100vh;display:flex;flex-direction:column;justify-content:flex-end}
body.bottom #root{flex-direction:column-reverse;transform-origin:bottom left}
body.bottom.right #root,body.bottom.mirror #root{transform-origin:bottom right}
body.bottom.center #root,body.bottom.mirror.center #root{transform-origin:bottom center}
@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes hit{0%,100%{filter:none}30%{filter:brightness(2) saturate(2) hue-rotate(-30deg)}}
@keyframes bump{0%,100%{transform:scale(1)}40%{transform:scale(1.18)}}
@keyframes pulse{50%{opacity:.4}}
`;

// The overlay client. Kept as plain ES2017 in a string so no build step is needed.
const CLIENT = `
const Q=new URLSearchParams(location.search);
const CFG=window.__OVERLAY__;
const panel=CFG.panel;
const num=(k,d,lo,hi)=>{const v=Number(Q.get(k));return Number.isFinite(v)&&v>0?Math.min(hi,Math.max(lo,v)):d};
const refresh=num("refresh",5,3,60)*1000, cycle=num("cycle",12,4,120)*1000, scale=num("scale",1,0.3,4);
const always=Q.get("always")==="1";
const align=Q.get("align"); if(align==="right"||align==="center")document.body.classList.add(align);
if(Q.get("side")==="right")document.body.classList.add("mirror"); // hang from the right, mirrored
if(Q.get("from")==="bottom")document.body.classList.add("bottom"); // feed from the bottom up
const root=document.getElementById("root"); root.style.transform="scale("+scale+")";
const dataUrl="/overlay/data?channel="+encodeURIComponent(CFG.channel)+"&panels="+encodeURIComponent(panel)
  +(Q.get("window")?"&window="+encodeURIComponent(Q.get("window")):"")+(Q.get("limit")?"&limit="+encodeURIComponent(Q.get("limit")):"");

function h(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e}
function add(p,...kids){for(const k of kids)if(k)p.appendChild(k);return p}
function card(title,sub){const c=h("div","card");const t=h("h2",null,title);if(sub)t.appendChild(h("small",null,sub));return add(c,t)}
function bar(hp,max,cls,key){const pct=max>0?Math.max(0,Math.min(100,hp/max*100)):0;
  const b=h("div","bar"+(cls?" "+cls:"")+(pct<=25?" low":pct<=55?" mid":""));const f=h("i");
  const prev=key!=null?lastHp[key]:undefined; f.style.width=(prev!=null&&max>0?Math.max(0,Math.min(100,prev/max*100)):pct)+"%";
  requestAnimationFrame(()=>requestAnimationFrame(()=>{f.style.width=pct+"%"}));
  if(key!=null){if(prev!=null&&hp<prev)b.classList.add("hit");lastHp[key]=hp}
  return add(b,f,h("b",null,hp+" / "+max))}
const lastHp={}; let lastJar=null, lastShots=null;
function ago(ms){const m=Math.round((Date.now()-ms)/60000);return m<1?"just now":m<60?m+"m ago":Math.round(m/60)+"h ago"}
function placeholder(label){return card(label,"nothing to show yet")}

const R={
  raid(d){const r=d.raid;if(!r)return null;
    const c=card("☠️ "+r.monster,"CR "+r.cr+" · AC "+r.ac+(r.raids?" · "+r.raids+" raid"+(r.raids===1?"":"s"):""));
    add(c,bar(r.hp,r.hpMax,"boss","raid"),h("div","muted",r.state));
    if(r.contributors&&r.contributors.length){const ol=h("ol");for(const x of r.contributors.slice(0,3))add(ol,add(h("li"),add(h("div","row"),h("span",null,x.name),h("span",null,x.damage+" dmg"))));add(c,h("div","hint","Top raiders"),ol)}
    if(r.slain)c.querySelector("h2").firstChild.textContent="🏆 "+r.monster+" — slain!";
    return c},
  battle(d){const fs=d.battle||[],rec=d.recent||[],boss=panel==="battle"?d.raid:null;if(!fs.length&&!rec.length&&!boss)return null;const wrap=document.createDocumentFragment();
    for(const f of fs){const c=card(f.title);
      for(const s of f.sides){const sd=add(h("div","side"),h("div","label",s.label));
        for(const m of s.combatants){const fe=h("div","fighter"+(m.turn?" turn":"")+(m.down?" down":""));
          add(fe,add(h("div","name"),h("span",null,m.name)),bar(m.hp,m.hpMax,null,f.kind+":"+m.name));add(sd,fe)}
        add(c,sd)}
      add(wrap,c)}
    if(boss)add(wrap,R.raid(d)); // the raid boss summary, on the standalone tracker only (the all/rotate views have their own raid panel)
    if(rec.length)add(wrap,recentCard(rec,fs.length||boss?3:5));
    const holder=h("div","group");holder.style.display="contents";add(holder,wrap);return holder},
  giveaway(d){const g=d.giveaway;if(!g)return null;
    const c=card("🎁 "+(g.open?"Giveaway":"Giveaway drawn"),g.open?(g.cost==="free"?"free entry":g.cost+" / ticket"):null);
    add(c,h("div","big",g.prize));
    if(g.open)add(c,h("div","muted",g.entrants+" entrant"+(g.entrants===1?"":"s")+" · "+g.tickets+" ticket"+(g.tickets===1?"":"s")),h("div","hint",g.cost==="free"?"!giveaway enter":"!giveaway enter [tickets] — max "+g.maxTickets));
    else add(c,h("div",null,g.winners.length?"🏆 "+g.winners.join(", "):"No winner drawn"));
    return c},
  merchant(d){const m=d.merchant;if(!m)return null;
    const c=card("🛒 "+(m.merchant||"The peddler"),ago(m.postedAt));
    return add(c,h("div","big",m.item),h("div",null,m.price),h("div","hint","!haggle <your pitch> · !stall"))},
  jar(d){const j=d.jar;if(!j)return null;const c=card("🫙 Swear jar");const v=h("div","big",j.text);
    if(lastJar!=null&&j.total>lastJar)v.classList.add("bump");lastJar=j.total;return add(c,v)},
  shots(d){const s=d.shots;if(!s)return null;const c=card("🥃 "+s.many.charAt(0).toUpperCase()+s.many.slice(1)+" taken");const v=h("div","big shots",s.count);
    if(lastShots!=null&&s.count>lastShots)v.classList.add("bump");lastShots=s.count;return add(c,v)},
  gold(d){const g=d.gold;if(!g||!g.length)return null;const c=card("💰 Richest adventurers");const ol=h("ol");
    for(const x of g)add(ol,add(h("li"),add(h("div","row"),h("span",null,x.name),h("span",null,x.text))));return add(c,ol)},
  dice(d){const x=d.dice;if(!x||(!x.nat20.length&&!x.nat1.length))return null;
    const c=card("🎲 Roll call","this "+x.window);const cols=h("div","cols");
    const col=(title,rows)=>{const w=add(h("div"),h("div","hint",title));const ol=h("ol");
      for(const r of rows)add(ol,add(h("li"),add(h("div","row"),h("span",null,r.name),h("span",null,"×"+r.count))));
      if(!rows.length)add(w,h("div","muted","none yet"));else add(w,ol);return w};
    add(cols,col("Natural 20s",x.nat20),col("Natural 1s",x.nat1));return add(c,cols)},
  guild(d){const g=d.guild;if(!g||!g.characters)return null;
    const c=card("📜 "+d.channel.name+"'s guild",g.characters+" adventurer"+(g.characters===1?"":"s")+" · "+g.parties+" part"+(g.parties===1?"y":"ies"));
    const ol=h("ol");for(const x of g.top)add(ol,add(h("li"),add(h("div","row"),h("span",null,x.name+" — "+x.race+" "+x.cls),h("span",null,"Lv "+x.level))));
    return add(c,ol)},
  status(d){const s=h("div","strip");
    add(s,add(h("span","chip"),h("i","dot"+(d.channel.live?" live":"")),h("b",null,d.channel.name)));
    if(showNext){nextList=nextSteps(d);const nx=add(h("span","chip next"),h("b",null,"👉 Next:"));nextEl=add(h("span","step"));fillNext();add(s,add(nx,nextEl))}
    if(d.raid){const mini=h("span","mini");const f=h("i");f.style.width=(d.raid.hpMax?Math.round(d.raid.hp/d.raid.hpMax*100):0)+"%";add(mini,f);
      add(s,add(h("span","chip"),h("span",null,(d.raid.slain?"🏆 ":"☠️ ")+d.raid.monster),d.raid.slain?h("span","muted","slain"):mini))}
    for(const f of d.battle||[]){const names=f.sides.map(x=>x.label).join(" vs ");add(s,add(h("span","chip"),h("span",null,f.title.split(" ")[0]+" "+names)))}
    if(d.giveaway)add(s,add(h("span","chip"),h("span",null,"🎁 "+d.giveaway.prize+(d.giveaway.open?" · "+d.giveaway.entrants+" in":" · won by "+(d.giveaway.winners.join(", ")||"—")))));
    if(d.merchant)add(s,add(h("span","chip"),h("span",null,"🛒 "+d.merchant.item+" — "+d.merchant.price)));
    if(d.jar){const v=h("span",null,"🫙 "+d.jar.text);if(lastJar!=null&&d.jar.total>lastJar)v.classList.add("bump");lastJar=d.jar.total;add(s,add(h("span","chip"),v))}
    return s},
};
// "Recent battles": finished fights (battle_log.ts), newest first, with a win/loss tally.
const KIND_ICON={hunt:"🐉",partyhunt:"🏹",autohunt:"⏳",raid:"☠️",duel:"⚔️",partyduel:"🛡️",rob:"🗡️"};
function ago(at){const m=Math.max(0,Math.floor((Date.now()-at)/60000));return m<1?"just now":m+"m ago"}
function recentCard(rec,max){
  const pvp=r=>r.kind==="duel"||r.kind==="partyduel"||r.kind==="rob";
  const pve=rec.filter(r=>!pvp(r)),wins=pve.filter(r=>r.outcome==="win").length,losses=pve.filter(r=>r.outcome==="loss").length;
  const c=card("📜 Recent battles",pve.length?"🏆 "+wins+" won · ☠️ "+losses+" lost":null);const list=h("div","recent");
  for(const r of rec.slice(0,max)){
    const line=pvp(r)?r.side+" beats "+r.foe
      :r.outcome==="win"?r.side+" slew "+r.foe:r.outcome==="loss"?r.foe+" felled "+r.side:r.side+" fell back from "+r.foe;
    const what=h("span",null,(KIND_ICON[r.kind]||"⚔️")+" ");add(what,h("b",pvp(r)?"win":r.outcome,line));
    if(r.note)add(what,h("span","note"," · "+r.note));
    add(list,add(h("div","row"),what,h("span",null,ago(r.at))))}
  return add(c,list)}
// The status strip's suggested next steps (&next=1): what a viewer could type
// right now — whatever's happening first, then a few ways in — one at a time.
const showNext=Q.get("next")==="1";let nextList=[],nextIdx=0,nextEl=null;
function nextSteps(d){const s=[];
  if(d.raid&&!d.raid.slain){if(/^Muster open/.test(d.raid.state))s.push(["!rally","join the raid on "+d.raid.monster]);
    else if(/^Ready/.test(d.raid.state))s.push(["!rally","sound the war horn vs "+d.raid.monster])}
  const TURN={duel:"!dndduel attack",hunt:"!dndduel monster attack",partyduel:"!dndduel party attack",partyhunt:"!party hunt attack"};
  for(const f of d.battle||[]){const who=f.sides.flatMap(x=>x.combatants).find(m=>m.turn);
    if(TURN[f.kind])s.push([TURN[f.kind],who?who.name+"'s turn":"take your turn"])}
  if(d.giveaway&&d.giveaway.open)s.push(["!giveaway enter","win "+d.giveaway.prize]);
  if(d.merchant)s.push(["!haggle <offer>","bargain for "+d.merchant.item]);
  const ways=[["!start","new here? the 5-step guide"],["!createchar","make your hero"],["!dndduel","hunt a monster for XP + loot"],
    ["!party create <name>","adventure with friends"],["!autohunt 30m","send your hero hunting"],["!d20","test fate"]];
  return s.length?s.concat(ways.slice(0,2)):ways}
function fillNext(){if(!nextEl||!nextList.length)return;const [cmd,why]=nextList[nextIdx%nextList.length];
  nextEl.replaceChildren(h("code",null,cmd),h("span","why","— "+why))}
if(showNext)setInterval(()=>{if(!nextEl||!nextEl.isConnected||nextList.length<2)return;nextEl.classList.add("swap");
  setTimeout(()=>{nextIdx=(nextIdx+1)%nextList.length;fillNext();nextEl.classList.remove("swap")},400)},8000);
const ORDER=["raid","battle","giveaway","merchant","jar","gold","dice","guild"];
const LABELS=CFG.labels;
// Cheap "does this panel have anything to show" check (no DOM, no side effects).
const HAS={raid:d=>!!d.raid,battle:d=>!!((d.battle&&d.battle.length)||(d.recent&&d.recent.length)||(panel==="battle"&&d.raid)),giveaway:d=>!!d.giveaway,merchant:d=>!!d.merchant,jar:d=>!!d.jar,shots:d=>!!d.shots,
  gold:d=>!!(d.gold&&d.gold.length),dice:d=>!!(d.dice&&(d.dice.nat20.length||d.dice.nat1.length)),guild:d=>!!(d.guild&&d.guild.characters)};
let rotIdx=-1, rotAt=0, lastSig="", prevShown=new Set();

function render(d){
  // Which panels to draw this frame.
  let list;
  if(panel==="all")list=ORDER.filter(p=>HAS[p](d));
  else if(panel==="rotate"){const live=ORDER.filter(p=>HAS[p](d));
    if(live.length&&(rotIdx<0||Date.now()-rotAt>=cycle)){rotIdx=(rotIdx+1)%live.length;rotAt=Date.now()}
    list=live.length?[live[rotIdx%live.length]]:[]}
  else list=panel==="status"||HAS[panel](d)?[panel]:[];
  // Redraw only when something on screen would change (plus once a minute for "x minutes ago").
  const sig=JSON.stringify([list,list.map(p=>p==="status"?[d.channel,d.raid,d.battle,d.giveaway,d.merchant,d.jar]:p==="battle"?[d.battle,d.recent,d.raid]:d[p]),Math.floor(Date.now()/60000)]);
  if(sig===lastSig)return;lastSig=sig;
  root.replaceChildren();
  const shown=new Set();
  for(const p of list){const n=R[p](d);if(!n)continue;shown.add(p);
    if(!prevShown.has(p))(n.classList.contains("group")?[...n.children]:[n]).forEach(x=>x.classList.add("fade"));
    add(root,n)}
  if(!shown.size&&always)add(root,placeholder(panel==="all"||panel==="rotate"?"GuildScribe":(LABELS[panel]||panel)));
  prevShown=shown;
}

let latest=null;
// OBS keeps browser sources running in scenes that aren't showing; it tells
// the page through these events, so don't poll while nobody can see it.
let obsActive=true,obsVisible=true;
addEventListener("obsSourceActiveChanged",e=>{obsActive=!!(e.detail&&e.detail.active);if(obsActive)tick()});
addEventListener("obsSourceVisibleChanged",e=>{obsVisible=!!(e.detail&&e.detail.visible);if(obsVisible)tick()});
async function tick(){
  if(!obsActive&&!obsVisible)return;
  try{const r=await fetch(dataUrl,{cache:"no-store"});const d=await r.json();if(d&&d.ok){latest=d;render(d)}}catch(e){/* keep the last frame on a network blip */}
}
tick();setInterval(tick,refresh);
if(panel==="rotate")setInterval(()=>{if(latest)render(latest)},1000);
`;

/** One panel overlay; look (overlay_style.ts) recolours it and sets its fonts for a link's look extras. */
export function renderOverlayPage(channelKey: string, panel: string, look: { css: string; fontHref: string } = { css: "", fontHref: "" }): string {
  const cfg = {
    channel: channelKey,
    panel,
    labels: Object.fromEntries(Object.entries(OVERLAY_PANELS).map(([k, v]) => [k, v.label])),
  };
  // JSON inside <script>: escape "<" so a value can never close the tag.
  const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GuildScribe overlay · ${escapeHtml(panel)}</title>${look.fontHref ? `<link rel="stylesheet" href="${escapeHtml(look.fontHref)}">` : ""}<style>${STYLE}${look.css}</style></head><body><div id="root"></div><script>window.__OVERLAY__=${cfgJson};${CLIENT}</script></body></html>`;
}

// The theme card's link builder: emblem (d20, your image, or a PNGtuber pair), its size, and the mic.
const THEME_BUILDER = `<div class="tb">
<label class="tb-wide">Scene <select class="tb-scene">${Object.entries(SCENES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select></label>
<div class="tb-wide tb-where"></div>
<label>Emblem <select class="tb-mode"><option value="d20">GuildScribe d20</option><option value="d20name">GuildScribe d20 with name banner</option><option value="image">My own image</option><option value="png">PNGtuber (idle + talking images)</option></select></label>
<label class="tb-img" hidden>Image URL <input type="url" class="tb-idle" placeholder="https://…/emblem.png"></label>
<label class="tb-png" hidden>Talking image URL <input type="url" class="tb-talk" placeholder="https://…/talking.png"></label>
<label class="tb-wide"><input type="checkbox" class="tb-music"> Now playing — the song you're playing (Spotify, Apple Music or YouTube, set up on the dashboard's 🎵 Now playing page), top-left in Gameplay, under the Battle Tracker in Be right back, above the emblem in Just chatting</label>
<label>Size <input type="number" class="tb-size" min="80" max="520" step="10" placeholder="auto"> px</label>
<div class="tb-wide tb-row">Mic <select class="mic-pick"><option value="">Default microphone</option><option value="off">Off (no mic reaction)</option></select><button type="button" class="ghost mic-list">List my microphones</button></div>
<p class="muted tb-wide">Images need a public link ending in .png, .gif or .webp (a Discord or Imgur image link works). Quiet = dimmer, talking = brighter; a PNGtuber also swaps to the talking image and bobs.</p></div>`;

// The look builder (overlay_style.ts): a preset, colours and images, applied to every link on the page.
const LOOK_COLOURS: Array<[string, string]> = [["paper", "Sheet"], ["ink", "Text"], ["heading", "Name & headings"], ["accent", "Accent & trims"], ["seal", "Live gem & banner"], ["disc", "d20 disc"], ["card", "Panel cards"]];
const fontOptions = (list: Record<string, LookFont>) => Object.entries(list).map(([k, f]) => `<option value="${k}">${escapeHtml(f.label)}</option>`).join("");
const LOOK_BUILDER = `<div class="note look"><strong>🎨 Look — colours, fonts &amp; images</strong>
<p>Make the overlays your own: pick a preset, change any colour or font, or give the theme's sheet your own image. Every link below picks it up (the theme takes all of it; the panels take the preset, accent, card colour/image and fonts). Share your <em>look code</em> with another streamer, or paste theirs to start from it.</p>
<div class="tb lk">
<label class="tb-wide">Preset <select class="lk-preset">${Object.entries(LOOK_PRESETS).map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`).join("")}</select></label>
${LOOK_COLOURS.map(([k, label]) => `<label class="lk-c"><input type="color" data-k="${k}"> ${label} <button type="button" class="ghost lk-reset" data-k="${k}" hidden title="Back to the preset's colour">↺</button></label>`).join("")}
<label class="tb-wide">Sheet image <input type="url" class="lk-bg" placeholder="https://…/texture.png — replaces the parchment (theme only)"></label>
<label>Image fit <select class="lk-bgfit"><option value="">Cover the sheet</option><option value="tile">Tile (repeat)</option></select></label>
<label><input type="checkbox" class="lk-rollers" checked> Scroll rollers top and bottom</label>
<label>Heading font <select class="lk-font">${fontOptions(HEADING_FONTS)}</select></label>
<label>Text font <select class="lk-bodyfont">${fontOptions(BODY_FONTS)}</select></label>
<div class="tb-wide lk-sample"><b>Tavern Talk · Be Right Back</b><span>The party is taking a short rest. <i>Rolling initiative against the kettle.</i></span></div>
<label class="tb-wide">Panel card image <input type="url" class="lk-cardimg" placeholder="https://…/card.png — behind the panels' cards, tinted by the card colour"></label>
<div class="tb-wide tb-row">Look code <input class="lk-code" spellcheck="false" placeholder="paste a look code or an overlay link…"><button type="button" class="lk-apply">Apply</button><button type="button" class="lk-copy" data-copy="">Copy</button></div>
<p class="muted tb-wide">Images need a public https link (.png, .jpg, .gif or .webp). Your emblem or PNGtuber is picked on the Full stream theme below. With nothing changed you get the classic parchment.</p>
</div></div>`;

/** The setup page: every overlay's URL, its suggested size and a live preview. */
export function renderOverlayIndexPage(channelName: string, channelKey: string, channelId: string, baseUrl: string): string {
  const base = `${baseUrl}/overlay?channel=${encodeURIComponent(channelKey)}`;
  const cards = Object.entries(OVERLAY_PANELS).map(([key, p]) => {
    const link = `${base}&panel=${key}`;
    // The full theme scales itself to fit, so its preview is just a 16:9 box.
    const full = key === "theme";
    const previewH = full ? 0 : Math.min(p.height, 360);
    // The idle game fills its frame like the theme: a 16:9 preview, no edge options.
    const wide = full || key === "idle" || key === "sounds" || key === "alerts";
    const opts = full ? THEME_BUILDER : key === "idle" || key === "sounds" || key === "alerts" ? "" : `<label class="side-opt"><input type="checkbox" class="side-right"> Hang from the right <span class="muted">(mirrored — anchored to the right edge, bars drain to the right)</span></label><label class="side-opt"><input type="checkbox" class="from-bottom"> Feed from the bottom up <span class="muted">(anchored to the bottom edge — new panels stack upward)</span></label>`;
    // Every card starts minimized (title and size only); click the title to open it.
    // The panels drawn from /overlay/data take the look's panel colours; the theme takes all of it.
    const look = full ? "theme" : key === "idle" || key === "sounds" || key === "music" || key === "alerts" ? "" : "panel";
    return `<details class="ov${full ? " full" : ""}" data-link="${escapeHtml(link)}"${look ? ` data-look="${look}"` : ""}><summary class="head"><h2>${escapeHtml(p.label)}</h2><span class="size">${p.width} × ${p.height}</span></summary><p>${escapeHtml(p.blurb)}</p>${opts}<div class="url"><code>${escapeHtml(link)}</code><button type="button" data-copy="${escapeHtml(link)}">Copy</button></div><div class="preview" style="${wide ? "aspect-ratio:16/9" : `height:${previewH}px`}"><iframe loading="lazy" src="${escapeHtml(link)}&always=1" title="${escapeHtml(p.label)} preview"></iframe></div></details>`;
  }).join("");
  return scrollDoc(`OBS Overlays · ${escapeHtml(channelName)}`, `
<span class="pill">Stream overlays</span><h1>OBS overlays</h1><p class="intro">${escapeHtml(channelName)} · live GuildScribe panels for your stream</p>
<div class="note"><strong>Adding one to OBS</strong><ol><li>In OBS, add a <strong>Browser</strong> source to your scene.</li><li>Open an overlay below (click its name), paste its URL and set the width/height shown next to it.</li><li>Leave the background transparent (OBS's default custom CSS is fine). Panels refresh on their own every few seconds.</li></ol>
<p style="margin-top:10px">Optional URL extras: <code>&amp;scale=1.5</code> (bigger/smaller), <code>&amp;side=right</code> (hang from the right — mirrored; the checkbox on each overlay adds it), <code>&amp;from=bottom</code> (feed from the bottom up — anchored to the bottom edge, panels stack upward; the checkbox on each overlay adds it), <code>&amp;align=right</code> or <code>center</code> (just move the column), <code>&amp;refresh=10</code> (seconds between updates), <code>&amp;limit=3</code> (rows in leaderboards), <code>&amp;always=1</code> (show a placeholder while a panel is empty, handy for positioning), and the look extras the 🎨 Look box writes for you (<code>&amp;preset=</code>, <code>&amp;accent=</code>, <code>&amp;card=</code>, <code>&amp;cardimg=</code>, <code>&amp;font=</code>, <code>&amp;bodyfont=</code>; the theme also takes <code>&amp;paper=</code>, <code>&amp;ink=</code>, <code>&amp;heading=</code>, <code>&amp;seal=</code>, <code>&amp;disc=</code>, <code>&amp;bg=</code>, <code>&amp;bgfit=tile</code>, <code>&amp;rollers=0</code>). Panels for features you've switched off on your dashboard stay hidden.</p></div>
${LOOK_BUILDER}<div class="grid">${cards}</div>
<div class="note"><strong>🗣️ Chat Reader (console streaming)</strong><p>Reads chat out loud on your own phone or PC — open it there and tap Start, not in OBS (it would read chat to your viewers too). Turn on "Chat Reader" on the dashboard first. <a href="${escapeHtml(base)}&amp;panel=reader">${escapeHtml(base)}&amp;panel=reader</a></p></div>
<p class="colophon"><a href="${escapeHtml(baseUrl)}/roster?channel=${encodeURIComponent(channelId)}">Guild roster</a> · <a href="${escapeHtml(baseUrl)}/guide">Guild Codex</a></p>
<script>// Theme card: list this computer's microphones and put the chosen one's name into the link (&mic=).
document.addEventListener("click",async(e)=>{const b=e.target.closest("button.mic-list");if(!b)return;const sel=b.parentElement.querySelector("select");
  try{const s=await navigator.mediaDevices.getUserMedia({audio:true});s.getTracks().forEach(t=>t.stop());
    const mics=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="audioinput"&&d.label&&d.deviceId!=="default"&&d.deviceId!=="communications");
    for(const o of [...sel.options].slice(2))o.remove();for(const m of mics){const o=document.createElement("option");o.value=m.label.replace(/\\s*\\([0-9a-f]{4}:[0-9a-f]{4}\\)$/i,"");o.textContent=m.label;sel.append(o)}
    b.textContent=mics.length?"Pick one above":"No microphones found"}catch(_){b.textContent="Mic permission denied"}});
// Where each OBS source goes for the chosen scene (windows under the theme, the Dungeon Gate over it).
const SCENES=${JSON.stringify(Object.fromEntries(Object.entries(SCENES).map(([k, v]) => [k, { windows: v.windows, gate: v.gate ?? null }])))};
const at=(r)=>"X "+r.x+", Y "+r.y+", "+r.w+" × "+r.h;
function themeWhere(ov,scene){const sc=SCENES[scene]||SCENES.game;const w=ov.querySelector(".tb-where");w.replaceChildren();
  const li=(t,b,rest)=>{const e=document.createElement("li");const s=document.createElement("strong");s.textContent=b;e.append(t,s,rest);return e};
  const ul=document.createElement("ul");for(const x of sc.windows)ul.append(x.idle?li("Drawn by the theme — ","The Endless Delve (idle game): ",at(x)+" — nothing to add; put &idle=0 on the link to use this window for "+x.label+" instead"):li("Under the theme — ",x.label+": ",at(x)));
  if(sc.gate)ul.append(li("Over the theme — ","Tangia / pop-up overlays (Dungeon Gate): ",at(sc.gate)));
  const head=document.createElement("span");head.textContent="Place your OBS sources (1920 × 1080 canvas):";w.append(head,ul)}
function themeLink(ov){const q=(c)=>ov.querySelector(c);const mode=q(".tb-mode").value;let link=ov.dataset.link;
  const scene=q(".tb-scene").value;if(scene!=="game")link+="&scene="+scene;themeWhere(ov,scene);
  q(".tb-img").hidden=mode.startsWith("d20");q(".tb-png").hidden=mode!=="png";
  const idle=q(".tb-idle").value.trim(),talk=q(".tb-talk").value.trim(),size=q(".tb-size").value.trim(),mic=q(".mic-pick").value;
  if(!mode.startsWith("d20")&&idle)link+="&emblem="+encodeURIComponent(idle);if(mode==="d20name")link+="&ribbon=1";if(mode==="png"&&idle&&talk)link+="&talk="+encodeURIComponent(talk);
  if(size)link+="&size="+encodeURIComponent(size);if(q(".tb-music").checked)link+="&music=1";link+=lookQuery("theme");const view=link;if(mic)link+="&mic="+encodeURIComponent(mic);
  q(".url code").textContent=link;q("button[data-copy]").dataset.copy=link;
  const fr=q("iframe");const want=view+"&always=1";if(fr.dataset.src!==want&&fr.getAttribute("src")!==want){fr.dataset.src=want;fr.src=want}}
let tbTimer;document.addEventListener("input",(e)=>{const ov=e.target.closest(".ov.full");if(!ov)return;clearTimeout(tbTimer);tbTimer=setTimeout(()=>themeLink(ov),400)});
document.addEventListener("change",(e)=>{const ov=e.target.closest(".ov.full");if(ov)themeLink(ov)});
document.querySelectorAll(".ov.full").forEach((ov)=>themeWhere(ov,"game"));
// A panel's link: its edge options plus the look's panel colours.
function panelLink(ov){const side=ov.querySelector("input.side-right"),bottom=ov.querySelector("input.from-bottom");
  const link=ov.dataset.link+(side&&side.checked?"&side=right":"")+(bottom&&bottom.checked?"&from=bottom":"")+lookQuery("panel");
  ov.querySelector(".url code").textContent=link;ov.querySelector("button[data-copy]").dataset.copy=link;
  const fr=ov.querySelector("iframe"),want=link+"&always=1";if(fr.dataset.src!==want&&fr.getAttribute("src")!==want){fr.dataset.src=want;fr.src=want}}
document.addEventListener("change",(e)=>{const cb=e.target.closest("input.side-right,input.from-bottom");if(cb)panelLink(cb.closest(".ov"))});
// ── The look builder: a preset, the colours changed from it, and images. ──
const PRESETS=${LOOK_PRESETS_JSON},DEFAULT_PRESET=${JSON.stringify(DEFAULT_PRESET)};
const THEME_ONLY=["paper","ink","heading","seal","disc","bg","bgfit","rollers"],ORDER=["preset","paper","ink","heading","accent","seal","disc","bg","bgfit","rollers","card","cardimg","font","bodyfont"];
// Fonts default to the preset's own; the link only carries one that differs.
const FONTS=${LOOK_FONTS_JSON},presetFont=(k)=>(PRESETS[look.preset]||PRESETS[DEFAULT_PRESET])[k];
// The sample line shows the picked fonts, each loaded only once it's picked.
const fontLinks=new Set();function showFonts(){const s=lq(".lk-sample"),hf=FONTS.heading[lq(".lk-font").value],bf=FONTS.body[lq(".lk-bodyfont").value];
  for(const f of [hf,bf])if(!fontLinks.has(f.href)){fontLinks.add(f.href);const l=document.createElement("link");l.rel="stylesheet";l.href=f.href;document.head.append(l)}
  s.querySelector("b").style.fontFamily=hf.stack;s.querySelector("span").style.fontFamily=bf.stack}
const lk=document.querySelector(".look"),lq=(c)=>lk.querySelector(c);
let look={preset:DEFAULT_PRESET,colors:{}};
const goodUrl=(v)=>{try{const u=new URL(v.trim());return u.protocol==="https:"||u.protocol==="http:"?u.href:""}catch(_){return ""}};
function lookParams(){const p={};if(look.preset!==DEFAULT_PRESET)p.preset=look.preset;
  for(const k in look.colors)p[k]=look.colors[k].replace("#","");
  const bg=goodUrl(lq(".lk-bg").value),ci=goodUrl(lq(".lk-cardimg").value);
  if(bg){p.bg=bg;if(lq(".lk-bgfit").value==="tile")p.bgfit="tile"}
  if(!lq(".lk-rollers").checked)p.rollers="0";if(ci)p.cardimg=ci;
  for(const k of ["font","bodyfont"]){const v=lq(".lk-"+k).value;if(v!==presetFont(k))p[k]=v}return p}
// The look as link extras: everything for the theme, the preset / accent / card for a panel.
function lookQuery(kind){const p=lookParams();return ORDER.filter(k=>k in p&&(kind==="theme"||!THEME_ONLY.includes(k))).map(k=>"&"+k+"="+encodeURIComponent(p[k])).join("")}
function showLook(){const pr=PRESETS[look.preset]||PRESETS[DEFAULT_PRESET];lq(".lk-preset").value=look.preset;
  for(const i of lk.querySelectorAll("input[type=color]")){const k=i.dataset.k;i.value=look.colors[k]||pr[k];lk.querySelector(".lk-reset[data-k="+k+"]").hidden=!look.colors[k]}}
function lookChanged(){const code=lookQuery("theme").slice(1);lq(".lk-code").value=code;lq(".lk-copy").dataset.copy=code;
  document.querySelectorAll(".ov[data-look]").forEach(ov=>ov.dataset.look==="theme"?themeLink(ov):panelLink(ov))}
let lkTimer;const lookSoon=()=>{clearTimeout(lkTimer);lkTimer=setTimeout(lookChanged,400)};
lk.addEventListener("input",(e)=>{const t=e.target;
  if(t.type==="color"){const pr=PRESETS[look.preset];if(t.value.toLowerCase()===pr[t.dataset.k])delete look.colors[t.dataset.k];else look.colors[t.dataset.k]=t.value.toLowerCase();showLook();lookSoon()}
  else if(t.matches(".lk-bg,.lk-cardimg"))lookSoon()});
lk.addEventListener("change",(e)=>{const t=e.target;
  if(t.matches(".lk-preset")){look={preset:t.value,colors:{}};lq(".lk-font").value=presetFont("font");lq(".lk-bodyfont").value=presetFont("bodyfont");showLook();showFonts();lookChanged()}
  else if(t.matches(".lk-font,.lk-bodyfont")){showFonts();lookChanged()}
  else if(t.matches(".lk-bgfit,.lk-rollers,.lk-bg,.lk-cardimg"))lookChanged()});
lk.addEventListener("click",(e)=>{const r=e.target.closest(".lk-reset");if(r){delete look.colors[r.dataset.k];showLook();lookChanged();return}
  if(!e.target.closest(".lk-apply"))return;
  // A look code ("preset=moonlit&accent=ffcc00") or a whole overlay link: take its look extras.
  let v=lq(".lk-code").value.trim();const qi=v.indexOf("?");if(qi>=0)v=v.slice(qi+1);const q=new URLSearchParams(v.replace(/^&/,""));
  const preset=(q.get("preset")||"").toLowerCase();look={preset:PRESETS[preset]?preset:DEFAULT_PRESET,colors:{}};
  for(const k of ["paper","ink","heading","accent","seal","disc","card"]){const c=(q.get(k)||"").trim().replace(/^#/,"").toLowerCase();
    const hex=/^[0-9a-f]{6}$/.test(c)?"#"+c:/^[0-9a-f]{3}$/.test(c)?"#"+[...c].map(x=>x+x).join(""):/^[0-9a-f]{8}$/.test(c)?"#"+c.slice(0,6):"";
    if(hex&&hex!==PRESETS[look.preset][k])look.colors[k]=hex}
  lq(".lk-bg").value=q.get("bg")||"";lq(".lk-bgfit").value=q.get("bgfit")==="tile"?"tile":"";lq(".lk-rollers").checked=q.get("rollers")!=="0";lq(".lk-cardimg").value=q.get("cardimg")||"";
  for(const [k,list] of [["font","heading"],["bodyfont","body"]]){const v=(q.get(k)||"").toLowerCase();lq(".lk-"+k).value=FONTS[list][v]?v:presetFont(k)}showFonts();
  showLook();lookChanged()});
showLook();showFonts();lookChanged();
document.addEventListener("click",async(e)=>{const b=e.target.closest("button[data-copy]");if(!b)return;try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent="Copied!";}catch(_){b.textContent="Select & copy";}setTimeout(()=>{b.textContent="Copy"},1500);});</script>
`, {
    width: 1140,
    css: `.intro{font-style:italic;font-size:1.15rem;margin-top:0}.note ol{margin:6px 0 0;padding-left:1.3em}.note li{margin:3px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,480px),1fr));gap:16px;align-items:start}
.ov.full{grid-column:1/-1}
.ov{background:linear-gradient(180deg,#e4dcc2,#dccfaa);border:1px solid var(--edge);border-radius:6px;padding:16px 18px;min-width:0;box-shadow:0 3px 10px #6b44182b}
.ov h2{margin:0;padding:0;border:0;font-size:1.1rem}.ov h2::before{content:none}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;cursor:pointer;list-style:none}.head::-webkit-details-marker{display:none}
.head h2::after{content:"▸";display:inline-block;margin-left:8px;color:var(--ink-3);font-size:.85em;transition:transform .15s}.ov[open] .head h2::after{transform:rotate(90deg)}
.ov[open] .head{margin-bottom:8px}.size{font:600 .78rem var(--mono);color:var(--ink-3);white-space:nowrap}
.url{display:flex;gap:8px;align-items:stretch}.url code{flex:1;min-width:0;background:#2b1d12;color:#f3dfb4;border:0;border-left:3px solid var(--seal);border-radius:3px;padding:8px 10px;font-size:.8rem}
.url button{padding:0 14px}
.tb{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:8px 16px;margin:0 0 10px;font-size:.92rem}
.tb label,.tb-row{display:flex;align-items:center;gap:8px;min-width:0}.tb label[hidden]{display:none}.tb input,.tb select{flex:1;min-width:0;width:auto}.tb .tb-size{flex:0 1 90px}
.tb-wide{grid-column:1/-1;flex-wrap:wrap}.tb-where{display:block;background:#efe5c8;border:1px solid var(--edge);border-radius:4px;padding:8px 12px}.tb-where ul{margin:4px 0 0;padding-left:1.2em}.tb p{margin:0}.tb button{padding:6px 12px}
.look{margin-bottom:16px}.look .tb{margin:10px 0 0}.lk-c input[type=color]{flex:0 0 46px;width:46px;height:30px;padding:2px;cursor:pointer}
.lk input[type=checkbox]{flex:none;width:auto}.lk-reset{padding:2px 8px!important}.lk-reset[hidden]{display:none}
.lk-sample{display:flex;flex-direction:column;gap:2px;background:#efe5c8;border:1px solid var(--edge);border-radius:4px;padding:8px 12px}.lk-sample b{font-size:1.3rem;letter-spacing:.06em;text-transform:uppercase}.lk .tb-row input{flex:1;min-width:180px;font:600 .8rem var(--mono)}
.side-opt{display:flex;align-items:baseline;gap:8px;margin:0 0 8px;font-size:.92rem;cursor:pointer}.side-opt .muted{font-size:.8rem}
.preview{margin-top:10px;border-radius:5px;overflow:hidden;border:1px solid var(--edge);background:repeating-conic-gradient(#2a2420 0 25%,#1d1915 0 50%) 0 0/24px 24px}
.preview iframe{width:100%;height:100%;border:0;background:transparent;color-scheme:normal}`,
  });
}

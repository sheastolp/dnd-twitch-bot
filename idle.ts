// GuildScribe — "The Endless Delve", an idle game chat plays together on
// stream (a drop-in replacement for Words on Stream). The guild's party walks
// down an endless dungeon on its own, floor by floor; chat makes it faster.
//
//   GET /overlay?channel=<id|login>&panel=idle   the game (an OBS Browser source, 1280×720;
//                                                the theme draws it in its brb and chat windows)
//   GET /overlay/idle?channel=<id|login>         the channel's GuildScribe heroes (class, level),
//                                                so chatters with a saved hero show up as one
//
// How it plays:
//   • The party fights on its own (party DPS); every 5 kills it goes down a
//     floor. Every 10th floor is a boss with a 30-second timer — miss it and
//     the party falls back a floor, farms 10 kills and tries again.
//   • Any chat message joins the chatter to the delve for 10 minutes (their
//     token sits in the party row, +20% party damage each) and lands a strike
//     (at most one per 1.5 s per chatter). A saved GuildScribe hero hits
//     harder (+5% per level) and shows its class.
//   • Plain words in chat: "fireball" (a big hit, once a minute per chatter)
//     and "bless" (double damage for 20 s, anyone, 90 s cooldown).
//   • The quartermaster spends the gold on his own, cheapest upgrade first.
//   • Stuck at a boss three times in a row (floor 15+), the party retreats to
//     the tavern: the run starts over with renown, +20% damage and gold each.
//   • Progress is saved in the browser source (localStorage, per channel); a
//     source that was closed or hidden catches up a quarter of the gold it
//     would have earned, up to 8 hours.
//   • Mods: "!delve reset" in chat starts the game over from floor 1.
//
// Like the theme, chat comes straight from Twitch's IRC websocket as an
// anonymous read-only guest; nothing is written server-side. Viewer text only
// ever goes in through textContent.
//
// URL extras: &hide=<login,login> chatters who don't play (bots — the
// GuildScribe bot, logins ending in "bot", every account listed in
// bot_accounts.ts and the channel's bot list on the dashboard are always left
// out; a name added there reaches the game the next time its source loads), &pad=<px> a
// margin inside the frame, &always=1 preview mode (demo party, nothing saved).

import { escapeHtml } from "./utils.ts";
import { listChannelCharacters } from "./db.ts";
import { listedBotAccounts } from "./bot_accounts.ts";

const HERO_TTL_MS = 60_000;
const heroCache = new Map<string, { at: number; heroes: Record<string, [string, number]> }>();

/** Every saved hero in the channel as login → [class, level]; cached a minute per isolate. */
export async function getIdleHeroes(channelId: string): Promise<Record<string, [string, number]>> {
  const hit = heroCache.get(channelId);
  if (hit && Date.now() - hit.at < HERO_TTL_MS) return hit.heroes;
  const heroes: Record<string, [string, number]> = {};
  for (const c of await listChannelCharacters(channelId)) {
    if (c.username) heroes[String(c.username).toLowerCase()] = [String(c.cls ?? ""), Number(c.level) || 1];
  }
  heroCache.set(channelId, { at: Date.now(), heroes });
  if (heroCache.size > 200) heroCache.delete(heroCache.keys().next().value!);
  return heroes;
}

/** `!delve` in chat: how to play. */
export function delveHelpText(display: string): string {
  return `@${display} 🕯️ The Endless Delve is on screen — the guild fights its way down on its own, and chat makes it faster: any message joins you to the party and lands a strike, "fireball" in chat is a big hit (1/min each), "bless" doubles everyone's damage for 20 s. A saved hero (!createchar) hits harder.`;
}

const STYLE = String.raw`
:root{--ink:#f4e6c8;--muted:#b8a586;--gold:#f2c94c;--gold2:#c99a2e;--blood:#d9473a;--good:#7fd17a;--arc:#9ab8ff}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#120d09}
#stage{position:absolute;left:0;top:0;width:1280px;height:720px;transform-origin:0 0;overflow:hidden;color:var(--ink);font-family:"EB Garamond",Georgia,serif;
  background:radial-gradient(ellipse 60% 55% at 50% 42%,#4a3220 0,#2a1c12 45%,#140e0a 100%),#140e0a}
#stage::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.5;
  background:repeating-linear-gradient(0deg,transparent 0 58px,#0006 58px 61px),repeating-linear-gradient(90deg,transparent 0 118px,#0004 118px 121px)}
.torch{position:absolute;top:150px;width:16px;height:46px;border-radius:3px;background:linear-gradient(#6b4a2a,#3a2614)}
.torch::before{content:"";position:absolute;left:50%;top:-34px;width:30px;height:42px;transform:translateX(-50%);border-radius:50% 50% 45% 45%;
  background:radial-gradient(ellipse at 50% 70%,#fff3b0,#ffb43a 45%,#e2572a 75%,transparent 78%);animation:flick .18s infinite alternate;filter:blur(.4px)}
.torch::after{content:"";position:absolute;left:50%;top:-120px;width:260px;height:260px;transform:translateX(-50%);border-radius:50%;background:radial-gradient(#ffb43a33,transparent 65%);pointer-events:none}
.torch.l{left:368px}.torch.r{left:896px}
@keyframes flick{from{transform:translateX(-50%) scale(1,1)}to{transform:translateX(-52%) scale(.94,1.06)}}
h1,.cz{font-family:Cinzel,Georgia,serif}
header{position:absolute;left:24px;right:24px;top:16px;height:56px;display:flex;align-items:center;justify-content:space-between}
header h1{margin:0;font-size:30px;letter-spacing:.08em;text-transform:uppercase;color:var(--gold);text-shadow:0 2px 8px #000}
header h1 small{display:block;font:italic 500 19px/1.1 "EB Garamond",Georgia,serif;letter-spacing:.02em;text-transform:none;color:var(--muted)}
.stats{display:flex;gap:18px}
.stat{display:flex;flex-direction:column;align-items:flex-end;padding:4px 14px;border:1px solid #c99a2e55;border-radius:8px;background:#0006;min-width:120px}
.stat b{font:700 26px/1.1 Cinzel,Georgia,serif;color:var(--gold)}.stat span{font-size:15px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.stat.bless{border-color:#9ab8ff;box-shadow:0 0 14px #9ab8ff88}.stat.bless b{color:var(--arc)}
.card{position:absolute;border:1px solid #c99a2e66;border-radius:10px;background:linear-gradient(180deg,#1d1510ee,#120d09ee);box-shadow:inset 0 0 0 4px #0004,0 6px 18px #0008}
.card h2{margin:0;padding:10px 14px 6px;font:700 17px/1 Cinzel,Georgia,serif;letter-spacing:.12em;text-transform:uppercase;color:var(--gold2);border-bottom:1px solid #c99a2e33}
#shop{left:24px;top:92px;width:300px;height:396px}
.up{display:grid;grid-template-columns:44px 1fr auto;grid-template-rows:auto auto;column-gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid #ffffff10;transition:background .4s}
.up i{grid-row:1/3;font-style:normal;font-size:34px;text-align:center}
.up b{font:600 20px/1.1 "EB Garamond",Georgia,serif}.up em{grid-column:3;grid-row:1;font:700 18px/1 Cinzel,Georgia,serif;color:var(--gold)}
.up small{grid-column:2/4;font-size:16px;color:var(--muted)}
.up.flash{background:#f2c94c33}
.up.next small{color:var(--ink)}
#arena{position:absolute;left:344px;top:92px;width:592px;height:396px;display:flex;flex-direction:column;align-items:center}
#floorline{font:700 22px/1 Cinzel,Georgia,serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
#pips{display:flex;gap:8px;margin-top:8px;height:12px}
#pips i{width:12px;height:12px;border-radius:50%;border:1px solid #c99a2e99}#pips i.on{background:var(--gold);box-shadow:0 0 8px #f2c94c}
#mon{position:relative;margin-top:12px;font-size:148px;line-height:1.15;height:178px;filter:drop-shadow(0 12px 14px #000);transition:opacity .35s,transform .35s}
#mon.hit{animation:hit .16s}#mon.dead{opacity:0;transform:translateY(30px) scale(.6) rotate(-12deg)}#mon.spawn{animation:spawn .45s ease-out}
#mon.boss{font-size:160px;line-height:1.08}
@keyframes hit{30%{transform:translateX(-8px) rotate(-4deg);filter:drop-shadow(0 12px 14px #000) brightness(2)}70%{transform:translateX(6px)}}
@keyframes spawn{from{opacity:0;transform:translateY(-30px) scale(.7)}}
#mname{margin-top:8px;font:700 30px/1.1 Cinzel,Georgia,serif;letter-spacing:.04em;text-shadow:0 2px 6px #000}
#mname.boss{color:#ff8a7a}
.bar{position:relative;width:480px;height:30px;margin-top:10px;border-radius:15px;background:#000a;border:1px solid #c99a2e88;overflow:hidden}
.bar>i{position:absolute;inset:0 auto 0 0;background:linear-gradient(180deg,#ff6a55,#a8231a);transition:width .12s linear}
.bar>span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:700 18px/1 Cinzel,Georgia,serif;text-shadow:0 1px 3px #000}
#timer{width:480px;height:10px;margin-top:8px;border-radius:5px;background:#000a;overflow:hidden;visibility:hidden}
#timer i{display:block;height:100%;background:linear-gradient(90deg,#f2c94c,#ff8a3a)}
#timer.on{visibility:visible}
.float{position:absolute;pointer-events:none;font:700 26px/1 Cinzel,Georgia,serif;white-space:nowrap;text-shadow:0 2px 4px #000,0 0 2px #000;animation:float 1.1s ease-out forwards}
.float small{display:block;font:italic 600 16px/1.1 "EB Garamond",Georgia,serif;color:var(--ink);text-align:center}
.float.big{font-size:38px;color:#ffb43a}.float.gold{color:var(--gold);font-size:22px}
@keyframes float{from{opacity:1;transform:translate(-50%,0)}to{opacity:0;transform:translate(-50%,-90px)}}
#log{left:956px;top:92px;width:300px;height:396px;display:flex;flex-direction:column}
#feed{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:6px;padding:8px 14px 10px;
  -webkit-mask:linear-gradient(transparent,#000 48px);mask:linear-gradient(transparent,#000 48px)}
#feed div{font-size:18px;line-height:1.25;overflow-wrap:anywhere;animation:in .4s ease-out}
#feed b{color:var(--gold)}
.how{padding:8px 14px 12px;border-top:1px solid #c99a2e33;font-size:16px;line-height:1.35;color:var(--muted)}
.how b{color:var(--ink);font-weight:600}
#party{left:24px;top:504px;width:1232px;height:200px}
#party h2{display:flex;justify-content:space-between}#party h2 span{color:var(--muted);font:italic 400 17px/1 "EB Garamond",Georgia,serif;letter-spacing:0;text-transform:none}
#tokens{display:flex;gap:10px;padding:12px 14px 0;height:116px;overflow:hidden}
.tok{position:relative;width:78px;flex:none;display:flex;flex-direction:column;align-items:center;animation:in .4s ease-out;transition:transform .15s}
.tok .face{width:62px;height:62px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px;background:radial-gradient(circle at 40% 35%,#5a4330,#20160e);border:3px solid var(--c,#c99a2e);box-shadow:0 3px 8px #000a}
.tok .lv{position:absolute;top:44px;right:4px;padding:1px 5px;border-radius:7px;background:#000c;border:1px solid #c99a2e;font:700 12px/1.2 Cinzel,Georgia,serif;color:var(--gold)}
.tok .nm{margin-top:4px;max-width:78px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:16px}
.tok.swing{transform:translateY(-10px)}
.tok.more .face{font:700 20px/1 Cinzel,Georgia,serif;color:var(--muted)}
.tok.empty{width:auto;flex:1;justify-content:center;color:var(--muted);font:italic 22px/1.3 "EB Garamond",Georgia,serif}
#mvp{padding:6px 14px 0;font-size:17px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#mvp b{color:var(--ink);font-weight:600}
#banner{position:absolute;left:640px;top:458px;transform:translate(-50%,-50%);padding:10px 34px;border-radius:12px;border:2px solid var(--gold);background:#120d09ee;
  font:700 28px/1.2 Cinzel,Georgia,serif;white-space:nowrap;color:var(--gold);text-align:center;box-shadow:0 0 40px #000;opacity:0;transition:opacity .5s;pointer-events:none;max-width:900px}
#banner small{display:block;font:italic 19px/1.3 "EB Garamond",Georgia,serif;color:var(--ink)}
#banner.on{opacity:1}
@keyframes in{from{opacity:0;transform:translateY(8px)}}
`;

// The client. Plain ES2017, no build step. Written as String.raw so escapes
// reach the browser as typed; it must never contain a backtick or "${".
const CLIENT = String.raw`
const CFG=window.__IDLE__,Q=new URLSearchParams(location.search),preview=Q.get("always")==="1";
const stage=document.getElementById("stage");
// &pad=<px> keeps the game clear of a frame's edge (the theme's torn paper overlaps its window).
const pad=Math.max(0,Math.min(80,Number(Q.get("pad"))||0));
function fit(){const s=Math.min((innerWidth-2*pad)/1280,(innerHeight-2*pad)/720);stage.style.transform="translate("+(innerWidth-1280*s)/2+"px,"+(innerHeight-720*s)/2+"px) scale("+s+")"}
fit();addEventListener("resize",fit);
const $=id=>document.getElementById(id);
function h(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e}

// ── Numbers ──
const SUF=["","K","M","B","T","Qa","Qi","Sx","Sp","Oc","No","Dc"];
function fmt(n){if(!isFinite(n))return "∞";if(n<1000)return String(Math.floor(n));const e=Math.floor(Math.log10(n)/3);
  if(e>=SUF.length)return n.toExponential(2).replace("+","");const v=n/Math.pow(1000,e);return (v<10?v.toFixed(2):v<100?v.toFixed(1):Math.floor(v))+SUF[e]}

// ── Tuning ──
const KILLS_PER_FLOOR=5,BOSS_EVERY=10,BOSS_SECONDS=30,BOSS_HP=6,FARM_KILLS=10,RETREAT_FAILS=3,RETREAT_MIN_FLOOR=15;
const ACTIVE_MS=10*60000,STRIKE_GAP_MS=1500,FIREBALL_CD_MS=60000,BLESS_MS=20000,BLESS_CD_MS=90000,AWAY_MAX_S=8*3600,AWAY_SHARE=.25;
const UPS=[
  {k:"sword",icon:"🗡️",name:"Sellswords",base:10,grow:1.13,what:"+2 party damage/s"},
  {k:"banner",icon:"🚩",name:"War banner",base:30,grow:1.2,what:"+4 to every chat strike"},
  {k:"whet",icon:"⚒️",name:"Whetstones",base:60,grow:1.55,what:"×1.25 all damage"},
  {k:"map",icon:"🗺️",name:"Treasure maps",base:120,grow:1.45,what:"+15% gold"}];
const TIERS=[
  [["🐀","Giant Rat"],["🦇","Swarm of Bats"],["👺","Goblin"],["🕷️","Giant Spider"],["🐺","Wolf"],["🐍","Giant Snake"],["🟩","Gelatinous Cube"]],
  [["💀","Skeleton"],["🧟","Zombie"],["👹","Orc"],["🦂","Giant Scorpion"],["🍄","Myconid"],["🐗","Dire Boar"],["🦉","Owlbear"]],
  [["👻","Wraith"],["🗿","Stone Golem"],["🦎","Basilisk"],["🧛","Vampire Spawn"],["🐊","Swamp Hydra"],["🦅","Griffon"],["🕸️","Drider"]],
  [["🐉","Young Dragon"],["👁️","Beholder"],["🦑","Mind Flayer"],["😈","Pit Fiend"],["🔥","Fire Elemental"],["🌑","Shadow Demon"],["❄️","Frost Giant"]]];
const BOSSES=[["👺","Goblin Boss"],["👹","Ogre Chieftain"],["🗿","Hill Giant"],["🐍","Medusa"],["🐉","Young Red Dragon"],["👁️","Beholder"],["🦴","Lich"],["🐲","Ancient Dragon"],["😈","Demon Lord"],["🦖","Tarrasque"]];
const CLASS_ICON={Barbarian:"🪓",Bard:"🎻",Cleric:"✨",Druid:"🌿",Fighter:"⚔️",Monk:"👊",Paladin:"🛡️",Ranger:"🏹",Rogue:"🗝️",Sorcerer:"🔮",Warlock:"🕯️",Wizard:"🧙"};
// Bots never play: everything bot_accounts.ts lists (passed in), and any login ending in "bot".
const HIDE=new Set(CFG.bots||[]);
(Q.get("hide")||"").toLowerCase().split(",").map(s=>s.trim().replace(/^@/,"")).filter(Boolean).forEach(s=>HIDE.add(s));

const isBoss=f=>f%BOSS_EVERY===0;
const hpFor=f=>Math.ceil(12*Math.pow(1.3,f-1)*(isBoss(f)?BOSS_HP:1));
function monsterFor(f,n){if(isBoss(f)){const i=f/BOSS_EVERY-1,b=BOSSES[i%BOSSES.length],lap=Math.floor(i/BOSSES.length);return {icon:b[0],name:b[1]+(lap?" "+"+".repeat(Math.min(lap,3)):"")}}
  const t=TIERS[Math.min(TIERS.length-1,Math.floor((f-1)/15))];const m=t[(f*7+n*3)%t.length];return {icon:m[0],name:m[1]}}

// ── State ──
const KEY="gs-idle:"+CFG.channel.toLowerCase();
function fresh(){return {v:1,floor:1,best:1,kills:0,gold:0,renown:0,up:{sword:0,banner:0,whet:0,map:0},hp:hpFor(1),n:0,fails:0,farm:0,mvp:{},savedAt:Date.now(),runs:0}}
let S=fresh();
if(!preview){try{const raw=localStorage.getItem(KEY);if(raw){const o=JSON.parse(raw);if(o&&o.v===1)S=Object.assign(fresh(),o,{up:Object.assign(fresh().up,o.up||{})})}}catch(e){}}
function save(){if(preview)return;S.savedAt=Date.now();try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}}
addEventListener("pagehide",save);setInterval(save,5000);

const heroes=new Map(); // login -> {name,color,last,nextStrike,nextFireball}
let gsHeroes={};let blessUntil=0,blessReady=0,bossEnds=0;

const renownMult=()=>1+.2*S.renown;
const whetMult=()=>Math.pow(1.25,S.up.whet);
const blessMult=()=>Date.now()<blessUntil?2:1;
function active(){const now=Date.now();return [...heroes.values()].filter(x=>now-x.last<ACTIVE_MS)}
function partyDps(){return (2+2*S.up.sword)*whetMult()*renownMult()*blessMult()*(1+.2*active().length)}
function heroLevel(login){const g=gsHeroes[login];return g?g[1]:0}
function strikeDmg(login){return Math.max((5+4*S.up.banner)*whetMult()*renownMult()*blessMult(),partyDps()*3)*(1+.05*heroLevel(login))}
function goldFor(f){return Math.ceil(hpFor(f)/5*(1+.15*S.up.map)*renownMult()*(isBoss(f)?4/BOSS_HP:1))}
function cost(u){return Math.ceil(u.base*Math.pow(u.grow,S.up[u.k]))}

// ── Feed, floats, banner ──
const feed=$("feed");
function say(parts){const d=h("div");for(const p of parts){if(typeof p==="string")d.append(document.createTextNode(p));else d.append(h("b",null,p.b))}
  feed.append(d);while(feed.children.length>14)feed.firstElementChild.remove()}
const arena=$("arena"),mon=$("mon");let floats=0;
function float(text,who,cls){if(floats>24)return;floats++;const f=h("div","float"+(cls?" "+cls:""),text);if(who)f.append(h("small",null,who));
  f.style.left=(296+(Math.random()-.5)*300)+"px";f.style.top=(70+Math.random()*90)+"px";arena.append(f);setTimeout(()=>{f.remove();floats--},1150)}
let bannerT=0;function banner(big,small){const b=$("banner");b.replaceChildren(document.createTextNode(big));if(small)b.append(h("small",null,small));b.classList.add("on");clearTimeout(bannerT);bannerT=setTimeout(()=>b.classList.remove("on"),4200)}

// ── Combat ──
let dying=false;
function hitMonster(d){if(dying||d<=0)return;S.hp-=d;if(S.hp<=0)kill()}
function kill(){dying=true;const f=S.floor,g=goldFor(f);S.gold+=g;S.n++;mon.classList.add("dead");float("+"+fmt(g)+" gold",null,"gold");
  if(isBoss(f)){S.fails=0;S.farm=0;bossEnds=0;const m=monsterFor(f,0);say(["👑 ",{b:m.name}," falls on floor "+f+"! +"+fmt(g)+" gold"]);banner(m.name+" is slain!","Floor "+(f+1)+" awaits");S.floor++;S.kills=0}
  else if(S.farm>0){if(--S.farm===0){S.floor++;S.kills=0;say(["⚔️ The party regroups and storms floor "+S.floor+" again."])}}
  else if(++S.kills>=KILLS_PER_FLOOR){S.floor++;S.kills=0}
  if(S.floor>S.best){S.best=S.floor;if(S.best%5===0&&!isBoss(S.best))say(["🕯️ New depth record: floor "+S.best])}
  setTimeout(spawn,420)}
function spawn(){dying=false;S.hp=hpFor(S.floor);mon.classList.remove("dead");mon.classList.remove("spawn");void mon.offsetWidth;mon.classList.add("spawn");
  if(isBoss(S.floor)){bossEnds=Date.now()+BOSS_SECONDS*1000;const m=monsterFor(S.floor,0);banner("Boss: "+m.name,"Floor "+S.floor+" — "+BOSS_SECONDS+" seconds! Chat, strike!")}else bossEnds=0;draw(true)}
function bossTimeout(){bossEnds=0;S.fails++;const m=monsterFor(S.floor,0);
  if(S.fails>=RETREAT_FAILS&&S.floor>=RETREAT_MIN_FLOOR){retreat();return}
  say(["💨 ",{b:m.name}," drove the party back. Regrouping on floor "+(S.floor-1)+"…"]);banner("Driven back!","Farming floor "+(S.floor-1)+" before another try");
  S.floor--;S.farm=FARM_KILLS;S.kills=0;spawn()}
function retreat(){const gain=Math.max(1,Math.floor((S.floor-10)/5));const keep={renown:S.renown+gain,best:S.best,mvp:S.mvp,runs:S.runs+1};
  S=Object.assign(fresh(),keep);say(["🍺 The guild retreats to the tavern. +"+gain+" renown (×"+renownMult().toFixed(1)+" damage & gold)."]);
  banner("Back to the tavern!","+"+gain+" renown — the next delve hits harder");spawn()}

// ── Quartermaster: spends the gold, cheapest upgrade first ──
function shop(){for(let i=0;i<25;i++){let best=null;for(const u of UPS)if(!best||cost(u)<cost(best))best=u;
  if(S.gold<cost(best))break;S.gold-=cost(best);S.up[best.k]++;flashUp(best);if(S.up[best.k]%5===0)say(["🛒 Quartermaster: ",{b:best.name}," → level "+S.up[best.k]])}}
const upEls={};
function buildShop(){const box=$("ups");for(const u of UPS){const r=h("div","up");r.append(h("i",null,u.icon),h("b",null,u.name),h("em"),h("small"));box.append(r);upEls[u.k]=r}}
function flashUp(u){const r=upEls[u.k];r.classList.remove("flash");void r.offsetWidth;r.classList.add("flash");setTimeout(()=>r.classList.remove("flash"),500)}

// ── Chat ──
function act(login,name,color,text,isMod){
  const now=Date.now(),word=text.trim().toLowerCase();
  if(isMod&&/^!delve\s+reset$/.test(word)){if(!preview){S=fresh();save()}heroes.clear();say(["🧹 A steward reset the delve. Back to floor 1."]);spawn();return}
  let x=heroes.get(login);
  if(!x||now-x.last>=ACTIVE_MS){if(!x){x={login,name,color,last:0,nextStrike:0,nextFireball:0};heroes.set(login,x)}
    const lv=heroLevel(login);say(["🎒 ",{b:name}," joins the delve"+(lv?" — a level "+lv+" "+gsHeroes[login][0]:"")+"!"])}
  x.name=name;x.color=color;x.last=now;
  const tok=document.querySelector('.tok[data-l="'+login+'"]');if(tok){tok.classList.add("swing");setTimeout(()=>tok.classList.remove("swing"),160)}
  if(/^fireball\b/.test(word)){
    if(now>=x.nextFireball){x.nextFireball=now+FIREBALL_CD_MS;const d=strikeDmg(login)*12;hitMonster(d);mon.classList.remove("hit");void mon.offsetWidth;mon.classList.add("hit");
      float("🔥 "+fmt(d),name,"big");say(["🔥 ",{b:name}," hurls a Fireball for "+fmt(d)+"!"]);addMvp(login,name,d);return}}
  else if(/^bless\b/.test(word)){
    if(now>=blessReady){blessUntil=now+BLESS_MS;blessReady=now+BLESS_CD_MS;say(["✨ ",{b:name}," blesses the party — double damage for 20 s!"]);banner("Blessed!",name+" calls on the gods — ×2 damage")}}
  if(now>=x.nextStrike){x.nextStrike=now+STRIKE_GAP_MS;const d=strikeDmg(login);hitMonster(d);mon.classList.remove("hit");void mon.offsetWidth;mon.classList.add("hit");float(fmt(d),name);addMvp(login,name,d)}}
function addMvp(login,name,d){const m=S.mvp[login]||(S.mvp[login]={n:name,d:0});m.n=name;m.d+=d}

const unesc=v=>v.replace(/\\(.)/g,(_,c)=>c==="s"?" ":c===":"?";":c==="r"?"\r":c==="n"?"\n":c);
function parse(line){let tags={},rest=line;
  if(rest[0]==="@"){const sp=rest.indexOf(" ");for(const kv of rest.slice(1,sp).split(";")){const eq=kv.indexOf("=");tags[eq<0?kv:kv.slice(0,eq)]=eq<0?"":unesc(kv.slice(eq+1))}rest=rest.slice(sp+1)}
  let prefix="";if(rest[0]===":"){const sp=rest.indexOf(" ");prefix=rest.slice(1,sp);rest=rest.slice(sp+1)}
  const ci=rest.indexOf(" :");const trail=ci<0?null:rest.slice(ci+2);const parts=(ci<0?rest:rest.slice(0,ci)).split(" ");
  return {tags,nick:prefix.split("!")[0],cmd:parts[0],trail}}
let ws=null,backoff=1000;
function connect(){if(!CFG.login)return;ws=new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ws.onopen=()=>{backoff=1000;ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");ws.send("PASS SCHMOOPIIE");ws.send("NICK justinfan"+(10000+Math.floor(Math.random()*80000)));ws.send("JOIN #"+CFG.login)};
  ws.onmessage=e=>{for(const line of String(e.data).split("\r\n")){if(!line)continue;const m=parse(line);
    if(m.cmd==="PING"){ws.send("PONG :"+(m.trail||"tmi.twitch.tv"));continue}
    if(m.cmd==="RECONNECT"){ws.close();continue}
    if(m.cmd!=="PRIVMSG")continue;
    let text=m.trail||"";const me=/^\u0001ACTION (.*)\u0001$/.exec(text);if(me)text=me[1];
    const login=(m.tags.login||m.nick||"").toLowerCase();if(!login||HIDE.has(login)||/bot$/.test(login)||(CFG.botId&&m.tags["user-id"]===CFG.botId))continue;
    const badges=m.tags.badges||"";const isMod=m.tags.mod==="1"||/(^|,)(broadcaster|moderator|lead_moderator)\//.test(badges);
    act(login,m.tags["display-name"]||m.nick,m.tags.color||"",text,isMod)}};
  ws.onclose=()=>{setTimeout(connect,backoff);backoff=Math.min(backoff*2,30000)};
  ws.onerror=()=>{try{ws.close()}catch(e){}}}

// GuildScribe heroes: chatters with a saved character show their class and hit harder.
function loadHeroes(){fetch("/overlay/idle?channel="+encodeURIComponent(CFG.channel)).then(r=>r.ok?r.json():null).then(d=>{if(d&&d.ok)gsHeroes=d.heroes||{}}).catch(()=>{})}

// ── Drawing ──
const INKS=["#e0604f","#7fd17a","#6fa8ff","#c58cff","#f2c94c","#5fd0d0","#ff8ab0"];
function tint(color,name){if(/^#[0-9a-f]{6}$/i.test(color))return color;let n=0;for(const c of name)n=(n*31+c.charCodeAt(0))>>>0;return INKS[n%INKS.length]}
let tokSig="";
function drawParty(){const list=active().sort((a,b)=>b.last-a.last);const sig=list.map(x=>x.name).join(",")+"|"+Object.keys(gsHeroes).length;
  $("partyhint").textContent=list.length?list.length+" in the delve · +"+Math.round(list.length*20)+"% party damage":"chat to join";
  if(sig===tokSig)return;tokSig=sig;const box=$("tokens");box.replaceChildren();
  if(!list.length){box.append(h("div","tok empty","The party marches alone. Say anything in chat to join the delve!"));return}
  const MAX=13;for(const x of list.slice(0,MAX)){const login=x.login,g=gsHeroes[login];const t=h("div","tok");t.dataset.l=login;
    const face=h("div","face",g&&CLASS_ICON[g[0]]||x.name.slice(0,1).toUpperCase());face.style.setProperty("--c",tint(x.color,x.name));t.append(face);
    if(g)t.append(h("div","lv","L"+g[1]));t.append(h("div","nm",x.name));box.append(t)}
  if(list.length>MAX){const t=h("div","tok more");t.append(h("div","face","+"+(list.length-MAX)),h("div","nm","more"));box.append(t)}}
let lastFloor=0;
function draw(force){const f=S.floor,boss=isBoss(f),m=monsterFor(f,S.n),max=hpFor(f);
  if(force||mon.dataset.f!==f+":"+S.n){mon.dataset.f=f+":"+S.n;mon.textContent=m.icon;mon.classList.toggle("boss",boss);$("mname").textContent=m.name;$("mname").classList.toggle("boss",boss)}
  $("floorline").textContent=(boss?"⚠ Boss floor ":"Floor ")+f+(S.farm?" · regrouping ("+(FARM_KILLS-S.farm)+"/"+FARM_KILLS+")":"");
  const pips=$("pips");if(lastFloor!==f||pips.dataset.k!==String(S.kills)){lastFloor=f;pips.dataset.k=String(S.kills);pips.replaceChildren();
    if(!boss&&!S.farm)for(let i=0;i<KILLS_PER_FLOOR;i++)pips.append(h("i",i<S.kills?"on":""))}
  const p=Math.max(0,S.hp)/max;$("hpfill").style.width=(p*100).toFixed(2)+"%";$("hptext").textContent=fmt(Math.max(0,Math.ceil(S.hp)))+" / "+fmt(max);
  const t=$("timer");t.classList.toggle("on",!!bossEnds);if(bossEnds)t.firstElementChild.style.width=Math.max(0,(bossEnds-Date.now())/(BOSS_SECONDS*10))+"%";
  $("gold").textContent=fmt(S.gold);$("dps").textContent=fmt(partyDps());$("depth").textContent=String(S.best);
  $("renown").textContent=S.renown?"×"+renownMult().toFixed(1):"—";
  const bl=Date.now()<blessUntil;$("dpsbox").classList.toggle("bless",bl);$("dpslabel").textContent=bl?"blessed ×2":"party dmg/s";
  let cheap=null;for(const u of UPS)if(!cheap||cost(u)<cost(cheap))cheap=u;
  for(const u of UPS){const r=upEls[u.k];r.querySelector("em").textContent="Lv "+S.up[u.k];r.querySelector("small").textContent=u.what+" · next "+fmt(cost(u));r.classList.toggle("next",u===cheap)}
  const top=Object.values(S.mvp).sort((a,b)=>b.d-a.d).slice(0,3);const mv=$("mvp");mv.replaceChildren();
  if(top.length){mv.append("🏆 Top delvers: ");top.forEach((x,i)=>{if(i)mv.append(" · ");mv.append(h("b",null,x.n)," "+fmt(x.d))})}
  else mv.append("🏆 Top delvers: nobody yet — every chat message is a strike.");
  drawParty()}

// ── Main loop ──
let last=Date.now();
function step(){const now=Date.now(),dt=Math.min(1,(now-last)/1000);last=now;
  hitMonster(partyDps()*dt);if(bossEnds&&now>=bossEnds&&!dying)bossTimeout();shop();draw(false)}

buildShop();
// Away earnings: a quarter of what the party would have hauled, up to 8 hours.
if(!preview){const away=Math.min(AWAY_MAX_S,(Date.now()-S.savedAt)/1000);
  if(away>6*3600)S.mvp={}; // a new stream: fresh leaderboard
  if(away>60){const perS=partyDps()/hpFor(Math.max(1,S.floor-1))*goldFor(Math.max(1,S.floor-1));const g=Math.floor(perS*away*AWAY_SHARE);
    if(g>0){S.gold+=g;const hrs=away>=3600?(away/3600).toFixed(1)+" h":Math.round(away/60)+" min";say(["💤 While the hall was dark ("+hrs+"), the guild hauled ",{b:fmt(g)+" gold"},"."])}}}
if(S.hp<=0||S.hp>hpFor(S.floor))S.hp=hpFor(S.floor);
if(isBoss(S.floor))bossEnds=Date.now()+BOSS_SECONDS*1000;
say(["🕯️ The guild descends. ",{b:"Chat to join"}," — every message is a strike."]);
if(preview){gsHeroes={adventurer:["Wizard",7],grimbold:["Fighter",4]};
  [["Adventurer","#6fa8ff"],["Grimbold","#e0604f"],["Pip","#7fd17a"],["Morwen","#c58cff"]].forEach((p,i)=>setTimeout(()=>act(p[0].toLowerCase(),p[0],p[1],i===2?"fireball":"hello!",false),400+i*700));
  setInterval(()=>{const p=["Adventurer","Grimbold","Pip","Morwen"][Math.floor(Math.random()*4)];act(p.toLowerCase(),p,"","huzzah",false)},1800)}
draw(true);setInterval(step,100);
loadHeroes();setInterval(loadHeroes,5*60000);
connect();
`;

/** channelBots: the channel's own bot list (channel_bots.ts), left out like the built-in bots. */
export function renderIdlePage(channelKey: string, login: string, name: string, botId = "", channelBots: Iterable<string> = []): string {
  const cfg = { channel: channelKey, login: login.toLowerCase(), name, botId, bots: [...new Set([...listedBotAccounts(), ...channelBots])] };
  // JSON inside <script>: escape "<" so a value can never close the tag.
  const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The Endless Delve · ${escapeHtml(name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=EB+Garamond:ital,wght@0,400;0,600;1,400&display=swap">
<style>${STYLE}</style></head><body><div id="stage"><div class="torch l"></div><div class="torch r"></div>
<header><h1>The Endless Delve<small>${escapeHtml(name)}'s guild, ever deeper</small></h1><div class="stats">
<div class="stat"><b id="depth">1</b><span>depth record</span></div><div class="stat"><b id="gold">0</b><span>gold</span></div>
<div class="stat" id="dpsbox"><b id="dps">0</b><span id="dpslabel">party dmg/s</span></div><div class="stat"><b id="renown">—</b><span>renown</span></div></div></header>
<section class="card" id="shop"><h2>Quartermaster</h2><div id="ups"></div></section>
<section id="arena"><div id="floorline"></div><div id="pips"></div><div id="mon"></div><div id="mname"></div>
<div class="bar"><i id="hpfill"></i><span id="hptext"></span></div><div id="timer"><i></i></div></section>
<section class="card" id="log"><h2>Chronicle</h2><div id="feed"></div>
<div class="how"><b>Chat to join</b> — every message strikes. Type <b>fireball</b> for a big hit (1/min) or <b>bless</b> for ×2 damage.</div></section>
<section class="card" id="party"><h2>The Party <span id="partyhint"></span></h2><div id="tokens"></div><div id="mvp"></div></section>
<div id="banner"></div>
</div><script>window.__IDLE__=${cfgJson};${CLIENT}</script></body></html>`;
}

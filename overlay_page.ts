// GuildScribe — HTML for the OBS overlays (see overlay.ts for the routes and
// data). Each overlay is a transparent page that polls /overlay/data and
// redraws itself, so OBS needs nothing but a Browser Source pointed at it.
// Everything viewer-supplied (names, prizes, item text) goes into the page
// through textContent, never innerHTML.

import { escapeHtml } from "./utils.ts";

/** Every overlay panel: what it shows and a sensible OBS browser-source size. */
export const OVERLAY_PANELS: Record<string, { label: string; blurb: string; width: number; height: number }> = {
  status: { label: "Status bar", blurb: "One slim strip: live dot, raid boss HP, fight in progress, giveaway, the peddler's ware and the swear jar. Made for the top or bottom edge of the screen.", width: 1920, height: 70 },
  raid: { label: "Raid boss", blurb: "This stream's raid boss with its HP bar, the muster/cooldown state, and the top damage dealers.", width: 520, height: 300 },
  battle: { label: "Battle tracker", blurb: "Whatever fight is under way — arena duel, monster hunt, party duel or party hunt — with live HP bars and whose turn it is. Hidden when nobody is fighting.", width: 560, height: 420 },
  giveaway: { label: "Giveaway", blurb: "The open giveaway's prize, entrants and tickets, then the winners for ten minutes after the draw. Hidden otherwise.", width: 520, height: 200 },
  merchant: { label: "Peddler's stall", blurb: "The ware the open-stall merchant is currently hawking and its price (needs !market on).", width: 520, height: 180 },
  jar: { label: "Swear jar", blurb: "The swear jar's running total; it bounces whenever someone pays in.", width: 360, height: 110 },
  gold: { label: "Coin leaderboard", blurb: "The channel's richest adventurers (needs gold on).", width: 400, height: 300 },
  dice: { label: "Roll call", blurb: "Natural 20 and natural 1 leaders. Add &window=hour or &window=week (default: day).", width: 520, height: 260 },
  guild: { label: "Guild summary", blurb: "How many adventurers and parties the guild has, plus its highest-level heroes.", width: 460, height: 320 },
  all: { label: "Everything (stacked)", blurb: "Every panel that has something to show, stacked in one column.", width: 560, height: 1080 },
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
.big{font-size:1.5rem;font-weight:bold}.muted{color:var(--muted);font-size:.88rem}.hint{color:var(--gold);font:600 .8rem ui-monospace,monospace;margin-top:6px}
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
.side+.side{margin-top:8px;padding-top:6px;border-top:1px dashed #68463299}.side>.label{color:var(--gold);font-size:.82rem;text-transform:uppercase;letter-spacing:.08em}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.strip{display:flex;gap:10px;align-items:center;flex-wrap:nowrap;background:var(--card);border:1px solid var(--edge);border-radius:999px;padding:8px 16px;width:max-content;max-width:100%;overflow:hidden;white-space:nowrap;box-shadow:0 6px 18px #0007}
.chip{display:inline-flex;gap:6px;align-items:center;font-size:.98rem}.chip+.chip{border-left:1px solid #68463299;padding-left:10px}
.dot{width:10px;height:10px;border-radius:50%;background:#777}.dot.live{background:#e91916;box-shadow:0 0 8px #e91916;animation:pulse 1.6s infinite}
.mini{display:inline-block;width:90px;height:9px;background:#000a;border-radius:5px;overflow:hidden;vertical-align:middle}.mini>i{display:block;height:100%;background:var(--bad);transition:width .8s}
.bump{animation:bump .7s ease}
.fade{animation:in .6s ease}
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
const lastHp={}; let lastJar=null;
function ago(ms){const m=Math.round((Date.now()-ms)/60000);return m<1?"just now":m<60?m+"m ago":Math.round(m/60)+"h ago"}
function placeholder(label){return card(label,"nothing to show yet")}

const R={
  raid(d){const r=d.raid;if(!r)return null;
    const c=card("☠️ "+r.monster,"CR "+r.cr+" · AC "+r.ac+(r.raids?" · "+r.raids+" raid"+(r.raids===1?"":"s"):""));
    add(c,bar(r.hp,r.hpMax,"boss","raid"),h("div","muted",r.state));
    if(r.contributors&&r.contributors.length){const ol=h("ol");for(const x of r.contributors.slice(0,3))add(ol,add(h("li"),add(h("div","row"),h("span",null,x.name),h("span",null,x.damage+" dmg"))));add(c,h("div","hint","Top raiders"),ol)}
    if(r.slain)c.querySelector("h2").firstChild.textContent="🏆 "+r.monster+" — slain!";
    return c},
  battle(d){const fs=d.battle||[];if(!fs.length)return null;const wrap=document.createDocumentFragment();
    for(const f of fs){const c=card(f.title);
      for(const s of f.sides){const sd=add(h("div","side"),h("div","label",s.label));
        for(const m of s.combatants){const fe=h("div","fighter"+(m.turn?" turn":"")+(m.down?" down":""));
          add(fe,add(h("div","name"),h("span",null,m.name)),bar(m.hp,m.hpMax,null,f.kind+":"+m.name));add(sd,fe)}
        add(c,sd)}
      add(wrap,c)}
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
    if(d.raid){const mini=h("span","mini");const f=h("i");f.style.width=(d.raid.hpMax?Math.round(d.raid.hp/d.raid.hpMax*100):0)+"%";add(mini,f);
      add(s,add(h("span","chip"),h("span",null,(d.raid.slain?"🏆 ":"☠️ ")+d.raid.monster),d.raid.slain?h("span","muted","slain"):mini))}
    for(const f of d.battle||[]){const names=f.sides.map(x=>x.label).join(" vs ");add(s,add(h("span","chip"),h("span",null,f.title.split(" ")[0]+" "+names)))}
    if(d.giveaway)add(s,add(h("span","chip"),h("span",null,"🎁 "+d.giveaway.prize+(d.giveaway.open?" · "+d.giveaway.entrants+" in":" · won by "+(d.giveaway.winners.join(", ")||"—")))));
    if(d.merchant)add(s,add(h("span","chip"),h("span",null,"🛒 "+d.merchant.item+" — "+d.merchant.price)));
    if(d.jar){const v=h("span",null,"🫙 "+d.jar.text);if(lastJar!=null&&d.jar.total>lastJar)v.classList.add("bump");lastJar=d.jar.total;add(s,add(h("span","chip"),v))}
    return s},
};
const ORDER=["raid","battle","giveaway","merchant","jar","gold","dice","guild"];
const LABELS=CFG.labels;
// Cheap "does this panel have anything to show" check (no DOM, no side effects).
const HAS={raid:d=>!!d.raid,battle:d=>!!(d.battle&&d.battle.length),giveaway:d=>!!d.giveaway,merchant:d=>!!d.merchant,jar:d=>!!d.jar,
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
  const sig=JSON.stringify([list,list.map(p=>p==="status"?[d.channel,d.raid,d.battle,d.giveaway,d.merchant,d.jar]:d[p]),Math.floor(Date.now()/60000)]);
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
async function tick(){
  try{const r=await fetch(dataUrl,{cache:"no-store"});const d=await r.json();if(d&&d.ok){latest=d;render(d)}}catch(e){/* keep the last frame on a network blip */}
}
tick();setInterval(tick,refresh);
if(panel==="rotate")setInterval(()=>{if(latest)render(latest)},1000);
`;

export function renderOverlayPage(channelKey: string, panel: string): string {
  const cfg = {
    channel: channelKey,
    panel,
    labels: Object.fromEntries(Object.entries(OVERLAY_PANELS).map(([k, v]) => [k, v.label])),
  };
  // JSON inside <script>: escape "<" so a value can never close the tag.
  const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GuildScribe overlay · ${escapeHtml(panel)}</title><style>${STYLE}</style></head><body><div id="root"></div><script>window.__OVERLAY__=${cfgJson};${CLIENT}</script></body></html>`;
}

/** The setup page: every overlay's URL, its suggested size and a live preview. */
export function renderOverlayIndexPage(channelName: string, channelKey: string, channelId: string, baseUrl: string): string {
  const base = `${baseUrl}/overlay?channel=${encodeURIComponent(channelKey)}`;
  const cards = Object.entries(OVERLAY_PANELS).map(([key, p]) => {
    const link = `${base}&panel=${key}`;
    const previewH = Math.min(p.height, 360);
    return `<section class="ov"><div class="head"><h2>${escapeHtml(p.label)}</h2><span class="size">${p.width} × ${p.height}</span></div><p>${escapeHtml(p.blurb)}</p><div class="url"><code>${escapeHtml(link)}</code><button type="button" data-copy="${escapeHtml(link)}">Copy</button></div><div class="preview" style="height:${previewH}px"><iframe loading="lazy" src="${escapeHtml(link)}&always=1" title="${escapeHtml(p.label)} preview"></iframe></div></section>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OBS Overlays · ${escapeHtml(channelName)}</title><style>
:root{color-scheme:dark}body{margin:0 auto;max-width:1100px;padding:28px 16px;background:#15120f;color:#f4eadb;font-family:Georgia,serif;line-height:1.5}
h1{margin:0 0 4px;font-size:2.4rem}h2{margin:0;color:#e6a56e;font-size:1.2rem}p{color:#d6c6b5;margin:6px 0 10px}a{color:#e6a56e}code{font-family:ui-monospace,monospace}
.note{background:#211b16;border:1px solid #684632;border-left:4px solid #b97545;border-radius:8px;padding:12px 16px;margin:18px 0}
.note ol{margin:6px 0 0;padding-left:1.3em}.note li{margin:3px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,480px),1fr));gap:16px}
.ov{background:#211b16;border:1px solid #684632;border-radius:10px;padding:16px;min-width:0}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:10px}.size{font:600 .78rem ui-monospace,monospace;color:#aa9b8d;white-space:nowrap}
.url{display:flex;gap:8px;align-items:stretch}.url code{flex:1;min-width:0;background:#0e0d0c;border-left:3px solid #b97545;padding:8px 10px;font-size:.8rem;overflow-wrap:anywhere;color:#f0c39e}
button{background:#b97545;color:#15120f;border:1px solid #e6a56e;border-radius:6px;padding:0 14px;font:700 .85rem ui-monospace,monospace;cursor:pointer}button:hover{background:#e6a56e}
.preview{margin-top:10px;border-radius:8px;overflow:hidden;border:1px solid #684632;background:repeating-conic-gradient(#2a2420 0 25%,#1d1915 0 50%) 0 0/24px 24px}
.preview iframe{width:100%;height:100%;border:0;background:transparent;color-scheme:normal}
</style></head><body>
<h1>OBS overlays</h1><p>${escapeHtml(channelName)} · live GuildScribe panels for your stream</p>
<div class="note"><strong>Adding one to OBS</strong><ol><li>In OBS, add a <strong>Browser</strong> source to your scene.</li><li>Paste an overlay URL below and set the width/height shown next to it.</li><li>Leave the background transparent (OBS's default custom CSS is fine). Panels refresh on their own every few seconds.</li></ol>
<p style="margin-top:10px">Optional URL extras: <code>&amp;scale=1.5</code> (bigger/smaller), <code>&amp;align=right</code> or <code>center</code>, <code>&amp;refresh=10</code> (seconds between updates), <code>&amp;limit=3</code> (rows in leaderboards), <code>&amp;always=1</code> (show a placeholder while a panel is empty, handy for positioning). Panels for features you've switched off on your dashboard stay hidden.</p></div>
<div class="grid">${cards}</div>
<p style="margin-top:24px"><a href="${escapeHtml(baseUrl)}/roster?channel=${encodeURIComponent(channelId)}">Guild roster</a> · <a href="${escapeHtml(baseUrl)}/guide">Guild Codex</a></p>
<script>document.addEventListener("click",async(e)=>{const b=e.target.closest("button[data-copy]");if(!b)return;try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent="Copied!";}catch(_){b.textContent="Select & copy";}setTimeout(()=>{b.textContent="Copy"},1500);});</script>
</body></html>`;
}

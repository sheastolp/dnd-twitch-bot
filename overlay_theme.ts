// GuildScribe — the full-screen "theme" overlay: the whole stream layout in
// one OBS Browser source. A parchment sheet covers the 1920×1080 canvas with a
// torn-edged window cut out of it for the game capture (which sits *below*
// this source in OBS), the channel's name across the top (with the stream
// title as a subtitle under it in the brb and chat scenes), "Tavern Talk" chat
// down the right (messages fade out after a while), a d20 emblem (name
// banner optional) in the bottom-left, and the status strip in the bottom-right.
//
// Scenes (&scene=game|brb|chat, see overlay_scenes.ts) swap the middle of
// the sheet: gameplay, "be right back" and "just chatting" layouts with their
// own windows, a Dungeon Gate for pop-up overlays, and a card.
//
// Chat comes straight from Twitch's IRC websocket as an anonymous read-only
// guest (no token, nothing stored server-side). Everything viewer-supplied goes
// in through textContent, never innerHTML.
//
// URL extras (all optional): &fade=<seconds> before a chat line fades (default
// 30, 0 = never), &title=<text> instead of the channel name (which otherwise
// comes from Twitch, CamelCase split into words; &split=0 keeps it as-is),
// &subtitle=<text> instead of the stream title (brb and chat scenes only) (which otherwise follows the
// channel's current Twitch title, checked every couple of minutes;
// &subtitle=0 hides it),
// &hide=<login,login> chatters to leave out (bots),
// &hidecmds=1 to leave out "!command" messages, &status=0 to drop the strip,
// &mic=<part of the mic's name> to pick which microphone lights the emblem
// (default: the system default mic; &mic=off turns it off), &micfloor=<dB>
// and &micpeak=<dB> for the quiet/loud ends of the range (default -55/-18).
//
// Emblem: &emblem=<image URL> (or the older &logo=) replaces the d20 with your
// own badge or PNGtuber; add &talk=<image URL> and it swaps to that image
// while you talk (with a little bounce; &bounce=0 to keep it still) — a
// PNGtuber. &talkat=<0–1> sets how loud counts as talking (default .3),
// &size=<px> the emblem's size (default 200 d20 / 240 image, up to 520; it
// grows upward from the bottom-left corner), &ribbon=1 adds the red name
// banner under the emblem (off by default), &dim=0
// keeps it at full brightness while quiet.
//
// The emblem reacts to the mic: dim while you're quiet, brightening and
// glowing as you talk. If the mic can't be opened (no permission, no device)
// the emblem just stays at full brightness.

import { escapeHtml } from "./utils.ts";
import { ROLLER_BG } from "./scroll_theme.ts";
import { SCENES, SCENE_CLIENT, SCENE_CSS, sceneHtml, type Rect, type SceneDef } from "./overlay_scenes.ts";

const W = 1920, H = 1080;

/** Seeded PRNG so the torn edge is the same on every load (no shimmering between refreshes). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A torn-paper outline just inside a window. Three scales of tear: a
 * slow wander (the line of the rip), a small jitter every few pixels (the
 * ragged edge), and the odd bite or flap where the paper caught. The paper
 * always overlaps the capture (min inset 5 px, more than the fibre roughening
 * in ROUGH can pull it back), so the frame never shows a gap at the edge. */
function tornPath({ x, y, w, h }: Rect, seed: number): string {
  const r = rng(seed);
  let wander = 9, drift = 0, bite = 0, biteLen = 0, biteAt = 0;
  const step = () => {
    drift = drift * 0.9 + (r() - 0.5) * 1.1;
    wander = Math.max(6, Math.min(17, wander + drift));
    if (!biteLen && r() < 0.025) { biteLen = 3 + Math.floor(r() * 6); biteAt = 0; bite = (r() < 0.75 ? 1 : -0.6) * (5 + r() * 9); }
    let d = wander + (r() - 0.5) * 3.2;
    if (biteLen) { biteAt++; d += bite * Math.sin(Math.PI * biteAt / (biteLen + 1)); if (biteAt >= biteLen) biteLen = 0; }
    return Math.max(5, Math.min(28, d));
  };
  const pts: string[] = [];
  const pt = (px: number, py: number) => pts.push(`${px.toFixed(1)} ${py.toFixed(1)}`);
  const gap = () => 2.5 + r() * 4.5;
  // Each edge stops short of its corner, so the corners come out as small diagonal nicks rather than spikes.
  const c = 14;
  for (let p = x + c; p < x + w - c; p += gap()) pt(p, y + step());
  for (let p = y + c; p < y + h - c; p += gap()) pt(x + w - step(), p);
  for (let p = x + w - c; p > x + c; p -= gap()) pt(p, y + h - step());
  for (let p = y + h - c; p > y + c; p -= gap()) pt(x + step(), p);
  return `M${pts.join("L")}Z`;
}

const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
// Fibre roughening: fine noise pushes the cut edge around by a few pixels, so
// it frays instead of running in straight segments. The mask and every edge
// stroke below use this exact filter (same seed and region), so they line up.
const ROUGH = (id: string, q: string) =>
  `<filter id=${q}${id}${q} filterUnits=${q}userSpaceOnUse${q} x=${q}-40${q} y=${q}-40${q} width=${q}${W + 80}${q} height=${q}${H + 80}${q}><feTurbulence type=${q}fractalNoise${q} baseFrequency=${q}0.11${q} numOctaves=${q}3${q} seed=${q}4${q} result=${q}n${q}/><feDisplacementMap in=${q}SourceGraphic${q} in2=${q}n${q} scale=${q}7${q} xChannelSelector=${q}R${q} yChannelSelector=${q}G${q}/></filter>`;

/** A scene's cut-outs: every window torn out of one sheet (the outer edge runs
 * off-canvas so the fibre roughening never frays the screen border), and the
 * paper's shape as a mask — opaque everywhere except the torn windows. */
type Sheet = { holes: string; paper: string; mask: string };
const sheets = new Map<string, Sheet>();
function sheetFor(key: string, scene: SceneDef): Sheet {
  let sheet = sheets.get(key);
  if (!sheet) {
    const holes = scene.windows.map((w, i) => tornPath(w, 20 + i * 17)).join("");
    const paper = `M-40 -40H${W + 40}V${H + 40}H-40Z${holes}`;
    const mask = svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'><defs>${ROUGH("r", "'")}</defs><path fill-rule='evenodd' d='${paper}' filter='url(#r)'/></svg>`);
    sheet = { holes, paper, mask };
    sheets.set(key, sheet);
  }
  return sheet;
}
// Fine fibre grain and soft stains, brown at low alpha.
const GRAIN = svgUrl(
  `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' seed='5' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.45  0 0 0 0 0.32  0 0 0 0 0.1  0 0 0 0.3 -0.08'/></filter><rect width='100%' height='100%' filter='url(#g)'/></svg>`,
);
const STAINS = svgUrl(
  `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'><filter id='s'><feTurbulence type='fractalNoise' baseFrequency='0.006' numOctaves='3' seed='11' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.75  0 0 0 0 0.55  0 0 0 0 0.15  0 0 0 0.55 -0.2'/></filter><rect width='100%' height='100%' filter='url(#s)'/></svg>`,
);

// The d20 badge: dark green disc in a gold ring with a golden d20 on it.
const BADGE_SVG = `<svg viewBox="0 0 200 200" aria-hidden="true">
<defs><radialGradient id="bd" cx=".45" cy=".38" r=".7"><stop offset="0" stop-color="#3d5a46"/><stop offset="1" stop-color="#18281e"/></radialGradient>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3a8"/><stop offset=".5" stop-color="#f2c94c"/><stop offset="1" stop-color="#b8862a"/></linearGradient>
<linearGradient id="dd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff07a"/><stop offset="1" stop-color="#e7b923"/></linearGradient></defs>
<circle cx="100" cy="100" r="97" fill="url(#bg)"/><circle cx="100" cy="100" r="89" fill="#2a1a0c"/><circle cx="100" cy="100" r="86" fill="url(#bd)"/>
<circle cx="100" cy="100" r="78" fill="none" stroke="#f2c94c" stroke-width="1.5" stroke-dasharray="2 5" opacity=".7"/>
<polygon points="100,38 152,68 152,128 100,158 48,128 48,68" fill="url(#dd)" stroke="#7a5512" stroke-width="2.5"/>
<polygon points="100,62 128,110 72,110" fill="none" stroke="#a87a16" stroke-width="2"/>
<path d="M100 38L100 62M152 68L128 110M48 68L72 110M100 158L128 110M100 158L72 110M48 128L72 110M152 128L128 110M100 62L48 68M100 62L152 68" stroke="#a87a16" stroke-width="1.6" fill="none"/>
<text x="100" y="101" text-anchor="middle" font-family="Cinzel,Georgia,serif" font-weight="700" font-size="22" fill="#4a2f08">20</text>
<path d="M58 52l3 6 6 3-6 3-3 6-3-6-6-3 6-3z M146 46l2 4 4 2-4 2-2 4-2-4-4-2 4-2z" fill="#fff8d0"/>
</svg>`;

const STYLE = `
:root{--ink:#3b2814;--ink2:#6b4419;--gold:#c99a2e;--gold2:#e8c25a;--seal:#d9473a}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
#stage{position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:0 0;font-family:"EB Garamond",Georgia,serif;color:var(--ink)}
.paper{position:absolute;inset:0;
  background:${STAINS} 0 0/${W}px ${H}px no-repeat,${GRAIN} 0 0/240px 240px,
    radial-gradient(ellipse at 8% 6%,#fffef8 0,#fffdf3 22%,transparent 55%),
    radial-gradient(ellipse at 100% 0%,#f9e27c 0,transparent 45%),
    radial-gradient(ellipse at 96% 100%,#f4d870 0,transparent 50%),
    linear-gradient(115deg,#fffaf0 0%,#fdf3cf 40%,#f8e7a0 75%,#f3d97c 100%);
  -webkit-mask:var(--sheet) 0 0/${W}px ${H}px no-repeat;mask:var(--sheet) 0 0/${W}px ${H}px no-repeat}
.edges{position:absolute;inset:0;pointer-events:none}
/* The Codex's scroll rollers, top and bottom; the paper darkens as it curls onto them. */
.curl{position:absolute;left:0;right:0;height:70px;pointer-events:none;background:linear-gradient(180deg,#5a3a1640,#5a3a1614 40%,transparent)}
.curl.bot{bottom:0;transform:scaleY(-1)}
.roller{position:absolute;left:0;right:0;height:48px;pointer-events:none;background:${ROLLER_BG};filter:drop-shadow(0 7px 7px #0009)}
.roller.top{top:-4px}.roller.bot{bottom:-4px;filter:drop-shadow(0 -5px 7px #0007)}
.title{position:absolute;left:0;right:0;top:56px;display:flex;flex-direction:column;align-items:center;gap:3px}
.title.sub{top:47px}
.title .name{display:flex;justify-content:center;align-items:center;gap:18px;
  font:700 36px/1 Cinzel,Georgia,serif;letter-spacing:.08em;text-transform:uppercase;color:var(--ink2);text-shadow:0 1px 0 #fff8,0 2px 6px #c99a2e40}
.title .subtitle{max-width:1360px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;
  font:italic 500 19px/1.1 "EB Garamond",Georgia,serif;letter-spacing:.02em;color:#8a6424;text-shadow:0 1px 0 #fff8}
.gem{width:20px;height:20px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffb3a6,var(--seal) 55%,#8e1d14);box-shadow:0 0 10px #e9191680;animation:pulse 2.4s ease-in-out infinite}
.chat{position:absolute;left:1528px;top:100px;width:372px;height:846px;display:flex;flex-direction:column;will-change:transform;
  background:transparent;border-radius:4px;box-shadow:inset 0 0 0 1px #c99a2e80,inset 0 0 0 5px transparent,inset 0 0 0 6px #c99a2e40}
.chat header{text-align:center;padding:22px 20px 14px}
.chat h2{margin:0;font:700 30px/1.1 Cinzel,Georgia,serif;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2)}
.chat header p{margin:6px 0 0;font:italic 16px/1.2 "EB Garamond",Georgia,serif;color:#a98235}
.chat header::after{content:"";display:block;height:2px;margin:14px 18px 0;background:linear-gradient(90deg,transparent,var(--gold),transparent)}
.msgs{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:10px;padding:8px 20px 20px}
.msg{font-size:22px;line-height:1.3;overflow-wrap:anywhere;animation:in .45s ease-out;transition:opacity .9s ease,transform .9s ease}
.msg b{font-weight:600}.msg .sep{color:#a98235}.msg.me .txt{font-style:italic}
.msg img{height:1.35em;vertical-align:-.3em;margin:0 1px}
.msg.out{opacity:0;transform:translateX(24px)}
.msg.note{color:#a98235;font-style:italic;font-size:18px;text-align:center}
.badge{position:absolute;left:22px;bottom:74px;width:250px;display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 6px 10px #5a3a0f55)}
.badge.custom{width:auto;min-width:250px}
#badge{position:relative;width:var(--size,200px);height:var(--size,200px);transform-origin:50% 100%}
#badge svg,#badge img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
#badge .talk{visibility:hidden}#badge.talking .talk{visibility:visible}#badge.talking .idle{visibility:hidden}
#badge.bounce.talking{animation:bob .32s ease-in-out infinite alternate}
/* Mic-reactive emblem: --lvl runs 0 (silence) to 1 (loud), set every frame by the client. */
#badge.mic{filter:brightness(calc(.42 + var(--lvl,0) * .78)) saturate(calc(.7 + var(--lvl,0) * .5)) drop-shadow(0 0 calc(var(--lvl,0) * 26px) #ffd76acc)}
#badge.mic.nodim{filter:drop-shadow(0 0 calc(var(--lvl,0) * 26px) #ffd76acc)}
@keyframes bob{from{transform:translateY(0)}to{transform:translateY(-8px)}}
.ribbon{margin-top:-26px;position:relative;padding:6px 34px 8px;background:linear-gradient(180deg,#e2574a,#b8302a);color:#fff7e6;
  font:700 22px/1 Cinzel,Georgia,serif;letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;text-shadow:0 1px 1px #5a0e0a;
  clip-path:polygon(0 0,100% 0,calc(100% - 16px) 50%,100% 100%,0 100%,16px 50%)}
.rule{position:absolute;left:290px;right:16px;top:952px;height:1px;background:linear-gradient(90deg,var(--gold),#c99a2e40 40%,transparent)}
.status{position:absolute;right:12px;bottom:46px;width:1200px;height:70px;border:0;background:transparent}
@keyframes in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes pulse{50%{opacity:.55;box-shadow:0 0 4px #e9191640}}
${SCENE_CSS}`;

// The client: fits the stage to the window, then runs the chat. Plain ES2017, no build step.
const CLIENT = `
const Q=new URLSearchParams(location.search);const CFG=window.__THEME__;
const stage=document.getElementById("stage");
function fit(){const s=Math.min(innerWidth/${W},innerHeight/${H});stage.style.transform="translate("+(innerWidth-${W}*s)/2+"px,"+(innerHeight-${H}*s)/2+"px) scale("+s+")"}
fit();addEventListener("resize",fit);
const preview=Q.get("always")==="1";
const fadeQ=Q.get("fade");const fade=fadeQ!=null&&Number.isFinite(Number(fadeQ))?Math.max(0,Math.min(3600,Number(fadeQ))):30;
const hidden=new Set((Q.get("hide")||"").toLowerCase().split(",").map(s=>s.trim().replace(/^@/,"")).filter(Boolean));
const hideCmds=Q.get("hidecmds")==="1";
// The channel's current Twitch display name; StonedSheamus -> "Stoned Sheamus" unless &split=0.
const autoTitle=Q.get("split")==="0"?CFG.name:CFG.name.replace(/_+/g," ").replace(/([a-z0-9])([A-Z])/g,"$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g,"$1 $2").trim();
const title=Q.get("title")||autoTitle;
document.getElementById("title").textContent=title;
// The stream title under the name: &subtitle=<text> pins it, &subtitle=0 hides
// it, otherwise it follows Twitch (checked every 2 minutes).
// Only the be-right-back and just-chatting scenes carry it (no #subtitle in gameplay).
const subEl=document.getElementById("subtitle"),subQ=Q.get("subtitle");
function setSub(t){t=(t||"").trim();subEl.textContent=t;subEl.title=t;subEl.hidden=!t;subEl.parentElement.classList.toggle("sub",!!t)}
if(!subEl||subQ==="0"){}else if(subQ)setSub(subQ);else{
  setSub(CFG.streamTitle);
  setInterval(()=>{fetch("/overlay/title?channel="+encodeURIComponent(CFG.channel)).then(r=>r.ok?r.json():null).then(d=>{if(d&&d.ok)setSub(d.title)}).catch(()=>{})},120000)}
document.getElementById("chatsub").textContent="words from "+CFG.name+"'s common room";
const rib=document.getElementById("ribbon");rib.textContent=title;rib.style.fontSize=Math.max(12,Math.min(22,330/Math.max(1,title.length)))+"px";
// The emblem: the d20, or your own image (+ an optional talking image for a PNGtuber).
const badge=document.getElementById("badge");
const imgUrl=k=>{try{const u=new URL(Q.get(k)||"");return u.protocol==="https:"||u.protocol==="http:"?u.href:null}catch(e){return null}};
const idleUrl=imgUrl("emblem")||imgUrl("logo"), talkUrl=imgUrl("talk");
if(idleUrl){const img=h("img","idle");img.alt="";img.src=idleUrl;badge.replaceChildren(img);badge.parentElement.classList.add("custom");
  if(talkUrl){const t=h("img","talk");t.alt="";t.src=talkUrl;badge.append(t);if(Q.get("bounce")!=="0")badge.classList.add("bounce")}}
if(Q.get("ribbon")!=="1")rib.remove(); // the name banner is opt-in
const sizeQ=Number(Q.get("size"));badge.style.setProperty("--size",(Number.isFinite(sizeQ)&&sizeQ>0?Math.max(80,Math.min(520,sizeQ)):idleUrl?240:200)+"px");
if(Q.get("dim")==="0")badge.classList.add("nodim");
const talkAt=(v=>Number.isFinite(v)&&v>0&&v<1?v:.3)(Number(Q.get("talkat")));
if(Q.get("status")==="0")document.getElementById("status").remove();
else document.getElementById("status").src="/overlay?channel="+encodeURIComponent(CFG.channel)+"&panel=status&align=right&refresh=10"+(preview?"&always=1":"");
// OBS keeps every scene's browser sources running; the embedded panels (status
// strip, Guild Board) can't hear OBS's events, so park them while this scene
// isn't showing and bring them back when it is.
let obsActive=true,obsVisible=true;
function obsPark(){const off=!obsActive&&!obsVisible;for(const f of document.querySelectorAll("iframe[src],iframe[data-parked]")){
  if(off&&f.getAttribute("src")&&f.getAttribute("src")!=="about:blank"){f.dataset.parked=f.getAttribute("src");f.src="about:blank"}
  else if(!off&&f.dataset.parked){f.src=f.dataset.parked;delete f.dataset.parked}}}
addEventListener("obsSourceActiveChanged",e=>{obsActive=!!(e.detail&&e.detail.active);obsPark()});
addEventListener("obsSourceVisibleChanged",e=>{obsVisible=!!(e.detail&&e.detail.visible);obsPark()});

const list=document.getElementById("msgs");
function h(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e}
// Twitch names can be any colour; darken pale ones so they read on parchment.
const INKS=["#8e2a1c","#1f5c3a","#24467a","#6d2f86","#8a5a12","#2f6b6b","#7a2948"];
function ink(hex,name){let m=/^#([0-9a-f]{6})$/i.exec(hex||"");if(!m){let n=0;for(const c of name)n=(n*31+c.charCodeAt(0))>>>0;return INKS[n%INKS.length]}
  let r=parseInt(m[1].slice(0,2),16)/255,g=parseInt(m[1].slice(2,4),16)/255,b=parseInt(m[1].slice(4),16)/255;
  const mx=Math.max(r,g,b),mn=Math.min(r,g,b);let hh=0,s=0,l=(mx+mn)/2;
  if(mx!==mn){const d=mx-mn;s=l>.5?d/(2-mx-mn):d/(mx+mn);hh=mx===r?(g-b)/d+(g<b?6:0):mx===g?(b-r)/d+2:(r-g)/d+4;hh*=60}
  return "hsl("+Math.round(hh)+","+Math.round(Math.min(s,.8)*100)+"%,"+Math.round(Math.min(l,.36)*100)+"%)"}
// Bottom-anchored lists overflow upward (scrollHeight never grows), so drop lines whose top has left the panel.
function trim(){const top=list.getBoundingClientRect().top;while(list.children.length>1&&list.firstElementChild.getBoundingClientRect().top<top)list.firstElementChild.remove()}
function retire(el){if(!fade||preview)return;setTimeout(()=>{el.classList.add("out");setTimeout(()=>el.remove(),950)},fade*1000)}
function emoteNodes(text,spec){const cps=Array.from(text);const out=[];const marks=[];
  if(spec)for(const part of spec.split("/")){const [id,ranges]=part.split(":");if(!ranges||!/^[\\w-]+$/.test(id))continue;
    for(const r of ranges.split(",")){const [a,b]=r.split("-").map(Number);if(Number.isFinite(a)&&Number.isFinite(b))marks.push([a,b,id])}}
  marks.sort((x,y)=>x[0]-y[0]);let i=0;
  for(const [a,b,id] of marks){if(a<i)continue;if(a>i)out.push(document.createTextNode(cps.slice(i,a).join("")));
    const img=h("img");img.alt=cps.slice(a,b+1).join("");img.src="https://static-cdn.jtvnw.net/emoticons/v2/"+id+"/default/light/2.0";out.push(img);i=b+1}
  if(i<cps.length)out.push(document.createTextNode(cps.slice(i).join("")));return out}
function addMsg(m){const el=h("div","msg"+(m.me?" me":""));el.dataset.id=m.id||"";el.dataset.user=m.userId||"";
  const n=h("b",null,m.name);n.style.color=ink(m.color,m.name);el.append(n,h("span","sep",m.me?" ":": "));
  const t=h("span","txt");t.append(...emoteNodes(m.text,m.emotes));el.append(t);list.append(el);trim();retire(el)}
function note(text){const el=h("div","msg note",text);list.append(el);trim();retire(el)}

if(preview){addMsg({name:"Adventurer",color:"#1E90FF",text:"Chat messages appear here and fade after "+(fade||"never")+(fade?"s":"")+"."});
  addMsg({name:CFG.name,color:"#FF4500",text:"Welcome to the tavern, friends!"})}

// ── Twitch chat over IRC websocket, as an anonymous read-only guest ──
const unesc=v=>v.replace(/\\\\(.)/g,(_,c)=>c==="s"?" ":c===":"?";":c==="r"?"\\r":c==="n"?"\\n":c);
function parse(line){let tags={},rest=line;
  if(rest[0]==="@"){const sp=rest.indexOf(" ");for(const kv of rest.slice(1,sp).split(";")){const eq=kv.indexOf("=");tags[eq<0?kv:kv.slice(0,eq)]=eq<0?"":unesc(kv.slice(eq+1))}rest=rest.slice(sp+1)}
  let prefix="";if(rest[0]===":"){const sp=rest.indexOf(" ");prefix=rest.slice(1,sp);rest=rest.slice(sp+1)}
  const ci=rest.indexOf(" :");const trail=ci<0?null:rest.slice(ci+2);const parts=(ci<0?rest:rest.slice(0,ci)).split(" ");
  return {tags,nick:prefix.split("!")[0],cmd:parts[0],params:parts.slice(1),trail}}
let ws=null,backoff=1000;
function connect(){if(!CFG.login){note("Chat needs the channel's Twitch login.");return}
  ws=new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ws.onopen=()=>{backoff=1000;ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");ws.send("PASS SCHMOOPIIE");ws.send("NICK justinfan"+(10000+Math.floor(Math.random()*80000)));ws.send("JOIN #"+CFG.login)};
  ws.onmessage=e=>{for(const line of String(e.data).split("\\r\\n")){if(!line)continue;const m=parse(line);
    if(m.cmd==="PING"){ws.send("PONG :"+(m.trail||"tmi.twitch.tv"));continue}
    if(m.cmd==="RECONNECT"){ws.close();continue}
    if(m.cmd==="PRIVMSG"){let text=m.trail||"";const me=/^\\u0001ACTION (.*)\\u0001$/.exec(text);if(me)text=me[1];
      const login=(m.tags.login||m.nick||"").toLowerCase();
      if(hidden.has(login)||(hideCmds&&text.trim()[0]==="!"))continue;
      addMsg({id:m.tags.id,userId:m.tags["user-id"],name:m.tags["display-name"]||m.nick,color:m.tags.color,emotes:m.tags.emotes,text,me:!!me})}
    else if(m.cmd==="CLEARMSG"){const id=m.tags["target-msg-id"];for(const el of [...list.children])if(id&&el.dataset.id===id)el.remove()}
    else if(m.cmd==="CLEARCHAT"){const uid=m.tags["target-user-id"];for(const el of [...list.children])if(!uid||el.dataset.user===uid)el.remove()}}};
  ws.onclose=()=>{setTimeout(connect,backoff);backoff=Math.min(backoff*2,30000)};
  ws.onerror=()=>{try{ws.close()}catch(e){}}}
connect();

// ── Mic-reactive emblem ──
const micQ=(Q.get("mic")||"").trim();
const dbNum=(k,d)=>{const v=Number(Q.get(k));return Q.get(k)!=null&&Number.isFinite(v)&&v<0?v:d};
const floor=dbNum("micfloor",-55), peak=Math.max(floor+5,dbNum("micpeak",-18));
async function micStream(){
  const open=id=>navigator.mediaDevices.getUserMedia({audio:{deviceId:id?{exact:id}:undefined,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
  if(!micQ)return open();
  // Labels only show up once mic permission is granted, so open the default first, then look for the named one.
  const first=await open();const want=micQ.toLowerCase();
  const dev=(await navigator.mediaDevices.enumerateDevices()).find(d=>d.kind==="audioinput"&&d.label.toLowerCase().includes(want));
  if(!dev)return first;
  first.getTracks().forEach(t=>t.stop());return open(dev.deviceId)}
async function startMic(){
  if(micQ.toLowerCase()==="off"||!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)return;
  let stream;try{stream=await micStream()}catch(e){return}
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  const an=ctx.createAnalyser();an.fftSize=1024;ctx.createMediaStreamSource(stream).connect(an);
  const buf=new Float32Array(an.fftSize);let lvl=0;
  badge.classList.add("mic");
  (function frame(){
    if(ctx.state==="suspended")ctx.resume().catch(()=>{});
    an.getFloatTimeDomainData(buf);let sum=0;for(let i=0;i<buf.length;i++)sum+=buf[i]*buf[i];
    const db=20*Math.log10(Math.sqrt(sum/buf.length)+1e-9);
    const target=Math.max(0,Math.min(1,(db-floor)/(peak-floor)));
    // Snap up fast when you speak, ease back down slowly so it doesn't flicker between words.
    lvl+=(target-lvl)*(target>lvl?0.45:0.06);
    badge.style.setProperty("--lvl",lvl.toFixed(3));
    // PNGtuber swap, with a little hysteresis so the mouth doesn't chatter at the threshold.
    if(talkUrl){const on=badge.classList.contains("talking");if(!on&&lvl>=talkAt)badge.classList.add("talking");else if(on&&lvl<talkAt*0.6)badge.classList.remove("talking")}
    requestAnimationFrame(frame)})()}
startMic();
${SCENE_CLIENT}`;

export function renderThemePage(channelKey: string, login: string, name: string, sceneKey = "game", streamTitle = ""): string {
  if (!(sceneKey in SCENES)) sceneKey = "game";
  const scene = SCENES[sceneKey];
  const { holes: HOLE, paper: PAPER, mask } = sheetFor(sceneKey, scene);
  const cfg = { channel: channelKey, login: login.toLowerCase(), name, streamTitle };
  // JSON inside <script>: escape "<" so a value can never close the tag.
  const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");
  // Edge shading, all through the same ROUGH filter as the mask: a shadow the
  // lifted paper casts onto the game, an aged brown band soaking into the
  // paper, a scorched rim, and a pale fringe of torn fibres right at the tear.
  const edges = `<svg class="edges" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><defs>${ROUGH("rough", '"')}
<filter id="fibres" filterUnits="userSpaceOnUse" x="-40" y="-40" width="${W + 80}" height="${H + 80}"><feTurbulence type="fractalNoise" baseFrequency="0.11" numOctaves="3" seed="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="7" xChannelSelector="R" yChannelSelector="G" result="d"/><feTurbulence type="fractalNoise" baseFrequency="0.9 0.35" numOctaves="2" seed="9" result="f"/><feColorMatrix in="f" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 2.6 -1.1" result="fa"/><feComposite in="d" in2="fa" operator="in"/></filter>
<filter id="soft" filterUnits="userSpaceOnUse" x="-40" y="-40" width="${W + 80}" height="${H + 80}"><feGaussianBlur stdDeviation="4"/></filter>
<filter id="wide" filterUnits="userSpaceOnUse" x="-40" y="-40" width="${W + 80}" height="${H + 80}"><feGaussianBlur stdDeviation="14"/></filter>
<mask id="onpaper" maskUnits="userSpaceOnUse" x="-40" y="-40" width="${W + 80}" height="${H + 80}"><path fill="#fff" fill-rule="evenodd" d="${PAPER}" filter="url(#rough)"/></mask>
<mask id="ongame" maskUnits="userSpaceOnUse" x="-40" y="-40" width="${W + 80}" height="${H + 80}"><path fill="#fff" d="${HOLE}" filter="url(#rough)"/></mask></defs>
<g stroke-linejoin="round" fill="none">
<g mask="url(#ongame)"><path d="${HOLE}" stroke="#1a0e04" stroke-width="30" opacity=".55" filter="url(#wide)"/></g>
<g mask="url(#onpaper)"><path d="${HOLE}" stroke="#a06a1c" stroke-width="60" opacity=".32" filter="url(#wide)"/>
<path d="${HOLE}" stroke="#8a5718" stroke-width="12" opacity=".4" filter="url(#soft)"/>
<path d="${HOLE}" stroke="#5e3a10" stroke-width="3.2" opacity=".8" filter="url(#rough)"/></g>
<path d="${HOLE}" stroke="#fffbea" stroke-width="2.6" opacity=".95" filter="url(#fibres)"/>
</g></svg>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GuildScribe theme · ${escapeHtml(scene.label)} · ${escapeHtml(name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=EB+Garamond:ital,wght@0,400;0,600;1,400&display=swap">
<style>${STYLE}#stage{--sheet:${mask}}</style></head><body><div id="stage"><div class="paper"></div>${edges}<div class="curl"></div><div class="curl bot"></div>
<div class="title"><div class="name"><i class="gem"></i><span id="title"></span></div>${sceneKey === "game" ? "" : `<div class="subtitle" id="subtitle" hidden></div>`}</div>
<section class="chat"><header><h2>Tavern Talk</h2><p id="chatsub"></p></header><div class="msgs" id="msgs"></div></section>
${scene.rule ? `<div class="rule"></div>` : ""}${sceneHtml(scene)}<iframe class="status" id="status" title="status" scrolling="no"></iframe>
<div class="roller top"></div><div class="roller bot"></div>
<div class="badge"><div id="badge">${BADGE_SVG}</div><div class="ribbon" id="ribbon"></div></div>
</div><script>window.__THEME__=${cfgJson};${CLIENT}</script></body></html>`;
}

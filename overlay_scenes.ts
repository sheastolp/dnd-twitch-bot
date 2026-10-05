// GuildScribe — the theme overlay's scenes (see overlay_theme.ts). Every scene
// shares the parchment, rollers, title, Tavern Talk chat, emblem and status
// strip; what changes is the middle of the sheet:
//
//   game  — one big torn window for the game capture.
//   brb   — "Be right back": a torn window for Words on Stream, the Dungeon
//           Gate (a framed spot for pop-up overlays such as Tangia dungeons),
//           a card with rotating flavour lines and an optional countdown, and
//           the Battle Tracker beside it.
//   chat  — "Just chatting": a big torn window for Words on Stream, the
//           Dungeon Gate (16:9, so a full-canvas pop-up source scales into it
//           exactly), the Guild Board — GuildScribe's own panels (raid boss,
//           leaderboards, roll call, guild summary) taking turns, drawn by the
//           theme itself, no extra source — a topic card, and the Battle
//           Tracker under it.
//
// The Battle Tracker (brb and chat) is GuildScribe's battle panel — the fight
// under way and the recent results — drawn by the theme like the Guild Board
// and shrunk to fit its frame; the board then skips that panel.
//
// Windows are cut out of the paper, so their sources go *below* the theme in
// OBS (the torn edge overlaps them). The Dungeon Gate is drawn on the paper,
// so pop-up overlays go *above* the theme and sit inside it; when nothing is
// playing the gate is just a quiet frame. Positions are on the 1920×1080
// canvas and listed on the /overlays setup page.
//
// Scene extras: &gate=<label> renames the Dungeon Gate; brb: &minutes=<n>
// counts down ("Back in 4:59"), &brbtext=<line> replaces the rotating lines;
// chat: &topic=<text> for the topic card, &cycle=<seconds> for the Guild
// Board's pace (default 15), &board=0 to leave the board empty;
// both: &tracker=0 to leave the Battle Tracker empty.

export type Rect = { x: number; y: number; w: number; h: number };
export type SceneWindow = Rect & { id: string; label: string };
export type SceneDef = {
  label: string;
  windows: SceneWindow[];
  gate?: Rect;
  card?: Rect & { kind: "brb" | "chat" };
  board?: Rect;
  tracker?: Rect;
  rule?: boolean;
};

export const SCENES: Record<string, SceneDef> = {
  game: {
    label: "Gameplay",
    windows: [{ id: "game", label: "Game capture", x: 64, y: 112, w: 1440, h: 810 }],
    rule: true,
  },
  brb: {
    label: "Be right back",
    windows: [{ id: "wos", label: "Words on Stream", x: 64, y: 112, w: 1040, h: 585 }],
    gate: { x: 1128, y: 112, w: 376, h: 585 },
    card: { kind: "brb", x: 300, y: 722, w: 700, h: 224 },
    tracker: { x: 1024, y: 722, w: 480, h: 224 },
  },
  chat: {
    label: "Just chatting",
    windows: [{ id: "wos", label: "Words on Stream", x: 64, y: 112, w: 864, h: 486 }],
    gate: { x: 952, y: 112, w: 552, h: 311 },
    board: { x: 952, y: 447, w: 552, h: 499 },
    card: { kind: "chat", x: 300, y: 622, w: 628, h: 112 },
    tracker: { x: 300, y: 756, w: 628, h: 190 },
  },
};

const box = (r: Rect) => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;

export const SCENE_CSS = `
.slot-hint{position:absolute;display:flex;align-items:center;justify-content:center;font:700 28px/1.2 Cinzel,Georgia,serif;letter-spacing:.06em;color:#fff8;text-transform:uppercase;text-align:center;pointer-events:none}
.gate{position:absolute;border:2px dashed #c99a2e99;border-radius:10px;box-shadow:inset 0 0 0 6px #fff3,inset 0 0 40px #b07a2222}
.gate::before,.gate::after{content:"◆";position:absolute;color:var(--gold);font-size:16px;line-height:1}
.gate::before{left:-9px;top:-10px}
.gate::after{right:-9px;bottom:-10px}
.gate .plaque,.board .plaque,.tracker .plaque{position:absolute;left:50%;top:-19px;transform:translateX(-50%);padding:6px 26px 7px;white-space:nowrap;
  background:linear-gradient(180deg,#fffaf0,#f6e3a6);border:1px solid #c99a2e;border-radius:4px;box-shadow:0 2px 6px #8a5a1830;
  font:700 18px/1 Cinzel,Georgia,serif;letter-spacing:.1em;text-transform:uppercase;color:var(--ink2)}
.gate .empty,.board .empty,.tracker .empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#a98235;opacity:.55;font:italic 22px/1.3 "EB Garamond",Georgia,serif;text-align:center;padding:20px}
.gate .empty b,.board .empty b,.tracker .empty b{font:400 46px/1 Georgia,serif;font-style:normal}
.board,.tracker{position:absolute;border:1px solid #c99a2e80;border-radius:10px;box-shadow:inset 0 0 0 5px #fff2,inset 0 0 0 6px #c99a2e40}
.board .empty[hidden],.tracker .empty[hidden]{display:none}
.tracker .empty{flex-direction:row;font-size:20px;padding:30px 14px 10px}.tracker .empty b{font-size:30px}
.board iframe,.tracker iframe{position:absolute;inset:28px 6px 6px;width:calc(100% - 12px);height:calc(100% - 34px);border:0;background:transparent}
.scard{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:16px 28px}
.scard h1{margin:0;font:700 74px/1 Cinzel,Georgia,serif;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2);text-shadow:0 1px 0 #fff8,0 3px 10px #c99a2e50}
.scard .flourish{width:62%;height:14px;margin:12px 0 10px;background:linear-gradient(90deg,transparent,var(--gold) 30%,var(--gold) 70%,transparent) center/100% 1px no-repeat;position:relative}
.scard .flourish::after{content:"❦";position:absolute;left:50%;top:50%;transform:translate(-50%,-52%);padding:0 10px;background:#fbefc3;color:var(--gold);font-size:20px;border-radius:50%}
.scard .line{font:italic 30px/1.3 "EB Garamond",Georgia,serif;color:#6b4a22;transition:opacity .6s ease;min-height:1.3em}
.scard .line.swap{opacity:0}
.scard .count{margin-top:8px;font:600 28px/1 Cinzel,Georgia,serif;letter-spacing:.06em;color:var(--seal)}
/* The gate's plaque sits right, clear of the stream-title subtitle centred above. */
.gate .plaque{left:auto;right:18px;transform:none}
.scard.sc-brb h1{font-size:64px}
.scard.sc-chat{padding:6px 20px}.scard.sc-chat h1{font-size:44px}.scard.sc-chat .flourish{margin:6px 0 4px}.scard.sc-chat .line{font-size:24px}
`;

/** The scene's panels (drawn on the paper) and, in previews, labels for its windows. */
export function sceneHtml(scene: SceneDef): string {
  const hints = scene.windows.map((w) => `<div class="slot-hint" data-hint style="${box(w)}">${w.label}<br>goes here</div>`).join("");
  const gate = scene.gate
    ? `<div class="gate" style="${box(scene.gate)}"><div class="plaque" id="gatelabel">Dungeon Gate</div><div class="empty"><b>⚔</b><span>Adventures appear here</span></div></div>`
    : "";
  const board = scene.board
    ? `<div class="board" style="${box(scene.board)}"><div class="plaque">Guild Board</div><div class="empty"><b>📜</b><span>Guild notices appear here</span></div><iframe id="board" title="Guild Board" scrolling="no"></iframe></div>`
    : "";
  const tracker = scene.tracker
    ? `<div class="tracker" style="${box(scene.tracker)}"><div class="plaque">Battle Tracker</div><div class="empty"><b>⚔</b><span>No battles yet — !dndduel to start one</span></div><iframe id="tracker" title="Battle Tracker" scrolling="no"></iframe></div>`
    : "";
  let card = "";
  if (scene.card?.kind === "brb") {
    card = `<div class="scard sc-brb" style="${box(scene.card)}"><h1>Be Right Back</h1><div class="flourish"></div><div class="line" id="brbline"></div><div class="count" id="brbcount" hidden></div></div>`;
  } else if (scene.card?.kind === "chat") {
    card = `<div class="scard sc-chat" style="${box(scene.card)}"><h1>Just Chatting</h1><div class="flourish"></div><div class="line" id="topic"></div></div>`;
  }
  return hints + gate + board + tracker + card;
}

// Scene behaviour in the client (runs after the theme's own client; h() and Q are in scope).
export const SCENE_CLIENT = `
if(!preview)document.querySelectorAll("[data-hint]").forEach(e=>e.remove());
const gl=document.getElementById("gatelabel");if(gl&&Q.get("gate"))gl.textContent=Q.get("gate");
const boardEl=document.getElementById("board");
if(boardEl){if(Q.get("board")==="0")boardEl.remove();else{const cyc=Number(Q.get("cycle"));
  boardEl.src="/overlay?channel="+encodeURIComponent(CFG.channel)+"&panel=rotate&align=center&refresh=10&cycle="+(Number.isFinite(cyc)&&cyc>=4?Math.min(cyc,120):15)+(document.getElementById("tracker")&&Q.get("tracker")!=="0"?"&skip=battle":"")+(preview?"&always=1":"");
  // Same origin, so peek in: hide the "notices appear here" line while a panel is up.
  const boardEmpty=boardEl.parentElement.querySelector(".empty");
  setInterval(()=>{try{const r=boardEl.contentDocument&&boardEl.contentDocument.getElementById("root");boardEmpty.hidden=!!(r&&r.children.length)}catch(e){}},1500)}}
const trackerEl=document.getElementById("tracker");
if(trackerEl){if(Q.get("tracker")==="0")trackerEl.remove();else{
  trackerEl.src="/overlay?channel="+encodeURIComponent(CFG.channel)+"&panel=battle&align=center&refresh=8"+(preview?"&always=1":"");
  // Same origin: hide the empty line while a card is up, and fit the cards to
  // the frame — stacked or side by side, whichever needs less shrinking.
  const trEmpty=trackerEl.parentElement.querySelector(".empty");
  setInterval(()=>{try{const doc=trackerEl.contentDocument,r=doc&&doc.getElementById("root");if(!r)return;
    trEmpty.hidden=!!r.children.length;if(!r.children.length)return;
    r.style.transform="none";r.style.maxWidth="none";r.style.margin="0";r.style.transformOrigin="top left";
    const W=trackerEl.clientWidth,H=trackerEl.clientHeight,pad=10; // the panel page's body padding
    const fit=()=>Math.min(1,(W-2*pad)/Math.max(1,r.scrollWidth),(H-2*pad)/Math.max(1,r.scrollHeight));
    r.style.flexDirection="column";r.style.alignItems="center";const col=fit();
    r.style.flexDirection="row";r.style.alignItems="flex-start";const row=fit();
    if(col>=row){r.style.flexDirection="column";r.style.alignItems="center"}
    const s=Math.max(col,row),x=(W-r.scrollWidth*s)/2-pad;
    r.style.transform="translateX("+x.toFixed(1)+"px) scale("+s.toFixed(3)+")"}catch(e){}},1000)}}
const topicEl=document.getElementById("topic");if(topicEl)topicEl.textContent=Q.get("topic")||"Pull up a chair by the hearth — the kettle's on.";
const brbLine=document.getElementById("brbline");
if(brbLine){
  const LINES=["The party is taking a short rest.","The bard went to restring the lute.","The DM is fetching more dice.","Spending hit dice on snacks.","The wizard is re-reading their spellbook.","Someone has to feed the owlbear.","Rolling initiative against the kettle.","The rogue is “just checking” the other room."];
  const own=Q.get("brbtext");let i=Math.floor(Math.random()*LINES.length);brbLine.textContent=own||LINES[i];
  if(!own)setInterval(()=>{brbLine.classList.add("swap");setTimeout(()=>{i=(i+1)%LINES.length;brbLine.textContent=LINES[i];brbLine.classList.remove("swap")},650)},12000);
  const mins=Number(Q.get("minutes"));
  if(Number.isFinite(mins)&&mins>0){const end=Date.now()+Math.min(mins,600)*60000;const c=document.getElementById("brbcount");c.hidden=false;
    const tick=()=>{const s=Math.max(0,Math.round((end-Date.now())/1000));c.textContent=s?"⌛ Back in "+Math.floor(s/60)+":"+String(s%60).padStart(2,"0"):"⌛ Any moment now…"};tick();setInterval(tick,1000)}
}
`;

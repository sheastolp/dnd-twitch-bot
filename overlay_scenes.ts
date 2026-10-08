// GuildScribe — the theme overlay's scenes (see overlay_theme.ts). Every scene
// shares the parchment, rollers, title, Tavern Talk chat and emblem; what
// changes is the middle of the sheet:
//
//   game  — one big torn window for the game capture, and the status strip
//           (with suggested next steps) along the bottom.
//   brb   — "Be right back": a torn window with The Endless Delve in it (the
//           idle game chat plays, idle.ts — or, with &idle=0, an empty
//           window for your own source such as Words on Stream), the Dungeon
//           Gate (a framed spot for pop-up overlays such as Tangia dungeons),
//           a card with rotating flavour lines and an optional countdown,
//           the Saving Throws tally under the card, and the Battle Tracker
//           across the bottom right, under the gate and a shortened Tavern
//           Talk.
//   chat  — "Just chatting": a big torn window with The Endless Delve (or,
//           with &idle=0, for Words on Stream or another source), the
//           Dungeon Gate (16:9, so a full-canvas pop-up source scales into it
//           exactly), the Battle Tracker under it (cards drawn larger and
//           stacked from the bottom up, level with the goldboard's card at the
//           foot of Tavern Talk), and a topic card with the Saving Throws
//           tally under it.
//   start — "Starting soon": the brb layout (The Endless Delve, the Dungeon
//           Gate, the Battle Tracker) with a tall "Starting Soon" card — a
//           big countdown to the stream (&minutes=<n>, or &at=<HH:MM> local
//           time so a reloaded source keeps the same deadline) and rotating
//           "getting ready" lines (&text=<line> for your own). No Saving
//           Throws tally: it would only be empty before the stream starts.
//   end   — "Ending soon": the brb layout with an "Ending Soon" card
//           (farewell lines, &text=<line>; an optional countdown, and
//           &raid=<channel> for a "Raiding … next" line) and the stream's
//           Saving Throws tally under it as a recap.
//
// The Battle Tracker (brb and chat) is GuildScribe's battle panel — the fight
// under way, the raid boss summary and the recent results — drawn by the theme itself (no extra
// source) and shrunk to fit its frame.
//
// Windows are cut out of the paper, so their sources go *below* the theme in
// OBS (the torn edge overlaps them). The Dungeon Gate is drawn on the paper,
// so pop-up overlays go *above* the theme and sit inside it; when nothing is
// playing the gate is just a quiet frame. The theme's own Sound Bytes card
// (soundbytes.ts) pops up in the gate too. Positions are on the 1920×1080
// canvas and listed on the /overlays setup page.
//
// The Saving Throws tally (brb and chat) is this stream's saving throws from
// chat (savingthrows.ts: !save dex, !save wis dc15) — saved / failed for each
// ability and the latest roll — drawn by the theme from /overlay/data. It
// starts fresh when the stream goes live (or on !saves reset) and is hidden
// with the Saves & skill checks dashboard switch.
//
// The Endless Delve is drawn by the theme itself, under the paper in its
// window (an iframe of /overlay?panel=idle), so it needs no OBS source.
//
// Scene extras: &idle=0 leaves the game window empty for a source of your
// own; &gate=<label> renames the Dungeon Gate; brb, start and end:
// &minutes=<n> or &at=<HH:MM> counts down ("Back in 4:59", "Starting in
// 4:59", "Ending in 4:59"), &text=<line> (brb also &brbtext=) replaces the
// rotating lines; end: &raid=<channel>; chat: &topic=<text> for the topic
// card; all but gameplay: &tracker=0 to leave the Battle Tracker empty,
// &saves=0 to drop the Saving Throws tally.

/** The scene's card: brb / start / end are countdown cards with rotating lines (CARDS), chat the topic card. */
export type CardKind = "brb" | "chat" | "start" | "end";
export type Rect = { x: number; y: number; w: number; h: number };
/** idle: the theme fills this window with The Endless Delve unless &idle=0. */
export type SceneWindow = Rect & { id: string; label: string; idle?: boolean };
export type SceneDef = {
  label: string;
  windows: SceneWindow[];
  gate?: Rect;
  /** The gate's plaque centred on it (brb and Just chatting) instead of sitting right,
   * clear of the stream title; a long title then stops short of it. */
  gateCentered?: boolean;
  card?: Rect & { kind: CardKind };
  tracker?: Rect;
  /** The Saving Throws tally, under the card. */
  saves?: Rect;
  /** Just chatting: the tracker's cards may grow past full size (up to this
   * factor) and stack from the bottom up, their bottom level with the
   * goldboard's card at the foot of Tavern Talk. */
  trackerGrow?: number;
  /** The status strip along the bottom, with suggested next steps. */
  status?: boolean;
  /** Tavern Talk's height when the scene needs it shorter than the full column. */
  chatH?: number;
  rule?: boolean;
  /** Now playing (&music=1): where the scene puts it, centred in this box —
   * stacked (art above the song) when the box is narrow. Without it, top-left. */
  music?: Rect & { stack?: boolean };
};

export const SCENES: Record<string, SceneDef> = {
  game: {
    label: "Gameplay",
    windows: [{ id: "game", label: "Game capture", x: 64, y: 112, w: 1440, h: 810 }],
    rule: true,
    status: true,
  },
  brb: {
    label: "Be right back",
    windows: [{ id: "wos", label: "Words on Stream", x: 64, y: 112, w: 1040, h: 585, idle: true }],
    gate: { x: 1128, y: 112, w: 376, h: 585 },
    gateCentered: true,
    card: { kind: "brb", x: 300, y: 706, w: 804, h: 200 },
    saves: { x: 300, y: 922, w: 804, h: 98 }, // under the card
    music: { x: 1254, y: 960, w: 520, h: 60 }, // under the Battle Tracker, centred on it
    // Under the gate and Tavern Talk, which ends level with the gate.
    tracker: { x: 1128, y: 722, w: 772, h: 224 },
    chatH: 597,
  },
  chat: {
    label: "Just chatting",
    windows: [{ id: "wos", label: "Words on Stream", x: 64, y: 112, w: 864, h: 486, idle: true }],
    gate: { x: 952, y: 112, w: 552, h: 311 },
    gateCentered: true,
    tracker: { x: 952, y: 447, w: 552, h: 499 },
    trackerGrow: 1.6,
    card: { kind: "chat", x: 300, y: 606, w: 628, h: 190 },
    saves: { x: 300, y: 814, w: 628, h: 98 }, // under the card
    // Left of the "Just chatting" card, above the emblem (centred on it), art over the song.
    music: { x: 27, y: 636, w: 240, h: 156, stack: true },
  },
  start: {
    label: "Starting soon",
    windows: [{ id: "wos", label: "Words on Stream", x: 64, y: 112, w: 1040, h: 585, idle: true }],
    gate: { x: 1128, y: 112, w: 376, h: 585 },
    gateCentered: true,
    // Taller than brb's: no Saving Throws tally under it, and the countdown is the star.
    card: { kind: "start", x: 300, y: 712, w: 804, h: 300 },
    music: { x: 1254, y: 960, w: 520, h: 60 },
    tracker: { x: 1128, y: 722, w: 772, h: 224 },
    chatH: 597,
  },
  end: {
    label: "Ending soon",
    windows: [{ id: "wos", label: "Words on Stream", x: 64, y: 112, w: 1040, h: 585, idle: true }],
    gate: { x: 1128, y: 112, w: 376, h: 585 },
    gateCentered: true,
    card: { kind: "end", x: 300, y: 706, w: 804, h: 200 },
    saves: { x: 300, y: 922, w: 804, h: 98 }, // the stream's recap
    music: { x: 1254, y: 960, w: 520, h: 60 },
    tracker: { x: 1128, y: 722, w: 772, h: 224 },
    chatH: 597,
  },
};

/** The countdown cards: heading, rotating lines, and the countdown's wording
 * (shown with &minutes=<n> or &at=<HH:MM>). */
export const CARDS: Record<"brb" | "start" | "end", { title: string; counting: string; done: string; lines: string[] }> = {
  brb: {
    title: "Be Right Back",
    counting: "Back in",
    done: "Any moment now…",
    lines: ["The party is taking a short rest.", "The bard went to restring the lute.", "The DM is fetching more dice.", "Spending hit dice on snacks.", "The wizard is re-reading their spellbook.", "Someone has to feed the owlbear.", "Rolling initiative against the kettle.", "The rogue is “just checking” the other room."],
  },
  start: {
    title: "Starting Soon",
    counting: "Starting in",
    done: "The adventure begins…",
    lines: ["The tavern doors are creaking open.", "Sharpening swords and tuning lutes.", "The DM is hiding the good loot.", "Rolling up a fresh character sheet.", "The barkeep is pouring the first round.", "Lighting the torches along the dungeon stair.", "The party is arguing over the marching order.", "The wizard is still preparing spells."],
  },
  end: {
    title: "Ending Soon",
    counting: "Ending in",
    done: "Farewell, adventurers!",
    lines: ["The hearth is burning low.", "Thanks for adventuring with us tonight.", "The bard is playing the last song.", "Counting the loot and splitting the gold.", "The party makes camp for a long rest.", "May your next roll be a natural 20.", "Last orders at the bar, friends.", "The DM is closing the screen… for now."],
  },
};

export const box = (r: Rect) => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;

export const SCENE_CSS = `
.idlegame{position:absolute;border:0;background:#120d09}
.slot-hint{position:absolute;display:flex;align-items:center;justify-content:center;font:700 28px/1.2 Cinzel,Georgia,serif;letter-spacing:.06em;color:#fff8;text-transform:uppercase;text-align:center;pointer-events:none}
.gate{position:absolute;border:2px dashed #c99a2e99;border-radius:10px;box-shadow:inset 0 0 0 6px #fff3,inset 0 0 40px #b07a2222}
.gate::before,.gate::after{content:"◆";position:absolute;color:var(--gold);font-size:16px;line-height:1}
.gate::before{left:-9px;top:-10px}
.gate::after{right:-9px;bottom:-10px}
.gate .plaque,.tracker .plaque{position:absolute;left:50%;top:-19px;transform:translateX(-50%);padding:6px 26px 7px;white-space:nowrap;
  background:linear-gradient(180deg,#fffaf0,#f6e3a6);border:1px solid #c99a2e;border-radius:4px;box-shadow:0 2px 6px #8a5a1830;
  font:700 18px/1 Cinzel,Georgia,serif;letter-spacing:.1em;text-transform:uppercase;color:var(--ink2)}
.gate .empty,.tracker .empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#a98235;opacity:.55;font:italic 22px/1.3 "EB Garamond",Georgia,serif;text-align:center;padding:20px}
.gate .empty b,.tracker .empty b{font:400 46px/1 Georgia,serif;font-style:normal}
.tracker{position:absolute;border:1px solid #c99a2e80;border-radius:10px;box-shadow:inset 0 0 0 5px #fff2,inset 0 0 0 6px #c99a2e40}
.tracker .empty[hidden]{display:none}
.tracker iframe{position:absolute;inset:28px 6px 6px;width:calc(100% - 12px);height:calc(100% - 34px);border:0;background:transparent}
.scard{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:16px 28px}
.scard h1{margin:0;font:700 74px/1 Cinzel,Georgia,serif;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2);text-shadow:0 1px 0 #fff8,0 3px 10px #c99a2e50}
.scard .flourish{width:62%;height:14px;margin:12px 0 10px;background:linear-gradient(90deg,transparent,var(--gold) 30%,var(--gold) 70%,transparent) center/100% 1px no-repeat;position:relative}
.scard .flourish::after{content:"❦";position:absolute;left:50%;top:50%;transform:translate(-50%,-52%);padding:0 10px;background:#fbefc3;color:var(--gold);font-size:20px;border-radius:50%}
.scard .line{font:italic 30px/1.3 "EB Garamond",Georgia,serif;color:#6b4a22;transition:opacity .6s ease;min-height:1.3em}
.scard .line.swap{opacity:0}
.scard .count{margin-top:8px;font:600 28px/1 Cinzel,Georgia,serif;letter-spacing:.06em;color:var(--seal)}
/* The gate's plaque sits right, clear of the stream-title subtitle centred above —
   except where the scene centres it (gateCentered), and the subtitle is kept short of it instead. */
.gate .plaque{left:auto;right:18px;transform:none}
.gate.center .plaque{left:50%;right:auto;transform:translateX(-50%)}
.scard.sc-chat h1{font-size:52px}.scard.sc-chat .line{font-size:28px}
.scard.sc-brb{padding:4px 28px}
/* Starting soon: a taller card with the countdown as its centrepiece. */
.scard.sc-start h1{font-size:76px;white-space:nowrap}
.scard.sc-start .count{margin-top:16px;font-size:54px}
.scard.sc-start .count.done{font-size:40px}
.scard .raid{margin-top:8px;font:600 24px/1.1 Cinzel,Georgia,serif;letter-spacing:.05em;color:var(--ink2)}
.scard .raid[hidden]{display:none}
/* Ending soon with a raid line: a smaller heading so all four lines clear the Saving Throws plaque. */
.scard.has-raid h1{font-size:56px}.scard.has-raid .flourish{margin:6px 0 4px}.scard.has-raid .line{font-size:26px}.scard.has-raid .count{margin-top:4px;font-size:24px}
/* The Saving Throws tally under the card: saved / failed per ability, the latest roll below. */
.saves{position:absolute;border:1px solid #c99a2e80;border-radius:10px;box-shadow:inset 0 0 0 5px #fff2,inset 0 0 0 6px #c99a2e40}
.saves .plaque{position:absolute;left:50%;top:-16px;transform:translateX(-50%);padding:5px 22px 6px;white-space:nowrap;
  background:linear-gradient(180deg,#fffaf0,#f6e3a6);border:1px solid #c99a2e;border-radius:4px;box-shadow:0 2px 6px #8a5a1830;
  font:700 15px/1 Cinzel,Georgia,serif;letter-spacing:.1em;text-transform:uppercase;color:var(--ink2)}
.saves .row{position:absolute;left:10px;right:10px;top:20px;height:46px;display:flex;justify-content:space-around;align-items:stretch}
.saves .cell{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-width:0}
.saves .cell+.cell{border-left:1px solid #c99a2e40}
.saves .cell.all{flex:1.25}
.saves .ab{font:700 14px/1 Cinzel,Georgia,serif;letter-spacing:.12em;color:#a98235}
.saves .n{font:600 21px/1 "EB Garamond",Georgia,serif;white-space:nowrap;color:var(--ink2)}
.saves .ok{color:#3f6b2a}.saves .no{color:#b8302a}
.saves .cell.zero .n{opacity:.4}
.saves .latest{position:absolute;left:12px;right:12px;bottom:7px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  font:italic 17px/1.1 "EB Garamond",Georgia,serif;color:#6b4a22}
.saves .empty{position:absolute;inset:14px 10px 4px;display:flex;align-items:center;justify-content:center;color:#a98235;opacity:.7;font:italic 21px/1.2 "EB Garamond",Georgia,serif;text-align:center}
.saves .empty[hidden],.saves .row[hidden],.saves .latest[hidden]{display:none}
`;

/** The scene's panels (drawn on the paper) and, in previews, labels for its windows. */
export function sceneHtml(scene: SceneDef): string {
  const hints = scene.windows.map((w) => `<div class="slot-hint" data-hint${w.idle ? " data-idle" : ""} style="${box(w)}">${w.label}<br>goes here</div>`).join("");
  const gate = scene.gate
    ? `<div class="gate${scene.gateCentered ? " center" : ""}" style="${box(scene.gate)}"><div class="plaque" id="gatelabel">Dungeon Gate</div><div class="empty"><b>⚔</b><span>Adventures appear here</span></div></div>`
    : "";
  const tracker = scene.tracker
    ? `<div class="tracker" style="${box(scene.tracker)}"${scene.trackerGrow ? ` data-grow="${scene.trackerGrow}"` : ""}><div class="plaque">Battle Tracker</div><div class="empty"><b>⚔</b><span>No battles yet — !dndduel to start one</span></div><iframe id="tracker" title="Battle Tracker" scrolling="no"></iframe></div>`
    : "";
  let card = "";
  const kind = scene.card?.kind;
  if (scene.card && kind && kind !== "chat") {
    card = `<div class="scard sc-brb sc-${kind}" style="${box(scene.card)}" data-card="${kind}"><h1>${CARDS[kind].title}</h1><div class="flourish"></div><div class="line" id="brbline"></div><div class="count" id="brbcount" hidden></div>${kind === "end" ? `<div class="raid" id="raidline" hidden></div>` : ""}</div>`;
  } else if (scene.card?.kind === "chat") {
    card = `<div class="scard sc-chat" style="${box(scene.card)}"><h1>Just Chatting</h1><div class="flourish"></div><div class="line" id="topic"></div></div>`;
  }
  const saves = scene.saves
    ? `<div class="saves" id="saves" style="${box(scene.saves)}"><div class="plaque">Saving Throws</div><div class="empty">No saving throws yet — !save or !save dex to make one</div><div class="row" hidden></div><div class="latest" hidden></div></div>`
    : "";
  return hints + gate + tracker + card + saves;
}

/** The Endless Delve's frames, drawn *under* the paper so the torn edge overlaps them like a capture. */
export function sceneUnderHtml(scene: SceneDef): string {
  return scene.windows.filter((w) => w.idle).map((w) => `<iframe class="idlegame" data-idlegame title="The Endless Delve" scrolling="no" style="${box(w)}"></iframe>`).join("");
}

// Scene behaviour in the client (runs after the theme's own client; h() and Q are in scope).
export const SCENE_CLIENT = `
const __CARDS__=${JSON.stringify(CARDS).replace(/</g, "\\u003c")};
// The Endless Delve in the game window, unless &idle=0 keeps it for a source of your own.
// The dashboard's switch (CFG.idle, re-checked with the title every minute) drops it and brings it back live.
const idleOn=Q.get("idle")!=="0";
const idleFrames=[...document.querySelectorAll("[data-idlegame]")];
const idleSrc="/overlay?channel="+encodeURIComponent(CFG.channel)+"&panel=idle&pad=26"+(preview?"&always=1":"")+(Q.get("hide")?"&hide="+encodeURIComponent(Q.get("hide")):"");
window.setDelve=on=>{if(!idleOn)return;on=on||preview;for(const f of idleFrames){f.hidden=!on;
  if(on&&!f.getAttribute("src")&&!f.dataset.parked)f.src=idleSrc;else if(!on&&f.getAttribute("src")){f.removeAttribute("src");delete f.dataset.parked}}};
if(!idleOn)idleFrames.forEach(f=>f.remove());else window.setDelve(CFG.idle!==false);
if(idleOn)document.querySelectorAll("[data-hint][data-idle]").forEach(e=>e.remove());
if(!preview)document.querySelectorAll("[data-hint]").forEach(e=>e.remove());
const gl=document.getElementById("gatelabel");if(gl&&Q.get("gate"))gl.textContent=Q.get("gate");
// A centred gate plaque sits under the end of a long stream title: stop the title (with "…") 16px short of it.
function clearPlaque(){const sub=document.getElementById("subtitle"),g=gl&&gl.closest(".gate.center");if(!sub||!g)return;
  const left=g.offsetLeft+gl.offsetLeft-gl.offsetWidth/2;sub.style.maxWidth=Math.max(160,Math.min(600,2*(left-16-960)))+"px"}
clearPlaque();if(document.fonts&&document.fonts.ready)document.fonts.ready.then(clearPlaque);
const trackerEl=document.getElementById("tracker");
if(trackerEl){if(Q.get("tracker")==="0")trackerEl.remove();else{
  trackerEl.src="/overlay?channel="+encodeURIComponent(CFG.channel)+"&panel=battle&align=center&refresh=8"+(preview?"&always=1":"");
  // Same origin: hide the empty line while a card is up, and fit the cards to
  // the frame — stacked or side by side, whichever needs less shrinking.
  // In just chatting (data-grow) the cards may grow, stack from the bottom up
  // (first card lowest) and end level with the goldboard's card beside them.
  const trBox=trackerEl.parentElement,trEmpty=trBox.querySelector(".empty"),grow=Number(trBox.dataset.grow)||0;
  setInterval(()=>{try{const doc=trackerEl.contentDocument,r=doc&&doc.getElementById("root");if(!r)return;
    trEmpty.hidden=!!r.children.length;if(!r.children.length)return;
    doc.body.style.minHeight="100vh"; // the body clips; let it span the frame so grown cards aren't cut off
    r.style.transform="none";r.style.maxWidth="none";r.style.margin="0";r.style.transformOrigin="top left";
    const W=trackerEl.clientWidth,H=trackerEl.clientHeight,pad=10; // the panel page's body padding
    let bottom=H-pad; // where the cards' bottom edge goes, in the frame's own pixels
    if(grow){const gb=document.getElementById("goldbox"),gf=document.getElementById("gold");
      const card=!gb||gb.hidden?null:gf.contentDocument&&gf.contentDocument.querySelector("#root .card");
      if(card){const k=trackerEl.getBoundingClientRect().width/Math.max(1,W);
        const b=(gf.getBoundingClientRect().top+card.getBoundingClientRect().bottom*k-trackerEl.getBoundingClientRect().top)/k;
        if(b>pad*4&&b<=H)bottom=b}}
    const fit=()=>Math.min(grow||1,(W-2*pad)/Math.max(1,r.scrollWidth),(bottom-pad)/Math.max(1,r.scrollHeight));
    const dir=grow?"column-reverse":"column";
    // Stacked, every card takes the widest one's width so their sides are flush.
    r.style.flexDirection=dir;r.style.alignItems="stretch";const col=fit();
    r.style.flexDirection="row";r.style.alignItems=grow?"flex-end":"flex-start";const row=fit();
    if(col>=row){r.style.flexDirection=dir;r.style.alignItems="stretch"}
    const s=Math.max(col,row),x=(W-r.scrollWidth*s)/2-pad,y=grow?bottom-pad-r.scrollHeight*s:0;
    r.style.transform="translate("+x.toFixed(1)+"px,"+y.toFixed(1)+"px) scale("+s.toFixed(3)+")"}catch(e){}},1000)}}
// The Saving Throws tally under the card: polled while this scene is showing; hidden with the dashboard's Saves & skill checks switch.
const savesEl=document.getElementById("saves");
if(savesEl){if(Q.get("saves")==="0")savesEl.remove();else{
  const sRow=savesEl.querySelector(".row"),sLast=savesEl.querySelector(".latest"),sEmpty=savesEl.querySelector(".empty");
  const DEMO={passed:9,failed:4,abilities:[["STR",1,1],["DEX",3,1],["CON",2,0],["INT",0,1],["WIS",2,1],["CHA",1,0]].map(a=>({ability:a[0],passed:a[1],failed:a[2]})),latest:{name:"Adventurer",ability:"WIS",total:17,dc:15,passed:true,raw:14}};
  const cell=(ab,p,f,cls)=>{const c=h("div","cell"+(cls?" "+cls:"")+(p+f?"":" zero")),n=h("div","n");
    n.append(h("span","ok","✔"+p),document.createTextNode(" "),h("span","no","✘"+f));c.append(h("div","ab",ab),n);return c};
  const drawSaves=t=>{savesEl.hidden=!t;if(!t)return;const any=t.passed+t.failed>0;
    sEmpty.hidden=any;sRow.hidden=!any;sLast.hidden=!any||!t.latest;if(!any)return;
    sRow.replaceChildren(cell("All",t.passed,t.failed,"all"),...t.abilities.map(a=>cell(a.ability,a.passed,a.failed)));
    const l=t.latest;if(l)sLast.textContent="Latest: "+l.name+" · "+l.ability+" "+l.total+(l.raw===20?" (nat 20)":l.raw===1?" (nat 1)":"")+(l.ability==="D20"?" vs bot's ":" vs DC ")+l.dc+(l.passed?" — saved ✔":" — failed ✘")};
  const pollSaves=()=>{if(preview){drawSaves(DEMO);return}if(!obsActive&&!obsVisible)return;
    fetch("/overlay/data?channel="+encodeURIComponent(CFG.channel)+"&panels=saves").then(r=>r.ok?r.json():null).then(d=>{if(d&&d.ok)drawSaves(d.saves||null)}).catch(()=>{})};
  pollSaves();setInterval(pollSaves,10000)}}
const topicEl=document.getElementById("topic");if(topicEl)topicEl.textContent=Q.get("topic")||"Pull up a chair by the hearth — the kettle's on.";
const brbLine=document.getElementById("brbline");
if(brbLine){
  // brb, start and end: rotating lines (or &text= / &brbtext= for your own) and an optional countdown.
  const C=__CARDS__[brbLine.parentElement.dataset.card]||__CARDS__.brb,LINES=C.lines;
  const own=Q.get("text")||Q.get("brbtext");let i=Math.floor(Math.random()*LINES.length);brbLine.textContent=own||LINES[i];
  if(!own)setInterval(()=>{brbLine.classList.add("swap");setTimeout(()=>{i=(i+1)%LINES.length;brbLine.textContent=LINES[i];brbLine.classList.remove("swap")},650)},12000);
  // &at=HH:MM (local time; the next one, so 00:30 after 23:00 is tomorrow) keeps the deadline across reloads; &minutes=<n> counts from load.
  let end=0;const at=/^(\\d{1,2}):(\\d{2})$/.exec(Q.get("at")||""),mins=Number(Q.get("minutes"));
  if(at&&+at[1]<24&&+at[2]<60){const d=new Date();d.setHours(+at[1],+at[2],0,0);if(d.getTime()<Date.now()-5*60000)d.setDate(d.getDate()+1);end=d.getTime()}
  else if(Number.isFinite(mins)&&mins>0)end=Date.now()+Math.min(mins,600)*60000;
  if(end){const c=document.getElementById("brbcount");c.hidden=false;
    const tick=()=>{const s=Math.max(0,Math.round((end-Date.now())/1000)),hh=Math.floor(s/3600),mm=Math.floor(s%3600/60),ss=String(s%60).padStart(2,"0");
      c.classList.toggle("done",!s);c.textContent=s?"⌛ "+C.counting+" "+(hh?hh+":"+String(mm).padStart(2,"0"):mm)+":"+ss:"⌛ "+C.done};tick();setInterval(tick,1000)}
  const raidEl=document.getElementById("raidline"),raid=(Q.get("raid")||"").trim().replace(/^@/,"");
  if(raidEl&&raid){raidEl.textContent="⚔ Raiding "+raid+" next";raidEl.hidden=false;raidEl.parentElement.classList.add("has-raid")}
}
`;

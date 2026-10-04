// The shared "unrolled scroll" look for GuildScribe's web pages: a parchment
// sheet with wooden rollers at top and bottom, laid on a dark leather desk.
// Used by the page() shell (page_shell.ts), the Guild Codex (guide.ts), the
// how-to guides (howto.ts) and the channel dashboard (dashboard_page.ts).
// Its own module so those files stay under Val Town's per-file size ceiling.
//
// Wrap a page's content with scrollOpen/scrollClose and put SCROLL_HEAD in
// <head> plus SCROLL_CSS (and the page's own CSS) in a <style>.

export const SCROLL_HEAD =
  `<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=EB+Garamond:ital,wght@0,400;0,600;1,400&display=swap">`;

export const scrollOpen = (cls = "") => `<main class="scroll${cls ? ` ${cls}` : ""}"><div class="sheet">`;
export const scrollClose = `</div></main>`;

export const SCROLL_CSS = `:root{color-scheme:light;
--desk:#140d08;--wood-1:#2a190d;--wood-2:#5b3a20;--wood-3:#a8703f;
--parch:#e0d5b6;--parch-2:#d9caa2;--parch-3:#cebb8b;--edge:#b48f58;--rule:#b99b63;
--ink:#2e2015;--ink-2:#53402d;--ink-3:#7a6249;
--seal:#8f4210;--seal-dk:#66300b;--gold:#9a6f22;--ok:#2e5a2a;--ok-bg:#c7d1ab;--bad:#8a2417;--bad-bg:#dcbeaa;
--display:Cinzel,"Trajan Pro",Georgia,serif;--body:"EB Garamond",Garamond,Georgia,serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;min-height:100vh;padding:44px 28px 64px;color:var(--ink);font:400 1.08rem/1.6 var(--body);
background:radial-gradient(ellipse at 50% 0,#3a2414 0,transparent 60%),radial-gradient(ellipse at 50% 100%,#2a170b 0,transparent 55%),repeating-linear-gradient(92deg,#ebebe403 0 2px,#0000 2px 7px),var(--desk);background-attachment:fixed}
.scroll{position:relative;max-width:var(--scroll-w,820px);margin:0 auto}
.scroll::before,.scroll::after{content:"";position:absolute;left:-22px;right:-22px;height:30px;border-radius:15px;z-index:2;pointer-events:none;
background:radial-gradient(circle at 15px 50%,#6b4423 0 6px,#0000 7px),radial-gradient(circle at calc(100% - 15px) 50%,#6b4423 0 6px,#0000 7px),
linear-gradient(90deg,var(--wood-1) 0 30px,#0000 30px calc(100% - 30px),var(--wood-1) calc(100% - 30px)),
linear-gradient(180deg,var(--wood-1) 0,var(--wood-2) 22%,var(--wood-3) 42%,#b9895b 50%,var(--wood-2) 72%,var(--wood-1) 100%);
box-shadow:0 8px 14px #000a,inset 0 0 0 1px #0006}
.scroll::before{top:-15px}.scroll::after{bottom:-15px}
.sheet{position:relative;padding:58px clamp(20px,5vw,64px) 54px;
background:radial-gradient(ellipse at 18% 12%,#ebe6d1 0,#0000 50%),radial-gradient(ellipse at 88% 78%,#d4be8d 0,#0000 46%),radial-gradient(ellipse at 40% 60%,#e4dbbf 0,#0000 60%),linear-gradient(180deg,#d6c598 0,var(--parch) 4%,var(--parch) 96%,#d6c598 100%);
box-shadow:inset 0 0 70px #9a6b2c55,inset 0 0 12px #6b44183d,0 24px 60px #000c}
.sheet::before,.sheet::after{content:"";position:absolute;top:0;bottom:0;width:10px;background:linear-gradient(90deg,#8a63305a,#0000)}
.sheet::before{left:0}.sheet::after{right:0;transform:scaleX(-1)}
h1,h2,h3,h4{font-family:var(--display);font-weight:700;letter-spacing:.02em;color:var(--seal-dk);line-height:1.15}
h1{font-size:clamp(2rem,5vw,3rem);margin:0 0 10px;color:var(--ink)}
h2{font-size:1.4rem;margin:40px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--rule);scroll-margin-top:20px}
h2::before{content:"❦";color:var(--seal);margin-right:.45em;font-weight:400}
h3{font-size:1.06rem;margin:0 0 6px;color:var(--seal-dk)}
p{margin:.6em 0;color:var(--ink-2)}
strong{color:var(--ink)}
a{color:var(--seal);text-decoration:underline;text-decoration-color:#8f421066;text-underline-offset:2px}
a:hover{color:var(--seal-dk);text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--seal);outline-offset:3px;border-radius:3px}
code{font-family:var(--mono);font-size:.86em;background:#d1be91;color:#4a2a14;padding:1px 6px;border-radius:3px;border:1px solid #bda26d;overflow-wrap:anywhere}
hr,.flourish{border:0;height:18px;margin:28px 0;background:linear-gradient(90deg,#0000,var(--rule) 30%,var(--rule) 70%,#0000) center/100% 1px no-repeat;text-align:center}
.muted{color:var(--ink-3);font-size:.94rem}
.btn,button,.action-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:600 .9rem/1.2 var(--display);letter-spacing:.04em;color:#fff3dc;background:linear-gradient(180deg,#d27c3a,#b5581f 55%,#8a3e12);border:1px solid #5e2a0a;border-radius:6px;padding:10px 18px;text-decoration:none;cursor:pointer;box-shadow:inset 0 1px 0 #ffffff30,0 2px 5px #4a2a1050;transition:transform .15s,filter .15s}
.btn:hover,button:hover,.action-button:hover{color:#fff;filter:brightness(1.1);transform:translateY(-1px)}
.btn.ember,.action-button.ember{background:linear-gradient(180deg,#d27c3a,#b5581f 55%,#8a3e12);border-color:#5e2a0a;color:#fff3dc}
.btn.ghost,button.ghost{background:transparent;color:var(--seal-dk);border-color:var(--edge);box-shadow:none}
input,textarea,select{font:inherit;font-size:1rem;color:var(--ink);background:#e7e0ca;border:1px solid var(--edge);border-radius:5px;padding:8px 10px;box-shadow:inset 0 1px 3px #6b441826}
input:focus,textarea:focus{outline:2px solid #8f421066;border-color:var(--seal)}
.pill{display:inline-block;border:1px solid var(--edge);border-radius:999px;padding:3px 11px;color:var(--seal-dk);background:#dccea8;font:600 .7rem var(--display);text-transform:uppercase;letter-spacing:.12em}
.card{background:linear-gradient(180deg,#e4dcc2,#dccfaa);border:1px solid var(--edge);border-radius:6px;padding:18px 20px;box-shadow:0 1px 0 #fff8 inset,0 3px 10px #6b44182b;position:relative}
.note{background:#d7c596;border:1px solid var(--edge);border-left:4px solid var(--seal);border-radius:4px;padding:12px 16px;margin:20px 0;color:var(--ink-2)}
.banner{padding:10px 14px;border-radius:5px;margin:14px 0;border:1px solid}
.banner.ok{background:var(--ok-bg);color:var(--ok);border-color:#92a470}
.banner.error{background:var(--bad-bg);color:var(--bad);border-color:#c98f78}
.colophon{margin-top:36px;padding-top:14px;border-top:1px solid var(--rule);text-align:center;font-size:.92rem}
@media(max-width:640px){body{padding:30px 16px 44px;font-size:1rem}.scroll::before,.scroll::after{left:-8px;right:-8px;height:24px}.scroll::before{top:-12px}.scroll::after{bottom:-12px}.sheet{padding:44px 18px 40px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}`;

/** Extra rules for the Guild Codex (GET /guide). */
export const GUIDE_CSS = `.scroll{--scroll-w:1080px}
.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding-bottom:24px;border-bottom:1px solid var(--rule)}
.top h1{margin-top:12px}
.intro{font-size:1.2rem;max-width:620px;font-style:italic;color:var(--ink-2)}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-width:300px;margin-top:6px}
.action-button{min-width:0;padding:11px 14px}
.action-button.ghost{background:#dccea8;color:var(--seal-dk);border-color:var(--edge);box-shadow:none}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;align-items:start}
.grid.masonry{grid-auto-rows:4px;row-gap:0}.grid.masonry>*{margin-bottom:16px}
.card{scroll-margin-top:16px}.card:target{border-color:var(--seal);box-shadow:0 0 0 3px #8f421040}
.card h3{padding-bottom:6px;border-bottom:1px dotted var(--rule)}
.cmd{display:block;background:#2b1d12;color:#f3dfb4;border-left:3px solid var(--seal);border-radius:3px;padding:7px 12px;margin:8px 0;font:.86rem/1.4 var(--mono);overflow-wrap:anywhere}
.switch-link{display:inline-block;margin:4px 0 6px;padding:2px 10px;border:1px solid var(--edge);border-radius:999px;font:600 .68rem var(--display);letter-spacing:.06em;text-transform:uppercase;color:var(--seal-dk);background:#dccea8;text-decoration:none}
a.switch-link:hover{background:#d4c191}.switch-link.off{color:var(--ink-3)}
.toc{background:#dccfaa;border:1px solid var(--edge);border-radius:6px;padding:16px 22px;margin:24px 0}
.toc h2{margin:0 0 10px;padding:0;border:0;font-size:1rem;letter-spacing:.14em;text-transform:uppercase;color:var(--seal-dk)}
.toc h2::before{content:"✦"}
.toc ol{margin:0;padding-left:1.4em;columns:3;column-gap:28px}.toc li{break-inside:avoid;margin:3px 0;color:var(--ink-3)}
.toc a{color:var(--ink);text-decoration:none}.toc a:hover{color:var(--seal);text-decoration:underline}
.toc-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}.toc-ctl{font-size:.92rem;color:var(--ink-3)}
button.linkish{background:none;border:0;box-shadow:none;padding:0;color:var(--seal);font:inherit;text-decoration:underline;cursor:pointer;transform:none}button.linkish:hover{filter:none;color:var(--seal-dk)}
details.fold{margin:18px 0 0;border:1px solid var(--edge);border-radius:6px;background:#dccfaa55;padding:0 20px;scroll-margin-top:20px;transition:background .2s}
details.fold[open]{background:transparent;padding-bottom:16px}
details.fold>summary{list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 0}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary h2{margin:0;padding:0;border:0}
details.fold>summary h2::after{content:"▸";display:inline-block;margin-left:.5em;color:var(--seal);font-size:.8em;transition:transform .2s}
details.fold[open]>summary h2::after{transform:rotate(90deg)}
details.fold[open]>summary{border-bottom:1px solid var(--rule);margin-bottom:12px}
details.fold>summary:hover h2{color:var(--seal)}
.fold-meta{font-size:.9rem;color:var(--ink-3)}
details.fold .fold-hint::after{content:"Click to expand"}details.fold[open] .fold-hint::after{content:"Click to collapse"}
@media(max-width:860px){.toc ol{columns:2}.top{display:block}.actions{margin-top:18px;min-width:0}}
@media(max-width:520px){.toc ol{columns:1}.actions{grid-template-columns:1fr}}`;

/** Extra rules for the how-to guides (GET /howto, /howto/<slug>, /go/*). */
export const HOWTO_CSS = `.crumbs{font:600 .74rem var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.crumbs a{text-decoration:none}
ol.steps{counter-reset:s;list-style:none;padding:0}
ol.steps>li{counter-increment:s;position:relative;background:linear-gradient(180deg,#e4dcc2,#dccfaa);border:1px solid var(--edge);border-radius:6px;padding:12px 16px 12px 58px;margin:10px 0;color:var(--ink-2)}
ol.steps>li::before{content:counter(s);position:absolute;left:14px;top:10px;width:30px;height:30px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#d27c3a,var(--seal) 55%,var(--seal-dk));color:#fbf0d6;font:700 .9rem/30px var(--display);text-align:center;box-shadow:0 2px 4px #4a2a1060}
ul.tips{padding-left:1.2em}ul.tips li{margin:6px 0;color:var(--ink-2)}ul.tips li::marker{content:"✦  ";color:var(--seal)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:14px}
.card p{margin:8px 0}.btn{margin:4px 8px 4px 0}
input{width:min(100%,280px)}`;

/** Extra rules for the channel dashboard (GET /dashboard) and its login gate. */
export const DASH_CSS = `.scroll{--scroll-w:1200px}
.scroll.gate{--scroll-w:540px;margin-top:60px;text-align:center}
.dash-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap;padding-bottom:18px;border-bottom:1px solid var(--rule)}
.dash-head h1{margin:8px 0 4px}.dash-head p{margin:0;max-width:680px}
h2{margin:0;padding:0;border:0;font-size:1.25rem}h2::before{content:none}
h3{margin:14px 0 8px}
.muted{font-size:.9rem}
summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;user-select:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸";color:var(--seal);font-size:.85rem;width:1em;transition:transform .15s}
details[open]>summary::before{transform:rotate(90deg)}
summary:hover .folder-name{text-decoration:underline;text-decoration-color:var(--rule)}
details{scroll-margin-top:16px}
.index{background:#dccfaa;border:1px solid var(--edge);border-radius:6px;padding:12px 18px;margin:20px 0}
.index-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;font:700 .8rem var(--display);letter-spacing:.14em;text-transform:uppercase;color:var(--seal-dk)}
.index-ctl{font:400 .9rem var(--body);letter-spacing:0;text-transform:none}
.index ol{margin:8px 0 0;padding-left:0;list-style:none;line-height:1.75;columns:3;column-gap:32px}
.index li::before{content:"✦";color:var(--seal);margin-right:7px;font-size:.75em}
.index ul li::before{content:"–";color:var(--ink-3)}
.index ol>li{break-inside:avoid}.index ol>li:has(ul){break-inside:auto}
.index ul{margin:0 0 4px;padding-left:16px;list-style:none;font-size:.9rem}
.index a{color:var(--ink);text-decoration:none}.index a:hover{color:var(--seal);text-decoration:underline}
@media(max-width:800px){.index ol{columns:2}}@media(max-width:520px){.index ol{columns:1}}
button{margin-top:6px;padding:8px 16px}
button.link{background:none;border:0;box-shadow:none;padding:0;margin:0;color:var(--seal);font:inherit;text-decoration:underline;transform:none}
button.danger{background:linear-gradient(180deg,#5f4a36,#3f2f21);border-color:#2a1d12}
button.x{background:none;border:0;box-shadow:none;color:var(--ink-3);font:1.1rem var(--body);padding:2px 8px;margin:0}
button.x:hover{color:var(--seal);transform:none}
.row-form,.add-form{background:#e2d8ba;border:1px solid var(--edge);border-radius:6px;padding:12px 14px}
.add-form{border-style:dashed}
.row-head{font-size:.95rem;margin-bottom:6px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
textarea,input[type=text],input[type=number]{width:100%;margin:4px 0}
label{display:block;font-size:.88rem;color:var(--ink-2)}
label.check{display:flex;align-items:center;gap:6px;font-size:.92rem}
input[type=checkbox]{accent-color:var(--seal);box-shadow:none}
.row-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:6px}
.row-controls label{flex:0 0 auto}.row-controls form.push{margin:0 0 0 auto}
.guide-link{white-space:nowrap;font-size:.85rem;margin-left:4px}
.toggle-detail p{margin:8px 0;font-size:.95rem}.toggle-detail .warn{color:var(--seal)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:10px;margin:12px 0}
.tile{aspect-ratio:1;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:7px;text-align:center;background:linear-gradient(180deg,#e7e0c7,#dccea7);color:var(--ink);border:1px solid var(--edge);border-radius:6px;padding:10px;margin:0;font:400 .95rem var(--body);letter-spacing:0;cursor:pointer;min-width:0;box-shadow:0 2px 6px #6b441826;scroll-margin-top:24px;transition:transform .12s,border-color .12s,box-shadow .12s}
.tile:hover,.tile:focus-visible{transform:translateY(-2px);border-color:var(--seal);box-shadow:0 6px 14px #6b441840;filter:none;color:var(--ink);outline:none}
.tile:target{border-color:var(--seal);box-shadow:0 0 0 3px #8f421040}
.tile>.pill{flex:0 0 auto}
.tile-title{font:700 .82rem/1.25 var(--display);letter-spacing:.02em;color:var(--seal-dk);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.tile-meta{font-size:.8rem;color:var(--ink-3)}
.tile-new{border-style:dashed;background:transparent;box-shadow:none}
.tile-new .tile-title{color:var(--seal);font-weight:500}
.tile-paused{opacity:.62}
.folders{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;align-items:start;margin:12px 0}
details.folder{background:linear-gradient(180deg,#e3d9bb,#d9c9a0);border:1px solid var(--edge);border-radius:6px;padding:12px 16px;min-width:0;box-shadow:0 3px 10px #6b44182b}
.board-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px;align-items:start;margin:22px 0}
@media(min-width:1100px){.board-row{grid-template-columns:repeat(4,minmax(0,1fr))}}
.masonry{grid-auto-rows:4px;row-gap:0}
details.folder.big.wide{margin:0 0 22px}
details.folder.big{padding:16px 18px;border-top:3px solid var(--seal)}
details.folder.big>summary{border-bottom:1px solid var(--rule);padding-bottom:8px;margin-bottom:6px}
h2.folder-name{font-size:1.15rem;color:var(--seal-dk);margin:0}
details.folder>summary{justify-content:space-between;flex-wrap:wrap;gap:4px 10px}
details.folder>summary::before{order:-1}
.folder-name{flex:1;font:700 1rem var(--display);color:var(--seal-dk)}
.tiles.mini{grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:12px 0 0}
.tiles.mini .tile{padding:8px}.tiles.mini .tile-title{font-size:.72rem}
dialog.editor{background:var(--parch);color:var(--ink);border:1px solid var(--edge);border-top:12px solid var(--wood-2);border-bottom:12px solid var(--wood-2);border-radius:8px;width:min(560px,92vw);max-height:88vh;padding:16px 22px 22px;box-shadow:inset 0 0 50px #9a6b2c40,0 24px 60px #000c}
dialog.editor::backdrop{background:#140d08cc}
.editor-head{display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:1px solid var(--rule);padding-bottom:8px;margin-bottom:6px}
.editor-head h3{margin:0}
dialog.editor .row-form,dialog.editor .add-form{background:none;border:0;padding:0}
.pill.on{background:var(--ok-bg);color:var(--ok);border-color:#92a470}
.pill.off{background:var(--bad-bg);color:var(--bad);border-color:#c98f78}`;

/** A whole themed HTML document: SCROLL_CSS plus the page's own `css`, the body
 * laid on the scroll. `head` adds extra <head> tags (e.g. a refresh meta);
 * `width` sets the sheet's max width in px. `title` must already be escaped. */
export function scrollDoc(title: string, body: string, opts: { css?: string; head?: string; width?: number } = {}): string {
  const w = opts.width ? `.scroll{--scroll-w:${opts.width}px}` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${SCROLL_HEAD}${opts.head ?? ""}<title>${title}</title><style>${SCROLL_CSS}${w}${opts.css ?? ""}</style></head><body>${scrollOpen()}${body}${scrollClose}</body></html>`;
}

/** Ledger-style tables, search boxes, stat tiles and member lists shared by the
 * roster, bestiary, maps and operator pages. */
export const LEDGER_CSS = `[hidden]{display:none!important}
.lede{margin-top:0}.small{font-size:.86rem}
.search{width:100%;margin:14px 0 4px;padding:11px 14px}
select{padding:10px}
.controls{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0 8px}.controls .search{flex:1 1 260px;width:auto;margin:0}
.table-wrap{overflow-x:auto;border:1px solid var(--edge);border-radius:6px;background:#e7e0ca;box-shadow:0 3px 10px #6b44182b}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #cebb8b;vertical-align:top;color:var(--ink-2)}
th{font:700 .72rem var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--seal-dk);background:#d9caa2;border-bottom:2px solid var(--rule);white-space:nowrap}
tbody tr:nth-child(even){background:#e2d9bd}tbody tr:hover{background:#dccea8}tbody tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.stats{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0}
.stat{background:linear-gradient(180deg,#e4dcc2,#dccfaa);border:1px solid var(--edge);border-radius:6px;padding:10px 18px;color:var(--ink-3);font-size:.92rem}
.stat b{display:block;font:700 1.5rem var(--display);color:var(--seal-dk)}
.badge{display:inline-block;border:1px solid var(--edge);border-radius:999px;padding:0 9px;font-size:.8rem;color:var(--ink-3);background:#dccea8}
.badge.learned{border-color:#92a470;color:var(--ok);background:var(--ok-bg)}
.members,.list{list-style:none;padding:0;margin:10px 0 0}
.members li,.list li{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:7px 0;border-bottom:1px dotted var(--rule)}
.members li:last-child,.list li:last-child{border-bottom:0}
.who{font-weight:600}
.hpbar{height:12px;background:#d1be91;border:1px solid var(--edge);border-radius:6px;overflow:hidden;margin:10px 0 4px}
.hpbar span{display:block;height:100%;background:linear-gradient(180deg,#d27c3a,var(--seal-dk))}
.slain .hpbar span{background:#8a7a66}`;

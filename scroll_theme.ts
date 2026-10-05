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

// ── Paper textures, all inline SVG (no extra requests) ──
const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
// Crumpled-paper relief: low-frequency noise lit from the top-left reads as
// wrinkles and gentle waves; remapped around mid-grey and blended overlay so
// it shades ridges and troughs without dulling the paper's colour.
const WRINKLES = svgUrl(
  `<svg xmlns='http://www.w3.org/2000/svg' width='720' height='720'><filter id='w' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='0.0035 0.009' numOctaves='5' seed='7' stitchTiles='stitch'/><feDiffuseLighting lighting-color='#fff' surfaceScale='5' diffuseConstant='1'><feDistantLight azimuth='225' elevation='55'/></feDiffuseLighting><feComponentTransfer><feFuncR type='linear' slope='1.5' intercept='-0.73'/><feFuncG type='linear' slope='1.5' intercept='-0.73'/><feFuncB type='linear' slope='1.5' intercept='-0.73'/></feComponentTransfer></filter><rect width='100%' height='100%' filter='url(#w)'/></svg>`,
);
// Fine fibre grain, brown at low alpha.
const GRAIN = svgUrl(
  `<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' seed='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.36  0 0 0 0 0.24  0 0 0 0 0.1  0 0 0 0.42 -0.1'/></filter><rect width='100%' height='100%' filter='url(#g)'/></svg>`,
);
// Torn left/right edges, tiled down the sheet and used as a mask.
const TORN_L = svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='16' height='300'><path d='M16 0L2.8 0L2.7 5.2L1.7 9.3L2.7 13.5L1.4 16.6L0.4 21.0L0.9 26.4L0.4 28.9L0.4 31.1L0.4 33.2L0.5 38.2L1.0 41.9L2.6 44.9L3.2 49.8L2.6 52.6L2.2 57.3L3.7 60.7L2.8 62.7L4.3 66.3L4.7 68.6L3.4 71.5L4.2 76.9L3.1 79.8L5.1 83.7L7.2 86.4L8.9 88.8L7.4 91.3L5.3 94.0L4.1 99.4L5.2 102.5L6 105.8L6 108.2L6 111.1L4.6 114.1L3.8 118.2L3.7 121.5L3.9 125.2L2.8 127.8L2.0 132.7L3.4 137.3L4.6 142.6L3.5 146.1L5.3 150.5L7.3 155.4L6.3 158.4L3.2 163.0L0.8 165.8L1.0 170.7L0.5 175.9L3.6 178.8L5.7 181.8L5.6 187.2L3.6 189.7L1.3 192.9L2.6 196.7L2.5 201.9L1.0 205.0L0.4 207.3L0.4 209.7L0.4 213.0L0.4 217.6L0.4 220.8L1.5 223.1L1.7 225.2L3.1 227.2L4.8 229.5L6.3 232.4L6.2 235.6L4.4 240.0L1.9 243.6L1.8 247.5L0.4 249.8L1.3 252.2L2.6 255.9L2.9 258.4L2.4 263.0L1.6 266.8L2.0 269.6L1.1 274.3L2.4 277.0L1.9 279.5L0.5 281.7L0.4 286.5L1.5 291.8L2.0 295.6L2.8 300L16 300Z'/></svg>`);
const TORN_R = svgUrl(`<svg xmlns='http://www.w3.org/2000/svg' width='16' height='300'><path transform='translate(16 0) scale(-1 1)' d='M16 0L3.2 0L2.5 5.0L2.2 8.2L2.0 10.5L3.6 13.7L3.4 17.9L2.3 21.4L3.3 24.9L3.8 27.6L2.9 31.3L3.0 36.1L3.2 40.7L3.6 44.1L5.0 46.5L3.9 49.0L3.6 51.2L3.5 55.5L2.9 59.8L4.4 64.3L3.4 69.6L1.9 75.0L0.7 80.2L2.2 85.4L3.1 90.0L3.5 92.0L3.7 97.3L6.8 100.6L8.9 105.2L5.1 107.2L1.7 111.8L1.1 116.1L2.3 118.8L1.4 124.1L0.4 126.1L0.4 129.0L1.7 134.4L0.6 138.4L0.4 140.8L0.4 145.6L0.4 148.1L0.4 151.5L0.6 154.2L4.7 159.0L7.4 164.1L4.7 167.3L0.6 172.6L1.7 176.8L0.4 181.2L0.4 184.0L0.4 189.0L0.4 193.8L0.4 196.3L1.8 199.9L1.2 203.8L0.4 206.5L0.6 210.5L1.6 212.8L0.8 217.9L4.5 221.0L7.6 225.2L7.1 230.2L4.5 234.8L1.2 237.2L2.1 240.2L0.9 244.1L1.0 248.5L0.4 251.6L1.7 256.3L1.8 259.7L3.2 262.4L3.2 265.6L2.4 269.6L1.5 272.4L0.6 275.2L0.4 280.7L1.4 285.6L3.6 289.6L6.5 291.9L6.9 294.3L3.9 297.4L3.2 300L16 300Z'/></svg>`);
const TORN_MASK = `${TORN_L} left top/16px 300px repeat-y,${TORN_R} right 0 top 137px/16px 300px repeat-y,linear-gradient(#000 0 0) center/calc(100% - 30px) 100% no-repeat`;

// Roller finial (left end; mirrored for the right): dowel stub, brass
// ferrule, turned neck and a lathe-turned knob with a highlight and groove.
const FINIAL_SVG = (flip: boolean) =>
  `<svg xmlns='http://www.w3.org/2000/svg' width='52' height='48' viewBox='0 0 52 48'><defs>` +
  `<linearGradient id='wd' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#2a170b'/><stop offset='.3' stop-color='#6e4423'/><stop offset='.45' stop-color='#b07a47'/><stop offset='.55' stop-color='#8a5a30'/><stop offset='1' stop-color='#24140a'/></linearGradient>` +
  `<linearGradient id='br' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#5a3f12'/><stop offset='.32' stop-color='#c9a24a'/><stop offset='.46' stop-color='#f3dc8e'/><stop offset='.62' stop-color='#a8822f'/><stop offset='1' stop-color='#3f2c0b'/></linearGradient>` +
  `<radialGradient id='kb' cx='.42' cy='.32' r='.75'><stop offset='0' stop-color='#d39a63'/><stop offset='.28' stop-color='#9a6435'/><stop offset='.7' stop-color='#5a3418'/><stop offset='1' stop-color='#1e1007'/></radialGradient>` +
  `</defs><g${flip ? " transform='translate(52 0) scale(-1 1)'" : ""}>` +
  `<rect x='32' y='15' width='20' height='18' fill='url(#wd)'/>` +
  `<rect x='27' y='10' width='7' height='28' rx='1.5' fill='url(#br)'/><rect x='27' y='10' width='7' height='28' rx='1.5' fill='none' stroke='#2b1d06' stroke-width='.6' opacity='.7'/>` +
  `<line x1='30.5' y1='10.5' x2='30.5' y2='37.5' stroke='#fff3c4' stroke-width='.5' opacity='.45'/>` +
  `<rect x='21' y='16' width='7' height='16' fill='url(#wd)'/><rect x='23.5' y='14.5' width='2.4' height='19' rx='1' fill='url(#wd)' stroke='#1e1007' stroke-width='.4'/>` +
  `<ellipse cx='13' cy='24' rx='11' ry='14.5' fill='url(#kb)'/>` +
  `<ellipse cx='13' cy='24' rx='6.5' ry='14' fill='none' stroke='#1e1007' stroke-width='.7' opacity='.55'/>` +
  `<ellipse cx='10' cy='16' rx='4' ry='3' fill='#f2c99a' opacity='.35'/>` +
  `<ellipse cx='2.6' cy='24' rx='2.6' ry='6.5' fill='url(#br)' stroke='#2b1d06' stroke-width='.5'/>` +
  `</g></svg>`;
const FINIAL_L = svgUrl(FINIAL_SVG(false));
const FINIAL_R = svgUrl(FINIAL_SVG(true));
// End of the rolled parchment: the spiral of paper layers seen edge-on.
const ROLL_END = svgUrl(
  `<svg xmlns='http://www.w3.org/2000/svg' width='12' height='36' viewBox='0 0 12 36'><defs><radialGradient id='e' cx='.5' cy='.5' r='.5'><stop offset='0' stop-color='#5a3c1a'/><stop offset='.25' stop-color='#b39060'/><stop offset='1' stop-color='#dcc597'/></radialGradient></defs>` +
  `<ellipse cx='6' cy='18' rx='6' ry='18' fill='url(#e)'/>` +
  [15.5, 13, 10.5, 8, 5.5].map((ry, i) => `<ellipse cx='6' cy='18' rx='${(ry / 18 * 6).toFixed(2)}' ry='${ry}' fill='none' stroke='#6e5230' stroke-width='.55' opacity='${(0.75 - i * 0.08).toFixed(2)}'/>`).join("") +
  `<ellipse cx='6' cy='18' rx='1' ry='3' fill='#2a170b'/><ellipse cx='6' cy='18' rx='6' ry='18' fill='none' stroke='#4e3417' stroke-width='.6'/></svg>`,
);
// The rolled-up parchment between the finials: a shaded cylinder, faint
// wrap lines, spiral rings at each end of the roll, and the bare dowel.
export const ROLLER_BG = [
  `${FINIAL_L} left center/52px 48px no-repeat`,
  `${FINIAL_R} right center/52px 48px no-repeat`,
  `${ROLL_END} 40px 50%/12px 36px no-repeat`,
  `${ROLL_END} right 40px top 50%/12px 36px no-repeat`,
  `${GRAIN} center/calc(100% - 92px) 36px no-repeat`,
  `repeating-linear-gradient(97deg,#0000 0 31px,#5a3a1626 31px 32px,#0000 32px 58px,#fff4d618 58px 59px,#0000 59px 83px) center/calc(100% - 92px) 36px no-repeat`,
  `linear-gradient(180deg,#4e3417 0,#8f6d40 10%,#c4a774 26%,#dcc597 40%,#e9d7ac 47%,#d2b783 58%,#a68654 76%,#6f5230 90%,#432d15 100%) center/calc(100% - 92px) 36px no-repeat`,
  `linear-gradient(180deg,#24140a 0,#6e4423 30%,#b07a47 45%,#8a5a30 55%,#24140a 100%) center/calc(100% - 60px) 18px no-repeat`,
].join(",");

export const SCROLL_CSS = `:root{color-scheme:light;
--desk:#140d08;--wood-1:#2a190d;--wood-2:#5b3a20;--wood-3:#a8703f;
--parch:#e0d5b6;--parch-2:#d9caa2;--parch-3:#cebb8b;--edge:#b48f58;--rule:#b99b63;
--ink:#2e2015;--ink-2:#53402d;--ink-3:#7a6249;
--seal:#8f4210;--seal-dk:#66300b;--gold:#9a6f22;--ok:#2e5a2a;--ok-bg:#c7d1ab;--bad:#8a2417;--bad-bg:#dcbeaa;
--display:Cinzel,"Trajan Pro",Georgia,serif;--body:"EB Garamond",Garamond,Georgia,serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;min-height:100vh;padding:48px 34px 68px;color:var(--ink);font:400 1.08rem/1.6 var(--body);
background:radial-gradient(ellipse at 50% 0,#3a2414 0,transparent 60%),radial-gradient(ellipse at 50% 100%,#2a170b 0,transparent 55%),repeating-linear-gradient(92deg,#ebebe403 0 2px,#0000 2px 7px),var(--desk);background-attachment:fixed}
.scroll{position:relative;max-width:var(--scroll-w,820px);margin:0 auto}
.scroll::before,.scroll::after{content:"";position:absolute;left:-30px;right:-30px;height:48px;z-index:2;pointer-events:none;background:${ROLLER_BG};filter:drop-shadow(0 7px 7px #000a)}
.scroll::before{top:-26px}.scroll::after{bottom:-26px}
.sheet{position:relative;padding:58px clamp(26px,5vw,68px) 54px;
background:
linear-gradient(180deg,#3a22104d 0,#5a3a1626 22px,#0000 40px,#0000 calc(100% - 40px),#5a3a1626 calc(100% - 22px),#3a221055 100%),
linear-gradient(180deg,#0000 calc(31% - 7px),#6b441816 31%,#fff8e036 calc(31% + 1px),#0000 calc(31% + 9px),#0000 calc(64% - 6px),#6b441814 64%,#fff8e030 calc(64% + 1px),#0000 calc(64% + 8px)),
linear-gradient(97deg,#0000 calc(58% - 5px),#6b44180f 58%,#fff8e026 calc(58% + 1px),#0000 calc(58% + 7px)),
linear-gradient(180deg,#0000 0,#fff6dc1c 6%,#0000 11%,#6b44180c 17%,#0000 23%,#fff6dc18 30%,#0000 37%,#6b44180e 45%,#0000 52%,#fff6dc16 60%,#0000 68%,#6b44180c 76%,#0000 83%,#fff6dc14 90%,#0000 100%),
radial-gradient(ellipse 140px 90px at 82% 14%,#8a5a2422 0,#8a5a240c 60%,#0000 72%),
radial-gradient(ellipse 60px 48px at 9% 47%,#7a4a1c1e 0,#7a4a1c0a 55%,#0000 70%),
radial-gradient(ellipse 210px 130px at 30% 88%,#8a5a241a 0,#0000 70%),
radial-gradient(circle 5px at 71% 38%,#6b44182e 0,#0000 100%),radial-gradient(circle 3px at 23% 21%,#6b441833 0,#0000 100%),radial-gradient(circle 4px at 54% 79%,#6b441829 0,#0000 100%),
${GRAIN},
${WRINKLES},
radial-gradient(ellipse at 18% 12%,#e6d6ad 0,#0000 50%),radial-gradient(ellipse at 88% 78%,#cfb27a 0,#0000 46%),radial-gradient(ellipse at 40% 60%,#dfcda0 0,#0000 60%),
linear-gradient(180deg,#c3a56a 0,#d8c18e 5%,#d8c18e 95%,#c3a56a 100%);
background-size:auto,auto,auto,auto,auto,auto,auto,auto,auto,auto,220px 220px,720px 720px,auto,auto,auto,auto;
background-blend-mode:normal,normal,normal,soft-light,normal,normal,normal,normal,normal,normal,normal,overlay,normal,normal,normal,normal;
box-shadow:inset 0 0 80px #8a5a2466,inset 0 0 22px #6b44184d,inset 0 0 3px #5a3a1680;
-webkit-mask:${TORN_MASK};mask:${TORN_MASK}}
.scroll{box-shadow:0 26px 60px -10px #000d}
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
@media(max-width:640px){body{padding:30px 16px 44px;font-size:1rem}.scroll::before,.scroll::after{left:-12px;right:-12px;height:40px;background-size:44px 40px,44px 40px,10px 30px,10px 30px,calc(100% - 76px) 30px,calc(100% - 76px) 30px,calc(100% - 76px) 30px,calc(100% - 50px) 15px;background-position:left center,right center,34px 50%,right 34px top 50%,center,center,center,center}.scroll::before{top:-22px}.scroll::after{bottom:-22px}.sheet{padding:44px 22px 40px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}`;

/** Extra rules for the Guild Codex (GET /guide). */
export const GUIDE_CSS = `.scroll{--scroll-w:1080px}
.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding-bottom:24px;border-bottom:1px solid var(--rule)}
.top h1{margin-top:12px}
.intro{font-size:1.2rem;max-width:620px;font-style:italic;color:var(--ink-2)}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-width:300px;margin-top:6px}
.action-button{min-width:0;padding:11px 14px}
.action-button.ghost{background:#dccea8;color:var(--seal-dk);border-color:var(--edge);box-shadow:none}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px;align-items:start}
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
.head-links{display:flex;gap:10px;flex-wrap:wrap}.dash-head h1{margin:8px 0 4px}.dash-head p{margin:0;max-width:680px}
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
.folders{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:14px;align-items:start;margin:12px 0}
details.folder{background:linear-gradient(180deg,#e3d9bb,#d9c9a0);border:1px solid var(--edge);border-radius:6px;padding:12px 16px;min-width:0;box-shadow:0 3px 10px #6b44182b}
.board-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:18px;align-items:start;margin:22px 0}
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
dialog.editor{background:${GRAIN} 0 0/220px 220px,${WRINKLES} 0 0/720px 720px,var(--parch);background-blend-mode:normal,overlay,normal;color:var(--ink);border:1px solid var(--edge);border-top:12px solid var(--wood-2);border-bottom:12px solid var(--wood-2);border-radius:8px;width:min(560px,92vw);max-height:88vh;padding:16px 22px 22px;box-shadow:inset 0 0 50px #9a6b2c40,0 24px 60px #000c}
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
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:16px}
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

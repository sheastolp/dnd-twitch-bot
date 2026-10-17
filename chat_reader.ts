// GuildScribe — Chat Reader: reads Twitch chat aloud to the streamer, for
// console streams (Xbox/PlayStation/Switch broadcasting straight to Twitch)
// where there's no OBS and no second screen to keep an eye on chat.
//
//   GET /overlay?channel=<id|login>&panel=reader   the page: open it on a phone, tablet or PC
//                                                  near you and tap Start
//   !chatreader                                    mod/broadcaster: posts that link in chat
//
// The voice is the browser's own (Web Speech API speechSynthesis), so there's
// nothing to install and no audio leaves the device. The page reads chat as
// an anonymous guest (like Sound Bytes and the theme) and speaks it on the
// device it's open on — it is NOT meant as an OBS source (it would read chat
// to the viewers too). Settings (voice, speed, volume, what to skip) live in
// that browser's localStorage, so each device keeps its own.
//
// Skipped by default: GuildScribe's own lines, the channel's known bots
// (channel_bots.ts) and a few common ones, !commands, the streamer's own
// messages, and emote-only messages. Links are read as "link". Messages that
// mods delete, and chatters who get timed out or banned, are dropped from the
// queue before they're read. Dashboard switch "chatreader" (off by default):
// off turns the page into a notice that checks back every minute.

import { escapeHtml } from "./utils.ts";

/** Bots that are almost never worth hearing, on top of the channel's own list. */
const COMMON_BOTS = ["nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot", "soundalerts", "sery_bot", "kofistreambot", "commanderroot"];

export function renderChatReaderOff(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>Chat Reader (off)</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15100c;color:#e9dcc8;font:500 17px/1.5 system-ui,sans-serif;padding:16px;text-align:center}b{color:#f5c873}</style></head>
<body><p><b>Chat Reader is switched off.</b><br>Turn on "Chat Reader" on the GuildScribe dashboard (Stream overlays); this page checks back every minute.</p></body></html>`;
}

export function renderChatReaderPage(channelKey: string, login: string, name: string, botId: string, channelBots: Iterable<string>): string {
  const cfg = {
    login: login.toLowerCase(),
    name,
    botId,
    bots: [...new Set([...COMMON_BOTS, ...[...channelBots].map((b) => b.toLowerCase())])],
  };
  // JSON inside <script>: escape "<" so a value can never close the tag.
  const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chat Reader · ${escapeHtml(channelKey)}</title><meta name="robots" content="noindex"><meta name="theme-color" content="#15100c">
<style>
*{box-sizing:border-box}
body{margin:0;background:#15100c;color:#e9dcc8;font:500 16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}
h1{font:800 1.5rem Georgia,serif;color:#f5c873;margin:4px 0 2px}
.sub{color:#b9a68f;margin:0 0 14px;font-size:.92rem}
.bar{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
button{font:700 1rem system-ui,sans-serif;border-radius:12px;border:2px solid #e0a84a;background:#2a1f16;color:#f5c873;padding:12px 18px;cursor:pointer}
button.go{flex:1;background:#e0a84a;color:#1b130d;font-size:1.15rem;padding:16px}
button.go.on{background:#2a1f16;color:#f5c873}
button:disabled{opacity:.45;cursor:default}
.status{font-size:.9rem;color:#b9a68f;min-height:1.4em}
.status b{color:#f5c873}
details{background:#1f1711;border:1px solid #4a3725;border-radius:12px;padding:10px 14px;margin:12px 0}
summary{cursor:pointer;font-weight:700;color:#f5c873}
.opts{display:grid;gap:10px;margin-top:10px}
.opts label{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.opts select,.opts input[type=range]{flex:1;min-width:160px}
.opts select{background:#15100c;color:#e9dcc8;border:1px solid #4a3725;border-radius:8px;padding:6px}
.opts input[type=checkbox]{width:20px;height:20px;accent-color:#e0a84a}
.opts output{min-width:3.5em;text-align:right;color:#f5c873}
#log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column-reverse;gap:6px}
#log li{background:#1f1711;border-left:3px solid #4a3725;border-radius:8px;padding:8px 10px;overflow-wrap:anywhere}
#log li.now{border-left-color:#e0a84a;background:#2a1f16}
#log li.skip{opacity:.45}
#log li.gone{opacity:.35;text-decoration:line-through}
#log .who{font-weight:700;color:#f5c873;margin-right:6px}
.note{color:#8f7d68;font-size:.82rem;margin-top:16px}
</style></head><body><main>
<h1>🗣️ Chat Reader</h1>
<p class="sub">Reads #<span id="chan"></span>'s chat out loud on this device. Keep this page open (the screen stays on while it reads).</p>
<div class="bar"><button class="go" id="go" type="button">▶ Start reading chat</button><button id="skip" type="button" disabled>⏭ Skip</button></div>
<div class="status" id="status" aria-live="polite"></div>
<details id="settings"><summary>Settings</summary><div class="opts">
  <label>Voice <select id="voice"></select></label>
  <label>Speed <input type="range" id="rate" min="0.5" max="2" step="0.1"><output id="rate-o"></output></label>
  <label>Volume <input type="range" id="volume" min="0" max="1" step="0.05"><output id="volume-o"></output></label>
  <label>Longest message <input type="range" id="maxlen" min="50" max="500" step="25"><output id="maxlen-o"></output></label>
  <label><input type="checkbox" id="names"> Say who's talking ("Name says …")</label>
  <label><input type="checkbox" id="cmds"> Skip !commands</label>
  <label><input type="checkbox" id="bots"> Skip bots (GuildScribe, Nightbot, StreamElements, …)</label>
  <label><input type="checkbox" id="self"> Skip my own messages</label>
  <label><input type="checkbox" id="emotes"> Leave out emotes</label>
  <label><input type="checkbox" id="links"> Say "link" instead of reading web addresses</label>
  <button type="button" id="test">🔊 Test voice</button>
</div></details>
<ul id="log"></ul>
<p class="note">Tip: on a phone, turn off auto-lock or keep the page in front — most phones stop speaking when the browser is in the background. If the chat backs up, older messages are skipped so you're never minutes behind.</p>
</main>
<script>
(function(){
  const CFG=${cfgJson};
  const $=(id)=>document.getElementById(id);
  $("chan").textContent=CFG.login;
  const MAX_QUEUE=8,LOG_MAX=40;
  const synth=window.speechSynthesis;
  if(!synth){$("status").textContent="This browser can't speak. Try Chrome, Edge or Safari.";$("go").disabled=true;return}

  // ── Settings, kept per device ──
  const DEF={voice:"",rate:1.1,volume:1,maxlen:200,names:true,cmds:true,bots:true,self:true,emotes:true,links:true};
  let S=Object.assign({},DEF);
  try{Object.assign(S,JSON.parse(localStorage.getItem("chatreader")||"{}"))}catch(e){}
  const save=()=>{try{localStorage.setItem("chatreader",JSON.stringify(S))}catch(e){}};
  for(const k of ["names","cmds","bots","self","emotes","links"]){$(k).checked=!!S[k];$(k).onchange=()=>{S[k]=$(k).checked;save()}}
  const fmt={rate:(v)=>v.toFixed(1)+"×",volume:(v)=>Math.round(v*100)+"%",maxlen:(v)=>v+" ch"};
  for(const k of ["rate","volume","maxlen"]){const el=$(k);el.value=S[k];$(k+"-o").textContent=fmt[k](Number(S[k]));
    el.oninput=()=>{S[k]=Number(el.value);$(k+"-o").textContent=fmt[k](S[k]);save()}}
  let voices=[];
  function loadVoices(){voices=synth.getVoices();const sel=$("voice");sel.replaceChildren();
    const d=document.createElement("option");d.value="";d.textContent="Default voice";sel.append(d);
    // This device's language first, then the rest.
    const lang=(navigator.language||"en").slice(0,2);
    [...voices].sort((a,b)=>(b.lang.startsWith(lang)-a.lang.startsWith(lang))||a.name.localeCompare(b.name)).forEach((v)=>{const o=document.createElement("option");o.value=v.voiceURI;o.textContent=v.name+" ("+v.lang+")";sel.append(o)});
    sel.value=voices.some((v)=>v.voiceURI===S.voice)?S.voice:""}
  loadVoices();synth.onvoiceschanged=loadVoices;
  $("voice").onchange=()=>{S.voice=$("voice").value;save()};

  // ── Speaking ──
  let running=false,current=null,wake=null;
  const queue=[];
  function say(text,onend){const u=new SpeechSynthesisUtterance(text);const v=voices.find((x)=>x.voiceURI===S.voice);if(v){u.voice=v;u.lang=v.lang}
    u.rate=S.rate;u.volume=S.volume;u.onend=u.onerror=onend;synth.speak(u);return u}
  function next(){if(current||!running)return;const item=queue.shift();$("skip").disabled=!item;if(!item)return;
    current=item;item.li.classList.add("now");
    say(item.speech,()=>{item.li.classList.remove("now");if(current===item)current=null;next()})}
  function enqueue(item){
    // Backed up: drop the oldest waiting so the reader stays close to live.
    while(queue.length>=MAX_QUEUE){const old=queue.shift();old.li.classList.add("skip")}
    queue.push(item);$("skip").disabled=false;next()}
  function skip(){if(current){current.li.classList.remove("now");current.li.classList.add("skip");current=null}synth.cancel();next()}
  // Chrome on desktop pauses long speech after ~15 s unless nudged.
  setInterval(()=>{if(current&&synth.speaking&&!synth.paused){synth.pause();synth.resume()}},10000);

  async function keepAwake(){try{if(running&&"wakeLock" in navigator&&document.visibilityState==="visible")wake=await navigator.wakeLock.request("screen")}catch(e){}}
  document.addEventListener("visibilitychange",keepAwake);

  $("go").onclick=()=>{running=!running;const b=$("go");b.classList.toggle("on",running);b.textContent=running?"⏸ Pause reading":"▶ Start reading chat";
    if(running){say("Chat reader on.",()=>{});keepAwake();next();if(ws&&ws.readyState===1)setStatus("Reading <b>#"+CFG.login.replace(/[^a-z0-9_]/g,"")+"</b> out loud")}else{queue.forEach((q)=>q.li.classList.add("skip"));queue.length=0;skip();try{wake&&wake.release()}catch(e){}wake=null}};
  $("skip").onclick=skip;
  $("test").onclick=()=>say(S.names?"Adventurer says: the dice gods smile upon you.":"The dice gods smile upon you.",()=>{});

  // ── Turning a chat line into speech ──
  function stripEmotes(text,tag){if(!tag)return text;const cut=[];
    tag.split("/").forEach((e)=>{const r=e.split(":")[1];r&&r.split(",").forEach((p)=>{const [a,b]=p.split("-").map(Number);cut.push([a,b])})});
    if(!cut.length)return text;cut.sort((x,y)=>y[0]-x[0]);const cp=[...text];for(const [a,b] of cut)cp.splice(a,b-a+1);return cp.join("")}
  function toSpeech(text,tags){
    if(S.emotes)text=stripEmotes(text,tags.emotes);
    if(S.links)text=text.replace(/\\bhttps?:\\/\\/\\S+|\\bwww\\.\\S+/gi,"link");
    text=text.replace(/(\\S)\\1{4,}/g,"$1$1$1") // "lolllllll" → "lolll"
      .replace(/\\b(\\S+)(\\s+\\1\\b){2,}/gi,"$1 $1") // "hype hype hype hype" → "hype hype"
      .replace(/\\s+/g," ").trim();
    if(text.length>S.maxlen)text=text.slice(0,S.maxlen).replace(/\\s+\\S*$/,"")+"…";
    return text}

  const logEl=$("log");
  function logLine(who,text,cls){const li=document.createElement("li");if(cls)li.className=cls;const w=document.createElement("span");w.className="who";w.textContent=who;li.append(w,text);
    logEl.append(li);while(logEl.children.length>LOG_MAX)logEl.firstElementChild.remove();return li}

  function onChat(tags,login,text){
    const who=tags["display-name"]||login;
    // ACTION (/me) lines arrive wrapped in \\x01ACTION … \\x01.
    const me=text.match(/^\\x01ACTION (.*)\\x01$/);if(me)text=me[1];
    let why="";
    if(S.bots&&login!==CFG.login&&(tags["user-id"]===CFG.botId||CFG.bots.includes(login)))why="bot";
    if(S.self&&login===CFG.login)why="you";
    if(S.cmds&&/^!\\S/.test(text))why="command";
    const speech=why?"":toSpeech(text,tags);
    if(!why&&!speech)why="emotes only";
    const li=logLine(who,text,why||!running?"skip":"");
    if(why||!running)return;
    const pre=S.names?(me?who+" ":who+" says: "):"";
    enqueue({id:tags.id,user:tags["user-id"],li,speech:pre+speech});
  }
  // A mod deleted a message, or timed out / banned a chatter: don't read it.
  function drop(match){for(let i=queue.length-1;i>=0;i--)if(match(queue[i])){queue[i].li.classList.add("gone");queue.splice(i,1)}
    if(current&&match(current)){current.li.classList.add("gone");skip()}}

  // ── Twitch chat over WebSocket, as an anonymous "justinfan" reader ──
  let ws,backoff=1000,pingTimer;
  const setStatus=(html)=>{$("status").innerHTML=html};
  function connect(){setStatus("Connecting to #"+CFG.login.replace(/[^a-z0-9_]/g,"")+"…");
    ws=new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    ws.onopen=()=>{ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");ws.send("PASS SCHMOOPIIE");ws.send("NICK justinfan"+(10000+Math.floor(Math.random()*80000)));ws.send("JOIN #"+CFG.login);
      clearInterval(pingTimer);pingTimer=setInterval(()=>ws.readyState===1&&ws.send("PING :tmi.twitch.tv"),240000)};
    ws.onmessage=(e)=>String(e.data).split("\\r\\n").forEach(handle);
    ws.onclose=()=>{clearInterval(pingTimer);setStatus("Lost the connection, reconnecting…");setTimeout(connect,backoff);backoff=Math.min(backoff*2,30000)};
  }
  function handle(raw){if(!raw)return;
    if(raw.startsWith("PING")){ws.send("PONG"+raw.slice(4));return}
    let rest=raw;const tags={};
    if(rest[0]==="@"){const sp=rest.indexOf(" ");rest.slice(1,sp).split(";").forEach((kv)=>{const i=kv.indexOf("=");tags[kv.slice(0,i)]=kv.slice(i+1)});rest=rest.slice(sp+1)}
    const m=rest.match(/^:([^!\\s]+)!\\S+ PRIVMSG #\\S+ :(.*)$/);
    if(m){onChat(tags,m[1].toLowerCase(),m[2]);return}
    if(/ CLEARMSG /.test(rest)){const id=tags["target-msg-id"];if(id)drop((q)=>q.id===id);return}
    if(/ CLEARCHAT /.test(rest)){const uid=tags["target-user-id"];drop((q)=>!uid||q.user===uid);return}
    if(/ 366 /.test(rest)){backoff=1000;setStatus("Listening to <b>#"+CFG.login.replace(/[^a-z0-9_]/g,"")+"</b>"+(running?"":" — tap Start to hear it"))}
  }
  connect();
})();
</script></body></html>`;
}

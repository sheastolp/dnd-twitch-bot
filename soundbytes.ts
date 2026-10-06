// GuildScribe — Sound Bytes: tavern sound effects for the stream, ported from
// the Tavernworks Sound Bytes page (tavernworks.dev/soundbytes). Chat fires a
// sound, GuildScribe answers with a line that starts with a "🔊 <sound>" tag,
// and the Sound Bytes overlay (an OBS browser source) plays it.
//
//   !sound <name>                   anyone: play a sound (channel-wide cooldown; mods skip it)
//   !sound / !sounds                anyone: list the sounds
//   !sound cooldown [<secs>|off]    mod/broadcaster: show or set the cooldown (max 10 min)
//   GET /overlay?channel=<id|login>&panel=sounds   the overlay (1920×1080, see-through)
//       &volume=0-100  &caption=0 (sound only)  &test=<sound> (plays once on load)
//
// Every sound is synthesized live in the browser with the Web Audio API, so
// there are no audio files to host, license or load. The overlay reads chat
// as an anonymous guest (like the theme and The Endless Delve) and reacts
// only to GuildScribe's own messages (TWITCH_BOT_ID) that *start* with the
// tag. Replies that echo viewer text always start with "@user", so viewers
// can't fire sounds by typing a tag themselves; a channel's own custom
// commands and triggers whose response starts with "🔊 <sound>" play too
// (e.g. !dndbot add crit 🔊 nat20 CRITICAL HIT from {user}!), which keeps the
// Tavernworks page's setup working unchanged. Dashboard switch "soundbytes"
// (on by default): off silences !sound and turns the overlay into an empty
// source that checks back every minute.
//
// Channels add their own sounds too (soundbytes_library.ts): picked from
// online sound repositories or added as a file on /dashboard/sounds, then
// played with !sound <name> like the built-in ones. !sound credit <name>
// posts where a sound came from (Creative Commons BY needs the credit).

import { sqlite } from "./sqlite.ts";
import { sendChatMessage } from "./twitch.ts";
import { getCustomCommand, isCommandGroupEnabled } from "./db.ts";
import { escapeHtml } from "./utils.ts";
import { getCustomSound, listCustomSounds, MAX_PLAY_SECONDS, type CustomSound } from "./soundbytes_library.ts";

export type SoundByte = { id: string; cmd: string; name: string; icon: string; blurb: string; line: string; len: number };

// `line` follows the tag in chat; {user} is the chatter's name. `cmd` is the
// name to type when it can't simply be the id: "fireball" anywhere in a chat
// message is a spell in The Endless Delve (idle.ts), so the fireball sound is
// listed as "kaboom" (typing !sound fireball still works, and casts there too).
// `len` (seconds) must match the sound's length in SYNTH_JS below.
export const SOUND_BYTES: SoundByte[] = [
  { id: "nat20", cmd: "nat20", name: "Natural 20", icon: "🌟", blurb: "A brass fanfare fit for a crit.", line: "{user} rolled a NATURAL 20! The bards are already writing the song.", len: 1.9 },
  { id: "nat1", cmd: "nat1", name: "Natural 1", icon: "💀", blurb: "The sad trombone of critical failure.", line: "{user} rolled a natural 1. The dice gods turn away in shame.", len: 2.2 },
  { id: "dice", cmd: "dice", name: "Dice Roll", icon: "🎲", blurb: "A handful of dice rattling across the table.", line: "{user} shakes the dice cup and lets them fly...", len: 1.0 },
  { id: "sword", cmd: "sword", name: "Sword Clash", icon: "⚔️", blurb: "Steel on steel, ringing out.", line: "⚔️ Steel rings out! {user} crosses blades with destiny.", len: 1.4 },
  { id: "coins", cmd: "coins", name: "Coin Purse", icon: "🪙", blurb: "Gold spilling onto the bar.", line: "🪙 {user} empties a jingling purse onto the bar. Drinks are on them!", len: 1.1 },
  { id: "ding", cmd: "ding", name: "Level Up", icon: "⬆️", blurb: "A chiptune climb to the next level.", line: "⬆️ {user} feels stronger. LEVEL UP!", len: 1.2 },
  { id: "fireball", cmd: "kaboom", name: "Fireball", icon: "🔥", blurb: "A roaring whoosh and a big boom.", line: "🔥 {user} casts FIREBALL! Everyone make a Dex save.", len: 2.0 },
  { id: "heal", cmd: "heal", name: "Healing Light", icon: "✨", blurb: "A shimmering cleric's blessing.", line: "✨ A warm light washes over {user}. Hit points restored!", len: 2.0 },
  { id: "drumroll", cmd: "drumroll", name: "Drumroll", icon: "🥁", blurb: "Building suspense, then a cymbal crash.", line: "🥁 {user} calls for a drumroll... the moment of truth!", len: 3.0 },
  { id: "roar", cmd: "roar", name: "Dragon Roar", icon: "🐉", blurb: "Something big just woke up.", line: "🐉 {user} woke the dragon. Roll initiative!", len: 2.4 },
  { id: "bell", cmd: "bell", name: "Tavern Bell", icon: "🔔", blurb: "Last call! Or first call. Who's counting?", line: "🔔 {user} rings the tavern bell. A round for the house!", len: 2.8 },
];

export const DEFAULT_SOUND_COOLDOWN_SECONDS = 15;
export const MAX_SOUND_COOLDOWN_SECONDS = 600;

/** A sound by its id, its listed name ("kaboom") or its title ("Dragon Roar"). */
export function findSoundByte(word: string): SoundByte | undefined {
  const w = word.trim().toLowerCase().replace(/^🔊\s*/, "").replace(/[\s_-]+/g, "");
  if (!w) return undefined;
  return SOUND_BYTES.find((s) => s.id === w || s.cmd === w || s.name.toLowerCase().replace(/\s+/g, "") === w);
}

/** Words !sound takes itself, so a channel's own sound can't be called them. */
const SUBCOMMANDS = new Set(["list", "help", "cooldown", "cd", "credit", "credits"]);

/** True when a custom sound can't use `name`: a built-in sound or a !sound word. */
export const isReservedSoundName = (name: string) => SUBCOMMANDS.has(name) || Boolean(findSoundByte(name));

export async function ensureSoundByteTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS soundbyte_settings (
      broadcaster_id TEXT PRIMARY KEY, cooldown_seconds INTEGER, last_played_at INTEGER
    )`,
  );
}

export async function purgeSoundByteData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM soundbyte_settings WHERE broadcaster_id = ?", [broadcasterId]);
}

async function getSettings(broadcasterId: string): Promise<{ cooldown: number; lastAt: number }> {
  const res = await sqlite.execute("SELECT cooldown_seconds, last_played_at FROM soundbyte_settings WHERE broadcaster_id = ?", [broadcasterId]);
  const r: any = res.rows[0];
  const cd = r?.cooldown_seconds;
  return {
    cooldown: cd === null || cd === undefined ? DEFAULT_SOUND_COOLDOWN_SECONDS : Number(cd),
    lastAt: Number(r?.last_played_at ?? 0),
  };
}

/** Claims the channel's cooldown: true when a sound may play now. One UPDATE,
 * so two chatters firing at once can't both get through. */
async function claimCooldown(broadcasterId: string, cooldownSeconds: number, now = Date.now()): Promise<boolean> {
  await sqlite.execute("INSERT OR IGNORE INTO soundbyte_settings (broadcaster_id, cooldown_seconds, last_played_at) VALUES (?, NULL, 0)", [broadcasterId]);
  const res = await sqlite.execute(
    "UPDATE soundbyte_settings SET last_played_at = ? WHERE broadcaster_id = ? AND COALESCE(last_played_at, 0) <= ?",
    [now, broadcasterId, now - cooldownSeconds * 1000],
  );
  return Number(res.rowsAffected ?? 0) > 0;
}

async function stampPlayed(broadcasterId: string, now = Date.now()) {
  await sqlite.execute(
    `INSERT INTO soundbyte_settings (broadcaster_id, cooldown_seconds, last_played_at) VALUES (?, NULL, ?)
     ON CONFLICT(broadcaster_id) DO UPDATE SET last_played_at = excluded.last_played_at`,
    [broadcasterId, now],
  );
}

async function setCooldown(broadcasterId: string, seconds: number) {
  await sqlite.execute(
    `INSERT INTO soundbyte_settings (broadcaster_id, cooldown_seconds, last_played_at) VALUES (?, ?, 0)
     ON CONFLICT(broadcaster_id) DO UPDATE SET cooldown_seconds = excluded.cooldown_seconds`,
    [broadcasterId, seconds],
  );
}

const soundList = (custom: CustomSound[] = []) =>
  [...SOUND_BYTES.map((s) => `${s.icon} ${s.cmd}`), ...custom.map((c) => `${c.icon} ${c.name}`)].join(" | ");

/** The chat line that plays a channel's own sound. */
export const customSoundLine = (c: CustomSound, display: string) => `🔊 ${c.name} ${display} plays ${c.title}!`;

/** The chat line that plays `s` on the overlay. The tag must lead the message. */
export const soundByteLine = (s: SoundByte, display: string) => `🔊 ${s.id} ${s.line.replaceAll("{user}", display)}`;

export async function handleSoundByteCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
): Promise<boolean> {
  const match = chatMessage.match(/^!(sounds?)(?:\s+([\s\S]*))?$/i);
  if (!match) return false;
  // Switched off, or the channel has its own !sound: fall through to it.
  const [on, custom] = await Promise.all([
    isCommandGroupEnabled(broadcasterId, "soundbytes"),
    getCustomCommand(broadcasterId, match[1].toLowerCase()),
  ]);
  if (!on || custom) return false;
  const arg = (match[2] ?? "").trim();
  const overlayHint = `Plays on stream through the Sound Bytes overlay (mods: !overlays).`;

  if (!arg || /^(list|help)$/i.test(arg)) {
    const custom = await listCustomSounds(broadcasterId);
    await sendChatMessage(`@${display} 🔊 Sound Bytes — !sound <name>: ${soundList(custom)}. ${overlayHint}`, broadcasterId);
    return true;
  }

  const credit = arg.match(/^credits?(?:\s+(\S+))?$/i);
  if (credit) {
    const custom = await listCustomSounds(broadcasterId);
    if (!credit[1]) {
      const credited = custom.filter((c) => c.credit);
      await sendChatMessage(
        credited.length
          ? `@${display} 🔊 Sound credits: ${credited.map((c) => `${c.name}: ${c.credit}`).join(" · ")}`.slice(0, 480)
          : `@${display} 🔊 The built-in sounds are GuildScribe's own${custom.length ? ", and this channel's own sounds carry no credits" : ""}.`,
        broadcasterId,
      );
      return true;
    }
    const name = credit[1].toLowerCase();
    const c = custom.find((x) => x.name === name);
    await sendChatMessage(
      c ? `@${display} 🔊 ${c.name}: ${c.credit || "no credit given"}${c.pageUrl ? ` — ${c.pageUrl}` : ""}` : findSoundByte(name) ? `@${display} 🔊 ${name} is one of GuildScribe's own built-in sounds.` : `@${display} no sound by that name.`,
      broadcasterId,
    );
    return true;
  }

  const cd = arg.match(/^(?:cooldown|cd)(?:\s+(\S+))?$/i);
  if (cd) {
    if (!cd[1]) {
      const { cooldown } = await getSettings(broadcasterId);
      await sendChatMessage(`@${display} 🔊 Sound cooldown: ${cooldown ? `${cooldown}s between sounds for the whole channel` : "off"}.${isModerator ? " Change it with !sound cooldown <seconds|off>." : ""}`, broadcasterId);
      return true;
    }
    if (!isModerator) {
      await sendChatMessage(`@${display} only the broadcaster or a mod can change the sound cooldown.`, broadcasterId);
      return true;
    }
    const raw = cd[1].toLowerCase();
    const secs = raw === "off" ? 0 : Number(raw.replace(/s$/, ""));
    if (!Number.isInteger(secs) || secs < 0 || secs > MAX_SOUND_COOLDOWN_SECONDS) {
      await sendChatMessage(`@${display} usage: !sound cooldown <0-${MAX_SOUND_COOLDOWN_SECONDS} seconds|off>.`, broadcasterId);
      return true;
    }
    await setCooldown(broadcasterId, secs);
    await sendChatMessage(`@${display} 🔊 Sound cooldown ${secs ? `set to ${secs}s` : "turned off"}.`, broadcasterId);
    return true;
  }

  const sound = findSoundByte(arg) ?? findSoundByte(arg.split(/\s+/)[0]);
  const own = sound ? null : await getCustomSound(broadcasterId, arg.split(/\s+/)[0].toLowerCase().replace(/^🔊/, ""));
  if (!sound && !own) {
    await sendChatMessage(`@${display} no sound by that name. Try: ${soundList(await listCustomSounds(broadcasterId))}.`, broadcasterId);
    return true;
  }
  const { cooldown, lastAt } = await getSettings(broadcasterId);
  if (isModerator || cooldown <= 0) {
    await stampPlayed(broadcasterId);
  } else if (!(await claimCooldown(broadcasterId, cooldown))) {
    const wait = Math.max(1, Math.ceil((lastAt + cooldown * 1000 - Date.now()) / 1000));
    await sendChatMessage(`@${display} the bard is catching their breath — next sound in ${wait}s.`, broadcasterId);
    return true;
  }
  await sendChatMessage(sound ? soundByteLine(sound, display) : customSoundLine(own!, display), broadcasterId);
  return true;
}

// ── The overlay ─────────────────────────────────────────────────────────────

// The synth, one play function per sound id. Ported from Tavernworks'
// soundbytes/sounds.js; plain browser JS, embedded in the overlay page.
const SYNTH_JS = `
const SoundSynth=(function(){
  let ctx=null,master=null,noiseBuf=null;
  function audio(){
    if(!ctx){
      ctx=new (window.AudioContext||window.webkitAudioContext)();
      const comp=ctx.createDynamicsCompressor();comp.threshold.value=-10;comp.ratio.value=6;comp.connect(ctx.destination);
      master=ctx.createGain();master.connect(comp);
      noiseBuf=ctx.createBuffer(1,ctx.sampleRate*2,ctx.sampleRate);
      const d=noiseBuf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;
    }
    if(ctx.state==="suspended")ctx.resume();
    return ctx;
  }
  // An attack/decay envelope on a fresh gain node.
  function env(out,t,dur,peak,attack=0.01){const g=ctx.createGain();g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(peak,t+attack);g.gain.exponentialRampToValueAtTime(0.0001,t+dur);g.connect(out);return g}
  // One oscillator, optionally sliding from freq to "to".
  function tone(out,{type="sine",freq,to,t=0,dur=0.3,gain=0.3,attack=0.01,vibrato=0,detune=0}){
    const start=ctx.currentTime+t,o=ctx.createOscillator();o.type=type;o.detune.value=detune;
    o.frequency.setValueAtTime(freq,start);if(to)o.frequency.exponentialRampToValueAtTime(to,start+dur);
    if(vibrato){const lfo=ctx.createOscillator(),depth=ctx.createGain();lfo.frequency.value=vibrato;depth.gain.value=freq*0.03;lfo.connect(depth).connect(o.frequency);lfo.start(start);lfo.stop(start+dur)}
    o.connect(env(out,start,dur,gain,attack));o.start(start);o.stop(start+dur+0.05);
  }
  // A burst of filtered white noise, optionally sweeping the filter.
  function noise(out,{t=0,dur=0.2,gain=0.3,type="bandpass",freq=2000,to,q=1,attack=0.005}){
    const start=ctx.currentTime+t,src=ctx.createBufferSource();src.buffer=noiseBuf;src.loop=true;
    const f=ctx.createBiquadFilter();f.type=type;f.Q.value=q;f.frequency.setValueAtTime(freq,start);if(to)f.frequency.exponentialRampToValueAtTime(to,start+dur);
    src.connect(f).connect(env(out,start,dur,gain,attack));src.start(start,Math.random());src.stop(start+dur+0.05);
  }
  function lowpass(out,freq){const f=ctx.createBiquadFilter();f.type="lowpass";f.frequency.value=freq;f.connect(out);return f}
  function drive(out,amount){const ws=ctx.createWaveShaper(),n=1024,curve=new Float32Array(n);for(let i=0;i<n;i++){const x=(i/n)*2-1;curve[i]=Math.tanh(x*amount)}ws.curve=curve;ws.connect(out);return ws}
  const N=(semis)=>261.63*Math.pow(2,semis/12); // semitones from middle C
  const PLAY={
    nat20(out){const brass=lowpass(out,2600);
      [[0,0,0.14],[7,0.15,0.14],[12,0.3,0.14],[16,0.45,1.3]].forEach(([s,t,dur])=>{tone(brass,{type:"sawtooth",freq:N(s),t,dur,gain:0.22,attack:0.03,vibrato:dur>1?5.5:0});tone(brass,{type:"sawtooth",freq:N(s-12),t,dur,gain:0.12,attack:0.03,detune:6})});
      [0,4,7].forEach((s)=>tone(out,{type:"triangle",freq:N(s+12),t:0.45,dur:1.3,gain:0.08,attack:0.05}));
      noise(out,{t:0.45,dur:1.2,gain:0.05,type:"highpass",freq:7000})},
    nat1(out){const horn=lowpass(out,1400);
      [[N(-2),0,0.42],[N(-3),0.45,0.42],[N(-4),0.9,0.42]].forEach(([freq,t,dur])=>tone(horn,{type:"sawtooth",freq,t,dur,gain:0.3,attack:0.04}));
      tone(horn,{type:"sawtooth",freq:N(-5),to:N(-7),t:1.35,dur:0.85,gain:0.3,attack:0.04,vibrato:7})},
    dice(out){let t=0;for(let i=0;i<14;i++){t+=0.025+Math.random()*(0.03+i*0.006);
      noise(out,{t,dur:0.03+Math.random()*0.03,gain:0.5-i*0.025,freq:2500+Math.random()*3000,q:4});
      tone(out,{type:"triangle",freq:900+Math.random()*900,t,dur:0.04,gain:0.08})}},
    sword(out){noise(out,{dur:0.12,gain:0.6,type:"highpass",freq:3000,attack:0.001});
      [2310,3170,4420,5980,7230].forEach((freq,i)=>tone(out,{freq,to:freq*0.995,dur:1.3-i*0.18,gain:0.12-i*0.015,attack:0.002}));
      noise(out,{t:0.05,dur:0.6,gain:0.08,freq:6000,q:8})},
    coins(out){let t=0;for(let i=0;i<9;i++){t+=0.04+Math.random()*0.08;const f=2600+Math.random()*1800;
      tone(out,{freq:f,t,dur:0.25,gain:0.12,attack:0.002});tone(out,{freq:f*1.5,t,dur:0.2,gain:0.08,attack:0.002});tone(out,{freq:f*2.76,t,dur:0.12,gain:0.04,attack:0.002})}},
    ding(out){[0,4,7,12,16,19,24].forEach((s,i)=>tone(out,{type:"square",freq:N(s+12),t:i*0.07,dur:0.12,gain:0.08,attack:0.003}));
      [12,16,19,24].forEach((s)=>tone(out,{type:"square",freq:N(s+12),t:0.5,dur:0.65,gain:0.05,attack:0.003,vibrato:6}))},
    fireball(out){noise(out,{dur:0.7,gain:0.35,type:"lowpass",freq:300,to:3500,attack:0.5});
      const boom=drive(out,3);tone(boom,{freq:110,to:32,t:0.65,dur:1.2,gain:0.7,attack:0.005});
      noise(out,{t:0.65,dur:1.3,gain:0.5,type:"lowpass",freq:2500,to:150,attack:0.005})},
    heal(out){[0,4,7,11,14,19,23,26].forEach((s,i)=>{tone(out,{freq:N(s+12),t:i*0.09,dur:1.2,gain:0.07,attack:0.04});tone(out,{freq:N(s+12),t:i*0.09,dur:1.2,gain:0.05,attack:0.04,detune:9})});
      noise(out,{dur:1.9,gain:0.04,type:"highpass",freq:8000,attack:0.6})},
    drumroll(out){for(let i=0;i<34;i++){const t=i*0.055;noise(out,{t,dur:0.06,gain:0.08+(i/34)*0.3,freq:1800,q:0.8});tone(out,{type:"triangle",freq:190,to:120,t,dur:0.05,gain:0.05+(i/34)*0.12})}
      noise(out,{t:1.9,dur:1.1,gain:0.45,type:"highpass",freq:5000,attack:0.002});tone(out,{freq:90,to:50,t:1.9,dur:0.4,gain:0.5,attack:0.002})},
    roar(out){const growl=drive(lowpass(out,1200),4);
      tone(growl,{type:"sawtooth",freq:140,to:55,dur:2.2,gain:0.35,attack:0.25,vibrato:18});tone(growl,{type:"sawtooth",freq:147,to:58,dur:2.2,gain:0.25,attack:0.25,vibrato:23});
      noise(out,{dur:2.2,gain:0.3,freq:700,to:250,q:1.5,attack:0.3})},
    bell(out){[[1,0.25],[2.0,0.15],[2.76,0.12],[5.4,0.07],[8.93,0.04]].forEach(([m,g])=>{tone(out,{freq:523*m,dur:2.7,gain:g,attack:0.002});tone(out,{freq:523*m,t:0.45,dur:2.3,gain:g*0.7,attack:0.002})})},
  };
  // Plays a sound (volume 0..1); len is its length in seconds.
  return {play(id,len,volume){const fn=PLAY[id];if(!fn)return;audio();const out=ctx.createGain();out.gain.value=Math.max(0,Math.min(1,volume));out.connect(master);fn(out);setTimeout(()=>out.disconnect(),(len+1)*1000)}};
})();`;

/** The Sound Bytes overlay: see-through until a sound plays, then a card at
 * the bottom centre while it plays. `always` (setup-page preview) shows a
 * sample card and never connects to chat. &fit=1 (the theme's Dungeon Gate)
 * centres the card in the frame instead, stacked, shrunk to fit if need be,
 * and tells the parent page while it's up (postMessage {soundbyte: bool}).
 * `custom` are the channel's own sounds (soundbytes_library.ts), played from
 * `src`; one added after the page loaded is fetched from /overlay/sounds. */
export function renderSoundBytesOverlay(
  channelKey: string,
  login: string,
  botId: string,
  always: boolean,
  channelId = "",
  custom: Array<{ id: string; name: string; icon: string; src: string }> = [],
): string {
  const cfg = {
    login: login.toLowerCase(),
    botId,
    always,
    channel: channelId,
    maxPlay: MAX_PLAY_SECONDS,
    sounds: {
      ...Object.fromEntries(custom.map((c) => [c.id, { name: c.name, icon: c.icon, src: c.src }])),
      ...Object.fromEntries(SOUND_BYTES.map((s) => [s.id, { name: s.name, icon: s.icon, len: s.len }])),
    },
  };
  // JSON inside <script>: escape "<" so a value can never close the tag.
  const cfgJson = JSON.stringify(cfg).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sound Bytes · ${escapeHtml(channelKey)}</title><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@800&family=Inter:wght@500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:transparent;overflow:hidden;height:100%}
body{font-family:Inter,system-ui,sans-serif;color:#f1e6d6}
.stage{position:fixed;left:0;right:0;bottom:6vh;display:flex;justify-content:center;pointer-events:none}
.pop{display:flex;align-items:center;gap:18px;max-width:min(92vw,820px);padding:16px 26px 16px 18px;border-radius:18px;
  background:linear-gradient(180deg,rgba(36,26,19,.94),rgba(21,16,12,.94));border:2px solid #e0a84a;
  box-shadow:0 12px 40px rgba(0,0,0,.55),0 0 30px rgba(224,168,74,.25);
  transform:translateY(30px) scale(.92);opacity:0;transition:transform .35s cubic-bezier(.2,1.4,.4,1),opacity .3s}
.pop.show{transform:none;opacity:1}
.pop .icon{font-size:54px;line-height:1;filter:drop-shadow(0 0 14px rgba(245,200,115,.5))}
.pop .name{font-family:Cinzel,serif;font-weight:800;font-size:30px;line-height:1.1;color:#f5c873}
.pop .line{font-size:18px;font-weight:500;color:#e9dcc8;margin-top:4px;overflow-wrap:anywhere}
.fit .stage{top:0;bottom:0;align-items:center;padding:12px}
.fit .pop{flex-direction:column;text-align:center;gap:10px;padding:18px 22px;max-width:100%}
.status{position:fixed;top:12px;left:12px;font:600 14px Inter,system-ui,sans-serif;padding:8px 12px;border-radius:10px;background:rgba(0,0,0,.7);color:#b9a68f}
.status b{color:#f5c873}
</style></head><body>
<div class="stage"><div class="pop" id="pop" aria-live="polite"><div class="icon" id="pop-icon"></div><div><div class="name" id="pop-name"></div><div class="line" id="pop-line"></div></div></div></div>
<div class="status" id="status" hidden></div>
<script>${SYNTH_JS}
(function(){
  const CFG=${cfgJson};
  const q=new URLSearchParams(location.search);
  const volume=Math.max(0,Math.min(100,Number(q.get("volume")??70)||0))/100;
  const caption=q.get("caption")!=="0";
  const debug=q.get("debug")==="1";
  const quiet=q.get("quiet")==="1"&&!debug; // embedded in the theme: no connection chip
  const fit=q.get("fit")==="1";
  if(fit)document.body.classList.add("fit");
  const stage=document.querySelector(".stage");
  const tell=(on)=>{if(fit&&parent!==window)try{parent.postMessage({soundbyte:on},location.origin)}catch(e){}};
  const MAX_QUEUE=5;
  // Anchored to the start of GuildScribe's own message (see soundbytes.ts).
  const TAG=/^\\u{1F50A}\\s*!?([a-z0-9_-]{2,25})/iu;
  const pop=document.getElementById("pop"),status=document.getElementById("status");
  const show=(id,line)=>{const s=CFG.sounds[id];document.getElementById("pop-icon").textContent=s.icon;document.getElementById("pop-name").textContent=s.name;document.getElementById("pop-line").textContent=line;
    // In a frame (&fit=1), shrink the card until it fits.
    if(fit){stage.style.transform="none";const k=Math.min(1,(innerWidth-24)/Math.max(1,pop.offsetWidth),(innerHeight-24)/Math.max(1,pop.offsetHeight));stage.style.transform="scale("+k.toFixed(3)+")"}
    pop.classList.add("show");tell(true)};
  if(CFG.always){show("nat20","A sound plays here, with this card, when chat types !sound <name>.");return}

  let hideStatus;
  const setStatus=(text,sticky)=>{if(quiet)return;status.textContent=text;status.hidden=false;clearTimeout(hideStatus);if(!sticky&&!debug)hideStatus=setTimeout(()=>status.hidden=true,5000)};

  // A sound the channel added after this page loaded: fetch the list again (at most every 10 s).
  let lastRefresh=0;
  async function refresh(){if(!CFG.channel||Date.now()-lastRefresh<10000)return;lastRefresh=Date.now();
    try{const r=await fetch("/overlay/sounds?channel="+encodeURIComponent(CFG.channel),{cache:"no-store"});const j=await r.json();
      if(j&&j.ok)j.sounds.forEach((c)=>{if(!CFG.sounds[c.id]||CFG.sounds[c.id].src)CFG.sounds[c.id]={name:c.name,icon:c.icon,src:c.src}})}catch(e){}}
  // A channel's own sound: an audio file, cut off after CFG.maxPlay seconds.
  function playFile(s,done){const a=new Audio(s.src);a.volume=volume;let fin=false;
    const end=()=>{if(fin)return;fin=true;clearTimeout(cap);try{a.pause()}catch(e){}done()};
    const cap=setTimeout(end,CFG.maxPlay*1000);a.addEventListener("ended",end);a.addEventListener("error",end);a.play().catch(end)}

  // One sound at a time, in the order chat fired them; past MAX_QUEUE waiting, skip.
  const queue=[];let playing=false;
  function enqueue(id,line){if(!CFG.sounds[id]){refresh().then(()=>{if(CFG.sounds[id])enqueue(id,line)});return}
    if(queue.length>=MAX_QUEUE)return;queue.push({id,line});if(!playing)next()}
  function next(){const item=queue.shift();if(!item){playing=false;return}playing=true;
    const s=CFG.sounds[item.id],t0=Date.now();if(caption)show(item.id,item.line);
    // The card stays at least 3 s, then the next sound follows.
    const finish=()=>setTimeout(()=>{pop.classList.remove("show");tell(false);setTimeout(next,450)},Math.max(0,3000-(Date.now()-t0)));
    if(s.src)playFile(s,finish);else{SoundSynth.play(item.id,s.len,volume);setTimeout(finish,s.len*1000)}}

  // Twitch chat over WebSocket, as an anonymous "justinfan" reader.
  let ws,backoff=1000,pingTimer;
  function connect(){if(!CFG.login)return;setStatus("Connecting to #"+CFG.login+"…",true);
    ws=new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    ws.onopen=()=>{ws.send("CAP REQ :twitch.tv/tags");ws.send("PASS SCHMOOPIIE");ws.send("NICK justinfan"+(10000+Math.floor(Math.random()*80000)));ws.send("JOIN #"+CFG.login);
      clearInterval(pingTimer);pingTimer=setInterval(()=>ws.readyState===1&&ws.send("PING :tmi.twitch.tv"),240000)};
    ws.onmessage=(e)=>String(e.data).split("\\r\\n").forEach(handle);
    ws.onclose=()=>{clearInterval(pingTimer);setStatus("Lost #"+CFG.login+", reconnecting…",true);setTimeout(connect,backoff);backoff=Math.min(backoff*2,30000)};
  }
  function handle(raw){if(!raw)return;
    if(raw.startsWith("PING")){ws.send("PONG"+raw.slice(4));return}
    let rest=raw;const tags={};
    if(rest[0]==="@"){const sp=rest.indexOf(" ");rest.slice(1,sp).split(";").forEach((kv)=>{const i=kv.indexOf("=");tags[kv.slice(0,i)]=kv.slice(i+1)});rest=rest.slice(sp+1)}
    const m=rest.match(/^:([^!\\s]+)!\\S+ PRIVMSG #\\S+ :(.*)$/);
    if(!m){if(/ 366 /.test(rest)){backoff=1000;setStatus("🔊 Sound Bytes listening to #"+CFG.login)}return}
    // Only GuildScribe's own messages count: its cooldowns decide how often a sound goes off.
    if(!CFG.botId||tags["user-id"]!==CFG.botId)return;
    const hit=m[2].match(TAG);if(!hit)return;
    enqueue(hit[1].toLowerCase(),m[2].replace(TAG,"").replace(/^\\s*[-–—:|]?\\s*/,"").trim());
  }
  connect();
  const test=(q.get("test")||"").toLowerCase();
  if(test)setTimeout(()=>enqueue(test,"Testing, testing. Is this thing on?"),800);
})();
</script></body></html>`;
}


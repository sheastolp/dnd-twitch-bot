// The dashboard's "Quick setup": GuildScribe's features as a handful of
// streamer-sized bundles (Gold, Fighting, Raid boss, The Endless Delve, …),
// each with a plain-words summary of what it does on stream and what, if
// anything, the streamer has to do. Flip any number of them and save once.
//
// A bundle is a set of the dashboard's existing switches: COMMAND_GROUPS keys
// (commandgroups.ts) and the dedicated ones (points, market, hoard, …). It
// reads On when all of them are on, Off when all are off, and Mixed
// otherwise; a mixed bundle offers "Leave as is" so saving never flattens
// fine-tuning done in the full switch list further down the page. Only
// bundles whose choice differs from their current state are written. A
// bundle with a master switch (Gold, Hunt and Hoard) reads Off while the
// master is off, since nothing in it works then.

import { escapeHtml } from "./utils.ts";
import { COMMAND_GROUPS } from "./commandgroups.ts";
import { OPTIONS, defaultText, type OptionDef } from "./channel_options.ts";

export type QuickBundle = {
  key: string;
  icon: string;
  name: string;
  /** What it does on stream, for the streamer. */
  what: string;
  /** What the streamer has to do. */
  yourPart: string;
  /** Dashboard switches it turns on/off together. */
  switches: string[];
  /** Other bundles it can't work without (shown, and checked on save). */
  needs?: string[];
  /** The module's own master switch: while it's off the whole bundle is off,
   * whatever its sub-switches say (they default on, the module defaults off). */
  master?: string;
};

export const QUICK_BUNDLES: QuickBundle[] = [
  {
    key: "gold", icon: "🪙", name: "Gold & giveaways",
    what: "Viewers earn gold just by chatting while you're live, check it with !gold, gift it and race up a leaderboard. Run a giveaway any time with !giveaway.",
    yourPart: "Nothing — it runs itself.",
    switches: ["points", "chatgold", "goldcheck", "goldgive", "leaderboard", "giveaways", "rob"],
    master: "points",
  },
  {
    key: "characters", icon: "🧙", name: "Characters",
    what: "Viewers roll a D&D hero in one command (!createchar) and can view, level and back it up. Heroes are what everything else fights with.",
    yourPart: "Nothing.",
    switches: ["charcreate", "charsaves", "charprogress", "charfun", "bg3char", "streamstats"],
  },
  {
    key: "fighting", icon: "⚔️", name: "Fighting & hunts",
    what: "Viewers duel each other or hunt monsters with !dndduel, form parties, and send heroes on timed !autohunt trips. Fights play out on their own and post one summary.",
    yourPart: "Nothing.",
    switches: ["duels", "hunts", "partyduels", "partyhunts", "party", "autohunt", "huntcooldown", "bestiary", "turn"],
    needs: ["characters"],
  },
  {
    key: "raid", icon: "🐉", name: "Raid boss",
    what: "A giant boss is posted when you go live. Viewers team up with !raid to chip away at it over the stream and share the loot when it falls.",
    yourPart: "Nothing — it appears automatically each stream.",
    switches: ["raid"],
    needs: ["characters"],
  },
  {
    key: "delve", icon: "🕯️", name: "The Endless Delve",
    what: "An idle dungeon game chat plays just by talking — a Words on Stream replacement with spells, bosses and upgrades. Use it on its own as an overlay anywhere, or inside the theme's Be right back and Just chatting scenes.",
    yourPart: "Nothing — add the stand-alone \"The Endless Delve\" overlay from !overlays to any scene (it's already in the theme). Every copy you have open plays the same game. Off hides it everywhere within a minute.",
    switches: ["delve"],
  },
  {
    key: "soundbytes", icon: "🔊", name: "Sound Bytes",
    what: "Tavern sound effects chat sets off with !sound — a nat 20 fanfare, the sad trombone of a nat 1, a dragon roar and more — played on stream with a card on screen.",
    yourPart: "Add the \"Sound Bytes\" overlay from !overlays to your scenes and tick Control audio via OBS. Mods tune the gap between sounds with !sound cooldown.",
    switches: ["soundbytes"],
  },
  {
    key: "hoard", icon: "💰", name: "Hunt and Hoard",
    what: "A deeper hunting game: wounds carry between fights, a shared bounty board, and a potion shop — !hunt, !bounties, !shop.",
    yourPart: "Nothing.",
    switches: ["hoard", "hoardhunt", "hoardbounties", "hoardshop"],
    needs: ["gold", "characters"],
    master: "hoard",
  },
  {
    key: "merchant", icon: "🛒", name: "Wandering merchant",
    what: "A peddler pops into chat now and then with a ware. Viewers haggle with !haggle — a sassy AI shopkeeper — and buy it with gold.",
    yourPart: "Nothing.",
    switches: ["market"],
    needs: ["gold"],
  },
  {
    key: "jar", icon: "🫙", name: "Swear jar",
    what: "Swearing in chat costs a few copper into the jar, and viewers can !fine you. Shows on the overlays; give the jar away with !jar giveaway.",
    yourPart: "Nothing.",
    switches: ["jar", "jarfine", "jarwords", "jargiveaway"],
    needs: ["gold"],
  },
  {
    key: "dice", icon: "🎲", name: "Dice & fate",
    what: "!d20, !roll 2d6+3, ability checks, yes/no omens, the !oracle and a natural-20 leaderboard.",
    yourPart: "Nothing.",
    switches: ["d20", "diceroll", "rollchecks", "rollfate", "rollcall", "oracle"],
  },
  {
    key: "npcs", icon: "🎭", name: "AI characters",
    what: "AI-voiced NPCs viewers can talk to with !npc talk, who sometimes chime into chat by themselves, plus occasional story-style quote-backs of chat.",
    yourPart: "Nothing — but they talk on their own, so turn off if you want a quiet chat.",
    switches: ["npc", "npcchatter", "chronicle"],
  },
];

export type SwitchStates = Record<string, boolean>;

/** "on" when every switch is on, "off" when every one is off, else "mixed". */
export function bundleState(b: QuickBundle, s: SwitchStates): "on" | "off" | "mixed" {
  if (b.master && s[b.master] === false) return "off";
  const vals = b.switches.map((k) => s[k] !== false);
  return vals.every(Boolean) ? "on" : vals.some(Boolean) ? "mixed" : "off";
}

/** Every switch in a bundle exists somewhere the dashboard can set it. */
export function isKnownSwitch(key: string, dedicated: readonly string[]): boolean {
  return key in COMMAND_GROUPS || dedicated.includes(key);
}

/** The bundles' requested changes from the form: [bundle, on] for each one that differs from now. */
export function quickChanges(form: FormData, s: SwitchStates): Array<[QuickBundle, boolean]> {
  const out: Array<[QuickBundle, boolean]> = [];
  for (const b of QUICK_BUNDLES) {
    const want = String(form.get(`b_${b.key}`) ?? "");
    if (want !== "on" && want !== "off") continue; // "keep" or missing
    if (want !== bundleState(b, s)) out.push([b, want === "on"]);
  }
  return out;
}

/** Bundles left on that need one left off, after the changes: "Swear jar needs Gold & giveaways". */
export function missingNeeds(s: SwitchStates): string[] {
  const byKey = Object.fromEntries(QUICK_BUNDLES.map((b) => [b.key, b]));
  const notes: string[] = [];
  for (const b of QUICK_BUNDLES) {
    if (bundleState(b, s) === "off" || !b.needs) continue;
    const off = b.needs.filter((n) => bundleState(byKey[n], s) === "off").map((n) => byKey[n].name);
    if (off.length) notes.push(`${b.name} needs ${off.join(" and ")} on`);
  }
  return notes;
}

export const QUICK_CSS = `
.quick{margin:0 0 22px}
.quick>p{margin:4px 0 12px}
.qgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:12px;align-items:start}
.qcard{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border:1px solid var(--edge);border-radius:8px;background:linear-gradient(180deg,#e9e0c5,#dfd2ad);box-shadow:0 2px 8px #6b44181f;transition:box-shadow .2s,border-color .2s}
.qcard.changed{border-color:var(--seal);box-shadow:0 0 0 2px #d9473a40,0 2px 8px #6b44181f}
.qcard h3{margin:0;font-size:1.08rem;display:flex;align-items:center;gap:8px}
.qcard h3 .ico{font-size:1.3rem}
.qcard .what{margin:0;font-size:.93rem;line-height:1.4}
.qcard .yours{margin:0;font-size:.85rem;color:var(--ink-3)}.qcard .yours b{color:var(--ink)}
.qcard .needs{margin:0;font-size:.8rem;color:var(--ink-3)}
.qcard .needs.warn{color:var(--seal);font-weight:600}
.seg{display:inline-flex;align-self:flex-start;border:1px solid var(--edge);border-radius:999px;overflow:hidden;background:#efe6c9}
.seg label{position:relative;cursor:pointer}
.seg input{position:absolute;opacity:0;pointer-events:none}
.seg span{display:block;padding:6px 16px;font-size:.85rem;font-weight:600;color:var(--ink-3)}
.seg label+label span{border-left:1px solid var(--edge)}
.seg input:checked+span{background:var(--ok);color:#fff8ee}
.seg input[value=off]:checked+span{background:#8a6f55}
.seg input[value=keep]:checked+span{background:#c9b88e;color:var(--ink)}
.seg input:focus-visible+span{outline:2px solid var(--seal);outline-offset:-2px}
.qopts{margin-top:4px;border-top:1px dashed var(--edge);padding-top:8px}
.qopts summary{cursor:pointer;font-size:.86rem;font-weight:600;color:var(--ink-3)}
.qfields{display:grid;gap:10px;margin-top:10px}
.qopt{display:grid;gap:3px}
.qopt .ql{font-size:.86rem;font-weight:600}
.qopt input{width:100%;padding:7px 10px;font:inherit;font-size:.92rem;border:1px solid var(--edge);border-radius:6px;background:#fbf6e6}
.qopt input::placeholder{color:#9a8566;font-style:italic}
.qopt input.edited{border-color:var(--seal);box-shadow:0 0 0 2px #d9473a30}
.qopt small{font-size:.76rem;color:var(--ink-3);line-height:1.3}
.qsave{position:sticky;bottom:10px;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:14px;padding:10px 14px;border:1px solid var(--edge);border-radius:8px;background:#f3ead0f2;box-shadow:0 4px 14px #6b44182b}
.qsave .count{font-size:.9rem;color:var(--ink-3)}
`;

/** Bundles whose ⚙ Options box starts minimized even when options are customized. */
const COLLAPSED_OPTIONS = new Set(["fighting"]);

/** One option's input: a text box with a suggestion list; blank means the default. */
function optionField(o: OptionDef, value: string): string {
  const id = `opt-${o.key.replace(/\./g, "-")}`;
  const list = `${id}-list`;
  const kind = o.kind === "duration" ? "e.g. 90s, 10m, 1h;" : "";
  return `<label class="qopt" for="${id}"><span class="ql">${escapeHtml(o.label)}</span>
<input id="${id}" name="opt_${escapeHtml(o.key)}" list="${list}" value="${escapeHtml(value)}" data-was="${escapeHtml(value)}" placeholder="${escapeHtml(defaultText(o))}" autocomplete="off" spellcheck="false" inputmode="${o.kind === "word" || o.kind === "duration" ? "text" : "decimal"}" aria-describedby="${id}-hint">
<datalist id="${list}">${o.suggest.map((v) => `<option value="${escapeHtml(v)}"></option>`).join("")}</datalist>
<small id="${id}-hint">${escapeHtml([o.help, kind, `blank = ${defaultText(o)}`].filter(Boolean).join(" "))}</small></label>`;
}

/** The Quick setup form (posts intent=quick to /dashboard/features). */
export function renderQuickSetup(hiddenAuth: string, s: SwitchStates, opts: Record<string, string> = {}): string {
  const byKey = Object.fromEntries(QUICK_BUNDLES.map((b) => [b.key, b]));
  const optionsBox = (b: QuickBundle) => {
    const list = OPTIONS.filter((o) => o.bundle === b.key);
    if (!list.length) return "";
    const custom = list.filter((o) => opts[o.key]).length;
    // Fighting & hunts has a long option list, so it always starts folded up.
    const open = custom && !COLLAPSED_OPTIONS.has(b.key);
    return `<details class="qopts"${open ? " open" : ""}><summary>⚙ Options${custom ? ` · ${custom} changed from default` : " · all default"}</summary><div class="qfields">${list.map((o) => optionField(o, opts[o.key] ?? "")).join("")}</div></details>`;
  };
  const cards = QUICK_BUNDLES.map((b) => {
    const st = bundleState(b, s);
    const opt = (v: string, label: string) =>
      `<label><input type="radio" name="b_${b.key}" value="${v}"${st === v || (v === "keep" && st === "mixed") ? " checked" : ""}><span>${label}</span></label>`;
    const needs = b.needs?.length
      ? `<p class="needs" data-needs="${b.needs.join(",")}">Needs ${b.needs.map((n) => escapeHtml(byKey[n].name)).join(" and ")} on.</p>`
      : "";
    return `<section class="qcard" data-bundle="${b.key}" data-was="${st}"><h3><span class="ico" aria-hidden="true">${b.icon}</span>${escapeHtml(b.name)}</h3>
<p class="what">${escapeHtml(b.what)}</p><p class="yours"><b>Your part:</b> ${escapeHtml(b.yourPart)}</p>${needs}
<div class="seg" role="radiogroup" aria-label="${escapeHtml(b.name)}">${opt("on", "On")}${opt("off", "Off")}${st === "mixed" ? opt("keep", "Mixed — leave as is") : ""}</div>${optionsBox(b)}</section>`;
  }).join("");
  return `<section class="quick" id="sec-quick"><h2>Quick setup</h2>
<p class="muted">Turn whole features on or off in one go — each card says what it does on stream and what you need to do (usually nothing). Open <strong>⚙ Options</strong> on a card to tune it: start typing for suggestions, or leave a box blank to use the default shown in it. Change as many as you like, then press <strong>Save changes</strong>. Fine-tune single commands in <a href="#sec-groups">Command groups</a> below; a feature you've fine-tuned shows as <em>Mixed</em> and is left alone unless you pick On or Off.</p>
<form method="post" action="/dashboard/features" id="quick-form">${hiddenAuth}<input type="hidden" name="intent" value="quick">
<div class="qgrid">${cards}</div>
<div class="qsave"><button type="submit" class="ember" id="quick-save">Save changes</button><span class="count" id="quick-count">No changes yet.</span></div></form>
<script>(function(){var f=document.getElementById("quick-form");if(!f)return;var cards=[].slice.call(f.querySelectorAll(".qcard"));
function val(c){var i=c.querySelector("input:checked");return i?i.value:"keep"}
function sync(){var n=0,o=0,on={};cards.forEach(function(c){var v=val(c),was=c.getAttribute("data-was");var ch=v!=="keep"&&v!==was;
  var oc=[].filter.call(c.querySelectorAll(".qopt input"),function(i){var d=i.value.trim()!==i.getAttribute("data-was");i.classList.toggle("edited",d);return d}).length;o+=oc;
  c.classList.toggle("changed",ch||oc>0);if(ch)n++;on[c.getAttribute("data-bundle")]=v==="keep"?was!=="off":v==="on"});
  cards.forEach(function(c){var nd=c.querySelector(".needs");if(!nd)return;var miss=nd.getAttribute("data-needs").split(",").filter(function(k){return!on[k]});nd.classList.toggle("warn",on[c.getAttribute("data-bundle")]&&miss.length>0)});
  var parts=[];if(n)parts.push(n+" feature"+(n===1?"":"s"));if(o)parts.push(o+" option"+(o===1?"":"s"));
  document.getElementById("quick-count").textContent=parts.length?parts.join(" and ")+" will change.":"No changes yet."}
f.addEventListener("change",sync);f.addEventListener("input",sync);sync()})();</script></section>`;
}

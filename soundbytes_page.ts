// GuildScribe — /dashboard/sounds: a channel's own Sound Bytes
// (soundbytes_library.ts). Search online sound repositories and add a pick,
// add a file from the computer and/or a link to one online, preview and
// delete. Behind the dashboard key + mod login (dashboard.ts); a plain
// POST/redirect/GET page like the others.

import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";
import { isReservedSoundName, SOUND_BYTES } from "./soundbytes.ts";
import {
  addCustomSound,
  customSoundSrc,
  deleteCustomSound,
  listCustomSounds,
  MAX_CUSTOM_SOUNDS,
  MAX_PLAY_SECONDS,
  MAX_SOUND_BYTES,
  MAX_STORED_SOUNDS,
  sanitizeSoundName,
  searchSoundLibrary,
  soundRepositories,
  validSoundName,
} from "./soundbytes_library.ts";

const kb = (n: number) => `${Math.max(1, Math.round(n / 1000))} KB`;

/** A short chat-friendly name from a title: "Sword Clash 02.wav" -> "sword-clash-02". */
function suggestName(title: string): string {
  const n = title.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "");
  return validSoundName(n) && !isReservedSoundName(n) ? n : "";
}

export async function renderSoundsPage(d: {
  broadcasterId: string;
  broadcasterName: string;
  key: string;
  q?: string;
  repo?: string;
  notice?: string;
  error?: string;
}): Promise<string> {
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);
  const repos = soundRepositories();
  const repo = repos.find((r) => r.id === d.repo)?.id ?? repos[0].id;
  const q = (d.q ?? "").trim().slice(0, 80);
  // Where a form sends us back to: the same search, if there was one.
  const back = `<input type="hidden" name="q" value="${escapeHtml(q)}"><input type="hidden" name="repo" value="${escapeHtml(repo)}">`;

  const [mine, search] = await Promise.all([listCustomSounds(d.broadcasterId), q ? searchSoundLibrary(repo, q) : Promise.resolve(null)]);
  const stored = mine.filter((s) => s.blobKey);

  const mineHtml = mine.length
    ? `<div class="sounds">${mine.map((s) => `<div class="snd"><div class="snd-head"><span class="ico">${escapeHtml(s.icon)}</span><div><b>!sound ${escapeHtml(s.name)}</b><div class="muted small">${escapeHtml(s.title)} · ${
      s.source === "upload" ? `uploaded file (${kb(s.bytes)})` : s.blobKey ? `copied from ${s.source === "library" ? "a sound library" : "a link"} (${kb(s.bytes)})` : `linked from ${s.source === "library" ? "a sound library" : "the web"}`
    }</div></div>
<form method="post" action="/dashboard/sounds" class="inline" onsubmit="return confirm('Delete !sound ${escapeHtml(s.name)}?')">${hidden}${back}<input type="hidden" name="intent" value="delete"><input type="hidden" name="name" value="${escapeHtml(s.name)}"><button type="submit" class="ghost">Delete</button></form></div>
<audio controls preload="none" src="${escapeHtml(customSoundSrc(d.broadcasterId, s))}"></audio>
${s.credit || s.pageUrl ? `<div class="muted small">${s.credit ? `Credit: ${escapeHtml(s.credit)}` : ""}${s.pageUrl ? ` <a href="${escapeHtml(s.pageUrl)}" target="_blank" rel="noopener noreferrer">source ↗</a>` : ""}</div>` : ""}
${!s.blobKey ? `<div class="muted small">Plays straight from <code>${escapeHtml(new URL(s.url).hostname)}</code>.</div>` : ""}</div>`).join("")}</div>`
    : `<p class="note">No sounds of your own yet — find one online below, or add a file.</p>`;

  const repoPicker = `<div class="repos">${repos.map((r) => `<label class="repo${r.id === repo ? " on" : ""}"><input type="radio" name="repo" value="${r.id}"${r.id === repo ? " checked" : ""}><b>${escapeHtml(r.label)}</b><span>${escapeHtml(r.blurb)} <a href="${escapeHtml(r.site)}" target="_blank" rel="noopener noreferrer">browse ↗</a></span></label>`).join("")}</div>`;

  let results = "";
  if (search && "error" in search) {
    results = `<p class="banner error">${escapeHtml(search.error)}</p>`;
  } else if (search) {
    results = search.hits.length
      ? `<div class="sounds">${search.hits.map((h) => `<div class="snd"><div><b>${escapeHtml(h.title)}</b><div class="muted small">${h.creator ? `by ${escapeHtml(h.creator)} · ` : ""}${escapeHtml(h.repo)} · ${escapeHtml(h.license)}${h.seconds ? ` · ${h.seconds}s${h.seconds > MAX_PLAY_SECONDS ? ` (plays the first ${MAX_PLAY_SECONDS}s)` : ""}` : ""}${h.pageUrl ? ` · <a href="${escapeHtml(h.pageUrl)}" target="_blank" rel="noopener noreferrer">page ↗</a>` : ""}</div></div>
<audio controls preload="none" src="${escapeHtml(h.fileUrl)}"></audio>
<form method="post" action="/dashboard/sounds" class="add">${hidden}${back}<input type="hidden" name="intent" value="add_library"><input type="hidden" name="url" value="${escapeHtml(h.fileUrl)}"><input type="hidden" name="title" value="${escapeHtml(h.title)}"><input type="hidden" name="credit" value="${escapeHtml(h.credit)}"><input type="hidden" name="page_url" value="${escapeHtml(h.pageUrl)}">
<label>!sound <input name="name" value="${escapeHtml(suggestName(h.title))}" placeholder="name" maxlength="25" pattern="[A-Za-z0-9_-]{2,25}" required></label>
<label class="chk"><input type="checkbox" name="copy" value="1"> Keep a copy here</label><button type="submit">Add</button></form></div>`).join("")}</div>`
      : `<p class="note">Nothing short found for "${escapeHtml(q)}" in ${escapeHtml(repos.find((r) => r.id === repo)!.label)}. Try another word, or another library.</p>`;
  }

  const body = `<header class="dash-top"><div><span class="pill">Stream · Sound Bytes</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>Add your own sounds to <code>!sound</code> — pick them from free online sound libraries, or add a file of your own. They play through the Sound Bytes overlay (and the full stream theme) just like the built-in ones, cut off after ${MAX_PLAY_SECONDS} seconds. Chat types <code>!sound &lt;name&gt;</code>; <code>!sound credit &lt;name&gt;</code> shows where a sound came from.</p>

<h2>Your sounds <span class="muted small">${mine.length} of ${MAX_CUSTOM_SOUNDS} · ${stored.length} of ${MAX_STORED_SOUNDS} files kept here</span></h2>
${mineHtml}

<h2 id="find">Find a sound online</h2>
<form method="get" action="/dashboard/sounds#find" class="search">${hidden}${repoPicker}
<div class="row"><input name="q" value="${escapeHtml(q)}" placeholder="sword, tavern, thunder, applause…" maxlength="80" required><button type="submit">Search</button></div></form>
<p class="muted small">Only short sounds are listed. Press play to hear one, give it a name and press <strong>Add</strong>. It plays straight from the library, unless you tick <em>Keep a copy here</em> (up to ${kb(MAX_SOUND_BYTES)}; keeps working even if the library removes it). Most sounds are Creative Commons: the credit is saved with the sound — for <strong>CC BY</strong> sounds, credit the creator (e.g. <code>!sound credits</code>, or in your panels). <strong>NC</strong> sounds are for non-commercial use only.</p>
${results}

<h2 id="upload">Add your own file</h2>
<form method="post" action="/dashboard/sounds" enctype="multipart/form-data" class="grid2">${hidden}${back}<input type="hidden" name="intent" value="add_upload">
<label>Name chat types<input name="name" placeholder="e.g. airhorn" maxlength="25" pattern="[A-Za-z0-9_-]{2,25}" required autocomplete="off"></label>
<label>Title on the card <span class="muted small">(optional)</span><input name="title" placeholder="e.g. Air Horn" maxlength="60"></label>
<label>Icon <span class="muted small">(optional emoji)</span><input name="icon" placeholder="🔊" maxlength="8"></label>
<label>File from your computer<input type="file" name="file" accept="audio/*,.mp3,.ogg,.wav,.m4a,.flac,.webm"></label>
<label>…and/or a link to one online<input type="url" name="url" placeholder="https://…/sound.mp3" maxlength="500"></label>
<label>Where it's from / credit <span class="muted small">(optional)</span><input name="credit" placeholder='e.g. "Air Horn" by someone (CC BY 4.0)' maxlength="300"></label>
<label class="chk"><input type="checkbox" name="copy" value="1" checked> Keep a copy of the link here (not just a link)</label>
<label class="chk"><input type="checkbox" name="replace" value="1"> Replace a sound with this name</label>
<button type="submit" class="ember">Add sound</button></form>
<p class="muted small">mp3, ogg, wav, m4a, flac or webm, up to ${kb(MAX_SOUND_BYTES)} (a few seconds of mp3 is plenty). Give a file, a link, or both — with both, the file is used and the link is saved as where it came from. A link must go straight to the audio file (ends in .mp3, .ogg…), not to a page with a player on it. Unticked, a link is played straight from where it lives, so it stops if that site removes it.</p>

<h2>Built-in sounds</h2>
<p class="muted">${SOUND_BYTES.map((s) => `${s.icon} <code>${s.cmd}</code>`).join(" · ")} — made live in the browser, always there. Overlay links are on the <a href="/overlays?channel=${encodeURIComponent(d.broadcasterId)}" target="_blank" rel="noopener">overlay setup page</a>.</p>
<script>document.querySelectorAll(".repo input").forEach(i=>i.addEventListener("change",()=>document.querySelectorAll(".repo").forEach(l=>l.classList.toggle("on",l.querySelector("input").checked))));</script>`;

  return scrollDoc(`${name} — Sound Bytes`, body, {
    width: 1000,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}
form.inline{display:inline;margin:0 0 0 auto}form.inline button{padding:5px 12px;font-size:.78rem}.small{font-size:.85rem}
.sounds{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,290px),1fr));gap:12px;margin:10px 0}
.snd{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--edge);border-radius:8px;background:#efe5c8b0;min-width:0}
.snd-head{display:flex;gap:10px;align-items:flex-start}.snd .ico{font-size:28px;line-height:1}.snd b{overflow-wrap:anywhere}.snd audio{width:100%;height:36px}
form.add{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0}form.add label{display:flex;align-items:center;gap:6px;font-weight:600;font-size:.88rem}form.add input[name=name]{width:130px;padding:6px 8px}form.add button{padding:6px 14px}
.chk{flex-direction:row!important;align-items:center;gap:6px;font-weight:400!important}
.repos{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:10px;margin:10px 0}
.repo{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--edge);border-radius:8px;background:#efe5c8;cursor:pointer}.repo input{position:absolute;opacity:0;pointer-events:none}
.repo span{font-size:.85rem;color:var(--ink-3)}.repo.on{border:2px solid var(--seal);background:#f6ecd0}
.search .row{display:flex;gap:8px}.search .row input{flex:1;padding:9px 12px;min-width:0}
form.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:10px;align-items:end;margin:10px 0}form.grid2 label{display:flex;flex-direction:column;gap:4px;font-weight:600;font-size:.9rem}form.grid2 input:not([type=checkbox]){padding:9px 12px;font-weight:400}`,
  });
}

/** POST /dashboard/sounds: add (upload / link / library pick) or delete. */
export async function applySoundsForm(broadcasterId: string, form: FormData): Promise<{ ok: boolean; message: string }> {
  const intent = String(form.get("intent") ?? "");
  if (intent === "delete") {
    const n = sanitizeSoundName(String(form.get("name") ?? ""));
    return (await deleteCustomSound(broadcasterId, n)) ? { ok: true, message: `Deleted !sound ${n}.` } : { ok: false, message: "That sound was already gone." };
  }
  if (intent === "add_upload" || intent === "add_library") {
    const file = form.get("file");
    const r = await addCustomSound(
      broadcasterId,
      {
        name: String(form.get("name") ?? ""),
        title: String(form.get("title") ?? ""),
        icon: String(form.get("icon") ?? ""),
        file: file instanceof File ? file : null,
        url: String(form.get("url") ?? ""),
        copy: form.get("copy") === "1",
        fromLibrary: intent === "add_library",
        credit: String(form.get("credit") ?? ""),
        pageUrl: String(form.get("page_url") ?? ""),
      },
      isReservedSoundName,
      form.get("replace") === "1",
    );
    if (!r.ok) return { ok: false, message: r.error };
    return { ok: true, message: `Added ${r.sound.icon} !sound ${r.sound.name}${r.sound.blobKey ? " (file kept here)" : " (linked)"}. Try it in chat!` };
  }
  return { ok: false, message: "Unknown action." };
}

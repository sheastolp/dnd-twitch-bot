// /dashboard/autoban — the channel's auto-ban word list, learned spam
// suggestions and ignore list, editable by mods. Auth (dashboard key + live
// Twitch mod login) is done by the caller; see dashboard.ts.

import { getBanToken, hasBanPermission, isAutoBanEnabled, setAutoBanEnabled } from "./autoban.ts";
import { forgetBan, IMPORT_EVERY_MS, importTwitchBans, listBans } from "./autoban_history.ts";
import {
  addWord,
  type AutoBanWord,
  deleteWord,
  editWord,
  type EditResult,
  getLearnMode,
  LEARN_PROMOTE_CHATTERS,
  type LearnMode,
  listIgnoredUsers,
  listWords,
  MAX_PHRASE_LEN,
  MAX_PHRASES,
  setLearnMode,
  setUserIgnored,
  setWordStatus,
} from "./autoban_words.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

export async function applyAutoBanForm(broadcasterId: string, form: FormData): Promise<EditResult | null> {
  const intent = String(form.get("intent") ?? "");
  const id = Number(form.get("id") ?? 0);
  const phrase = String(form.get("phrase") ?? "");
  const login = String(form.get("login") ?? "");
  switch (intent) {
    case "add":
      return await addWord(broadcasterId, phrase);
    case "edit":
      return id ? await editWord(broadcasterId, id, phrase) : null;
    case "activate":
    case "approve":
      return id ? await setWordStatus(broadcasterId, id, "active") : null;
    case "disable":
    case "reject":
      return id ? await setWordStatus(broadcasterId, id, "off") : null;
    case "delete":
      return id ? await deleteWord(broadcasterId, id) : null;
    case "ignore":
      return await setUserIgnored(broadcasterId, login, true);
    case "unignore":
      return await setUserIgnored(broadcasterId, login, false);
    case "learn_mode": {
      const mode = String(form.get("mode") ?? "");
      if (mode !== "auto" && mode !== "suggest" && mode !== "off") return null;
      return await setLearnMode(broadcasterId, mode);
    }
    case "import_bans": {
      const auth = await getBanToken(broadcasterId);
      if ("problem" in auth) return { ok: false, error: "GuildScribe needs ban permission to read the ban list — the broadcaster should reconnect at /connect." };
      const r = await importTwitchBans(broadcasterId, auth.token);
      return r.ok ? { ok: true, message: `Imported ${r.count} ban${r.count === 1 ? "" : "s"} from Twitch as references.` } : { ok: false, error: `Couldn't read the ban list: ${r.error}.` };
    }
    case "forget_ban": {
      const userId = String(form.get("user_id") ?? "");
      if (!/^\d+$/.test(userId)) return null;
      return (await forgetBan(broadcasterId, userId))
        ? { ok: true, message: "Reference forgotten — new messages won't be compared with that ban." }
        : { ok: false, error: "That reference no longer exists." };
    }
    case "autoban_on":
    case "autoban_off":
      await setAutoBanEnabled(broadcasterId, intent === "autoban_on");
      return { ok: true, message: intent === "autoban_on" ? "Auto-ban is on." : "Auto-ban is off." };
  }
  return null;
}

function fmtDate(ms: number | null) {
  return ms ? new Date(ms).toISOString().slice(0, 10) : "—";
}

export async function renderAutoBanPage(d: { broadcasterId: string; broadcasterName: string; key: string; notice?: string; error?: string }): Promise<string> {
  // Refresh the Twitch ban list now and then (at most every IMPORT_EVERY_MS).
  if (await hasBanPermission(d.broadcasterId)) {
    const { syncedAt } = await listBans(d.broadcasterId, 0);
    if (!syncedAt || Date.now() - syncedAt > IMPORT_EVERY_MS) {
      const auth = await getBanToken(d.broadcasterId);
      if (!("problem" in auth)) await importTwitchBans(d.broadcasterId, auth.token).catch(() => {});
    }
  }
  const [enabled, permitted, words, ignored, mode, history] = await Promise.all([
    isAutoBanEnabled(d.broadcasterId),
    hasBanPermission(d.broadcasterId),
    listWords(d.broadcasterId),
    listIgnoredUsers(d.broadcasterId),
    getLearnMode(d.broadcasterId),
    listBans(d.broadcasterId, 50),
  ]);
  const hidden = `<input type="hidden" name="channel" value="${escapeHtml(d.broadcasterId)}"><input type="hidden" name="key" value="${escapeHtml(d.key)}">`;
  const btn = (intent: string, label: string, extra = "", cls = "ghost", confirm = "") =>
    `<form method="post" action="/dashboard/autoban" class="inline"${confirm ? ` onsubmit="return confirm('${confirm}')"` : ""}>${hidden}<input type="hidden" name="intent" value="${intent}">${extra}<button type="submit" class="${cls}">${label}</button></form>`;
  const idField = (w: AutoBanWord) => `<input type="hidden" name="id" value="${w.id}">`;
  const qs = `channel=${encodeURIComponent(d.broadcasterId)}&key=${encodeURIComponent(d.key)}`;
  const name = escapeHtml(d.broadcasterName);

  const pending = words.filter((w) => w.status === "pending");
  const listed = words.filter((w) => w.status !== "pending");
  const activeCount = listed.filter((w) => w.status === "active").length;

  const sourceBadge = (w: AutoBanWord) =>
    w.source === "learned" ? `<span class="badge learned">learned</span>` : w.source === "default" ? `<span class="badge">default</span>` : `<span class="badge">added</span>`;
  const exampleLine = (w: AutoBanWord) => w.example ? `<div class="muted small ex">e.g. “${escapeHtml(w.example)}”</div>` : "";

  const wordRows = listed.map((w) => {
    const editForm = `<form method="post" action="/dashboard/autoban" class="edit">${hidden}<input type="hidden" name="intent" value="edit">${idField(w)}<input name="phrase" value="${escapeHtml(w.phrase)}" maxlength="${MAX_PHRASE_LEN}" required aria-label="Phrase"><button type="submit" class="ghost">Save</button></form>`;
    const toggle = w.status === "active" ? btn("disable", "Turn off", idField(w)) : btn("activate", "Turn on", idField(w));
    return `<tr class="${w.status === "off" ? "off" : ""}"><td>${editForm}${exampleLine(w)}</td><td>${sourceBadge(w)} ${w.status === "off" ? `<span class="badge offb">off</span>` : ""}</td><td class="num">${w.hits}</td><td class="num small">${fmtDate(w.lastHitAt)}</td><td class="num actions">${toggle}${btn("delete", "Delete", idField(w), "ghost danger", "Delete this phrase?")}</td></tr>`;
  }).join("");

  const pendingRows = pending.map((w) =>
    `<tr><td><code>${escapeHtml(w.phrase)}</code>${exampleLine(w)}</td><td class="num">${w.sightings}</td><td class="num small">${fmtDate(w.createdAt)}</td><td class="num actions">${btn("approve", "Ban it", idField(w), "")}${btn("reject", "Not spam", idField(w))}</td></tr>`
  ).join("");

  const modeOpt = (m: LearnMode, label: string) => `<option value="${m}"${mode === m ? " selected" : ""}>${label}</option>`;
  const status = `<div class="stats"><div class="stat"><b>${enabled ? "On" : "Off"}</b>auto-ban</div><div class="stat"><b>${activeCount}</b>active phrases</div><div class="stat"><b>${pending.length}</b>learned, awaiting review</div><div class="stat"><b>${ignored.length}</b>ignored users</div></div>
<div class="controls">${btn(enabled ? "autoban_off" : "autoban_on", enabled ? "Turn auto-ban off" : "Turn auto-ban on", "", enabled ? "ghost" : "ember")}
<form method="post" action="/dashboard/autoban" class="inline">${hidden}<input type="hidden" name="intent" value="learn_mode"><label class="small">Learning <select name="mode" onchange="this.form.submit()">${modeOpt("auto", `Automatic — ban a pattern once ${LEARN_PROMOTE_CHATTERS}+ chatters send it`)}${modeOpt("suggest", "Suggest only — wait for a mod to approve")}${modeOpt("off", "Off")}</select></label><noscript><button type="submit" class="ghost">Save</button></noscript></form></div>
${!permitted ? `<p class="banner error">GuildScribe doesn't have ban permission for this channel yet — the broadcaster needs to <a href="/connect">reconnect</a> once and approve it.</p>` : ""}
${!enabled ? `<p class="note">Auto-ban is off, so nothing below is enforced and nothing is learned until it's turned on.</p>` : ""}`;

  const addForm = `<form method="post" action="/dashboard/autoban" class="add">${hidden}<input type="hidden" name="intent" value="add"><input name="phrase" placeholder='e.g. "best viewers" or "streamboo.com"' maxlength="${MAX_PHRASE_LEN}" required aria-label="New phrase"><button type="submit" class="ember">Add phrase</button></form>`;

  const ignoredList = ignored.length
    ? `<ul class="list">${ignored.map((r) => `<li><span class="who">${escapeHtml(r.login)}</span><span class="muted small">since ${fmtDate(r.addedAt)}</span><span style="margin-left:auto">${btn("unignore", "Remove", `<input type="hidden" name="login" value="${escapeHtml(r.login)}">`)}</span></li>`).join("")}</ul>`
    : `<p class="muted">No one yet.</p>`;

  const body = `<header class="dash-top"><div><span class="pill">Moderation · Auto-ban words</span><h1>${name}</h1></div><a class="btn ghost" href="/dashboard?${qs}">← Dashboard</a></header>
${d.error ? `<p class="banner error">${escapeHtml(d.error)}</p>` : d.notice ? `<p class="banner ok">${escapeHtml(d.notice)}</p>` : ""}
<p>Anyone who isn't a moderator, the broadcaster or on the ignore list and says one of the <strong>active</strong> phrases below is <strong>permanently banned</strong>. Matching ignores case, extra spaces, look-alike characters (<code>v1ewers</code>) and spelled-out domains (<code>grow dot com</code>, <code>grow . com</code>).</p>
${status}
<h2>Learned spam — awaiting review</h2>
<p class="muted">Messages that read like viewer/follower ads (a link plus "viewers", "grow your stream" and the like). Not enforced yet. ${mode === "auto" ? `In automatic mode a pattern starts being banned once ${LEARN_PROMOTE_CHATTERS} different chatters send it.` : mode === "suggest" ? "Suggest-only mode: nothing here is banned until you approve it." : "Learning is off, so nothing new will appear."} Domains in messages that get banned are learned straight away. <strong>Not spam</strong> keeps a pattern from being learned again.</p>
${pending.length
    ? `<div class="table-wrap"><table><thead><tr><th>Pattern</th><th class="num">Chatters</th><th class="num">First seen</th><th></th></tr></thead><tbody>${pendingRows}</tbody></table></div>`
    : `<p class="note">Nothing waiting.</p>`}
<h2>Auto-ban phrases</h2>
${addForm}
<p class="muted small">${words.length} / ${MAX_PHRASES} entries. Edit a phrase in place and press Save. A phrase that's turned off is kept (and never re-learned) but not enforced.</p>
${listed.length
    ? `<div class="table-wrap"><table><thead><tr><th>Phrase</th><th>Source</th><th class="num">Bans</th><th class="num">Last ban</th><th></th></tr></thead><tbody>${wordRows}</tbody></table></div>`
    : `<p class="note">The list is empty — auto-ban won't ban anyone until you add a phrase.</p>`}
<h2>Ban history</h2>
<p class="muted">Everyone banned before is a reference for new bans. A message that repeats a banned one (ignoring @mentions, numbers, spacing and look-alike letters), or a numbered account named like a banned one sending a promo-looking message, is ${mode === "auto" ? "<strong>banned</strong>" : mode === "suggest" ? "<strong>queued under Learned spam</strong> for you to review" : "ignored — learning is off, so the history isn't used"}. Auto-bans are recorded with the message; bans your mods made on Twitch are imported (names and reasons only — Twitch doesn't keep the messages).</p>
<div class="stats"><div class="stat"><b>${history.total}</b>references</div><div class="stat"><b>${history.imported}</b>from Twitch's ban list</div></div>
<div class="controls">${btn("import_bans", "Import Twitch ban list now", "", "ghost")}<span class="muted small">${history.syncedAt ? `Last imported ${new Date(history.syncedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : permitted ? "Not imported yet" : "Needs ban permission to import"}</span></div>
${history.refs.length
    ? `<div class="table-wrap"><table><thead><tr><th>Banned account</th><th>How</th><th>Message / reason</th><th class="num">When</th><th></th></tr></thead><tbody>${
      history.refs.map((r) => `<tr><td><span class="who">${escapeHtml(r.login)}</span></td><td>${r.source === "twitch" ? `<span class="badge">Twitch ban</span>` : r.source === "history" ? `<span class="badge learned">history match</span>` : `<span class="badge learned">auto-ban</span>`}</td><td class="small">${r.message ? `“${escapeHtml(r.message)}”` : r.reason ? `<span class="muted">${escapeHtml(r.reason)}</span>` : `<span class="muted">—</span>`}</td><td class="num small">${fmtDate(r.bannedAt)}</td><td class="num actions">${btn("forget_ban", "Forget", `<input type="hidden" name="user_id" value="${escapeHtml(r.userId)}">`)}</td></tr>`).join("")
    }</tbody></table></div>${history.total > history.refs.length ? `<p class="muted small">Showing the latest ${history.refs.length} of ${history.total}.</p>` : ""}`
    : `<p class="note">No bans recorded yet.</p>`}
<h2>Ignored users</h2>
<p class="muted">Auto-ban never bans these accounts and never learns from their messages — handy for a friend who jokes about "ai viewers" or a partner bot that posts links.</p>
<form method="post" action="/dashboard/autoban" class="add">${hidden}<input type="hidden" name="intent" value="ignore"><input name="login" placeholder="twitch username" maxlength="26" required pattern="@?[A-Za-z0-9_]{1,25}" aria-label="Username to ignore"><button type="submit" class="ember">Ignore user</button></form>
${ignoredList}
<p class="colophon muted">In chat: <code>!autoban on</code> · <code>!autoban off</code> · <code>!autoban status</code></p>`;

  return scrollDoc(`${name} — Auto-ban words`, body, {
    width: 1000,
    css: `${LEDGER_CSS}.dash-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--rule)}.dash-top h1{margin:8px 0 0}form.inline{display:inline;margin:0}form.inline button,td form button{padding:5px 12px;font-size:.78rem}.actions{white-space:nowrap}.actions form{margin-left:6px}form.edit{display:flex;gap:6px;margin:0}form.edit input{flex:1;min-width:140px;padding:5px 8px}form.add{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}form.add input{flex:1 1 240px;padding:9px 12px}.controls{align-items:center}.controls select{max-width:100%}.ex{margin-top:4px;word-break:break-word}tr.off td{opacity:.6}.badge.offb{color:var(--bad);background:var(--bad-bg)}button.danger{color:var(--bad)}.badge,td.num.small{white-space:nowrap}td{vertical-align:middle}`,
  });
}

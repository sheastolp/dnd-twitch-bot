// The Division 2 quest tracker — !div2quests, !div2quest
//
// One list per channel with two halves:
//   - the preloaded campaign checklist (DIV2_CAMPAIGN in division2data.ts),
//     where only completions are stored, keyed by the quest's `key`;
//   - the streamer's own custom quests ("get the Eagle Bearer").
// Mods tick both off from chat; anyone can see progress in chat or on the
// public /div2quests?channel=<id> page (web_routes.ts).
//
// !div2quests [campaign]       progress, or every campaign quest left (anyone)
// !div2quest add <quest>       add a custom quest (mod)
// !div2quest done <n|name>     complete custom quest n, or a quest by name (mod)
// !div2quest undo <n|name>     un-complete it (mod)
// !div2quest remove <n>        delete custom quest n (mod)
// !div2quest clear             delete every completed custom quest (mod)
// !div2quest reset             un-tick the whole campaign checklist (mod)

import { sqlite } from "./sqlite.ts";
import { sendChatMessage, sendChatMessages } from "./twitch.ts";
import { DIV2_CAMPAIGN, type Div2CampaignQuest } from "./division2data.ts";
import { comparable } from "./division2.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";

const MAX_CUSTOM = 25;
const MAX_TITLE_LENGTH = 120;

export async function ensureDiv2QuestTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS div2_campaign_done (
      broadcaster_id TEXT NOT NULL, quest_key TEXT NOT NULL, done_at INTEGER NOT NULL,
      PRIMARY KEY (broadcaster_id, quest_key)
    )`,
  );
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS div2_custom_quests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, broadcaster_id TEXT NOT NULL, title TEXT NOT NULL,
      done_at INTEGER, created_at INTEGER NOT NULL
    )`,
  );
  await sqlite.execute("CREATE INDEX IF NOT EXISTS idx_div2_custom_channel ON div2_custom_quests(broadcaster_id)");
}

/** Wipes the channel's quest progress — called from !dndbot leave purge. */
export async function purgeDiv2QuestData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM div2_campaign_done WHERE broadcaster_id = ?", [broadcasterId]);
  await sqlite.execute("DELETE FROM div2_custom_quests WHERE broadcaster_id = ?", [broadcasterId]);
}

export interface CustomQuest {
  id: number;
  title: string;
  doneAt: number | null;
}

export interface Div2QuestState {
  /** Campaign quest key -> completion time. */
  campaignDone: Map<string, number>;
  /** Custom quests in the order they were added (their chat numbers are index + 1). */
  custom: CustomQuest[];
}

export async function getDiv2QuestState(broadcasterId: string): Promise<Div2QuestState> {
  const [done, custom] = await Promise.all([
    sqlite.execute("SELECT quest_key, done_at FROM div2_campaign_done WHERE broadcaster_id = ?", [broadcasterId]),
    sqlite.execute("SELECT id, title, done_at FROM div2_custom_quests WHERE broadcaster_id = ? ORDER BY id ASC", [broadcasterId]),
  ]);
  return {
    // Ignore keys no longer in DIV2_CAMPAIGN so the counts stay honest.
    campaignDone: new Map(
      done.rows
        .filter((r: any) => DIV2_CAMPAIGN.some((q) => q.key === String(r.quest_key)))
        .map((r: any) => [String(r.quest_key), Number(r.done_at)]),
    ),
    custom: custom.rows.map((r: any) => ({ id: Number(r.id), title: String(r.title), doneAt: r.done_at == null ? null : Number(r.done_at) })),
  };
}

export function div2QuestsUrl(baseUrl: string, broadcasterId: string): string {
  return `${baseUrl}/div2quests?channel=${encodeURIComponent(broadcasterId)}`;
}

function campaignProgress(state: Div2QuestState): string {
  return `${state.campaignDone.size}/${DIV2_CAMPAIGN.length}`;
}

function campaignRemaining(state: Div2QuestState): Div2CampaignQuest[] {
  return DIV2_CAMPAIGN.filter((q) => !state.campaignDone.has(q.key));
}

/** Best match for a name: custom quests first, then the campaign. Exact before partial. */
function findQuestByName(
  state: Div2QuestState,
  query: string,
): { custom: CustomQuest } | { campaign: Div2CampaignQuest } | null {
  const wanted = comparable(query);
  if (wanted.length < 3) return null;
  const campaignNames = (q: Div2CampaignQuest) => [q.name, ...(q.aliases ?? [])].map(comparable);
  const exactCustom = state.custom.find((c) => comparable(c.title) === wanted);
  if (exactCustom) return { custom: exactCustom };
  const exactCampaign = DIV2_CAMPAIGN.find((q) => campaignNames(q).includes(wanted));
  if (exactCampaign) return { campaign: exactCampaign };
  const partialCustom = state.custom.find((c) => comparable(c.title).includes(wanted));
  if (partialCustom) return { custom: partialCustom };
  const partialCampaign = DIV2_CAMPAIGN.find((q) => campaignNames(q).some((n) => n.includes(wanted)));
  return partialCampaign ? { campaign: partialCampaign } : null;
}

/** "12" -> custom quest 12, otherwise a name search. */
function resolveQuest(state: Div2QuestState, arg: string) {
  if (/^#?\d+$/.test(arg)) {
    const quest = state.custom[Number(arg.replace("#", "")) - 1];
    return quest ? { custom: quest } : null;
  }
  return findQuestByName(state, arg);
}

function customLine(state: Div2QuestState): string {
  if (!state.custom.length) return "no custom quests yet (mods: !div2quest add <quest>)";
  return state.custom.map((c, i) => `${c.doneAt ? "✅" : "☐"} ${i + 1}. ${c.title}`).join(" | ");
}

/** Handles !div2quests and !div2quest. Returns true if it consumed the message. */
export async function handleDiv2QuestCommand(
  chatMessage: string,
  display: string,
  broadcasterId: string,
  isModerator: boolean,
  baseUrl: string,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!div2quest(s)?(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/i);
  if (!m) return false;
  const say = (text: string) => sendChatMessage(`@${display} ${text}`, broadcasterId);
  const sub = (m[2] ?? "").toLowerCase();
  const arg = (m[3] ?? "").replace(/\s+/g, " ").trim();
  const state = await getDiv2QuestState(broadcasterId);
  const link = div2QuestsUrl(baseUrl, broadcasterId);

  // Read-only views, open to everyone.
  if (!sub || sub === "list" || sub === "show") {
    const next = campaignRemaining(state).slice(0, 3).map((q) => q.name);
    const campaign = next.length ? `next up: ${next.join(", ")}` : "all done! 🏆";
    await sendChatMessages(
      `@${display} 🎯 Division 2 quests — Campaign ${campaignProgress(state)} (${campaign}) | Custom: ${customLine(state)} | Full list: ${link}`,
      broadcasterId,
    );
    return true;
  }
  if (sub === "campaign") {
    const left = campaignRemaining(state);
    await sendChatMessages(
      left.length
        ? `@${display} 🗺️ Campaign ${campaignProgress(state)} — still to do: ${left.slice(0, 8).map((q) => q.name).join(", ")}${
          left.length > 8 ? ` +${left.length - 8} more` : ""
        } | Full list: ${link}`
        : `@${display} 🏆 Campaign ${campaignProgress(state)} — every quest on the checklist is done!`,
      broadcasterId,
    );
    return true;
  }

  if (!isModerator) {
    await say("only the broadcaster or a moderator can update the quest tracker. !div2quests shows progress.");
    return true;
  }

  if (sub === "add") {
    if (!arg) {
      await say("usage: !div2quest add <quest>, e.g. !div2quest add get the Eagle Bearer");
    } else if (state.custom.length >= MAX_CUSTOM) {
      await say(`the custom quest list is full (${MAX_CUSTOM}) — !div2quest clear removes finished ones, !div2quest remove <n> any one.`);
    } else {
      const title = arg.replace(/\|/g, "/").slice(0, MAX_TITLE_LENGTH);
      await sqlite.execute(
        "INSERT INTO div2_custom_quests (broadcaster_id, title, created_at) VALUES (?,?,?)",
        [broadcasterId, title, Date.now()],
      );
      await say(`🎯 new quest #${state.custom.length + 1}: ${title}`);
    }
  } else if (sub === "done" || sub === "complete" || sub === "undo") {
    const finishing = sub !== "undo";
    const found = arg ? resolveQuest(state, arg) : null;
    if (!found) {
      await say(
        arg
          ? `couldn't find quest "${arg}". Use a custom quest's number or part of a quest's name, e.g. !div2quest ${sub} grand washington`
          : `usage: !div2quest ${sub} <number | name>, e.g. !div2quest ${sub} 2 or !div2quest ${sub} grand washington`,
      );
    } else if ("custom" in found) {
      const q = found.custom;
      if (Boolean(q.doneAt) === finishing) {
        await say(`"${q.title}" is already ${finishing ? "done" : "open"}.`);
      } else {
        await sqlite.execute("UPDATE div2_custom_quests SET done_at = ? WHERE id = ?", [finishing ? Date.now() : null, q.id]);
        const open = state.custom.filter((c) => !c.doneAt).length + (finishing ? -1 : 1);
        await say(finishing ? `✅ Quest complete: ${q.title}! ${open} custom quest${open === 1 ? "" : "s"} left.` : `↩️ "${q.title}" is open again.`);
      }
    } else {
      const q = found.campaign;
      const wasDone = state.campaignDone.has(q.key);
      if (wasDone === finishing) {
        await say(`${q.name} is already ${finishing ? "done" : "open"}.`);
      } else {
        if (finishing) {
          await sqlite.execute(
            "INSERT OR REPLACE INTO div2_campaign_done (broadcaster_id, quest_key, done_at) VALUES (?,?,?)",
            [broadcasterId, q.key, Date.now()],
          );
        } else {
          await sqlite.execute("DELETE FROM div2_campaign_done WHERE broadcaster_id = ? AND quest_key = ?", [broadcasterId, q.key]);
        }
        const count = state.campaignDone.size + (finishing ? 1 : -1);
        const progress = `Campaign ${count}/${DIV2_CAMPAIGN.length}`;
        await say(
          finishing
            ? count === DIV2_CAMPAIGN.length ? `🏆 ${q.name} complete — that's the whole campaign checklist! ${progress}.` : `✅ ${q.name} complete! ${progress}.`
            : `↩️ ${q.name} is open again. ${progress}.`,
        );
      }
    }
  } else if (sub === "remove" || sub === "delete") {
    const q = /^#?\d+$/.test(arg) ? state.custom[Number(arg.replace("#", "")) - 1] : undefined;
    if (!q) {
      await say(state.custom.length ? `usage: !div2quest remove <1-${state.custom.length}> (custom quests only)` : "there are no custom quests to remove.");
    } else {
      await sqlite.execute("DELETE FROM div2_custom_quests WHERE id = ?", [q.id]);
      await say(`removed quest: ${q.title}`);
    }
  } else if (sub === "clear") {
    const finished = state.custom.filter((c) => c.doneAt).length;
    await sqlite.execute("DELETE FROM div2_custom_quests WHERE broadcaster_id = ? AND done_at IS NOT NULL", [broadcasterId]);
    await say(`cleared ${finished} completed custom quest${finished === 1 ? "" : "s"}.`);
  } else if (sub === "reset") {
    await sqlite.execute("DELETE FROM div2_campaign_done WHERE broadcaster_id = ?", [broadcasterId]);
    await say(`the campaign checklist is reset to 0/${DIV2_CAMPAIGN.length}. Custom quests are untouched.`);
  } else {
    await say("usage: !div2quests [campaign] | mods: !div2quest add <quest> | done <n|name> | undo <n|name> | remove <n> | clear | reset");
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public page: /div2quests?channel=<id>
// ---------------------------------------------------------------------------

export function renderDiv2QuestsPage(channelName: string, state: Div2QuestState, baseUrl: string): string {
  const name = escapeHtml(channelName);
  const date = (t: number) => new Date(t).toISOString().slice(0, 10);
  const tick = (doneAt: number | null | undefined) =>
    doneAt ? `<span class="ok" title="Completed ${date(doneAt)}">✅ ${date(doneAt)}</span>` : `<span class="muted">☐ to do</span>`;

  const arcs = [...new Set(DIV2_CAMPAIGN.map((q) => q.arc))];
  const campaignCards = arcs.map((arc) => {
    const quests = DIV2_CAMPAIGN.filter((q) => q.arc === arc);
    const done = quests.filter((q) => state.campaignDone.has(q.key)).length;
    const rows = quests
      .map((q) => `<tr><td>${escapeHtml(q.name)}</td><td>${tick(state.campaignDone.get(q.key))}</td></tr>`)
      .join("");
    return `<h3>${escapeHtml(arc)} <span class="muted small">${done}/${quests.length}</span></h3><div class="table-wrap"><table><tbody>${rows}</tbody></table></div>`;
  }).join("");

  const customRows = state.custom.length
    ? state.custom.map((c, i) => `<tr><td class="num">${i + 1}</td><td>${escapeHtml(c.title)}</td><td>${tick(c.doneAt)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="muted">No custom quests yet — mods add them with <code>!div2quest add &lt;quest&gt;</code>.</td></tr>`;
  const customDone = state.custom.filter((c) => c.doneAt).length;
  const pct = Math.round((state.campaignDone.size / DIV2_CAMPAIGN.length) * 100);

  const body =
    `<span class="pill">The Division 2 · Quests</span><h1>${name}</h1>` +
    `<p class="muted">The agent's progress through the Division 2 campaign, plus the channel's own quests. Updated live from Twitch chat.</p>` +
    `<div class="stats"><div class="stat"><b>${campaignProgress(state)}</b>campaign (${pct}%)</div><div class="stat"><b>${customDone}/${state.custom.length}</b>custom quests</div></div>` +
    `<h2>Custom quests</h2><div class="table-wrap"><table><thead><tr><th class="num">#</th><th>Quest</th><th>Status</th></tr></thead><tbody>${customRows}</tbody></table></div>` +
    `<h2>Campaign checklist</h2>${campaignCards}` +
    `<p class="muted small">From chat: <code>!div2quests</code> · <code>!div2quests campaign</code> · mods: <code>!div2quest add/done/undo/remove/clear/reset</code> · full list: <a href="${baseUrl}/guide#div2">Guild Codex</a></p>`;
  return scrollDoc(`${name} — Division 2 quests`, body, {
    css: `${LEDGER_CSS}.ok{color:var(--ok);font-weight:600}h3{margin-top:22px}td:last-child,th:last-child,td.num,th.num{white-space:nowrap;width:1%}`,
  });
}

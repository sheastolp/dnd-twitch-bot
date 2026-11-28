// GuildScribe — the AI model picker, /admin/ai.
//
// Every AI reply (!haggle, NPCs, !askme, @-mention replies) goes through
// openai.ts. Its address and model normally come from guildscribe.env
// (OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_API_KEY). This page lets the
// operator pick them in the browser instead, with no file editing and no
// restart:
//   - Address: any OpenAI-shaped server (OpenAI, Ollama, the AI Pool, …),
//     ending in /v1. "AI Pool" fills in the pool's brain: AI_POOL_URL, or
//     port 8090 on the tailnet machine OPENAI_BASE_URL points at.
//   - Model: typed, or picked from the list the server itself offers
//     (GET <address>/models).
//   - Key: optional, for servers that want one. It's never shown again,
//     and it's only sent to the address it was saved with.
// A blank field falls back to guildscribe.env; "Use guildscribe.env again"
// clears the page's choice. "Test" sends one short question to the AI that
// GuildScribe is using now.
//
// It's bot-wide (one AI for every channel), so only the operator can change
// it: the same ADMIN_API_SECRET / bot-admin login as the other /admin pages.
// Table `bot_ai_settings` (one row).
//
// The AI switch, at the top of the page: on (the default), the AI writes
// GuildScribe's replies (ai_voice.ts) and runs !haggle, NPCs, !askme and the
// @-mention babushka; off, nothing is sent to any AI and every feature uses
// its canned lines. Bot admins can also flip it from chat with !ai on|off
// (anyone can ask !ai). Kept in table `bot_ai_power` (one row), so it
// survives a restart.

import { sqlite } from "./sqlite.ts";
import { escapeHtml } from "./utils.ts";
import { LEDGER_CSS, scrollDoc } from "./scroll_theme.ts";
import { isOperatorRequest, operatorUnauthorized } from "./operator_auth.ts";
import {
  type AiConfig,
  type AiOverride,
  cleanBaseUrl,
  currentAiConfig,
  DEFAULT_BASE_URL,
  listAiModels,
  OpenAI,
  isAiEnabled,
  setAiEnabled,
  setAiOverride,
  setAiOverrideReady,
} from "./openai.ts";
import { sendChatMessage } from "./twitch.ts";
import { isBotAdminLogin } from "./bot_admins.ts";
import { rewordStats } from "./ai_voice.ts";

const MAX_MODEL_LEN = 200;
const MAX_URL_LEN = 500;
const MAX_KEY_LEN = 500;

/** The AI Pool's brain (llama-server, OpenAI-shaped, no key): AI_POOL_URL,
 * else port 8090 on the tailnet machine guildscribe.env's OPENAI_BASE_URL
 * points at (the FX705, where Ollama and the pool both run), else none. */
export function aiPoolPresetUrl(): string {
  const set = cleanBaseUrl(Deno.env.get("AI_POOL_URL") ?? "");
  if (/^(off|no|false|0)$/i.test(set)) return "";
  if (set) return set;
  try {
    const host = new URL(Deno.env.get("OPENAI_BASE_URL") ?? "").hostname;
    if (host.endsWith(".ts.net") || /^100\.\d+\.\d+\.\d+$/.test(host)) return `http://${host}:8090/v1`;
  } catch { /* no env address */ }
  return "";
}

/** Addresses offered as one-tap fills. */
function presets(): { label: string; url: string }[] {
  const pool = aiPoolPresetUrl();
  return [
    ...(pool ? [{ label: "AI Pool", url: pool }] : []),
    { label: "OpenAI", url: DEFAULT_BASE_URL },
    { label: "Ollama on this laptop", url: "http://localhost:11434/v1" },
    { label: "llama.cpp on this laptop", url: "http://localhost:8080/v1" },
  ];
}

let saved: AiOverride & { updatedAt: number } = { baseUrl: "", model: "", apiKey: "", updatedAt: 0 };

export async function ensureAiSettingsTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS bot_ai_settings (id INTEGER PRIMARY KEY CHECK (id = 1), base_url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)`,
  );
}

let powerChangedAt = 0;

async function ensureAiPowerTable() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS bot_ai_power (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '')`,
  );
}

async function readPower() {
  await ensureAiPowerTable();
  const r = (await sqlite.execute("SELECT enabled, updated_at FROM bot_ai_power WHERE id = 1")).rows[0] as any;
  setAiEnabled(r ? Number(r.enabled) !== 0 : true);
  powerChangedAt = Number(r?.updated_at ?? 0);
}

/** Flips the AI switch for every channel and saves it. */
export async function setAiSwitch(on: boolean, by: string) {
  await ensureAiPowerTable();
  await sqlite.execute(
    `INSERT INTO bot_ai_power (id, enabled, updated_at, updated_by) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [on ? 1 : 0, Date.now(), by],
  );
  await readPower();
}

/** !ai — is the AI writing replies? !ai on|off flips it (bot admins only,
 * since it's one switch for every channel). True if it was an !ai command. */
export async function handleAiSwitchCommand(chatMessage: string, chatter: string, display: string, broadcasterId: string): Promise<boolean> {
  const m = chatMessage.trim().match(/^!ai(?:\s+(\S+))?\s*$/i);
  if (!m) return false;
  const action = (m[1] ?? "status").toLowerCase();
  if (action !== "on" && action !== "off") {
    const on = isAiEnabled();
    await sendChatMessage(
      `@${display} AI replies are ${on ? "on: the AI words GuildScribe's replies" : "off: GuildScribe uses its canned lines"}.${isBotAdminLogin(chatter) ? ` Switch with !ai ${on ? "off" : "on"}.` : ""}`,
      broadcasterId,
    );
    return true;
  }
  if (!isBotAdminLogin(chatter)) {
    await sendChatMessage(`@${display} only the bot's operator can switch AI replies ${action}, since it's one switch for every channel.`, broadcasterId);
    return true;
  }
  await setAiSwitch(action === "on", chatter.toLowerCase());
  await sendChatMessage(
    action === "on"
      ? `@${display} AI replies are on. The AI words GuildScribe's replies again.`
      : `@${display} AI replies are off. GuildScribe uses its canned lines and sends nothing to the AI.`,
    broadcasterId,
  );
  return true;
}

async function readSaved() {
  await ensureAiSettingsTables();
  const r = (await sqlite.execute("SELECT base_url, model, api_key, updated_at FROM bot_ai_settings WHERE id = 1")).rows[0] as any;
  saved = {
    baseUrl: cleanBaseUrl(String(r?.base_url ?? "")),
    model: String(r?.model ?? "").trim(),
    apiKey: String(r?.api_key ?? "").trim(),
    updatedAt: Number(r?.updated_at ?? 0),
  };
  setAiOverride(saved);
}

/** server.ts: load the page's saved choice at start-up (AI requests wait for it). */
export function loadAiSettings(): Promise<void> {
  const p = Promise.all([
    readSaved().catch((e) => console.error("ai settings load failed:", e)),
    readPower().catch((e) => console.error("ai switch load failed:", e)),
  ]).then(() => {});
  setAiOverrideReady(p);
  return p;
}

async function writeSaved(o: AiOverride) {
  await ensureAiSettingsTables();
  await sqlite.execute(
    `INSERT INTO bot_ai_settings (id, base_url, model, api_key, updated_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, model = excluded.model, api_key = excluded.api_key, updated_at = excluded.updated_at`,
    [o.baseUrl, o.model, o.apiKey, Date.now()],
  );
  await readSaved();
}

/** The key to use when asking `address` for its models: a newly typed one,
 * else the key already in use there (never one meant for another address). */
function keyFor(address: string, typed: string): string {
  if (typed) return typed;
  const cfg = currentAiConfig();
  return cleanBaseUrl(address) === cfg.baseUrl ? cfg.apiKey : "";
}

/** "" if fine, else what's wrong with the address. */
function addressProblem(url: string): string {
  if (!url) return "";
  if (url.length > MAX_URL_LEN) return "That address is too long.";
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "The address has to start with http:// or https://.";
  } catch {
    return "That doesn't look like a web address. It should look like http://localhost:11434/v1.";
  }
  return "";
}

const SOURCE_TEXT: Record<string, string> = {
  page: "picked on this page",
  file: "from guildscribe.env",
  default: "built-in default",
  none: "none",
};

function statusCard(cfg: AiConfig): string {
  const model = cfg.model
    ? `<code>${escapeHtml(cfg.model)}</code> <span class="muted small">(${SOURCE_TEXT[cfg.modelSource]})</span>`
    : `<span>Each feature's own model</span> <span class="muted small">(NPC_MODEL, HAGGLE_MODEL, ASKME_MODEL, MENTION_REPLY_MODEL; gpt-4o-mini when unset)</span>`;
  const key = cfg.keySource === "none" ? `<span class="muted">none</span>` : `set <span class="muted small">(${SOURCE_TEXT[cfg.keySource]})</span>`;
  return `<div class="card ai-now"><h3>What GuildScribe uses right now</h3>
<p><strong>Address:</strong> <code class="wrap">${escapeHtml(cfg.baseUrl)}</code> <span class="muted small">(${SOURCE_TEXT[cfg.baseUrlSource]})</span></p>
<p><strong>Model:</strong> ${model}</p>
<p><strong>Key:</strong> ${key}</p></div>`;
}

type PageState = {
  key: string;
  notice?: string;
  error?: string;
  /** Form values to show (after Load models or a failed save); else the saved ones. */
  form?: { baseUrl: string; model: string };
  models?: string[];
  modelsError?: string;
  modelsFrom?: string;
  test?: { ok: boolean; text: string; seconds: number; model: string };
};

function page(s: PageState): Response {
  const cfg = currentAiConfig();
  const formUrl = s.form?.baseUrl ?? saved.baseUrl;
  const formModel = s.form?.model ?? saved.model;
  const k = encodeURIComponent(s.key);
  const hiddenKey = `<input type="hidden" name="key" value="${escapeHtml(s.key)}">`;
  const presetButtons = presets().map((p) => `<button type="button" class="chip" data-url="${escapeHtml(p.url)}">${escapeHtml(p.label)}</button>`).join("");
  const models = s.models?.length
    ? `<p class="muted small">Tap one to pick it (${s.models.length} on ${escapeHtml(s.modelsFrom ?? "")}):</p><div class="chips">${
      s.models.map((m) => `<button type="button" class="chip model" data-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`).join("")
    }</div>`
    : s.modelsError
    ? `<p class="banner error small">Couldn't load models from ${escapeHtml(s.modelsFrom ?? "that address")}: ${escapeHtml(s.modelsError)}. You can still type the model name.</p>`
    : s.models
    ? `<p class="muted small">${escapeHtml(s.modelsFrom ?? "That server")} didn't list any models. Type the model name.</p>`
    : "";
  const savedKeyNote = saved.apiKey
    ? `A key is saved on this page. Leave this blank to keep it (it's only kept while the address stays the same).`
    : `Only needed if the server asks for one (OpenAI, OpenRouter, the AI Pool). Leave blank for Ollama.`;
  const test = s.test
    ? `<div class="banner ${s.test.ok ? "ok" : "error"}"><strong>${s.test.ok ? "It answered" : "Test failed"}</strong> in ${s.test.seconds.toFixed(1)} s${
      s.test.model ? ` (model ${escapeHtml(s.test.model)})` : ""
    }:<br>${escapeHtml(s.test.text)}</div>`
    : "";
  const on = isAiEnabled();
  const power = `<form method="post" action="/admin/ai" class="card ai-power ${on ? "is-on" : "is-off"}">${hiddenKey}
<h3>AI replies: ${on ? "ON" : "OFF"}</h3>
<p>${on
    ? "The AI words every GuildScribe reply in chat (the bot still works out the dice, coins and names itself), and runs !haggle, NPCs, !askme and the @-mention babushka. If it's slow, busy or garbled, the canned line goes out instead."
    : "Nothing is sent to the AI. Every reply uses GuildScribe's canned lines, and !haggle, NPCs, !askme and the babushka answer with their built-in ones."}</p>
<button type="submit" name="intent" value="${on ? "power_off" : "power_on"}" class="${on ? "ghost" : "ember"}" role="switch" aria-checked="${on}">${on ? "Turn AI off" : "Turn AI on"}</button>
${on ? `<p class="small">Since GuildScribe started: <strong>${rewordStats.reworded}</strong> replies worded by the AI, <strong>${rewordStats.canned}</strong> sent canned instead (${rewordStats.busy} AI busy or slow, ${rewordStats.blocked} blocked for dropping a fact or coming out garbled, ${rewordStats.failed} errors). Blocked ones are on the operator logs as ai_reword_blocked.</p>` : ""}
<p class="muted small">One switch for every channel. Bot admins can also type <code>!ai on</code> or <code>!ai off</code> in chat.${powerChangedAt ? ` Last switched ${new Date(powerChangedAt).toISOString().replace("T", " ").slice(0, 16)} UTC.` : ""}</p>
</form>`;
  const body = `<h1>AI model</h1>
<p class="lede">Pick which AI GuildScribe uses to word its chat replies and for <code>!haggle</code>, NPCs, <code>!askme</code> and replies when someone @-tags the bot. It's one choice for every channel, and it takes effect straight away, with no restart. Leave a field blank to use what guildscribe.env says.</p>
${s.error ? `<p class="banner error">${escapeHtml(s.error)}</p>` : s.notice ? `<p class="banner ok">${escapeHtml(s.notice)}</p>` : ""}
${power}
${statusCard(cfg)}
${test}
<form method="post" action="/admin/ai" class="card ai-form" autocomplete="off">${hiddenKey}
<h3>Change it</h3>
<label for="ai-url"><strong>Address</strong> <span class="muted small">(an OpenAI-shaped server, usually ending in /v1)</span></label>
<input type="url" id="ai-url" name="base_url" value="${escapeHtml(formUrl)}" maxlength="${MAX_URL_LEN}" placeholder="${escapeHtml(cfg.baseUrlSource === "page" ? "" : cfg.baseUrl)}" inputmode="url" spellcheck="false">
<div class="chips">${presetButtons}</div>
<label for="ai-model"><strong>Model</strong> <span class="muted small">(blank = guildscribe.env or each feature's own)</span></label>
<input type="text" id="ai-model" name="model" value="${escapeHtml(formModel)}" maxlength="${MAX_MODEL_LEN}" placeholder="e.g. qwen3.5:35b-a3b or gpt-4o-mini" spellcheck="false" autocapitalize="off">
<button type="submit" name="intent" value="models" class="ghost" formnovalidate>Load models from this address</button>
${models}
<label for="ai-key"><strong>Key</strong> <span class="muted small">(optional)</span></label>
<input type="password" id="ai-key" name="api_key" value="" maxlength="${MAX_KEY_LEN}" placeholder="${saved.apiKey ? "saved — leave blank to keep" : "none"}" autocomplete="new-password">
<p class="muted small">${savedKeyNote}</p>
${saved.apiKey ? `<label class="check"><input type="checkbox" name="clear_key" value="1"> Remove the saved key</label>` : ""}
<div class="actions"><button type="submit" name="intent" value="save" class="ember">Save</button></div>
</form>
<form method="post" action="/admin/ai" class="actions">${hiddenKey}
<button type="submit" name="intent" value="test" class="ghost">Test the AI in use now</button>
${saved.baseUrl || saved.model || saved.apiKey ? `<button type="submit" name="intent" value="reset" class="ghost" onclick="return confirm('Go back to what guildscribe.env says?')">Use guildscribe.env again</button>` : ""}
</form>
<p class="muted small">${saved.updatedAt ? `Last changed here ${new Date(saved.updatedAt).toISOString().replace("T", " ").slice(0, 16)} UTC.` : "Nothing picked here yet: GuildScribe follows guildscribe.env."} A key saved here is kept in GuildScribe's database on the laptop and never shown again.</p>
<p><a href="/admin/channels?key=${k}">Channel connections</a> · <a href="/admin/logs?key=${k}">Operator logs</a></p>
<script>(function(){
var u=document.getElementById("ai-url"),m=document.getElementById("ai-model");
document.querySelectorAll(".chip[data-url]").forEach(function(b){b.addEventListener("click",function(){u.value=b.getAttribute("data-url");u.focus()})});
document.querySelectorAll(".chip[data-model]").forEach(function(b){b.addEventListener("click",function(){m.value=b.getAttribute("data-model");document.querySelectorAll(".chip.model").forEach(function(x){x.classList.toggle("on",x===b)})})});
})();</script>`;
  return new Response(scrollDoc("AI model — GuildScribe", body, { width: 900, css: LEDGER_CSS + AI_CSS }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const AI_CSS = `
.ai-form label{display:block;margin-top:14px}
.ai-form input[type=url],.ai-form input[type=text],.ai-form input[type=password]{width:100%;box-sizing:border-box;margin:6px 0;font-size:16px;padding:10px 12px}
.ai-form label.check{display:flex;align-items:center;gap:8px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 10px}
.chip{font:inherit;font-size:.92rem;padding:8px 12px;min-height:40px;border-radius:999px;border:1px solid var(--edge);background:#e7e0ca;color:var(--ink);cursor:pointer;max-width:100%;overflow-wrap:anywhere;text-align:left}
.chip.on{background:var(--seal);color:#fff3dc;border-color:var(--seal-dk)}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
.actions button,.ai-form button{min-height:44px;padding:10px 16px;font:inherit}
code.wrap{overflow-wrap:anywhere}
.ai-power.is-on{border-left:6px solid #3f7d3a}
.ai-power.is-off{border-left:6px solid #9b2c2c}
.ai-power button{min-height:44px;padding:10px 16px;font:inherit}
.ai-now p{margin:6px 0;overflow-wrap:anywhere}
`;

/** ?key= decoded by hand so a "+" in the secret survives (see /admin/logs). */
function keyFromQuery(url: URL): string {
  const m = url.search.slice(1).match(/(?:^|&)key=([^&]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function tryListModels(address: string, apiKey: string): Promise<Pick<PageState, "models" | "modelsError" | "modelsFrom">> {
  const modelsFrom = address;
  try {
    return { models: await listAiModels(address, apiKey), modelsFrom };
  } catch (e) {
    const msg = e instanceof Error && e.name === "TimeoutError" ? "no answer within 6 seconds" : String(e instanceof Error ? e.message : e);
    return { modelsError: msg.slice(0, 200), modelsFrom };
  }
}

async function runTest(): Promise<NonNullable<PageState["test"]>> {
  const started = Date.now();
  const cfg = currentAiConfig();
  try {
    const res = await new OpenAI().chat.completions.create(
      {
        model: cfg.model || "gpt-4o-mini",
        messages: [{ role: "user", content: "Say hello to a Twitch chat in one short sentence, as a tavern keeper." }],
        max_completion_tokens: 80,
        think: false,
      },
      { timeoutMs: 90_000, ignoreSwitch: true },
    );
    const text = String(res?.choices?.[0]?.message?.content ?? "").trim() || "(an empty reply)";
    return { ok: true, text: text.slice(0, 400), seconds: (Date.now() - started) / 1000, model: String(res?.model ?? cfg.model ?? "") };
  } catch (e) {
    const msg = e instanceof Error && e.name === "TimeoutError" ? "no answer within 90 seconds" : String(e instanceof Error ? e.message : e);
    return { ok: false, text: msg.slice(0, 400), seconds: (Date.now() - started) / 1000, model: cfg.model };
  }
}

/** GET and POST /admin/ai; null for other paths. */
export async function handleAiAdminRoute(req: Request, url: URL, path: string): Promise<Response | null> {
  if (path !== "/admin/ai") return null;
  if (req.method === "GET") {
    const key = keyFromQuery(url);
    if (!(await isOperatorRequest(req, key))) return operatorUnauthorized();
    await readSaved();
    await readPower();
    const cfg = currentAiConfig();
    return page({ key, ...(await tryListModels(cfg.baseUrl, cfg.apiKey)) });
  }
  if (req.method !== "POST") return null;
  const form = await req.formData();
  const key = String(form.get("key") ?? "");
  if (!(await isOperatorRequest(req, key))) return operatorUnauthorized();
  await readSaved();
  const intent = String(form.get("intent") ?? "save");
  const baseUrl = cleanBaseUrl(String(form.get("base_url") ?? ""));
  const model = String(form.get("model") ?? "").trim();
  const typedKey = String(form.get("api_key") ?? "").trim();
  const formValues = { baseUrl, model };

  if (intent === "test") return page({ key, test: await runTest() });

  if (intent === "power_on" || intent === "power_off") {
    await setAiSwitch(intent === "power_on", "admin page");
    return page({
      key,
      notice: intent === "power_on" ? "AI replies are on." : "AI replies are off: GuildScribe uses its canned lines and sends nothing to the AI.",
    });
  }

  if (intent === "reset") {
    await writeSaved({ baseUrl: "", model: "", apiKey: "" });
    return page({ key, notice: "Back to guildscribe.env. AI replies use its settings from now on." });
  }

  const problem = addressProblem(baseUrl);
  if (intent === "models") {
    if (problem) return page({ key, form: formValues, error: problem });
    const address = baseUrl || currentAiConfig().baseUrl;
    return page({ key, form: formValues, ...(await tryListModels(address, keyFor(address, typedKey))) });
  }

  // Save.
  if (problem) return page({ key, form: formValues, error: problem });
  if (model.length > MAX_MODEL_LEN) return page({ key, form: formValues, error: "That model name is too long." });
  if (typedKey.length > MAX_KEY_LEN) return page({ key, form: formValues, error: "That key is too long." });
  const sameAddress = (baseUrl || "") === saved.baseUrl;
  let apiKey = typedKey;
  let keyNote = "";
  if (!apiKey && form.get("clear_key") !== "1" && saved.apiKey) {
    if (sameAddress) apiKey = saved.apiKey;
    else keyNote = " The saved key was for the old address, so it was removed; type it again if the new one needs it.";
  }
  await writeSaved({ baseUrl, model, apiKey });
  const cfg = currentAiConfig();
  const notice = `Saved. AI replies now go to ${cfg.baseUrl}${cfg.model ? ` using ${cfg.model}` : ""}. Press "Test the AI in use now" to check it answers.${keyNote}`;
  return page({ key, notice, ...(await tryListModels(cfg.baseUrl, cfg.apiKey)) });
}

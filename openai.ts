// A tiny OpenAI-compatible chat client with the official SDK's `new OpenAI().chat.completions.create(...)` shape.
//
// Point it at either:
//   - OpenAI: set OPENAI_API_KEY (OPENAI_BASE_URL defaults to api.openai.com)
//   - Ollama on the Local AI laptop (free): OPENAI_BASE_URL=http://<ai-laptop>:11434/v1
//     and OPENAI_MODEL=<an installed model, e.g. llama3.2>; no key needed.
//   - Any other OpenAI-shaped server (the AI Pool, llama.cpp, OpenRouter…).
// OPENAI_MODEL, when set, replaces whatever model the caller asks for.
//
// The operator page /admin/ai (ai_model.ts) can pick the address, model and
// key instead, without editing guildscribe.env: what it saved wins over the
// env vars, and a field left blank there falls back to them. The env key is
// only sent to the env address, so pointing the page at another server never
// hands that server the OpenAI key.
//
// A caller may pass `reasoning_effort`; it is only forwarded to OpenAI
// reasoning models (gpt-5*, o3*, o4*), which are the only ones that accept it.
// Those models also refuse `temperature`, `top_p` and the penalties, so those
// are dropped for them and sent to every other model.
//
// Thinking: on any server but OpenAI, requests ask the model to answer
// straight away instead of thinking first (Qwen3/3.5, deepseek-r1…), because a
// chat reply needs a quip, not a proof, and thinking would spend the reply's
// time and tokens. It's sent the two ways servers understand: llama.cpp's
// `chat_template_kwargs: { enable_thinking: false }` (the AI Pool) and
// `reasoning_effort: "none"` (Ollama). A server that won't take them gets the
// request again without them. A caller that does want thinking passes
// `think: true`.
//
// The AI Pool answers one request at a time, so GuildScribe sends it one at a
// time too (AI_MAX_CONCURRENT, default 1 for any server but OpenAI): the rest
// wait their turn inside their own time limit. A caller that would rather
// skip than wait (an NPC chiming in unprompted) passes `ifIdle: true`. A busy
// or failed request is not tried again against the pool (it shouldn't be
// taxed by bots): each feature answers its own fallback way instead.
//
// The AI switch (/admin/ai, or !ai on|off in chat — ai_model.ts): while it's
// off, every request fails at once with AiOffError and nothing is sent to any
// server, so each feature answers with its own canned lines. On by default.

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Trims spaces and trailing slashes off an address. */
export function cleanBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

const ENV_BASE_URL = cleanBaseUrl(Deno.env.get("OPENAI_BASE_URL") || "") || DEFAULT_BASE_URL;
const ENV_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const ENV_MODEL = (Deno.env.get("OPENAI_MODEL") || "").trim();
const TIMEOUT_MS = Number(Deno.env.get("OPENAI_TIMEOUT_MS") || 60_000);
/** How many requests GuildScribe has in flight at once to a server that isn't
 * OpenAI (the AI Pool and Ollama answer one at a time). 0 = no limit. */
const MAX_CONCURRENT = Math.max(0, Math.floor(Number(Deno.env.get("AI_MAX_CONCURRENT") ?? "1")));

/** What the operator saved on /admin/ai; blank fields fall back to the env vars. */
export type AiOverride = { baseUrl: string; model: string; apiKey: string };
let override: AiOverride = { baseUrl: "", model: "", apiKey: "" };
let overrideReady: Promise<unknown> = Promise.resolve();

/** ai_model.ts: the settings saved on /admin/ai (or none). */
export function setAiOverride(o: Partial<AiOverride> | null) {
  override = { baseUrl: cleanBaseUrl(o?.baseUrl ?? ""), model: (o?.model ?? "").trim(), apiKey: (o?.apiKey ?? "").trim() };
}

/** ai_model.ts: AI requests wait for this (the saved settings loading at start-up). */
export function setAiOverrideReady(p: Promise<unknown>) {
  overrideReady = p.catch(() => {});
}

let aiEnabled = true;

/** ai_model.ts: the AI switch (saved on /admin/ai or by !ai on|off). */
export function setAiEnabled(on: boolean) {
  aiEnabled = on;
}

/** False while the AI switch is off: no AI requests at all, canned lines everywhere. */
export function isAiEnabled(): boolean {
  return aiEnabled;
}

/** Thrown, without any request, while the AI switch is off. */
export class AiOffError extends Error {
  constructor() {
    super("the AI is switched off");
    this.name = "AiOffError";
  }
}

/** True if `e` means "the AI switch is off" (callers use their canned line
 * and log nothing: it isn't a failure). */
export function isAiOff(e: unknown): boolean {
  return e instanceof AiOffError || (e as any)?.name === "AiOffError";
}

export type AiSource = "page" | "file" | "default";
export type AiConfig = {
  baseUrl: string;
  baseUrlSource: AiSource;
  /** The model every request runs on, or "" when each feature uses its own. */
  model: string;
  modelSource: AiSource;
  apiKey: string;
  keySource: AiSource | "none";
  isOpenAI: boolean;
};

function hostIsOpenAI(baseUrl: string): boolean {
  try {
    return /(^|\.)openai\.com$/.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** The address, model and key AI requests use right now. */
export function currentAiConfig(): AiConfig {
  const baseUrl = override.baseUrl || ENV_BASE_URL;
  const baseUrlSource: AiSource = override.baseUrl ? "page" : Deno.env.get("OPENAI_BASE_URL") ? "file" : "default";
  // The env key belongs to the env address: don't send it anywhere else.
  const envKeyFits = baseUrl === ENV_BASE_URL;
  const apiKey = override.apiKey || (envKeyFits ? ENV_API_KEY : "");
  const keySource = override.apiKey ? "page" : apiKey ? "file" : "none";
  const model = override.model || ENV_MODEL;
  const modelSource: AiSource = override.model ? "page" : ENV_MODEL ? "file" : "default";
  return { baseUrl, baseUrlSource, model, modelSource, apiKey, keySource, isOpenAI: hostIsOpenAI(baseUrl) };
}

/** The model a request for `model` actually runs on (the picked model / OPENAI_MODEL wins). */
export function resolvedModel(model: string): string {
  return currentAiConfig().model || model;
}

/** True if `model` is an OpenAI reasoning model: it spends part of its token
 * budget thinking before it answers, and accepts `reasoning_effort`. */
export function isReasoningModel(model: string): boolean {
  return currentAiConfig().isOpenAI && /^(?:gpt-5|o[3-9])/i.test(resolvedModel(model));
}

/** The model ids a server offers (GET <address>/models), for the picker. */
export async function listAiModels(baseUrl: string, apiKey: string, timeoutMs = 6_000): Promise<string[]> {
  const res = await fetch(`${cleanBaseUrl(baseUrl)}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const list: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  const ids = list.map((m) => String(m?.id ?? m?.name ?? m?.model ?? "")).filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** Thinking models (Qwen3/3.5 on llama.cpp or Ollama) can still put their
 * <think>…</think> notes in the reply; only the answer after them goes on. */
export function stripThinking(j: any): any {
  for (const c of Array.isArray(j?.choices) ? j.choices : []) {
    const m = c?.message;
    if (typeof m?.content !== "string" || !/<\/?think>/i.test(m.content)) continue;
    let t = m.content.replace(/<think>[\s\S]*?<\/think>/gi, "");
    const close = t.search(/<\/think>/i); // an opening tag the template already sent
    if (close >= 0) t = t.slice(close + "</think>".length);
    m.content = t.replace(/<think>[\s\S]*$/i, "").trim();
  }
  return j;
}

/** Thrown when the AI didn't get to the request in time (busy with others,
 * or the time limit ran out) or the caller asked to skip a busy AI. */
export class AiBusyError extends Error {
  constructor(message = "the AI is busy") {
    super(message);
    this.name = "AiBusyError";
  }
}

/** True if `e` means "busy or too slow", not "broken": a queue that didn't
 * clear, a timeout, or a 503/429 from the server. Callers say "try again in a
 * moment" for these. */
export function isAiBusy(e: unknown): boolean {
  if (e instanceof AiBusyError) return true;
  const name = (e as any)?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  return /HTTP (?:503|429)\b/.test(String(e));
}

// One slot per request in flight; the rest queue in order.
let active = 0;
const queue: (() => void)[] = [];

function takeSlot(deadline: number, ifIdle: boolean): Promise<() => void> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    active--;
    queue.shift()?.();
  };
  if (MAX_CONCURRENT === 0) return Promise.resolve(() => {});
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve(release);
  }
  if (ifIdle) return Promise.reject(new AiBusyError("the AI is busy with another reply"));
  return new Promise((resolve, reject) => {
    const go = () => {
      clearTimeout(timer);
      active++;
      resolve(release);
    };
    const timer = setTimeout(() => {
      const at = queue.indexOf(go);
      if (at >= 0) queue.splice(at, 1);
      reject(new AiBusyError("the AI was busy with other replies the whole time"));
    }, Math.max(0, deadline - Date.now()));
    queue.push(go);
  });
}

/** Test hook: how many requests are in flight and waiting. */
export function aiQueueState(): { active: number; waiting: number } {
  return { active, waiting: queue.length };
}

const SAMPLING_FIELDS = ["temperature", "top_p", "frequency_penalty", "presence_penalty"];

export class OpenAI {
  chat = {
    completions: {
      // ignoreSwitch: only the operator's "Test" button on /admin/ai, which
      // checks the AI answers before it's switched back on.
      create: async (body: Record<string, any>, opts: { timeoutMs?: number; ifIdle?: boolean; ignoreSwitch?: boolean } = {}): Promise<any> => {
        await overrideReady;
        if (!aiEnabled && !opts.ignoreSwitch) throw new AiOffError();
        const cfg = currentAiConfig();
        if (cfg.isOpenAI && !cfg.apiKey) throw new Error("AI replies need OPENAI_API_KEY (or another AI server picked on /admin/ai or in OPENAI_BASE_URL)");
        const req: Record<string, any> = { ...body, stream: false };
        const wantsThinking = req.think === true;
        delete req.think;
        if (cfg.model) req.model = cfg.model;
        const reasoning = isReasoningModel(String(req.model ?? ""));
        if (req.reasoning_effort !== undefined && !reasoning) delete req.reasoning_effort;
        // OpenAI reasoning models only take the default sampling.
        if (reasoning) for (const k of SAMPLING_FIELDS) delete req[k];
        const thinkingOff = !cfg.isOpenAI && !wantsThinking;
        if (thinkingOff) {
          req.reasoning_effort = "none";
          req.chat_template_kwargs = { ...(req.chat_template_kwargs ?? {}), enable_thinking: false };
        }
        // Ollama and most other OpenAI-compatible servers read max_tokens.
        if (!cfg.isOpenAI && req.max_completion_tokens !== undefined && req.max_tokens === undefined) {
          req.max_tokens = req.max_completion_tokens;
          delete req.max_completion_tokens;
        }
        const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;
        const release = cfg.isOpenAI ? () => {} : await takeSlot(deadline, !!opts.ifIdle);
        try {
          const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
          const post = () =>
            fetch(`${cfg.baseUrl}/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
              },
              body: JSON.stringify(req),
              signal,
            });
          let res = await post();
          // A server that doesn't know the thinking-off fields (the request
          // never ran, so this isn't a retry of real work).
          if (res.status === 400 && thinkingOff) {
            await res.body?.cancel();
            delete req.reasoning_effort;
            delete req.chat_template_kwargs;
            res = await post();
          }
          if (!res.ok) throw new Error(`AI request failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
          return stripThinking(await res.json());
        } finally {
          release();
        }
      },
    },
  };
}

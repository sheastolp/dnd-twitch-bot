// A tiny OpenAI-compatible chat client, standing in for Val Town's std/openai
// with the same `new OpenAI().chat.completions.create(...)` shape.
//
// Point it at either:
//   - OpenAI: set OPENAI_API_KEY (OPENAI_BASE_URL defaults to api.openai.com)
//   - Ollama on the Local AI laptop (free): OPENAI_BASE_URL=http://<ai-laptop>:11434/v1
//     and OPENAI_MODEL=<an installed model, e.g. llama3.2>; no key needed.
// OPENAI_MODEL, when set, replaces whatever model the caller asks for.

const BASE_URL = (Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/+$/, "");
const API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const MODEL_OVERRIDE = Deno.env.get("OPENAI_MODEL") || "";
const TIMEOUT_MS = Number(Deno.env.get("OPENAI_TIMEOUT_MS") || 60_000);
const IS_OPENAI = /(^|\.)openai\.com$/.test(new URL(BASE_URL).hostname);

export class OpenAI {
  chat = {
    completions: {
      create: async (body: Record<string, any>): Promise<any> => {
        if (IS_OPENAI && !API_KEY) throw new Error("AI replies need OPENAI_API_KEY (or OPENAI_BASE_URL pointing at Ollama)");
        const req: Record<string, any> = { ...body, stream: false };
        if (MODEL_OVERRIDE) req.model = MODEL_OVERRIDE;
        // Ollama and most other OpenAI-compatible servers read max_tokens.
        if (!IS_OPENAI && req.max_completion_tokens !== undefined && req.max_tokens === undefined) {
          req.max_tokens = req.max_completion_tokens;
          delete req.max_completion_tokens;
        }
        const res = await fetch(`${BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
          },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`AI request failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
        return await res.json();
      },
    },
  };
}

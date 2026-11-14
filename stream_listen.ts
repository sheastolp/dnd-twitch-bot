// Hearing the streamer, the way UndercoverBurn does (its stream_audio.ts):
// while a channel is live, its Twitch audio is pulled with streamlink,
// turned into 16 kHz mono PCM by ffmpeg, cut into utterances where the
// streamer pauses (vad.ts) and sent to a speech-to-text endpoint.
//
// GuildScribe only listens for one thing: the streamer saying "that was
// stupid", "I'm stupid" or "that was worthy of one". Each time, the shot counter (shots.ts) goes up
// by one and chat is told. What was heard is kept in memory only (the
// newest LOG_MAX lines, lost on restart, never in the database) for the
// operator page /admin/listen (listen_page.ts), like UndercoverBurn's /logs.
//
// Per channel it's the "Count a shot when you say…" option on the Shot
// counter card (shots.listen), and it only runs while the shots switch is on
// and the channel is live. syncStreamListening (server.ts, every 30 s)
// starts and stops captures.
//
// Needs on the host: `streamlink` and `ffmpeg` on PATH, and Deno started
// with --allow-run=streamlink,ffmpeg (deno task start does). Transcription
// is any OpenAI-compatible /audio/transcriptions endpoint:
//   - OpenAI (default): TRANSCRIBE_API_KEY, or OPENAI_API_KEY when that's
//     unset. OPENAI_BASE_URL is NOT used here: Ollama can't transcribe.
//   - A local Whisper server (speaches / faster-whisper-server):
//     TRANSCRIBE_BASE_URL=http://<host>:<port>/v1, TRANSCRIBE_MODEL=<model>.

import { sqlite } from "./sqlite.ts";
import { sendChatMessage } from "./twitch.ts";
import { isCommandGroupEnabled } from "./db.ts";
import { optWord } from "./channel_options.ts";
import { adjustShots, shotWords } from "./shots.ts";
import { pick } from "./utils.ts";
import { SAMPLE_RATE, type Segment, SpeechSegmenter } from "./vad.ts";

const OPENAI_URL = "https://api.openai.com/v1";
const BASE_URL = (Deno.env.get("TRANSCRIBE_BASE_URL") || OPENAI_URL).replace(/\/+$/, "");
const IS_OPENAI = /(^|\.)openai\.com$/.test(new URL(BASE_URL).hostname);
const API_KEY = Deno.env.get("TRANSCRIBE_API_KEY") || (IS_OPENAI ? Deno.env.get("OPENAI_API_KEY") || "" : "");
const MODEL = Deno.env.get("TRANSCRIBE_MODEL") || (IS_OPENAI ? "gpt-4o-mini-transcribe" : "Systran/faster-whisper-small");
// e.g. "en"; unset lets the model work it out.
const LANGUAGE = Deno.env.get("TRANSCRIBE_LANGUAGE") || "";
const STREAMLINK = Deno.env.get("STREAMLINK_PATH") || "streamlink";
const FFMPEG = Deno.env.get("FFMPEG_PATH") || "ffmpeg";

// Utterances waiting for the transcriber are sent together, up to this long.
const BATCH_BYTES = 20 * SAMPLE_RATE * 2;
// Silence put between utterances sent together in one request.
const BATCH_GAP = new Uint8Array((SAMPLE_RATE / 4) * 2);
// Requests to the transcriber in flight at once per channel.
const PARALLEL = 2;
// The end of the previous line is sent as the prompt, so a phrase cut in two
// at a pause still reads right.
const PROMPT_CONTEXT_CHARS = 200;
// One shot per this long, at most: the same words can come back from two
// overlapping chunks, and saying it twice in one breath is one shot.
const SHOT_COOLDOWN_MS = 15_000;
// A capture that dies is restarted after a wait that doubles up to this.
const MAX_BACKOFF_MS = 5 * 60_000;
// A capture that ran this long counts as healthy and resets the wait.
const HEALTHY_RUN_MS = 2 * 60_000;

/** The phrases, matched against the transcript lowercased with punctuation
 * dropped: "That was stupid.", "that was so stupid", "I'm stupid",
 * "im stupid", "I am stupid", "That was worthy of one", "that's worthy of
 * one", "that was worthy of a shot" (Whisper may write "one" as "1"). */
const PHRASES: { re: RegExp; said: string }[] = [
  { re: /\bthat was (?:so |really |pretty |just )?stupid\b/, said: "that was stupid" },
  { re: /\bi(?: ?m| am) (?:so |really |just )?stupid\b/, said: "I'm stupid" },
  { re: /\bthat(?:s| was| is) (?:so |totally |definitely |really )?worthy of (?:one|1|a shot)\b/, said: "that was worthy of one" },
];

/** Which phrase a transcript line contains, or null. */
export function heardPhrase(text: string): string | null {
  const norm = text.toLowerCase().replace(/[’‘`]/g, "'").replace(/'/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  for (const p of PHRASES) if (p.re.test(norm)) return p.said;
  return null;
}

const HEARD_LINES = [
  (said: string, n: string) => `🥃 GuildScribe heard "${said}" — that's a shot! ${n} this stream.`,
  (said: string, n: string) => `🥃 "${said}," says the streamer. The barkeep pours one: ${n} this stream.`,
  (said: string, n: string) => `🥃 The scribe overheard "${said}" and wrote it in the ledger. ${n} and counting.`,
];

// Lines Whisper-style models make up from music or near-silence.
const HALLUCINATIONS = [
  /^(thank you|thanks)( so much)? for watching[.!]*$/i,
  /subtitles? (by|from)|amara\.org|transcribed by|captions? by/i,
];

type Capture = { login: string; startedAt: number; abort: AbortController };

const captures = new Map<string, Capture>();
const retries = new Map<string, { at: number; backoffMs: number }>();
const lastShotAt = new Map<string, number>();
// Set when streamlink/ffmpeg can't be run at all; tried again after a while.
let unavailableUntil = 0;
let warnedNoKey = false;
// Shared by every channel (one endpoint): consecutive failures pause
// attempts for a growing wait, logged once per pause.
const health = { failures: 0, lastError: "", pausedUntil: 0 };

// ── The listen log (/admin/listen) ──

export type ListenLogKind = "said" | "shot" | "cooldown" | "status" | "error";
export type ListenLogLine = { ts: number; login: string; kind: ListenLogKind; text: string };
const LOG_MAX = 2000;
const listenLog: ListenLogLine[] = [];
export const LISTEN_LOG_MAX = LOG_MAX;
export const listenLogStartedAt = Date.now();

/** Logs to the console (journalctl) and keeps the line for /admin/listen. */
export function note(kind: ListenLogKind, login: string, text: string) {
  const line = `[listen] ${login ? `${login}: ` : ""}${text}`;
  if (kind === "error") console.error(line);
  else console.log(line);
  listenLog.push({ ts: Date.now(), login, kind, text: text.slice(0, 2000) });
  if (listenLog.length > LOG_MAX) listenLog.splice(0, listenLog.length - LOG_MAX);
}

/** The kept lines, oldest first. */
export function getListenLog(): readonly ListenLogLine[] {
  return listenLog;
}

/** What's being listened to right now and how the transcriber is doing. */
export function getListenStatus() {
  return {
    host: IS_OPENAI ? "OpenAI" : new URL(BASE_URL).host,
    model: MODEL,
    hasKey: !IS_OPENAI || !!API_KEY,
    unavailableUntil,
    captures: [...captures.values()].map((c) => ({ login: c.login, startedAt: c.startedAt })),
    retries: [...retries.entries()].map(([id, r]) => ({ broadcasterId: id, at: r.at })),
    failures: health.failures,
    lastError: health.lastError,
    pausedUntil: health.pausedUntil,
  };
}

/** Whether this channel wants listening right now (live, shots on, shots.listen on). */
async function wantsListening(broadcasterId: string): Promise<boolean> {
  if (!(await isCommandGroupEnabled(broadcasterId, "shots"))) return false;
  return (await optWord(broadcasterId, "shots.listen")) === "on";
}

/** Logins being listened to right now. */
export function activeListeners(): string[] {
  return [...captures.values()].map((c) => c.login);
}

/** Starts a capture for each live channel that wants one and stops the rest. */
export async function syncStreamListening(): Promise<void> {
  const want = new Map<string, string>();
  const { rows } = await sqlite.execute(
    `SELECT broadcaster_id, login FROM broadcasters WHERE is_live = 1 AND connected = 1 AND login IS NOT NULL`,
  );
  for (const r of rows as any[]) {
    const id = String(r.broadcaster_id);
    try {
      if (await wantsListening(id)) want.set(id, String(r.login).toLowerCase());
    } catch { /* checked again next tick */ }
  }

  for (const [id, cap] of captures) {
    if (!want.has(id)) {
      note("status", cap.login, "stopping (offline or switched off).");
      cap.abort.abort();
      captures.delete(id);
    }
  }
  for (const id of retries.keys()) if (!want.has(id)) retries.delete(id);
  if (!want.size) return;

  if (IS_OPENAI && !API_KEY) {
    if (!warnedNoKey) {
      note("error", "", "Not listening: set TRANSCRIBE_API_KEY or OPENAI_API_KEY, or TRANSCRIBE_BASE_URL for a local Whisper server.");
      warnedNoKey = true;
    }
    return;
  }
  if (Date.now() < unavailableUntil) return;

  for (const [id, login] of want) {
    if (captures.has(id)) continue;
    const retry = retries.get(id);
    if (retry && Date.now() < retry.at) continue;
    startCapture(id, login);
  }
}

function startCapture(broadcasterId: string, login: string) {
  const abort = new AbortController();
  const cap: Capture = { login, startedAt: Date.now(), abort };
  captures.set(broadcasterId, cap);
  note("status", login, `listening (${IS_OPENAI ? "OpenAI" : new URL(BASE_URL).host}, ${MODEL}).`);
  runCapture(broadcasterId, login, abort.signal)
    .catch((err) => {
      const e = err as Error;
      if (e.name === "NotFound" || e.name === "NotCapable" || e.name === "PermissionDenied") {
        note(
          "error",
          login,
          `Can't run ${STREAMLINK}/${FFMPEG} (${e.message}). Install streamlink and ffmpeg and start Deno with --allow-run=streamlink,ffmpeg. Trying again in 10 min.`,
        );
        unavailableUntil = Date.now() + 10 * 60_000;
      } else if (!abort.signal.aborted) {
        note("error", login, `capture failed: ${e.message}`);
      }
    })
    .finally(() => {
      if (captures.get(broadcasterId) !== cap) return; // stopped on purpose
      captures.delete(broadcasterId);
      if (Date.now() < unavailableUntil) return;
      const prev = retries.get(broadcasterId)?.backoffMs ?? 0;
      const backoffMs = Date.now() - cap.startedAt > HEALTHY_RUN_MS ? 15_000 : Math.min(MAX_BACKOFF_MS, Math.max(15_000, prev * 2));
      retries.set(broadcasterId, { at: Date.now() + backoffMs, backoffMs });
      note("status", login, `capture ended, retrying in ${Math.round(backoffMs / 1000)}s.`);
    });
}

async function runCapture(broadcasterId: string, login: string, signal: AbortSignal) {
  const streamlink = new Deno.Command(STREAMLINK, {
    args: ["--stdout", "--loglevel", "error", "--twitch-low-latency", `https://www.twitch.tv/${login}`, "audio_only,worst"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).spawn();
  const ffmpeg = new Deno.Command(FFMPEG, {
    args: [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn",
      // Cut rumble below the voice and hiss above it.
      "-af", "highpass=f=80,lowpass=f=7600",
      "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).spawn();

  logStderr(`${login} streamlink`, streamlink.stderr);
  logStderr(`${login} ffmpeg`, ffmpeg.stderr);
  streamlink.stdout.pipeTo(ffmpeg.stdin).catch(() => {});

  // Utterances go to the transcriber as soon as they end, a couple at a
  // time; when it falls behind, waiting ones are sent together. Lines are
  // checked strictly in the order they were said.
  const pending: Segment[] = [];
  let inFlight = 0;
  let nextSeq = 0;
  let nextCheck = 0;
  const results = new Map<number, string | null>();
  let lastText = "";
  let chain = Promise.resolve();
  let idle: (() => void) | null = null;

  const checkReady = () => {
    while (results.has(nextCheck)) {
      const raw = results.get(nextCheck)!;
      results.delete(nextCheck);
      nextCheck++;
      if (raw === null) continue;
      const text = cleanTranscript(raw);
      if (!text) continue;
      lastText = text;
      chain = chain.then(() => onLine(broadcasterId, login, text)).catch((e) =>
        note("error", login, `counting the shot failed: ${(e as Error).message}`)
      );
    }
  };
  const pump = () => {
    while (inFlight < PARALLEL && pending.length) {
      const batch: Uint8Array[] = [pending.shift()!.pcm];
      let size = batch[0].byteLength;
      while (pending.length && size + BATCH_GAP.byteLength + pending[0].pcm.byteLength <= BATCH_BYTES) {
        batch.push(BATCH_GAP, pending.shift()!.pcm);
        size += BATCH_GAP.byteLength + batch[batch.length - 1].byteLength;
      }
      const pcm = batch.length === 1 ? batch[0] : concat(batch, size);
      const seq = nextSeq++;
      inFlight++;
      transcribeSegment(login, pcm, lastText)
        .then((raw) => results.set(seq, raw))
        .finally(() => {
          inFlight--;
          checkReady();
          pump();
          if (!inFlight && !pending.length) idle?.();
        });
    }
  };
  const segmenter = new SpeechSegmenter((seg) => {
    pending.push(seg);
    pump();
  });

  for await (const data of ffmpeg.stdout) segmenter.push(data);
  segmenter.flush();
  if (inFlight || pending.length) await new Promise<void>((resolve) => (idle = resolve));
  await chain;
  await Promise.allSettled([streamlink.status, ffmpeg.status]);
}

/** One transcribed line: a shot if it holds a phrase (and the cooldown's over). */
async function onLine(broadcasterId: string, login: string, text: string) {
  note("said", login, text);
  const said = heardPhrase(text);
  if (!said) return;
  const now = Date.now();
  if (now - (lastShotAt.get(broadcasterId) ?? 0) < SHOT_COOLDOWN_MS) {
    note("cooldown", login, `heard "${said}" again within ${SHOT_COOLDOWN_MS / 1000}s — not counted.`);
    return;
  }
  // Switched off mid-stream: the capture stops on the next sync, but don't count meanwhile.
  if (!(await wantsListening(broadcasterId))) return;
  lastShotAt.set(broadcasterId, now);
  const [n, w] = await Promise.all([adjustShots(broadcasterId, 1), shotWords(broadcasterId)]);
  const total = `${n} ${n === 1 ? w.one : w.many}`;
  note("shot", login, `heard "${said}" — +1, ${total} this stream.`);
  await sendChatMessage(pick(HEARD_LINES)(said, total), broadcasterId);
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function logStderr(label: string, stream: ReadableStream<Uint8Array>) {
  try {
    const decoder = new TextDecoder();
    for await (const bytes of stream) {
      const t = decoder.decode(bytes, { stream: true }).trim();
      if (t) note("error", label.split(" ")[0], `${label.split(" ").slice(1).join(" ")}: ${t.slice(0, 300)}`);
    }
  } catch { /* process ended */ }
}

function wav(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** How long to stop attempting transcription after `failures` in a row. */
function pauseMs(failures: number): number {
  if (failures < 3) return 0;
  return [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000][Math.min(failures - 3, 3)];
}

async function transcribeSegment(login: string, pcm: Uint8Array, prev: string): Promise<string | null> {
  if (Date.now() < health.pausedUntil) return null;
  try {
    const raw = await transcribe(pcm, login, prev);
    if (health.failures > 0) {
      note("status", "", "Transcription is working again.");
      health.failures = 0;
      health.pausedUntil = 0;
    }
    return raw;
  } catch (err) {
    health.failures++;
    health.lastError = (err as Error).message;
    const pause = pauseMs(health.failures);
    if (pause > 0) {
      health.pausedUntil = Date.now() + pause;
      note(
        "error",
        "",
        `Transcription keeps failing (${health.lastError}). Pausing for ~${Math.round(pause / 60_000)} min — check TRANSCRIBE_BASE_URL, TRANSCRIBE_MODEL and the API key.`,
      );
    } else {
      note("error", login, `transcription failed: ${health.lastError}`);
    }
    return null;
  }
}

function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const t = text.slice(-max);
  const sp = t.indexOf(" ");
  return sp >= 0 ? t.slice(sp + 1) : t;
}

async function transcribe(pcm: Uint8Array, login: string, prev: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([wav(pcm)], { type: "audio/wav" }), "chunk.wav");
  form.append("model", MODEL);
  form.append("response_format", "json");
  // Greedy decoding: fewer invented lines, and the same audio reads the same.
  form.append("temperature", "0");
  if (LANGUAGE) form.append("language", LANGUAGE);
  // The phrases are left out of the prompt on purpose: Whisper can echo its
  // prompt back over silence, and that would pour a shot nobody earned.
  const context = tail(prev, PROMPT_CONTEXT_CHARS);
  form.append("prompt", `Twitch stream by ${login}.${context ? ` ${context}` : ""}`);
  const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return String((await res.json())?.text ?? "");
}

/** The line with made-up sentences dropped ("" when nothing real is left). */
export function cleanTranscript(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim() && !HALLUCINATIONS.some((re) => re.test(s.trim())))
    .join(" ")
    .trim();
}

// Voice-activity segmentation for the stream audio (stream_listen.ts),
// copied from UndercoverBurn's vad.ts.
//
// The audio is cut where the streamer pauses: 30 ms frames are classed as
// speech when they stand out above a running noise floor, an utterance
// starts at a short run of speech frames (with a little audio from just
// before it, so the first syllable isn't clipped) and ends at the first
// pause of END_SILENCE_MS. So a short phrase goes off to be transcribed
// well under a second after the streamer stops talking, and each request is
// one utterance with no long stretches of silence or game noise around it.
// A long monologue is still cut at MAX_SEGMENT_SECONDS, at the quietest
// moment near the end, so nothing waits on it.

// A 30 ms frame is speech when it's at least SILENCE_RMS (RMS of 16-bit
// samples) AND NOISE_RATIO times the running noise floor.
const SILENCE_RMS = 120;
const NOISE_RATIO = 1.8;
// A pause this long ends an utterance.
const END_SILENCE_MS = 600;
// Less speech than this is a click or a bump, not a word.
const MIN_SPEECH_MS = 240;
// Nonstop talking is cut at this length anyway.
const MAX_SEGMENT_SECONDS = 12;

export const SAMPLE_RATE = 16000;
export const FRAME_MS = 30;
export const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS / 1000) * 2;

const frames = (ms: number) => Math.max(1, Math.round(ms / FRAME_MS));
// Audio kept from before the speech started.
const PREROLL_FRAMES = frames(300);
// Silence kept after the last word.
const TAIL_FRAMES = frames(240);
// Speech starts when this many of the last ONSET_WINDOW frames are
// speech: one loud click isn't a word.
const ONSET_FRAMES = 3;
const ONSET_WINDOW = 5;
// Quiet frames inside an utterance before it's over.
const END_FRAMES = frames(END_SILENCE_MS);
const MAX_FRAMES = frames(MAX_SEGMENT_SECONDS * 1000);
// A forced cut (MAX_FRAMES) is made at the quietest frame in this last
// stretch of the segment.
const CUT_SEARCH_FRAMES = frames(3000);
const MIN_SPEECH_FRAMES = frames(MIN_SPEECH_MS);
// The noise floor is a low percentile of frame loudness over the
// last few seconds ("minimum statistics"): even nonstop talking has
// gaps between words, so this tracks the background (game audio,
// music, fans) and not the voice, and it catches up within about a
// second when the background jumps or the stream starts.
const FLOOR_WINDOW = frames(4000);
const FLOOR_PERCENTILE = 0.2;
const FLOOR_MIN = 20;

// Loudness of 16-bit PCM, 0..32768.
export function rms(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let sum = 0;
  const n = pcm.byteLength >> 1;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true);
    sum += s * s;
  }
  return Math.sqrt(sum / Math.max(1, n));
}

export type Segment = {
  pcm: Uint8Array;
  // How much of it was classed as speech, in ms.
  speechMs: number;
  // Cut because it ran long, not at a pause (more is coming).
  forced: boolean;
};

type Frame = { pcm: Uint8Array; rms: number; speech: boolean };

export class SpeechSegmenter {
  private partial = new Uint8Array(FRAME_BYTES);
  private partialFill = 0;
  private floor = 0;
  private history: number[] = [];
  private recent: boolean[] = [];
  private preroll: Frame[] = [];
  private seg: Frame[] | null = null;
  private quietRun = 0;

  constructor(private emit: (seg: Segment) => void) {}

  // The current noise floor estimate (RMS), for logs and tests.
  get noiseFloor(): number {
    return this.floor;
  }

  push(data: Uint8Array) {
    let off = 0;
    while (off < data.length) {
      const n = Math.min(data.length - off, FRAME_BYTES - this.partialFill);
      this.partial.set(data.subarray(off, off + n), this.partialFill);
      this.partialFill += n;
      off += n;
      if (this.partialFill === FRAME_BYTES) {
        this.frame(this.partial.slice());
        this.partialFill = 0;
      }
    }
  }

  // The stream ended: send whatever utterance was in progress.
  flush() {
    if (this.seg) this.finish(this.seg.length, false);
    this.seg = null;
  }

  private isSpeech(r: number): boolean {
    return r >= Math.max(SILENCE_RMS, this.floor * NOISE_RATIO);
  }

  private frame(pcm: Uint8Array) {
    const r = rms(pcm);
    this.history.push(r);
    if (this.history.length > FLOOR_WINDOW) this.history.shift();
    const sorted = [...this.history].sort((x, y) => x - y);
    this.floor = Math.max(
      FLOOR_MIN,
      sorted[Math.floor((sorted.length - 1) * FLOOR_PERCENTILE)],
    );
    const speech = this.isSpeech(r);

    const f: Frame = { pcm, rms: r, speech };
    this.recent.push(speech);
    if (this.recent.length > ONSET_WINDOW) this.recent.shift();

    if (!this.seg) {
      this.preroll.push(f);
      if (this.preroll.length > PREROLL_FRAMES + ONSET_WINDOW) this.preroll.shift();
      if (this.recent.filter(Boolean).length >= ONSET_FRAMES) {
        this.seg = this.preroll;
        this.preroll = [];
        this.quietRun = 0;
      }
      return;
    }

    this.seg.push(f);
    this.quietRun = speech ? 0 : this.quietRun + 1;
    if (this.quietRun >= END_FRAMES) {
      // The pause is over-long by definition; keep a short tail.
      this.finish(this.seg.length - this.quietRun + TAIL_FRAMES, false);
      this.seg = null;
      this.recent = [];
      return;
    }
    if (this.seg.length >= MAX_FRAMES) {
      // Cut at the quietest frame near the end; the rest carries on.
      let cut = this.seg.length;
      let best = Infinity;
      for (let i = this.seg.length - CUT_SEARCH_FRAMES; i < this.seg.length; i++) {
        if (this.seg[i].rms < best) {
          best = this.seg[i].rms;
          cut = i + 1;
        }
      }
      const rest = this.seg.slice(cut);
      this.finish(cut, true);
      this.seg = rest;
    }
  }

  // Sends the first `n` frames of the current segment, if it held
  // enough speech to be worth transcribing.
  private finish(n: number, forced: boolean) {
    const seg = this.seg!.slice(0, Math.min(n, this.seg!.length));
    const speechFrames = seg.filter((f) => f.speech).length;
    if (speechFrames < MIN_SPEECH_FRAMES) return;
    const pcm = new Uint8Array(seg.length * FRAME_BYTES);
    seg.forEach((f, i) => pcm.set(f.pcm, i * FRAME_BYTES));
    this.emit({ pcm, speechMs: speechFrames * FRAME_MS, forced });
  }
}

// GuildScribe — Wild Shape by the 2024 (5.5e) Player's Handbook, and the
// 2024 Monster Manual beasts to shift into. No chat or database here (see
// wildshape.ts), so the rules can be tested on their own.
//
// The rules, as the 2024 Druid has them:
//   Uses        2 (L2), 3 (L6), 4 (L17); one back on a Short Rest, all on a Long Rest.
//               Wild Resurgence (L5): with none left, a spell slot buys one.
//   Duration    hours equal to half your Druid level (round down).
//   Beast Shapes  L2: CR 1/4, no Fly speed, 4 known forms
//                 L4: CR 1/2, no Fly speed, 6 known forms
//                 L8: CR 1, Fly speed allowed, 8 known forms
//               Swap one known form after each Long Rest.
//   In the form   Temporary HP equal to your Druid level. You keep your HP,
//               Hit Dice, INT/WIS/CHA, class features, languages, feats, and
//               your skill and save proficiencies (with your Proficiency
//               Bonus); a higher modifier in the beast's stat block wins.
//               Everything else (STR/DEX/CON, AC, speeds, senses, traits,
//               actions) is the beast's. No spellcasting, but Concentration
//               holds.
//   Circle of the Moon (L3+)  Circle Forms: max CR is Druid level ÷ 3
//               (round down, at least 1), AC is at least 13 + WIS, and the
//               Temporary HP are 3 × Druid level. Improved Circle Forms (L6):
//               attacks may deal Radiant damage, and add WIS to CON saves.
//               Lunar Form (L14): +2d10 Radiant once a turn on a hit.

import type { Ability, BeastAttack, Character, WildForm } from "./types.ts";
import { flattenEntries, stripTags } from "./fivetools.ts";
import { modifier } from "./utils.ts";

/** Base URL of the 5etools 2024 `data/` folder (the 2024 Monster Manual is XMM). */
const DATA_URL = (Deno.env.get("FIVETOOLS_2024_DATA_URL") ||
  "https://raw.githubusercontent.com/5etools-mirror-3/5etools-src/main/data").replace(/\/+$/, "");
const SITE_URL = "https://5e.tools";
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

export const CIRCLES = ["land", "moon", "sea", "stars"] as const;
export type Circle = typeof CIRCLES[number];

/** A druid's Wild Shape numbers at their level (and circle). */
export type ShapeLimits = {
  uses: number;
  known: number;
  maxCr: number;
  fly: boolean;
  hours: number;
  tempHp: number;
  moon: boolean;
  /** Wild Resurgence: spell slots a druid this level has to trade for uses (0 before L5). */
  slots: number;
};

/** Total spell slots of a full caster, by level (index 0 unused). */
const FULL_CASTER_SLOTS = [0, 2, 3, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22];

export function shapeLimits(level: number, circle: string | null): ShapeLimits {
  const moon = circle === "moon" && level >= 3;
  return {
    uses: level >= 17 ? 4 : level >= 6 ? 3 : 2,
    known: level >= 8 ? 8 : level >= 4 ? 6 : 4,
    maxCr: moon ? Math.max(1, Math.floor(level / 3)) : level >= 8 ? 1 : level >= 4 ? 0.5 : 0.25,
    fly: level >= 8,
    hours: Math.floor(level / 2),
    tempHp: moon ? 3 * level : level,
    moon,
    slots: level >= 5 ? FULL_CASTER_SLOTS[Math.min(20, level)] : 0,
  };
}

export function crText(cr: number): string {
  if (cr === 0.125) return "1/8";
  if (cr === 0.25) return "1/4";
  if (cr === 0.5) return "1/2";
  return String(cr);
}

// ---------------------------------------------------------------------------
// Beasts
// ---------------------------------------------------------------------------

export type Beast = {
  name: string;
  key: string;
  cr: number;
  data: any;
};

export const comparable = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function crValue(cr: unknown): number {
  const raw = typeof cr === "object" && cr ? (cr as any).cr : cr;
  const [a, b] = String(raw ?? "").split("/").map(Number);
  return b ? a / b : Number.isFinite(a) ? a : NaN;
}

const isBeast = (m: any) => (typeof m?.type === "string" ? m.type : m?.type?.type) === "beast";

/** Beasts from a 5etools bestiary file, skipping any without a CR. */
export function beastsFrom(file: any): Beast[] {
  return (Array.isArray(file?.monster) ? file.monster : [])
    .filter((m: any) => m?.name && isBeast(m) && Number.isFinite(crValue(m.cr)))
    .map((m: any) => ({ name: m.name, key: comparable(m.name), cr: crValue(m.cr), data: m }));
}

let cache: { at: number; promise: Promise<Beast[]> } | null = null;

/** The 2024 Monster Manual's beasts, downloaded once a day. */
export function loadBeasts(): Promise<Beast[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.promise;
  const slot = {
    at: Date.now(),
    promise: fetch(`${DATA_URL}/bestiary/bestiary-xmm.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      .then((res) => {
        if (!res.ok) throw new Error(`5etools 2024 bestiary: HTTP ${res.status}`);
        return res.json();
      })
      .then((file) => {
        const beasts = beastsFrom(file);
        if (!beasts.length) throw new Error("5etools 2024 bestiary: no beasts");
        return beasts;
      }),
  };
  slot.promise.catch((e) => {
    console.error("wild shape beasts load failed", e);
    if (cache === slot) cache = null;
  });
  cache = slot;
  return slot.promise;
}

/** One beast by name, or the near matches when the name is ambiguous. */
export function findBeast(beasts: Beast[], query: string): { beast?: Beast; options: Beast[] } {
  const wanted = comparable(query);
  if (!wanted) return { options: [] };
  const exact = beasts.find((b) => b.key === wanted);
  if (exact) return { beast: exact, options: [] };
  // Plurals and "a wolf": "wolves" → "wolf" is beyond this, but "giant spiders" isn't.
  const singular = wanted.replace(/s$/, "");
  const exactish = beasts.find((b) => b.key === singular);
  if (exactish) return { beast: exactish, options: [] };
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const partial = beasts.filter((b) =>
    b.key.includes(wanted) || (words.length && words.every((w) => b.name.toLowerCase().includes(w)))
  );
  return partial.length === 1 ? { beast: partial[0], options: [] } : { options: partial };
}

export const flySpeed = (m: any): number => {
  const fly = m?.speed?.fly;
  return typeof fly === "number" ? fly : Number(fly?.number ?? 0);
};

/** Why `b` isn't a form this druid can take (null = it is). */
export function ineligibleReason(b: Beast, limits: ShapeLimits, level: number): string | null {
  if (b.cr > limits.maxCr) {
    // Circle Forms: CR = level ÷ 3, so CR n opens at level 3n.
    const next = limits.moon
      ? `Circle Forms reach CR ${crText(b.cr)} at Druid level ${3 * Math.ceil(b.cr)}`
      : b.cr <= 0.5 ? "CR 1/2 opens at Druid level 4" : b.cr <= 1 ? "CR 1 opens at Druid level 8" : "only Circle of the Moon druids go above CR 1";
    return `the ${b.name} is CR ${crText(b.cr)}, above your limit of CR ${crText(limits.maxCr)} (${next})`;
  }
  if (!limits.fly && flySpeed(b.data) > 0) {
    return `the ${b.name} has a Fly speed, and Wild Shape allows flying forms from Druid level 8 (you're ${level})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The form's game statistics
// ---------------------------------------------------------------------------

const ABILITIES: Ability[] = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];
const PHYSICAL = new Set<Ability>(["STR", "DEX", "CON"]);
const SIZES: Record<string, string> = { T: "Tiny", S: "Small", M: "Medium", L: "Large", H: "Huge", G: "Gargantuan" };
/** The Druid's saving throw proficiencies. */
const DRUID_SAVES = new Set<Ability>(["INT", "WIS"]);

const signed = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n)}`;

/** 2024 stat-block markup that the 2014 tag renderer doesn't know. */
function plain(text: string): string {
  return stripTags(
    String(text)
      .replace(/\{@atkr\s+m\}/g, "Melee Attack Roll:")
      .replace(/\{@atkr\s+r\}/g, "Ranged Attack Roll:")
      .replace(/\{@atkr\s+m,r\}/g, "Melee or Ranged Attack Roll:")
      .replace(/\{@actSave\s+(\w+)\}/g, (_m, ab) => `${String(ab).toUpperCase()} Saving Throw:`)
      .replace(/\{@actSaveFail\s+(\d+)\}/g, "Failure by $1 or more:")
      .replace(/\{@actSaveFail\}/g, "Failure:")
      .replace(/\{@actSaveSuccess\}/g, "Success:")
      .replace(/\{@actSaveSuccessOrFail\}/g, "Failure or Success:")
      .replace(/\{@actTrigger\}/g, "Trigger:")
      .replace(/\{@actResponse\}/g, "Response:"),
  );
}

/** "Bite +4 (1d6+2 piercing)", or a short line for anything that isn't an attack. */
export function actionSummary(a: any): string {
  const name = stripTags(a?.name ?? "");
  const raw = JSON.stringify(a?.entries ?? []);
  const hit = raw.match(/\{@hit\s+([+-]?\d+)\}/);
  const damage = [...raw.matchAll(/\{@damage\s+([^}|]+)\}\)\s*([A-Za-z]+) damage/g)]
    .map((m) => `${m[1].replace(/\s+/g, "")} ${m[2].toLowerCase()}`);
  const dc = raw.match(/\{@dc\s+(\d+)\}/);
  if (hit) return `${name} ${signed(Number(hit[1]))}${damage.length ? ` (${damage.join(" + ")})` : ""}`;
  if (dc) return `${name} (DC ${dc[1]}${damage.length ? `, ${damage.join(" + ")}` : ""})`;
  const text = flattenEntries((a?.entries ?? []).map((e: any) => (typeof e === "string" ? plain(e) : e)));
  return `${name}: ${text.length > 90 ? `${text.slice(0, 87).trimEnd()}…` : text.replace(/\.$/, "")}`;
}

export type FormStats = {
  name: string;
  link: string;
  cr: number;
  size: string;
  ac: number;
  acNote: string;
  tempHp: number;
  speed: string;
  scores: Record<Ability, number>;
  saves: Record<Ability, number>;
  skills: string[];
  senses: string[];
  traits: string[];
  actions: string[];
  notes: string[];
};

/** The druid's game statistics in this beast's form, by the 2024 rules. */
export function formStats(c: Character, b: Beast, circle: string | null): FormStats {
  const m = b.data;
  const limits = shapeLimits(c.level, circle);
  const wis = modifier(Number(c.scores.WIS ?? 10));
  const pb = Number(c.proficiency ?? 2);

  const ac0 = Array.isArray(m.ac) ? m.ac[0] : m.ac;
  const beastAc = Number(typeof ac0 === "number" ? ac0 : ac0?.ac ?? 10);
  const moonAc = 13 + wis;
  const ac = limits.moon ? Math.max(beastAc, moonAc) : beastAc;

  const scores = {} as Record<Ability, number>;
  for (const ab of ABILITIES) {
    scores[ab] = PHYSICAL.has(ab) ? Number(m[ab.toLowerCase()] ?? 10) : Number(c.scores[ab] ?? 10);
  }
  // Your save proficiencies (with your Proficiency Bonus) carry over; the
  // stat block's own save wins when it's higher.
  const saves = {} as Record<Ability, number>;
  for (const ab of ABILITIES) {
    let own = modifier(scores[ab]) + (DRUID_SAVES.has(ab) ? pb : 0);
    if (ab === "CON" && limits.moon && c.level >= 6) own += Math.max(0, wis);
    const listed = Number.parseInt(String(m.save?.[ab.toLowerCase()] ?? ""), 10);
    saves[ab] = Number.isFinite(listed) ? Math.max(own, listed) : own;
  }

  const speed = Object.entries(m.speed ?? {})
    .map(([mode, v]) => {
      const n = typeof v === "number" ? v : (v as any)?.number;
      return typeof n === "number" ? (mode === "walk" ? `${n} ft.` : `${mode} ${n} ft.`) : "";
    })
    .filter(Boolean)
    .join(", ");

  const notes: string[] = [];
  if (limits.moon) {
    notes.push(c.level >= 6 ? "Moon: attacks can deal Radiant damage; can cast Circle of the Moon spells" : "Moon: can cast Circle of the Moon spells");
    if (c.level >= 14) notes.push("Lunar Form: +2d10 Radiant once a turn on a hit");
  }
  notes.push(limits.moon ? "no other spellcasting (Concentration holds)" : "no spellcasting (Concentration holds)");

  const type = typeof m.type === "object" && m.type?.swarmSize ? `swarm of ${SIZES[m.type.swarmSize] ?? ""} beasts` : "beast";
  return {
    name: b.name,
    link: `${SITE_URL}/bestiary.html#${encodeURIComponent(b.name.toLowerCase())}_xmm`,
    cr: b.cr,
    size: `${SIZES[m.size?.[0]] ?? ""} ${type}`.trim(),
    ac,
    acNote: limits.moon && moonAc > beastAc ? " (Circle Forms: 13 + WIS)" : "",
    tempHp: limits.tempHp,
    speed,
    scores,
    saves,
    skills: Object.entries(m.skill ?? {}).map(([k, v]) => `${k.charAt(0).toUpperCase()}${k.slice(1)} ${String(v).replace(/^\+?/, "+")}`),
    senses: [...(m.senses ?? []).map((s: string) => plain(s)), ...(m.passive ? [`passive Perception ${m.passive}`] : [])],
    traits: (m.trait ?? []).map((t: any) => stripTags(t?.name ?? "")).filter(Boolean),
    actions: [...(m.action ?? []), ...(m.bonus ?? []).map((a: any) => ({ ...a, name: `${a.name} (bonus)` }))]
      .map(actionSummary),
    notes,
  };
}

/** The form in one chat-sized line. */
export function formLine(s: FormStats): string {
  const sc = (ab: Ability) => `${ab} ${s.scores[ab]}`;
  const sv = ABILITIES.map((ab) => `${ab} ${signed(s.saves[ab])}`).join(" ");
  return [
    `${s.name} (CR ${crText(s.cr)} ${s.size})`,
    `AC ${s.ac}${s.acNote}`,
    `Speed ${s.speed || "0 ft."}`,
    `${sc("STR")} ${sc("DEX")} ${sc("CON")} (INT/WIS/CHA stay yours)`,
    `Saves ${sv}`,
    [...s.skills, ...s.senses].join(", "),
    s.traits.length ? `Traits: ${s.traits.join(", ")}` : "",
    `Actions: ${s.actions.join("; ")}`,
    s.notes.join("; "),
  ].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// The form in a fight
// ---------------------------------------------------------------------------

const COUNTS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };

/** An attack-roll action as numbers, e.g. Bite +4, 1d6 + 2 Piercing. Null for anything else. */
export function beastAttack(a: any): BeastAttack | null {
  const raw = JSON.stringify(a?.entries ?? []);
  const hit = raw.match(/\{@hit\s+([+-]?\d+)\}/);
  // "{@h}5 ({@damage 1d6 + 2}) Piercing damage", or a flat "{@h}1 Slashing damage".
  const dmg = raw.match(/\{@h\}(\d+)(?:\s*\(\{@damage\s+(\d+)d(\d+)\s*(?:([+-])\s*(\d+))?\}\))?\s+([A-Za-z]+) damage/);
  if (!hit || !dmg) return null;
  const [, flat, n, sides, sign, plus, type] = dmg;
  const name = stripTags(a?.name ?? "");
  const out: BeastAttack = n
    ? { name, bonus: Number(hit[1]), dice: Number(n), die: Number(sides), mod: plus ? (sign === "-" ? -1 : 1) * Number(plus) : 0, type: type.toLowerCase() }
    : { name, bonus: Number(hit[1]), dice: 0, die: 0, mod: Number(flat), type: type.toLowerCase() };
  // "… Piercing damage plus 7 ({@damage 2d6}) Poison damage": part of every hit.
  const rider = raw.slice((dmg.index ?? 0) + dmg[0].length).match(/^\s*plus \d+ \(\{@damage\s+(\d+)d(\d+)\}\)\s+([A-Za-z]+) damage/);
  if (rider) out.plus = { dice: Number(rider[1]), die: Number(rider[2]), type: rider[3].toLowerCase() };
  return out;
}

const average = (a: BeastAttack) => a.dice * (a.die + 1) / 2 + a.mod + (a.plus ? a.plus.dice * (a.plus.die + 1) / 2 : 0);

/** One turn's attacks: the Multiattack's ("one Bite attack and one Claw
 * attack", "two Rend attacks", "two attacks"), else the best single one. */
export function turnAttacks(m: any): BeastAttack[] {
  const attacks = (m?.action ?? []).map(beastAttack).filter(Boolean) as BeastAttack[];
  if (!attacks.length) return [];
  const best = [...attacks].sort((a, b) => average(b) - average(a))[0];
  const multi = (m.action ?? []).find((a: any) => /^multiattack/i.test(String(a?.name ?? "")));
  if (!multi) return [best];
  const text = (multi.entries ?? []).map((e: any) => (typeof e === "string" ? plain(e) : "")).join(" ").toLowerCase();
  const found: Array<{ at: number; n: number; a: BeastAttack }> = [];
  for (const a of attacks) {
    const name = a.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hit = new RegExp(`\\b(one|two|three|four)\\s+${name}\\s+attacks?`).exec(text);
    if (hit) found.push({ at: hit.index, n: COUNTS[hit[1]], a });
  }
  if (found.length) return found.sort((x, y) => x.at - y.at).flatMap((f) => Array(f.n).fill(f.a));
  const generic = text.match(/(one|two|three|four)\s+attacks/);
  return generic ? Array(COUNTS[generic[1]]).fill(best) : [best];
}

/** What fights need of the form, fixed when the druid shifts. */
export function fightForm(c: Character, b: Beast, circle: string | null): WildForm {
  const s = formStats(c, b, circle);
  return {
    name: b.name,
    ac: s.ac,
    tempHp: s.tempHp,
    moon: shapeLimits(c.level, circle).moon,
    str: s.scores.STR,
    dex: s.scores.DEX,
    con: s.scores.CON,
    attacks: turnAttacks(b.data),
  };
}

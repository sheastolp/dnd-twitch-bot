// GuildScribe — 5e.tools (2014) as a second archive for lookups and the
// bestiary. dnd5eapi.co only carries the SRD; 5e.tools has every official
// 2014 book (Monster Manual, Volo's, Mordenkainen's, Xanathar's, Tasha's…).
//
// 2014.5e.tools itself sits behind a Cloudflare bot challenge, so the data
// comes from its public source mirror on GitHub (the same JSON the site
// renders). Links in chat still point at the 2014.5e.tools pages.
//
// Each dataset is downloaded once, converted into the dnd5eapi shape the
// rest of the bot already reads (formatLookup, formatSpellSections,
// statBlockFromApi, boss_saves), and kept in memory for a day.

/** Base URL of the 5etools 2014 `data/` folder. */
const DATA_URL = (Deno.env.get("FIVETOOLS_DATA_URL") ||
  "https://raw.githubusercontent.com/5etools-mirror-3/5etools-2014-src/main/data").replace(/\/+$/, "");
const SITE_URL = "https://2014.5e.tools";

const DATASET_TTL_MS = 24 * 60 * 60 * 1000;
const FILE_TIMEOUT_MS = 30_000;
/** How long a chat lookup waits on a dataset that is still downloading. */
const LOOKUP_WAIT_MS = 15_000;

type Dataset = "monster" | "spell" | "item" | "feat" | "race";
type Entry = { key: string; name: string; source: string; data: any };

/** Which dataset answers each lookup kind. */
const KIND_DATASET: Record<string, Dataset> = {
  monster: "monster",
  spell: "spell",
  item: "item",
  feat: "feat",
  race: "race",
  subrace: "race",
};

export function fivetoolsSupports(kind: string): boolean {
  return kind in KIND_DATASET;
}

// ---------------------------------------------------------------------------
// Text: 5etools {@tag …} markup and nested entries → plain chat text
// ---------------------------------------------------------------------------

const ATTACK_TYPES: Record<string, string> = {
  mw: "Melee Weapon Attack:",
  rw: "Ranged Weapon Attack:",
  "mw,rw": "Melee or Ranged Weapon Attack:",
  ms: "Melee Spell Attack:",
  rs: "Ranged Spell Attack:",
  "ms,rs": "Melee or Ranged Spell Attack:",
};

function renderTag(tag: string, body: string): string {
  const parts = body.split("|");
  switch (tag) {
    case "atk":
      return ATTACK_TYPES[body.trim()] ?? "Attack:";
    case "hit":
      return /^[+-]/.test(body.trim()) ? body.trim() : `+${body.trim()}`;
    case "h":
      return "Hit: ";
    case "dc":
      return `DC ${parts[0]}`;
    case "recharge":
      return body.trim() ? `(Recharge ${body.trim()}–6)` : "(Recharge 6)";
    case "chance":
      return `${parts[0]}%`;
    case "scaledamage":
    case "scaledice":
      return parts[2] ?? parts[0];
    default:
      // {@item leather armor|phb|leather} shows its third part when present.
      return parts[2] || parts[0];
  }
}

export function stripTags(text: unknown): string {
  let s = String(text ?? "");
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/\{@(\w+)\s*([^{}]*?)\}/g, (_m, tag, body) => renderTag(tag, body));
  }
  return s.replace(/\{=\w+[^}]*\}/g, "item").replace(/\s+/g, " ").trim();
}

/** Flatten an `entries` tree into one line of plain text. */
export function flattenEntries(entries: unknown): string {
  const out: string[] = [];
  const walk = (e: any) => {
    if (e == null) return;
    if (typeof e === "string") return void out.push(stripTags(e));
    if (Array.isArray(e)) return void e.forEach(walk);
    if (typeof e !== "object" || e.type === "table" || e.type === "image") return;
    if (e.name && (e.entries || e.entry)) out.push(`${stripTags(e.name)}.`);
    if (e.entry) walk(e.entry);
    if (e.entries) walk(e.entries);
    if (e.items) walk(e.items);
  };
  walk(entries);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function fetchJson(path: string): Promise<any> {
  const res = await fetch(`${DATA_URL}/${path}`, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`5etools ${path}: HTTP ${res.status}`);
  return await res.json();
}

/** Fetch many files a few at a time; a file that fails is logged and skipped. */
async function fetchAll(paths: string[], limit = 8): Promise<any[]> {
  const out: any[] = [];
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const path = paths[next++];
      try {
        out.push(await fetchJson(path));
      } catch (e) {
        console.error("5etools fetch failed", path, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, paths.length) }, worker));
  return out;
}

const comparable = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function entry(name: string, source: string, data: any): Entry {
  return { key: comparable(name), name, source, data };
}

const loaders: Record<Dataset, () => Promise<Entry[]>> = {
  monster: loadMonsters,
  spell: loadSpells,
  item: loadItems,
  feat: loadFeats,
  race: loadRaces,
};

const datasets = new Map<Dataset, { at: number; promise: Promise<Entry[]>; ready?: Entry[] }>();

/** A dataset's entries, downloading it on first use. A stale copy keeps
 * serving while a fresh one downloads; a failed download is retried next time. */
function getDataset(name: Dataset): Promise<Entry[]> {
  const hit = datasets.get(name);
  if (hit && Date.now() - hit.at < DATASET_TTL_MS) return hit.promise;
  const slot: { at: number; promise: Promise<Entry[]>; ready?: Entry[] } = { at: Date.now(), promise: null as any };
  slot.promise = loaders[name]().then((entries) => {
    if (!entries.length) throw new Error(`5etools ${name}: no entries`);
    slot.ready = entries;
    console.log(`5etools ${name}: ${entries.length} entries loaded`);
    return entries;
  });
  slot.promise.catch((e) => {
    console.error(`5etools ${name} load failed`, e);
    if (datasets.get(name) === slot) {
      if (hit?.ready) datasets.set(name, hit);
      else datasets.delete(name);
    }
  });
  datasets.set(name, slot);
  if (hit?.ready) return Promise.resolve(hit.ready);
  return slot.promise;
}

/** Start every download in the background (server start), so the first
 * lookup doesn't wait on GitHub. */
export function warmFivetools(): void {
  for (const name of Object.keys(loaders) as Dataset[]) getDataset(name).catch(() => {});
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Preferred books when a name exists in several (core books first). */
const SOURCE_RANK = ["MM", "PHB", "DMG", "MPMM", "XGE", "TCE", "VGM", "MTF", "FTD", "SCAG", "EGW", "BGG", "BMT"];
const rankOf = (source: string) => {
  const i = SOURCE_RANK.indexOf(source.toUpperCase());
  return i < 0 ? SOURCE_RANK.length : i;
};

function best(list: Entry[]): Entry | undefined {
  return [...list].sort((a, b) => a.key.length - b.key.length || rankOf(a.source) - rankOf(b.source))[0];
}

function search(entries: Entry[], query: string, fuzzy: boolean): Entry | undefined {
  const wanted = comparable(query);
  if (!wanted) return undefined;
  const exact = best(entries.filter((e) => e.key === wanted));
  if (exact || !fuzzy) return exact;
  return (
    best(entries.filter((e) => e.key.startsWith(wanted))) ??
    best(entries.filter((e) => e.key.includes(wanted))) ??
    best(entries.filter((e) => e.key.length >= 4 && wanted.includes(e.key)))
  );
}

/**
 * Look a name up in 5e.tools: `exact` is a same-name match, `fuzzy` the
 * closest partial match (equal to `exact` when there is one). Data is
 * dnd5eapi-shaped, with `_link` and `_source`. Null when the dataset is
 * unreachable or still downloading after LOOKUP_WAIT_MS, so a lookup never
 * hangs on it.
 */
export async function lookupFivetools(kind: string, query: string): Promise<{ exact: any | null; fuzzy: any | null } | null> {
  const name = KIND_DATASET[kind];
  if (!name) return null;
  let entries: Entry[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), LOOKUP_WAIT_MS)));
    const loaded = await Promise.race([getDataset(name), timeout]);
    if (!loaded) return null;
    entries = loaded;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (kind === "subrace") entries = entries.filter((e) => e.data._subrace);
  const exact = search(entries, query, false)?.data ?? null;
  return { exact, fuzzy: exact ?? search(entries, query, true)?.data ?? null };
}

export function fivetoolsLink(page: string, name: string, source: string): string {
  return `${SITE_URL}/${page}#${encodeURIComponent(name.toLowerCase())}_${encodeURIComponent(source.toLowerCase())}`;
}

const base = (page: string, name: string, source: string) => ({
  index: `5etools:${name}|${source}`.toLowerCase(),
  name,
  _source: `5e.tools (${source})`,
  _link: fivetoolsLink(page, name, source),
});

// ---------------------------------------------------------------------------
// Monsters
// ---------------------------------------------------------------------------

const SIZES: Record<string, string> = { T: "Tiny", S: "Small", M: "Medium", L: "Large", H: "Huge", G: "Gargantuan" };
const ALIGN: Record<string, string> = { L: "lawful", N: "neutral", C: "chaotic", G: "good", E: "evil", U: "unaligned", A: "any alignment" };
const XP_BY_CR: Record<string, number> = {
  "0": 10, "0.125": 25, "0.25": 50, "0.5": 100, "1": 200, "2": 450, "3": 700, "4": 1100, "5": 1800, "6": 2300,
  "7": 2900, "8": 3900, "9": 5000, "10": 5900, "11": 7200, "12": 8400, "13": 10000, "14": 11500, "15": 13000,
  "16": 15000, "17": 18000, "18": 20000, "19": 22000, "20": 25000, "21": 33000, "22": 41000, "23": 50000,
  "24": 62000, "25": 75000, "26": 90000, "27": 105000, "28": 120000, "29": 135000, "30": 155000,
};
const SCORES: Array<[string, string]> = [
  ["str", "strength"], ["dex", "dexterity"], ["con", "constitution"],
  ["int", "intelligence"], ["wis", "wisdom"], ["cha", "charisma"],
];

function crValue(cr: unknown): number {
  const raw = typeof cr === "object" && cr ? (cr as any).cr : cr;
  const [a, b] = String(raw ?? "").split("/").map(Number);
  return b ? a / b : Number.isFinite(a) ? a : NaN;
}

function alignmentText(al: unknown): string {
  if (!Array.isArray(al) || !al.length) return "";
  if (typeof al[0] === "object") {
    const first = al[0] as any;
    return first.special ? stripTags(first.special) : alignmentText(first.alignment);
  }
  const codes = al as string[];
  if (codes.length === 1) return ALIGN[codes[0]] ?? codes[0];
  if (codes.length > 2) return `any ${codes.includes("G") && !codes.includes("E") ? "non-evil" : codes.includes("E") && !codes.includes("G") ? "non-good" : ""} alignment`.replace(/\s+/g, " ");
  return codes.map((c) => ALIGN[c] ?? c).join(" ");
}

function typeText(type: unknown): string {
  if (typeof type === "string") return type;
  const t = type as any;
  const main = typeof t?.type === "string" ? t.type : Array.isArray(t?.type?.choose) ? t.type.choose.join(" or ") : "creature";
  const tags = (t?.tags ?? []).map((x: any) => (typeof x === "string" ? x : x?.tag)).filter(Boolean);
  return t?.swarmSize ? `swarm of ${SIZES[t.swarmSize] ?? ""} ${main}s` : `${main}${tags.length ? ` (${tags.join(", ")})` : ""}`;
}

function speedObject(speed: any): Record<string, string> {
  if (typeof speed === "number") return { walk: `${speed} ft.` };
  const out: Record<string, string> = {};
  for (const [mode, v] of Object.entries(speed ?? {})) {
    const n = typeof v === "number" ? v : (v as any)?.number;
    if (typeof n === "number") out[mode] = `${n} ft.${(v as any)?.condition ? ` ${stripTags((v as any).condition)}` : ""}`;
  }
  return out;
}

function adaptAction(a: any) {
  const raw = JSON.stringify(a?.entries ?? []);
  const hit = raw.match(/\{@hit\s+([+-]?\d+)\}/);
  // Only attack-roll actions count as the bestiary's swing: save effects like a
  // beholder's Eye Rays list every ray's damage, which would add up absurdly.
  const damage = hit
    ? [...raw.matchAll(/\{@damage\s+([^}|]+)\}/g)].map((m) => ({ damage_dice: m[1].replace(/\s+/g, "") }))
    : [];
  return {
    name: stripTags(a?.name ?? ""),
    desc: flattenEntries(a?.entries).slice(0, 400),
    ...(hit ? { attack_bonus: Number(hit[1]) } : {}),
    damage,
  };
}

function adaptMonster(m: any) {
  const cr = crValue(m.cr);
  const ac0 = Array.isArray(m.ac) ? m.ac[0] : m.ac;
  const acValue = typeof ac0 === "number" ? ac0 : ac0?.ac;
  const acType = typeof ac0 === "object" && ac0?.from ? ac0.from.map(stripTags).join(", ") : "";
  const hpSpecial = Number.parseInt(String(m.hp?.special ?? ""), 10);
  const data: any = {
    ...base("bestiary.html", m.name, m.source),
    size: SIZES[m.size?.[0]] ?? "",
    type: typeText(m.type),
    alignment: alignmentText(m.alignment),
    armor_class: acValue != null ? [{ value: acValue, ...(acType ? { type: acType } : {}) }] : [],
    hit_points: m.hp?.average ?? (Number.isFinite(hpSpecial) ? hpSpecial : undefined),
    hit_dice: m.hp?.formula ?? "",
    speed: speedObject(m.speed),
    challenge_rating: Number.isFinite(cr) ? cr : undefined,
    xp: Number.isFinite(cr) ? XP_BY_CR[String(cr)] : undefined,
    actions: (Array.isArray(m.action) ? m.action : []).map(adaptAction),
    proficiencies: Object.entries(m.save ?? {}).map(([ab, v]) => ({
      proficiency: { index: `saving-throw-${ab}` },
      value: Number.parseInt(String(v), 10),
    })),
  };
  for (const [short, long] of SCORES) if (typeof m[short] === "number") data[long] = m[short];
  return data;
}

async function loadMonsters(): Promise<Entry[]> {
  const index = await fetchJson("bestiary/index.json");
  const files = await fetchAll(Object.values(index).map((f) => `bestiary/${f}`));
  const raw = files.flatMap((f) => (Array.isArray(f?.monster) ? f.monster : []));
  const byId = new Map(raw.map((m: any) => [`${m.name}|${m.source}`.toLowerCase(), m]));
  // `_copy` entries (variants like "Goblin Boss" reskins) inherit the base
  // stat block; their `_mod` text tweaks are skipped.
  const resolve = (m: any, depth = 0): any => {
    if (!m?._copy || depth > 4) return m;
    const parent = byId.get(`${m._copy.name}|${m._copy.source}`.toLowerCase());
    if (!parent) return m;
    const { _copy, ...own } = m;
    return { ...resolve(parent, depth + 1), ...own };
  };
  return raw
    .filter((m: any) => m?.name && m?.source)
    .map((m: any) => entry(m.name, m.source, adaptMonster(resolve(m))));
}

// ---------------------------------------------------------------------------
// Spells
// ---------------------------------------------------------------------------

const SCHOOLS: Record<string, string> = {
  A: "Abjuration", C: "Conjuration", D: "Divination", E: "Enchantment",
  V: "Evocation", I: "Illusion", N: "Necromancy", T: "Transmutation",
};

function castingTime(time: any[]): string {
  const t = time?.[0];
  if (!t) return "?";
  const unit = t.unit === "bonus" ? "bonus action" : t.unit;
  return `${t.number} ${unit}${t.number > 1 ? "s" : ""}${t.condition ? `, ${stripTags(t.condition)}` : ""}`;
}

function rangeText(r: any): string {
  const d = r?.distance;
  if (r?.type === "special") return "Special";
  if (r?.type === "point") {
    if (d?.type === "self") return "Self";
    if (d?.type === "touch") return "Touch";
    if (d?.type === "sight") return "Sight";
    if (d?.type === "unlimited") return "Unlimited";
    return `${d?.amount ?? "?"} ${d?.type ?? ""}`.trim();
  }
  return d ? `Self (${d.amount}-${String(d.type).replace(/s$/, "")} ${r.type})` : String(r?.type ?? "?");
}

function durationText(dur: any[]): string {
  const d = dur?.[0];
  if (!d) return "?";
  if (d.type === "instant") return "Instantaneous";
  if (d.type === "permanent") return "Until dispelled";
  if (d.type === "special") return "Special";
  if (d.type === "timed") {
    const n = d.duration?.amount ?? 1;
    return `${d.concentration ? "Up to " : ""}${n} ${d.duration?.type ?? ""}${n > 1 ? "s" : ""}`;
  }
  return String(d.type);
}

/** "8d6" + k × "1d6" when the dice match (scaled spell damage). */
function addDice(baseDice: string, step: string, times: number): string {
  const a = baseDice.match(/^(\d+)d(\d+)(.*)$/);
  const b = step.match(/^(\d+)d(\d+)$/);
  if (!a || !b || a[2] !== b[2]) return baseDice;
  return `${Number(a[1]) + Number(b[1]) * times}d${a[2]}${a[3]}`;
}

function adaptSpell(s: any, classes: any) {
  const text = JSON.stringify(s.entries ?? []);
  const plain = flattenEntries(s.entries);
  const baseDice = text.match(/\{@damage\s+([^}|]+)\}/)?.[1]?.replace(/\s+/g, "");
  const scale = JSON.stringify(s.entriesHigherLevel ?? []).match(/\{@scaledamage\s+[^|}]+\|(\d+)-(\d+)\|([^}|]+)\}/);
  const slots: Record<string, string> = {};
  if (baseDice) {
    slots[String(s.level)] = baseDice;
    if (scale) {
      for (let slot = Math.max(s.level + 1, Number(scale[1])); slot <= Number(scale[2]); slot++) {
        slots[String(slot)] = addDice(baseDice, scale[3].replace(/\s+/g, ""), slot - s.level);
      }
    }
  }
  const save = String(s.savingThrow?.[0] ?? "").slice(0, 3);
  const area = plain.match(/(\d+)-foot(?:-radius)?[\s-]+(sphere|cone|cube|cylinder|line|square|radius)/i);
  const m = s.components?.m;
  return {
    ...base("spells.html", s.name, s.source),
    level: s.level,
    school: { name: SCHOOLS[s.school] ?? s.school },
    casting_time: castingTime(s.time),
    range: rangeText(s.range),
    duration: durationText(s.duration),
    concentration: (s.duration ?? []).some((d: any) => d.concentration),
    components: [s.components?.v && "V", s.components?.s && "S", m && "M"].filter(Boolean),
    ...(m ? { material: stripTags(typeof m === "string" ? m : m.text) } : {}),
    ...(baseDice || s.damageInflict
      ? { damage: { damage_type: { name: s.damageInflict?.[0] ? cap(s.damageInflict[0]) : "Damage" }, damage_at_slot_level: slots } }
      : {}),
    ...(save
      ? { dc: { dc_type: { index: save, name: save.toUpperCase() }, dc_success: /half as much/i.test(plain) ? "half" : "none" } }
      : {}),
    ...(area ? { area_of_effect: { size: Number(area[1]), type: area[2].toLowerCase() } } : {}),
    classes: [...new Set(
      [...(classes?.[s.source]?.[s.name]?.class ?? []), ...(classes?.[s.source]?.[s.name]?.classVariant ?? [])]
        .map((c: any) => String(c.name)),
    )].map((name) => ({ name })),
    higher_level: s.entriesHigherLevel ? [flattenEntries(s.entriesHigherLevel).replace(/^At Higher Levels\.\s*/i, "")] : [],
    desc: [plain],
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

async function loadSpells(): Promise<Entry[]> {
  const index = await fetchJson("spells/index.json");
  const [classes, ...files] = await Promise.all([
    fetchJson("spells/sources.json").catch(() => ({})),
    ...Object.values(index).map((f) => fetchJson(`spells/${f}`).catch(() => null)),
  ]);
  return files
    .flatMap((f) => (Array.isArray(f?.spell) ? f.spell : []))
    .map((s: any) => entry(s.name, s.source, adaptSpell(s, classes)));
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const DAMAGE_TYPES: Record<string, string> = {
  A: "Acid", B: "Bludgeoning", C: "Cold", F: "Fire", O: "Force", L: "Lightning", N: "Necrotic",
  P: "Piercing", I: "Poison", Y: "Psychic", R: "Radiant", S: "Slashing", T: "Thunder",
};
const PROPERTIES: Record<string, string> = {
  A: "Ammunition", AF: "Ammunition (Firearm)", BF: "Burst Fire", F: "Finesse", H: "Heavy", L: "Light",
  LD: "Loading", R: "Reach", RLD: "Reload", S: "Special", T: "Thrown", "2H": "Two-Handed", V: "Versatile",
};
const ARMOR: Record<string, string> = { LA: "Light", MA: "Medium", HA: "Heavy", S: "Shield" };

function costOf(cp: unknown) {
  const v = Number(cp);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  if (v % 100 === 0) return { quantity: v / 100, unit: "gp" };
  if (v % 10 === 0) return { quantity: v / 10, unit: "sp" };
  return { quantity: v, unit: "cp" };
}

function adaptItem(it: any) {
  const [normal, long] = String(it.range ?? "").split("/").map(Number);
  const type = String(it.type ?? "").split("|")[0];
  const attune = it.reqAttune === true ? "requires attunement" : it.reqAttune ? `requires attunement ${stripTags(it.reqAttune)}` : "";
  return {
    ...base("items.html", it.name, it.source),
    ...(it.dmg1 ? { damage: { damage_dice: it.dmg1, damage_type: { name: DAMAGE_TYPES[it.dmgType] ?? it.dmgType ?? "damage" } } } : {}),
    ...(Number.isFinite(normal) ? { range: { normal, ...(Number.isFinite(long) ? { long } : {}) } } : {}),
    properties: (it.property ?? []).map((p: string) => ({ name: PROPERTIES[String(p).split("|")[0]] ?? p })),
    ...(ARMOR[type] && it.ac != null
      ? { armor_category: ARMOR[type], armor_class: { base: it.ac, dex_bonus: type === "LA" || type === "MA" } }
      : {}),
    weight: it.weight,
    cost: costOf(it.value),
    rarity: it.rarity && it.rarity !== "none" ? it.rarity : undefined,
    attunement: attune || undefined,
    desc: [flattenEntries(it.entries)],
  };
}

async function loadItems(): Promise<Entry[]> {
  const [baseFile, itemsFile, variantsFile] = await fetchAll(["items-base.json", "items.json", "magicvariants.json"], 3)
    .then((files) => [
      files.find((f) => f?.baseitem),
      files.find((f) => f?.item),
      files.find((f) => f?.magicvariant),
    ]);
  const items = [
    ...(baseFile?.baseitem ?? []),
    ...(itemsFile?.item ?? []),
    ...(itemsFile?.itemGroup ?? []),
    // Generic variants ("Flame Tongue", "+1 Weapon") keep their rules text in `inherits`.
    ...(variantsFile?.magicvariant ?? []).map((v: any) => ({ ...v.inherits, name: v.name, source: v.inherits?.source ?? v.source })),
  ];
  return items.filter((it: any) => it?.name && it?.source).map((it: any) => entry(it.name, it.source, adaptItem(it)));
}

// ---------------------------------------------------------------------------
// Feats
// ---------------------------------------------------------------------------

function prereqText(prereqs: any[]): string {
  const parts: string[] = [];
  for (const p of prereqs ?? []) {
    for (const ab of p.ability ?? []) {
      parts.push(Object.entries(ab).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(" or "));
    }
    if (p.race) parts.push(p.race.map((r: any) => cap(r.displayEntry ?? r.name)).join(" or "));
    if (p.level) parts.push(`level ${typeof p.level === "object" ? p.level.level : p.level}`);
    if (p.spellcasting || p.spellcasting2020) parts.push("ability to cast a spell");
    if (p.proficiency) parts.push(p.proficiency.map((x: any) => `${Object.values(x)[0]} ${Object.keys(x)[0]} proficiency`).join(" or "));
    if (p.feat) parts.push(p.feat.map((f: string) => stripTags(`{@feat ${f}}`)).join(", "));
    if (p.other) parts.push(stripTags(p.other));
  }
  return parts.filter(Boolean).join("; ");
}

async function loadFeats(): Promise<Entry[]> {
  const file = await fetchJson("feats.json");
  return (file.feat ?? []).map((f: any) =>
    entry(f.name, f.source, {
      ...base("feats.html", f.name, f.source),
      prerequisites: (f.prerequisite ?? []).flatMap((p: any) =>
        (p.ability ?? []).flatMap((ab: any) =>
          Object.entries(ab).map(([k, v]) => ({ ability_score: { name: k.toUpperCase() }, minimum_score: v })),
        ),
      ),
      _prereqText: prereqText(f.prerequisite) || "none",
      desc: [flattenEntries(f.entries)],
    }),
  );
}

// ---------------------------------------------------------------------------
// Races and subraces
// ---------------------------------------------------------------------------

const RACE_BOILERPLATE = /^(age|size|speed|alignment|languages|ability score increase|creature type)$/i;

function abilityBonuses(ability: any[], lineage?: unknown): any[] {
  // MPMM/Tasha's-style races: +2 and +1 (or three +1s) wherever you like.
  if (!ability && lineage) return [{ ability_score: { name: "any one" }, bonus: 2 }, { ability_score: { name: "any other" }, bonus: 1 }];
  const out: any[] = [];
  for (const [k, v] of Object.entries(ability?.[0] ?? {})) {
    if (k === "choose") {
      const c = v as any;
      const from = (c.from ?? []).map((x: string) => x.toUpperCase());
      out.push({ ability_score: { name: `${c.count ?? 1} of ${from.length >= 6 ? "any" : from.join("/")}` }, bonus: c.amount ?? 1 });
    } else if (typeof v === "number") {
      out.push({ ability_score: { name: k.toUpperCase() }, bonus: v });
    }
  }
  return out;
}

function languages(langs: any[]): any[] {
  return Object.entries(langs?.[0] ?? {}).map(([k, v]) =>
    ({ name: v === true ? cap(k) : k === "anyStandard" ? `${v} of your choice` : `${cap(k)} (${v})` }),
  );
}

function adaptRace(r: any, displayName: string, parent?: any) {
  const traits = (r.entries ?? [])
    .filter((e: any) => typeof e === "object" && e.name && !RACE_BOILERPLATE.test(e.name))
    .map((e: any) => ({ name: stripTags(e.name) }));
  const speed = r.speed ?? parent?.speed;
  const sizes: string[] = r.size ?? parent?.size ?? [];
  const langs = r.languageProficiencies ?? parent?.languageProficiencies ??
    (r.lineage ? [{ common: true, anyStandard: 1 }] : undefined);
  return {
    ...base("races.html", displayName, r.source),
    name: displayName,
    size: sizes.map((x) => SIZES[x] ?? x).join(" or "),
    speed: typeof speed === "number" ? speed : speed?.walk,
    ability_bonuses: abilityBonuses(r.ability ?? (parent ? [] : undefined), r.lineage),
    languages: languages(langs),
    traits,
    ...(parent ? { race: { name: parent.name }, _subrace: true } : {}),
  };
}

async function loadRaces(): Promise<Entry[]> {
  const file = await fetchJson("races.json");
  const races = (file.race ?? []).filter((r: any) => r?.name && r?.source && !r._copy);
  const byId = new Map(races.map((r: any) => [`${r.name}|${r.source}`.toLowerCase(), r]));
  const out: Entry[] = races.map((r: any) => entry(r.name, r.source, adaptRace(r, r.name)));
  for (const s of file.subrace ?? []) {
    if (!s?.name || !s.raceName) continue; // unnamed = the base race's own option
    const parent = byId.get(`${s.raceName}|${s.raceSource}`.toLowerCase()) ?? { name: s.raceName };
    // 5e.tools lists it as "Elf (High)"; chat usually says "high elf".
    const display = `${s.raceName} (${s.name})`;
    const source = s.source ?? s.raceSource;
    const data = adaptRace({ ...s, source }, display, parent);
    out.push(entry(display, source, data), entry(`${s.name} ${s.raceName}`, source, data));
  }
  return out;
}

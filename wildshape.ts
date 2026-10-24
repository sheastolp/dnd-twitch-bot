// !wildshape <beast> — a saved Druid takes the shape of a beast from the
// 2024 Monster Manual, by the 2024 (5.5e) Wild Shape rules in
// wildshape_rules.ts: CR and Fly-speed limits by level, known forms, uses,
// duration, Temporary HP, and the form's merged stat block. Dashboard switch:
// charcreate ("Create and view", with !char and !abilities).
//
//   !wildshape <beast>          shift (spends a use; learns the form if a known-form slot is free)
//   !wildshape                  your form, uses, rests and known forms
//   !wildshape info <beast>     a form's stats for you, without shifting
//   !wildshape end              return to your true form
//   !wildshape forms            your known forms; !wildshape list: every form you could learn
//   !wildshape forget <beast>   swap out a known form (once per Long Rest)
//   !wildshape circle <land|moon|sea|stars>   your Druid Circle (Moon changes Wild Shape)
//   !wildshape shortrest        regain one use (a Short Rest is an hour, so once an hour)
//   !wildshape rest             Long Rest: every use back, a form swap, and the shape ends
//                               (one Long Rest per 24 hours, as the rules say)
//
// The form lasts its real-time duration (half your Druid level in hours).
// While it lasts, fights use it (combat_abilities.ts): the beast's AC and
// attacks, and its Temporary HP soaking damage first (wildshape_form.ts
// hands it to getCharacter).

import { getCharacter } from "./db.ts";
import { sqlite } from "./sqlite.ts";
import { sendChatMessages } from "./twitch.ts";
import type { Character } from "./types.ts";
import {
  type Beast,
  CIRCLES,
  comparable,
  crText,
  findBeast,
  formLine,
  formStats,
  fightForm,
  ineligibleReason,
  loadBeasts,
  shapeLimits,
} from "./wildshape_rules.ts";

const HOUR_MS = 60 * 60 * 1000;
const SHORT_REST_MS = HOUR_MS;
const LONG_REST_MS = 24 * HOUR_MS;

type ShapeState = {
  circle: string | null;
  known: string[];
  usesSpent: number;
  slotsSpent: number;
  form: string | null;
  formUntil: number;
  tempHp: number;
  /** The form as fights use it (WildForm JSON), fixed when shifting. */
  fight: string | null;
  swapReady: boolean;
  longRestAt: number;
  shortRestAt: number;
};

export async function ensureWildShapeTables() {
  await sqlite.execute(
    `CREATE TABLE IF NOT EXISTS wild_shapes (
      broadcaster_id TEXT NOT NULL, username TEXT NOT NULL,
      circle TEXT, known TEXT NOT NULL DEFAULT '[]',
      uses_spent INTEGER NOT NULL DEFAULT 0, slots_spent INTEGER NOT NULL DEFAULT 0,
      form TEXT, form_until INTEGER, temp_hp INTEGER,
      swap_ready INTEGER NOT NULL DEFAULT 1,
      long_rest_at INTEGER, short_rest_at INTEGER, updated_at INTEGER,
      form_fight TEXT,
      PRIMARY KEY (broadcaster_id, username)
    )`,
  );
  // Tables made before fights used the form.
  const cols = await sqlite.execute("PRAGMA table_info(wild_shapes)");
  if (!cols.rows.some((r: any) => r.name === "form_fight")) {
    await sqlite.execute("ALTER TABLE wild_shapes ADD COLUMN form_fight TEXT");
  }
}

export async function purgeWildShapeData(broadcasterId: string) {
  await sqlite.execute("DELETE FROM wild_shapes WHERE broadcaster_id = ?", [broadcasterId]);
}

async function loadState(broadcasterId: string, username: string): Promise<ShapeState> {
  const res = await sqlite.execute("SELECT * FROM wild_shapes WHERE broadcaster_id = ? AND username = ?", [broadcasterId, username]);
  const r: any = res.rows[0];
  let known: string[] = [];
  try {
    known = r ? JSON.parse(String(r.known ?? "[]")) : [];
  } catch { /* a bad row starts over */ }
  return {
    circle: r?.circle ?? null,
    known,
    usesSpent: Number(r?.uses_spent ?? 0),
    slotsSpent: Number(r?.slots_spent ?? 0),
    form: r?.form ?? null,
    formUntil: Number(r?.form_until ?? 0),
    tempHp: Number(r?.temp_hp ?? 0),
    fight: r?.form_fight ?? null,
    swapReady: r ? Number(r.swap_ready) === 1 : true,
    longRestAt: Number(r?.long_rest_at ?? 0),
    shortRestAt: Number(r?.short_rest_at ?? 0),
  };
}

async function saveState(broadcasterId: string, username: string, s: ShapeState) {
  await sqlite.execute(
    `INSERT OR REPLACE INTO wild_shapes (broadcaster_id, username, circle, known, uses_spent, slots_spent, form, form_until,
      temp_hp, form_fight, swap_ready, long_rest_at, short_rest_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      broadcasterId, username, s.circle, JSON.stringify(s.known), s.usesSpent, s.slotsSpent, s.form, s.formUntil,
      s.tempHp, s.form ? s.fight : null, s.swapReady ? 1 : 0, s.longRestAt, s.shortRestAt, Date.now(),
    ],
  );
}

function waitText(ms: number): string {
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `${h} h ${mins % 60} min` : `${h} h`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Handles !wildshape …. Returns true if the message matched. */
export async function handleWildShapeCommand(
  chatMessage: string,
  chatter: string,
  display: string,
  broadcasterId: string,
): Promise<boolean> {
  const m = chatMessage.trim().match(/^!wildshape(?:\s+(.*))?$/i);
  if (!m) return false;
  const arg = (m[1] ?? "").trim();
  const say = (text: string) => sendChatMessages(`@${display} ${text}`, broadcasterId);

  const c = await getCharacter(chatter, broadcasterId);
  if (!c) {
    await say("you don't have a character yet — !createchar or !newchar to make one (Wild Shape is a Druid feature).");
    return true;
  }
  if (String(c.cls).toLowerCase() !== "druid") {
    await say(`Wild Shape is a Druid feature, and you're a ${c.cls}.`);
    return true;
  }
  if (c.level < 2) {
    await say("Druids learn Wild Shape at level 2 — you're level 1.");
    return true;
  }

  const now = Date.now();
  const s = await loadState(broadcasterId, chatter);
  let ended = "";
  if (s.form && s.formUntil <= now) {
    ended = `Your ${s.form} form wore off. `;
    s.form = null;
    await saveState(broadcasterId, chatter, s);
  }
  const limits = shapeLimits(c.level, s.circle);
  const usesText = () => `Wild Shape ${Math.max(0, limits.uses - s.usesSpent)}/${limits.uses} uses`;

  const [sub, ...rest] = arg.split(/\s+/);
  const word = (sub ?? "").toLowerCase();
  const tail = rest.join(" ").trim();

  if (!arg || word === "status") {
    const form = s.form
      ? `🐾 In ${s.form} form for ${waitText(s.formUntil - now)} more (${s.tempHp} temp HP when you shifted). `
      : "In your true form. ";
    await say(
      `${ended}${form}${usesText()}${limits.slots ? `, Wild Resurgence slots ${limits.slots - s.slotsSpent}/${limits.slots}` : ""}. ` +
        `Lv ${c.level}${limits.moon ? " Circle of the Moon" : s.circle ? ` Circle of the ${capitalize(s.circle)}` : ""}: ` +
        `up to CR ${crText(limits.maxCr)}, ${limits.fly ? "flying forms allowed" : "no Fly speed"}, ${limits.hours} h, ${limits.tempHp} temp HP. ` +
        `Known forms (${s.known.length}/${limits.known}): ${s.known.length ? s.known.join(", ") : "none yet — !wildshape <beast> learns one"}.`,
    );
    return true;
  }

  if (["end", "revert", "off", "leave", "stop"].includes(word)) {
    if (!s.form) {
      await say(`${ended}you're already in your true form.`);
      return true;
    }
    const was = s.form;
    s.form = null;
    await saveState(broadcasterId, chatter, s);
    await say(`🌿 you shed the ${was} form and return to your true shape (bonus action). Any of the form's temp HP left are lost.`);
    return true;
  }

  if (word === "circle") {
    const circle = tail.toLowerCase().replace(/^(?:circle\s+)?(?:of\s+)?(?:the\s+)?/, "");
    if (!CIRCLES.includes(circle as any)) {
      await say(`your circle is ${s.circle ? capitalize(s.circle) : "not set"}. Set it with !wildshape circle land|moon|sea|stars (only Moon changes Wild Shape).`);
      return true;
    }
    s.circle = circle;
    await saveState(broadcasterId, chatter, s);
    const l = shapeLimits(c.level, circle);
    await say(
      `you are now a Circle of the ${capitalize(circle)} druid.` +
        (circle === "moon"
          ? c.level >= 3
            ? ` Circle Forms: up to CR ${crText(l.maxCr)}, AC at least 13 + WIS, ${l.tempHp} temp HP (3 × level).`
            : " Circle Forms start when you reach Druid level 3."
          : ""),
    );
    return true;
  }

  if (word === "rest" || word === "longrest" || word === "shortrest") {
    const short = word === "shortrest" || /^short/i.test(tail);
    if (short) {
      const wait = s.shortRestAt + SHORT_REST_MS - now;
      if (wait > 0) {
        await say(`a Short Rest takes an hour — you can finish another in ${waitText(wait)}.`);
        return true;
      }
      const regained = s.usesSpent > 0 ? 1 : 0;
      s.usesSpent -= regained;
      s.shortRestAt = now;
      await saveState(broadcasterId, chatter, s);
      await say(`☕ Short Rest: ${regained ? "you regain one use of Wild Shape" : "your Wild Shape uses are already full"}. ${usesText()}.`);
      return true;
    }
    const wait = s.longRestAt + LONG_REST_MS - now;
    if (wait > 0) {
      await say(`you can only benefit from one Long Rest in 24 hours — the next in ${waitText(wait)}. (!wildshape shortrest regains one use.)`);
      return true;
    }
    const was = s.form;
    Object.assign(s, { usesSpent: 0, slotsSpent: 0, swapReady: true, longRestAt: now, shortRestAt: now, form: null });
    await saveState(broadcasterId, chatter, s);
    await say(
      `🌙 Long Rest: all ${limits.uses} Wild Shape uses${limits.slots ? " and your spell slots" : ""} are back, ` +
        `and you may swap one known form (!wildshape forget <beast>).${was ? ` You slept out of your ${was} form.` : ""}`,
    );
    return true;
  }

  let beasts: Beast[];
  try {
    beasts = await loadBeasts();
  } catch {
    await say("the 2024 Monster Manual's beasts couldn't be fetched right now — try again in a minute.");
    return true;
  }

  if (word === "forms" || word === "known") {
    await say(
      `known forms (${s.known.length}/${limits.known}): ${s.known.length ? s.known.join(", ") : "none yet"}. ` +
        `${limits.known - s.known.length > 0 ? "Shifting into a new eligible beast learns it. " : ""}` +
        `${s.swapReady ? "You can swap one out now (!wildshape forget <beast>)." : "Your next swap comes after a Long Rest."}`,
    );
    return true;
  }

  if (word === "list") {
    const ok = beasts.filter((b) => !ineligibleReason(b, limits, c.level)).sort((a, b) => b.cr - a.cr || a.name.localeCompare(b.name));
    const byCr = new Map<number, string[]>();
    for (const b of ok) byCr.set(b.cr, [...(byCr.get(b.cr) ?? []), b.name]);
    await say(
      `${ok.length} beasts fit your Wild Shape (CR ${crText(limits.maxCr)}, ${limits.fly ? "flying allowed" : "no fliers"}): ` +
        [...byCr].map(([cr, names]) => `CR ${crText(cr)}: ${names.join(", ")}`).join(" | "),
    );
    return true;
  }

  if (word === "forget") {
    const i = s.known.findIndex((k) => comparable(k) === comparable(tail));
    if (i < 0) {
      await say(`"${tail}" isn't one of your known forms (${s.known.join(", ") || "none yet"}).`);
      return true;
    }
    if (!s.swapReady) {
      await say("you can replace one known form after each Long Rest, and you've used this one's swap (!wildshape rest).");
      return true;
    }
    const [gone] = s.known.splice(i, 1);
    s.swapReady = false;
    await saveState(broadcasterId, chatter, s);
    await say(`you forget the ${gone} form. Your next new beast fills its place (${s.known.length}/${limits.known} known).`);
    return true;
  }

  const preview = word === "info" || word === "stats" || word === "preview";
  const query = preview ? tail : arg;
  const { beast, options } = findBeast(beasts, query);
  if (!beast) {
    await say(
      options.length
        ? `which one? ${options.slice(0, 10).map((b) => `${b.name} (CR ${crText(b.cr)})`).join(", ")}`
        : `"${query}" isn't a beast in the 2024 Monster Manual. !wildshape list shows the ones you can take.`,
    );
    return true;
  }

  const why = ineligibleReason(beast, limits, c.level);
  const stats = formStats(c as Character, beast, s.circle);
  if (preview) {
    await say(`${why ? `(not available: ${why}) ` : ""}${formLine(stats)} · ${stats.link}`);
    return true;
  }
  if (why) {
    await say(`you can't take that shape: ${why}. !wildshape list shows the ones you can.`);
    return true;
  }

  const known = s.known.some((k) => comparable(k) === beast.key);
  if (!known && s.known.length >= limits.known) {
    await say(
      `you already know ${s.known.length} forms (${s.known.join(", ")}), your limit at level ${c.level}. ` +
        (s.swapReady ? "!wildshape forget <beast> to make room." : "You can swap one after a Long Rest (!wildshape rest)."),
    );
    return true;
  }

  let resurgence = "";
  if (s.usesSpent >= limits.uses) {
    if (limits.slots - s.slotsSpent > 0) {
      s.slotsSpent++;
      resurgence = " (Wild Resurgence: a spell slot spent for the use)";
    } else {
      await say(
        `you have no uses of Wild Shape left${limits.slots ? " and no spell slots for Wild Resurgence" : ""}. ` +
          `!wildshape shortrest regains one, !wildshape rest regains them all.`,
      );
      return true;
    }
  } else {
    s.usesSpent++;
  }
  if (!known) s.known.push(beast.name);
  const from = s.form;
  s.form = beast.name;
  s.formUntil = now + limits.hours * HOUR_MS;
  s.tempHp = stats.tempHp;
  s.fight = JSON.stringify(fightForm(c as Character, beast, s.circle));
  await saveState(broadcasterId, chatter, s);

  await say(
    `${ended}🐾 ${from ? `from ${from} form, ` : ""}you take the shape of a ${beast.name} for ${limits.hours} h — ` +
      `${stats.tempHp} temp HP over your ${c.hpCurrent}/${c.hpMax} HP, AC ${stats.ac}, Speed ${stats.speed || "0 ft."}, ` +
      `${stats.actions.filter((a) => !a.includes(": ")).join("; ")}. ` +
      `${usesText()} left${resurgence}.${known ? "" : ` Form learned (${s.known.length}/${limits.known}).`} ` +
      `Full stats: !wildshape info ${beast.name.toLowerCase()}`,
  );
  return true;
}

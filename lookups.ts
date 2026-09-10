// D&D 5e API lookups and formatting

import { lookupResources } from "./data.ts";
import { compactText } from "./utils.ts";

/**
 * Public reference links for chat.
 * Avoid 5thsrd.org — it often shows "Access Denied" (403) to normal browsers.
 */
export function lookupLink(kind: string, data: any): string {
  const index = String(data?.index ?? data?.name ?? "")
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const nameQ = encodeURIComponent(String(data?.name ?? index));

  // Hardcoded Free Rules chapter URLs (e.g. /sources/dnd/free-rules/combat) have started
  // returning 403s as D&D Beyond has restructured that section. The public search URL
  // below doesn't require login and hasn't shown the same 403 gate, so use it for everything.
  if (kind === "rule" || kind === "rules") {
    return `https://www.dndbeyond.com/search?q=${nameQ}`;
  }
  if (kind === "spell") return `https://www.dndbeyond.com/spells/${index}`;
  if (kind === "item") return `https://www.dndbeyond.com/equipment/${index}`;
  if (kind === "class") return `https://www.dndbeyond.com/classes/${index}`;
  if (kind === "feat") return `https://www.dndbeyond.com/feats/${index}`;
  if (kind === "race") return `https://www.dndbeyond.com/races/${index}`;
  if (kind === "subrace") return `https://www.dndbeyond.com/search?q=${nameQ}`;
  if (kind === "ability") return `https://www.dndbeyond.com/search?q=${nameQ}`;
  return `https://www.dndbeyond.com/search?q=${nameQ}`;
}

function withLink(kind: string, data: any, text: string): string {
  const link = lookupLink(kind, data);
  // Put the link first so it's always visible even if chat truncates/splits the message
  if (text.includes(link)) return text;
  return `🔗 ${link} | ${text}`;
}

async function fetchFromResource(resource: string, lookupQuery: string): Promise<any | null> {
  const normalized = lookupQuery
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
  const slug = normalized.replace(/ /g, "-");
  const base = `https://www.dnd5eapi.co/api/2014/${resource}`;
  for (const candidate of [slug, normalized.replace(/ /g, "-")]) {
    const direct = await fetch(`${base}/${encodeURIComponent(candidate)}`);
    if (direct.ok) return await direct.json();
  }
  const res = await fetch(base);
  if (!res.ok) return null;
  const list = (await res.json()).results ?? [];
  const comparable = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = comparable(lookupQuery);
  const found =
    list.find((x: any) => comparable(x.name) === wanted) ??
    list.find((x: any) => comparable(x.name).includes(wanted) || wanted.includes(comparable(x.name)));
  if (!found) return null;
  const detail = await fetch(`https://www.dnd5eapi.co${found.url}`);
  return detail.ok ? await detail.json() : null;
}

export async function lookup5e(kind: string, query: string): Promise<any | null> {
  const resource = lookupResources[kind];
  if (!resource || !query || query.length > 60) return null;
  const abilityAliases: Record<string, string> = {
    strength: "str",
    dexterity: "dex",
    constitution: "con",
    intelligence: "int",
    wisdom: "wis",
    charisma: "cha",
  };
  const lookupQuery = kind === "ability" ? (abilityAliases[query.toLowerCase().trim()] ?? query) : query;

  // Rules: aliases + sections + chapters; expand chapter subsections for fuller answers
  if (kind === "rule" || kind === "rules") {
    const aliases: Record<string, string> = {
      magic: "spellcasting",
      spells: "spellcasting",
      spell: "what-is-a-spell",
      casting: "casting-a-spell",
      concentration: "casting-a-spell",
      combat: "combat",
      attack: "making-an-attack",
      attacks: "making-an-attack",
      cover: "cover",
      advantage: "advantage-and-disadvantage",
      disadvantage: "advantage-and-disadvantage",
      rest: "resting",
      resting: "resting",
      death: "damage-and-healing",
      healing: "damage-and-healing",
      damage: "damage-and-healing",
      movement: "movement",
      initiative: "the-order-of-combat",
      surprise: "the-order-of-combat",
    };
    const q = lookupQuery.toLowerCase().trim();
    const aliased = aliases[q] ?? lookupQuery;

    let section = await fetchFromResource("rule-sections", aliased);
    if (!section) section = await fetchFromResource("rule-sections", lookupQuery);
    if (section) return { ...section, _kind: "rule-section" };

    let chapter = await fetchFromResource("rules", aliased);
    if (!chapter) chapter = await fetchFromResource("rules", lookupQuery);
    if (chapter) {
      const subs = Array.isArray(chapter.subsections) ? chapter.subsections.slice(0, 4) : [];
      const expanded: string[] = [];
      for (const sub of subs) {
        try {
          const res = await fetch(`https://www.dnd5eapi.co${sub.url}`);
          if (res.ok) {
            const detail = await res.json();
            const d = String(detail.desc ?? "").replace(/#{1,6}\s*/g, "").replace(/\s+/g, " ").trim();
            if (d) expanded.push(`${detail.name}: ${d.slice(0, 700)}`);
          }
        } catch (_) {
          /* ignore */
        }
      }
      return { ...chapter, _kind: "rule-chapter", _expanded: expanded };
    }
    return null;
  }

  return fetchFromResource(resource, lookupQuery);
}

export function formatSpellSections(data: any, bonus: number | null = null) {
  const upcast = bonus && bonus > 0 ? bonus : 0;
  const baseSlot = data.level + upcast;
  const slotDamage = data.damage?.damage_at_slot_level?.[String(baseSlot)];
  const damage = data.damage
    ? `${data.damage.damage_type?.name ?? "Damage"} ${
        slotDamage
          ? `at slot ${baseSlot}: ${slotDamage}`
          : Object.entries(data.damage.damage_at_slot_level ?? {})
              .map(([level, dice]) => `L${level}:${dice}`)
              .join("/")
      }`
    : "no direct damage";
  const dc = data.dc ? `${data.dc.dc_type?.name ?? "save"} save (${data.dc.dc_success ?? "normal"})` : "no save";
  const area = data.area_of_effect
    ? `${data.area_of_effect.size}-ft ${data.area_of_effect.type}`
    : "not listed";
  const components = (data.components ?? []).join("") || "none";
  const material = data.material ? `; material: ${compactText(data.material, 80)}` : "";
  const classes =
    compactText((data.classes ?? []).map((x: any) => x.name).join(", "), 100) || "none listed";
  const higher = data.higher_level?.length ? compactText(data.higher_level[0], 180) : "none";
  const link = lookupLink("spell", data);
  return [
    `🔗 ${link} | ${data.name} Lv${data.level}${upcast ? ` (upcast +${upcast}, slot ${baseSlot})` : ""} ${data.school?.name ?? "magic"} | Cast: ${data.casting_time} | Range: ${data.range} | Duration: ${data.duration}${data.concentration ? " (concentration)" : ""}`,
    `Components: ${components}${material} | Damage: ${damage} | Save: ${dc} | Area: ${area}`,
    `Classes: ${classes} | Higher levels: ${higher}`,
  ];
}

export function formatLookup(kind: string, data: any, bonus: number | null = null) {
  const name = data.name;
  const bonusText = bonus !== null ? `modifier +${bonus}; ` : "";
  if (kind === "item") {
    const damage = data.damage
      ? `${data.damage.damage_dice ?? "?"} ${data.damage.damage_type?.name ?? "damage"}`
      : "no weapon damage";
    const range =
      data.range?.normal != null
        ? data.range.long != null
          ? `${data.range.normal}-${data.range.long} ft`
          : `${data.range.normal} ft`
        : "melee";
    const props = compactText((data.properties ?? []).map((x: any) => x.name).join(", "), 90);
    const ac = data.armor_category
      ? `AC ${data.armor_class?.base ?? "?"}${data.armor_class?.dex_bonus ? "+ Dex" : ""}`
      : "";
    const itemParts = [
      `${bonusText}${bonus !== null ? `attack/damage +${bonus}` : ""}`,
      damage,
      `range ${range}`,
      ac,
      `weight ${data.weight ?? "?"} lb`,
      `cost ${data.cost?.quantity ?? "?"} ${data.cost?.unit ?? "gp"}`,
      `properties ${props || "none"}`,
    ].filter((part) => part.trim());
    return withLink(kind, data, `${name}: ${itemParts.join("; ")}`);
  }
  if (kind === "class") {
    const saves = (data.saving_throws ?? []).map((x: any) => x.name).join(", ") || "none listed";
    const profs = compactText((data.proficiencies ?? []).map((x: any) => x.name).join(", "), 140);
    return withLink(
      kind,
      data,
      `${name}: ${bonusText}Hit Die d${data.hit_die}; saves ${saves}; proficiencies ${profs || "none listed"}`,
    );
  }
  if (kind === "feat") {
    const prereq =
      (data.prerequisites ?? [])
        .map((x: any) => `${x.ability_score?.name ?? "ability"} ${x.minimum_score ?? "?"}`)
        .join(", ") || "none listed";
    return withLink(
      kind,
      data,
      `${name}: ${bonusText}prerequisite ${prereq}; ${compactText((data.desc ?? []).join(" "), 220)}`,
    );
  }
  if (kind === "ability") {
    const skills = compactText((data.skills ?? []).map((x: any) => x.name).join(", "), 100);
    return withLink(
      kind,
      data,
      `${name}: ${bonusText}score ${data.full_name ?? name}; skills ${skills || "none listed"}; ${compactText((data.desc ?? []).join(" "), 180)}`,
    );
  }
  if (kind === "race" || kind === "subrace") {
    const bonuses =
      (data.ability_bonuses ?? [])
        .map(
          (b: any) =>
            `${b.ability_score?.name ?? b.ability_score?.index?.toUpperCase() ?? "ability"} +${b.bonus}`,
        )
        .join(", ") || "none listed";
    const traits = compactText((data.traits ?? data.racial_traits ?? []).map((x: any) => x.name).join(", "));
    const languages = compactText((data.languages ?? []).map((x: any) => x.name).join(", "), 80);
    const parent = data.race?.name ? `; parent race ${data.race.name}` : "";
    return withLink(
      kind,
      data,
      `${name}: ${bonusText}bonuses ${bonuses}; speed ${data.speed ?? "?"} ft; size ${data.size ?? "?"}${parent}; languages ${languages || "not listed"}; traits ${traits || "none listed"}`,
    );
  }
  if (kind === "monster") {
    const acEntries = Array.isArray(data.armor_class) ? data.armor_class : [];
    const ac = acEntries.length
      ? `${acEntries[0].value ?? "?"}${acEntries[0].type ? ` (${acEntries[0].type})` : ""}`
      : String(data.armor_class ?? "?");
    const speedObj = data.speed ?? {};
    const speed =
      Object.entries(speedObj)
        .map(([mode, value]) => `${mode} ${value}`)
        .join(", ") || "30 ft.";
    const typeLine = `${data.size ?? "?"} ${data.type ?? "creature"}${
      data.alignment ? `, ${data.alignment}` : ""
    }`;
    const actionsList = Array.isArray(data.actions) ? data.actions : [];
    const actionText = actionsList.length
      ? compactText(
          actionsList.map((a: any) => `${a.name}: ${a.desc}`).join(" | "),
          200,
        )
      : "no notable actions listed";
    return withLink(
      kind,
      data,
      `${name}: ${typeLine} | AC ${ac} | HP ${data.hit_points ?? "?"} (${data.hit_dice ?? "?"}) | Speed ${speed} | CR ${data.challenge_rating ?? "?"} (XP ${data.xp ?? "?"}) | Actions: ${actionText}`,
    );
  }
  if (kind === "rule" || kind === "rules") {
    // Cap for 3 chat messages (~480 each, leave room for @user in outer send)
    const MAX_RULE_CHARS = 1200;
    const rawDesc = Array.isArray(data.desc) ? data.desc.join(" ") : String(data.desc ?? "");
    const cleaned = rawDesc
      .replace(/\|/g, " ")
      .replace(/#{1,6}\s*/g, "")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const link = lookupLink(kind, data);
    if (Array.isArray(data._expanded) && data._expanded.length) {
      const intro = cleaned.slice(0, 200);
      const body = data._expanded.join(" || ");
      return `🔗 ${link} | ${name}: ${intro} || ${body}`.slice(0, MAX_RULE_CHARS);
    }

    const body = cleaned.slice(0, MAX_RULE_CHARS - 80);
    const subsections = Array.isArray(data.subsections)
      ? data.subsections.map((s: any) => s.name).join(", ")
      : "";
    const subNote = subsections ? ` | Related: ${subsections}` : "";
    return `🔗 ${link} | ${name}: ${body || "no description"}${subNote}`.slice(0, MAX_RULE_CHARS);
  }
  return withLink(kind, data, name);
}

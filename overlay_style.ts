// GuildScribe — custom looks for the OBS overlays. Every overlay link takes the
// same optional look extras, so a streamer can pick a preset or their own
// colours and images and share the link (or just its look) with another
// streamer:
//
//   &preset=<name>     a ready-made look (LOOK_PRESETS: parchment — the default —
//                      moonlit, grove, frost, hellforge, arcane)
//   &paper=<hex>       the theme's sheet          &ink=<hex>     its body text
//   &heading=<hex>     names, headings, plaques   &accent=<hex>  gold trims (and the panels' accent)
//   &seal=<hex>        live gem, name banner, countdowns
//   &disc=<hex>        the d20 emblem's disc
//   &bg=<image URL>    an image for the sheet instead of parchment (&bgfit=tile repeats it)
//   &rollers=0         drop the scroll rollers top and bottom
//   &card=<hex>        the panels' card colour (#rrggbb, or #rrggbbaa for see-through)
//   &cardimg=<URL>     an image behind the panels' cards
//
// Colours are hex only and images http(s) only, so nothing a link carries can
// break out of the CSS. Everything is resolved here, server-side, into plain
// hex values (no color-mix(): OBS's browser is too old for it on many PCs).
// With no look extras the overlays come out exactly as they always have.

export type Rgb = [number, number, number];

/** "#abc", "abc", "#aabbcc" or "#aabbccdd" → "#aabbcc" / "#aabbccdd" (lowercase); anything else → null. */
export function parseColor(v: string | null | undefined): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec((v ?? "").trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return "#" + (h.length === 3 ? [...h].map((c) => c + c).join("") : h);
}

/** An http(s) image link, made safe to drop into CSS url("…"); anything else → null. */
export function parseImageUrl(v: string | null | undefined): string | null {
  try {
    const u = new URL((v ?? "").trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // href already percent-encodes quotes, spaces and angle brackets; belt and braces for the rest.
    return u.href.replace(/["'\\()<>\s]/g, (c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase());
  } catch (_) {
    return null;
  }
}

const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hexOf = (c: Rgb) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
/** a → b by t (0 = a, 1 = b), alpha dropped. */
export const mix = (a: string, b: string, t: number) => hexOf(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t) as Rgb);
const WHITE = "#ffffff", BLACK = "#000000";
export const lighten = (c: string, t: number) => mix(c, WHITE, t);
export const darken = (c: string, t: number) => mix(c, BLACK, t);
/** Relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const solid = (c: string) => c.slice(0, 7);

/** The theme's six base colours; everything else is worked out from these. */
export type ThemeBase = { paper: string; ink: string; heading: string; accent: string; seal: string; disc: string };
export const THEME_KEYS = ["paper", "ink", "heading", "accent", "seal", "disc"] as const;
type ThemeKey = typeof THEME_KEYS[number];

export type LookPreset = {
  label: string;
  base: ThemeBase;
  /** The panels' card colour (with alpha) and accent — their cards are dark glass on every preset but the light ones. */
  card: string;
  panelAccent: string;
};

export const LOOK_PRESETS: Record<string, LookPreset> = {
  parchment: {
    label: "Parchment (GuildScribe)",
    base: { paper: "#fdf3cf", ink: "#3b2814", heading: "#6b4419", accent: "#c99a2e", seal: "#d9473a", disc: "#2f4a39" },
    card: "#15120fd6",
    panelAccent: "#e6a56e",
  },
  moonlit: {
    label: "Moonlit Keep (dark blue)",
    base: { paper: "#1c2333", ink: "#dde4f2", heading: "#f1d98f", accent: "#8faee8", seal: "#ff5d73", disc: "#20304f" },
    card: "#0d1220db",
    panelAccent: "#9fbcf2",
  },
  grove: {
    label: "Elven Grove (green)",
    base: { paper: "#e6edd5", ink: "#23331f", heading: "#2f5a2a", accent: "#7a9a3c", seal: "#c4552f", disc: "#2e4a2b" },
    card: "#121a10d6",
    panelAccent: "#a8c76a",
  },
  frost: {
    label: "Frostfell (icy blue)",
    base: { paper: "#e9f2f8", ink: "#1c3144", heading: "#24577e", accent: "#5f9fc9", seal: "#e0566a", disc: "#1e3b57" },
    card: "#0e1823d6",
    panelAccent: "#8cc4ea",
  },
  hellforge: {
    label: "Hellforge (dark red)",
    base: { paper: "#2b1612", ink: "#f5dccb", heading: "#ffb36b", accent: "#e2622b", seal: "#ff3b2f", disc: "#3d140e" },
    card: "#1a0b08db",
    panelAccent: "#ff8a4c",
  },
  arcane: {
    label: "Arcane Tower (violet)",
    base: { paper: "#eee4f6", ink: "#2c1a3e", heading: "#5b2f88", accent: "#9b6bd8", seal: "#d94a8c", disc: "#2d1c4b" },
    card: "#160e22d6",
    panelAccent: "#c39cf2",
  },
};
export const DEFAULT_PRESET = "parchment";

/** Every look extra a link may carry, in the order the setup page writes them. */
export const LOOK_PARAMS = ["preset", ...THEME_KEYS, "bg", "bgfit", "rollers", "card", "cardimg"] as const;
/** The ones the theme passes on to the panels it embeds (status strip, goldboard, Battle Tracker). */
const PANEL_PARAMS = ["preset", "accent", "card", "cardimg"] as const;

// ── The theme ────────────────────────────────────────────────────────────────

/** Paper fine grain and soft stains, tinted to the paper (brown on parchment). */
const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
const matrix = (c: Rgb, a: number, b: number) => c.map((v) => `0 0 0 0 ${(v / 255).toFixed(3)}`).join("  ") + `  0 0 0 ${a} ${b}`;
const grainUrl = (tint: string) => svgUrl(
  `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' seed='5' stitchTiles='stitch'/><feColorMatrix values='${matrix(rgb(tint), 0.3, -0.08)}'/></filter><rect width='100%' height='100%' filter='url(#g)'/></svg>`,
);
const stainsUrl = (tint: string, w: number, h: number) => svgUrl(
  `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><filter id='s'><feTurbulence type='fractalNoise' baseFrequency='0.006' numOctaves='3' seed='11' stitchTiles='stitch'/><feColorMatrix values='${matrix(rgb(tint), 0.55, -0.2)}'/></filter><rect width='100%' height='100%' filter='url(#s)'/></svg>`,
);
// The parchment's own grain and stains, exactly as the theme has always drawn them.
const CLASSIC_GRAIN = svgUrl(
  `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' seed='5' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.45  0 0 0 0 0.32  0 0 0 0 0.1  0 0 0 0.3 -0.08'/></filter><rect width='100%' height='100%' filter='url(#g)'/></svg>`,
);
const classicStains = (w: number, h: number) => svgUrl(
  `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><filter id='s'><feTurbulence type='fractalNoise' baseFrequency='0.006' numOctaves='3' seed='11' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.75  0 0 0 0 0.55  0 0 0 0 0.15  0 0 0 0.55 -0.2'/></filter><rect width='100%' height='100%' filter='url(#s)'/></svg>`,
);

/** The resolved look of the full stream theme. */
export type ThemeLook = {
  /** True when nothing was customised: the classic parchment, untouched. */
  classic: boolean;
  dark: boolean;
  /** CSS custom properties, set on #stage. */
  vars: Record<string, string>;
  /** The .paper background, and whether it's an image (the theme then skips the curl shading). */
  paperBg: string;
  image: boolean;
  rollers: boolean;
  /** Colours drawn into the torn edges' SVG. */
  edge: { gameShadow: string; band: string; burn: string; rim: string; fibres: string };
  /** The d20 emblem's colours. */
  d20: { disc1: string; disc2: string; rim: string; ring1: string; ring2: string; ring3: string; die1: string; die2: string; line: string; line2: string; text: string; spark: string };
  /** Query string (starting "&", or empty) the theme appends to the panels it embeds. */
  panelQuery: string;
};

// The classic parchment's tokens, kept literally so the default never shifts by a shade.
const CLASSIC: Record<ThemeKey, Record<string, string>> = {
  paper: { "--paper": "#fbefc3", "--plaque1": "#fffaf0", "--plaque2": "#f6e3a6", "--hi": "#fff8", "--hi1": "#fff2", "--hi2": "#fff3", "--shadow": "#5a3a0f55", "--pshadow": "#8a5a1830", "--curl1": "#5a3a1640", "--curl2": "#5a3a1614", "--npbg": "#e8d49a", "--ok": "#3f6b2a", "--no": "#b8302a" },
  ink: { "--ink": "#3b2814", "--ink3": "#6b4a22" },
  heading: { "--ink2": "#6b4419" },
  accent: { "--gold": "#c99a2e", "--gold60": "#c99a2e99", "--gold50": "#c99a2e80", "--gold25": "#c99a2e40", "--gold31": "#c99a2e50", "--gold13": "#b07a2222", "--muted": "#a98235", "--sub": "#8a6424", "--glow": "#ffd76acc" },
  seal: { "--seal": "#d9473a", "--seal-hi": "#ffb3a6", "--seal-lo": "#8e1d14", "--seal50": "#e9191680", "--seal25": "#e9191640", "--rib1": "#e2574a", "--rib2": "#b8302a", "--ribtext": "#fff7e6", "--ribshadow": "#5a0e0a" },
  disc: {},
};
const CLASSIC_EDGE = { gameShadow: "#1a0e04", band: "#a06a1c", burn: "#8a5718", rim: "#5e3a10", fibres: "#fffbea" };
const CLASSIC_D20 = { disc1: "#3d5a46", disc2: "#18281e", rim: "#2a1a0c", ring1: "#fff3a8", ring2: "#f2c94c", ring3: "#b8862a", die1: "#fff07a", die2: "#e7b923", line: "#7a5512", line2: "#a87a16", text: "#4a2f08", spark: "#fff8d0" };
const CLASSIC_PAPER_BG = (w: number, h: number) =>
  `${classicStains(w, h)} 0 0/${w}px ${h}px no-repeat,${CLASSIC_GRAIN} 0 0/240px 240px,
    radial-gradient(ellipse at 8% 6%,#fffef8 0,#fffdf3 22%,transparent 55%),
    radial-gradient(ellipse at 100% 0%,#f9e27c 0,transparent 45%),
    radial-gradient(ellipse at 96% 100%,#f4d870 0,transparent 50%),
    linear-gradient(115deg,#fffaf0 0%,#fdf3cf 40%,#f8e7a0 75%,#f3d97c 100%)`;

/** Each base colour's tokens, worked out from the whole base (the paper decides light or dark). */
const DERIVE: Record<ThemeKey, (b: ThemeBase, dark: boolean) => Record<string, string>> = {
  paper: ({ paper: p }, dark) => ({
    "--paper": p,
    "--plaque1": dark ? lighten(p, 0.1) : lighten(p, 0.6),
    "--plaque2": dark ? lighten(p, 0.03) : darken(p, 0.04),
    "--hi": dark ? "#0008" : "#fff8",
    "--hi1": dark ? "#ffffff0d" : "#fff2",
    "--hi2": dark ? "#ffffff12" : "#fff3",
    "--shadow": dark ? "#00000088" : darken(p, 0.65) + "55",
    "--pshadow": dark ? "#00000055" : darken(p, 0.45) + "30",
    "--curl1": dark ? "#00000066" : darken(p, 0.65) + "40",
    "--curl2": dark ? "#00000022" : darken(p, 0.65) + "14",
    "--npbg": dark ? lighten(p, 0.12) : darken(p, 0.1),
    "--ok": dark ? "#86d07a" : "#3f6b2a",
    "--no": dark ? "#ff7d6e" : "#b8302a",
  }),
  ink: ({ ink, paper }) => ({ "--ink": ink, "--ink3": mix(ink, paper, 0.25) }),
  heading: ({ heading }) => ({ "--ink2": heading }),
  accent: ({ accent: a, paper }, dark) => ({
    "--gold": a,
    "--gold60": a + "99",
    "--gold50": a + "80",
    "--gold25": a + "40",
    "--gold31": a + "50",
    "--gold13": a + "22",
    "--muted": dark ? lighten(a, 0.2) : darken(a, 0.16),
    "--sub": dark ? mix(lighten(a, 0.3), paper, 0.1) : darken(a, 0.3),
    "--glow": lighten(a, 0.45) + "cc",
  }),
  seal: ({ seal: s }) => ({
    "--seal": s,
    "--seal-hi": lighten(s, 0.6),
    "--seal-lo": darken(s, 0.45),
    "--seal50": s + "80",
    "--seal25": s + "40",
    "--rib1": lighten(s, 0.1),
    "--rib2": darken(s, 0.18),
    "--ribtext": luminance(s) > 0.55 ? darken(s, 0.8) : "#fff7e6",
    "--ribshadow": luminance(s) > 0.55 ? lighten(s, 0.5) : darken(s, 0.7),
  }),
  disc: () => ({}),
};

/** The look a theme link asks for. */
export function themeLook(q: URLSearchParams, w: number, h: number): ThemeLook {
  const presetKey = (q.get("preset") ?? "").toLowerCase();
  const preset = LOOK_PRESETS[presetKey] ?? LOOK_PRESETS[DEFAULT_PRESET];
  const isParchment = preset === LOOK_PRESETS[DEFAULT_PRESET];
  const base = { ...preset.base };
  const changed = new Set<ThemeKey>();
  for (const k of THEME_KEYS) {
    const c = parseColor(q.get(k));
    if (c && solid(c) !== base[k]) { base[k] = solid(c); changed.add(k); }
  }
  const img = parseImageUrl(q.get("bg"));
  const rollers = q.get("rollers") !== "0";
  const dark = luminance(base.paper) < 0.3;
  // Parchment keeps its hand-tuned tokens for every colour that wasn't changed.
  const literal = (k: ThemeKey) => isParchment && !changed.has(k);
  const vars: Record<string, string> = {};
  for (const k of THEME_KEYS) Object.assign(vars, literal(k) ? CLASSIC[k] : DERIVE[k](base, dark));

  const p = base.paper, a = base.accent;
  let paperBg: string;
  if (img) {
    paperBg = q.get("bgfit") === "tile" ? `url("${img}") 0 0/auto repeat,${p}` : `url("${img}") center/cover no-repeat,${p}`;
  } else if (literal("paper") && literal("accent")) {
    paperBg = CLASSIC_PAPER_BG(w, h);
  } else {
    const lift = dark ? 0.08 : 0.6;
    paperBg = `${stainsUrl(dark ? lighten(p, 0.12) : mix(darken(p, 0.25), a, 0.4), w, h)} 0 0/${w}px ${h}px no-repeat,${grainUrl(dark ? lighten(p, 0.3) : darken(p, 0.55))} 0 0/240px 240px,
    radial-gradient(ellipse at 8% 6%,${lighten(p, lift + 0.15)} 0,${lighten(p, lift)} 22%,transparent 55%),
    radial-gradient(ellipse at 100% 0%,${mix(p, a, dark ? 0.18 : 0.38)} 0,transparent 45%),
    radial-gradient(ellipse at 96% 100%,${mix(p, a, dark ? 0.14 : 0.32)} 0,transparent 50%),
    linear-gradient(115deg,${lighten(p, lift * 0.75)} 0%,${p} 40%,${darken(p, dark ? 0.1 : 0.04)} 75%,${darken(p, dark ? 0.2 : 0.08)} 100%)`;
  }

  const edge = literal("paper") ? CLASSIC_EDGE : dark
    ? { gameShadow: "#000000", band: darken(p, 0.5), burn: darken(p, 0.6), rim: darken(p, 0.75), fibres: lighten(p, 0.3) }
    : { gameShadow: darken(p, 0.9), band: mix(darken(p, 0.35), a, 0.35), burn: darken(p, 0.45), rim: darken(p, 0.62), fibres: lighten(p, 0.8) };
  const ringFrom = literal("accent") ? null : a;
  const discFrom = literal("disc") ? null : base.disc;
  const d20 = {
    ...CLASSIC_D20,
    ...(ringFrom ? {
      ring1: lighten(a, 0.65), ring2: lighten(a, 0.2), ring3: darken(a, 0.12), die1: lighten(a, 0.55), die2: lighten(a, 0.08),
      line: darken(a, 0.4), line2: darken(a, 0.18), text: darken(a, 0.65), spark: lighten(a, 0.82),
    } : {}),
    ...(discFrom ? { disc1: lighten(discFrom, 0.12), disc2: darken(discFrom, 0.45), rim: darken(discFrom, 0.7) } : {}),
  };

  return {
    classic: isParchment && !changed.size && !img && rollers,
    dark,
    vars,
    paperBg,
    image: !!img,
    rollers,
    edge,
    d20,
    panelQuery: lookQuery(q, PANEL_PARAMS),
  };
}

/** The look extras from a query, validated and in a fixed order ("&preset=…&accent=…", or ""). */
export function lookQuery(q: URLSearchParams, keys: readonly string[] = LOOK_PARAMS): string {
  const out: string[] = [];
  for (const k of keys) {
    const v = q.get(k);
    if (v == null) continue;
    let clean: string | null = null;
    if (k === "preset") clean = LOOK_PRESETS[v.toLowerCase()] ? v.toLowerCase() : null;
    else if (k === "bg" || k === "cardimg") clean = parseImageUrl(v);
    else if (k === "bgfit") clean = v === "tile" ? "tile" : null;
    else if (k === "rollers") clean = v === "0" ? "0" : null;
    else clean = parseColor(v)?.slice(1) ?? null; // colours travel without the "#"
    if (clean) out.push(`${k}=${encodeURIComponent(clean)}`);
  }
  return out.length ? "&" + out.join("&") : "";
}

// ── The panels ───────────────────────────────────────────────────────────────

/** CSS overriding the panels' colours for a panel link's look extras; "" for the classic look. */
export function panelLookCss(q: URLSearchParams): string {
  const presetKey = (q.get("preset") ?? "").toLowerCase();
  const preset = LOOK_PRESETS[presetKey];
  const cardQ = parseColor(q.get("card")), accentQ = parseColor(q.get("accent")), img = parseImageUrl(q.get("cardimg"));
  if (!cardQ && !accentQ && !img && (!preset || presetKey === DEFAULT_PRESET)) return "";
  const p = preset ?? LOOK_PRESETS[DEFAULT_PRESET];
  // A colour without alpha keeps the cards' usual see-through glass — thinner over a card image, so it shows.
  const card = cardQ?.length === 9 ? cardQ : solid(cardQ ?? p.card) + (img ? "a6" : cardQ ? "d6" : p.card.slice(7));
  const accent = accentQ ? solid(accentQ) : p.panelAccent;
  const c = solid(card);
  // Light text on dark glass; on a light card (with enough body to read on), dark text.
  const light = luminance(c) > 0.45 && parseInt(card.slice(7) || "ff", 16) > 0x99;
  const ink = light ? mix(c, BLACK, 0.85) : mix(c, WHITE, 0.9);
  const vars = {
    "--ink": ink,
    "--muted": mix(ink, c, 0.3),
    "--gold": light ? darken(accent, 0.3) : accent,
    "--edge": darken(accent, 0.25),
    "--card": card,
    "--rule": mix(darken(accent, 0.4), c, 0.3) + "99",
    "--tshadow": light ? "#fff8" : "#000c",
  };
  const decl = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";");
  return `:root{${decl}}body{text-shadow:0 1px 2px var(--tshadow)}.side+.side{border-top-color:var(--rule)}.chip+.chip{border-left-color:var(--rule)}body.mirror .chip+.chip{border-right-color:var(--rule)}`
    + (img ? `.card,.strip{background-image:linear-gradient(var(--card),var(--card)),url("${img}");background-size:cover;background-position:center}` : "");
}

/** The presets for the setup page's look picker. */
export const LOOK_PRESETS_JSON = JSON.stringify(
  Object.fromEntries(Object.entries(LOOK_PRESETS).map(([k, v]) => [k, { label: v.label, ...v.base, card: solid(v.card) }])),
).replace(/</g, "\\u003c");

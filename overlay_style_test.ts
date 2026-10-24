// Tests for the overlays' custom looks (overlay_style.ts).
// deno test overlay_style_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fontsHref, HEADING_FONTS, lookQuery, panelLook, parseColor, parseImageUrl, themeLook } from "./overlay_style.ts";

const q = (s: string) => new URLSearchParams(s);

Deno.test("colours: hex only, normalised", () => {
  assertEquals(parseColor("#ABC"), "#aabbcc");
  assertEquals(parseColor("ff8800"), "#ff8800");
  assertEquals(parseColor("#11223344"), "#11223344");
  assertEquals(parseColor("red"), null);
  assertEquals(parseColor("#ff8800;}body{x:y"), null);
  assertEquals(parseColor(null), null);
});

Deno.test("images: http(s) only, nothing that can close url(\"…\")", () => {
  assertEquals(parseImageUrl("javascript:alert(1)"), null);
  assertEquals(parseImageUrl("data:image/png;base64,AAAA"), null);
  assertEquals(parseImageUrl("not a url"), null);
  const u = parseImageUrl(`https://x.example/a"b'c(d)e\\f<g>.png`)!;
  assert(u.startsWith("https://x.example/"));
  assert(!/["'()\\<>\s]/.test(u), u);
});

Deno.test("no look extras: the classic parchment", () => {
  const look = themeLook(q(""), 1920, 1080);
  assert(look.classic);
  assertEquals(look.vars["--gold"], "#c99a2e");
  assertEquals(look.vars["--paper"], "#fbefc3");
  assertEquals(look.panelQuery, "");
  assertEquals(panelLook(q("")), { css: "", fontHref: "" });
  assertEquals(panelLook(q("preset=parchment")), { css: "", fontHref: "" });
  // The theme's font link is the one it always loaded.
  assertEquals(look.fonts.href, "https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=EB+Garamond:ital,wght@0,400;0,600;1,400&display=swap");
  assertEquals(look.fonts.heading, `"Cinzel",Georgia,serif`);
});

Deno.test("a preset, colours and an image", () => {
  const look = themeLook(q("preset=moonlit&accent=%23ff8800&bg=https://x.example/t.png&rollers=0&card=101018&junk=1"), 1920, 1080);
  assert(!look.classic && look.dark && look.image && !look.rollers);
  assertEquals(look.vars["--gold"], "#ff8800");
  assertEquals(look.vars["--ink2"], "#f1d98f");
  assert(look.paperBg.startsWith(`url("https://x.example/t.png") center/cover`));
  assertEquals(look.panelQuery, "&preset=moonlit&accent=ff8800&card=101018");
  const { css } = panelLook(q("preset=moonlit&accent=ff8800"));
  assert(css.includes("--gold:#ff8800"));
});

Deno.test("a changed colour on parchment only re-derives its own tokens", () => {
  const look = themeLook(q("seal=00aa00"), 1920, 1080);
  assertEquals(look.vars["--seal"], "#00aa00");
  assertEquals(look.vars["--gold"], "#c99a2e");
  assertEquals(look.vars["--paper"], "#fbefc3");
});

Deno.test("look query: validated and in a fixed order", () => {
  assertEquals(lookQuery(q("card=zzz&accent=FFF&preset=NOPE&bgfit=cover&rollers=1&preset=arcane")), "&accent=ffffff");
  assertEquals(lookQuery(q("rollers=0&preset=Arcane")), "&preset=arcane&rollers=0");
});

Deno.test("fonts: only from the lists, on the theme and the panels", () => {
  const look = themeLook(q("font=Uncial&bodyfont=inter"), 1920, 1080);
  assert(!look.classic);
  assertEquals(look.fonts.heading, `"Uncial Antiqua",Georgia,serif`);
  assert(look.fonts.noFauxBold);
  assertEquals(look.fonts.href, "https://fonts.googleapis.com/css2?family=Uncial+Antiqua&family=Inter:wght@400;600&display=swap");
  assertEquals(look.panelQuery, "&font=uncial&bodyfont=inter");
  const unknown = themeLook(q("font=Comic%20Sans&bodyfont=x%22%3B}"), 1920, 1080);
  assertEquals(unknown.fonts.heading, `"Cinzel",Georgia,serif`);
  assert(unknown.classic);
  const panel = panelLook(q("bodyfont=lora"));
  assertEquals(panel.fontHref, fontsHref([{ ...HEADING_FONTS.cinzel, family: "Lora", axes: "ital,wght@0,400;0,600;1,400" }]));
  assert(panel.css.includes(`body{font-family:"Lora",Georgia,serif}`));
});

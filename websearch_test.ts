// Tests for the DuckDuckGo result parsers and page cleanup (websearch.ts).
// deno test --allow-env --allow-net websearch_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { mainContent, parseHtmlResults, parseLiteResults } from "./websearch.ts";

Deno.test("parseHtmlResults unwraps links, skips ads and decodes text", () => {
  const page = `<div id="links" class="results">
<div class="result results_links results_links_deep result--ad "><div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Ad</a></h2></div></div>
<div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpatch%2Dnotes&amp;rut=abc">Patch <b>notes</b></a></h2><a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Version 1.2 &amp; more&#x27;s</a></div></div>
<div class="result results_links web-result "><div class="result__body"><a class="result__a" href="javascript:alert(1)">Bad</a></div></div>
</div>`;
  assertEquals(parseHtmlResults(page), [{ title: "Patch notes", url: "https://example.com/patch-notes", snippet: "Version 1.2 & more's" }]);
});

Deno.test("parseLiteResults pairs links with the snippet after them", () => {
  const page = `<table><tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2F" class='result-link'>A <b>title</b></a></td></tr>
<tr><td class='result-snippet'>About <b>A</b></td></tr><tr><td><a rel="nofollow" href="https://b.com/" class='result-link'>B</a></td></tr></table>`;
  assertEquals(parseLiteResults(page), [
    { title: "A title", url: "https://a.com/", snippet: "About A" },
    { title: "B", url: "https://b.com/", snippet: "" },
  ]);
});

Deno.test("mainContent keeps the article and drops scripts and menus", () => {
  const html = `<html><body><nav>Home | News</nav><main><h2>Release</h2><p>It came out in 2024.</p><script>track()</script><aside>Ad</aside></main><footer>©</footer></body></html>`;
  const out = mainContent(html);
  assert(out.includes("It came out in 2024."));
  for (const gone of ["Home | News", "track()", "Ad", "©"]) assert(!out.includes(gone), gone);
});

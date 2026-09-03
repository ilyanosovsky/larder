# Parser fixtures

Saved HTML, used **only** as input to the recipe parsers in
`src/server/recipes/*.test.ts`. Nothing renders them, nothing links to them,
and **no test touches the network** (AGENTS.md) — that is the whole reason
they are checked in.

Each page was fetched once, on the capture date below, with a browser
`User-Agent`, then trimmed to the recipe fragment: scripts other than the
`ld+json` blocks, styles, comments, ad slots, comment threads and
"похожие рецепты" carousels are gone. Image _tags_ are kept where an
`itemprop="image"` sits on one — the parser reads the `src` attribute — but no
image bytes are stored. Every file is under 50 KB.

| File                     | Source                                                                               | Captured   | Why it exists                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rambler-jsonld.html`    | <https://eda.rambler.ru/recepty/osnovnye-blyuda/kotlety-s-ovsyanymi-hlopyami-192922> | 2026-09-03 | Full JSON-LD `Recipe` — the free first rung of the cascade (VISION §6.4). Keeps the page's `Organization` and `BreadcrumbList` blocks so `findRecipeNode` has to skip non-recipes.                                                                                                                                          |
| `povar-microdata.html`   | <https://povar.ru/recipes/bliny_na_moloke-473.html>                                  | 2026-09-03 | Microdata `schema.org/Recipe`, and its only `ld+json` block is an `Organization` — the exact page shape that makes the second rung necessary. Nested `Person` (author), `NutritionInformation`, `AggregateRating` and thirteen `HowToStep`s are all kept, because ownership is the rule the microdata parser can get wrong. |
| `russianfood-plain.html` | <https://www.russianfood.com/recipes/recipe.php?rid=179072>                          | 2026-09-03 | Nothing structured at all — the page that has to fall through to FireCrawl. Served as `windows-1251`; stored decoded to UTF-8 so the repo stays text-safe, with the decoding path itself covered by `fetch-page.test.ts`.                                                                                                   |
| `dirty-graph.html`       | synthetic                                                                            | 2026-09-03 | Hand-written, not fetched: every awkward JSON-LD shape at once — a malformed block first, an `@graph` wrapper, `@type` as an array, `HowToSection` with nested `itemListElement`, an `ImageObject`, and `recipeYield` as an array.                                                                                          |

Re-capturing one is a deliberate act: these files pin _what the parsers must
survive_, not what a site looks like today, so a test that starts failing is a
parser regression until proven otherwise.

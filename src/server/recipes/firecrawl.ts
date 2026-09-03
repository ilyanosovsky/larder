import "server-only";

import { z } from "zod";

/**
 * The third rung of the cascade: a page with nothing structured on it
 * (VISION §6.4 — russianfood.com), or one whose server refuses our own fetch.
 *
 * Called with `fetch` and no SDK, deliberately: the SDK is a dependency, a
 * cold start and a second HTTP client for one POST. The price of that choice
 * is that a change to FireCrawl's response shape becomes a *runtime* failure
 * (R7), so **the response is Zod-parsed and any mismatch becomes
 * `pageBlocked`** — the user gets S8.2's text/screenshot fork, never a stack
 * trace.
 *
 * The bearer token is read **inside** the call, never at module scope: `pnpm
 * build` runs in CI with no environment at all, exactly as `env()`, `db()` and
 * `openaiClient()` already require. `process.env` directly rather than
 * `env()`, mirroring `src/server/uploadthing-url.ts` and for its reason:
 * `env()` validates the *whole* schema on its first call, so an unrelated
 * missing variable would make a recipe import fail over `RESEND_API_KEY`. The
 * variable stays declared in `src/lib/env.ts` — that is where a deployment is
 * checked — and an absent key here degrades to `pageBlocked`, which is the
 * same fork every other FireCrawl failure offers.
 *
 * Credits: this is the rare branch — rambler and povar never reach it — so a
 * ~1000/month plan is not a constraint.
 */

export const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";

/**
 * How much markdown the model may see. A scraped page is mostly navigation
 * and comments; twelve thousand characters is several recipes' worth, and the
 * ceiling is what stops one pathological page from costing ten cents.
 */
export const MAX_MARKDOWN_CHARS = 12_000;

/**
 * Below this a "successful" scrape returned a cookie banner. Reported as
 * `noRecipeOnPage` rather than `pageBlocked`: the page was reachable, it
 * simply had no recipe on it.
 */
export const MIN_MARKDOWN_CHARS = 200;

/**
 * Only the two fields this app reads. Extra keys are ignored (Zod objects are
 * not strict here on purpose) so FireCrawl *adding* a field never breaks an
 * import; only removing `data.markdown` does, and that is the case this
 * schema exists to catch.
 */
const firecrawlResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ markdown: z.string() }),
});

export type FirecrawlResult =
  | { readonly ok: true; readonly markdown: string }
  /** Any failure at all: refused, wrong shape, or nothing worth reading. */
  | { readonly ok: false; readonly reason: "blocked" | "empty" };

export interface FirecrawlDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export async function firecrawlScrape(
  url: string,
  deps: FirecrawlDeps,
): Promise<FirecrawlResult> {
  // Read here, not at import: CI builds with an empty environment. An absent
  // key is a deployment problem, and the honest answer for *this* import is
  // the same fork every other scrape failure gets — not a 500.
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    return { ok: false, reason: "blocked" };
  }

  let response: Response;

  try {
    response = await deps.fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        // The recipe, not the site's chrome — and a third of the tokens.
        onlyMainContent: true,
      }),
      signal: deps.signal,
    });
  } catch {
    return { ok: false, reason: "blocked" };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, reason: "blocked" };
  }

  // A non-2xx is read for its body first: FireCrawl answers 402 with a JSON
  // body too, and the outcome is the same either way — no markdown.
  return parseFirecrawlResponse(json);
}

/**
 * FireCrawl's answer → markdown, or a reason. Pure, so every shape the API
 * could return is a unit test rather than a production surprise.
 */
export function parseFirecrawlResponse(json: unknown): FirecrawlResult {
  const parsed = firecrawlResponseSchema.safeParse(json);

  if (!parsed.success || !parsed.data.success) {
    return { ok: false, reason: "blocked" };
  }

  const markdown = condenseMarkdown(parsed.data.data.markdown);
  if (markdown.length < MIN_MARKDOWN_CHARS) {
    return { ok: false, reason: "empty" };
  }

  return { ok: true, markdown: markdown.slice(0, MAX_MARKDOWN_CHARS) };
}

/**
 * Strips a scraped page down to its words — **before** the truncation, which
 * is the whole point.
 *
 * Found the hard way against russianfood.com, one of VISION §6.4's three
 * verified sites: its scrape comes back as 58 000 characters of nested
 * table-layout markdown whose first twelve thousand are the logo, the menu,
 * a login box and a share widget. Truncating that hands the model a
 * navigation bar and gets back `isRecipe: false` for a page that has a
 * perfectly good recipe on it. Condensing first leaves 8 000 characters that
 * start with the dish's own heading.
 *
 * Every rule below removes *markup*, never words: a table row keeps its
 * cells, a link keeps its label, an image keeps nothing because it was never
 * text. Cheaper too — the model is billed by the token, and a page of `| ---
 * | --- |` is tokens spent on punctuation.
 */
export function condenseMarkdown(markdown: string): string {
  const lines: string[] = [];

  for (const raw of markdown.split(/\r?\n/)) {
    let line = raw.trim();

    if (line.length === 0) {
      // One blank line survives, so paragraphs stay paragraphs.
      if (lines.at(-1) !== "") {
        lines.push("");
      }
      continue;
    }

    // A table separator row (`| --- | --- |`) is pure layout.
    if (/^\|[\s|:-]*\|?$/.test(line)) {
      continue;
    }

    // A table row keeps its cells, joined — a recipe laid out in a table
    // (which is exactly how russianfood.com writes its ingredients) must not
    // lose a single one of them.
    if (line.startsWith("|")) {
      line = line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0)
        .join(" · ");
    }

    line = line
      // Images first: `![alt](src)` is a link shape too, and reducing it to
      // its alt text would leave stray words from decorative icons.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      // A link keeps its label and drops its href.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();

    // Nothing but punctuation left: a separator, a spacer cell, an icon.
    if (line.length === 0 || !/[\p{L}\p{N}]/u.test(line)) {
      continue;
    }

    lines.push(line);
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

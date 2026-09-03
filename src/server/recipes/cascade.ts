import { parse } from "node-html-parser";

import {
  extractJsonLdNodes,
  findRecipeNode,
  recipeSkeletonFromJsonLd,
} from "@/server/recipes/jsonld";
import { recipeSkeletonFromMicrodata } from "@/server/recipes/microdata";
import { isUsableSkeleton, type RecipeSkeleton } from "@/server/recipes/skeleton";
import { isSocialHost, normalizeHostname } from "@/server/recipes/url-guard";

/**
 * Which branch of the import cascade a page takes (VISION §6.4, blueprint
 * §3.2).
 *
 * ```
 * ссылка ──► JSON-LD Recipe?  ──► да: бесплатно
 *            └─ нет ──► microdata Recipe? ──► да: бесплатно
 *                       └─ нет ──► FireCrawl (платно)
 * инстаграм ──► сразу FireCrawl (прямой fetch отдаёт логин-стену)
 * ```
 *
 * The decision returns the **skeleton it found**, not just a label: deciding
 * and extracting are the same work, and splitting them would mean parsing the
 * document twice — once to choose the branch and once to use it — on a
 * serverless function with a 50-second budget.
 *
 * Free means free: eda.rambler.ru and povar.ru never reach FireCrawl. That is
 * the entire reason this module exists, and the fixtures pin it.
 */
export type UrlStrategy =
  /** A login wall: do not fetch, go straight to FireCrawl. */
  | { readonly kind: "skipFetch" }
  | { readonly kind: "jsonld"; readonly skeleton: RecipeSkeleton }
  | { readonly kind: "microdata"; readonly skeleton: RecipeSkeleton }
  /** Nothing structured — the page has to be scraped and read. */
  | { readonly kind: "firecrawl" };

export interface DecideUrlStrategyArgs {
  readonly url: string;
  /** `null` when the fetch never produced HTML (blocked, dead, not HTML). */
  readonly html: string | null;
}

export function decideUrlStrategy({
  url,
  html,
}: DecideUrlStrategyArgs): UrlStrategy {
  if (isSocialUrl(url)) {
    return { kind: "skipFetch" };
  }

  if (html === null) {
    return { kind: "firecrawl" };
  }

  const extracted = extractPageSkeleton(html);
  return extracted ?? { kind: "firecrawl" };
}

/**
 * JSON-LD first, microdata second — and only if the result is *usable*.
 *
 * A page can carry a `Recipe` node with a name and an image and no
 * ingredients at all (a listing card, a "recipe of the day" teaser). Taking
 * it would mean skipping FireCrawl for a page whose actual recipe we never
 * read, so an unusable skeleton falls through to the next rung exactly like
 * an absent one.
 */
export function extractPageSkeleton(
  html: string,
): { kind: "jsonld" | "microdata"; skeleton: RecipeSkeleton } | null {
  const node = findRecipeNode(extractJsonLdNodes(html));
  if (node !== null) {
    const skeleton = recipeSkeletonFromJsonLd(node);
    if (isUsableSkeleton(skeleton)) {
      return { kind: "jsonld", skeleton };
    }
  }

  const microdata = recipeSkeletonFromMicrodata(html);
  if (microdata !== null && isUsableSkeleton(microdata)) {
    return { kind: "microdata", skeleton: microdata };
  }

  return null;
}

function isSocialUrl(url: string): boolean {
  try {
    return isSocialHost(normalizeHostname(new URL(url).hostname));
  } catch {
    return false;
  }
}

/**
 * The page's own title, for a failed import's «создать вручную».
 *
 * `og:title` before `<title>`: the former is the dish, the latter is usually
 * the dish plus the site's name plus a category trail. Neither is trusted
 * further than a prefilled form field a person is looking at.
 */
export function pageTitle(html: string): string | null {
  const root = parse(html);

  const og = root
    .querySelectorAll("meta")
    .find(
      (meta) =>
        meta.getAttribute("property")?.toLowerCase() === "og:title" ||
        meta.getAttribute("name")?.toLowerCase() === "og:title",
    )
    ?.getAttribute("content");

  const title = og ?? root.querySelector("title")?.text ?? "";
  const collapsed = title.replace(/\s+/g, " ").trim();

  return collapsed.length === 0 ? null : collapsed.slice(0, 200);
}

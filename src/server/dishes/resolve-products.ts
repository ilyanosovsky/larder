import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";

import { aiJobs, categories, products } from "@/db/schema";
import type { RecipeDraft } from "@/lib/recipes/draft";
import type { Unit } from "@/lib/units";
import {
  enrichProducts,
  type EnrichProductsResult,
} from "@/server/ai/enrich-products";
import { formatCostUsd } from "@/server/ai/pricing";
import { aiRateLimitDecision } from "@/server/ai/rate-limit-guard";
import {
  FALLBACK_ICON,
  FALLBACK_UNIT,
  findExistingProduct,
  productColumns,
  toProductOutput,
  type ProductOutput,
} from "@/server/api/routers/product";
import type { TRPCContext } from "@/server/api/trpc";
import { normalizeProductName } from "@/server/catalog/normalize";
import {
  fallbackCategoryId,
  type HouseholdCategory,
} from "@/server/catalog/resolve-category";
import type { CatalogProduct } from "@/server/catalog/search";
import { isUniqueViolation } from "@/server/db-errors";
import {
  isUsableProductName,
  matchIngredients,
} from "@/server/recipes/match-ingredients";

/**
 * The step between «Сохранить блюдо» and the save transaction: every
 * ingredient row that names a product but does not point at one gets a
 * `product_id` (blueprint §3.7, decisions D3/D13/D14).
 *
 * It lives beside the router rather than inside it because it is a whole
 * pipeline of its own — catalog lookup, reference catalog, rate limiter,
 * a billed AI call, savepointed inserts — and `dish.ts` is already the
 * largest router in the repo with `dish.adapt` (task 4.6) still to come.
 * What stays in the router is the transaction and the aggregate; what lives
 * here is everything that decides *which product a row means*.
 *
 * The statement order this module produces is asserted from `dish.test.ts`,
 * through the router, because order across the transaction boundary is the
 * property that matters and only the router can show it.
 */

type Database = TRPCContext["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The slice of a `householdProcedure` context a save actually uses. Named
 * structurally rather than as an intersection of `TRPCContext` so the helpers
 * below can be called from a test with a plain object if that ever helps.
 */
export interface SaveContext {
  db: Database;
  openai: TRPCContext["openai"];
  user: { id: string };
  household: { id: string };
}

/** One product a save is about to mint, and the draft rows that bind to it. */
export interface PendingProduct {
  readonly values: {
    name: string;
    icon: string;
    categoryId: string;
    defaultUnit: Unit;
    aliases: string[];
  };
  /** Indexes into `draft.ingredients` — two rows may name one product. */
  readonly rowIndexes: number[];
}

export interface ResolvedDraft {
  /** `productId` per draft ingredient index; `null` = saved unbound. */
  readonly bound: (string | null)[];
  /** To be inserted inside the transaction, each in its own savepoint. */
  readonly pending: PendingProduct[];
  /** At least one pending product carries fallback values. */
  readonly aiFailed: boolean;
}

/** The household's own catalog, as the matcher needs it. */
async function loadCatalog(
  db: Database,
  householdId: string,
): Promise<CatalogProduct[]> {
  const rows = await db
    .select(productColumns)
    .from(products)
    .where(eq(products.householdId, householdId));

  return rows.map((row) => toProductOutput(row));
}

/** The caller's departments, in walking order — the enrichment's choice set. */
function loadCategories(db: Database, householdId: string) {
  return db
    .select({
      id: categories.id,
      name: categories.name,
      sortOrder: categories.sortOrder,
    })
    .from(categories)
    .where(eq(categories.householdId, householdId))
    .orderBy(asc(categories.sortOrder));
}

/**
 * Turns every unbound ingredient row into either a catalog id or a product
 * the transaction is about to create — **outside any transaction** (D3).
 *
 * The order is the whole design, cheapest first:
 *
 * 1. Rows that already carry a `productId`, and rows whose name holds no
 *    letter and no digit (`isUsableProductName` — «—», «...»), are skipped
 *    outright: punctuation a parse left behind must not become a permanent,
 *    `RESTRICT`-referenced catalog row. The guard is only that, deliberately —
 *    it does not try to judge whether a name reads like a product.
 * 2. The remaining names are **deduplicated by normalized name** before
 *    anything is looked up: «мука» twice in one recipe is one product, one
 *    match and one enrichment slot.
 * 3. `matchIngredients` — the household's own catalog, then the built-in
 *    reference list. Both are free and deterministic.
 *
 *    The catalog is read here rather than reused from `assertProductsOwned`,
 *    which deliberately asks a different question: that one is a scoped
 *    `id IN (…)` set-size check on the handful of ids a client actually sent,
 *    and it must run on every save. Loading the whole catalog up front to
 *    serve both would put a full table read on a save where every row is
 *    already bound — the common case for an edit. One extra read on a save
 *    that has unbound rows is the cheaper half of that trade.
 * 4. Whatever is left goes into **one** batched `enrichProducts` call, behind
 *    the rate limiter and with its own `ai_jobs` row. A refusal or a failure
 *    does not fail the save: the products are created with fallbacks and
 *    `aiFailed` comes back so the form can say «проверь новые продукты».
 *    Losing a recipe someone just spent a minute reviewing, to save a
 *    fraction of a cent, is the wrong trade.
 *
 * **Nothing here runs inside `ctx.db.transaction`**, and that is asserted in
 * the tests as `txDepth === 0`: a 15–40 s OpenAI round trip inside an open
 * transaction would pin a pooled Railway connection and its row locks for the
 * whole call, on a function with a hard duration ceiling.
 */
export async function resolveIngredientProducts(
  ctx: SaveContext,
  draft: RecipeDraft,
): Promise<ResolvedDraft> {
  const householdId = ctx.household.id;
  const bound = draft.ingredients.map((row) => row.productId);

  /** normalized name → the draft rows that want it. */
  const wanted = new Map<string, { name: string; rowIndexes: number[] }>();

  draft.ingredients.forEach((row, index) => {
    if (row.productId !== null || !isUsableProductName(row.name)) {
      return;
    }
    const key = normalizeProductName(row.name);
    const existing = wanted.get(key);
    if (existing) {
      existing.rowIndexes.push(index);
    } else {
      wanted.set(key, { name: row.name, rowIndexes: [index] });
    }
  });

  if (wanted.size === 0) {
    // Nothing to resolve — an edit that only reordered steps costs no reads
    // at all, and `unusableOpenai` in the tests proves no AI call is made.
    return { bound, pending: [], aiFailed: false };
  }

  const catalog = await loadCatalog(ctx.db, householdId);
  const householdCategories = await loadCategories(ctx.db, householdId);
  const firstCategory = householdCategories[0];

  if (!firstCategory) {
    // A household with no departments cannot hold a product at all (in
    // practice impossible — `household.create` seeds seven in the same
    // transaction as the membership). The rows stay unbound, which is a
    // first-class state, rather than the save failing over it.
    return { bound, pending: [], aiFailed: false };
  }

  const targets = [...wanted.values()];
  const matches = matchIngredients({
    names: targets.map((target) => target.name),
    products: catalog,
    categories: householdCategories,
  });

  const pending: PendingProduct[] = [];
  const unknown: number[] = [];

  matches.forEach((match, at) => {
    const target = targets[at];
    if (!target) {
      return;
    }

    if (match.kind === "catalog") {
      for (const index of target.rowIndexes) {
        bound[index] = match.product.id;
      }
      return;
    }

    if (match.kind === "reference") {
      pending.push({
        values: {
          // The reference entry's own capitalization and aliases, not the
          // recipe's wording: «мука» becomes «Мука», and «томаты» will find
          // it later — exactly what `product.create`'s reference path does.
          name: match.ref.name,
          icon: match.ref.icon,
          categoryId: match.categoryId,
          defaultUnit: match.ref.unit,
          aliases: [...match.ref.aliases],
        },
        rowIndexes: target.rowIndexes,
      });
      return;
    }

    unknown.push(at);
  });

  if (unknown.length === 0) {
    return { bound, pending, aiFailed: false };
  }

  const unknownNames = unknown.map((at) => targets[at]?.name ?? "");
  const enrichment = await enrichUnknownProducts(
    ctx,
    unknownNames,
    householdCategories,
  );

  const fallbackId =
    fallbackCategoryId(householdCategories) ?? firstCategory.id;
  let aiFailed = enrichment === null;

  unknown.forEach((at, position) => {
    const target = targets[at];
    if (!target) {
      return;
    }

    const value = enrichment?.values[position] ?? null;
    if (value === null) {
      aiFailed = true;
    }

    pending.push({
      values: {
        name: target.name,
        icon: value?.icon ?? FALLBACK_ICON,
        categoryId: value?.categoryId ?? fallbackId,
        defaultUnit: value?.unit ?? FALLBACK_UNIT,
        aliases: [],
      },
      rowIndexes: target.rowIndexes,
    });
  });

  return { bound, pending, aiFailed };
}

/** Longest name list `ai_jobs.input_ref` carries for one batched enrichment. */
const INPUT_REF_MAX = 500;

/**
 * The one paid step of a save: rate limit, `ai_jobs` row, batched call,
 * `ai_jobs` row closed with its cost. `null` means the call never happened.
 *
 * The job row is written **before** the call, not after: it is what the rate
 * limiter counts, so a burst still in flight already counts against the
 * window. The cost is recorded on the failure branch too — a response that
 * came back and then failed validation was billed all the same, and a ledger
 * that only counts successes under-reports exactly when things go wrong.
 */
async function enrichUnknownProducts(
  ctx: SaveContext,
  names: readonly string[],
  householdCategories: readonly HouseholdCategory[],
): Promise<EnrichProductsResult | null> {
  const decision = await aiRateLimitDecision(ctx.db, ctx.user.id);

  if (!decision.allowed) {
    // Refused, not thrown: `product.create` can afford to say «попробуй через
    // минуту» because retrying costs the user one tap. Here the user is
    // holding a whole reviewed recipe.
    return null;
  }

  const [job] = await ctx.db
    .insert(aiJobs)
    .values({
      householdId: ctx.household.id,
      userId: ctx.user.id,
      type: "product_enrich",
      status: "running",
      inputRef: names.join(", ").slice(0, INPUT_REF_MAX),
    })
    .returning({ id: aiJobs.id });

  let result: EnrichProductsResult;
  try {
    result = await enrichProducts({
      client: ctx.openai(),
      names,
      categories: householdCategories,
    });
  } catch (error) {
    // `enrichProducts` itself never throws; this catches `ctx.openai()`
    // failing to build a client at all — a malformed OPENAI_API_KEY, say.
    result = {
      values: names.map(() => null),
      error: error instanceof Error ? error.message : String(error),
      usage: null,
      costUsd: 0,
    };
  }

  if (job) {
    await ctx.db
      .update(aiJobs)
      .set(
        result.error === null
          ? {
              status: "done",
              outputJson: { values: result.values },
              costUsd: formatCostUsd(result.costUsd),
              finishedAt: sql`now()`,
            }
          : {
              status: "error",
              error: result.error,
              costUsd: formatCostUsd(result.costUsd),
              finishedAt: sql`now()`,
            },
      )
      .where(
        and(eq(aiJobs.id, job.id), eq(aiJobs.householdId, ctx.household.id)),
      );
  }

  return result;
}

/**
 * Inserts one catalog product **inside a savepoint**, or reads back the row
 * that beat us to it.
 *
 * The savepoint is not decoration (D14, and the lesson `cart.ts`'s
 * `insertActiveItem` already encodes): in Postgres a 23505 aborts the *whole*
 * enclosing transaction, so catching it without one would leave every
 * following statement — the dish, the recipe, both child tables — failing
 * with 25P02, and the recovery read would never reach the winner's row.
 *
 * `created` distinguishes "we minted it" from "someone else already had it",
 * so the form's «Создано N новых продуктов» counts what actually appeared in
 * the catalog rather than what this save happened to look up.
 */
async function insertCatalogProduct(
  tx: Transaction,
  values: {
    householdId: string;
    createdBy: string;
    name: string;
    icon: string;
    categoryId: string;
    defaultUnit: Unit;
    aliases: string[];
  },
): Promise<{ product: ProductOutput; created: boolean }> {
  try {
    const [inserted] = await tx.transaction((savepoint) =>
      savepoint
        .insert(products)
        .values({
          ...values,
          // Derived here, never by the caller: `name` and `normalized_name`
          // are one value in two forms, and the unique index is built on the
          // second one.
          normalizedName: normalizeProductName(values.name),
        })
        .returning(productColumns),
    );

    if (inserted) {
      return { product: toProductOutput(inserted), created: true };
    }
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }

  const existing = await findExistingProduct(
    tx,
    values.householdId,
    values.name,
  );
  if (existing) {
    return { product: existing, created: false };
  }

  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Product insert returned no row",
  });
}

/**
 * Creates every pending product and fills the bindings the ingredient rows
 * are about to be written with. Sequential on purpose: each insert owns a
 * savepoint, and a concurrent pair inside one transaction has no meaning.
 */
export async function createPendingProducts(
  tx: Transaction,
  householdId: string,
  userId: string,
  pending: readonly PendingProduct[],
  bound: (string | null)[],
): Promise<ProductOutput[]> {
  const created: ProductOutput[] = [];

  for (const item of pending) {
    const outcome = await insertCatalogProduct(tx, {
      householdId,
      createdBy: userId,
      ...item.values,
    });

    for (const index of item.rowIndexes) {
      bound[index] = outcome.product.id;
    }

    if (outcome.created) {
      created.push(outcome.product);
    }
  }

  return created;
}

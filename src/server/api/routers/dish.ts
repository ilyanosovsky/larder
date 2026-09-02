import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  aiJobs,
  categories,
  dishes,
  pantryItems,
  products,
  recipeIngredients,
  recipes,
  recipeSteps,
} from "@/db/schema";
import {
  dishSourceTypeSchema,
  normalizeDraftForSave,
  recipeDraftSchema,
  type RecipeDraft,
} from "@/lib/recipes/draft";
import { recipeUnitSchema, type Unit, type RecipeUnit } from "@/lib/units";
import {
  enrichProducts,
  type EnrichProductsResult,
} from "@/server/ai/enrich-products";
import { formatCostUsd } from "@/server/ai/pricing";
import { aiRateLimitDecision } from "@/server/ai/rate-limit-guard";
import {
  createTRPCRouter,
  householdProcedure,
  type TRPCContext,
} from "@/server/api/trpc";
import {
  FALLBACK_ICON,
  FALLBACK_UNIT,
  findExistingProduct,
  productColumns,
  productOutput,
  toProductOutput,
  type ProductOutput,
} from "@/server/api/routers/product";
import { normalizeProductName } from "@/server/catalog/normalize";
import {
  fallbackCategoryId,
  type HouseholdCategory,
} from "@/server/catalog/resolve-category";
import type { CatalogProduct } from "@/server/catalog/search";
import { isUniqueViolation } from "@/server/db-errors";
import { normalizeDishTitle } from "@/server/dishes/normalize";
import {
  isUsableProductName,
  matchIngredients,
} from "@/server/recipes/match-ingredients";
import { deriveNeedsReview } from "@/server/recipes/needs-review";

type Database = TRPCContext["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * A dish library row as S6 renders it (DESIGN_BRIEF S6): the card's photo,
 * title, tags and meta line, plus the two counts behind the quiet amber dot.
 *
 * No ingredients and no steps — a grid of tiles that carried its recipes
 * would be N times the payload for a screen that shows none of it.
 */
export const dishListItemOutput = z.object({
  id: z.uuid(),
  title: z.string(),
  photoUrl: z.string().nullable(),
  tags: z.array(z.string()),
  sourceType: dishSourceTypeSchema,
  totalTimeMin: z.int().nullable(),
  portionsBase: z.int(),
  portionsMin: z.int().nullable(),
  yieldUnit: z.string().nullable(),
  ingredientCount: z.int(),
  /** How many rows still wear the amber chip — S6's «есть что уточнить» dot. */
  needsReviewCount: z.int(),
  version: z.int(),
  createdAt: z.date(),
});

/**
 * One ingredient row of S7.
 *
 * `unit` is `RECIPE_UNITS`-validated **on read** and degraded to `null` for
 * anything unrecognized — the column is `text`, and one row holding a retired
 * measure must not fail the whole dish's output validation (the same
 * reasoning `cart.ts`'s `FALLBACK_UNIT` encodes, with `null` as the honest
 * degradation here: a recipe may legitimately state no unit at all).
 */
export const dishIngredientOutput = z.object({
  id: z.uuid(),
  productId: z.uuid().nullable(),
  productName: z.string().nullable(),
  productIcon: z.string().nullable(),
  categoryId: z.uuid().nullable(),
  rawText: z.string(),
  name: z.string(),
  qty: z.number().nullable(),
  unit: recipeUnitSchema.nullable(),
  note: z.string().nullable(),
  isOptional: z.boolean(),
  needsReview: z.boolean(),
  sortOrder: z.int(),
  /** «· дома есть ✓» — a `pantry_items` join, computed server-side. */
  inPantry: z.boolean(),
});

export const dishStepOutput = z.object({
  id: z.uuid(),
  stepOrder: z.int(),
  text: z.string(),
  timerSec: z.int().nullable(),
  timerMaxSec: z.int().nullable(),
});

export const dishDetailOutput = z.object({
  id: z.uuid(),
  title: z.string(),
  photoUrl: z.string().nullable(),
  photoKey: z.string().nullable(),
  tags: z.array(z.string()),
  sourceType: dishSourceTypeSchema,
  sourceUrl: z.string().nullable(),
  version: z.int(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  recipe: z.object({
    id: z.uuid(),
    portionsBase: z.int(),
    portionsMin: z.int().nullable(),
    yieldUnit: z.string().nullable(),
    totalTimeMin: z.int().nullable(),
    equipment: z.array(z.string()),
    adaptedAt: z.date().nullable(),
    adaptedNote: z.string().nullable(),
    /** The flag only — S7 never needs the draft itself, and it is large. */
    hasOriginalDraft: z.boolean(),
  }),
  ingredients: z.array(dishIngredientOutput),
  steps: z.array(dishStepOutput),
});

export const dishIdInput = z.object({ id: z.uuid() });

export const createDishInput = z.object({
  draft: recipeDraftSchema,
  /** Set by an import: stored verbatim as `recipes.original_draft`. */
  originalDraft: recipeDraftSchema.nullable(),
  /** The import job this save came from, so it can be marked consumed. */
  jobId: z.uuid().nullable(),
});

/**
 * What both `create` and `update` answer — the same three facts, because the
 * S8.3 form asks the same question either way: what did I just save, what did
 * it cost the catalog, and does anything need a second look.
 */
export const saveDishOutput = z.object({
  dish: dishDetailOutput,
  /**
   * Products minted from unbound ingredient rows, for the form's «Создано N
   * новых продуктов». A reference-catalog hit and an AI-enriched name both
   * land here — from the household's point of view they are the same event.
   */
  createdProducts: z.array(productOutput),
  /**
   * At least one of those products was created with fallback values: the
   * batched enrichment was refused by the rate limiter, failed outright, or
   * skipped that name. The dish is saved either way — the form only says
   * «проверь новые продукты».
   */
  aiFailed: z.boolean(),
});

export const updateDishInput = z.object({
  id: z.uuid(),
  /** The aggregate `version` the editor started from; see `dishes` in schema.ts. */
  expectedVersion: z.int(),
  draft: recipeDraftSchema,
});

export const archiveDishInput = z.object({
  id: z.uuid(),
  expectedVersion: z.int(),
});

export const archiveDishOutput = z.object({
  id: z.uuid(),
  /** The bumped token, so an undo can pass it straight back as `expectedVersion`. */
  version: z.int(),
});

export type DishListItemOutput = z.infer<typeof dishListItemOutput>;
export type DishDetailOutput = z.infer<typeof dishDetailOutput>;
export type DishIngredientOutput = z.infer<typeof dishIngredientOutput>;
export type DishStepOutput = z.infer<typeof dishStepOutput>;

/** A stored unit the app no longer recognizes reads back as "unstated". */
function toRecipeUnit(value: string | null): RecipeUnit | null {
  if (value === null) {
    return null;
  }
  const parsed = recipeUnitSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The library query, minus the one predicate that separates the two lists.
 *
 * The counts are aggregated in the database rather than by returning the
 * ingredient rows themselves — S6 shows a number and a dot, nothing else —
 * the same shape `trip.list` uses for «N позиций». The `INNER JOIN` to
 * `recipes` is safe because the pair is created together in one transaction
 * and `recipes_dishId_uidx` keeps it 1:1; a dish with no recipe would be a
 * broken row, and hiding it is better than rendering a card that cannot open.
 *
 * Both joins repeat `household_id`. `recipes.dish_id` already only ever
 * points at this household's dishes, but a statement has to read as scoped on
 * its own rather than by an argument about another table (VISION §6.7).
 */
function dishListQuery(db: Database, householdId: string) {
  return db
    .select({
      id: dishes.id,
      title: dishes.title,
      photoUrl: dishes.photoUrl,
      tags: dishes.tags,
      sourceType: dishes.sourceType,
      totalTimeMin: recipes.totalTimeMin,
      portionsBase: recipes.portionsBase,
      portionsMin: recipes.portionsMin,
      yieldUnit: recipes.yieldUnit,
      version: dishes.version,
      createdAt: dishes.createdAt,
      // `::int` because `count()` is `bigint`, which the driver hands back as
      // a string — the Zod output would reject it, loudly but for the wrong
      // reason. Same treatment as `trip.list`'s own count.
      ingredientCount: sql<number>`count(${recipeIngredients.id})::int`,
      needsReviewCount: sql<number>`count(*) filter (where ${recipeIngredients.needsReview})::int`,
    })
    .from(dishes)
    .innerJoin(
      recipes,
      and(
        eq(recipes.dishId, dishes.id),
        eq(recipes.householdId, householdId),
      ),
    )
    .leftJoin(
      recipeIngredients,
      and(
        eq(recipeIngredients.recipeId, recipes.id),
        eq(recipeIngredients.householdId, householdId),
      ),
    )
    .groupBy(dishes.id, recipes.id);
}

/**
 * The whole aggregate in three scoped selects, or `null` when the id names
 * nothing this household owns.
 *
 * The dish read comes **first and alone**: an id from another household has
 * to be refused before anything else runs, not filtered out of a join at the
 * end (VISION §6.7, and `dish.test.ts` asserts nothing beyond it is issued).
 *
 * `inPantry` rides inside this read as a `LEFT JOIN pantry_items` rather than
 * being cross-referenced against the client's `pantry.list` cache:
 * `pantry_items` is unique on `product_id`, so the join cannot fan out, and a
 * second cache entry could disagree with the ✓ mark on screen. An unbound
 * ingredient (`product_id IS NULL`) matches nothing and reads as `false` — a
 * row nobody has bound to a product cannot be «дома есть».
 */
async function readDishDetail(
  db: Database,
  householdId: string,
  dishId: string,
): Promise<DishDetailOutput | null> {
  const [row] = await db
    .select({
      id: dishes.id,
      title: dishes.title,
      photoUrl: dishes.photoUrl,
      photoKey: dishes.photoKey,
      tags: dishes.tags,
      sourceType: dishes.sourceType,
      sourceUrl: dishes.sourceUrl,
      version: dishes.version,
      archivedAt: dishes.archivedAt,
      createdAt: dishes.createdAt,
      updatedAt: dishes.updatedAt,
      recipeId: recipes.id,
      portionsBase: recipes.portionsBase,
      portionsMin: recipes.portionsMin,
      yieldUnit: recipes.yieldUnit,
      totalTimeMin: recipes.totalTimeMin,
      equipment: recipes.equipment,
      adaptedAt: recipes.adaptedAt,
      adaptedNote: recipes.adaptedNote,
      originalDraft: recipes.originalDraft,
    })
    .from(dishes)
    .innerJoin(
      recipes,
      and(eq(recipes.dishId, dishes.id), eq(recipes.householdId, householdId)),
    )
    .where(and(eq(dishes.id, dishId), eq(dishes.householdId, householdId)))
    .limit(1);

  if (!row) {
    return null;
  }

  const ingredientRows = await db
    .select({
      id: recipeIngredients.id,
      productId: recipeIngredients.productId,
      rawText: recipeIngredients.rawText,
      name: recipeIngredients.name,
      qty: recipeIngredients.qty,
      unit: recipeIngredients.unit,
      note: recipeIngredients.note,
      isOptional: recipeIngredients.isOptional,
      needsReview: recipeIngredients.needsReview,
      sortOrder: recipeIngredients.sortOrder,
      productName: products.name,
      productIcon: products.icon,
      categoryId: products.categoryId,
      pantryItemId: pantryItems.id,
    })
    .from(recipeIngredients)
    .leftJoin(
      products,
      and(
        eq(products.id, recipeIngredients.productId),
        eq(products.householdId, householdId),
      ),
    )
    .leftJoin(
      pantryItems,
      and(
        eq(pantryItems.productId, recipeIngredients.productId),
        eq(pantryItems.householdId, householdId),
      ),
    )
    .where(
      and(
        eq(recipeIngredients.recipeId, row.recipeId),
        eq(recipeIngredients.householdId, householdId),
      ),
    )
    .orderBy(asc(recipeIngredients.sortOrder), asc(recipeIngredients.id));

  const stepRows = await db
    .select({
      id: recipeSteps.id,
      stepOrder: recipeSteps.stepOrder,
      text: recipeSteps.text,
      timerSec: recipeSteps.timerSec,
      timerMaxSec: recipeSteps.timerMaxSec,
    })
    .from(recipeSteps)
    .where(
      and(
        eq(recipeSteps.recipeId, row.recipeId),
        eq(recipeSteps.householdId, householdId),
      ),
    )
    .orderBy(asc(recipeSteps.stepOrder), asc(recipeSteps.id));

  return {
    id: row.id,
    title: row.title,
    photoUrl: row.photoUrl,
    photoKey: row.photoKey,
    tags: row.tags,
    sourceType: row.sourceType,
    sourceUrl: row.sourceUrl,
    version: row.version,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    recipe: {
      id: row.recipeId,
      portionsBase: row.portionsBase,
      portionsMin: row.portionsMin,
      yieldUnit: row.yieldUnit,
      totalTimeMin: row.totalTimeMin,
      equipment: row.equipment,
      adaptedAt: row.adaptedAt,
      adaptedNote: row.adaptedNote,
      hasOriginalDraft: row.originalDraft !== null,
    },
    ingredients: ingredientRows.map((ingredient) => ({
      id: ingredient.id,
      productId: ingredient.productId,
      productName: ingredient.productName,
      productIcon: ingredient.productIcon,
      categoryId: ingredient.categoryId,
      rawText: ingredient.rawText,
      name: ingredient.name,
      qty: ingredient.qty,
      unit: toRecipeUnit(ingredient.unit),
      note: ingredient.note,
      isOptional: ingredient.isOptional,
      needsReview: ingredient.needsReview,
      sortOrder: ingredient.sortOrder,
      inPantry: ingredient.pantryItemId !== null,
    })),
    steps: stepRows,
  };
}

/**
 * Every non-null `productId` in the draft, checked against the caller's own
 * catalog in **one** scoped select, before any write.
 *
 * This is the mandated guard for a foreign id arriving from the client
 * (VISION §6.7): the foreign key proves the product exists somewhere, not
 * that it exists in this household. A set-size mismatch is the whole test —
 * an id that belongs to a partner household simply does not come back.
 */
async function assertProductsOwned(
  db: Database,
  householdId: string,
  draft: RecipeDraft,
): Promise<void> {
  const ids = [
    ...new Set(
      draft.ingredients
        .map((row) => row.productId)
        .filter((id): id is string => id !== null),
    ),
  ];

  if (ids.length === 0) {
    return;
  }

  const owned = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.householdId, householdId), inArray(products.id, ids)));

  if (owned.length !== ids.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Unknown product in the recipe",
    });
  }
}

/**
 * The slice of a `householdProcedure` context a save actually uses. Named
 * structurally rather than as an intersection of `TRPCContext` so the helpers
 * below can be called from a test with a plain object if that ever helps.
 */
interface SaveContext {
  db: Database;
  openai: TRPCContext["openai"];
  user: { id: string };
  household: { id: string };
}

/** One product a save is about to mint, and the draft rows that bind to it. */
interface PendingProduct {
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

interface ResolvedDraft {
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
 * 1. Rows that already carry a `productId`, and rows whose name could never be
 *    a product (`isUsableProductName`), are skipped outright. A bad parse must
 *    not mint «(см. шаг 3)» as a permanent, `RESTRICT`-referenced catalog row.
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
async function resolveIngredientProducts(
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

  const fallbackId = fallbackCategoryId(householdCategories) ?? firstCategory.id;
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

  const existing = await findExistingProduct(tx, values.householdId, values.name);
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
async function createPendingProducts(
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

/** The children of a saved recipe, with freshly minted `0..n-1` orders. */
function childRows(
  householdId: string,
  recipeId: string,
  draft: RecipeDraft,
  bound: readonly (string | null)[],
): {
  ingredients: (typeof recipeIngredients.$inferInsert)[];
  steps: (typeof recipeSteps.$inferInsert)[];
} {
  return {
    ingredients: draft.ingredients.map((row, index) => ({
      householdId,
      recipeId,
      // The resolved binding, not the one that came off the wire: the client
      // may only ever say «this is product X» or «I don't know», and the
      // second answer is the server's to fill in.
      productId: bound[index] ?? null,
      rawText: row.rawText,
      name: row.name,
      qty: row.qty,
      unit: row.unit,
      note: row.note,
      isOptional: row.isOptional,
      // Recomputed at the statement that writes the column, never copied off
      // the wire: this is the only place the amber chip's truth is decided.
      needsReview: deriveNeedsReview(row),
      sortOrder: index,
    })),
    steps: draft.steps.map((step, index) => ({
      householdId,
      recipeId,
      stepOrder: index,
      text: step.text,
      timerSec: step.timerSec,
      timerMaxSec: step.timerMaxSec,
    })),
  };
}

/**
 * Normalizes the incoming draft and enforces the one rule the schema itself
 * deliberately does not: **a saved recipe has at least one ingredient.**
 *
 * `recipeDraftSchema` allows zero, because a parse that produced steps but no
 * ingredient list must still reach the review form so a human can type them.
 * Saving one is a different question, and this is where it is asked.
 */
function draftForSave(draft: RecipeDraft): RecipeDraft {
  const normalized = normalizeDraftForSave(draft);

  if (normalized.ingredients.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A dish needs at least one ingredient",
    });
  }

  return normalized;
}

/**
 * The dish library (VISION §3.3, DESIGN_BRIEF S6/S7) — the model phase 5's
 * week menu and phase 6's assistant are both built on.
 *
 * **No `dish.delete`.** Archiving is the only removal path: `menu_items`
 * (task 5.1) and «повторить неделю» (5.3) must keep the dish a stored week
 * names, and a hard delete would either cascade that history away or start
 * throwing 23503 at the user.
 *
 * **No `lockHousehold()` anywhere in this router, deliberately.** That
 * advisory lock (`src/server/household-lock.ts`) exists for exactly one
 * reason: `trip.close` walks cart → pantry while `pantry.ranOut` walks pantry
 * → cart, and two of them at once is a lock-order cycle Postgres resolves by
 * aborting one with 40P01. A dish save touches neither table — it writes
 * `dishes`, `recipes` and their children, and (from task 4.2) inserts into
 * `products` — so there is no cycle to break, and taking the lock would
 * serialize every «Сохранить блюдо» behind every shopping action for nothing.
 * The concurrency this router *does* have to answer for is two people editing
 * one dish, and that is what `dishes.version` and the `FOR UPDATE` in
 * `update` are for.
 */
export const dishRouter = createTRPCRouter({
  /**
   * The library, newest first (DESIGN_BRIEF S6 is a grid you keep importing
   * into, so the dish just added belongs top-left; `id` is the tiebreak that
   * keeps the order stable for two dishes saved in the same millisecond).
   *
   * **No input**: search and tag filtering are client-side (`filterDishes`,
   * `src/lib/recipes/filter-dishes.ts`), so one cache entry serves the whole
   * screen and no keystroke costs a round trip. The documented threshold for
   * revisiting that is ~200 dishes.
   */
  list: householdProcedure
    .output(z.array(dishListItemOutput))
    .query(({ ctx }) =>
      dishListQuery(ctx.db, ctx.household.id)
        .where(
          and(
            eq(dishes.householdId, ctx.household.id),
            isNull(dishes.archivedAt),
          ),
        )
        .orderBy(desc(dishes.createdAt), desc(dishes.id)),
    ),

  /**
   * The archive, most recently archived first — S12's «Архив блюд» block, and
   * the only place a dish that left the library can be found again.
   */
  listArchived: householdProcedure
    .output(z.array(dishListItemOutput))
    .query(({ ctx }) =>
      dishListQuery(ctx.db, ctx.household.id)
        .where(
          and(
            eq(dishes.householdId, ctx.household.id),
            isNotNull(dishes.archivedAt),
          ),
        )
        .orderBy(desc(dishes.archivedAt), desc(dishes.id)),
    ),

  /** One dish with its whole recipe — S7, and the seed for S8.3's edit mode. */
  get: householdProcedure
    .input(dishIdInput)
    .output(dishDetailOutput)
    .query(async ({ ctx, input }) => {
      const detail = await readDishDetail(ctx.db, ctx.household.id, input.id);

      if (!detail) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Unknown dish" });
      }

      return detail;
    }),

  /**
   * Saves a new dish and its recipe as one aggregate.
   *
   * The order is the whole design (blueprint §3.7):
   *
   * 1. **Outside any transaction** — every client-sent `productId` is checked
   *    against this household's catalog, and the unbound rows are resolved
   *    (`resolveIngredientProducts`): reference catalog first, then one
   *    batched AI call. A 15–40 s OpenAI round trip inside an open
   *    transaction would pin a pooled Railway connection and row locks on a
   *    Vercel function.
   * 2. **Inside one transaction** — the products those unbound rows need
   *    (each in its own savepoint), then the dish, the recipe and both child
   *    tables, so a save is all or nothing.
   *
   * **This procedure is not idempotent, and `recipes_dishId_uidx` does not
   * make it so.** Every call mints a fresh `dishes.id`, and the recipe hangs
   * off that brand-new id, so the unique index can never fire on this path —
   * what it protects is the 1:1 shape against any future writer that inserts
   * a second recipe for an *existing* dish. A duplicate submit therefore
   * produces a second complete dish; the only planned defence is the
   * synchronous ref lock on «Сохранить блюдо» (task 4.2), and `input.jobId`
   * is recorded but never checked, so it is not an idempotency key either.
   * Turning it into one — read `output_json->>'consumedDishId'` under `FOR
   * UPDATE` and return the dish it names — is the option task 4.3 has when
   * the import path makes a retry likely. Duplicate dishes break no
   * invariant (`normalized_title` is deliberately not unique), which is why
   * this is a known gap rather than a bug.
   * 3. **After the commit** — the aggregate is re-read and returned. Outside
   *    the transaction on purpose: it carries its own `version`, so reading a
   *    state a partner has already moved on from is not a lie, while holding
   *    the write's locks through three more round trips would be a real cost.
   *
   * `original_draft` is written only here, only from an import: it is the
   * base task 4.6 diffs its adaptation against and reverts to.
   */
  create: householdProcedure
    .input(createDishInput)
    .output(saveDishOutput)
    .mutation(async ({ ctx, input }) => {
      const householdId = ctx.household.id;
      const draft = draftForSave(input.draft);

      await assertProductsOwned(ctx.db, householdId, draft);

      const resolved = await resolveIngredientProducts(ctx, draft);
      const bound = [...resolved.bound];

      const saved = await ctx.db.transaction(async (tx) => {
        const createdProducts = await createPendingProducts(
          tx,
          householdId,
          ctx.user.id,
          resolved.pending,
          bound,
        );

        const [dish] = await tx
          .insert(dishes)
          .values({
            householdId,
            title: draft.title,
            normalizedTitle: normalizeDishTitle(draft.title),
            photoUrl: draft.photoUrl,
            photoKey: draft.photoKey,
            tags: draft.tags,
            sourceType: draft.sourceType,
            sourceUrl: draft.sourceUrl,
            createdBy: ctx.user.id,
          })
          .returning({ id: dishes.id });

        if (!dish) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Creating a dish inserted no row",
          });
        }

        const [recipe] = await tx
          .insert(recipes)
          .values({
            householdId,
            dishId: dish.id,
            portionsBase: draft.portionsBase,
            portionsMin: draft.portionsMin,
            yieldUnit: draft.yieldUnit,
            totalTimeMin: draft.totalTimeMin,
            equipment: draft.equipment,
            originalDraft: input.originalDraft,
          })
          .returning({ id: recipes.id });

        if (!recipe) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Creating a dish inserted no recipe",
          });
        }

        const children = childRows(householdId, recipe.id, draft, bound);

        await tx.insert(recipeIngredients).values(children.ingredients);

        if (children.steps.length > 0) {
          await tx.insert(recipeSteps).values(children.steps);
        }

        if (input.jobId !== null) {
          // Marks the import job consumed so `/dishes/import/[jobId]` can
          // redirect to the saved dish instead of re-rendering a draft the
          // household already turned into a recipe. `coalesce` because a job
          // row may legitimately have no `output_json` yet, and `jsonb_set`
          // on NULL returns NULL — which would erase the ledger entry rather
          // than annotate it.
          await tx
            .update(aiJobs)
            .set({
              outputJson: sql`jsonb_set(coalesce(${aiJobs.outputJson}, '{}'::jsonb), '{consumedDishId}', to_jsonb(${dish.id}::text), true)`,
            })
            .where(
              and(
                eq(aiJobs.id, input.jobId),
                eq(aiJobs.householdId, householdId),
              ),
            );
        }

        return { dishId: dish.id, createdProducts };
      });

      const detail = await readDishDetail(ctx.db, householdId, saved.dishId);

      if (!detail) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Created dish could not be read back",
        });
      }

      return {
        dish: detail,
        createdProducts: saved.createdProducts,
        aiFailed: resolved.aiFailed,
      };
    }),

  /**
   * Replaces a dish's recipe wholesale, guarded by the aggregate `version`.
   *
   * **Full replace, not a diff.** Nothing holds a `recipe_ingredients.id`
   * durably — phase 5.2's cart build reads them transiently — so churning
   * child ids costs nothing and buys a save path with no reorder-or-merge
   * logic to get wrong.
   *
   * **The `SELECT … FOR UPDATE` is the concurrency answer.** It reads the
   * version under a row lock, so a stale `expectedVersion` is a `CONFLICT`
   * the editor can act on («Блюдо изменили — обновить?») rather than a silent
   * overwrite of a partner's edit, and two saves racing on the same dish
   * serialize instead of interleaving their child deletes and inserts. The
   * `UPDATE` repeats the version predicate anyway — defence in depth, at the
   * cost of one comparison.
   */
  update: householdProcedure
    .input(updateDishInput)
    .output(saveDishOutput)
    .mutation(async ({ ctx, input }) => {
      const householdId = ctx.household.id;
      const draft = draftForSave(input.draft);

      // The version is read **before** anything is resolved, so a stale
      // editor is refused before it can spend an AI call and mint products
      // for a save that was never going to land. The `FOR UPDATE` read inside
      // the transaction below is still the real guard — this one only closes
      // the common case cheaply; between the two, a partner's write turns
      // into the same `CONFLICT`, one round trip later.
      const [current] = await ctx.db
        .select({ version: dishes.version })
        .from(dishes)
        .where(
          and(eq(dishes.id, input.id), eq(dishes.householdId, householdId)),
        )
        .limit(1);

      if (!current) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Unknown dish" });
      }

      if (current.version !== input.expectedVersion) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "The dish changed since it was opened",
        });
      }

      await assertProductsOwned(ctx.db, householdId, draft);

      const resolved = await resolveIngredientProducts(ctx, draft);
      const bound = [...resolved.bound];

      const createdProducts = await ctx.db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ version: dishes.version })
          .from(dishes)
          .where(
            and(eq(dishes.id, input.id), eq(dishes.householdId, householdId)),
          )
          .limit(1)
          .for("update");

        if (!locked) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Unknown dish" });
        }

        if (locked.version !== input.expectedVersion) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The dish changed since it was opened",
          });
        }

        const [recipe] = await tx
          .select({ id: recipes.id })
          .from(recipes)
          .where(
            and(
              eq(recipes.dishId, input.id),
              eq(recipes.householdId, householdId),
            ),
          )
          .limit(1);

        if (!recipe) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Dish has no recipe",
          });
        }

        const created = await createPendingProducts(
          tx,
          householdId,
          ctx.user.id,
          resolved.pending,
          bound,
        );

        const [updated] = await tx
          .update(dishes)
          .set({
            title: draft.title,
            normalizedTitle: normalizeDishTitle(draft.title),
            photoUrl: draft.photoUrl,
            photoKey: draft.photoKey,
            tags: draft.tags,
            sourceType: draft.sourceType,
            sourceUrl: draft.sourceUrl,
            version: sql`${dishes.version} + 1`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(dishes.id, input.id),
              eq(dishes.householdId, householdId),
              eq(dishes.version, input.expectedVersion),
            ),
          )
          .returning({ id: dishes.id });

        if (!updated) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "The dish changed since it was opened",
          });
        }

        // `original_draft` is deliberately absent: it records what the import
        // produced, and an edit is exactly the thing task 4.6 needs to be
        // able to revert *past*.
        await tx
          .update(recipes)
          .set({
            portionsBase: draft.portionsBase,
            portionsMin: draft.portionsMin,
            yieldUnit: draft.yieldUnit,
            totalTimeMin: draft.totalTimeMin,
            equipment: draft.equipment,
          })
          .where(
            and(
              eq(recipes.id, recipe.id),
              eq(recipes.householdId, householdId),
            ),
          );

        await tx
          .delete(recipeIngredients)
          .where(
            and(
              eq(recipeIngredients.recipeId, recipe.id),
              eq(recipeIngredients.householdId, householdId),
            ),
          );

        await tx
          .delete(recipeSteps)
          .where(
            and(
              eq(recipeSteps.recipeId, recipe.id),
              eq(recipeSteps.householdId, householdId),
            ),
          );

        const children = childRows(householdId, recipe.id, draft, bound);

        await tx.insert(recipeIngredients).values(children.ingredients);

        if (children.steps.length > 0) {
          await tx.insert(recipeSteps).values(children.steps);
        }

        return created;
      });

      const detail = await readDishDetail(ctx.db, householdId, input.id);

      if (!detail) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Updated dish could not be read back",
        });
      }

      return { dish: detail, createdProducts, aiFailed: resolved.aiFailed };
    }),

  /**
   * Takes a dish out of the library without losing it (VISION §3.3): S6 stops
   * listing it, S12's «Архив блюд» keeps it, and every week menu that names
   * it (phase 5) still resolves.
   *
   * Guarded by `expectedVersion` like a save, so «В архив» tapped on a stale
   * card cannot quietly hide a dish a partner has just rewritten — and so the
   * undo toast gets a fresh token back to pass to `unarchive`.
   */
  archive: householdProcedure
    .input(archiveDishInput)
    .output(archiveDishOutput)
    .mutation(({ ctx, input }) =>
      setArchived(ctx.db, ctx.household.id, input, true),
    ),

  /** The undo, and S12's «Вернуть». Same guard, opposite direction. */
  unarchive: householdProcedure
    .input(archiveDishInput)
    .output(archiveDishOutput)
    .mutation(({ ctx, input }) =>
      setArchived(ctx.db, ctx.household.id, input, false),
    ),
});

/**
 * One `UPDATE` for both directions, plus one read that only runs when it
 * changed nothing.
 *
 * The write is scoped by id, household, `expectedVersion` **and** the archive
 * state it expects to find — so a second «В архив» on a dish already archived
 * matches nothing rather than bumping the version again. Telling `NOT_FOUND`
 * apart from `CONFLICT` then needs the row itself, which is why the extra
 * select exists and why it only runs on the failure path: the screen's two
 * answers are «блюда больше нет» and «его изменили», and collapsing them into
 * one message would leave the user guessing which happened.
 */
async function setArchived(
  db: Database,
  householdId: string,
  input: z.infer<typeof archiveDishInput>,
  archived: boolean,
): Promise<z.infer<typeof archiveDishOutput>> {
  const [updated] = await db
    .update(dishes)
    .set({
      archivedAt: archived ? sql`now()` : null,
      version: sql`${dishes.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(dishes.id, input.id),
        eq(dishes.householdId, householdId),
        eq(dishes.version, input.expectedVersion),
        archived ? isNull(dishes.archivedAt) : isNotNull(dishes.archivedAt),
      ),
    )
    .returning({ id: dishes.id, version: dishes.version });

  if (updated) {
    return updated;
  }

  const [current] = await db
    .select({ id: dishes.id })
    .from(dishes)
    .where(and(eq(dishes.id, input.id), eq(dishes.householdId, householdId)))
    .limit(1);

  if (!current) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Unknown dish" });
  }

  throw new TRPCError({
    code: "CONFLICT",
    message: "The dish changed since it was opened",
  });
}

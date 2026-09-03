import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  aiJobs,
  dishes,
  kitchenProfiles,
  pantryItems,
  products,
  recipeIngredients,
  recipes,
  recipeSteps,
} from "@/db/schema";
import {
  dishSourceTypeSchema,
  draftFromDetail,
  MAX_PORTIONS,
  normalizeDraftForSave,
  recipeDraftSchema,
  type RecipeDraft,
} from "@/lib/recipes/draft";
import { recipeUnitSchema, type RecipeUnit } from "@/lib/units";
import { adaptRecipe } from "@/server/ai/adapt-recipe";
import { formatCostUsd } from "@/server/ai/pricing";
import { assertWithinRateLimit } from "@/server/ai/rate-limit-guard";
import {
  createTRPCRouter,
  householdProcedure,
  type TRPCContext,
} from "@/server/api/trpc";
import { productOutput } from "@/server/api/routers/product";
import { normalizeDishTitle } from "@/server/dishes/normalize";
import {
  createPendingProducts,
  resolveIngredientProducts,
} from "@/server/dishes/resolve-products";
import { applyAdaptation, rescaleDraft } from "@/server/recipes/adapt";
import { coerceEquipmentList } from "@/server/recipes/coerce-equipment";
import { missingEquipment } from "@/server/recipes/equipment-check";
import { deriveNeedsReview } from "@/server/recipes/needs-review";

type Database = TRPCContext["db"];

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

/**
 * The longest machine-written «переделано под твою духовку» line S7 will
 * render. One phrase, not a paragraph — the summary is a label above the
 * ingredient list, and anything longer is a model that started explaining
 * itself.
 */
export const MAX_ADAPTED_NOTE = 200;

/**
 * The adaptation stamp a save may carry (task 4.6): `recipes.adapted_at` +
 * `recipes.adapted_note`.
 *
 * The note travels through the client because the client is who *approved*
 * it: `dish.adapt` proposes, the household reads the proposal, and «Применить»
 * saves the recipe together with the sentence that explains it. It is bounded
 * and trimmed here like any other client-sent string.
 *
 * **Never `dishes.tags`** (decision D20). `tags` feeds S6's user-facing filter
 * chips and `collectTags()`; a machine tag «переделано под твою духовку» would
 * be both a hardcoded Russian string in the database and system state
 * polluting user content.
 */
export const dishAdaptationStamp = z.object({
  note: z.string().trim().min(1).max(MAX_ADAPTED_NOTE),
});

export const updateDishInput = z.object({
  id: z.uuid(),
  /** The aggregate `version` the editor started from; see `dishes` in schema.ts. */
  expectedVersion: z.int(),
  draft: recipeDraftSchema,
  /**
   * Three states, and `.optional()` here is deliberate — the one place in
   * this codebase where it is right, because the three answers are genuinely
   * "stamp it", "clear it" and "this save is not about adaptation at all":
   *
   * - **absent** — an ordinary edit (S8.3's own form, which does not send this
   *   field). The stamps are left exactly as they are, so fixing a typo in an
   *   adapted recipe does not silently erase «переделано под твою духовку».
   * - `{ note }` — «Применить» on a proposal: `adapted_at = now()`,
   *   `adapted_note = note`.
   * - `null` — «Вернуть как было»: both columns cleared, because the recipe
   *   on screen is once again the one that was imported.
   *
   * (AGENTS.md's «`.nullable()`, never `.optional()`» is a rule about OpenAI
   * strict mode, where an optional property is not expressible at all. A tRPC
   * input has no such constraint, and collapsing these three states into two
   * would mean every save from the edit form had to decide something it knows
   * nothing about.)
   */
  adaptation: dishAdaptationStamp.nullable().optional(),
});

export const adaptDishInput = z.object({
  dishId: z.uuid(),
  /**
   * The aggregate `version` the card was showing. Checked **before** anything
   * is spent: a proposal built against a recipe a partner has already
   * rewritten could not be applied anyway (`dish.update` would refuse it), so
   * paying for one would be paying for a dead end.
   */
  expectedVersion: z.int(),
  /** The portion count to rescale to, or `null` to keep the recipe's own. */
  targetPortions: z.int().min(1).max(MAX_PORTIONS).nullable(),
});

/**
 * What changed, in indexes. `changedIngredients`, `changedSteps` and
 * `addedSteps` index the **proposed** draft; `removedSteps` indexes the dish
 * as it stands, because a removed step exists nowhere else. The sheet holds
 * both and renders «было → стало» from them (see `adapt.ts`).
 */
export const adaptationDiffOutput = z.object({
  changedIngredients: z.array(z.int()),
  changedSteps: z.array(z.int()),
  addedSteps: z.array(z.int()),
  removedSteps: z.array(z.int()),
});

/**
 * A proposal, or an honest failure — **never a thrown error for an AI
 * problem**. The recipe is still on screen exactly as it was; the only thing
 * that failed is an offer, and S7 says so inside the sheet instead of
 * replacing the page with an error.
 */
export const adaptDishOutput = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("proposed"),
    jobId: z.uuid(),
    /** What the recipe would become. Nothing is written until «Применить». */
    draft: recipeDraftSchema,
    summary: z.string(),
    diff: adaptationDiffOutput,
  }),
  z.object({
    outcome: z.literal("failed"),
    /**
     * `null` for `nothingToAdapt`, which is decided before the ledger opens —
     * there is no job because there was no call and no cost.
     */
    jobId: z.uuid().nullable(),
    reason: z.enum(["aiUnavailable", "nothingToAdapt"]),
  }),
]);

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
            // Spread rather than a ternary per column, so an ordinary edit
            // emits no `adapted_*` assignment at all — see `updateDishInput`
            // for why the three states are three states.
            ...adaptationColumns(input.adaptation),
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

  /**
   * The recipe exactly as the import produced it — S7's «Вернуть как было»
   * (task 4.6), and nothing else reads it.
   *
   * **Its own query rather than a field on `dish.get`.** `dish.get` runs on
   * every open of every dish and already carries `hasOriginalDraft`, which is
   * all S7 needs to decide whether to offer the button; the draft itself is a
   * whole second recipe of JSON that would ride along on every one of those
   * reads for a button most people never press. This is fetched once, at the
   * moment the confirmation is accepted.
   *
   * **A product id that no longer resolves is nulled, never rejected.** The
   * import bound «Мука» to a catalog row; someone may have deleted it since,
   * and refusing the whole revert over one dangling binding would strand the
   * household with an adaptation it explicitly asked to undo. An unbound row
   * is a state this app already has a name for («новый»), and `dish.update`
   * re-resolves it through the same reference-catalog → enrichment path any
   * other save takes.
   */
  originalDraft: householdProcedure
    .input(dishIdInput)
    .output(recipeDraftSchema.nullable())
    .query(async ({ ctx, input }) => {
      const householdId = ctx.household.id;

      const [row] = await ctx.db
        .select({ draft: recipes.originalDraft })
        .from(recipes)
        .where(
          and(
            eq(recipes.dishId, input.id),
            eq(recipes.householdId, householdId),
          ),
        )
        .limit(1);

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Unknown dish" });
      }

      if (row.draft === null) {
        return null;
      }

      const parsed = recipeDraftSchema.safeParse(row.draft);
      if (!parsed.success) {
        // Written by an import that validated at the time, so this only
        // happens if a bound has since moved under it. Refusing loudly beats
        // handing the edit form a shape it cannot render — and beats
        // returning `null`, which the screen would read as «this dish never
        // had an original» and quietly stop offering the button.
        throw new TRPCError({
          code: "UNPROCESSABLE_CONTENT",
          message: "The stored original draft is no longer a valid recipe",
        });
      }

      return withOwnedProducts(ctx.db, householdId, parsed.data);
    }),

  /**
   * Proposes an adaptation of a recipe to the household's own kitchen and
   * portion count (VISION §3.3, DESIGN_BRIEF S7). **A proposal, never an
   * application.**
   *
   * The order is the whole procedure:
   *
   * 1. **The version, first and alone.** A stale `expectedVersion` is a
   *    `CONFLICT` before a single token is spent — a proposal built against a
   *    recipe a partner has already rewritten is one `dish.update` would
   *    refuse anyway, so paying for it would be paying for a dead end. (The
   *    read is issued separately rather than taken off the aggregate below
   *    for the same reason `update` does it: a guard has to be visible as a
   *    guard, and the aggregate read is three statements.)
   * 2. **Nothing to adapt is decided before the ledger opens.** A recipe the
   *    profile already covers, at its own portion count, has no adaptation to
   *    propose — and the honest answer costs nothing, writes no `ai_jobs` row
   *    and returns no job id.
   * 3. **The `ai_jobs` row opens before the call**, because
   *    `src/server/ai/rate-limit.ts` counts those rows — calls still in flight
   *    have to count against the window already.
   * 4. **The ledger closes immediately after `adaptRecipe` returns**, on both
   *    branches, before the proposal is applied to anything (decision C.2).
   *    Everything after that runs inside a `try/catch` that stamps the reason
   *    and re-throws.
   * 5. **This procedure writes nothing but its own `ai_jobs` rows** — asserted
   *    in `dish.test.ts` by inspecting every recorded statement. It returns a
   *    `RecipeDraft`; «Применить» calls `dish.update` with the current
   *    `expectedVersion`, so an adaptation cannot bypass draft validation,
   *    household scoping, product ownership or the version guard. That is the
   *    entire reason the feature is shaped as a proposal.
   */
  adapt: householdProcedure
    .input(adaptDishInput)
    .output(adaptDishOutput)
    .mutation(async ({ ctx, input }) => {
      const householdId = ctx.household.id;

      const [current] = await ctx.db
        .select({ version: dishes.version })
        .from(dishes)
        .where(
          and(eq(dishes.id, input.dishId), eq(dishes.householdId, householdId)),
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

      const detail = await readDishDetail(ctx.db, householdId, input.dishId);

      if (!detail) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Unknown dish" });
      }

      const [profile] = await ctx.db
        .select({ equipment: kitchenProfiles.equipment })
        .from(kitchenProfiles)
        .where(eq(kitchenProfiles.householdId, householdId))
        .limit(1);

      const draft = draftFromDetail(detail);
      // **No profile row is not an empty profile.** `profile?.equipment ?? []`
      // would make every requirement "missing", which sends the adaptation off
      // to work around appliances nobody said were absent — and then strips
      // all of them from `recipe.equipment` on apply. A household that never
      // filled in the kitchen profile has told us nothing, so nothing is
      // missing; the only thing left to adapt is the portion count. (S7 does
      // not even offer the button in that state — `EquipmentBanner` links to
      // Settings instead — but the rescale entry point beside the slider does
      // reach here, and a direct call reaches here regardless of the screen.)
      //
      // Both sides otherwise go through `coerceEquipmentSlug` (task 4.5), so a
      // profile entry typed as «мультиварка» still satisfies `multicooker`.
      const missing =
        profile === undefined
          ? []
          : missingEquipment(
              coerceEquipmentList(detail.recipe.equipment),
              profile.equipment,
            );
      // A target equal to the recipe's own yield is not a rescale, whatever
      // the client sent.
      const targetPortions =
        input.targetPortions === null ||
        input.targetPortions === draft.portionsBase
          ? null
          : input.targetPortions;

      if (missing.length === 0 && targetPortions === null) {
        return {
          outcome: "failed" as const,
          jobId: null,
          reason: "nothingToAdapt" as const,
        };
      }

      await assertWithinRateLimit(ctx.db, ctx.user.id);

      const [job] = await ctx.db
        .insert(aiJobs)
        .values({
          householdId,
          userId: ctx.user.id,
          type: "adapt_recipe",
          status: "running",
          // No `dish_id` column on `ai_jobs`: an adaptation puts the dish id
          // in the existing `input_ref`.
          inputRef: input.dishId,
        })
        .returning({ id: aiJobs.id });

      if (!job) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Opening an adaptation job inserted no row",
        });
      }

      const proposed = await adaptRecipe({
        client: ctx.openai(),
        // The model is shown the arithmetic already done: `rescaleDraft` is
        // deterministic and `applyAdaptation` runs it again on the same
        // inputs, so what the model reasons about is exactly what its edits
        // will land on.
        draft:
          targetPortions === null ? draft : rescaleDraft(draft, targetPortions),
        profile: { equipment: profile?.equipment ?? null },
        missing,
        targetPortions,
        basePortions: draft.portionsBase,
        options: {
          timeout: ADAPT_TIMEOUT_MS,
          // No retry: it doubles both the latency someone is watching and the
          // bill, for a call whose failure costs the user nothing but a tap.
          maxRetries: 0,
        },
      });

      // Step 4 — the ledger, closed before anything else can fail.
      await ctx.db
        .update(aiJobs)
        .set(
          proposed.ok
            ? {
                status: "done",
                costUsd: formatCostUsd(proposed.costUsd),
                finishedAt: sql`now()`,
              }
            : {
                status: "error",
                error: proposed.error,
                costUsd: formatCostUsd(proposed.costUsd),
                finishedAt: sql`now()`,
              },
        )
        .where(and(eq(aiJobs.id, job.id), eq(aiJobs.householdId, householdId)));

      try {
        if (!proposed.ok) {
          return {
            outcome: "failed" as const,
            jobId: job.id,
            reason: proposed.reason,
          };
        }

        const applied = applyAdaptation(draft, proposed.value, {
          targetPortions,
          // The recipe was reworked to avoid these; leaving them in
          // `recipe.equipment` would make S7's banner report them missing
          // forever after the fix was applied.
          dropEquipment: missing,
        });

        if (!applied.ok) {
          // A well-formed proposal that assembles into something
          // `recipeDraftSchema` refuses is our bug, not the model's day off —
          // but the user's answer is the same, and the ledger should say the
          // job did not produce anything usable.
          await markJobError(ctx.db, householdId, job.id, applied.error);

          return {
            outcome: "failed" as const,
            jobId: job.id,
            reason: "aiUnavailable" as const,
          };
        }

        return {
          outcome: "proposed" as const,
          jobId: job.id,
          draft: applied.draft,
          summary: proposed.value.summary.trim().slice(0, MAX_ADAPTED_NOTE),
          diff: applied.diff,
        };
      } catch (error) {
        // The cost is already recorded above; this only makes the reason
        // visible in the ledger instead of leaving a job that says «done»
        // beside a proposal the user never received.
        await markJobError(ctx.db, householdId, job.id, error);
        throw error;
      }
    }),
});

/**
 * How long an adaptation may take before we give up. Longer than the icon
 * lookup's 15 s (this call reasons over a whole recipe) and inside the tRPC
 * route's own `maxDuration = 60`, with room for the reads before it and the
 * ledger write after.
 */
const ADAPT_TIMEOUT_MS = 40_000;

/**
 * The `adapted_*` columns a save assigns, if any. Absent → an empty object,
 * so drizzle emits no assignment and an ordinary edit cannot erase a stamp it
 * knows nothing about.
 */
function adaptationColumns(
  adaptation: z.infer<typeof updateDishInput>["adaptation"],
) {
  if (adaptation === undefined) {
    return {};
  }

  return adaptation === null
    ? { adaptedAt: null, adaptedNote: null }
    : { adaptedAt: sql`now()`, adaptedNote: adaptation.note };
}

/**
 * The same draft with every binding this household no longer owns set to
 * `null` — one scoped select, and nothing is rejected.
 *
 * `dish.update` verifies every non-null `productId` against the catalog and
 * refuses the whole save on a mismatch (`assertProductsOwned`), which is the
 * right answer for a draft a *client* composed. A draft this server stored
 * months ago is a different question: the household deleted a product, and
 * the honest repair is the unbound «новый» state the save path already knows
 * how to resolve.
 */
async function withOwnedProducts(
  db: Database,
  householdId: string,
  draft: RecipeDraft,
): Promise<RecipeDraft> {
  const ids = [
    ...new Set(
      draft.ingredients
        .map((row) => row.productId)
        .filter((id): id is string => id !== null),
    ),
  ];

  if (ids.length === 0) {
    return draft;
  }

  const owned = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(eq(products.householdId, householdId), inArray(products.id, ids)),
    );

  const live = new Set(owned.map((row) => row.id));

  if (live.size === ids.length) {
    return draft;
  }

  return {
    ...draft,
    ingredients: draft.ingredients.map((row) =>
      row.productId !== null && !live.has(row.productId)
        ? { ...row, productId: null }
        : row,
    ),
  };
}

/**
 * Stamps a job as failed without touching its cost — the call was still
 * billed. Local to this router rather than shared with `dish-import.ts`'s own
 * copy: the two files are deliberately kept apart (decision D26) so the
 * 4.2/4.6 pair and the 4.3/4.4 pair never edit one file.
 */
async function markJobError(
  db: Database,
  householdId: string,
  jobId: string,
  error: unknown,
): Promise<void> {
  await db
    .update(aiJobs)
    .set({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: sql`now()`,
    })
    .where(and(eq(aiJobs.id, jobId), eq(aiJobs.householdId, householdId)));
}

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

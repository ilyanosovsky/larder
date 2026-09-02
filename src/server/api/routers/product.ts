import { TRPCError } from "@trpc/server";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import { aiJobs, categories, products } from "@/db/schema";
import { unitSchema, type Unit } from "@/lib/units";
import {
  enrichProduct,
  type EnrichProductResult,
} from "@/server/ai/enrich-product";
import { formatCostUsd } from "@/server/ai/pricing";
import { assertWithinRateLimit } from "@/server/ai/rate-limit-guard";
import {
  createTRPCRouter,
  householdProcedure,
  type TRPCContext,
} from "@/server/api/trpc";
import { normalizeProductName } from "@/server/catalog/normalize";
import {
  fallbackCategoryId,
  resolveCategoryIdForSlug,
  type HouseholdCategory,
} from "@/server/catalog/resolve-category";
import {
  findReferenceProduct,
  searchCatalog,
  type CatalogProduct,
} from "@/server/catalog/search";
import { isUniqueViolation } from "@/server/db-errors";

type Database = TRPCContext["db"];

/**
 * What a product gets when the AI could not help. Both are one tap to fix.
 *
 * Exported because `dish.create`/`dish.update` mint products too (task 4.2's
 * batched enrichment), and one feature must not have two answers to "what
 * does an un-enriched product look like".
 */
export const FALLBACK_ICON = "🛒";
export const FALLBACK_UNIT: Unit = "шт";

/** Shared by every input that names a product. Zod trims before validating. */
const productNameField = z.string().trim().min(1).max(100);

/**
 * Output schemas live next to the router so the sheet, the catalog screen and
 * (later) the cart all render the exact same contract.
 */
export const productOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  icon: z.string(),
  categoryId: z.uuid(),
  defaultUnit: unitSchema,
  aliases: z.array(z.string()),
});

export const productListItemOutput = productOutput.extend({
  categoryName: z.string(),
  categoryIcon: z.string(),
  categorySortOrder: z.int(),
});

/**
 * One autocomplete suggestion. Catalog and reference hits share one shape on
 * purpose — DESIGN_BRIEF S4 renders them identically, so a shopper never has
 * to think about which half of the catalog a familiar product came from.
 * `productId` is the only difference: `null` means "not in the database yet",
 * and tapping the row creates it from the built-in reference entry.
 */
export const productSearchHitOutput = z.object({
  source: z.enum(["catalog", "reference"]),
  productId: z.uuid().nullable(),
  name: z.string(),
  icon: z.string(),
  categoryId: z.uuid(),
  categoryName: z.string(),
  unit: unitSchema,
});

export const searchProductsInput = z.object({
  query: z.string().max(100),
});

/**
 * Discriminated on where the product comes from, because the two paths cost
 * very different things: `"reference"` is free and instant, `"new"` spends an
 * AI call and is rate limited. The client never sends an icon or a
 * department — the server re-resolves both.
 */
export const createProductInput = z.discriminatedUnion("source", [
  z.object({ source: z.literal("reference"), name: productNameField }),
  z.object({ source: z.literal("new"), name: productNameField }),
]);

export const createProductOutput = z.object({
  product: productOutput,
  /** The AI picked the icon/department (as opposed to the reference list). */
  enriched: z.boolean(),
  /** Enrichment was attempted and failed — the sheet nudges «проверь». */
  aiFailed: z.boolean(),
});

/**
 * Every field is optional (a partial update), but at least one must be
 * present — an empty patch is a bug in the caller, not a no-op worth a round
 * trip. `.optional()` and not `.nullable()` here: the `.nullable()` rule is
 * for OpenAI structured outputs; tRPC inputs follow the usual shape.
 */
export const updateProductInput = z
  .object({
    id: z.uuid(),
    name: productNameField.optional(),
    icon: z.string().trim().min(1).max(16).optional(),
    categoryId: z.uuid().optional(),
    defaultUnit: unitSchema.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.icon !== undefined ||
      input.categoryId !== undefined ||
      input.defaultUnit !== undefined,
    { message: "Nothing to update" },
  );

export type ProductOutput = z.infer<typeof productOutput>;
export type ProductListItemOutput = z.infer<typeof productListItemOutput>;
export type ProductSearchHitOutput = z.infer<typeof productSearchHitOutput>;
export type CreateProductOutput = z.infer<typeof createProductOutput>;

export const productColumns = {
  id: products.id,
  name: products.name,
  icon: products.icon,
  categoryId: products.categoryId,
  defaultUnit: products.defaultUnit,
  aliases: products.aliases,
};

export interface ProductRow {
  id: string;
  name: string;
  icon: string;
  categoryId: string;
  defaultUnit: string;
  aliases: string[];
}

/** The unit stored on a row, or the safest default if it is somehow not one. */
function toUnit(value: string): Unit {
  // Every write goes through `unitSchema`, so this only fires for a row
  // edited outside the app. Degrading to «шт» keeps `list` rendering instead
  // of failing output validation for the whole catalog over one bad row.
  const parsed = unitSchema.safeParse(value);
  return parsed.success ? parsed.data : FALLBACK_UNIT;
}

export function toProductOutput(row: ProductRow): ProductOutput {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    categoryId: row.categoryId,
    defaultUnit: toUnit(row.defaultUnit),
    aliases: row.aliases,
  };
}

function toCatalogProduct(row: ProductRow): CatalogProduct {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    categoryId: row.categoryId,
    defaultUnit: toUnit(row.defaultUnit),
    aliases: row.aliases,
  };
}

/** The caller's departments, in walking order. */
function loadCategories(
  db: Database,
  householdId: string,
): Promise<HouseholdCategory[]> {
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
 * The household's own row for a name, if it has one.
 *
 * The first probe is `normalizedName = normalizeProductName(input)` — **the
 * unique index's expression, exactly**, not an approximation of it. That
 * equality is what makes `insertProduct`'s recovery-after-23505 reliable: a
 * lookup that could disagree with the index would miss precisely the row the
 * insert just collided with, and the conflict would surface as a 500. The
 * second probe covers aliases, so «томаты» finds «Помидоры».
 */
export async function findExistingProduct(
  // `Pick<…, "select">` rather than the whole `Database`: `dish.create` calls
  // this from inside its transaction to recover from a 23505, and a drizzle
  // transaction is not assignable to `PostgresJsDatabase` (it has no
  // `$client`). It has to be *this* function rather than a second hand-written
  // probe, for the reason the doc comment above gives.
  db: Pick<Database, "select">,
  householdId: string,
  name: string,
): Promise<ProductOutput | null> {
  const normalized = normalizeProductName(name);

  const [row] = await db
    .select(productColumns)
    .from(products)
    .where(
      and(
        eq(products.householdId, householdId),
        or(
          eq(products.normalizedName, normalized),
          sql`${normalized} = ANY(${products.aliases})`,
        ),
      ),
    )
    .limit(1);

  return row ? toProductOutput(row) : null;
}

interface NewProduct {
  householdId: string;
  createdBy: string;
  name: string;
  icon: string;
  categoryId: string;
  defaultUnit: Unit;
  aliases: string[];
}

/**
 * Inserts a product, or reads back the row that beat us to it.
 *
 * Two taps on «Создать», two open tabs, or both partners adding «буррата» at
 * once all end here. The `(householdId, normalizedName)` unique index decides
 * the winner, and the loser returns the winner's row: creating a product is
 * idempotent by name, which is what lets the sheet retry without ever
 * producing the duplicate this whole feature exists to prevent.
 *
 * `normalizedName` is derived here rather than by the callers, so the column
 * the index is built on cannot drift from the `name` beside it — there is one
 * place that writes both, and it is this one.
 */
async function insertProduct(
  db: Database,
  values: NewProduct,
): Promise<ProductOutput> {
  try {
    const [inserted] = await db
      .insert(products)
      .values({
        ...values,
        normalizedName: normalizeProductName(values.name),
      })
      .returning(productColumns);

    if (inserted) {
      return toProductOutput(inserted);
    }
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }

  const existing = await findExistingProduct(
    db,
    values.householdId,
    values.name,
  );
  if (existing) {
    return existing;
  }

  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Product insert returned no row",
  });
}

/**
 * The household product catalog (VISION §3.1, §5) — autocomplete, creation
 * (with the AI fallback for anything unfamiliar) and editing.
 *
 * Adding to the cart (task 2.3) will go through this router and nothing else:
 * a name always resolves to one row here, which is what makes the «одна
 * активная строка на продукт» invariant expressible at all.
 */
export const productRouter = createTRPCRouter({
  /**
   * Autocomplete for the S4 sheet. Ranking, the reference-catalog merge and
   * the duplicate exclusion all live in `searchCatalog`, which is pure and
   * tested on its own; this procedure only feeds it the household's rows.
   */
  search: householdProcedure
    .input(searchProductsInput)
    .output(z.array(productSearchHitOutput))
    .query(async ({ ctx, input }) => {
      // Nothing typed yet — the sheet shows no list at all, so do not query.
      if (normalizeProductName(input.query).length === 0) {
        return [];
      }

      const rows = await ctx.db
        .select(productColumns)
        .from(products)
        .where(eq(products.householdId, ctx.household.id));

      const householdCategories = await loadCategories(
        ctx.db,
        ctx.household.id,
      );

      const categoryNames = new Map(
        householdCategories.map((category) => [category.id, category.name]),
      );

      const hits = searchCatalog({
        query: input.query,
        products: rows.map(toCatalogProduct),
        categories: householdCategories,
      });

      return hits.map((hit) =>
        hit.source === "catalog"
          ? {
              source: "catalog" as const,
              productId: hit.product.id,
              name: hit.product.name,
              icon: hit.product.icon,
              categoryId: hit.product.categoryId,
              categoryName: categoryNames.get(hit.product.categoryId) ?? "",
              unit: hit.product.defaultUnit,
            }
          : {
              source: "reference" as const,
              productId: null,
              name: hit.ref.name,
              icon: hit.ref.icon,
              categoryId: hit.categoryId,
              categoryName: categoryNames.get(hit.categoryId) ?? "",
              unit: hit.ref.unit,
            },
      );
    }),

  /** The whole catalog, in walking order: department, then name. */
  list: householdProcedure
    .output(z.array(productListItemOutput))
    .query(async ({ ctx }) => {
      const rows = await ctx.db
        .select({
          ...productColumns,
          categoryName: categories.name,
          categoryIcon: categories.icon,
          categorySortOrder: categories.sortOrder,
        })
        .from(products)
        .innerJoin(categories, eq(categories.id, products.categoryId))
        .where(eq(products.householdId, ctx.household.id))
        .orderBy(asc(categories.sortOrder), asc(products.name));

      return rows.map((row) => ({
        ...toProductOutput(row),
        categoryName: row.categoryName,
        categoryIcon: row.categoryIcon,
        categorySortOrder: row.categorySortOrder,
      }));
    }),

  /**
   * Creates a product, by one of two routes.
   *
   * `source: "reference"` re-resolves the entry from `REFERENCE_PRODUCTS` by
   * normalized name and takes the icon, department and unit from **there** —
   * the client sends only a name, so a tampered request cannot file a product
   * under an arbitrary category or give it an arbitrary icon.
   *
   * `source: "new"` is the paid path: rate limit, then one AI call for icon +
   * department + unit. Any failure at all still creates the product, with 🛒,
   * «Бакалея» and «шт» — someone who typed «буррата» wants a product, not an
   * apology, and one tap fixes whatever the AI got wrong (VISION §3.1: всё
   * редактируемо). `aiFailed` is what tells the sheet to say so.
   *
   * Both routes are idempotent by name: an existing product is returned
   * as-is, without an AI call and without a second row.
   */
  create: householdProcedure
    .input(createProductInput)
    .output(createProductOutput)
    .mutation(async ({ ctx, input }) => {
      const name = input.name;

      const householdCategories = await loadCategories(
        ctx.db,
        ctx.household.id,
      );
      const firstCategory = householdCategories[0];

      if (!firstCategory) {
        // Impossible in practice: `household.create` seeds seven departments
        // in the same transaction that creates the membership.
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Household has no categories",
        });
      }

      const existing = await findExistingProduct(
        ctx.db,
        ctx.household.id,
        name,
      );
      if (existing) {
        return { product: existing, enriched: false, aiFailed: false };
      }

      if (input.source === "reference") {
        const ref = findReferenceProduct(name);
        if (!ref) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Not a reference product",
          });
        }

        const product = await insertProduct(ctx.db, {
          householdId: ctx.household.id,
          createdBy: ctx.user.id,
          // The reference entry's own capitalization, not the query that
          // found it: picking «помидор» from the sheet creates «Помидоры».
          name: ref.name,
          icon: ref.icon,
          categoryId:
            resolveCategoryIdForSlug(ref.categorySlug, householdCategories) ??
            firstCategory.id,
          defaultUnit: ref.unit,
          aliases: [...ref.aliases],
        });

        return { product, enriched: false, aiFailed: false };
      }

      await assertWithinRateLimit(ctx.db, ctx.user.id);

      // The job row is written *before* the call, not after: it is what the
      // rate limiter counts, so a burst of calls that are still in flight
      // already counts against the window.
      const [job] = await ctx.db
        .insert(aiJobs)
        .values({
          householdId: ctx.household.id,
          userId: ctx.user.id,
          type: "product_enrich",
          status: "running",
          inputRef: name,
        })
        .returning({ id: aiJobs.id });

      let result: EnrichProductResult;
      try {
        result = await enrichProduct({
          client: ctx.openai(),
          name,
          categories: householdCategories,
        });
      } catch (error) {
        // `enrichProduct` itself never throws; this catches `ctx.openai()`
        // failing to build a client at all — a malformed OPENAI_API_KEY, say.
        // Same outcome as any other enrichment failure: the product still
        // gets created, with defaults.
        //
        // A *missing* key never reaches here: `env()` validates the whole
        // schema on its first call and `db()` calls `env()`, so the request
        // dies building its context. That is the intended behaviour for an
        // absent required variable, not something to paper over.
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          usage: null,
          costUsd: 0,
        };
      }

      if (job) {
        await ctx.db
          .update(aiJobs)
          .set(
            result.ok
              ? {
                  status: "done",
                  outputJson: result.value,
                  costUsd: formatCostUsd(result.costUsd),
                  finishedAt: sql`now()`,
                }
              : {
                  status: "error",
                  error: result.error,
                  // Recorded on the failure branch too: a response that came
                  // back and then failed validation was still billed, and a
                  // ledger that only counts successes under-reports exactly
                  // when things go wrong (AGENTS.md).
                  costUsd: formatCostUsd(result.costUsd),
                  finishedAt: sql`now()`,
                },
          )
          .where(eq(aiJobs.id, job.id));
      }

      const product = await insertProduct(ctx.db, {
        householdId: ctx.household.id,
        createdBy: ctx.user.id,
        name,
        icon: result.ok ? result.value.icon : FALLBACK_ICON,
        categoryId: result.ok
          ? result.value.categoryId
          : (fallbackCategoryId(householdCategories) ?? firstCategory.id),
        defaultUnit: result.ok ? result.value.unit : FALLBACK_UNIT,
        aliases: [],
      });

      return { product, enriched: result.ok, aiFailed: !result.ok };
    }),

  /**
   * Edits a product — the «Изменить» affordance in the sheet and, later, the
   * «изменить продукт» mini-sheet on a cart row (DESIGN_BRIEF S3).
   *
   * The `WHERE` repeats `household_id` on top of the id: an id from the
   * client never reaches a write on its own (VISION §6.7). A `categoryId` in
   * the patch is checked against the caller's own departments for the same
   * reason — an unchecked one would file the product under another
   * household's department, and the foreign key would happily allow it.
   */
  update: householdProcedure
    .input(updateProductInput)
    .output(productOutput)
    .mutation(async ({ ctx, input }) => {
      if (input.categoryId !== undefined) {
        const [category] = await ctx.db
          .select({ id: categories.id })
          .from(categories)
          .where(
            and(
              eq(categories.id, input.categoryId),
              eq(categories.householdId, ctx.household.id),
            ),
          )
          .limit(1);

        if (!category) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Unknown category",
          });
        }
      }

      try {
        const [updated] = await ctx.db
          .update(products)
          .set({
            // A rename rewrites the canonical column in the same statement:
            // they are one value in two forms, and a `name` that outran its
            // `normalizedName` would silently disable the uniqueness guard.
            ...(input.name === undefined
              ? {}
              : {
                  name: input.name,
                  normalizedName: normalizeProductName(input.name),
                }),
            ...(input.icon === undefined ? {} : { icon: input.icon }),
            ...(input.categoryId === undefined
              ? {}
              : { categoryId: input.categoryId }),
            ...(input.defaultUnit === undefined
              ? {}
              : { defaultUnit: input.defaultUnit }),
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(products.id, input.id),
              eq(products.householdId, ctx.household.id),
            ),
          )
          .returning(productColumns);

        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Unknown product",
          });
        }

        return toProductOutput(updated);
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        if (isUniqueViolation(error)) {
          // The new name normalizes onto another product in this household —
          // the `(householdId, normalizedName)` unique index caught it.
          throw new TRPCError({
            code: "CONFLICT",
            message: "A product with this name already exists",
          });
        }
        throw error;
      }
    }),
});

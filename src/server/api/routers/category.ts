import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { categories } from "@/db/schema";
import { createTRPCRouter, householdProcedure } from "@/server/api/trpc";
import { checkReorderPermutation } from "@/server/catalog/reorder";

/**
 * Output schema lives next to the router so a future drag-and-drop UI
 * (task 7.1) reuses the exact same contract as the query it renders.
 */
export const categoryOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  icon: z.string(),
  sortOrder: z.int(),
});

export const reorderCategoriesInput = z.object({
  orderedIds: z.array(z.uuid()).min(1).max(100),
});

export type CategoryOutput = z.infer<typeof categoryOutput>;

/**
 * Store departments a household groups its catalog by (VISION §3.1, §5).
 * Every new household gets the 7 defaults from `household.create`; this
 * router only reads and reorders them — there is no create/delete here in
 * the MVP scope of task 1.2.
 */
export const categoryRouter = createTRPCRouter({
  /** The household's departments, in their configured display order. */
  list: householdProcedure.output(z.array(categoryOutput)).query(({ ctx }) =>
    ctx.db
      .select({
        id: categories.id,
        name: categories.name,
        icon: categories.icon,
        sortOrder: categories.sortOrder,
      })
      .from(categories)
      .where(eq(categories.householdId, ctx.household.id))
      .orderBy(asc(categories.sortOrder)),
  ),

  /**
   * Applies a new display order. `orderedIds` must be exactly the
   * household's own category ids, each once — `checkReorderPermutation`
   * rejects anything else (a stale id from before a delete, a typo, a
   * duplicate) with `BAD_REQUEST` before any row is touched. On success,
   * each category's `sortOrder` becomes its index in the array.
   *
   * Each update's `WHERE` still repeats `householdId`, on top of the
   * permutation check above: an id already proven to belong to this
   * household is redundant to re-scope, but never trust a bare id from the
   * client to reach a write on its own (VISION §6.7).
   *
   * The existing-ids read runs *inside* the transaction, `ORDER BY id FOR
   * UPDATE`: it locks every row of this household's category set before any
   * update touches one. The ordering is what actually prevents a deadlock —
   * two overlapping reorders of the same household would otherwise be free
   * to lock the same rows in whatever order each request's own `orderedIds`
   * happened to list them in, and Postgres aborts one side when that
   * crosses. Locking in one fixed order (by id, not by the caller's
   * proposed order) means every concurrent reorder queues up on the same
   * row first instead of deadlocking.
   */
  reorder: householdProcedure
    .input(reorderCategoriesInput)
    .output(z.void())
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.householdId, ctx.household.id))
          .orderBy(categories.id)
          .for("update");

        const check = checkReorderPermutation(
          input.orderedIds,
          existing.map((row) => row.id),
        );

        if (!check.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `orderedIds is not a permutation of the household's categories (${check.reason})`,
          });
        }

        for (const [index, id] of input.orderedIds.entries()) {
          await tx
            .update(categories)
            .set({ sortOrder: index })
            .where(
              and(
                eq(categories.id, id),
                eq(categories.householdId, ctx.household.id),
              ),
            );
        }
      });
    }),
});

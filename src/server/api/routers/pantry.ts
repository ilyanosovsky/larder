import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { cartItems, categories, pantryItems, products } from "@/db/schema";
import { createTRPCRouter, householdProcedure } from "@/server/api/trpc";
import {
  activeItemScope,
  cartItemColumns,
  cartItemOutput,
  insertActiveItem,
  lockActiveItem,
  toCartItemOutput,
  toUnit,
} from "@/server/api/routers/cart";
import { decidePantryRanOut } from "@/server/pantry/ran-out";

/**
 * At most two passes through the ran-out rules, the same bound `cart.add`
 * uses and for the same reason: the second pass runs against the row that
 * won the unique index, and by then an active row provably exists, so it
 * cannot come back "added" a second time.
 */
const RAN_OUT_ATTEMPTS = 2;

/**
 * One row of "what's at home" (VISION §3.2), as S5 renders it —
 * `categoryId`/`categoryName`/`categoryIcon` feed `groupProductsByCategory`
 * (`src/lib/group-products.ts`) exactly the way `cartListItemOutput` does,
 * and `list` returns rows in the order that function assumes.
 */
export const pantryListItemOutput = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  productName: z.string(),
  productIcon: z.string(),
  categoryId: z.uuid(),
  categoryName: z.string(),
  categoryIcon: z.string(),
  updatedAt: z.date(),
});

export const ranOutInput = z.object({ id: z.uuid() });

/**
 * Discriminated on what actually happened, the same shape `addCartItemOutput`
 * uses and for the same reason: the screen's toast text differs per case
 * (DESIGN_BRIEF S5's «В корзине» / cart's «уже в корзине» / no message at
 * all). `gone` carries no `item` — there is nothing left to describe, the
 * pantry row this call was about is already someone else's finished tap.
 */
export const ranOutOutput = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("gone") }),
  z.object({ outcome: z.literal("added"), item: cartItemOutput }),
  z.object({ outcome: z.literal("alreadyInCart"), item: cartItemOutput }),
  z.object({ outcome: z.literal("restored"), item: cartItemOutput }),
]);

export type PantryListItemOutput = z.infer<typeof pantryListItemOutput>;
export type RanOutOutput = z.infer<typeof ranOutOutput>;

/**
 * "What's at home" (VISION §3.2) and the one action it offers: «Кончилось»
 * sends a product straight back to the cart.
 *
 * There is no `create`/`remove` endpoint here in task 3.1's scope. Rows are
 * populated by «Завершить закупку» (task 3.2, not yet wired) and emptied
 * exclusively by `ranOut` — a pantry fact is never edited by hand, only
 * asserted true (by a purchase) or false (by running out).
 */
export const pantryRouter = createTRPCRouter({
  /**
   * The household's pantry, in the same walking order `cart.list` uses:
   * department by `sortOrder`, then product name — what
   * `groupProductsByCategory` needs to cut the list into S5's sections.
   */
  list: householdProcedure
    .output(z.array(pantryListItemOutput))
    .query(({ ctx }) =>
      ctx.db
        .select({
          id: pantryItems.id,
          productId: pantryItems.productId,
          updatedAt: pantryItems.updatedAt,
          productName: products.name,
          productIcon: products.icon,
          categoryId: categories.id,
          categoryName: categories.name,
          categoryIcon: categories.icon,
        })
        .from(pantryItems)
        .innerJoin(products, eq(products.id, pantryItems.productId))
        .innerJoin(categories, eq(categories.id, products.categoryId))
        .where(eq(pantryItems.householdId, ctx.household.id))
        .orderBy(asc(categories.sortOrder), asc(products.name)),
    ),

  /**
   * «Кончилось» (VISION §3.2, DESIGN_BRIEF S5): removes the pantry row and
   * makes sure the product is on the cart — **ensure-in-cart, not
   * add-quantity**. The rules for what "ensure" means against whatever the
   * cart already holds are `decidePantryRanOut` (`src/server/pantry/
   * ran-out.ts`, pure and unit-tested); this procedure supplies the locked
   * rows and performs whatever the decision asks for, the same split
   * `cart.add` uses against `decideCartAdd`.
   *
   * **The delete is the single `DELETE … RETURNING`, not a separate locking
   * `SELECT` followed by a delete.** That one statement already gives the
   * atomicity a `SELECT … FOR UPDATE` would: it either removes a row nobody
   * else has removed yet and hands back its `productId`, or it matches
   * nothing and this call knows at once there is nothing left to do. Two
   * overlapping calls for the same row — the shopper's own double tap, or an
   * offline-queue replay racing a second live tap — can therefore never both
   * see a row to act on; exactly one wins the delete, the other reads `gone`.
   *
   * **`gone` is a no-op, not an error.** A pantry row a partner already
   * cleared (or a queued tap replayed after this one already landed) is
   * simply too late to mean anything — the cart line it would have ensured
   * already exists from whichever call won. This is what makes the whole
   * mutation replay-safe for the offline queue's at-least-once delivery: a
   * `ranOut` sent twice is `gone` the second time, never a duplicate line.
   *
   * Ensuring the cart line then follows the exact shape `cart.add` uses
   * against its own unique index: lock the product's active row, decide, and
   * — for the one outcome with nothing to lock — retry once against whatever
   * a concurrent insert won the race with. Two passes is the whole budget,
   * for the same reason it is in `cart.add`: after a lost race an active row
   * provably exists, so a second miss is a bug, not something to retry.
   */
  ranOut: householdProcedure
    .input(ranOutInput)
    .output(ranOutOutput)
    .mutation(async ({ ctx, input }) => {
      const householdId = ctx.household.id;

      return ctx.db.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(pantryItems)
          .where(
            and(
              eq(pantryItems.id, input.id),
              eq(pantryItems.householdId, householdId),
            ),
          )
          .returning({ productId: pantryItems.productId });

        if (!deleted) {
          return { outcome: "gone" as const };
        }

        const productId = deleted.productId;

        // Re-checked against the caller's own household even though this
        // row's `productId` came from a pantry row already scoped to it —
        // the same defense-in-depth `cart.add` applies to a client-supplied
        // `productId`, kept here because nothing in the schema itself forces
        // `pantry_items.household_id` and `products.household_id` to agree
        // (see `cart_items`' own doc comment on the same gap).
        const [product] = await tx
          .select({ defaultUnit: products.defaultUnit })
          .from(products)
          .where(
            and(
              eq(products.id, productId),
              eq(products.householdId, householdId),
            ),
          )
          .limit(1);

        if (!product) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Pantry row referenced a product outside its household",
          });
        }

        const defaultUnit = toUnit(product.defaultUnit);

        for (let attempt = 0; attempt < RAN_OUT_ATTEMPTS; attempt += 1) {
          const [existing] = await lockActiveItem(tx, householdId, productId);

          const decision = decidePantryRanOut({
            existing: existing ? { status: existing.status } : null,
            defaultUnit,
          });

          if (decision.outcome === "added") {
            const inserted = await insertActiveItem(tx, {
              householdId,
              productId,
              qty: decision.qty,
              unit: decision.unit,
              note: null,
              addedBy: ctx.user.id,
            });

            if (inserted) {
              return {
                outcome: "added" as const,
                item: toCartItemOutput(inserted),
              };
            }
            // Lost the race — go round once more against the winner's row.
            continue;
          }

          if (!existing) {
            // Unreachable by construction, the same reasoning `cart.add`
            // documents at its own equivalent check: `decidePantryRanOut`
            // answers "added" for exactly the no-active-row case, handled
            // above.
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Pantry ran-out decided against a row that is not there",
            });
          }

          if (decision.outcome === "alreadyInCart") {
            return {
              outcome: "alreadyInCart" as const,
              item: toCartItemOutput(existing),
            };
          }

          // "restored": back to `needed` as if freshly added — the buyer and
          // the delivery service belonged to the purchase being undone.
          // Deliberately not `qty`/`unit`/`note`: unlike `cart.add`'s
          // restore, there is no new quantity here to replace them with, so
          // the row simply keeps what it already had.
          const [restored] = await tx
            .update(cartItems)
            .set({
              status: "needed",
              addedBy: ctx.user.id,
              buyerId: null,
              orderedVia: null,
              updatedAt: sql`now()`,
            })
            .where(activeItemScope(existing.id, householdId))
            .returning(cartItemColumns);

          if (!restored) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Pantry restore updated no row",
            });
          }

          return {
            outcome: "restored" as const,
            item: toCartItemOutput(restored),
          };
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Pantry ran-out could not resolve an active row",
        });
      });
    }),
});

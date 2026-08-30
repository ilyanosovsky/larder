import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { cartItems, pantryItems, shoppingTrips } from "@/db/schema";
import { createTRPCRouter, householdProcedure } from "@/server/api/trpc";
import { lockHousehold } from "@/server/household-lock";

/**
 * How many closed trips the S12 history block reads.
 *
 * A flat list, no pagination: a household closes a trip a few times a week,
 * so 50 is about a year of shopping and the screen is a settings block rather
 * than a browsable archive. The limit is here so the query cannot grow without
 * bound years from now, not because anyone is expected to reach it — when the
 * block becomes a real screen (task 7.1) it gets a cursor, and this constant
 * is the reminder that it does not have one yet.
 */
export const TRIP_HISTORY_LIMIT = 50;

export const closeTripOutput = z.object({
  /** `null` for the no-op: nothing was bought, so no trip was created. */
  tripId: z.uuid().nullable(),
  count: z.number().int().nonnegative(),
  /** What moved to the pantry — one id per stamped line. */
  productIds: z.array(z.uuid()),
});

export const tripListItemOutput = z.object({
  id: z.uuid(),
  closedAt: z.date(),
  itemCount: z.number().int().nonnegative(),
});

export type CloseTripOutput = z.infer<typeof closeTripOutput>;
export type TripListItemOutput = z.infer<typeof tripListItemOutput>;

/**
 * «Завершить закупку» (VISION §3.1) and the purchase history it produces.
 *
 * Closing a trip is the one moment a `ShoppingTrip` row exists at all: there
 * is no "open trip" (see `shoppingTrips`' own doc comment in `src/db/
 * schema.ts`), so `close` mints the row and stamps its id onto every bought
 * line in the same transaction. That stamp is what frees the cart's partial
 * unique index `(product_id) WHERE trip_id IS NULL` — the same product can be
 * bought again next week precisely because last week's line is no longer
 * active.
 *
 * **The purchase is the household's, not the shopper's** (VISION §3.1: «чьи
 * бы они ни были: закупка общая на household»): every `bought` line goes,
 * whoever ticked it. `needed` and `ordered` lines stay in the cart — a
 * delivery that has not arrived is not part of the run that just ended.
 *
 * **Lock ordering is deliberate; see `src/server/household-lock.ts`.** This
 * transaction locks cart rows before it touches the pantry, `pantry.ranOut`
 * does it the other way round, and both take the household's advisory lock as
 * their first statement so the two can never interleave into a 40P01.
 */
export const tripRouter = createTRPCRouter({
  /**
   * Closes the current run: bought lines leave the cart for history, and the
   * products they name become pantry facts (VISION §3.2 — presence only, no
   * quantities, so the upsert carries nothing but the pair of ids).
   *
   * The four statements in order, and why that order:
   *
   * 1. **The advisory lock**, first, before any row is touched — a lock taken
   *    later would order nothing.
   * 2. **`SELECT … FOR UPDATE` over the bought lines.** It answers "is there
   *    anything to close" *and* pins the answer: with those rows locked, a
   *    partner un-ticking one blocks until this transaction commits, so the
   *    set that gets stamped is exactly the set that was counted. Without the
   *    lock the check and the write could disagree, and a run that turned out
   *    empty would leave a trip row behind describing nothing.
   * 3. **The trip row**, minted only once step 2 found something. **No bought
   *    lines means no trip**: `{ tripId: null, count: 0, productIds: [] }`,
   *    no error — the same idempotent no-op `cart.receiveOrder` returns when
   *    nothing is ordered, and the reason the history never fills with empty
   *    entries from a double tap.
   * 4. **The stamp, then the pantry upsert.** `ON CONFLICT … DO UPDATE SET
   *    updated_at = now()` rather than `DO NOTHING`: buying something the
   *    pantry already lists is not a no-op, it is a fresher fact about the
   *    same product, and `pantry.list` orders by department and name so the
   *    timestamp costs nothing but honesty.
   */
  close: householdProcedure
    .output(closeTripOutput)
    .mutation(async ({ ctx }) => {
      const householdId = ctx.household.id;

      return ctx.db.transaction(async (tx) => {
        await lockHousehold(tx, householdId);

        const bought = await tx
          .select({ id: cartItems.id })
          .from(cartItems)
          .where(
            and(
              eq(cartItems.householdId, householdId),
              isNull(cartItems.tripId),
              eq(cartItems.status, "bought"),
            ),
          )
          .for("update");

        if (bought.length === 0) {
          return { tripId: null, count: 0, productIds: [] };
        }

        const [trip] = await tx
          .insert(shoppingTrips)
          .values({ householdId })
          .returning({ id: shoppingTrips.id });

        if (!trip) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Closing a trip created no trip row",
          });
        }

        // Scoped by household and by `trip_id IS NULL` on top of the ids,
        // exactly like `activeItemScope` — an id never reaches a write on its
        // own (VISION §6.7), and a line another transaction somehow carried
        // off first must not be re-stamped into a second trip.
        const stamped = await tx
          .update(cartItems)
          .set({ tripId: trip.id, updatedAt: sql`now()` })
          .where(
            and(
              inArray(
                cartItems.id,
                bought.map((row) => row.id),
              ),
              eq(cartItems.householdId, householdId),
              isNull(cartItems.tripId),
              eq(cartItems.status, "bought"),
            ),
          )
          .returning({ productId: cartItems.productId });

        if (stamped.length === 0) {
          // Unreachable while the rows above are locked, and a throw rather
          // than an early return on purpose: the trip row has already been
          // inserted in this transaction, so the only way not to leave an
          // empty trip behind is to roll the whole thing back.
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Closing a trip stamped no cart lines",
          });
        }

        // De-duplicated even though the partial unique index already
        // guarantees one active line per product: a multi-row
        // `INSERT … ON CONFLICT DO UPDATE` whose values hit the same key twice
        // is a hard Postgres error (21000, "cannot affect row a second time"),
        // which would turn an impossible state into a failed purchase.
        const productIds = [...new Set(stamped.map((row) => row.productId))];

        await tx
          .insert(pantryItems)
          .values(productIds.map((productId) => ({ householdId, productId })))
          .onConflictDoUpdate({
            target: pantryItems.productId,
            set: { updatedAt: sql`now()` },
            // The conflicting row belongs to this household by construction
            // (one product, one household), but the write path repeats the
            // check anyway — the same defense in depth every other statement
            // here applies, and a mismatch degrades to "left alone" instead
            // of touching another household's row.
            setWhere: eq(pantryItems.householdId, householdId),
          });

        return { tripId: trip.id, count: stamped.length, productIds };
      });
    }),

  /**
   * Purchase history for the S12 block (DESIGN_BRIEF S12): closed trips,
   * newest first, each with how many lines it carried off.
   *
   * The count is aggregated in the database rather than by returning the
   * lines themselves — the block shows «N позиций» and nothing else, and the
   * expanded per-trip list DESIGN_BRIEF sketches is task 7.1's, at which
   * point it can read its own trip by id.
   *
   * The join is scoped by household on **both** sides. `cart_items.trip_id`
   * already only ever points at this household's trips, but repeating the
   * predicate is what makes the statement readable as scoped on its own
   * (VISION §6.7) rather than by an argument about the other table.
   */
  list: householdProcedure
    .output(z.array(tripListItemOutput))
    .query(({ ctx }) =>
      ctx.db
        .select({
          id: shoppingTrips.id,
          closedAt: shoppingTrips.closedAt,
          // `::int` because `count()` is `bigint`, which the driver hands
          // back as a string — the Zod output would then reject it, loudly
          // but for the wrong reason.
          itemCount: sql<number>`count(${cartItems.id})::int`,
        })
        .from(shoppingTrips)
        .leftJoin(
          cartItems,
          and(
            eq(cartItems.tripId, shoppingTrips.id),
            eq(cartItems.householdId, ctx.household.id),
          ),
        )
        .where(eq(shoppingTrips.householdId, ctx.household.id))
        .groupBy(shoppingTrips.id)
        .orderBy(desc(shoppingTrips.closedAt))
        .limit(TRIP_HISTORY_LIMIT),
    ),
});

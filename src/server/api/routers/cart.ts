import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  cartItems,
  cartItemStatusEnum,
  categories,
  householdMembers,
  products,
  users,
} from "@/db/schema";
import { orderedViaSchema, type OrderedVia } from "@/lib/ordered-via";
import { unitSchema, type Unit } from "@/lib/units";
import {
  createTRPCRouter,
  householdProcedure,
  type TRPCContext,
} from "@/server/api/trpc";
import { decideCartAdd, MAX_QTY, MIN_QTY } from "@/server/cart/merge";
import { isUniqueViolation } from "@/server/db-errors";

type Database = TRPCContext["db"];
/** The handle drizzle hands a `db.transaction` callback. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The unit a row falls back to when it somehow holds something else. */
const FALLBACK_UNIT: Unit = "шт";

/**
 * At most two passes through the add rules: the second one runs against the
 * row that won the unique index, and by then an active row provably exists,
 * so it cannot come back "insert" a second time.
 */
const ADD_ATTEMPTS = 2;

/**
 * Output schemas live next to the router so the S3 cart, the S4 sheet and
 * (later) the menu→cart preview all render the exact same contract.
 */
export const cartItemStatusSchema = z.enum(cartItemStatusEnum.enumValues);

/**
 * Where an ordered line was ordered (VISION §3.1), re-exported from
 * `@/lib/ordered-via` for callers that already import it from here. Stored as
 * text rather than a database enum — the list grows with whatever delivery
 * service the household starts using, and a text column re-validated on read
 * does not need a migration for that. Anything unrecognized reads back as
 * `null`. Lives in `@/lib/ordered-via` rather than only here because the row
 * action sheet and the offline queue's pending-row extraction (task 2.5) need
 * this vocabulary on the client, and importing it from this router would drag
 * drizzle/db imports into a client bundle for the sake of one enum.
 */
export { orderedViaSchema, type OrderedVia };

/**
 * One line as the database holds it. Mutations return this; `list` extends it
 * with the joined product, department and member names — the same split
 * `productOutput` / `productListItemOutput` uses.
 */
export const cartItemOutput = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  qty: z.number(),
  unit: unitSchema,
  status: cartItemStatusSchema,
  note: z.string().nullable(),
  orderedVia: orderedViaSchema.nullable(),
  addedById: z.string().nullable(),
  buyerId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/**
 * A line as S3 renders it. `categoryId`/`categoryName`/`categoryIcon` are
 * exactly what `groupProductsByCategory` (`src/lib/group-products.ts`) needs,
 * and `list` returns rows in the order that function assumes.
 *
 * `updatedAt` is on the wire for task 2.2: the refetch model has no push, so
 * the screen highlights what changed by comparing it across refetches.
 */
export const cartListItemOutput = cartItemOutput.extend({
  productName: z.string(),
  productIcon: z.string(),
  categoryId: z.uuid(),
  categoryName: z.string(),
  categoryIcon: z.string(),
  addedByName: z.string().nullable(),
  buyerName: z.string().nullable(),
});

/**
 * A quantity, bounded on both ends by what the column can hold. The lower
 * bound matters as much as the upper one: `numeric(10, 3)` rounds anything
 * below 0.001 down to zero, so a smaller value would silently create a line
 * for none of something.
 */
const qtyField = z.number().min(MIN_QTY).max(MAX_QTY);

export const addCartItemInput = z.object({
  productId: z.uuid(),
  qty: qtyField,
  unit: unitSchema,
  note: z.string().trim().max(200).optional(),
  /**
   * Confirms the «вернуть в нужно» offer for a line already bought in the
   * open trip. Ignored for a line in any other state — see `decideCartAdd`.
   */
  restore: z.boolean().optional(),
});

/**
 * Discriminated on what actually happened, because the five cases are five
 * different screens (DESIGN_BRIEF S3/S4): a new row, «6 шт → 8 шт», a unit
 * conflict to resolve by hand, an offer to un-buy, and the result of taking
 * it. Every case carries the resulting — or the untouched current — line, so
 * the caller never has to re-read to find out what it is looking at.
 */
export const addCartItemOutput = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("added"), item: cartItemOutput }),
  z.object({
    outcome: z.literal("merged"),
    item: cartItemOutput,
    /** What the line held before the merge, for «6 шт → 8 шт». */
    previousQty: z.number(),
  }),
  z.object({ outcome: z.literal("unitMismatch"), item: cartItemOutput }),
  z.object({ outcome: z.literal("boughtExists"), item: cartItemOutput }),
  z.object({ outcome: z.literal("restored"), item: cartItemOutput }),
]);

/**
 * A partial patch, with at least one field present — an empty one is a bug in
 * the caller, not a no-op worth a round trip. `.optional()` and not
 * `.nullable()` for "leave it alone": the `.nullable()` rule is for OpenAI
 * structured outputs, tRPC inputs follow the usual shape. The three clearable
 * fields are `.nullable().optional()`, which is the only way to tell "don't
 * touch it" (undefined) from "clear it" (null) — a note and a buyer both have
 * to be removable, and an absent key cannot mean both.
 */
export const updateCartItemInput = z
  .object({
    id: z.uuid(),
    qty: qtyField.optional(),
    unit: unitSchema.optional(),
    note: z.string().trim().max(200).nullable().optional(),
    buyerId: z.string().min(1).nullable().optional(),
    orderedVia: orderedViaSchema.nullable().optional(),
  })
  .refine(
    (input) =>
      input.qty !== undefined ||
      input.unit !== undefined ||
      input.note !== undefined ||
      input.buyerId !== undefined ||
      input.orderedVia !== undefined,
    { message: "Nothing to update" },
  );

export const setCartItemStatusInput = z.object({
  id: z.uuid(),
  status: cartItemStatusSchema,
  /** Only meaningful together with `ordered`; ignored otherwise. */
  orderedVia: orderedViaSchema.optional(),
});

export const removeCartItemInput = z.object({
  id: z.uuid(),
});

/**
 * «Заказ получен» (task 2.5): every active `ordered` line moves to `bought`
 * in one call, optionally narrowed to one delivery service. Both `null` and
 * an absent key mean "every service" — there is no third state worth telling
 * apart, and the UI never has a reason to ask for "no service" specifically.
 */
export const receiveOrderInput = z.object({
  orderedVia: orderedViaSchema.nullable().optional(),
});

export const receiveOrderOutput = z.object({
  count: z.number(),
  ids: z.array(z.uuid()),
});

export type CartItemOutput = z.infer<typeof cartItemOutput>;
export type CartListItemOutput = z.infer<typeof cartListItemOutput>;
export type AddCartItemOutput = z.infer<typeof addCartItemOutput>;
export type ReceiveOrderOutput = z.infer<typeof receiveOrderOutput>;

const cartItemColumns = {
  id: cartItems.id,
  productId: cartItems.productId,
  qty: cartItems.qty,
  unit: cartItems.unit,
  status: cartItems.status,
  note: cartItems.note,
  orderedVia: cartItems.orderedVia,
  addedById: cartItems.addedBy,
  buyerId: cartItems.buyerId,
  createdAt: cartItems.createdAt,
  updatedAt: cartItems.updatedAt,
};

interface CartItemRow {
  id: string;
  productId: string;
  qty: number;
  unit: string;
  status: CartItemOutput["status"];
  note: string | null;
  orderedVia: string | null;
  addedById: string | null;
  buyerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The unit stored on a row, or the safest default if it is somehow not one. */
function toUnit(value: string): Unit {
  // Every write goes through `unitSchema`, so this only fires for a row edited
  // outside the app. Degrading to «шт» keeps the whole cart rendering instead
  // of failing output validation over one bad line.
  const parsed = unitSchema.safeParse(value);
  return parsed.success ? parsed.data : FALLBACK_UNIT;
}

/** Same idea for the delivery service — an unknown one is simply not shown. */
function toOrderedVia(value: string | null): OrderedVia | null {
  if (value === null) {
    return null;
  }
  const parsed = orderedViaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toCartItemOutput(row: CartItemRow): CartItemOutput {
  return {
    id: row.id,
    productId: row.productId,
    qty: row.qty,
    unit: toUnit(row.unit),
    status: row.status,
    note: row.note,
    orderedVia: toOrderedVia(row.orderedVia),
    addedById: row.addedById,
    buyerId: row.buyerId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The product's active line, locked for the rest of the transaction.
 *
 * `FOR UPDATE` is what makes the read-decide-write of `cart.add` safe: two
 * partners adding «помидоры» at the same moment would otherwise both read
 * «2 шт», both compute «3 шт», and one increment would vanish. The lock also
 * covers the restore branch, which reads a status and writes a different one.
 *
 * A product with no active line locks nothing — there is no row to lock — so
 * the insert below still has to survive losing that race.
 */
function lockActiveItem(
  tx: Transaction,
  householdId: string,
  productId: string,
): Promise<CartItemRow[]> {
  return tx
    .select(cartItemColumns)
    .from(cartItems)
    .where(
      and(
        eq(cartItems.householdId, householdId),
        eq(cartItems.productId, productId),
        isNull(cartItems.tripId),
      ),
    )
    .limit(1)
    .for("update");
}

interface NewCartItem {
  householdId: string;
  productId: string;
  qty: number;
  unit: Unit;
  note: string | null;
  addedBy: string;
}

/**
 * Inserts the line, or reports that someone else got there first.
 *
 * The insert runs inside a **savepoint** (drizzle's nested `transaction`),
 * and that is not decoration: in Postgres a unique violation aborts the
 * *entire* enclosing transaction, so catching 23505 without one would leave
 * every following statement failing with 25P02 — the recovery read would never
 * reach the winner's row. Rolling back to the savepoint puts the transaction
 * back in a usable state, which is what lets the caller re-read and merge.
 */
async function insertActiveItem(
  tx: Transaction,
  values: NewCartItem,
): Promise<CartItemRow | null> {
  try {
    return await tx.transaction(async (nested) => {
      const [inserted] = await nested
        .insert(cartItems)
        .values(values)
        .returning(cartItemColumns);

      return inserted ?? null;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The `(product_id) WHERE trip_id IS NULL` index caught a concurrent
      // insert of the same product. Not an error — the merge rules simply
      // apply to the winner's row instead.
      return null;
    }
    throw error;
  }
}

/**
 * The caller's own active line with that id, or NOT_FOUND.
 *
 * Every mutation below repeats `household_id` on top of the primary key: an id
 * from the client never reaches a write on its own (VISION §6.7). `trip_id IS
 * NULL` is the other half — a line carried off by a closed trip is purchase
 * history, and history is not editable from the cart screen.
 */
function activeItemScope(id: string, householdId: string) {
  return and(
    eq(cartItems.id, id),
    eq(cartItems.householdId, householdId),
    isNull(cartItems.tripId),
  );
}

/**
 * The shared shopping list (VISION §3.1) — the product's core screen.
 *
 * The one thing this router exists to protect is the invariant «одна активная
 * строка на продукт», carried by the partial unique index
 * `(product_id) WHERE trip_id IS NULL`. Adding a product that is already in
 * the cart raises the existing line instead of minting a second one, and the
 * index — not a pre-check — is what decides the concurrent case. Nothing here
 * may work around it (AGENTS.md).
 */
export const cartRouter = createTRPCRouter({
  /**
   * The active cart, in walking order: department by `sortOrder`, then product
   * name. That order is the contract `groupProductsByCategory` relies on —
   * it cuts the list into sections by walking it, rather than re-deriving an
   * order the database already decided.
   *
   * `addedBy` and `buyerId` join `users` twice under two aliases, because
   * «кто добавил» and «кто купил/заказал» are both shown on the row and are
   * usually different people.
   */
  list: householdProcedure
    .output(z.array(cartListItemOutput))
    .query(async ({ ctx }) => {
      const addedByUser = alias(users, "added_by_user");
      const buyerUser = alias(users, "buyer_user");

      const rows = await ctx.db
        .select({
          ...cartItemColumns,
          productName: products.name,
          productIcon: products.icon,
          categoryId: categories.id,
          categoryName: categories.name,
          categoryIcon: categories.icon,
          addedByName: addedByUser.name,
          buyerName: buyerUser.name,
        })
        .from(cartItems)
        .innerJoin(products, eq(products.id, cartItems.productId))
        .innerJoin(categories, eq(categories.id, products.categoryId))
        .leftJoin(addedByUser, eq(addedByUser.id, cartItems.addedBy))
        .leftJoin(buyerUser, eq(buyerUser.id, cartItems.buyerId))
        .where(
          and(
            eq(cartItems.householdId, ctx.household.id),
            isNull(cartItems.tripId),
          ),
        )
        .orderBy(asc(categories.sortOrder), asc(products.name));

      return rows.map((row) => ({
        ...toCartItemOutput(row),
        productName: row.productName,
        productIcon: row.productIcon,
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        categoryIcon: row.categoryIcon,
        addedByName: row.addedByName,
        buyerName: row.buyerName,
      }));
    }),

  /**
   * Adds a product to the cart, or merges into the line it already has.
   *
   * The rules themselves are pure and tested on their own
   * (`src/server/cart/merge.ts`); this procedure supplies the locked row and
   * performs whatever the decision asks for.
   *
   * The loop exists for exactly one case: a product with no active line, where
   * `FOR UPDATE` has nothing to lock and a concurrent insert can therefore win
   * the unique index. The loser does not fail — it re-reads the winner's row
   * and applies the same merge rules to it, so two partners adding «помидоры»
   * at the same instant end with one line holding both quantities. Two passes
   * are enough by construction: after a lost race an active row provably
   * exists, so the second pass cannot decide to insert again.
   */
  add: householdProcedure
    .input(addCartItemInput)
    .output(addCartItemOutput)
    .mutation(async ({ ctx, input }) => {
      const householdId = ctx.household.id;

      // A product id from the client is checked against the caller's own
      // catalog before it reaches a write: the foreign key would happily
      // accept another household's product, and the cart would then show a
      // line nobody in this household can explain.
      const [product] = await ctx.db
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.id, input.productId),
            eq(products.householdId, householdId),
          ),
        )
        .limit(1);

      if (!product) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Unknown product" });
      }

      return ctx.db.transaction(async (tx) => {
        for (let attempt = 0; attempt < ADD_ATTEMPTS; attempt += 1) {
          const [existing] = await lockActiveItem(
            tx,
            householdId,
            input.productId,
          );

          const decision = decideCartAdd({
            existing: existing
              ? {
                  qty: existing.qty,
                  // The unit as stored, deliberately not through `toUnit`:
                  // degrading an unrecognized unit to «шт» here would let it
                  // merge into a «шт» addition, changing the quantity while
                  // leaving the row's own unit untouched. `toUnit` is for
                  // rendering (`toCartItemOutput`), never for deciding.
                  unit: existing.unit,
                  status: existing.status,
                }
              : null,
            addition: { qty: input.qty, unit: input.unit },
            restore: input.restore ?? false,
          });

          if (decision.outcome === "added") {
            const inserted = await insertActiveItem(tx, {
              householdId,
              productId: input.productId,
              qty: decision.qty,
              unit: decision.unit,
              note: input.note ?? null,
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
            // Unreachable by construction: `decideCartAdd` answers "added" for
            // exactly the no-active-row case, which the branch above took. The
            // check is here so the four outcomes below can name the row they
            // are about without an assertion standing in for that reasoning.
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Cart add decided against a row that is not there",
            });
          }

          switch (decision.outcome) {
            case "merged": {
              const [merged] = await tx
                .update(cartItems)
                .set({ qty: decision.qty, updatedAt: sql`now()` })
                .where(activeItemScope(existing.id, householdId))
                .returning(cartItemColumns);

              if (!merged) {
                throw new TRPCError({
                  code: "INTERNAL_SERVER_ERROR",
                  message: "Cart merge updated no row",
                });
              }

              return {
                outcome: "merged" as const,
                item: toCartItemOutput(merged),
                previousQty: decision.previousQty,
              };
            }

            case "restored": {
              // The line goes back to «нужно» as if freshly added: the buyer
              // and the delivery service belonged to the purchase that is
              // being undone. The note is the exception — it describes the
              // product («покрупнее»), not the trip, so it stays.
              const [restored] = await tx
                .update(cartItems)
                .set({
                  status: "needed",
                  qty: decision.qty,
                  unit: decision.unit,
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
                  message: "Cart restore updated no row",
                });
              }

              return {
                outcome: "restored" as const,
                item: toCartItemOutput(restored),
              };
            }

            // Both leave the row exactly as it is: the screen asks a question
            // the shopper answers, rather than the server guessing.
            case "unitMismatch":
              return {
                outcome: "unitMismatch" as const,
                item: toCartItemOutput(existing),
              };

            case "boughtExists":
              return {
                outcome: "boughtExists" as const,
                item: toCartItemOutput(existing),
              };
          }
        }

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Cart add could not resolve an active row",
        });
      });
    }),

  /**
   * Edits a line — quantity, unit, note, who is taking it, where it was
   * ordered. Last write wins (VISION §3.1): the patch is applied as given,
   * with no read-modify-write to lose someone else's edit behind.
   *
   * A `buyerId` is checked against the household's members for the same reason
   * a `categoryId` is checked in `product.update`: the foreign key only proves
   * the user exists, not that they live here.
   */
  updateItem: householdProcedure
    .input(updateCartItemInput)
    .output(cartItemOutput)
    .mutation(async ({ ctx, input }) => {
      if (input.buyerId !== undefined && input.buyerId !== null) {
        const [member] = await ctx.db
          .select({ id: householdMembers.id })
          .from(householdMembers)
          .where(
            and(
              eq(householdMembers.userId, input.buyerId),
              eq(householdMembers.householdId, ctx.household.id),
            ),
          )
          .limit(1);

        if (!member) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Not a household member",
          });
        }
      }

      const [updated] = await ctx.db
        .update(cartItems)
        .set({
          ...(input.qty === undefined ? {} : { qty: input.qty }),
          ...(input.unit === undefined ? {} : { unit: input.unit }),
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.buyerId === undefined ? {} : { buyerId: input.buyerId }),
          ...(input.orderedVia === undefined
            ? {}
            : { orderedVia: input.orderedVia }),
          updatedAt: sql`now()`,
        })
        .where(activeItemScope(input.id, ctx.household.id))
        .returning(cartItemColumns);

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Unknown cart item",
        });
      }

      return toCartItemOutput(updated);
    }),

  /**
   * Moves a line along `нужно → заказано → куплено` (VISION §3.1).
   *
   * What each status writes besides itself:
   *
   * - `bought` stamps the caller as the buyer — that is what «кто купил» reads,
   *   and the checkbox is the only place it is ever set.
   * - `needed` clears both the buyer and the delivery service: the line is
   *   back to nobody having done anything about it.
   * - `ordered` records `orderedVia` when the screen offers one, and touches
   *   nothing else.
   *
   * The two carried-over fields are deliberate, not oversights:
   *
   * `ordered → bought` keeps `orderedVia` — a delivered Wolt order was still
   * bought at Wolt, and the history should say so.
   *
   * `bought → ordered` keeps `buyerId`, because that column answers «кто
   * берёт» as much as «кто купил» (VISION §3.1: закупки разделены). It is set
   * by hand through `updateItem` to assign a line long before anyone buys
   * anything, and clearing it here would silently discard that assignment
   * every time a line moved to `ordered`. Only `needed` clears it, which is
   * the path that actually means "nobody has done anything about this".
   * A buyer left over from an undone purchase is the lesser cost, and the one
   * the shopper can see and fix.
   *
   * Last write wins, as VISION §3.1 asks — a checkbox has to work instantly on
   * a bad connection at the till, so the write must never depend on having
   * read the row first.
   */
  setStatus: householdProcedure
    .input(setCartItemStatusInput)
    .output(cartItemOutput)
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(cartItems)
        .set({
          status: input.status,
          ...(input.status === "bought" ? { buyerId: ctx.user.id } : {}),
          ...(input.status === "needed"
            ? { buyerId: null, orderedVia: null }
            : {}),
          ...(input.status === "ordered" && input.orderedVia !== undefined
            ? { orderedVia: input.orderedVia }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(activeItemScope(input.id, ctx.household.id))
        .returning(cartItemColumns);

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Unknown cart item",
        });
      }

      return toCartItemOutput(updated);
    }),

  /**
   * Drops a line from the cart for good. Only an active one: a line already
   * carried off by a closed trip is purchase history.
   *
   * Deliberately idempotent — no NOT_FOUND when nothing matched. The cart is
   * shared, so both partners removing the same line is ordinary, not an error,
   * and the desired state is reached either way. The offline queue task 2.4
   * adds replays mutations after a reconnect, and a delete that fails the
   * second time would surface as an error for something that did work.
   */
  remove: householdProcedure
    .input(removeCartItemInput)
    .output(z.void())
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(cartItems)
        .where(activeItemScope(input.id, ctx.household.id));
    }),

  /**
   * «Заказ получен» — every active `ordered` line becomes `bought` in one
   * statement, instead of ticking each one by hand. `orderedVia` narrows it
   * to the lines ordered through one service; omitted or `null`, it takes
   * every ordered line regardless of service.
   *
   * The buyer rule mirrors `setStatus`'s single-row one: a line already
   * assigned to someone (`updateItem`'s «кто берёт») keeps that buyer, and
   * only a line nobody claimed is credited to whoever tapped the control —
   * `COALESCE` decides that per row, in the same statement, so a batch mixing
   * both cases needs no per-row loop. `orderedVia` is cleared on every
   * receipted line: the badge exists to answer "is this on its way", and once
   * it has arrived that question is moot — history is what `bought` already
   * means, the same way `ordered → bought` through the checkbox needs no
   * separate "received" state.
   *
   * A household with nothing ordered (or nothing ordered through the given
   * service) is a no-op: `count: 0`, `ids: []`, no error — the control simply
   * had nothing to do, the same idea as `remove`'s idempotence.
   */
  receiveOrder: householdProcedure
    .input(receiveOrderInput)
    .output(receiveOrderOutput)
    .mutation(async ({ ctx, input }) => {
      const scope = and(
        eq(cartItems.householdId, ctx.household.id),
        isNull(cartItems.tripId),
        eq(cartItems.status, "ordered"),
        ...(input.orderedVia === undefined || input.orderedVia === null
          ? []
          : [eq(cartItems.orderedVia, input.orderedVia)]),
      );

      const received = await ctx.db
        .update(cartItems)
        .set({
          status: "bought",
          orderedVia: null,
          buyerId: sql`coalesce(${cartItems.buyerId}, ${ctx.user.id})`,
          updatedAt: sql`now()`,
        })
        .where(scope)
        .returning({ id: cartItems.id });

      return { count: received.length, ids: received.map((row) => row.id) };
    }),
});

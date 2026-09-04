import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { dishes, menuItems, recipes, weekMenus } from "@/db/schema";
import { MAX_PORTIONS } from "@/lib/recipes/draft";
import {
  createTRPCRouter,
  householdProcedure,
  type TRPCContext,
} from "@/server/api/trpc";
import { MENU_TIME_ZONE, weekEndOf, weekStartOf } from "@/server/menu/week";

type Database = TRPCContext["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * One card in the S10 pool (DESIGN_BRIEF S10): the dish it names, what this
 * household is cooking of it, and whether it has been cooked yet.
 *
 * `day_of_week` is deliberately absent. The column exists (VISION §5) and
 * nothing writes it in MVP, so a field that is always `null` would be noise
 * on the wire and in the type; product phase 2 adds it to the output in the
 * PR that adds a UI for it.
 */
export const menuItemOutput = z.object({
  id: z.uuid(),
  dishId: z.uuid(),
  title: z.string(),
  photoUrl: z.string().nullable(),
  tags: z.array(z.string()),
  totalTimeMin: z.int().nullable(),
  /** What this household is cooking, 1…`MAX_PORTIONS`. */
  portions: z.int(),
  /** The recipe's own yield, for the ± bounds and the «8 печений» label. */
  portionsBase: z.int(),
  portionsMin: z.int().nullable(),
  yieldUnit: z.string().nullable(),
  cookedAt: z.date().nullable(),
  /** Non-null ⇒ the quiet «в архиве» chip; the card stays fully usable. */
  archivedAt: z.date().nullable(),
  addedById: z.string().nullable(),
  createdAt: z.date(),
  /** For `useChangedRows` — same job it does on `cartListItemOutput`. */
  updatedAt: z.date(),
});

export const weekMenuOutput = z.object({
  /** «YYYY-MM-DD» Monday. A string, never a Date — see the column's comment. */
  weekStart: z.string(),
  /** «YYYY-MM-DD» Sunday, derived; on the wire so the header needs no math. */
  weekEnd: z.string(),
  /** `null` until the first dish is added — the row is created lazily. */
  id: z.uuid().nullable(),
  items: z.array(menuItemOutput),
  /** Task 5.2's «Корзина собрана · {дата}». Null until the first build. */
  lastBuiltAt: z.date().nullable(),
});

export const addMenuItemInput = z.object({
  dishId: z.uuid(),
  /**
   * S10's picker sends the recipe's own `portions_base`; S7 sends the
   * slider's live value — the number the person has been reading the
   * ingredient list at. Throwing that away to re-derive the base would be a
   * worse answer than the one on screen.
   *
   * Bounded 1…`MAX_PORTIONS` rather than by `portionsRange(base)`: the UI
   * clamps to the range, but a stored `portions` must survive a partner
   * editing the recipe's own yield downward afterwards, and a server that
   * re-clamped would reject a value it had itself accepted last week.
   */
  portions: z.int().min(1).max(MAX_PORTIONS),
});

export const addMenuItemOutput = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("added"), item: menuItemOutput }),
  /** Already in this week's pool — untouched, portions and all. */
  z.object({ outcome: z.literal("alreadyInMenu"), item: menuItemOutput }),
]);

export const setMenuPortionsInput = z.object({
  id: z.uuid(),
  portions: z.int().min(1).max(MAX_PORTIONS),
});

export const setMenuCookedInput = z.object({
  id: z.uuid(),
  cooked: z.boolean(),
});

export const removeMenuItemInput = z.object({ id: z.uuid() });

/**
 * What a ± tap or a «приготовлено» tick changes, and nothing else.
 *
 * Deliberately not the joined row: the card is already on screen, only its
 * own state moved, and re-reading the dish and its recipe for one integer
 * would be three joins for a `+`.
 */
export const menuItemStateOutput = z.object({
  id: z.uuid(),
  portions: z.int(),
  cookedAt: z.date().nullable(),
  updatedAt: z.date(),
});

/**
 * The two entrances DESIGN_BRIEF gives the build flow, as one discriminated
 * input: S10's «Собрать корзину» over the whole week, and S7's «Ингредиенты в
 * корзину» for one dish at the portions its slider is showing (VISION §3.3:
 * «с тем же превью-диффом и сверкой с кладовой»).
 *
 * Declared here, in 5.1, although its first reader is 5.2's `previewCart`:
 * the union is the contract between the two screens and the router, and a
 * second copy of it — one in the router, one in the sheet — is exactly the
 * shape that drifts. Phase 6.1's assistant reads the same answer through a
 * server-side tool call with no client in the picture.
 *
 * `week` carries no `weekStart`: it is always *this* week, computed
 * server-side. A client-chosen week would let somebody build a cart out of
 * last month, which is not a feature, and it keeps the assistant's tool a
 * zero-argument call.
 */
export const buildCartScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("week") }),
  z.object({
    kind: z.literal("dish"),
    dishId: z.uuid(),
    portions: z.int().min(1).max(MAX_PORTIONS),
  }),
]);

export type MenuItemOutput = z.infer<typeof menuItemOutput>;
export type WeekMenuOutput = z.infer<typeof weekMenuOutput>;
export type MenuItemStateOutput = z.infer<typeof menuItemStateOutput>;
export type BuildCartScope = z.infer<typeof buildCartScope>;

/**
 * `weekStartOf(new Date(), MENU_TIME_ZONE)` — the one call site for the clock.
 *
 * A function rather than an inline call so the whole router reads its week
 * from one place, and so 5.3's `repeatWeek` cannot answer a different
 * question about «this week» than `current` does. `ctx` is taken (and
 * ignored) because task 7.1 turns the zone into `households.time_zone`, at
 * which point this body changes and no call site does.
 */
export function currentWeekStartFor(ctx: {
  household: { id: string };
}): string {
  void ctx;
  return weekStartOf(new Date(), MENU_TIME_ZONE);
}

/**
 * The week's row id, creating it if this is the household's first write of
 * the week.
 *
 * `ON CONFLICT … DO UPDATE SET updated_at = now()` rather than `DO NOTHING`:
 * `DO UPDATE` returns the conflicting row, so the caller needs no second
 * read, and it takes that row's lock — which serializes two partners creating
 * the same week without extra ceremony. `setWhere` repeats the household
 * predicate for the same defence in depth `trip.close`'s pantry upsert
 * applies: the conflicting row belongs to this household by construction, and
 * a mismatch must degrade to "left alone" rather than touch another
 * household's row.
 *
 * **That degradation is why the `RETURNING` is guarded.** A `setWhere` that
 * matches nothing updates nothing and returns nothing, so `row` is genuinely
 * optional — a non-null assertion here would be a crash in the one case the
 * predicate exists for. `NOT_FOUND` is the honest answer: from the caller's
 * side the week they asked to write into is not theirs.
 *
 * No advisory lock: this transaction touches `week_menus` and `menu_items`
 * only, so it forms no cycle with `trip.close` / `pantry.ranOut` / 5.2's
 * `applyCart`, which are the transactions that take it
 * (`src/server/household-lock.ts`).
 */
export async function ensureWeekMenu(
  tx: Transaction,
  householdId: string,
  weekStart: string,
): Promise<string> {
  const [row] = await tx
    .insert(weekMenus)
    .values({ householdId, weekStart })
    .onConflictDoUpdate({
      target: [weekMenus.householdId, weekMenus.weekStart],
      set: { updatedAt: sql`now()` },
      setWhere: eq(weekMenus.householdId, householdId),
    })
    .returning({ id: weekMenus.id });

  if (row === undefined) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Unknown week menu",
    });
  }

  return row.id;
}

/**
 * The pool read, minus the predicate that separates its two callers —
 * `menu.current`'s whole week and `addDish`'s single row.
 *
 * One builder rather than two copies of a fifteen-column projection and two
 * joins, the shape `dishListQuery` already uses on the dish side. Both joins
 * repeat `household_id`: `recipes.dish_id` only ever points at this
 * household's dishes, but a statement has to read as scoped on its own rather
 * than by an argument about another table (VISION §6.7).
 */
function menuItemQuery(db: Database | Transaction, householdId: string) {
  return db
    .select({
      id: menuItems.id,
      dishId: menuItems.dishId,
      title: dishes.title,
      photoUrl: dishes.photoUrl,
      tags: dishes.tags,
      totalTimeMin: recipes.totalTimeMin,
      portions: menuItems.portions,
      portionsBase: recipes.portionsBase,
      portionsMin: recipes.portionsMin,
      yieldUnit: recipes.yieldUnit,
      cookedAt: menuItems.cookedAt,
      archivedAt: dishes.archivedAt,
      addedById: menuItems.addedBy,
      createdAt: menuItems.createdAt,
      updatedAt: menuItems.updatedAt,
    })
    .from(menuItems)
    .innerJoin(
      dishes,
      and(eq(dishes.id, menuItems.dishId), eq(dishes.householdId, householdId)),
    )
    .innerJoin(
      recipes,
      and(eq(recipes.dishId, dishes.id), eq(recipes.householdId, householdId)),
    );
}

/**
 * One week's whole pool, in the order S10 renders it.
 *
 * Ascending by `created_at`, not descending like `dish.list`: S6 is a grid you
 * keep importing into, so the newest tile belongs top-left; S10 is a pool you
 * assemble, and a card that appears at the bottom next to «+ Блюдо» is where
 * the eye already is. `id` breaks a tie between two rows added in the same
 * millisecond.
 *
 * **Archived dishes are returned, not filtered.** `menu_items.dish_id` is
 * `RESTRICT` precisely so a stored week keeps naming the dish it named, and
 * `dish.archiveHint` promises out loud that an archived dish «останется в
 * меню недели». The card wears a quiet «в архиве» chip instead.
 */
export function readMenuItems(
  db: Database | Transaction,
  householdId: string,
  weekMenuId: string,
): Promise<MenuItemOutput[]> {
  return menuItemQuery(db, householdId)
    .where(
      and(
        eq(menuItems.householdId, householdId),
        eq(menuItems.weekMenuId, weekMenuId),
      ),
    )
    .orderBy(asc(menuItems.createdAt), asc(menuItems.id));
}

/**
 * The week menu (VISION §3.4, DESIGN_BRIEF S10) — a pool of dishes for the
 * current week, with no days attached.
 *
 * **The week is the server's answer, never the client's** (`week.ts`): the
 * menu and the cart are shared, so two partners in two zones must not
 * disagree about which week is current, and a week computed in a `useEffect`
 * would make `/menu` un-prefetchable. The row for that week is created
 * lazily, by the first write.
 *
 * None of these procedures takes the advisory lock: they touch `week_menus`
 * and `menu_items` and nothing else, so they cannot form the lock-order cycle
 * `src/server/household-lock.ts` exists for. Task 5.2's `applyCart`, which
 * writes `cart_items` in bulk, does take it.
 *
 * The two setters are last-write-wins with no read-modify-write, and answer
 * `NOT_FOUND` when nothing matched; `removeDish` is deliberately idempotent.
 * The asymmetry is the repo's own rule: removal-shaped mutations must be
 * idempotent (both partners clearing the same card is ordinary), state-shaped
 * ones must be honest about a row that is gone.
 */
export const menuRouter = createTRPCRouter({
  /**
   * This week's pool. No input — see the router's own comment.
   *
   * A week nobody has touched ends the procedure after **one** statement with
   * `{ id: null, items: [], lastBuiltAt: null }` and writes nothing: a query
   * that created its row would mint an empty week every Monday for every
   * household that merely opened the tab, and 5.3's «Прошлые недели» would
   * fill with weeks nobody planned.
   */
  current: householdProcedure
    .output(weekMenuOutput)
    .query(async ({ ctx }) => {
      const householdId = ctx.household.id;
      const weekStart = currentWeekStartFor(ctx);
      const weekEnd = weekEndOf(weekStart);

      const [week] = await ctx.db
        .select({ id: weekMenus.id, lastBuiltAt: weekMenus.lastBuiltAt })
        .from(weekMenus)
        .where(
          and(
            eq(weekMenus.householdId, householdId),
            eq(weekMenus.weekStart, weekStart),
          ),
        )
        .limit(1);

      if (!week) {
        return { weekStart, weekEnd, id: null, items: [], lastBuiltAt: null };
      }

      return {
        weekStart,
        weekEnd,
        id: week.id,
        items: await readMenuItems(ctx.db, householdId, week.id),
        lastBuiltAt: week.lastBuiltAt,
      };
    }),

  /**
   * «В меню недели» (S7) and the S10 picker's row tap.
   *
   * The ownership read runs **outside** the transaction and carries
   * `archived_at IS NULL` — the picker's own list predicate (`dish.list`
   * excludes archived dishes), so client and server agree on what is
   * addable. An archived dish already *in* the pool stays there; it simply
   * cannot be added again.
   *
   * Inside the transaction: `ensureWeekMenu`, then `INSERT … ON CONFLICT
   * (week_menu_id, dish_id) DO NOTHING RETURNING id`, then **always** a
   * joined re-read of the row by its natural key.
   *
   * `DO NOTHING`, not the savepoint dance `cart.add` performs: the cart has
   * to catch its violation because it needs the winner's row *to merge into*,
   * and a 23505 aborts the enclosing transaction. Here there is nothing to
   * merge — a no-op followed by one read is the whole answer, and the outcome
   * is decided by whether the insert returned a row.
   *
   * Replay safety: sent twice → `added`, then `alreadyInMenu`. No duplicate
   * card, no doubled portions, and the second answer describes the row that
   * is actually there.
   */
  addDish: householdProcedure
    .input(addMenuItemInput)
    .output(addMenuItemOutput)
    .mutation(async ({ ctx, input }) => {
      const householdId = ctx.household.id;
      const weekStart = currentWeekStartFor(ctx);

      const [dish] = await ctx.db
        .select({ id: dishes.id })
        .from(dishes)
        .innerJoin(
          recipes,
          and(
            eq(recipes.dishId, dishes.id),
            eq(recipes.householdId, householdId),
          ),
        )
        .where(
          and(
            eq(dishes.id, input.dishId),
            eq(dishes.householdId, householdId),
            isNull(dishes.archivedAt),
          ),
        )
        .limit(1);

      if (!dish) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Unknown dish" });
      }

      return ctx.db.transaction(async (tx) => {
        const weekMenuId = await ensureWeekMenu(tx, householdId, weekStart);

        const [inserted] = await tx
          .insert(menuItems)
          .values({
            householdId,
            weekMenuId,
            dishId: input.dishId,
            portions: input.portions,
            addedBy: ctx.user.id,
          })
          // Targeted rather than bare: the only conflict this insert is
          // allowed to swallow is the (week, dish) pair the pool's invariant
          // is about. A bare `DO NOTHING` would also silently absorb any
          // other unique violation this table ever grows.
          .onConflictDoNothing({
            target: [menuItems.weekMenuId, menuItems.dishId],
          })
          .returning({ id: menuItems.id });

        const [item] = await menuItemQuery(tx, householdId)
          .where(
            and(
              eq(menuItems.householdId, householdId),
              eq(menuItems.weekMenuId, weekMenuId),
              eq(menuItems.dishId, input.dishId),
            ),
          )
          .limit(1);

        if (!item) {
          // Nearly unreachable, and worth naming the interleaving that does
          // reach it: this transaction runs at READ COMMITTED (nothing here
          // sets an isolation level), where `ON CONFLICT DO NOTHING` takes no
          // lock on the conflicting row and each statement takes a fresh
          // snapshot. So a partner's `removeDish` — an unlocked autocommit
          // DELETE — landing in the one round trip between the insert and
          // this re-read empties it legitimately.
          //
          // `CONFLICT`, not `INTERNAL_SERVER_ERROR`: nothing is broken, the
          // window is ~one round trip wide and the action succeeds on a
          // retry. A throw rather than a silent second attempt inside the
          // same transaction, which could lose the same race again —
          // `insertProduct` answers the identical situation the same way.
          throw new TRPCError({
            code: "CONFLICT",
            message: "Menu item vanished between its insert and its read",
          });
        }

        return inserted
          ? { outcome: "added" as const, item }
          : { outcome: "alreadyInMenu" as const, item };
      });
    }),

  /**
   * The card's ± control.
   *
   * One `UPDATE`, **last write wins, no read-modify-write** — the rule
   * `cart.setStatus` states: a ± tap has to work instantly, so the write must
   * never depend on having read the row first. Two partners nudging the same
   * card end on whichever value landed last, which is the honest answer for a
   * shared pool.
   *
   * That is the whole of the server's contract, and it is *why* the client
   * serialises: two requests for one card can be served out of order, and a
   * LWW `UPDATE` would then persist the earlier number. How the taps are
   * dispatched — first one immediately, at most one outstanding per card, one
   * `onSettled` follow-up carrying the final number — is documented where it
   * lives, in `src/lib/menu/portions-queue.ts` and `menu-screen.tsx`.
   *
   * No rows updated → `NOT_FOUND`. The card is on screen, so the useful
   * response is a refresh, not a retry.
   */
  setPortions: householdProcedure
    .input(setMenuPortionsInput)
    .output(menuItemStateOutput)
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .update(menuItems)
        .set({ portions: input.portions, updatedAt: sql`now()` })
        .where(
          and(
            eq(menuItems.id, input.id),
            eq(menuItems.householdId, ctx.household.id),
          ),
        )
        .returning({
          id: menuItems.id,
          portions: menuItems.portions,
          cookedAt: menuItems.cookedAt,
          updatedAt: menuItems.updatedAt,
        });

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Unknown menu item" });
      }

      return row;
    }),

  /**
   * The «приготовлено» checkbox.
   *
   * LWW like `setPortions`, and idempotent in effect: ticking twice writes
   * the same state, and the millisecond difference in `now()` is read by
   * nothing. `NOT_FOUND` when nothing matched, for the same reason.
   */
  setCooked: householdProcedure
    .input(setMenuCookedInput)
    .output(menuItemStateOutput)
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .update(menuItems)
        .set({
          cookedAt: input.cooked ? sql`now()` : null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(menuItems.id, input.id),
            eq(menuItems.householdId, ctx.household.id),
          ),
        )
        .returning({
          id: menuItems.id,
          portions: menuItems.portions,
          cookedAt: menuItems.cookedAt,
          updatedAt: menuItems.updatedAt,
        });

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Unknown menu item" });
      }

      return row;
    }),

  /**
   * «Убрать из меню».
   *
   * **Deliberately idempotent — no `NOT_FOUND`.** The menu is shared, so both
   * partners removing the same card is ordinary rather than an error, and the
   * desired state is reached either way. Exactly `cart.remove`'s rule — and
   * the reason `setCooked` does *not* share it.
   */
  removeDish: householdProcedure
    .input(removeMenuItemInput)
    .output(z.void())
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(menuItems)
        .where(
          and(
            eq(menuItems.id, input.id),
            eq(menuItems.householdId, ctx.household.id),
          ),
        );
    }),

  // --- task 5.2 appends previewCart / applyCart here ---

  // --- task 5.3 appends history / addDishes / repeatWeek here ---
});

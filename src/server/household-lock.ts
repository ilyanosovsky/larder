import { sql, type SQL } from "drizzle-orm";

/**
 * The one transaction-scoped advisory lock this app takes, keyed by household.
 *
 * **Why it exists: a genuine lock-order cycle between two transactions.**
 * `pantry.ranOut` locks *pantry row → cart row* (a `DELETE … RETURNING` on
 * `pantry_items`, then `SELECT … FOR UPDATE` / an insert against the cart's
 * partial unique index). `trip.close` naturally runs the other way round:
 * *cart rows → pantry row* (stamping `trip_id` on every bought line, then
 * upserting the pantry rows that purchase produced) — and it has to, because
 * the stamping `UPDATE … RETURNING` is what authoritatively decides which
 * products were bought. Run those two at the same instant for the same
 * product and Postgres has a cycle: `ranOut` holds the pantry-row delete and
 * waits for the cart row, `close` holds the cart row and waits on the pantry
 * key's uncommitted delete. One of them is aborted with 40P01 (deadlock
 * detected) — a 500 for a tap that did nothing wrong.
 *
 * **The resolution: both transactions serialize on the household first.**
 * Reordering the statements was the alternative and it does not survive
 * contact with the requirement: for `close` to touch the pantry first it
 * would have to read the bought lines without locking them, and any line
 * un-bought in the gap would leave a pantry row for something still sitting
 * in the cart. A coarse per-household lock costs nothing here — a household
 * is two people, and these are the only two transactions that take it, so the
 * contention window is one shopper's tap against their partner's, measured in
 * milliseconds — and it makes the interaction obvious to read rather than a
 * property to re-derive every time either procedure changes.
 *
 * `pg_advisory_xact_lock` (not the session-scoped `pg_advisory_lock`) is
 * released by Postgres at commit or rollback, so there is no unlock call to
 * forget and no way for a failed transaction to strand the lock — which
 * matters on serverless, where the connection outlives the request.
 *
 * `hashtextextended(uuid::text, 0)` maps the household id onto the `bigint`
 * key space the single-argument form of the lock takes. Collisions between
 * two households are possible in principle and harmless in practice: the
 * consequence is that two unrelated households briefly serialize with each
 * other, not that either sees the other's data.
 *
 * **The club has four members now, and the second cycle is not about the
 * pantry at all.** `cart.receiveOrder` locks every `ordered` line in one
 * multi-row `UPDATE` with no order to give; `trip.close` locks every `bought`
 * line in one `SELECT … FOR UPDATE`, also unordered; and `menu.applyCart`
 * (task 5.2) locks a chosen set of active lines ordered by `product_id`. Any
 * two of those overlapping on two products can deadlock, and — unlike the
 * pantry cycle — no amount of reordering fixes it, because two of the three
 * statements have no order to impose. Taking the household lock first is what
 * makes them serialize instead.
 */
export function householdLockStatement(householdId: string): SQL {
  return sql`select pg_advisory_xact_lock(hashtextextended(${householdId}::text, 0))`;
}

/**
 * The minimum of a drizzle transaction handle this module needs — declared
 * structurally so the pure statement above can be unit-tested without a
 * database, the same split the routers use for their decision functions.
 */
export interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Takes the household's advisory lock. **Must be the first statement of any
 * transaction that writes both `cart_items` and `pantry_items`, or that takes
 * more than one `cart_items` row lock at a time** — a lock taken after the
 * first row lock does not order anything.
 *
 * The four transactions that take it: `trip.close`, `pantry.ranOut`,
 * `cart.receiveOrder` and `menu.applyCart`. The single-row lockers
 * (`cart.add`, `setStatus`, `updateItem`, `remove`) stay lock-free on purpose —
 * one row cannot form a cycle, and paying for the lock on the cart's most
 * frequent taps would slow the shared screen for nothing.
 */
export function lockHousehold(
  tx: SqlExecutor,
  householdId: string,
): Promise<unknown> {
  return tx.execute(householdLockStatement(householdId));
}

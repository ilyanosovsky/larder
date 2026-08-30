import { TRPCError } from "@trpc/server";
import { isSQLWrapper, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { pantryItems } from "@/db/schema";
import { createCaller } from "@/server/api/root";
import { TRIP_HISTORY_LIMIT } from "@/server/api/routers/trip";
import {
  anonymousContext,
  createDbStub,
  signedInContext,
  unusableDb,
  type RecordedStatement,
  type StubResult,
} from "@/server/api/test-support";

const HOUSEHOLD_ID = "3f1a6d0e-0000-4000-8000-000000000001";
const PRODUCT_ID = "3f1a6d0e-0000-4000-8000-000000000201";
const OTHER_PRODUCT_ID = "3f1a6d0e-0000-4000-8000-000000000202";
const ITEM_ID = "3f1a6d0e-0000-4000-8000-000000000401";
const OTHER_ITEM_ID = "3f1a6d0e-0000-4000-8000-000000000402";
const TRIP_ID = "3f1a6d0e-0000-4000-8000-000000000501";

const membershipRow = {
  membership: {
    id: "membership_1",
    householdId: HOUSEHOLD_ID,
    userId: "user_1",
    joinedAt: new Date("2026-08-01T00:00:00.000Z"),
  },
  household: {
    id: HOUSEHOLD_ID,
    name: "Наш дом",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
};

function callerWith(results: StubResult[]) {
  const stub = createDbStub(results);
  return { caller: createCaller(signedInContext(stub.db)), stub };
}

function hasCode(code: TRPCError["code"]) {
  return (error: unknown) => error instanceof TRPCError && error.code === code;
}

function compile(clause: unknown) {
  expect(isSQLWrapper(clause)).toBe(true);
  return new PgDialect().sqlToQuery((clause as SQLWrapper).getSQL());
}

function expectScopedByHousehold(statement: RecordedStatement | undefined) {
  expect(compile(statement?.wheres[0]).sql).toContain('"household_id"');
}

/**
 * The happy path's statements, in order:
 *
 * 0 household membership · 1 the advisory lock · 2 the locking read of bought
 * lines · 3 the trip row · 4 the stamp · 5 the pantry upsert.
 */
function closePreamble(
  bought: StubResult = [{ id: ITEM_ID }],
  trip: StubResult = [{ id: TRIP_ID }],
  stamped: StubResult = [{ productId: PRODUCT_ID }],
): StubResult[] {
  return [[membershipRow], [], bought, trip, stamped, []];
}

describe("trip.close", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.trip.close()).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.trip.close()).rejects.toSatisfy(hasCode("FORBIDDEN"));
  });

  it("takes the household's advisory lock as the very first statement of the transaction", async () => {
    // The whole deadlock design (see `src/server/household-lock.ts`) rests on
    // this being *first*: `pantry.ranOut` locks pantry→cart and this
    // transaction locks cart→pantry, so a lock taken even one statement later
    // would leave the 40P01 cycle wide open. Nothing else in this suite fails
    // if the call moves or disappears, which is exactly why this test exists.
    const { caller, stub } = callerWith(closePreamble());

    await caller.trip.close();

    const lock = stub.statements[1];
    expect(lock).toMatchObject({ kind: "execute", txDepth: 1 });
    const compiled = compile(lock?.query);
    expect(compiled.sql).toContain("pg_advisory_xact_lock");
    expect(compiled.params).toEqual([HOUSEHOLD_ID]);

    // Every write of this transaction comes after it.
    for (const statement of stub.statements.slice(2)) {
      expect(statement.txDepth).toBe(1);
    }
  });

  describe("nothing bought", () => {
    it("is a no-op: no trip row, no stamp, no pantry write", async () => {
      const { caller, stub } = callerWith([[membershipRow], [], []]);

      await expect(caller.trip.close()).resolves.toEqual({
        tripId: null,
        count: 0,
        productIds: [],
      });

      // household → advisory lock → the read that found nothing. A trip row
      // minted here would be an empty entry in the S12 history for a tap that
      // did nothing — the same idempotent no-op `cart.receiveOrder` returns.
      expect(stub.statements).toHaveLength(3);
    });
  });

  describe("with bought lines", () => {
    it("reads them locked, scoped to this household's active bought lines", async () => {
      const { caller, stub } = callerWith(closePreamble());

      await caller.trip.close();

      const read = stub.statements[2];
      expect(read).toMatchObject({ kind: "select", table: "cart_items" });
      // `FOR UPDATE` is what pins the answer: a partner un-ticking a line
      // blocks until this transaction commits, so the set counted is the set
      // stamped and an empty trip can never be left behind.
      expect(read?.lock).toMatchObject({ strength: "update" });
      expectScopedByHousehold(read);

      const where = compile(read?.wheres[0]);
      expect(where.sql).toContain('"trip_id" is null');
      expect(where.sql).toContain('"status"');
      // The **value**, not just the column: VISION §3.1 says «Позиции "нужно"
      // и "заказано" остаются в корзине», and asserting only that a status
      // predicate exists lets the literal drift to `needed` with every test
      // in the repo still green — which would sweep the whole cart into the
      // pantry.
      expect(where.params).toEqual(
        expect.arrayContaining([HOUSEHOLD_ID, "bought"]),
      );
    });

    it("creates the trip row for the caller's own household", async () => {
      const { caller, stub } = callerWith(closePreamble());

      await caller.trip.close();

      expect(stub.statements[3]).toMatchObject({
        kind: "insert",
        table: "shopping_trips",
        values: { householdId: HOUSEHOLD_ID },
      });
    });

    it("stamps the trip id on exactly the lines it read, re-checking the scope", async () => {
      const { caller, stub } = callerWith(
        closePreamble(
          [{ id: ITEM_ID }, { id: OTHER_ITEM_ID }],
          [{ id: TRIP_ID }],
          [{ productId: PRODUCT_ID }, { productId: OTHER_PRODUCT_ID }],
        ),
      );

      await caller.trip.close();

      const stamp = stub.statements[4];
      expect(stamp).toMatchObject({
        kind: "update",
        table: "cart_items",
        values: { tripId: TRIP_ID },
      });

      const where = compile(stamp?.wheres[0]);
      // The ids, plus the household and the active/bought predicates: an id
      // never reaches a write on its own (VISION §6.7), and a line another
      // transaction carried off first must not land in a second trip.
      // `"bought"` is pinned by value here too — the read and the stamp
      // drifting *together* to another status would otherwise stay green.
      expect(where.params).toEqual(
        expect.arrayContaining([
          ITEM_ID,
          OTHER_ITEM_ID,
          HOUSEHOLD_ID,
          "bought",
        ]),
      );
      expect(where.sql).toContain('"household_id"');
      expect(where.sql).toContain('"trip_id" is null');
      expect(where.sql).toContain('"status"');
    });

    it("upserts pantry presence for every stamped product", async () => {
      const { caller, stub } = callerWith(
        closePreamble(
          [{ id: ITEM_ID }, { id: OTHER_ITEM_ID }],
          [{ id: TRIP_ID }],
          [{ productId: PRODUCT_ID }, { productId: OTHER_PRODUCT_ID }],
        ),
      );

      await caller.trip.close();

      const upsert = stub.statements[5];
      expect(upsert).toMatchObject({ kind: "insert", table: "pantry_items" });
      // Presence only (VISION §3.2) — the pair of ids and nothing else.
      expect(upsert?.values).toEqual([
        { householdId: HOUSEHOLD_ID, productId: PRODUCT_ID },
        { householdId: HOUSEHOLD_ID, productId: OTHER_PRODUCT_ID },
      ]);
      expect(upsert?.onConflict?.target).toBe(pantryItems.productId);
      // `DO UPDATE`, not `DO NOTHING`: buying something the pantry already
      // lists is a fresher fact about the same product, not a no-op.
      const set = upsert?.onConflict?.set as { updatedAt?: unknown };
      expect(compile(set.updatedAt).sql).toBe("now()");
      // Even the conflict path repeats the household check.
      expect(compile(upsert?.onConflict?.setWhere).sql).toContain(
        '"household_id"',
      );
    });

    it("de-duplicates products before the upsert", async () => {
      // Unreachable while the partial unique index holds (one active line per
      // product), and guarded anyway: a multi-row `ON CONFLICT DO UPDATE`
      // whose values hit one key twice is a hard Postgres error (21000), so
      // an impossible state would surface as a failed purchase.
      const { caller, stub } = callerWith(
        closePreamble(
          [{ id: ITEM_ID }, { id: OTHER_ITEM_ID }],
          [{ id: TRIP_ID }],
          [{ productId: PRODUCT_ID }, { productId: PRODUCT_ID }],
        ),
      );

      await expect(caller.trip.close()).resolves.toEqual({
        tripId: TRIP_ID,
        count: 2,
        productIds: [PRODUCT_ID],
      });

      expect(stub.statements[5]?.values).toEqual([
        { householdId: HOUSEHOLD_ID, productId: PRODUCT_ID },
      ]);
    });

    it("returns the trip, the line count and what moved to the pantry", async () => {
      const { caller } = callerWith(
        closePreamble(
          [{ id: ITEM_ID }, { id: OTHER_ITEM_ID }],
          [{ id: TRIP_ID }],
          [{ productId: PRODUCT_ID }, { productId: OTHER_PRODUCT_ID }],
        ),
      );

      await expect(caller.trip.close()).resolves.toEqual({
        tripId: TRIP_ID,
        count: 2,
        productIds: [PRODUCT_ID, OTHER_PRODUCT_ID],
      });
    });

    it("fails rather than continuing when the trip row comes back empty", async () => {
      const { caller } = callerWith(closePreamble([{ id: ITEM_ID }], []));

      await expect(caller.trip.close()).rejects.toSatisfy(
        hasCode("INTERNAL_SERVER_ERROR"),
      );
    });

    it("rolls back rather than leaving an empty trip when the stamp matches nothing", async () => {
      const { caller, stub } = callerWith(
        closePreamble([{ id: ITEM_ID }], [{ id: TRIP_ID }], []),
      );

      await expect(caller.trip.close()).rejects.toSatisfy(
        hasCode("INTERNAL_SERVER_ERROR"),
      );
      // Throwing is the point: the trip row is already inserted in this
      // transaction, so rolling back is the only way not to leave a history
      // entry describing nothing. Nothing runs after the failed stamp.
      expect(stub.statements).toHaveLength(5);
    });
  });
});

describe("trip.list", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.trip.list()).rejects.toSatisfy(hasCode("UNAUTHORIZED"));
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.trip.list()).rejects.toSatisfy(hasCode("FORBIDDEN"));
  });

  it("returns each trip with its own item count", async () => {
    const { caller } = callerWith([
      [membershipRow],
      [
        {
          id: TRIP_ID,
          closedAt: new Date("2026-08-22T17:30:00.000Z"),
          itemCount: 7,
        },
      ],
    ]);

    await expect(caller.trip.list()).resolves.toEqual([
      {
        id: TRIP_ID,
        closedAt: new Date("2026-08-22T17:30:00.000Z"),
        itemCount: 7,
      },
    ]);
  });

  it("rejects a count the driver handed back as a string", async () => {
    // `count()` is `bigint`, which arrives as a string unless it is cast —
    // the `::int` in the projection is what keeps this from happening, and
    // this test is what would notice the cast being dropped.
    const { caller } = callerWith([
      [membershipRow],
      [
        {
          id: TRIP_ID,
          closedAt: new Date("2026-08-22T17:30:00.000Z"),
          itemCount: "7",
        },
      ],
    ]);

    await expect(caller.trip.list()).rejects.toThrow();
  });

  it("reads only this household's trips, newest first, one row per trip", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.trip.list();

    const select = stub.statements[1];
    expect(select).toMatchObject({ kind: "select", table: "shopping_trips" });
    expectScopedByHousehold(select);
    expect(compile(select?.orderBys[0]).sql).toBe(
      '"shopping_trips"."closed_at" desc',
    );
    expect(compile(select?.groupBys[0]).sql).toBe('"shopping_trips"."id"');
  });

  it("caps the history at TRIP_HISTORY_LIMIT rows", async () => {
    // The cap is behaviour, not decoration: a `.limit(0)` here would render
    // the S12 block permanently empty, and asserting the constant separately
    // is what keeps the two from drifting to zero together.
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.trip.list();

    expect(TRIP_HISTORY_LIMIT).toBeGreaterThan(0);
    expect(stub.statements[1]?.limit).toBe(TRIP_HISTORY_LIMIT);
  });

  it("scopes the joined cart lines by household too", async () => {
    // Defense in depth, the same shape every other statement here uses: a
    // trip's own lines are this household's by construction, and the join
    // says so rather than relying on an argument about another table.
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.trip.list();

    const join = stub.statements[1]?.joins[0];
    expect(compile(join).sql).toContain('"cart_items"."household_id"');
    expect(compile(join).params).toEqual([HOUSEHOLD_ID]);
  });
});

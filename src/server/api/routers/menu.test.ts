import { TRPCError } from "@trpc/server";
import { isSQLWrapper, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { menuItems, weekMenus } from "@/db/schema";
import { createCaller } from "@/server/api/root";
import { ensureWeekMenu } from "@/server/api/routers/menu";
import {
  anonymousContext,
  createDbStub,
  signedInContext,
  unusableDb,
  type RecordedStatement,
  type StubResult,
} from "@/server/api/test-support";
import { weekStartOf } from "@/server/menu/week";

const HOUSEHOLD_ID = "3f1a6d0e-0000-4000-8000-000000000001";
const OTHER_HOUSEHOLD_ID = "3f1a6d0e-0000-4000-8000-000000000002";
const DISH_ID = "3f1a6d0e-0000-4000-8000-000000000601";
const WEEK_MENU_ID = "3f1a6d0e-0000-4000-8000-000000000701";
const ITEM_ID = "3f1a6d0e-0000-4000-8000-000000000801";

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

function menuRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    dishId: DISH_ID,
    title: "Лазанья болоньезе",
    photoUrl: null,
    tags: ["ужин", "духовка"],
    totalTimeMin: 75,
    portions: 4,
    portionsBase: 4,
    portionsMin: null,
    yieldUnit: null,
    cookedAt: null,
    archivedAt: null,
    addedById: "user_1",
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    updatedAt: new Date("2026-08-20T10:00:00.000Z"),
    ...overrides,
  };
}

function stateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    portions: 4,
    cookedAt: null,
    updatedAt: new Date("2026-08-20T10:05:00.000Z"),
    ...overrides,
  };
}

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
  const where = compile(statement?.wheres[0]);
  expect(where.sql).toContain('"household_id"');
  expect(where.params).toEqual(expect.arrayContaining([HOUSEHOLD_ID]));
}

/**
 * The week the server will compute for "now".
 *
 * Derived through `weekStartOf` rather than hard-coded, because the whole
 * point of the assertions below is that the value the router binds is the one
 * this function produces — a literal would go stale the moment the suite ran
 * in a different week, and pinning `Date.now()` would prove nothing about
 * which calendar the router used.
 */
function currentWeekStart(): string {
  return weekStartOf(new Date());
}

describe("menu.current", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.menu.current()).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.menu.current()).rejects.toSatisfy(hasCode("FORBIDDEN"));
  });

  it("binds the literal week the server computed, scoped to the household", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.menu.current();

    const read = stub.statements[1];
    expect(read).toMatchObject({ kind: "select", table: "week_menus" });
    // The **value**, not just the column: `weekStartOf` living in TypeScript
    // is precisely what makes the bound literal assertable, and a
    // `date_trunc('week', now())` in SQL would make this test impossible
    // while quietly depending on the session's `TimeZone`.
    const where = compile(read?.wheres[0]);
    expect(where.sql).toContain('"household_id"');
    expect(where.sql).toContain('"week_start"');
    expect(where.params).toEqual([HOUSEHOLD_ID, currentWeekStart()]);
    expect(read?.lock).toBeNull();
  });

  it("ends after one statement and writes nothing when the week has no row", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    const result = await caller.menu.current();

    expect(result).toEqual({
      weekStart: currentWeekStart(),
      weekEnd: expect.any(String),
      id: null,
      items: [],
      lastBuiltAt: null,
    });
    // The lazy-creation rule: a read must never mint the row. Membership +
    // the week read and nothing more.
    expect(stub.statements).toHaveLength(2);
    expect(stub.statements.every((s) => s.kind === "select")).toBe(true);
  });

  it("returns the week's closing Sunday so the header needs no arithmetic", async () => {
    const { caller } = callerWith([[membershipRow], []]);

    const result = await caller.menu.current();

    expect(new Date(`${result.weekEnd}T00:00:00.000Z`).getUTCDay()).toBe(0);
  });

  it("reads the pool scoped on the table and on both joins, oldest first", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: WEEK_MENU_ID, lastBuiltAt: null }],
      [menuRow()],
    ]);

    const result = await caller.menu.current();

    expect(result.id).toBe(WEEK_MENU_ID);
    expect(result.items).toHaveLength(1);

    const pool = stub.statements[2];
    expect(pool).toMatchObject({ kind: "select", table: "menu_items" });
    expect(pool?.lock).toBeNull();

    // Both predicates, and both bound values: `expectScopedByHousehold`
    // alone survives the week predicate being deleted or pointed at the
    // wrong column, and the pool would then be every week at once.
    const poolWhere = compile(pool?.wheres[0]);
    expect(poolWhere.sql).toContain('"household_id"');
    expect(poolWhere.sql).toContain('"week_menu_id"');
    expect(poolWhere.params).toEqual([HOUSEHOLD_ID, WEEK_MENU_ID]);

    // The projection, because every content assertion in this file reads the
    // row the stub was handed rather than the column the router selected —
    // and `MenuItemOutput` types each field, so a swap between two columns
    // of the same type ships green through lint, typecheck and the suite.
    // `dishes.archived_at → dishes.created_at` would put a permanent «в
    // архиве» chip on every card.
    const fields = pool?.fields as Record<string, unknown>;
    expect(Object.keys(fields)).toEqual([
      "id",
      "dishId",
      "title",
      "photoUrl",
      "tags",
      "totalTimeMin",
      "portions",
      "portionsBase",
      "portionsMin",
      "yieldUnit",
      "cookedAt",
      "archivedAt",
      "addedById",
      "createdAt",
      "updatedAt",
    ]);
    // All fifteen, not a sample: a partial list is indistinguishable from no
    // list for the columns it omits, and the pairs that share a SQL type —
    // `total_time_min`/`portions_min` and `photo_url`/`yield_unit` — are
    // exactly the swaps neither tsc nor zod can see.
    expect(compile(fields.id).sql).toContain('"menu_items"."id"');
    expect(compile(fields.dishId).sql).toContain('"dish_id"');
    expect(compile(fields.title).sql).toContain('"title"');
    expect(compile(fields.photoUrl).sql).toContain('"photo_url"');
    expect(compile(fields.tags).sql).toContain('"tags"');
    expect(compile(fields.totalTimeMin).sql).toContain('"total_time_min"');
    expect(compile(fields.portions).sql).toContain('"menu_items"."portions"');
    expect(compile(fields.portionsBase).sql).toContain('"portions_base"');
    expect(compile(fields.portionsMin).sql).toContain('"portions_min"');
    expect(compile(fields.yieldUnit).sql).toContain('"yield_unit"');
    expect(compile(fields.cookedAt).sql).toContain('"cooked_at"');
    expect(compile(fields.archivedAt).sql).toContain('"archived_at"');
    expect(compile(fields.addedById).sql).toContain('"added_by"');
    expect(compile(fields.createdAt).sql).toContain('"menu_items"."created_at"');
    expect(compile(fields.updatedAt).sql).toContain('"menu_items"."updated_at"');

    // A join condition is exactly where a household predicate goes missing
    // without any `where` noticing (VISION §6.7).
    expect(pool?.joins).toHaveLength(2);
    for (const join of pool?.joins ?? []) {
      const compiled = compile(join);
      expect(compiled.sql).toContain('"household_id"');
      expect(compiled.params).toEqual(
        expect.arrayContaining([HOUSEHOLD_ID]),
      );
    }

    // Ascending, unlike `dish.list`: S10 is a pool you assemble, and a card
    // appearing next to «+ Блюдо» is where the eye already is. `id` is the
    // tiebreak for two rows added in the same millisecond.
    expect(pool?.orderBys).toHaveLength(2);
    expect(compile(pool?.orderBys[0]).sql).toContain('"created_at" asc');
    expect(compile(pool?.orderBys[1]).sql).toContain('"id" asc');
  });

  it("carries lastBuiltAt and an archived dish's own stamp through", async () => {
    const builtAt = new Date("2026-08-21T09:00:00.000Z");
    const archivedAt = new Date("2026-08-19T09:00:00.000Z");
    const { caller } = callerWith([
      [membershipRow],
      [{ id: WEEK_MENU_ID, lastBuiltAt: builtAt }],
      [menuRow({ archivedAt })],
    ]);

    const result = await caller.menu.current();

    expect(result.lastBuiltAt).toEqual(builtAt);
    // Archived dishes stay in the pool — `dish.archiveHint`'s standing
    // promise, and why `menu_items.dish_id` is RESTRICT.
    expect(result.items[0]?.archivedAt).toEqual(archivedAt);
  });
});

describe("menu.addDish", () => {
  /** household → the ownership read → the week upsert → the insert → the re-read. */
  function addPreamble(
    dish: StubResult = [{ id: DISH_ID }],
    week: StubResult = [{ id: WEEK_MENU_ID }],
    inserted: StubResult = [{ id: ITEM_ID }],
    reread: StubResult = [menuRow()],
  ): StubResult[] {
    return [[membershipRow], dish, week, inserted, reread];
  }

  const input = { dishId: DISH_ID, portions: 4 };

  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.menu.addDish(input)).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.menu.addDish(input)).rejects.toSatisfy(
      hasCode("FORBIDDEN"),
    );
  });

  it("checks ownership first, outside the transaction, refusing archived dishes", async () => {
    const { caller, stub } = callerWith(addPreamble());

    await caller.menu.addDish(input);

    const ownership = stub.statements[1];
    expect(ownership).toMatchObject({
      kind: "select",
      table: "dishes",
      // Outside the transaction: an id from another household has to be
      // refused before anything is written, not rolled back afterwards.
      txDepth: 0,
    });
    const where = compile(ownership?.wheres[0]);
    expect(where.sql).toContain('"household_id"');
    expect(where.sql).toContain('"archived_at" is null');
    expect(where.params).toEqual(
      expect.arrayContaining([DISH_ID, HOUSEHOLD_ID]),
    );
    // The recipe join carries the household too — the pair is what makes the
    // portions columns 5.3 and the picker read trustworthy.
    expect(compile(ownership?.joins[0]).params).toEqual(
      expect.arrayContaining([HOUSEHOLD_ID]),
    );
  });

  it("refuses an unknown, archived or foreign dish with no write at all", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await expect(caller.menu.addDish(input)).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );

    expect(stub.statements).toHaveLength(2);
    expect(stub.statements.every((s) => s.kind === "select")).toBe(true);
  });

  it("upserts the week row inside the transaction, re-checking the household", async () => {
    const { caller, stub } = callerWith(addPreamble());

    await caller.menu.addDish(input);

    const upsert = stub.statements[2];
    expect(upsert).toMatchObject({
      kind: "insert",
      table: "week_menus",
      values: { householdId: HOUSEHOLD_ID, weekStart: currentWeekStart() },
      txDepth: 1,
    });
    expect(upsert?.onConflict?.target).toEqual([
      weekMenus.householdId,
      weekMenus.weekStart,
    ]);
    // `DO UPDATE`, not `DO NOTHING`: it is what makes `RETURNING` yield a row
    // on the conflicting path, so no second read reopens the race.
    const set = upsert?.onConflict?.set as { updatedAt?: unknown };
    expect(compile(set.updatedAt).sql).toBe("now()");
    expect(compile(upsert?.onConflict?.setWhere).sql).toContain(
      '"household_id"',
    );
  });

  it("inserts the item with DO NOTHING on the (week, dish) pair", async () => {
    const { caller, stub } = callerWith(addPreamble());

    await caller.menu.addDish(input);

    const insert = stub.statements[3];
    expect(insert).toMatchObject({
      kind: "insert",
      table: "menu_items",
      onConflictDoNothing: true,
      txDepth: 1,
      values: {
        householdId: HOUSEHOLD_ID,
        weekMenuId: WEEK_MENU_ID,
        dishId: DISH_ID,
        portions: 4,
        addedBy: "user_1",
      },
    });
    // Targeted, not bare. A bare `DO NOTHING` behaves identically today —
    // `menu_items` has exactly one unique index — but it would silently
    // absorb any unique constraint the table ever grows, and `addDish` would
    // then answer `alreadyInMenu` for a row it never wrote.
    expect(insert?.onConflictNothing?.target).toEqual([
      menuItems.weekMenuId,
      menuItems.dishId,
    ]);
  });

  it("re-reads the joined row and reports «added» when the insert won", async () => {
    const { caller, stub } = callerWith(addPreamble());

    await expect(caller.menu.addDish(input)).resolves.toMatchObject({
      outcome: "added",
      item: { id: ITEM_ID, dishId: DISH_ID, portions: 4 },
    });

    const reread = stub.statements[4];
    expect(reread).toMatchObject({ kind: "select", table: "menu_items" });
    expectScopedByHousehold(reread);
    expect(compile(reread?.wheres[0]).params).toEqual(
      expect.arrayContaining([HOUSEHOLD_ID, WEEK_MENU_ID, DISH_ID]),
    );
  });

  it("reports «alreadyInMenu» — with the untouched row — when the insert conflicted", async () => {
    // The replay-safety case, and the one that must not bump portions: the
    // stored row keeps the 2 a partner set, not the 4 this call sent.
    const { caller, stub } = callerWith(
      addPreamble([{ id: DISH_ID }], [{ id: WEEK_MENU_ID }], [], [
        menuRow({ portions: 2 }),
      ]),
    );

    await expect(caller.menu.addDish(input)).resolves.toEqual({
      outcome: "alreadyInMenu",
      item: expect.objectContaining({ portions: 2 }),
    });

    // The re-read runs on both branches — five statements either way.
    expect(stub.statements).toHaveLength(5);
    expect(stub.statements.filter((s) => s.kind === "update")).toHaveLength(0);
  });

  it("refuses portions outside 1…MAX_PORTIONS before touching either menu table", async () => {
    // The bound is `MAX_PORTIONS`, not `portionsRange(base)`: a stored value
    // has to survive a partner editing the recipe's yield downward, so the
    // server must not re-clamp a number it accepted last week.
    for (const portions of [0, 101]) {
      const { caller, stub } = callerWith([[membershipRow]]);

      await expect(
        caller.menu.addDish({ dishId: DISH_ID, portions }),
      ).rejects.toSatisfy(hasCode("BAD_REQUEST"));

      // `householdProcedure`'s membership read runs before input validation,
      // so it is the *menu* tables that must stay untouched.
      expect(stub.statements.map((statement) => statement.table)).toEqual([
        "household_members",
      ]);
    }
  });

  it("answers CONFLICT rather than guessing if the re-read finds nothing", async () => {
    // Reachable under READ COMMITTED: `DO NOTHING` takes no lock on the
    // conflicting row, and a partner's unlocked `removeDish` can land in the
    // round trip between the insert and the re-read. Nothing is broken and
    // the retry succeeds, so it is a conflict, not a server fault.
    const { caller } = callerWith(
      addPreamble([{ id: DISH_ID }], [{ id: WEEK_MENU_ID }], [{ id: ITEM_ID }], []),
    );

    await expect(caller.menu.addDish(input)).rejects.toSatisfy(
      hasCode("CONFLICT"),
    );
  });
});

/**
 * The stub is a drizzle-shaped query builder, not a real transaction handle —
 * the same fiction `createDbStub().db` already is for `ctx.db`. Narrowed here
 * once so the two cases below read as tests rather than as casts.
 */
function asTransaction(db: unknown): Parameters<typeof ensureWeekMenu>[0] {
  return db as Parameters<typeof ensureWeekMenu>[0];
}

describe("ensureWeekMenu", () => {
  it("throws NOT_FOUND when the household-scoped setWhere matched nothing", async () => {
    // `setWhere` exists precisely so a conflicting row belonging to somebody
    // else degrades to "left alone" — which means `DO UPDATE` can update no
    // row and return none. A `!` here would be a crash in the one case the
    // predicate is for.
    const stub = createDbStub([[]]);

    await expect(
      ensureWeekMenu(asTransaction(stub.db), OTHER_HOUSEHOLD_ID, "2026-08-03"),
    ).rejects.toSatisfy(hasCode("NOT_FOUND"));
  });

  it("returns the row the upsert produced", async () => {
    const stub = createDbStub([[{ id: WEEK_MENU_ID }]]);

    await expect(
      ensureWeekMenu(asTransaction(stub.db), HOUSEHOLD_ID, "2026-08-03"),
    ).resolves.toBe(WEEK_MENU_ID);
  });
});

describe("menu.setPortions", () => {
  const input = { id: ITEM_ID, portions: 6 };

  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.menu.setPortions(input)).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.menu.setPortions(input)).rejects.toSatisfy(
      hasCode("FORBIDDEN"),
    );
  });

  it("is one scoped UPDATE with no read before it", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [stateRow({ portions: 6 })],
    ]);

    await expect(caller.menu.setPortions(input)).resolves.toMatchObject({
      id: ITEM_ID,
      portions: 6,
    });

    // Last write wins: a ± tap must never depend on having read the row
    // first, or two partners nudging one card would fight over a stale base.
    expect(stub.statements).toHaveLength(2);
    const update = stub.statements[1];
    expect(update).toMatchObject({
      kind: "update",
      table: "menu_items",
      txDepth: 0,
    });
    expect(update?.values).toMatchObject({ portions: 6 });
    expect(compile((update?.values as { updatedAt: unknown }).updatedAt).sql).toBe(
      "now()",
    );

    const where = compile(update?.wheres[0]);
    expect(where.sql).toContain('"id"');
    expect(where.sql).toContain('"household_id"');
    expect(where.params).toEqual([ITEM_ID, HOUSEHOLD_ID]);
  });

  it("answers NOT_FOUND when nothing matched", async () => {
    const { caller } = callerWith([[membershipRow], []]);

    await expect(caller.menu.setPortions(input)).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );
  });

  it("refuses portions outside 1…MAX_PORTIONS before touching menu_items", async () => {
    const { caller, stub } = callerWith([[membershipRow]]);

    await expect(
      caller.menu.setPortions({ id: ITEM_ID, portions: 0 }),
    ).rejects.toSatisfy(hasCode("BAD_REQUEST"));

    expect(stub.statements.map((statement) => statement.table)).toEqual([
      "household_members",
    ]);
  });
});

describe("menu.setCooked", () => {
  const input = { id: ITEM_ID, cooked: true };

  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.menu.setCooked(input)).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.menu.setCooked(input)).rejects.toSatisfy(
      hasCode("FORBIDDEN"),
    );
  });

  it("stamps now() when ticked, in one scoped UPDATE with no read before it", async () => {
    const cookedAt = new Date("2026-08-21T12:00:00.000Z");
    const { caller, stub } = callerWith([[membershipRow], [stateRow({ cookedAt })]]);

    await expect(caller.menu.setCooked(input)).resolves.toMatchObject({
      cookedAt,
    });

    expect(stub.statements).toHaveLength(2);
    const update = stub.statements[1];
    expect(update).toMatchObject({ kind: "update", table: "menu_items" });
    expect(
      compile((update?.values as { cookedAt: unknown }).cookedAt).sql,
    ).toBe("now()");
    expect(compile(update?.wheres[0]).params).toEqual([ITEM_ID, HOUSEHOLD_ID]);
  });

  it("clears the stamp when unticked", async () => {
    const { caller, stub } = callerWith([[membershipRow], [stateRow()]]);

    await expect(
      caller.menu.setCooked({ id: ITEM_ID, cooked: false }),
    ).resolves.toMatchObject({ cookedAt: null });

    expect(
      (stub.statements[1]?.values as { cookedAt: unknown }).cookedAt,
    ).toBeNull();
  });

  it("answers NOT_FOUND when nothing matched", async () => {
    // A state-shaped mutation is honest about a row that is gone — unlike
    // `removeDish` below, whose desired state is reached either way.
    const { caller } = callerWith([[membershipRow], []]);

    await expect(caller.menu.setCooked(input)).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );
  });
});

describe("menu.removeDish", () => {
  const input = { id: ITEM_ID };

  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.menu.removeDish(input)).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.menu.removeDish(input)).rejects.toSatisfy(
      hasCode("FORBIDDEN"),
    );
  });

  it("is one DELETE scoped by id and household", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);

    await caller.menu.removeDish(input);

    expect(stub.statements).toHaveLength(2);
    const remove = stub.statements[1];
    expect(remove).toMatchObject({
      kind: "delete",
      table: "menu_items",
      txDepth: 0,
    });
    expect(compile(remove?.wheres[0]).params).toEqual([ITEM_ID, HOUSEHOLD_ID]);
  });

  it("is idempotent — a row already gone is not an error", async () => {
    // Both partners clearing the same card is ordinary, not a failure, and
    // the desired state is reached either way. `cart.remove`'s own rule.
    const { caller } = callerWith([[membershipRow], []]);

    await expect(caller.menu.removeDish(input)).resolves.toBeUndefined();
  });
});

describe("the menu router as a whole", () => {
  it("never takes the household advisory lock", async () => {
    // It touches `week_menus` and `menu_items` only, so it cannot form the
    // lock-order cycle `household-lock.ts` exists for. 5.2's `applyCart`,
    // which writes `cart_items` in bulk, is the one that will.
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: DISH_ID }],
      [{ id: WEEK_MENU_ID }],
      [{ id: ITEM_ID }],
      [menuRow()],
    ]);

    await caller.menu.addDish({ dishId: DISH_ID, portions: 4 });

    expect(stub.statements.some((s) => s.kind === "execute")).toBe(false);
  });

  it("writes only the two menu tables", async () => {
    const { caller, stub } = callerWith([
      [membershipRow],
      [{ id: DISH_ID }],
      [{ id: WEEK_MENU_ID }],
      [{ id: ITEM_ID }],
      [menuRow()],
    ]);

    await caller.menu.addDish({ dishId: DISH_ID, portions: 4 });

    const written = stub.statements
      .filter((s) => s.kind !== "select")
      .map((s) => s.table);
    expect(new Set(written)).toEqual(new Set(["week_menus", "menu_items"]));
  });
});

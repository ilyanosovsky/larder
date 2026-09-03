import { getTableName, type Table } from "drizzle-orm";

import type { AiChatClient } from "@/server/ai/openai";
import type { UploadedFileStore } from "@/server/uploadthing-files";

import type { TRPCContext } from "./trpc";

/**
 * Test-only helpers. Never imported by application code — routers get a real
 * `ctx.db`, and unit tests get the stub below instead of a database
 * connection (AGENTS.md: no network, no env, no Postgres in vitest).
 */

type SessionData = NonNullable<TRPCContext["session"]>;
type UserData = NonNullable<TRPCContext["user"]>;

/**
 * The database must never be reached — any property access blows up loudly
 * instead of silently doing I/O. Use this for procedures that should fail
 * before they ever query.
 */
export const unusableDb = new Proxy({} as TRPCContext["db"], {
  get(_target, property) {
    throw new Error(
      `ctx.db must not be touched in unit tests (accessed "${String(property)}")`,
    );
  },
});

export const testSession: SessionData = {
  id: "session_1",
  token: "token_1",
  userId: "user_1",
  expiresAt: new Date("2100-01-01T00:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

export const testUser: UserData = {
  id: "user_1",
  email: "kira@example.com",
  name: "Кира",
  emailVerified: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  image: null,
};

/**
 * OpenAI must never be reached either — same idea as `unusableDb`. Every
 * procedure that makes an AI call takes its client from the context, so a
 * test that forgets to supply a fake one fails loudly instead of dialing out
 * to a paid API.
 */
export const unusableOpenai = (): AiChatClient => {
  throw new Error("ctx.openai() must not be called in unit tests");
};

/**
 * The upload store must never be reached either — same idea again. A test that
 * exercises `discardPhoto` has to hand over a fake and assert what it was
 * asked to delete; without this the deletion branch would run against a real
 * (or absent) token and pass either way, which is exactly how it went
 * untested.
 */
export const unusableUploadThing = (): UploadedFileStore => {
  throw new Error("ctx.uploadThing() must not be called in unit tests");
};

export function anonymousContext(
  db: TRPCContext["db"],
  openai: TRPCContext["openai"] = unusableOpenai,
  uploadThing: TRPCContext["uploadThing"] = unusableUploadThing,
): TRPCContext {
  return { session: null, user: null, db, openai, uploadThing };
}

export function signedInContext(
  db: TRPCContext["db"],
  openai: TRPCContext["openai"] = unusableOpenai,
  uploadThing: TRPCContext["uploadThing"] = unusableUploadThing,
): TRPCContext {
  return { session: testSession, user: testUser, db, openai, uploadThing };
}

/** One statement the router ran, in the order it ran it. */
export interface RecordedStatement {
  kind: "select" | "insert" | "update" | "delete" | "execute";
  /** Table name, once the builder revealed one (`from`/`insert`/`update`). */
  table: string | null;
  /** Payload handed to `.values()` or `.set()`. */
  values: unknown;
  /**
   * The projection handed to `.select({ … })`, or `undefined` for a bare
   * `.select()`. Same idea as `wheres`: a computed column (an aggregate, a
   * `FILTER`) can be compiled with `PgDialect` to check the SQL *and the
   * parameters* it produces — which is the only way a stub-based test can
   * catch a value bound without its column's type.
   */
  fields: unknown;
  /**
   * Conditions handed to `.where()`. The stub cannot evaluate them, but a
   * test can compile one with `PgDialect` to assert which columns a guard
   * actually covers — see the invite claim tests.
   */
  wheres: unknown[];
  /**
   * Columns/expressions handed to `.orderBy()`, in call order. Same idea as
   * `wheres`: compile one with `PgDialect` to assert which column a sort —
   * or a locking read that must walk rows in a fixed order — actually uses.
   */
  orderBys: unknown[];
  /**
   * Columns/expressions handed to `.groupBy()`, in call order — what an
   * aggregate (`trip.list`'s per-trip item count) collapses rows by.
   */
  groupBys: unknown[];
  /**
   * The raw SQL handed to `db.execute()`, or `undefined` for a statement
   * built through the query builder. Compile it with `PgDialect` the way
   * `wheres` are compiled: that is how a test asserts a statement with no
   * builder of its own — a `pg_advisory_xact_lock`, say — is issued at all,
   * in the right place, and with the right parameters.
   */
  query: unknown;
  /**
   * The row cap handed to `.limit()`, or `null` if the statement never
   * capped. Recorded rather than swallowed: a cap is a real behavioural
   * decision (`trip.list`'s history limit), and a stub that drops it lets
   * `.limit(0)` pass every test while rendering a permanently empty screen.
   */
  limit: number | null;
  /**
   * The lock strength and config handed to `.for()` (e.g.
   * `.for("update")`), or `null` if the statement never locked. `for()`
   * takes a plain string rather than a SQL fragment, so this is asserted
   * directly instead of compiled.
   */
  lock: { strength: unknown; config: unknown } | null;
  /**
   * Conditions handed to `.innerJoin()`/`.leftJoin()`, in call order —
   * compiled like `wheres`. A join condition is a place a household
   * predicate can silently go missing, so it has to be assertable.
   */
  joins: unknown[];
  /**
   * The config handed to `.onConflictDoUpdate({ target, set, setWhere })`, or
   * `null` for an insert that never upserts. `target` is a real column
   * reference and `setWhere` a condition, so a test compiles them the same
   * way `wheres` are compiled.
   */
  onConflict: {
    target: unknown;
    set: unknown;
    setWhere?: unknown;
  } | null;
  /**
   * How many `transaction()` callbacks the statement was issued inside: `0`
   * for a bare statement, `1` inside a transaction, `2` inside a nested one.
   *
   * Drizzle turns a nested `transaction()` into a **savepoint**, and for some
   * writes that nesting is load-bearing rather than stylistic: an insert that
   * may violate a unique index has to sit in one, because in Postgres the
   * violation otherwise aborts the whole enclosing transaction and every
   * following statement fails with 25P02. The stub cannot reproduce that — it
   * has no database — so recording the depth is what lets a test assert the
   * savepoint is there. Without it, deleting the nesting would keep every
   * other assertion green and only fail against a real Postgres.
   */
  txDepth: number;
}

/**
 * A result per awaited statement, consumed in call order. An `Error` is
 * thrown instead of resolved, which is how a constraint violation is
 * simulated.
 */
export type StubResult = unknown[] | Error;

export interface DbStub {
  db: TRPCContext["db"];
  statements: RecordedStatement[];
}

/**
 * A drizzle-shaped query-builder stub.
 *
 * Drizzle's builders are thenables that resolve to rows, and every clause
 * (`from`, `where`, `limit`, `returning`, …) returns the builder again. That
 * is the entire surface a router touches, so the stub mimics it: each clause
 * is a no-op that returns `this`, and awaiting one shifts the next queued
 * result off `results`. `transaction(fn)` runs `fn` against the same stub —
 * these tests are about the router's decisions, not about rollback semantics.
 * It does count how deeply it is nested, though, so a test can still prove a
 * write was issued inside a savepoint (see `txDepth`).
 */
export function createDbStub(results: StubResult[] = []): DbStub {
  const queue = [...results];
  const statements: RecordedStatement[] = [];
  let txDepth = 0;

  function begin(
    kind: RecordedStatement["kind"],
    table: Table | null,
    fields?: unknown,
    query?: unknown,
  ) {
    const statement: RecordedStatement = {
      kind,
      table: table === null ? null : getTableName(table),
      values: undefined,
      fields,
      wheres: [],
      orderBys: [],
      groupBys: [],
      joins: [],
      query,
      limit: null,
      lock: null,
      onConflict: null,
      txDepth,
    };
    statements.push(statement);

    const chain = {
      from(source: Table) {
        statement.table = getTableName(source);
        return chain;
      },
      values(values: unknown) {
        statement.values = values;
        return chain;
      },
      set(values: unknown) {
        statement.values = values;
        return chain;
      },
      innerJoin(_source: Table, condition?: unknown) {
        statement.joins.push(condition);
        return chain;
      },
      leftJoin(_source: Table, condition?: unknown) {
        statement.joins.push(condition);
        return chain;
      },
      where(condition: unknown) {
        statement.wheres.push(condition);
        return chain;
      },
      orderBy(...columns: unknown[]) {
        statement.orderBys.push(...columns);
        return chain;
      },
      groupBy(...columns: unknown[]) {
        statement.groupBys.push(...columns);
        return chain;
      },
      limit(rows: number) {
        statement.limit = rows;
        return chain;
      },
      for(strength: unknown, config?: unknown) {
        statement.lock = { strength, config };
        return chain;
      },
      onConflictDoUpdate(config: {
        target: unknown;
        set: unknown;
        setWhere?: unknown;
      }) {
        statement.onConflict = {
          target: config.target,
          set: config.set,
          setWhere: config.setWhere,
        };
        return chain;
      },
      returning: () => chain,
      then<TResult>(
        resolve: (rows: unknown[]) => TResult,
        reject: (error: unknown) => TResult,
      ): Promise<TResult> {
        const next = queue.shift() ?? [];
        return next instanceof Error
          ? Promise.reject(next).then(resolve, reject)
          : Promise.resolve(next).then(resolve, reject);
      },
    };

    return chain;
  }

  const db = {
    select: (fields?: unknown) => begin("select", null, fields),
    insert: (table: Table) => begin("insert", table),
    update: (table: Table) => begin("update", table),
    delete: (table: Table) => begin("delete", table),
    // Raw SQL, for the statements no builder covers — `pg_advisory_xact_lock`
    // is the only one so far. Recorded (and queued-result-consuming) like any
    // other statement, so its *position* is assertable too.
    execute: (query: unknown) => begin("execute", null, undefined, query),
    transaction: async <TResult>(fn: (tx: unknown) => Promise<TResult>) => {
      txDepth += 1;
      try {
        return await fn(db);
      } finally {
        txDepth -= 1;
      }
    },
  };

  return { db: db as unknown as TRPCContext["db"], statements };
}

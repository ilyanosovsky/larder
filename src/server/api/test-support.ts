import { getTableName, type Table } from "drizzle-orm";

import type { AiChatClient } from "@/server/ai/openai";

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

export function anonymousContext(
  db: TRPCContext["db"],
  openai: TRPCContext["openai"] = unusableOpenai,
): TRPCContext {
  return { session: null, user: null, db, openai };
}

export function signedInContext(
  db: TRPCContext["db"],
  openai: TRPCContext["openai"] = unusableOpenai,
): TRPCContext {
  return { session: testSession, user: testUser, db, openai };
}

/** One statement the router ran, in the order it ran it. */
export interface RecordedStatement {
  kind: "select" | "insert" | "update" | "delete";
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
   * The lock strength and config handed to `.for()` (e.g.
   * `.for("update")`), or `null` if the statement never locked. `for()`
   * takes a plain string rather than a SQL fragment, so this is asserted
   * directly instead of compiled.
   */
  lock: { strength: unknown; config: unknown } | null;
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
 */
export function createDbStub(results: StubResult[] = []): DbStub {
  const queue = [...results];
  const statements: RecordedStatement[] = [];

  function begin(
    kind: RecordedStatement["kind"],
    table: Table | null,
    fields?: unknown,
  ) {
    const statement: RecordedStatement = {
      kind,
      table: table === null ? null : getTableName(table),
      values: undefined,
      fields,
      wheres: [],
      orderBys: [],
      lock: null,
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
      innerJoin: () => chain,
      leftJoin: () => chain,
      where(condition: unknown) {
        statement.wheres.push(condition);
        return chain;
      },
      orderBy(...columns: unknown[]) {
        statement.orderBys.push(...columns);
        return chain;
      },
      limit: () => chain,
      for(strength: unknown, config?: unknown) {
        statement.lock = { strength, config };
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
    transaction: <TResult>(fn: (tx: unknown) => Promise<TResult>) => fn(db),
  };

  return { db: db as unknown as TRPCContext["db"], statements };
}

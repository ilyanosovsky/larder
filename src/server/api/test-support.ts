import { getTableName, type Table } from "drizzle-orm";

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

export function anonymousContext(db: TRPCContext["db"]): TRPCContext {
  return { session: null, user: null, db };
}

export function signedInContext(db: TRPCContext["db"]): TRPCContext {
  return { session: testSession, user: testUser, db };
}

/** One statement the router ran, in the order it ran it. */
export interface RecordedStatement {
  kind: "select" | "insert" | "update" | "delete";
  /** Table name, once the builder revealed one (`from`/`insert`/`update`). */
  table: string | null;
  /** Payload handed to `.values()` or `.set()`. */
  values: unknown;
  /**
   * Conditions handed to `.where()`. The stub cannot evaluate them, but a
   * test can compile one with `PgDialect` to assert which columns a guard
   * actually covers — see the invite claim tests.
   */
  wheres: unknown[];
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

  function begin(kind: RecordedStatement["kind"], table: Table | null) {
    const statement: RecordedStatement = {
      kind,
      table: table === null ? null : getTableName(table),
      values: undefined,
      wheres: [],
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
      orderBy: () => chain,
      limit: () => chain,
      for: () => chain,
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
    select: () => begin("select", null),
    insert: (table: Table) => begin("insert", table),
    update: (table: Table) => begin("update", table),
    delete: (table: Table) => begin("delete", table),
    transaction: <TResult>(fn: (tx: unknown) => Promise<TResult>) => fn(db),
  };

  return { db: db as unknown as TRPCContext["db"], statements };
}

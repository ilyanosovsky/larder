/** Postgres `unique_violation` (23505). */
const UNIQUE_VIOLATION = "23505";

/**
 * How far down the `cause` chain to look. Bounded so a pathological chain
 * cannot turn error handling into a long walk; nothing we throw nests deeper
 * than two or three levels.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * Whether a thrown value is a Postgres unique-constraint violation.
 *
 * Database invariants (one household per user, one active cart item per
 * product) are enforced by unique indexes, so the losing side of a race
 * surfaces as this error rather than as a failed pre-check. Callers turn it
 * into a domain-level CONFLICT instead of a 500.
 *
 * **The chain walk is the whole point.** Since drizzle-orm 0.44 the driver
 * error no longer arrives as-is: it is wrapped in a `DrizzleQueryError` with
 * the postgres.js error on `.cause`, so a top-level `code` check silently
 * stops matching and every concurrent-insert race turns into an
 * INTERNAL_SERVER_ERROR. Walking `cause` also keeps this working if a future
 * drizzle version adds or removes a wrapper layer.
 *
 * Duck-typed rather than `instanceof PostgresError`: the value crosses
 * drizzle, a transaction wrapper and possibly a driver boundary, and a failed
 * `instanceof` here would degrade a handled conflict into a crash.
 */
export function isUniqueViolation(error: unknown): boolean {
  // Guards against a self-referential or circular `cause`, which would
  // otherwise be a hang rather than a wrong answer.
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return false;
    }
    seen.add(current);

    if ("code" in current && current.code === UNIQUE_VIOLATION) {
      return true;
    }

    if (!("cause" in current)) {
      return false;
    }
    current = current.cause;
  }

  return false;
}

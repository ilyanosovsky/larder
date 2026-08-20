/** Postgres `unique_violation` (23505). */
const UNIQUE_VIOLATION = "23505";

/**
 * Whether a thrown value is a Postgres unique-constraint violation.
 *
 * Database invariants (one household per user, one active cart item per
 * product) are enforced by unique indexes, so the losing side of a race
 * surfaces as this error rather than as a failed pre-check. Callers turn it
 * into a domain-level CONFLICT instead of a 500.
 *
 * Duck-typed on purpose: postgres.js exports `PostgresError`, but the value
 * arrives through drizzle and a transaction wrapper, and `instanceof` across
 * that boundary is fragile.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return error.code === UNIQUE_VIOLATION;
}

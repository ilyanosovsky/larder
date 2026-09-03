import type { ImportResultOutput } from "@/server/api/routers/dish-import";

/**
 * Which import job a save is allowed to mark consumed, and which one a screen
 * should redirect away from instead of re-opening (task 4.3).
 *
 * `dish.create` stamps `consumedDishId` onto whatever `jobId` it is handed —
 * it checks neither the job's outcome nor whether it was already consumed
 * (`dish.ts` documents that it is deliberately not an idempotency key). So the
 * rule lives on the client, and it lives *here* rather than inline in the
 * screen because this repo has no component-test setup (vitest runs in `node`,
 * no jsdom): a rule that cannot be tested where it is written gets moved to
 * where it can be.
 *
 * Pure — no React, no network.
 */

/**
 * The dish this job already became, if any.
 *
 * A `running` job has not finished deciding what it is, so it never counts as
 * consumed.
 */
export function consumedDishIdOf(
  result: ImportResultOutput | undefined,
): string | null {
  if (result === undefined || result.outcome === "running") {
    return null;
  }
  return result.consumedDishId ?? null;
}

/**
 * The job id a manual save may consume, or `null`.
 *
 * Two conditions, and each one is a bug that has to be excluded:
 *
 * - **Only a `failed` job.** `?from=` accepts any job the household owns,
 *   including one that parsed successfully — and `/dishes/new` opens a *blank*
 *   form for those, because a parsed draft has its own review route. Stamping
 *   that job would make the review route redirect to an empty manual dish and
 *   put the parsed recipe permanently out of reach.
 * - **Only an unconsumed one.** Saving stamps the job and invalidates the
 *   cache, so a Back onto this screen re-prefills from the same job; a second
 *   save would mint a duplicate dish carrying the first one's `photo_key` and
 *   repoint `consumedDishId` at the copy.
 */
export function consumableJobId(
  result: ImportResultOutput | undefined,
  jobId: string | null,
): string | null {
  if (jobId === null || result === undefined) {
    return null;
  }
  if (result.outcome !== "failed" || consumedDishIdOf(result) !== null) {
    return null;
  }
  return jobId;
}

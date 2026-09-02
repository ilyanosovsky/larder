import { TRPCError } from "@trpc/server";
import { and, eq, gte, sql } from "drizzle-orm";

import { aiJobs } from "@/db/schema";
import {
  checkRateLimit,
  rateLimitWindows,
  type RateLimitDecision,
} from "@/server/ai/rate-limit";
import type { TRPCContext } from "@/server/api/trpc";

type Database = TRPCContext["db"];

/**
 * The per-user AI rate limit, counted in the database (VISION §6.7).
 *
 * One indexed `count(*)` covers both windows: the day's rows are counted, and
 * the minute's are counted again with a `FILTER` over the same scan, so the
 * limiter costs one round trip rather than two. Counted in Postgres because
 * the app is serverless and an in-process counter would reset per invocation
 * — see `src/server/ai/rate-limit.ts` for the windows themselves.
 *
 * **Two callers with two different answers**, which is why the decision and
 * the guard are separate functions rather than one throwing helper:
 * `product.create` refuses outright (the user asked for one AI call and can
 * ask again in a minute), while a dish save must *not* fail — the user has
 * just spent a minute reviewing a recipe, and losing it to a quota to save a
 * fraction of a cent is the wrong trade. It creates the products with
 * fallbacks and reports `aiFailed`.
 */
export async function aiRateLimitDecision(
  db: Database,
  userId: string,
): Promise<RateLimitDecision> {
  const { minuteStart, dayStart } = rateLimitWindows(new Date());

  const [counts] = await db
    .select({
      // The FILTER predicate is built with `gte`, not written inline as
      // `${aiJobs.createdAt} >= ${minuteStart}`: a bare Date interpolated
      // into a raw `sql` fragment is bound with no column type, and
      // postgres.js rejects it at bind time. Going through `gte` reuses the
      // column's own encoder, exactly like the `WHERE` below.
      minute: sql<number>`(count(*) filter (where ${gte(aiJobs.createdAt, minuteStart)}))::int`,
      day: sql<number>`(count(*))::int`,
    })
    .from(aiJobs)
    .where(and(eq(aiJobs.userId, userId), gte(aiJobs.createdAt, dayStart)));

  return checkRateLimit({
    recentMinuteCount: counts?.minute ?? 0,
    recentDayCount: counts?.day ?? 0,
  });
}

/** The refusing form: for a call the user is waiting on and can simply retry. */
export async function assertWithinRateLimit(
  db: Database,
  userId: string,
): Promise<void> {
  const decision = await aiRateLimitDecision(db, userId);

  if (!decision.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `AI rate limit reached (${decision.reason})`,
    });
  }
}

import { initTRPC, TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { z, ZodError } from "zod";

import type { db } from "@/db";
import { householdMembers, households } from "@/db/schema";
import type { Session } from "@/lib/session";
import type { AiChatClient } from "@/server/ai/openai";

type Database = ReturnType<typeof db>;
type SessionData = NonNullable<Session>;

/**
 * Per-request context handed to every procedure.
 *
 * `session`/`user` are null for anonymous callers — building the context must
 * never fail just because nobody is signed in, or public procedures would
 * break. `protectedProcedure` is where the absence turns into an error.
 *
 * Built in `src/server/api/context.ts`; kept out of this module on purpose so
 * routers can be imported (and tested) without pulling in `next/headers`,
 * Better Auth or the database driver.
 */
export interface TRPCContext {
  session: SessionData["session"] | null;
  user: SessionData["user"] | null;
  db: Database;
  /**
   * The OpenAI client, as a factory rather than an instance — for the same
   * reason `db` is injected at all: a procedure that makes an AI call is
   * testable without a network, and a unit test that should never reach
   * OpenAI fails loudly instead of quietly dialing out.
   *
   * A factory, not a value, because building the client reads
   * `OPENAI_API_KEY`: every request would otherwise pay for an environment
   * lookup, and `next build` (which runs with no environment at all) would
   * hit one while prerendering.
   */
  openai: () => AiChatClient;
}

const t = initTRPC.context<TRPCContext>().create({
  // superjson keeps Date (and Map/Set/BigInt) intact across the wire. Every
  // row we will return carries timestamps, so this is on from the first
  // procedure rather than retrofitted later.
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // Field-level validation errors, so forms can map them onto inputs
        // instead of showing one opaque "bad request". Null — never absent —
        // so the shape is the same for every error (VISION §6.2 convention).
        zodError:
          error.code === "BAD_REQUEST" && error.cause instanceof ZodError
            ? z.flattenError(error.cause)
            : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

/** Reachable without a session. Check membership yourself if you touch data. */
export const publicProcedure = t.procedure;

/**
 * Requires a signed-in user. After this middleware `ctx.session` and
 * `ctx.user` are non-null in the resolver's types, so resolvers never need a
 * `!` assertion.
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session || !ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  return next({
    ctx: {
      session: ctx.session,
      user: ctx.user,
    },
  });
});

/**
 * Requires a signed-in user who belongs to a household, and puts that
 * household on the context.
 *
 * This is the membership check VISION §6.7 asks every data request to make.
 * Build every household-scoped procedure on it rather than re-deriving the
 * household from an input field — a `householdId` coming from the client is
 * an authorization hole, `ctx.household.id` is not.
 *
 * A signed-in user without a household is FORBIDDEN, not UNAUTHORIZED: they
 * are authenticated, they simply have not finished onboarding (S2). The UI
 * gate in `src/app/(app)/layout.tsx` normally redirects them before any
 * procedure runs; this is the backstop for direct API calls.
 */
export const householdProcedure = protectedProcedure.use(
  async ({ ctx, next }) => {
    const [row] = await ctx.db
      .select({
        membership: householdMembers,
        household: households,
      })
      .from(householdMembers)
      .innerJoin(households, eq(households.id, householdMembers.householdId))
      .where(eq(householdMembers.userId, ctx.user.id))
      .limit(1);

    if (!row) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No household membership",
      });
    }

    return next({
      ctx: {
        membership: row.membership,
        household: row.household,
      },
    });
  },
);

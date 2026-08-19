import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z, ZodError } from "zod";

import type { db } from "@/db";
import type { Session } from "@/lib/session";

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

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { createTRPCContext } from "@/server/api/context";
import { appRouter } from "@/server/api/root";

/**
 * Explicit, not inherited: task 4.4's SSRF guard resolves a hostname through
 * `node:dns` before it opens a socket, and the Edge runtime has no `dns` at
 * all. Next's App Router already defaults to `nodejs`, so this changes
 * nothing today — it is here so a future `export const runtime = "edge"`
 * has to argue with a comment rather than silently break the one procedure
 * that fetches a URL a user chose.
 */
export const runtime = "nodejs";

/**
 * A **ceiling**, not a floor — and the only reason it is not the platform
 * default: a recipe import (task 4.3) spends up to 40 s inside one vision
 * call, and Vercel's default 10 s would turn every one of them into a 504.
 * A 504 is the one outcome S8.2 has no copy for, because it carries no
 * `jobId` — so the cost record and the retry handle are lost with it.
 *
 * 60 is Vercel Hobby's maximum. Nothing else on this route runs long, and
 * `Deadline` (`src/server/recipes/deadline.ts`) keeps the import itself
 * inside 50 s so the function always has room to answer. A separate route for
 * import would fork the context and auth plumbing for one number (R13).
 */
export const maxDuration = 60;

/**
 * The single tRPC endpoint.
 *
 * `src/middleware.ts` deliberately excludes `/api/**`, so nothing gates this
 * route: authorization is per-procedure, and `protectedProcedure` is the
 * boundary.
 *
 * Context is built inside the per-request closure, never at module scope —
 * importing this file must not read env or open a database connection, or a
 * `next build` with no environment variables would fail (same reasoning as
 * `src/app/api/auth/[...all]/route.ts`).
 */
const handler = (request: Request): Promise<Response> =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: () => createTRPCContext(),
    onError:
      process.env.NODE_ENV === "development"
        ? ({ path, error }) => {
            console.error(
              `tRPC error on ${path ?? "<no-path>"}: ${error.message}`,
            );
          }
        : undefined,
  });

export { handler as GET, handler as POST };

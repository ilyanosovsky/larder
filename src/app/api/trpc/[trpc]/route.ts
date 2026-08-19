import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { createTRPCContext } from "@/server/api/context";
import { appRouter } from "@/server/api/root";

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

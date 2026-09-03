import { createRouteHandler } from "uploadthing/next";
import type { NextRequest } from "next/server";

import { larderFileRouter } from "@/server/uploadthing";

/**
 * The UploadThing endpoint (task 4.3).
 *
 * **The handler is built lazily, inside the request.** `createRouteHandler`
 * is given the token explicitly rather than letting the library read
 * `process.env.UPLOADTHING_TOKEN` for itself, and the whole construction is
 * deferred to the first call: `pnpm build` runs in CI with zero environment
 * variables, and anything that reads env at module scope fails the build in a
 * way no local run reproduces (blueprint R1 — this is the one file in the
 * task at risk of it). Same discipline as `env()`, `db()` and
 * `openaiClient()`.
 *
 * Auth lives in the router's own `.middleware()`, not here: `src/middleware.ts`
 * excludes `/api/**`, exactly as it does for tRPC and Better Auth.
 */
type Handlers = ReturnType<typeof createRouteHandler>;

let cached: Handlers | undefined;

function handlers(): Handlers {
  cached ??= createRouteHandler({
    router: larderFileRouter,
    config: { token: process.env.UPLOADTHING_TOKEN },
  });
  return cached;
}

export function GET(request: NextRequest): Promise<Response> {
  return handlers().GET(request);
}

export function POST(request: NextRequest): Promise<Response> {
  return handlers().POST(request);
}

import "server-only";

import { lookup } from "node:dns/promises";

import { db } from "@/db";
import { getSession } from "@/lib/session";
import { openaiClient } from "@/server/ai/openai";
import { uploadedFileStore } from "@/server/uploadthing-files";

import type { TRPCContext } from "./trpc";

/**
 * Builds the per-request tRPC context. Used by the HTTP handler
 * (`src/app/api/trpc/[trpc]/route.ts`) and by the server-side caller
 * (`src/trpc/server.tsx`) alike, so both see exactly the same context.
 *
 * Anonymous requests are normal here: the session is simply null and
 * `publicProcedure` still works.
 *
 * Order matters. `getSession()` is awaited *before* `db()` because it awaits
 * `headers()` first: during `next build` that throws Next's dynamic-render
 * bailout, so `db()` — and therefore `env()` — is never reached while
 * prerendering. That is what keeps a zero-environment build working
 * (see src/lib/session.ts, src/db/index.ts).
 */
export async function createTRPCContext(): Promise<TRPCContext> {
  const session = await getSession();

  return {
    session: session?.session ?? null,
    user: session?.user ?? null,
    db: db(),
    // Passed uncalled on purpose: building the client reads OPENAI_API_KEY,
    // and only the procedures that actually make an AI call should need it.
    openai: openaiClient,
    // Same reasoning for UPLOADTHING_TOKEN, which the store reads per call.
    uploadThing: () => uploadedFileStore,
    // `verbatim: true` so the resolver's own address order survives: the
    // guard checks *every* returned address anyway, and reordering them would
    // only hide which one the socket will actually use.
    pageFetch: () => ({
      fetch: globalThis.fetch,
      lookup: (hostname: string) =>
        lookup(hostname, { all: true, verbatim: true }),
    }),
  };
}

import "server-only";

import {
  HydrationBoundary,
  type FetchQueryOptions,
  type QueryKey,
} from "@tanstack/react-query";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { cache, type ReactNode } from "react";

import { createTRPCContext } from "@/server/api/context";
import { appRouter, createCaller } from "@/server/api/root";

import { makeQueryClient } from "./query-client";
import { dehydrateSettled } from "./settle-queries";

/** One QueryClient per request — `cache()` scopes it to the render pass. */
export const getQueryClient = cache(makeQueryClient);

/**
 * Server-side options proxy: `trpc.health.ping.queryOptions()` produces the
 * same query options a client component would use, but resolves in-process.
 * Pair it with `prefetch` + `HydrateClient` to render a screen with its data
 * already in the cache.
 */
export const trpc = createTRPCOptionsProxy({
  ctx: createTRPCContext,
  router: appRouter,
  queryClient: getQueryClient,
});

/**
 * Direct caller for server components and server actions — a plain typed
 * function call, no HTTP round trip and no serialization:
 * `const me = await caller.health.whoami()`.
 */
export const caller = createCaller(createTRPCContext);

/**
 * Ships everything prefetched during this render to the client cache.
 *
 * Awaits this request's in-flight prefetches before snapshotting the cache
 * (`dehydrateSettled`). A query dehydrated while still pending travels as a
 * promise, and `hydrate()` resolves such a promise synchronously in the
 * browser but never during SSR — which puts a screen's skeleton branch in the
 * HTML and its loaded branch in the client's first render, i.e. a hydration
 * mismatch on every prefetched screen. See `settleQueries`.
 *
 * The cost is that this subtree's HTML no longer renders ahead of its data:
 * the segment waits for `max(prefetch latency)`. The prefetches run in
 * parallel with each other, and the `(app)` layout already awaits the session
 * and `household.current` before any page renders, so this is one extra
 * parallel round trip rather than a new blocking phase. Every route that
 * prefetches — `/`, `/dishes`, `/dishes/[dishId]`, `/dishes/[dishId]/edit`,
 * `/dishes/new` (only for `?from=`), `/dishes/import/[jobId]`, `/settings` —
 * has its own `loading.tsx` so the wait is that screen's own skeleton rather
 * than a blank tab; add one for any new route that prefetches.
 */
export async function HydrateClient({ children }: { children: ReactNode }) {
  const state = await dehydrateSettled(getQueryClient());

  return <HydrationBoundary state={state}>{children}</HydrationBoundary>;
}

/**
 * Starts a query on the server. Fire-and-forget **at the call site**, so every
 * prefetch on a page runs in parallel with the others and with the rest of the
 * RSC render; `HydrateClient` is what awaits them, once, before it snapshots
 * the cache (see `settleQueries`).
 *
 * A failed prefetch still must not break the page: `prefetchQuery` swallows
 * its own rejection, an errored query is not dehydrated, and the client
 * fetches it normally. Retries are not a concern here either — `fetchQuery`
 * forces `retry: false` when a call site leaves it unset, so awaiting these
 * cannot hold a render for a backoff tail.
 *
 * Infinite queries need `prefetchInfiniteQuery` instead; add a sibling helper
 * when the first paginated screen needs one.
 */
export function prefetch<
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey,
>(queryOptions: FetchQueryOptions<TQueryFnData, TError, TData, TQueryKey>) {
  void getQueryClient().prefetchQuery(queryOptions);
}

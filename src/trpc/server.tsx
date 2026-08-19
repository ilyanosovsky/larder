import "server-only";

import {
  dehydrate,
  HydrationBoundary,
  type FetchQueryOptions,
  type QueryKey,
} from "@tanstack/react-query";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { cache, type ReactNode } from "react";

import { createTRPCContext } from "@/server/api/context";
import { appRouter, createCaller } from "@/server/api/root";

import { makeQueryClient } from "./query-client";

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

/** Ships everything prefetched during this render to the client cache. */
export function HydrateClient({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      {children}
    </HydrationBoundary>
  );
}

/**
 * Starts a query on the server without awaiting it, so the RSC stream and the
 * query run in parallel. Deliberately fire-and-forget: a failed prefetch must
 * not break the page, the client simply refetches.
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

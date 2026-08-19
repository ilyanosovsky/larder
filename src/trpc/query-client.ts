import {
  defaultShouldDehydrateQuery,
  QueryClient,
} from "@tanstack/react-query";
import superjson from "superjson";

/**
 * Shared QueryClient factory — one instance per server request, one long-lived
 * instance in the browser (see `src/trpc/client.tsx`).
 *
 * The dehydrate/hydrate hooks run the cache through superjson so data
 * prefetched in a server component survives the trip to the client with its
 * Dates intact, exactly like the tRPC HTTP link does.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Must be > 0: with staleTime 0 every server-prefetched query is
        // considered stale the moment the client hydrates and is refetched
        // immediately, throwing away the SSR work.
        staleTime: 30 * 1000,
      },
      dehydrate: {
        serializeData: superjson.serialize,
        // Also ship queries that are still in flight, so streamed RSC
        // prefetches reach the client instead of restarting there.
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) ||
          query.state.status === "pending",
      },
      hydrate: {
        deserializeData: superjson.deserialize,
      },
    },
  });
}

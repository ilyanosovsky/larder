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
        // Successes only — never a pending query. A pending query is
        // dehydrated together with its in-flight promise, which `hydrate()`
        // can resolve synchronously in the browser (it arrives as a React
        // Flight chunk) but never during SSR: the HTML would hold a screen's
        // skeleton branch while the client's first render already held the
        // loaded one. `HydrateClient` awaits this request's prefetches
        // (`settleQueries`) so they are `success` by the time this runs; this
        // default is the backstop for anything that still slips through — it
        // degrades to "the client fetches it", not to a hydration mismatch.
        // Kept explicit rather than left to the library default: it is the
        // regression pin.
        shouldDehydrateQuery: defaultShouldDehydrateQuery,
      },
      hydrate: {
        deserializeData: superjson.deserialize,
      },
    },
  });
}

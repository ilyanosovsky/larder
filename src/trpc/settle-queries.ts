import {
  dehydrate,
  type DehydratedState,
  type QueryClient,
} from "@tanstack/react-query";

/**
 * How many awaits we are willing to spend on one render pass.
 *
 * One is enough for today's pages: `prefetchQuery` starts the retryer
 * synchronously, so every query a page kicked off is already `fetching` by the
 * time `HydrateClient` renders, and nothing on the server starts a query while
 * we wait. The extra rounds are insurance for a query that re-enters
 * `fetching` while we are awaiting (a retry, or a prefetch issued by a nested
 * server component that renders during the same pass); the cache is re-scanned
 * after every await, including the last one, so hitting this ceiling is a
 * decision to stop waiting, not an accident of loop shape. What is still in
 * flight then is simply not dehydrated and the client fetches it.
 *
 * Deliberately a ceiling rather than "loop until nothing is fetching": this
 * runs inside the render of every prefetching page, and an unbounded wait on
 * a cache anything else may keep re-populating trades a lost prefetch — one
 * extra client fetch, no mismatch — for a request that never answers. A chain
 * long enough to hit it is pinned by a test, so the stop is visible behaviour
 * rather than a silent truncation.
 */
const MAX_SETTLE_ROUNDS = 3;

/** The in-flight promises of this cache, one snapshot in time. */
function collectInFlight(queryClient: QueryClient): Promise<unknown>[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.fetchStatus === "fetching")
    .map((query) => query.promise)
    .filter((promise): promise is Promise<unknown> => promise !== undefined);
}

/**
 * Waits until every query started during this server render has settled.
 *
 * `HydrateClient` calls this before `dehydrate()` so the payload carries
 * **data, never a promise**. A query dehydrated while pending travels together
 * with its in-flight promise, and `hydrate()` can resolve such a promise
 * synchronously in the browser (it arrives as a React Flight chunk) but never
 * during SSR — `tryResolveSync` needs a thenable that calls back
 * synchronously. The server would therefore render a screen's skeleton branch
 * into the HTML while the client's very first render already had the loaded
 * one: a hydration mismatch on every prefetched screen.
 *
 * **Never rejects.** `prefetchQuery` already swallows its own failures
 * (`fetchQuery().then(noop).catch(noop)`), and `Promise.allSettled` covers the
 * retryer promise read here. A prefetch that failed is simply not dehydrated
 * (`shouldDehydrateQuery` ships successes only) and the client fetches it —
 * the "a failed prefetch must not break the page" contract, unchanged.
 *
 * Deliberately **not** `import "server-only"`, and deliberately a pure
 * function of a `QueryClient`: that keeps it importable from a vitest file
 * without dragging in `server.tsx`, whose import graph reaches the router,
 * `env()` and the database. (`server-only` itself is stubbed in
 * `vitest.config.ts`, so the marker is not what would hurt — the import graph
 * is.)
 */
export async function settleQueries(queryClient: QueryClient): Promise<void> {
  let rounds = 0;
  let inFlight = collectInFlight(queryClient);

  while (inFlight.length > 0 && rounds < MAX_SETTLE_ROUNDS) {
    await Promise.allSettled(inFlight);
    rounds += 1;
    inFlight = collectInFlight(queryClient);
  }
}

/**
 * Settles this request's queries, then snapshots the cache — the two halves
 * `HydrateClient` needs, in the one order that is correct.
 *
 * They live here together rather than inline in `server.tsx` so the wiring is
 * testable: `server.tsx` is a `.tsx` module whose import graph reaches the
 * router, `env()` and the database, so a vitest file cannot call
 * `HydrateClient` without standing all of that up. This function is what
 * carries the behaviour, and `settle-queries.test.ts` pins it — drop the
 * `await` here and the payload comes back empty (nothing has settled yet,
 * and a pending query is never dehydrated).
 */
export async function dehydrateSettled(
  queryClient: QueryClient,
): Promise<DehydratedState> {
  await settleQueries(queryClient);

  return dehydrate(queryClient);
}

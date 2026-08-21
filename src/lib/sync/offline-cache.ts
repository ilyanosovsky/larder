import type { PersistedClient } from "@tanstack/react-query-persist-client";
import superjson from "superjson";

import { isQueuedMutationState } from "./delivery";

/**
 * What the offline queue writes to IndexedDB, and the rules for reading it
 * back — the pure half of task 2.4 (VISION §6.3). The browser wiring that
 * turns these into a TanStack persister lives in `src/trpc/offline-queue.ts`;
 * everything decided here is a plain function, so it is covered by tests in a
 * node environment with no IndexedDB anywhere near it.
 */

/**
 * Bump this when the shape of what we persist changes in a way an older
 * payload cannot satisfy:
 *
 * - `cart.list`'s output fields (a restored list would render missing columns),
 * - any `cart.*` mutation's **input** shape (a replayed mutation would send a
 *   body the router now rejects),
 * - the serializer below.
 *
 * A stored payload whose buster does not match is not migrated — TanStack
 * drops the whole entry, queue included. That is the intended trade: a
 * handful of unsent taps is a far smaller cost than replaying them against a
 * contract that has moved.
 */
export const OFFLINE_CACHE_VERSION = 1;

/** The buster string TanStack compares on restore. */
export const OFFLINE_CACHE_BUSTER = `larder-cart-v${OFFLINE_CACHE_VERSION}`;

/**
 * How old a stored payload may be before it is discarded on restore, in ms.
 *
 * Two days. A queued tap older than that is no longer a fact about the
 * household's cart: by then someone has bought the thing, removed it, or
 * added it again, and delivering the tap would land as an unexplained change
 * days after the person made it. The cached list goes with it — the queue and
 * the snapshot it was taken against are one payload, and keeping a two-day-old
 * list while dropping the writes made on top of it would be worse than
 * starting from the server.
 */
export const OFFLINE_CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** IndexedDB database, object store and entry key for the payload. */
export const OFFLINE_CACHE_DB_NAME = "larder-offline-cache";
export const OFFLINE_CACHE_STORE_NAME = "query-cache";
export const OFFLINE_CACHE_KEY = "cart";

/**
 * The payload goes through **superjson**, not `JSON.stringify`.
 *
 * Query data is already superjson-encoded by the time it gets here — the
 * `dehydrate`/`hydrate` options in `src/trpc/query-client.ts` run it through
 * `superjson.serialize` — but a mutation is dehydrated **raw**: TanStack
 * copies `mutation.state` (variables, and whatever `onMutate` returned as
 * context) into the payload untouched, with no `serializeData` hook to hand
 * it to. Today's cart mutations carry plain uuids, numbers and enum strings,
 * so `JSON` would survive; the first optimistic context holding a row
 * snapshot — `updatedAt` is a `Date` — would silently come back as a string
 * and blow up on the next `.getTime()`. Encoding the envelope costs nothing
 * and closes that off for good.
 */
export function serializeOfflineCache(client: PersistedClient): string {
  return superjson.stringify(client);
}

/** Inverse of {@link serializeOfflineCache}. */
export function deserializeOfflineCache(raw: string): PersistedClient {
  return superjson.parse<PersistedClient>(raw);
}

/**
 * The part of a TanStack `Query` the persist filter reads. Deliberately
 * structural and wider than the real class, so the filter can be called with
 * a plain object in a test — a `Query` is assignable to it, which is what
 * keeps the filter usable as `DehydrateOptions['shouldDehydrateQuery']`.
 */
export interface PersistableQuery {
  readonly queryKey: readonly unknown[];
  readonly state: { readonly status: string };
}

/** Same idea for a `Mutation`. */
export interface PersistableMutation {
  readonly options: { readonly mutationKey?: readonly unknown[] | undefined };
  readonly state: {
    readonly status: string;
    readonly isPaused: boolean;
    readonly failureCount: number;
    readonly failureReason: unknown;
  };
}

export interface OfflineCacheFilters {
  shouldDehydrateQuery: (query: PersistableQuery) => boolean;
  shouldDehydrateMutation: (mutation: PersistableMutation) => boolean;
}

/**
 * Whether a TanStack key belongs to a tRPC router path.
 *
 * Both keys are the array-of-arrays shape the tRPC option-proxy builds: a
 * query key is `[["cart","list"], { type: "query" }]`, a mutation key is
 * `[["cart","setStatus"]]`, and a router-level key is `[["cart"]]`. Matching
 * is therefore "does the key's path segment **start with** the given path's",
 * the same prefix rule TanStack's own filters use — which is why one helper
 * covers both `trpc.cart.pathKey()` (the whole router) and
 * `trpc.cart.list.queryKey()` (one procedure; its trailing `{ type }` entry
 * is not a path segment, and is simply never looked at).
 *
 * An empty path matches nothing rather than everything: a prefix of zero
 * segments would quietly persist the entire cache.
 */
export function matchesTrpcPath(
  key: unknown,
  pathKey: readonly unknown[],
): boolean {
  if (!Array.isArray(key)) {
    return false;
  }

  const segments: unknown = key[0];
  const pathSegments: unknown = pathKey[0];

  if (!Array.isArray(segments) || !Array.isArray(pathSegments)) {
    return false;
  }
  if (pathSegments.length === 0) {
    return false;
  }

  return pathSegments.every(
    (segment: unknown, index: number) => segments[index] === segment,
  );
}

/**
 * What gets written to IndexedDB, and — just as importantly — what does not.
 *
 * **Mutations: `cart.*` ones the router provably has not seen** —
 * `isQueuedMutationState` (`./delivery.ts`) decides, and the reasoning for
 * both halves of that test lives there. Deliberately **wider** than
 * TanStack's own `defaultShouldDehydrateMutation`, which persists paused
 * mutations only: a mutation retrying after an undelivered failure is not
 * paused, so a paused-only filter erases the queue from storage the moment a
 * captive portal makes the first delivery attempt fail. Still narrower than
 * "everything pending" — a first attempt in flight carries no evidence
 * either way, and `cart.add` **merges**, so replaying one that did land turns
 * «2 шт» into «4 шт» with nothing on screen to explain it.
 *
 * **Queries: a successful `cart.list` only.** It is the one query worth
 * having before the network answers. Everything else (the catalog, category
 * and kitchen-profile queries) is either cheap or irrelevant to a shopper
 * standing in a shop, and would only make the payload bigger and staler.
 * `status === "success"` is not decoration either: a *pending* query is
 * dehydrated together with its in-flight `promise`, which no serializer can
 * write to disk.
 *
 * @param cartPathKey `trpc.cart.pathKey()` — the whole cart router.
 * @param cartListKey `trpc.cart.list.queryKey()` — the one persisted query.
 */
export function createOfflineCacheFilters(
  cartPathKey: readonly unknown[],
  cartListKey: readonly unknown[],
): OfflineCacheFilters {
  return {
    shouldDehydrateQuery: (query) =>
      query.state.status === "success" &&
      matchesTrpcPath(query.queryKey, cartListKey),
    shouldDehydrateMutation: (mutation) =>
      isQueuedMutationState(mutation.state) &&
      matchesTrpcPath(mutation.options.mutationKey, cartPathKey),
  };
}

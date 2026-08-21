import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
  focusManager,
  onlineManager,
  type MutationFunction,
  type MutationKey,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  AsyncStorage,
  PersistQueryClientOptions,
  Persister,
} from "@tanstack/react-query-persist-client";
import type { TRPCClient } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { createStore, del, get, set, type UseStore } from "idb-keyval";

import {
  createOfflineCacheFilters,
  deserializeOfflineCache,
  OFFLINE_CACHE_BUSTER,
  OFFLINE_CACHE_DB_NAME,
  OFFLINE_CACHE_KEY,
  OFFLINE_CACHE_MAX_AGE_MS,
  OFFLINE_CACHE_STORE_NAME,
  serializeOfflineCache,
} from "@/lib/sync/offline-cache";
import type { AppRouter } from "@/server/api/root";

/** Everything `PersistQueryClientProvider` needs except the client itself. */
export type OfflinePersistOptions = Omit<
  PersistQueryClientOptions,
  "queryClient"
>;

export interface OfflineQueue {
  readonly persistOptions: OfflinePersistOptions;
  /**
   * Deliver whatever is queued, then re-read the cart. Wired to the events
   * below; also handed to `PersistQueryClientProvider`'s `onSuccess`, which
   * is the moment a queue restored from IndexedDB first exists in memory.
   */
  readonly flush: () => Promise<void>;
}

/**
 * The `AsyncStorage` the persister writes through.
 *
 * The store is opened **lazily**: `idb-keyval`'s `createStore` calls
 * `indexedDB.open` the moment it is invoked, and this module is imported by a
 * client component that also renders on the server, where there is no
 * `indexedDB` to open.
 */
function createIndexedDbStorage(): AsyncStorage<string> {
  let store: UseStore | undefined;
  const getStore = (): UseStore =>
    (store ??= createStore(OFFLINE_CACHE_DB_NAME, OFFLINE_CACHE_STORE_NAME));

  return {
    getItem: (key) => get<string>(key, getStore()),
    setItem: (key, value) => set(key, value, getStore()),
    removeItem: (key) => del(key, getStore()),
  };
}

/**
 * Gives one restored mutation its function back.
 *
 * A dehydrated mutation carries its key, its variables and its state — never
 * its `mutationFn`, which is a closure and cannot be written to disk. On
 * restore TanStack rebuilds it through `queryClient.defaultMutationOptions`,
 * which merges in whatever `setMutationDefaults` registered for a matching
 * key; without that, resuming the queue fails with «No mutationFn found».
 *
 * The default is **only** the function. The rich optimistic wiring —
 * `onMutate`'s cache patch, the per-row rollback, the toast, the own-change
 * mark — stays at the S3 call sites, and deliberately does not run here:
 *
 * - A restored mutation never calls `onMutate` at all. TanStack skips it for
 *   a mutation whose state is already `pending` (`Mutation#execute`), which
 *   is exactly right — the patch it would apply was applied in the previous
 *   session, before the tap was persisted.
 * - There is nothing left to roll back to. The optimistic snapshot lived in
 *   the cache of a tab that no longer exists, and the screen this mutation
 *   belonged to was closed hours ago.
 *
 * So the resume path is deliberately simpler than the live one: deliver, then
 * let `flush` re-read the cart, and whatever the server says is what the
 * screen shows. That is the same last-write-wins bargain VISION §3.1 already
 * makes for two people editing one row.
 */
function registerMutationDefault<TData, TVariables>(
  queryClient: QueryClient,
  options: {
    mutationKey: MutationKey;
    mutationFn?: MutationFunction<TData, TVariables>;
  },
): void {
  queryClient.setMutationDefaults(options.mutationKey, {
    mutationFn: options.mutationFn,
  });
}

/** Whether anything is actually waiting, so a flush can be free when idle. */
function hasQueuedMutations(queryClient: QueryClient): boolean {
  return queryClient
    .getMutationCache()
    .getAll()
    .some((mutation) => mutation.state.isPaused);
}

/**
 * The offline queue (VISION §6.3), wired to one browser QueryClient.
 *
 * The queue itself is not written here — it is TanStack's own paused-mutation
 * machinery, made durable. Three pieces:
 *
 * 1. **Persistence.** `PersistQueryClientProvider` writes the dehydrated
 *    cache to IndexedDB on every cache event and reads it back on startup.
 *    `localStorage` would not do: iOS evicts it more eagerly, it is
 *    synchronous on the main thread, and it is capped at a few MB.
 * 2. **Mutation defaults**, so a restored mutation has a function to run.
 * 3. **Delivery triggers.** `QueryClient#mount` already resumes paused
 *    mutations on `onlineManager`'s `online` event *and* on `focusManager`'s
 *    `visibilitychange` — which together are exactly VISION §6.3's «доставка
 *    при открытом приложении по событию online», including the iOS-PWA
 *    reopen. There is no Background Sync API on iOS and none is emulated
 *    here: nothing is delivered while the app is closed, by design.
 *
 * What the subscriptions below add on top of TanStack's own is the **refetch
 * after** the queue drains. `QueryClient#mount` does invalidate-ish work of
 * its own (`queryCache.onOnline()`), but S3 mutes its passive refetch
 * triggers while `useIsMutating` is non-zero — and resumed mutations are
 * counted as mutating — so that refetch can be swallowed by a mute React has
 * not re-rendered out of yet. Invalidating explicitly once every resumed
 * mutation has settled is what guarantees the screen ends up showing the
 * server's answer rather than the optimistic guess it inherited.
 *
 * **A resumed mutation that fails is dropped, not retried.** Mutations keep
 * TanStack's default `retry: 0`, so a replay that reaches the server and is
 * rejected (a row a partner already removed, a CONFLICT) settles as an error,
 * loses its `isPaused` flag and is therefore no longer persisted — it cannot
 * wedge the queue or come back on the next reload. Nothing is announced: the
 * tap it belonged to happened in a previous session, and the invalidate that
 * follows puts the true state on screen, which is the honest answer to «что в
 * корзине сейчас».
 */
export function installOfflineQueue(
  queryClient: QueryClient,
  trpcClient: TRPCClient<AppRouter>,
): OfflineQueue {
  const trpc = createTRPCOptionsProxy<AppRouter>({
    client: trpcClient,
    queryClient,
  });

  registerMutationDefault(queryClient, trpc.cart.add.mutationOptions());
  registerMutationDefault(queryClient, trpc.cart.setStatus.mutationOptions());
  registerMutationDefault(queryClient, trpc.cart.updateItem.mutationOptions());
  registerMutationDefault(queryClient, trpc.cart.remove.mutationOptions());

  const cartFilter = trpc.cart.pathFilter();

  const flush = async (): Promise<void> => {
    if (!hasQueuedMutations(queryClient)) {
      return;
    }

    try {
      await queryClient.resumePausedMutations();
      await queryClient.invalidateQueries(cartFilter);
    } catch {
      // Both calls already swallow per-mutation and per-query failures;
      // anything that still surfaces here is not actionable and must not
      // become an unhandled rejection inside an event listener.
    }
  };

  // Never unsubscribed: both the client and these listeners live for the
  // lifetime of the tab (see `getBrowserRuntime` in `client.tsx`).
  onlineManager.subscribe((online) => {
    if (online) {
      void flush();
    }
  });
  focusManager.subscribe((focused) => {
    if (focused) {
      void flush();
    }
  });

  const filters = createOfflineCacheFilters(
    trpc.cart.pathKey(),
    trpc.cart.list.queryKey(),
  );

  return {
    flush,
    persistOptions: {
      persister: createAsyncStoragePersister({
        key: OFFLINE_CACHE_KEY,
        storage: createIndexedDbStorage(),
        serialize: serializeOfflineCache,
        deserialize: deserializeOfflineCache,
      }),
      buster: OFFLINE_CACHE_BUSTER,
      maxAge: OFFLINE_CACHE_MAX_AGE_MS,
      dehydrateOptions: filters,
    },
  };
}

const inertPersister: Persister = {
  persistClient: () => undefined,
  restoreClient: () => Promise.resolve(undefined),
  removeClient: () => undefined,
};

/**
 * A persister that stores nothing, for the server render.
 *
 * `PersistQueryClientProvider` is rendered on **both** sides rather than only
 * in the browser, and this is what makes that possible without touching
 * IndexedDB during SSR. Swapping providers per environment instead would
 * change the `isRestoring` context between the server's HTML and the client's
 * first render — which forces `fetchStatus` to `idle` on one side and not the
 * other, i.e. a hydration mismatch on any screen that renders a loading
 * state. Its restore effect never runs on the server anyway; the inert
 * persister just keeps the props type-honest.
 */
export function createInertPersistOptions(): OfflinePersistOptions {
  return {
    persister: inertPersister,
    buster: OFFLINE_CACHE_BUSTER,
    maxAge: OFFLINE_CACHE_MAX_AGE_MS,
  };
}

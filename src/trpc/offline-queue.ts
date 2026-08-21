import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
  focusManager,
  onlineManager,
  type Mutation,
  type MutationFunction,
  type MutationKey,
  type QueryClient,
} from "@tanstack/react-query";
import {
  persistQueryClientSave,
  type AsyncStorage,
  type PersistQueryClientOptions,
  type Persister,
} from "@tanstack/react-query-persist-client";
import type { TRPCClient } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { createStore, del, get, set, type UseStore } from "idb-keyval";

import {
  isQueuedMutationState,
  mutationIdentity,
  persistedMutationIdentities,
  shouldRetryDelivery,
} from "@/lib/sync/delivery";
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
   * Deliver whatever is queued, then re-read the cart and rewrite storage.
   *
   * Resolves when the round is done and **never rejects**, so a caller may
   * await it or ignore it. Production callers ignore it: with a queue that
   * retries until the server answers, a round can outlive the session.
   */
  readonly flush: () => Promise<void>;
  /**
   * Handed to `PersistQueryClientProvider`'s `onSuccess`: the moment a queue
   * read back from IndexedDB first exists in memory. Returns **void, at
   * once** — the provider chains this before flipping `isRestoring`, and does
   * not subscribe the persister until it flips.
   */
  readonly onRestored: () => void;
  /** Write the current cache to storage now, bypassing the save throttle. */
  readonly saveNow: () => Promise<void>;
  /**
   * Delete the stored envelope, awaited. For sign-out: `queryClient.clear()`
   * alone only *schedules* an empty replacement through the persister's
   * throttle, and nothing waits for that write — so the previous household's
   * cart can still be sitting in IndexedDB when the next page load reads it.
   */
  readonly purge: () => Promise<void>;
}

export interface OfflineQueueOptions {
  /**
   * Where the queue is kept. Defaults to IndexedDB through `idb-keyval`;
   * overridden in tests, which have neither an IndexedDB nor a reason to
   * exercise one.
   */
  readonly storage?: AsyncStorage<string>;
}

/**
 * The persister writes on every cache event, so the throttle only decides how
 * long a tap may sit in memory before it is durable. On iOS a backgrounded
 * PWA has its timers suspended and may then be killed outright, so a deferred
 * save is a save that never happens — and the S3 banner promises «изменения
 * сохранятся». The payload is one cart list plus a handful of queued
 * mutations, so writing it per event costs nothing worth trading a lost tap
 * for. `asyncThrottle` still coalesces anything raised inside the same tick.
 */
const SAVE_THROTTLE_MS = 0;

/**
 * How long to wait for another context (a PWA and a browser tab can both be
 * open on the same origin, sharing this storage) to finish delivering before
 * giving up on this round. Delivery keeps running there; the next `online` or
 * focus event brings us back.
 */
const DELIVERY_LOCK_TIMEOUT_MS = 5_000;

/** Web Locks name, scoped like the IndexedDB database is. */
const DELIVERY_LOCK_NAME = `${OFFLINE_CACHE_DB_NAME}:delivery`;

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
 * Gives one restored mutation its function and its retry policy back.
 *
 * A dehydrated mutation carries its key, its variables and its state — never
 * its `mutationFn`, which is a closure and cannot be written to disk. On
 * restore TanStack rebuilds it through `queryClient.defaultMutationOptions`,
 * which merges in whatever `setMutationDefaults` registered for a matching
 * key; without that, resuming the queue fails with «No mutationFn found».
 *
 * `retry` is registered here rather than at the call sites so that **every**
 * cart write — live or resumed — is delivered under the same policy
 * (`shouldRetryDelivery`, `src/lib/sync/delivery.ts`): keep trying while the
 * server has not answered, give up the moment it has. A call site can still
 * override it, and none currently does.
 *
 * Nothing else is defaulted. The rich optimistic wiring — `onMutate`'s cache
 * patch, the per-row rollback, the toast, the own-change mark — stays at the
 * S3 call sites, and deliberately does not run on resume:
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
 * let the queue re-read the cart, and whatever the server says is what the
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
    retry: shouldRetryDelivery,
  });
}

/** Every mutation waiting to be delivered, live or restored from storage. */
function queuedMutations(
  queryClient: QueryClient,
): Mutation<unknown, Error, unknown, unknown>[] {
  return queryClient
    .getMutationCache()
    .getAll()
    .filter((mutation) => isQueuedMutationState(mutation.state));
}

/**
 * Runs `work` under an exclusive Web Lock, so two contexts on the same origin
 * cannot deliver the same restored queue at once.
 *
 * Feature-detected (Web Locks is iOS 15.4+): where it is missing, delivery
 * simply runs, which is the behaviour without this wrapper at all. The
 * timeout matters as much as the lock — a context stuck retrying against a
 * captive portal holds the lock for as long as that lasts, and boot in
 * another tab must not wait on it. Giving up is safe: nothing was delivered,
 * and the next `online` or focus event tries again.
 */
async function withDeliveryLock(work: () => Promise<void>): Promise<void> {
  const locks: LockManager | undefined =
    typeof navigator === "undefined" ? undefined : navigator.locks;

  if (locks === undefined) {
    await work();
    return;
  }

  try {
    await locks.request(
      DELIVERY_LOCK_NAME,
      {
        mode: "exclusive",
        signal: AbortSignal.timeout(DELIVERY_LOCK_TIMEOUT_MS),
      },
      async () => {
        await work();
      },
    );
  } catch {
    // AbortError (another context is still delivering) or an environment
    // that refused the lock. Either way this round is skipped, not failed.
  }
}

/**
 * The offline queue (VISION §6.3), wired to one browser QueryClient.
 *
 * The queue itself is not written here — it is TanStack's own paused-mutation
 * machinery, made durable. Four pieces:
 *
 * 1. **Persistence.** `PersistQueryClientProvider` writes the dehydrated
 *    cache to IndexedDB on every cache event and reads it back on startup.
 *    `localStorage` would not do: iOS evicts it more eagerly, it is
 *    synchronous on the main thread, and it is capped at a few MB.
 * 2. **Mutation defaults**, so a restored mutation has a function to run and
 *    a retry policy that will not throw it away.
 * 3. **Delivery triggers.** `QueryClient#mount` already resumes paused
 *    mutations on `onlineManager`'s `online` event *and* on `focusManager`'s
 *    `visibilitychange` — which together are exactly VISION §6.3's «доставка
 *    при открытом приложении по событию online», including the iOS-PWA
 *    reopen. There is no Background Sync API on iOS and none is emulated
 *    here: nothing is delivered while the app is closed, by design.
 * 4. **Explicit saves** at the two moments the throttle cannot be trusted:
 *    when the page is hidden or unloaded, and once a delivery round is done.
 *
 * What the subscriptions below add on top of TanStack's own resume is the
 * **refetch after** the queue drains, plus the restored mutations TanStack
 * would not resume by itself (`resumePausedMutations` looks only at paused
 * ones, and a mutation retrying after an undelivered failure is not paused).
 * S3 mutes its passive refetch triggers while `useIsMutating` is non-zero,
 * and resumed mutations count as mutating, so TanStack's own post-resume
 * `queryCache.onOnline()` can be swallowed by a mute React has not re-rendered
 * out of yet. Invalidating once delivery is done is what guarantees the
 * screen ends up showing the server's answer.
 *
 * **A rejected replay is dropped; an unanswered one is not.** See
 * `src/lib/sync/delivery.ts` — the drop policy is scoped to failures the
 * server actually produced. A dropped mutation settles as an error, stops
 * matching the queue test, and is therefore no longer persisted: it cannot
 * wedge the queue or come back on the next reload, and since no mutation sets
 * a `scope`, nothing queues behind it either. Nothing is announced — the tap
 * belonged to a previous session, and the invalidate that follows puts the
 * true state on screen.
 */
export function installOfflineQueue(
  queryClient: QueryClient,
  trpcClient: TRPCClient<AppRouter>,
  options: OfflineQueueOptions = {},
): OfflineQueue {
  const trpc = createTRPCOptionsProxy<AppRouter>({
    client: trpcClient,
    queryClient,
  });

  registerMutationDefault(queryClient, trpc.cart.add.mutationOptions());
  registerMutationDefault(queryClient, trpc.cart.setStatus.mutationOptions());
  registerMutationDefault(queryClient, trpc.cart.updateItem.mutationOptions());
  registerMutationDefault(queryClient, trpc.cart.remove.mutationOptions());
  registerMutationDefault(
    queryClient,
    trpc.cart.receiveOrder.mutationOptions(),
  );

  const cartFilter = trpc.cart.pathFilter();
  const filters = createOfflineCacheFilters(
    trpc.cart.pathKey(),
    trpc.cart.list.queryKey(),
  );

  const persister = createAsyncStoragePersister({
    key: OFFLINE_CACHE_KEY,
    storage: options.storage ?? createIndexedDbStorage(),
    serialize: serializeOfflineCache,
    deserialize: deserializeOfflineCache,
    throttleTime: SAVE_THROTTLE_MS,
  });

  const saveNow = (): Promise<void> =>
    persistQueryClientSave({
      queryClient,
      persister,
      buster: OFFLINE_CACHE_BUSTER,
      dehydrateOptions: filters,
    });

  /**
   * Mutations that came back from storage, captured the moment the restore
   * finished — before anything this session dispatched can be mistaken for
   * one. Only these are checked against storage below; a live tap has not
   * been anywhere near another context.
   */
  let restored: readonly Mutation<unknown, Error, unknown, unknown>[] = [];

  /**
   * Forget restored mutations that storage no longer lists as queued: another
   * context (the PWA and a browser tab can both be open) restored the same
   * envelope and has already sent them. Delivering them again would merge a
   * `cart.add` twice.
   */
  const dropAlreadyDelivered = async (): Promise<void> => {
    if (restored.length === 0) {
      return;
    }

    let stored;
    try {
      stored = await persister.restoreClient();
    } catch {
      // Storage is unreadable. Delivering without the cross-check risks a
      // duplicate only in the two-contexts-at-once case; skipping delivery
      // would risk losing the tap in every case. Deliver.
      restored = [];
      return;
    }

    if (stored === undefined) {
      // **No envelope is not evidence of delivery.** A context that drained
      // the queue leaves an envelope behind that simply no longer lists it
      // (`deliveryRound` always rewrites before releasing the lock), so
      // "delivered elsewhere" always looks like a *present* envelope. An
      // absent one means something else — the entry expired, sign-out purged
      // it, the read raced a write — and dropping on that would throw away
      // taps nobody has sent. Deliver, and accept the duplicate risk that
      // only exists if a second context is running right now.
      restored = [];
      return;
    }

    const stillQueued = persistedMutationIdentities(stored);
    const cache = queryClient.getMutationCache();

    for (const mutation of restored) {
      const identity = mutationIdentity(
        mutation.options.mutationKey,
        mutation.state.submittedAt,
      );
      if (!stillQueued.has(identity)) {
        cache.remove(mutation);
      }
    }

    restored = [];
  };

  const deliver = async (): Promise<void> => {
    await dropAlreadyDelivered();

    const queued = queuedMutations(queryClient);
    if (queued.length === 0) {
      return;
    }

    // `continue()` rather than `resumePausedMutations()`: the latter looks
    // only at paused mutations, and one retrying after an undelivered
    // failure — restored from storage, with no retryer of its own yet — is
    // just as much a member of the queue. `continue()` covers both, resuming
    // a paused retryer or executing a restored mutation from its variables.
    await Promise.all(
      queued.map((mutation) => mutation.continue().catch(() => undefined)),
    );

    await queryClient.invalidateQueries(cartFilter);
  };

  /**
   * One delivery round, start to finish, **inside** the lock.
   *
   * The rewrite has to be in here with the sending. Released a moment early —
   * with the save left to run after — a second context could acquire the lock
   * and read the envelope while it still listed everything this one has just
   * delivered, and send all of it again. Holding the lock until storage says
   * so is the whole point of taking it.
   *
   * `finally`, so a `deliver` that throws still leaves storage describing
   * what actually happened.
   */
  const deliveryRound = async (): Promise<void> => {
    try {
      await deliver();
    } finally {
      // The event-driven save covers this too; doing it explicitly closes the
      // window between a mutation settling and the persister's subscription
      // noticing it.
      await saveNow().catch(() => undefined);
    }
  };

  const flush = async (): Promise<void> => {
    try {
      await withDeliveryLock(deliveryRound);
    } catch {
      // Per-mutation failures are already swallowed inside `deliver`;
      // anything reaching here is a storage or lock problem that an event
      // listener cannot act on, and must not become an unhandled rejection.
    }
  };

  const onRestored = (): void => {
    restored = queuedMutations(queryClient);
    // Deliberately **not** awaited, and `onRestored` returns nothing.
    // `PersistQueryClientProvider` chains its `onSuccess` before flipping
    // `isRestoring` to false, and it only subscribes the persister once that
    // flips — so awaiting delivery here would leave the app in its restoring
    // state, and nothing persisted at all, for as long as delivery took.
    // With a queue that retries until the server answers, "as long as it
    // took" can be the whole session.
    void flush();
  };

  // Never unsubscribed: both the client and these listeners live for the
  // lifetime of the tab (see `getRuntime` in `client.tsx`, which installs
  // this exactly once, in the browser only).
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

  if (typeof window !== "undefined") {
    // The last chance to write. `pagehide` is the one that fires on iOS
    // (where `beforeunload` and `unload` are unreliable), and
    // `visibilitychange` → hidden is the one that fires when the PWA is
    // backgrounded — after which its timers stop and it may never run again.
    const save = () => void saveNow().catch(() => undefined);
    window.addEventListener("pagehide", save);
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        save();
      }
    });
  }

  return {
    flush,
    onRestored,
    saveNow,
    /**
     * `removeClient` goes straight at the store rather than through the
     * save throttle, so awaiting it is a real guarantee. A save already
     * scheduled when this runs can still land afterwards and re-create the
     * entry — but `asyncThrottle` keeps only the *latest* arguments, and by
     * then the cache has been cleared, so what it would write is an empty
     * envelope. Either outcome leaves nothing of the previous session.
     */
    purge: () => Promise.resolve(persister.removeClient()),
    persistOptions: {
      persister,
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

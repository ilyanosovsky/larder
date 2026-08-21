import {
  QueryClient,
  type Mutation,
  type MutationKey,
  type QueryKey,
} from "@tanstack/react-query";
import type {
  AsyncStorage,
  PersistedClient,
} from "@tanstack/react-query-persist-client";
import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import superjson from "superjson";
import { describe, expect, it, vi } from "vitest";

import { mutationIdentity } from "@/lib/sync/delivery";
import { OFFLINE_CACHE_KEY } from "@/lib/sync/offline-cache";
import type { AppRouter } from "@/server/api/root";

import {
  createInertPersistOptions,
  installOfflineQueue,
} from "./offline-queue";

/**
 * A client that is never called: `installOfflineQueue` only needs it to build
 * the tRPC option-proxy, and the proxy does not touch the transport until a
 * `mutationFn` actually runs. Every mutation exercised below carries its own
 * fake function, so no request leaves this file.
 */
function makeClient() {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchStreamLink({
        transformer: superjson,
        url: "http://localhost/api/trpc",
      }),
    ],
  });
}

/** The persister's storage, in memory — CI has no IndexedDB. */
function memoryStorage() {
  const entries = new Map<string, string>();

  const storage: AsyncStorage<string> = {
    getItem: (key) => Promise.resolve(entries.get(key)),
    setItem: (key, value) => Promise.resolve(entries.set(key, value)),
    removeItem: (key) => {
      entries.delete(key);
      return Promise.resolve();
    },
  };

  return { storage, entries };
}

function install() {
  const queryClient = new QueryClient();
  const { storage, entries } = memoryStorage();
  const queue = installOfflineQueue(queryClient, makeClient(), { storage });
  return { queryClient, queue, entries };
}

/** A paused mutation in `queryClient`'s cache, as a restore would rebuild it. */
function pausedMutation(
  queryClient: QueryClient,
  mutationKey: MutationKey,
  mutationFn?: () => Promise<unknown>,
): Mutation<unknown, Error, unknown, unknown> {
  const mutation = queryClient
    .getMutationCache()
    .build<unknown, Error, unknown, unknown>(queryClient, {
      mutationKey,
      ...(mutationFn ? { mutationFn } : {}),
    });
  mutation.state = {
    ...mutation.state,
    status: "pending",
    isPaused: true,
    submittedAt: 1000,
    variables: { id: "row" },
  };
  return mutation;
}

/** The envelope another context leaves behind once it has drained the queue. */
function drainedEnvelope(queue: { persistOptions: { buster?: string } }) {
  return superjson.stringify({
    timestamp: Date.now(),
    buster: queue.persistOptions.buster ?? "",
    clientState: { queries: [], mutations: [] },
  } satisfies PersistedClient);
}

/** A query holding data, which is the only kind that may be persisted. */
function successfulQuery(queryClient: QueryClient, queryKey: QueryKey) {
  const query = queryClient
    .getQueryCache()
    .build<unknown, Error, unknown, QueryKey>(queryClient, { queryKey });
  query.setData([]);
  return query;
}

/**
 * These assertions are about the seam between two libraries, which is exactly
 * where a silent break lives: `offline-cache.test.ts` proves the filters
 * against hand-written key fixtures, and this file proves those fixtures are
 * what the tRPC option-proxy really builds. If tRPC ever changes its key
 * shape, the persist filters would quietly match nothing — the queue would
 * keep working right up until a reload, then be empty — and only this test
 * would notice.
 */
describe("installOfflineQueue: registration", () => {
  it("gives every cart mutation a function to run after a restore", () => {
    const { queryClient } = install();

    for (const path of [
      "add",
      "setStatus",
      "updateItem",
      "remove",
      "receiveOrder",
    ]) {
      const defaults = queryClient.getMutationDefaults([["cart", path]]);
      expect(defaults.mutationFn, path).toBeTypeOf("function");
    }
  });

  it("gives every cart mutation the delivery retry policy", () => {
    const { queryClient } = install();

    for (const path of [
      "add",
      "setStatus",
      "updateItem",
      "remove",
      "receiveOrder",
    ]) {
      const { retry } = queryClient.getMutationDefaults([["cart", path]]);
      expect(retry, path).toBeTypeOf("function");

      const shouldRetry = retry as (count: number, error: unknown) => boolean;
      // Undelivered: keep it alive, however many times it has failed. This is
      // what stops a captive portal from erasing the queue.
      expect(shouldRetry(9, new TypeError("Failed to fetch")), path).toBe(true);
      // Answered by the server: no point sending it again.
      expect(
        shouldRetry(
          0,
          Object.assign(new Error("x"), { data: { code: "NOT_FOUND" } }),
        ),
        path,
      ).toBe(false);
    }
  });

  it("registers nothing for a mutation outside the cart router", () => {
    const { queryClient } = install();

    expect(
      queryClient.getMutationDefaults([["product", "create"]]).mutationFn,
    ).toBeUndefined();
  });
});

describe("installOfflineQueue: persist filters", () => {
  it("persists a paused cart mutation built by the real option-proxy", () => {
    const { queryClient, queue } = install();
    const shouldDehydrate =
      queue.persistOptions.dehydrateOptions?.shouldDehydrateMutation;
    expect(shouldDehydrate).toBeTypeOf("function");

    expect(
      shouldDehydrate?.(pausedMutation(queryClient, [["cart", "setStatus"]])),
    ).toBe(true);
  });

  it("persists a paused cart.receiveOrder — the filter is path-prefix based, not an explicit list", () => {
    const { queryClient, queue } = install();
    const shouldDehydrate =
      queue.persistOptions.dehydrateOptions?.shouldDehydrateMutation;

    expect(
      shouldDehydrate?.(
        pausedMutation(queryClient, [["cart", "receiveOrder"]]),
      ),
    ).toBe(true);
  });

  it("does not persist a paused mutation from another router", () => {
    const { queryClient, queue } = install();

    expect(
      queue.persistOptions.dehydrateOptions?.shouldDehydrateMutation?.(
        pausedMutation(queryClient, [["product", "create"]]),
      ),
    ).toBe(false);
  });

  it("persists a successful cart.list and not a sibling query", () => {
    const { queryClient, queue } = install();
    const shouldDehydrate =
      queue.persistOptions.dehydrateOptions?.shouldDehydrateQuery;

    const cartList = successfulQuery(queryClient, [
      ["cart", "list"],
      { type: "query" },
    ]);
    const categoryList = successfulQuery(queryClient, [
      ["category", "list"],
      { type: "query" },
    ]);

    expect(shouldDehydrate?.(cartList)).toBe(true);
    expect(shouldDehydrate?.(categoryList)).toBe(false);
  });

  it("carries the buster and max age the cache policy defines", () => {
    const { queue } = install();
    const inert = createInertPersistOptions();

    expect(queue.persistOptions.buster).toBe(inert.buster);
    expect(queue.persistOptions.maxAge).toBe(inert.maxAge);
  });
});

describe("installOfflineQueue: delivery", () => {
  it("does nothing when nothing is queued", async () => {
    const { queue, entries } = install();

    await expect(queue.flush()).resolves.toBeUndefined();
    // The save still runs — an empty envelope is how storage stops listing
    // what has already gone.
    expect(entries.has(OFFLINE_CACHE_KEY)).toBe(true);
  });

  it("delivers a queued mutation and clears it out of storage", async () => {
    const { queryClient, queue, entries } = install();
    const send = vi.fn(() => Promise.resolve("ok"));
    pausedMutation(queryClient, [["cart", "setStatus"]], send);

    await queue.flush();

    expect(send).toHaveBeenCalledTimes(1);

    const stored = superjson.parse<PersistedClient>(
      entries.get(OFFLINE_CACHE_KEY) ?? "",
    );
    expect(stored.clientState.mutations).toHaveLength(0);
  });

  it("does not deliver a restored mutation another context already sent", async () => {
    const { queryClient, queue, entries } = install();
    const send = vi.fn(() => Promise.resolve("ok"));
    pausedMutation(queryClient, [["cart", "setStatus"]], send);

    // What a second open context sees once the first has delivered the shared
    // envelope and rewritten it: the envelope is *there*, and no longer lists
    // the mutation.
    entries.set(OFFLINE_CACHE_KEY, drainedEnvelope(queue));

    queue.onRestored();
    await queue.flush();

    expect(send).not.toHaveBeenCalled();
  });

  it("delivers a restored mutation when there is no envelope to check against", async () => {
    const { queryClient, queue } = install();
    const send = vi.fn(() => Promise.resolve("ok"));
    pausedMutation(queryClient, [["cart", "setStatus"]], send);

    // An *absent* envelope is not evidence of delivery — a context that
    // drained the queue always leaves one behind. Absent means expired,
    // purged, or a read that raced a write, and dropping on that would throw
    // away a tap nobody has sent.
    queue.onRestored();
    await queue.flush();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("delivers a restored mutation that storage still lists as queued", async () => {
    const { queryClient, queue, entries } = install();
    const send = vi.fn(() => Promise.resolve("ok"));
    const mutation = pausedMutation(queryClient, [["cart", "setStatus"]], send);

    // Storage agrees this one is still undelivered.
    entries.set(
      OFFLINE_CACHE_KEY,
      superjson.stringify({
        timestamp: Date.now(),
        buster: queue.persistOptions.buster ?? "",
        clientState: {
          queries: [],
          mutations: [
            {
              mutationKey: mutation.options.mutationKey,
              state: mutation.state,
            },
          ],
        },
      } satisfies PersistedClient),
    );

    queue.onRestored();
    await queue.flush();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("returns from onRestored without waiting for delivery", async () => {
    const { queryClient, queue } = install();
    let started = false;
    // A delivery that never finishes — the captive-portal retry loop, or
    // simply a slow connection. `PersistQueryClientProvider` chains
    // `onSuccess` before it flips `isRestoring` and subscribes the persister,
    // so if this waited, the app would sit in its restoring state and
    // persist nothing at all for the whole session.
    pausedMutation(queryClient, [["cart", "setStatus"]], () => {
      started = true;
      return new Promise(() => undefined);
    });

    // Returns synchronously, even though the delivery it starts never ends.
    // This is the assertion that bites: making `onRestored` hand back the
    // flush promise fails right here.
    expect(queue.onRestored()).toBeUndefined();

    // And the never-ending delivery really did start in the background,
    // rather than being skipped.
    await vi.waitFor(() => expect(started).toBe(true));
  });
});

describe("installOfflineQueue: the stored envelope", () => {
  it("round-trips a Date through the production serializer", async () => {
    // Not a test of superjson — a test that the *persister this app builds*
    // is wired to it. Deleting the serialize/deserialize options leaves every
    // other test passing and turns a queued `Date` into a string.
    const { queryClient, queue, entries } = install();

    const query = successfulQuery(queryClient, [
      ["cart", "list"],
      { type: "query" },
    ]);
    query.setData([{ id: "row", updatedAt: new Date("2026-08-21T10:00:00Z") }]);

    await queue.saveNow();

    const restored = await queue.persistOptions.persister.restoreClient();
    const rows = restored?.clientState.queries[0]?.state.data as
      { updatedAt: unknown }[] | undefined;

    expect(rows?.[0]?.updatedAt).toBeInstanceOf(Date);
    // And the raw entry really is what came out of the app's serializer.
    expect(entries.get(OFFLINE_CACHE_KEY)).toContain("Date");
  });
});

describe("installOfflineQueue: purge", () => {
  it("deletes the stored envelope, awaited", async () => {
    // What sign-out needs. `queryClient.clear()` only *schedules* an empty
    // replacement through the persister's throttle and nothing waits for it,
    // so a reload landing in that gap would restore the household that was
    // just signed out of.
    const { queryClient, queue, entries } = install();
    successfulQuery(queryClient, [["cart", "list"], { type: "query" }]);
    await queue.saveNow();
    expect(entries.has(OFFLINE_CACHE_KEY)).toBe(true);

    await queue.purge();

    expect(entries.has(OFFLINE_CACHE_KEY)).toBe(false);
  });

  it("leaves nothing behind even if a scheduled save lands afterwards", async () => {
    const { queryClient, queue, entries } = install();
    successfulQuery(queryClient, [["cart", "list"], { type: "query" }]);
    await queue.saveNow();

    queryClient.clear();
    await queue.purge();
    // The throttle keeps only the latest arguments, and by now the cache is
    // empty — so the worst a late write can do is re-create an empty one.
    await queue.saveNow();

    const stored = entries.get(OFFLINE_CACHE_KEY);
    if (stored !== undefined) {
      const envelope = superjson.parse<PersistedClient>(stored);
      expect(envelope.clientState.queries).toHaveLength(0);
      expect(envelope.clientState.mutations).toHaveLength(0);
    }
  });
});

describe("createInertPersistOptions", () => {
  it("restores nothing, so the server render never reads storage", async () => {
    const { persister } = createInertPersistOptions();

    await expect(persister.restoreClient()).resolves.toBeUndefined();
  });
});

describe("mutationIdentity across a real dehydrate", () => {
  it("names a stored mutation the same way the cache does", async () => {
    const { queryClient, queue, entries } = install();
    const mutation = pausedMutation(queryClient, [["cart", "setStatus"]]);

    await queue.saveNow();

    const stored = superjson.parse<PersistedClient>(
      entries.get(OFFLINE_CACHE_KEY) ?? "",
    );
    const persisted = stored.clientState.mutations[0];

    expect(
      mutationIdentity(persisted?.mutationKey, persisted?.state.submittedAt),
    ).toBe(
      mutationIdentity(
        mutation.options.mutationKey,
        mutation.state.submittedAt,
      ),
    );
  });
});

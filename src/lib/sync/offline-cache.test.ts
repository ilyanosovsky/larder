import type { DehydrateOptions } from "@tanstack/react-query";
import type { PersistedClient } from "@tanstack/react-query-persist-client";
import superjson from "superjson";
import { describe, expect, it } from "vitest";

import {
  createOfflineCacheFilters,
  deserializeOfflineCache,
  matchesTrpcPath,
  OFFLINE_CACHE_BUSTER,
  OFFLINE_CACHE_MAX_AGE_MS,
  OFFLINE_CACHE_VERSION,
  serializeOfflineCache,
  type PersistableMutation,
  type PersistableQuery,
} from "./offline-cache";

/** The keys the tRPC option-proxy actually builds, as fixtures. */
const CART_PATH_KEY = [["cart"]];
const CART_LIST_KEY = [["cart", "list"], { type: "query" }];
const CART_SET_STATUS_KEY = [["cart", "setStatus"]];
const CATEGORY_LIST_KEY = [["category", "list"], { type: "query" }];

function query(
  queryKey: readonly unknown[],
  status: string = "success",
): PersistableQuery {
  return { queryKey, state: { status } };
}

function mutation(
  mutationKey: readonly unknown[] | undefined,
  isPaused: boolean,
): PersistableMutation {
  return {
    options: { mutationKey },
    state: {
      status: "pending",
      isPaused,
      failureCount: 0,
      failureReason: null,
    },
  };
}

/** Not paused, but retrying after a failure the router never answered. */
function retryingMutation(
  mutationKey: readonly unknown[],
): PersistableMutation {
  return {
    options: { mutationKey },
    state: {
      status: "pending",
      isPaused: false,
      failureCount: 1,
      failureReason: new TypeError("Failed to fetch"),
    },
  };
}

describe("matchesTrpcPath", () => {
  it("matches a router path against a procedure under it", () => {
    expect(matchesTrpcPath(CART_SET_STATUS_KEY, CART_PATH_KEY)).toBe(true);
    expect(matchesTrpcPath(CART_LIST_KEY, CART_PATH_KEY)).toBe(true);
  });

  it("matches a procedure path against its own key, ignoring the type entry", () => {
    expect(matchesTrpcPath(CART_LIST_KEY, CART_LIST_KEY)).toBe(true);
  });

  it("does not match a sibling router", () => {
    expect(matchesTrpcPath(CATEGORY_LIST_KEY, CART_PATH_KEY)).toBe(false);
  });

  it("does not match a sibling procedure of the same router", () => {
    expect(matchesTrpcPath(CART_SET_STATUS_KEY, CART_LIST_KEY)).toBe(false);
  });

  it("is a prefix match, not an equality match — a longer key still matches", () => {
    expect(matchesTrpcPath([["cart", "list", "deep"]], CART_LIST_KEY)).toBe(
      true,
    );
  });

  it("refuses an empty path rather than matching everything", () => {
    expect(matchesTrpcPath(CART_SET_STATUS_KEY, [[]])).toBe(false);
    expect(matchesTrpcPath(CART_SET_STATUS_KEY, [])).toBe(false);
  });

  it("refuses keys that are not the array-of-arrays shape", () => {
    expect(matchesTrpcPath(undefined, CART_PATH_KEY)).toBe(false);
    expect(matchesTrpcPath("cart", CART_PATH_KEY)).toBe(false);
    expect(matchesTrpcPath(["cart"], CART_PATH_KEY)).toBe(false);
  });
});

describe("createOfflineCacheFilters", () => {
  const filters = createOfflineCacheFilters(CART_PATH_KEY, CART_LIST_KEY);

  it("is assignable to TanStack's own DehydrateOptions", () => {
    // A type-level assertion with a runtime witness: the structural parameter
    // types in `offline-cache.ts` are only useful if a real `Query` /
    // `Mutation` can still be passed to them.
    const options: DehydrateOptions = filters;

    expect(options.shouldDehydrateQuery).toBeTypeOf("function");
    expect(options.shouldDehydrateMutation).toBeTypeOf("function");
  });

  it("persists a successful cart.list and nothing else", () => {
    expect(filters.shouldDehydrateQuery(query(CART_LIST_KEY))).toBe(true);
    expect(filters.shouldDehydrateQuery(query(CATEGORY_LIST_KEY))).toBe(false);
  });

  it("does not persist a pending or failed cart.list", () => {
    // A pending query is dehydrated together with its in-flight promise,
    // which cannot be written to storage at all.
    expect(filters.shouldDehydrateQuery(query(CART_LIST_KEY, "pending"))).toBe(
      false,
    );
    expect(filters.shouldDehydrateQuery(query(CART_LIST_KEY, "error"))).toBe(
      false,
    );
  });

  it("persists a paused cart mutation", () => {
    expect(
      filters.shouldDehydrateMutation(mutation(CART_SET_STATUS_KEY, true)),
    ).toBe(true);
  });

  it("does not persist an in-flight cart mutation — it may already have landed", () => {
    expect(
      filters.shouldDehydrateMutation(mutation(CART_SET_STATUS_KEY, false)),
    ).toBe(false);
  });

  it("persists a cart mutation retrying after an undelivered failure", () => {
    // Wider than TanStack's paused-only default on purpose: a captive portal
    // makes the first attempt fail, which un-pauses the mutation — and a
    // paused-only filter would then erase the whole queue from storage.
    expect(
      filters.shouldDehydrateMutation(retryingMutation(CART_SET_STATUS_KEY)),
    ).toBe(true);
  });

  it("still scopes the retrying case to the cart router", () => {
    expect(
      filters.shouldDehydrateMutation(
        retryingMutation([["product", "create"]]),
      ),
    ).toBe(false);
  });

  it("does not persist a paused mutation from another router", () => {
    expect(
      filters.shouldDehydrateMutation(mutation([["product", "create"]], true)),
    ).toBe(false);
  });

  it("does not persist a keyless mutation", () => {
    expect(filters.shouldDehydrateMutation(mutation(undefined, true))).toBe(
      false,
    );
  });
});

describe("offline cache envelope", () => {
  /**
   * A payload shaped like the real one: a cart.list snapshot already run
   * through `superjson.serialize` by the dehydrate hook in
   * `src/trpc/query-client.ts`, plus one paused `setStatus` whose optimistic
   * context carries a raw `Date` — the case a plain JSON envelope loses.
   */
  const persisted: PersistedClient = {
    timestamp: 1_700_000_000_000,
    buster: OFFLINE_CACHE_BUSTER,
    clientState: {
      queries: [
        {
          queryKey: CART_LIST_KEY,
          queryHash: JSON.stringify(CART_LIST_KEY),
          state: {
            data: superjson.serialize([
              {
                id: "0f1a9b0c-1111-4222-8333-444455556666",
                qty: 6,
                unit: "шт",
                status: "needed",
                updatedAt: new Date("2026-08-21T10:00:00.000Z"),
              },
            ]),
            dataUpdateCount: 1,
            dataUpdatedAt: 1_700_000_000_000,
            error: null,
            errorUpdateCount: 0,
            errorUpdatedAt: 0,
            fetchFailureCount: 0,
            fetchFailureReason: null,
            fetchMeta: null,
            isInvalidated: false,
            status: "success",
            fetchStatus: "idle",
          },
        },
      ],
      mutations: [
        {
          mutationKey: CART_SET_STATUS_KEY,
          state: {
            context: {
              previousStatus: "needed",
              updatedAt: new Date("2026-08-21T09:59:00.000Z"),
            },
            data: undefined,
            error: null,
            failureCount: 0,
            failureReason: null,
            isPaused: true,
            status: "pending",
            variables: {
              id: "0f1a9b0c-1111-4222-8333-444455556666",
              status: "bought",
            },
            submittedAt: 1_700_000_000_000,
          },
        },
      ],
    },
  };

  it("round-trips the whole payload", () => {
    const restored = deserializeOfflineCache(serializeOfflineCache(persisted));

    expect(restored).toEqual(persisted);
  });

  it("keeps a queued mutation's variables intact, which is what gets replayed", () => {
    const restored = deserializeOfflineCache(serializeOfflineCache(persisted));

    expect(restored.clientState.mutations[0]?.state.variables).toEqual({
      id: "0f1a9b0c-1111-4222-8333-444455556666",
      status: "bought",
    });
    expect(restored.clientState.mutations[0]?.state.isPaused).toBe(true);
  });

  it("preserves a Date that JSON would have flattened to a string", () => {
    const restored = deserializeOfflineCache(serializeOfflineCache(persisted));
    const context = restored.clientState.mutations[0]?.state.context;

    expect(context).toBeTypeOf("object");
    const updatedAt = (context as { updatedAt: unknown }).updatedAt;
    expect(updatedAt).toBeInstanceOf(Date);

    // The contrast the choice of serializer is about.
    const viaJson = JSON.parse(JSON.stringify(persisted)) as PersistedClient;
    expect(
      (
        viaJson.clientState.mutations[0]?.state.context as {
          updatedAt: unknown;
        }
      ).updatedAt,
    ).toBeTypeOf("string");
  });

  it("survives a payload restored from an entry written before superjson had anything to do", () => {
    const plain: PersistedClient = {
      timestamp: 1,
      buster: OFFLINE_CACHE_BUSTER,
      clientState: { queries: [], mutations: [] },
    };

    expect(deserializeOfflineCache(serializeOfflineCache(plain))).toEqual(
      plain,
    );
  });
});

describe("cache version", () => {
  /**
   * The buster is what makes an incompatible payload disappear instead of
   * being replayed against a contract that has moved. Bump
   * `OFFLINE_CACHE_VERSION` — never edit the buster string by hand — when
   * `cart.list`'s output, any `cart.*` mutation input, or the serializer
   * changes. See the module doc comment.
   */
  it("derives the buster from the version, so bumping one bumps the other", () => {
    expect(OFFLINE_CACHE_BUSTER).toContain(String(OFFLINE_CACHE_VERSION));
    expect(OFFLINE_CACHE_BUSTER).toBe(`larder-cart-v${OFFLINE_CACHE_VERSION}`);
  });

  it("keeps the version a whole number, so the buster never gains a dot", () => {
    expect(Number.isInteger(OFFLINE_CACHE_VERSION)).toBe(true);
    expect(OFFLINE_CACHE_VERSION).toBeGreaterThan(0);
  });

  it("drops a stored payload after two days", () => {
    expect(OFFLINE_CACHE_MAX_AGE_MS).toBe(48 * 60 * 60 * 1000);
  });
});

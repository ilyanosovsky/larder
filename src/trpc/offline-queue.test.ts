import {
  QueryClient,
  type MutationKey,
  type QueryKey,
} from "@tanstack/react-query";
import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import superjson from "superjson";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "@/server/api/root";

import {
  createInertPersistOptions,
  installOfflineQueue,
} from "./offline-queue";

/**
 * A client that is never called: `installOfflineQueue` only needs it to build
 * the tRPC option-proxy, and the proxy does not touch the transport until a
 * `mutationFn` actually runs. No request leaves this file.
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

function install() {
  const queryClient = new QueryClient();
  const queue = installOfflineQueue(queryClient, makeClient());
  return { queryClient, queue };
}

/** A paused mutation in `queryClient`'s cache, as a restore would rebuild it. */
function pausedMutation(queryClient: QueryClient, mutationKey: MutationKey) {
  const mutation = queryClient
    .getMutationCache()
    .build<unknown, Error, unknown, unknown>(queryClient, { mutationKey });
  mutation.state = { ...mutation.state, isPaused: true };
  return mutation;
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
describe("installOfflineQueue", () => {
  it("gives every cart mutation a function to run after a restore", () => {
    const { queryClient } = install();

    for (const path of ["add", "setStatus", "updateItem", "remove"]) {
      const defaults = queryClient.getMutationDefaults([["cart", path]]);
      expect(defaults.mutationFn, path).toBeTypeOf("function");
    }
  });

  it("registers nothing for a mutation outside the cart router", () => {
    const { queryClient } = install();

    expect(
      queryClient.getMutationDefaults([["product", "create"]]).mutationFn,
    ).toBeUndefined();
  });

  it("persists a paused cart mutation built by the real option-proxy", () => {
    const { queryClient, queue } = install();
    const shouldDehydrate =
      queue.persistOptions.dehydrateOptions?.shouldDehydrateMutation;
    expect(shouldDehydrate).toBeTypeOf("function");

    expect(
      shouldDehydrate?.(pausedMutation(queryClient, [["cart", "setStatus"]])),
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

  it("flushes to a no-op when nothing is queued", async () => {
    const { queue } = install();

    await expect(queue.flush()).resolves.toBeUndefined();
  });
});

describe("createInertPersistOptions", () => {
  it("restores nothing, so the server render never reads storage", async () => {
    const { persister } = createInertPersistOptions();

    await expect(persister.restoreClient()).resolves.toBeUndefined();
  });
});

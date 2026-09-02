import {
  hashKey,
  hydrate,
  QueryClient,
  dehydrate,
  type DehydratedState,
} from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { makeQueryClient } from "./query-client";
import { settleQueries } from "./settle-queries";

/**
 * The payload the *old* `shouldDehydrateQuery` produced for a prefetch that
 * was still running when `HydrateClient` snapshotted the cache: no data, and
 * the in-flight promise alongside it. `hydrate()` types this as a full
 * `QueryState`, which a hand-built fixture has no business restating.
 */
function pendingPayload(
  queryKey: string[],
  promise: Promise<unknown>,
): DehydratedState {
  return {
    mutations: [],
    queries: [
      {
        dehydratedAt: Date.now(),
        queryKey,
        queryHash: hashKey(queryKey),
        state: { status: "pending", data: undefined, dataUpdatedAt: 0 },
        promise,
      },
    ],
  } as unknown as DehydratedState;
}

describe("makeQueryClient dehydrate defaults", () => {
  it("never dehydrates a pending query", () => {
    const client = makeQueryClient();

    void client.prefetchQuery({
      queryKey: ["pending"],
      queryFn: () => new Promise<string>(() => undefined),
    });

    expect(client.getQueryState(["pending"])?.status).toBe("pending");
    expect(dehydrate(client).queries).toHaveLength(0);
  });

  it("hydrates a settled prefetch as success, with its Dates intact", async () => {
    const server = makeQueryClient();
    const closedAt = new Date("2026-09-02T10:00:00.000Z");

    void server.prefetchQuery({
      queryKey: ["trips"],
      queryFn: () => Promise.resolve([{ closedAt }]),
    });
    await settleQueries(server);

    const browser = makeQueryClient();
    hydrate(browser, dehydrate(server));

    const state = browser.getQueryState<{ closedAt: Date }[]>(["trips"]);
    expect(state?.status).toBe("success");
    expect(state?.data?.[0]?.closedAt).toBeInstanceOf(Date);
    expect(state?.data?.[0]?.closedAt.toISOString()).toBe(
      closedAt.toISOString(),
    );
  });
});

describe("the old failure mode", () => {
  // A plain QueryClient on purpose: `makeQueryClient()` would run this raw
  // fixture through `superjson.deserialize`, which is not what is under test.
  it("hydrates a Flight-shaped promise as success — what the browser did", () => {
    const client = new QueryClient();
    // React's production Flight client resolves a fulfilled chunk
    // synchronously, which is what `tryResolveSync` needs. It returns nothing
    // from `then` — `tryResolveSync` does `promise.then(cb, noop)?.catch(noop)`
    // precisely because of that, so a fake that returns a value would throw
    // instead of reproducing the bug.
    const flightChunk = {
      then(onFulfilled: (value: unknown) => unknown) {
        onFulfilled(["milk"]);
      },
    } as unknown as Promise<unknown>;

    hydrate(client, pendingPayload(["cart"], flightChunk));

    expect(client.getQueryState(["cart"])?.status).toBe("success");
  });

  it("leaves an ordinary unresolved promise pending — what the server did", () => {
    const client = new QueryClient();

    hydrate(
      client,
      pendingPayload(["cart"], new Promise<unknown>(() => undefined)),
    );

    const state = client.getQueryState(["cart"]);
    // Same payload, two different first renders — that gap *was* the bug.
    expect(state?.status).toBe("pending");
    expect(state?.fetchStatus).toBe("fetching");
  });
});

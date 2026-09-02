import {
  dehydrate,
  hydrate,
  onlineManager,
  QueryClient,
} from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { makeQueryClient } from "./query-client";
import { dehydrateSettled, settleQueries } from "./settle-queries";

/** A promise whose resolution the test decides, like a slow procedure. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

describe("settleQueries", () => {
  it("resolves at once when nothing is in flight", async () => {
    await expect(settleQueries(new QueryClient())).resolves.toBeUndefined();
  });

  it("waits for an in-flight prefetch, so nothing is dehydrated as pending", async () => {
    const client = makeQueryClient();
    const gate = deferred<string[]>();

    void client.prefetchQuery({
      queryKey: ["slow"],
      queryFn: () => gate.promise,
    });
    expect(client.getQueryState(["slow"])?.status).toBe("pending");

    setTimeout(() => gate.resolve(["milk"]), 10);
    await settleQueries(client);

    const { queries } = dehydrate(client);
    expect(queries).toHaveLength(1);
    // "Settled implies success" is not a documented library guarantee — it
    // holds because `Query.fetch()` attaches its own `setData` continuation to
    // the retryer promise before we attach `allSettled`'s. This assertion is
    // the pin: if a future @tanstack/query-core reorders that, this test says
    // so instead of the bug coming back silently as a hydration mismatch.
    expect(queries[0]?.state.status).toBe("success");
    // The mismatch vector itself: a payload carrying a promise resolves
    // synchronously in the browser and never during SSR.
    expect(queries[0]).not.toHaveProperty("promise");
  });

  it("waits for every prefetch on the page, whatever order they resolve in", async () => {
    const client = makeQueryClient();
    const first = deferred<string[]>();
    const second = deferred<string[]>();

    void client.prefetchQuery({
      queryKey: ["cart"],
      queryFn: () => first.promise,
    });
    void client.prefetchQuery({
      queryKey: ["categories"],
      queryFn: () => second.promise,
    });

    // Out of order, and the second one lands well after the first: a page
    // whose queries finish together is not the shape to prove anything about.
    setTimeout(() => second.resolve(["dairy"]), 5);
    setTimeout(() => first.resolve(["milk"]), 20);
    await settleQueries(client);

    const statuses = dehydrate(client)
      .queries.map(
        (query) => `${String(query.queryKey[0])}:${query.state.status}`,
      )
      .sort();
    expect(statuses).toStrictEqual(["cart:success", "categories:success"]);
  });

  it("waits for a prefetch that only starts after the first await", async () => {
    const client = makeQueryClient();
    const first = deferred<string[]>();
    const second = deferred<string[]>();

    void client.prefetchQuery({
      queryKey: ["first"],
      queryFn: () => first.promise,
    });
    // A nested server component whose own prefetch begins only once the
    // first one has landed — the case the re-scan after each await exists
    // for. Collapse the loop to a single `allSettled` and `second` is still
    // pending when the cache is snapshotted.
    void first.promise.then(() => {
      void client.prefetchQuery({
        queryKey: ["second"],
        queryFn: () => second.promise,
      });
      setTimeout(() => second.resolve(["b"]), 10);
    });
    setTimeout(() => first.resolve(["a"]), 5);

    await settleQueries(client);

    const statuses = dehydrate(client)
      .queries.map(
        (query) => `${String(query.queryKey[0])}:${query.state.status}`,
      )
      .sort();
    expect(statuses).toStrictEqual(["first:success", "second:success"]);
  });

  it("does not await a paused query", async () => {
    const client = makeQueryClient();

    // `onlineManager` is a module singleton shared by every test in this
    // worker, so it is restored even if an assertion throws.
    onlineManager.setOnline(false);
    try {
      void client.prefetchQuery({
        queryKey: ["paused"],
        queryFn: () => new Promise<string>(() => undefined),
      });
      // A paused query has no in-flight promise to await and will never get
      // one on the server: widen the `fetchStatus === "fetching"` predicate
      // and this render waits forever instead of shipping without it.
      expect(client.getQueryState(["paused"])?.fetchStatus).toBe("paused");

      const raced = await Promise.race([
        settleQueries(client).then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 200)),
      ]);
      expect(raced).toBe("settled");
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("tolerates a failing prefetch: it neither rejects nor reaches the client", async () => {
    const server = makeQueryClient();

    void server.prefetchQuery({
      queryKey: ["boom"],
      queryFn: () => Promise.reject(new Error("db down")),
      // The retryer's server-side default is already 0 attempts, but this test
      // also runs in a plain node process where `isServer()` is false.
      retry: false,
    });

    await expect(settleQueries(server)).resolves.toBeUndefined();
    expect(server.getQueryState(["boom"])?.status).toBe("error");
    expect(dehydrate(server).queries).toHaveLength(0);

    // The contract that matters is on the other side: the client hydrates
    // without that query at all and fetches it itself — a skeleton on both
    // sides, never a mismatch.
    const browser = makeQueryClient();
    hydrate(browser, dehydrate(server));
    expect(browser.getQueryState(["boom"])).toBeUndefined();
  });
});

describe("dehydrateSettled", () => {
  it("snapshots the cache only after its queries have settled", async () => {
    const client = makeQueryClient();
    const gate = deferred<string[]>();

    void client.prefetchQuery({
      queryKey: ["slow"],
      queryFn: () => gate.promise,
    });
    setTimeout(() => gate.resolve(["milk"]), 10);

    // What `HydrateClient` calls, in one function so it can be tested without
    // standing up `server.tsx`'s import graph. Without the await inside, the
    // payload comes back empty: nothing has settled, and a pending query is
    // never dehydrated.
    const state = await dehydrateSettled(client);

    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]?.state.status).toBe("success");
    expect(state.queries[0]).not.toHaveProperty("promise");
  });
});

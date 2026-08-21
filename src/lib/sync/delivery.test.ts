import type { PersistedClient } from "@tanstack/react-query-persist-client";
import { describe, expect, it } from "vitest";

import {
  isQueuedMutationState,
  isUndeliveredFailure,
  mutationIdentity,
  persistedMutationIdentities,
  shouldRetryDelivery,
  type DeliverableMutationState,
} from "./delivery";

/** A rejection the router produced — `errorFormatter` puts a code on it. */
function serverRejection(code: string) {
  return Object.assign(new Error(code), { data: { code, zodError: null } });
}

/** A failure that never reached a procedure: dead fetch, proxy, portal. */
function networkFailure(message = "Failed to fetch") {
  return new TypeError(message);
}

function state(
  overrides: Partial<DeliverableMutationState> = {},
): DeliverableMutationState {
  return {
    status: "pending",
    isPaused: false,
    failureCount: 0,
    failureReason: null,
    ...overrides,
  };
}

describe("isUndeliveredFailure", () => {
  it("treats a coded tRPC error as the server's answer", () => {
    expect(isUndeliveredFailure(serverRejection("NOT_FOUND"))).toBe(false);
    expect(isUndeliveredFailure(serverRejection("CONFLICT"))).toBe(false);
    expect(isUndeliveredFailure(serverRejection("BAD_REQUEST"))).toBe(false);
    expect(isUndeliveredFailure(serverRejection("UNAUTHORIZED"))).toBe(false);
  });

  it("treats a bare fetch failure as never delivered", () => {
    expect(isUndeliveredFailure(networkFailure())).toBe(true);
  });

  it("treats a non-tRPC HTTP failure as never delivered", () => {
    // A proxy's 502 HTML page: it reached *a* server, but not a procedure,
    // so nothing was written and sending it again is safe.
    const proxyError = Object.assign(new Error("Unexpected token <"), {
      meta: { response: { status: 502 } },
      data: undefined,
      shape: undefined,
    });

    expect(isUndeliveredFailure(proxyError)).toBe(true);
  });

  it("treats anything unrecognisable as never delivered", () => {
    // Better to risk re-sending than to silently drop a shopper's tap.
    expect(isUndeliveredFailure(null)).toBe(true);
    expect(isUndeliveredFailure(undefined)).toBe(true);
    expect(isUndeliveredFailure("boom")).toBe(true);
    expect(isUndeliveredFailure({ data: {} })).toBe(true);
    expect(isUndeliveredFailure({ data: { code: 409 } })).toBe(true);
  });
});

describe("shouldRetryDelivery", () => {
  it("keeps retrying an undelivered call, however many times it has failed", () => {
    // The captive-portal case: `navigator.onLine` says yes, every request
    // dies at the network layer. TanStack's default (`retry: 0`) would settle
    // every queued mutation as an error, strip `isPaused`, and let the next
    // persist write an envelope without them — the whole queue erased,
    // silently, having never reached the server.
    expect(shouldRetryDelivery(0, networkFailure())).toBe(true);
    expect(shouldRetryDelivery(5, networkFailure())).toBe(true);
    expect(shouldRetryDelivery(500, networkFailure())).toBe(true);
  });

  it("gives up the moment the server actually answers", () => {
    expect(shouldRetryDelivery(0, serverRejection("NOT_FOUND"))).toBe(false);
    expect(shouldRetryDelivery(0, serverRejection("CONFLICT"))).toBe(false);
  });
});

describe("isQueuedMutationState", () => {
  it("queues a paused mutation — it never left the device", () => {
    expect(isQueuedMutationState(state({ isPaused: true }))).toBe(true);
  });

  it("queues one retrying after an undelivered failure", () => {
    // Not paused, so TanStack's own `defaultShouldDehydrateMutation` would
    // drop it from storage on the very first failure.
    expect(
      isQueuedMutationState(
        state({ failureCount: 1, failureReason: networkFailure() }),
      ),
    ).toBe(true);
  });

  it("does not queue a first attempt still in flight", () => {
    // No evidence either way about whether it landed, and `cart.add` merges.
    expect(isQueuedMutationState(state({ failureCount: 0 }))).toBe(false);
  });

  it("does not queue one the server has rejected", () => {
    expect(
      isQueuedMutationState(
        state({ failureCount: 1, failureReason: serverRejection("NOT_FOUND") }),
      ),
    ).toBe(false);
  });

  it("does not queue a settled mutation", () => {
    expect(
      isQueuedMutationState(
        state({
          status: "error",
          failureCount: 3,
          failureReason: networkFailure(),
        }),
      ),
    ).toBe(false);
    expect(isQueuedMutationState(state({ status: "success" }))).toBe(false);
  });

  it("queues a paused mutation even after a server rejection", () => {
    // Paused wins: the retryer parked it before running, so whatever the
    // previous attempt answered, this one has not been sent.
    expect(
      isQueuedMutationState(
        state({
          isPaused: true,
          failureCount: 2,
          failureReason: serverRejection("CONFLICT"),
        }),
      ),
    ).toBe(true);
  });
});

describe("mutationIdentity", () => {
  it("distinguishes two taps on the same procedure", () => {
    const key = [["cart", "setStatus"]];

    expect(mutationIdentity(key, 1000)).not.toBe(mutationIdentity(key, 1001));
  });

  it("distinguishes two procedures dispatched in the same millisecond", () => {
    expect(mutationIdentity([["cart", "setStatus"]], 1000)).not.toBe(
      mutationIdentity([["cart", "remove"]], 1000),
    );
  });

  it("is stable across a serialization round trip", () => {
    const key = [["cart", "setStatus"]];
    const restored: unknown = JSON.parse(JSON.stringify(key));

    expect(mutationIdentity(restored, 1000)).toBe(mutationIdentity(key, 1000));
  });

  it("does not throw on a keyless or timeless mutation", () => {
    expect(mutationIdentity(undefined, undefined)).toBeTypeOf("string");
  });
});

describe("persistedMutationIdentities", () => {
  function envelope(
    mutations: PersistedClient["clientState"]["mutations"],
  ): PersistedClient {
    return {
      timestamp: 1,
      buster: "test",
      clientState: { queries: [], mutations },
    };
  }

  it("lists what storage still holds as queued", () => {
    const identities = persistedMutationIdentities(
      envelope([
        {
          mutationKey: [["cart", "setStatus"]],
          state: {
            context: undefined,
            data: undefined,
            error: null,
            failureCount: 0,
            failureReason: null,
            isPaused: true,
            status: "pending",
            variables: { id: "a" },
            submittedAt: 1000,
          },
        },
      ]),
    );

    expect(
      identities.has(mutationIdentity([["cart", "setStatus"]], 1000)),
    ).toBe(true);
    expect(identities.size).toBe(1);
  });

  it("is empty for an envelope another context already drained", () => {
    // This is the signal that a second open context (a PWA plus a browser
    // tab) has delivered the restored queue, and that re-sending it would
    // merge a `cart.add` twice.
    expect(persistedMutationIdentities(envelope([])).size).toBe(0);
  });

  it("is empty when there is no stored envelope at all", () => {
    expect(persistedMutationIdentities(undefined).size).toBe(0);
  });
});

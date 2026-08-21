import { describe, expect, it } from "vitest";

import {
  CART_REFETCH_INTERVAL_MS,
  cartSyncQueryOptions,
} from "./cart-sync-presets";

describe("CART_REFETCH_INTERVAL_MS", () => {
  it("stays within VISION §6.3's ~30-60s band", () => {
    expect(CART_REFETCH_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    expect(CART_REFETCH_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("cartSyncQueryOptions", () => {
  it("polls at the shared interval", () => {
    expect(cartSyncQueryOptions.refetchInterval).toBe(CART_REFETCH_INTERVAL_MS);
  });

  it("refetches on focus and reconnect unconditionally, bypassing staleTime", () => {
    expect(cartSyncQueryOptions.refetchOnWindowFocus).toBe("always");
    expect(cartSyncQueryOptions.refetchOnReconnect).toBe("always");
  });
});

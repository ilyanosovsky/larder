import { describe, expect, it } from "vitest";

import {
  CART_REFETCH_INTERVAL_MS,
  cartSyncQueryOptions,
} from "./cart-sync-presets";
import { OFFLINE_CACHE_MAX_AGE_MS } from "./offline-cache";

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

  it("keeps the list in memory at least as long as the offline cache keeps it on disk", () => {
    // Below this, walking away from S3 garbage-collects `cart.list`, the
    // 'removed' event triggers a save, and the stored envelope loses the
    // list hours before its own max age says it should (task 2.4).
    expect(cartSyncQueryOptions.gcTime).toBeGreaterThanOrEqual(
      OFFLINE_CACHE_MAX_AGE_MS,
    );
  });
});

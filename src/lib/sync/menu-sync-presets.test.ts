import { describe, expect, it } from "vitest";

import { menuSyncQueryOptions } from "./menu-sync-presets";

describe("menuSyncQueryOptions", () => {
  it("refetches on focus and reconnect unconditionally, bypassing staleTime", () => {
    expect(menuSyncQueryOptions.refetchOnWindowFocus).toBe("always");
    expect(menuSyncQueryOptions.refetchOnReconnect).toBe("always");
  });

  it("does not poll", () => {
    // The assertion that catches a copy-paste from `cartSyncQueryOptions`:
    // the cart's 45s poll is justified by two people in a shop, and a weekly
    // plan edited in bursts minutes apart would just burn a request a minute
    // for a screen nobody is watching. `not.toHaveProperty` rather than
    // `toBeUndefined`, because an explicit `refetchInterval: undefined` would
    // pass the weaker check while still reading as "we thought about polling".
    expect(menuSyncQueryOptions).not.toHaveProperty("refetchInterval");
  });

  it("keeps nothing warm on disk — the offline cache is cart-only", () => {
    expect(menuSyncQueryOptions).not.toHaveProperty("gcTime");
  });
});

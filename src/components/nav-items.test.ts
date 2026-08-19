import { describe, expect, it } from "vitest";

import { isNavItemActive } from "./nav-items";

describe("isNavItemActive", () => {
  it("matches the root route only on an exact match", () => {
    expect(isNavItemActive("/", "/")).toBe(true);
    expect(isNavItemActive("/menu", "/")).toBe(false);
  });

  it("matches a non-root route on an exact match", () => {
    expect(isNavItemActive("/menu", "/menu")).toBe(true);
  });

  it("matches a non-root route on its sub-paths", () => {
    expect(isNavItemActive("/menu/2026-08-19", "/menu")).toBe(true);
  });

  it("does not match unrelated routes", () => {
    expect(isNavItemActive("/dishes", "/menu")).toBe(false);
  });

  it("does not match a route that merely shares a prefix", () => {
    expect(isNavItemActive("/menu-archive", "/menu")).toBe(false);
  });
});

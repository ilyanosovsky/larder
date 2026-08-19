import { describe, expect, it } from "vitest";

import { LOGIN_PATH, resolveAuthRedirect } from "./auth-redirect";

describe("resolveAuthRedirect", () => {
  it("sends an anonymous visitor of an app route to the login screen", () => {
    for (const pathname of [
      "/",
      "/menu",
      "/dishes",
      "/assistant",
      "/settings",
    ]) {
      expect(resolveAuthRedirect({ pathname, hasSessionCookie: false })).toBe(
        LOGIN_PATH,
      );
    }
  });

  it("treats nested app routes like their parent", () => {
    expect(
      resolveAuthRedirect({
        pathname: "/dishes/some-dish",
        hasSessionCookie: false,
      }),
    ).toBe(LOGIN_PATH);
  });

  it("lets a visitor with a session cookie through to app routes", () => {
    expect(
      resolveAuthRedirect({ pathname: "/menu", hasSessionCookie: true }),
    ).toBeNull();
  });

  it("lets an anonymous visitor stay on the login screen", () => {
    expect(
      resolveAuthRedirect({ pathname: LOGIN_PATH, hasSessionCookie: false }),
    ).toBeNull();
  });

  it("never bounces off the login screen on the cookie alone, so a stale cookie cannot cause a redirect loop", () => {
    // With a stale cookie the app layout redirects /* -> /login; if the
    // middleware also redirected /login -> / the two would ping-pong forever.
    expect(
      resolveAuthRedirect({ pathname: LOGIN_PATH, hasSessionCookie: true }),
    ).toBeNull();
  });
});

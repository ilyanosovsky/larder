import { describe, expect, it } from "vitest";

import { MAX_SOURCE_URL } from "@/lib/recipes/draft";

import {
  classifyImportUrl,
  isBlockedAddress,
  isBlockedHostname,
  isSocialHost,
  parseIpAddress,
} from "./url-guard";

describe("classifyImportUrl — the URL as written", () => {
  it("accepts an ordinary recipe link and normalizes it", () => {
    expect(
      classifyImportUrl("https://eda.rambler.ru/recepty/osnovnye-blyuda/x-1"),
    ).toEqual({
      kind: "ok",
      url: "https://eda.rambler.ru/recepty/osnovnye-blyuda/x-1",
    });
    expect(classifyImportUrl("http://povar.ru/recipes/x.html")).toMatchObject({
      kind: "ok",
    });
  });

  it.each([
    ["file", "file:///etc/passwd"],
    ["ftp", "ftp://example.com/recipe.html"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:text/html,<h1>hi</h1>"],
    ["gopher", "gopher://example.com/"],
  ])("refuses the %s scheme", (_label, url) => {
    expect(classifyImportUrl(url)).toEqual({ kind: "blocked" });
  });

  it("refuses credentials in the URL", () => {
    // Parsers disagree about where the host starts in `a@b`; we do not play.
    expect(classifyImportUrl("https://user:pass@example.com/r")).toEqual({
      kind: "blocked",
    });
    expect(classifyImportUrl("https://user@example.com/r")).toEqual({
      kind: "blocked",
    });
  });

  it("refuses every port but 80 and 443", () => {
    expect(classifyImportUrl("http://example.com:80/r")).toMatchObject({
      kind: "ok",
    });
    expect(classifyImportUrl("https://example.com:443/r")).toMatchObject({
      kind: "ok",
    });
    expect(classifyImportUrl("http://example.com:6379/r")).toEqual({
      kind: "blocked",
    });
    expect(classifyImportUrl("http://example.com:8080/r")).toEqual({
      kind: "blocked",
    });
  });

  it.each([
    "http://localhost/r",
    "http://LOCALHOST/r",
    "http://api.localhost/r",
    "http://printer.local/r",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://anything.internal/r",
    "http://router.home.arpa/r",
    // A trailing dot is the DNS root, not a different name.
    "http://localhost./r",
  ])("refuses the internal name %s", (url) => {
    expect(classifyImportUrl(url)).toEqual({ kind: "blocked" });
  });

  it.each([
    "http://127.0.0.1/r",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/r",
    "http://[::1]/r",
    // Public literals too: no recipe site is addressed by number, and
    // allowing them would mean trusting the range list to be complete.
    "http://93.184.216.34/r",
  ])("refuses the literal address %s", (url) => {
    expect(classifyImportUrl(url)).toEqual({ kind: "blocked" });
  });

  it("refuses a link whose normalized form would not fit the draft", () => {
    // `fromUrlInput` bounds the string as typed; `new URL()` percent-encodes
    // every non-ASCII byte, so a Cyrillic path well under the cap comes back
    // six times longer than it went in — past what `recipes.source_url`
    // stores, and the draft would have refused it after the model was paid.
    const raw = `https://example.com/${"щ".repeat(700)}`;
    expect(raw.length).toBeLessThan(MAX_SOURCE_URL);
    expect(new URL(raw).href.length).toBeGreaterThan(MAX_SOURCE_URL);
    expect(classifyImportUrl(raw)).toEqual({ kind: "blocked" });

    const fits = `https://example.com/${"щ".repeat(300)}`;
    expect(classifyImportUrl(fits)).toEqual({
      kind: "ok",
      url: new URL(fits).href,
    });
  });

  it("refuses a string that is not a URL at all", () => {
    expect(classifyImportUrl("not a url")).toEqual({ kind: "blocked" });
    expect(classifyImportUrl("")).toEqual({ kind: "blocked" });
  });

  it.each([
    "https://www.instagram.com/p/abc123/",
    "https://instagram.com/reel/abc",
    "https://www.facebook.com/recipe",
    "https://vm.tiktok.com/xyz/",
    "https://www.threads.net/@cook/post/1",
  ])("marks %s as a login wall rather than blocking it", (url) => {
    // Not a threat — a page that answers a server with a login form. The
    // direct fetch is skipped, FireCrawl gets one try, then S8.2 says
    // «скриншот работает лучше».
    expect(classifyImportUrl(url)).toMatchObject({ kind: "social" });
  });

  it("does not mistake a lookalike domain for a social host", () => {
    expect(classifyImportUrl("https://notinstagram.com/r")).toMatchObject({
      kind: "ok",
    });
    expect(isSocialHost("instagram.com.evil.example")).toBe(false);
  });
});

describe("isBlockedHostname", () => {
  it("blocks the internal suffixes and nothing else", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("db.internal")).toBe(true);
    expect(isBlockedHostname("povar.ru")).toBe(false);
    // A name that merely *contains* one of the words is a real site.
    expect(isBlockedHostname("mylocalhost.ru")).toBe(false);
    expect(isBlockedHostname("localhost.evil.com")).toBe(false);
  });
});

describe("isBlockedAddress — what the name resolved to", () => {
  it.each([
    ["loopback", "127.0.0.1"],
    ["loopback, whole /8", "127.53.1.9"],
    ["this network", "0.0.0.0"],
    ["private 10/8", "10.1.2.3"],
    ["private 172.16/12", "172.16.0.1"],
    ["private 172.31/12", "172.31.255.254"],
    ["private 192.168/16", "192.168.1.1"],
    ["link-local", "169.254.1.1"],
    ["cloud metadata", "169.254.169.254"],
    ["CGNAT", "100.64.0.1"],
    ["IETF protocol assignments", "192.0.0.171"],
    ["benchmarking", "198.18.0.1"],
    ["benchmarking, upper half", "198.19.255.255"],
    ["multicast", "224.0.0.1"],
    ["broadcast", "255.255.255.255"],
  ])("blocks %s (%s)", (_label, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["unique local", "fc00::1"],
    ["unique local, upper half", "fd12:3456::1"],
    ["link-local", "fe80::1"],
    ["multicast", "ff02::1"],
    ["6to4", "2002:c0a8:0101::1"],
    ["NAT64", "64:ff9b::a00:1"],
  ])("blocks the IPv6 %s (%s)", (_label, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it("unwraps IPv4-mapped IPv6 before deciding", () => {
    // `::ffff:10.0.0.1` is 10.0.0.1 wearing a hat. A guard that reads it as
    // "some IPv6 address" waves it straight through.
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    // …and the same wrapper around a public address is still public.
    expect(isBlockedAddress("::ffff:93.184.216.34")).toBe(false);
  });

  it.each(["93.184.216.34", "8.8.8.8", "2a00:1450:4010:c07::8b", "1.1.1.1"])(
    "allows the public address %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it("fails closed on anything it cannot read", () => {
    // This function is the last thing between a redirect and a socket.
    expect(isBlockedAddress("not-an-address")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
    expect(isBlockedAddress("999.1.1.1")).toBe(true);
    expect(isBlockedAddress("1.2.3")).toBe(true);
  });

  it("refuses the shorthand forms that classically bypass guards", () => {
    // `inet_aton` would resolve every one of these to 127.0.0.1. We do not
    // expand them — we simply do not recognize them as addresses, and an
    // unrecognized address is blocked.
    expect(isBlockedAddress("127.1")).toBe(true);
    expect(isBlockedAddress("0x7f.0.0.1")).toBe(true);
    expect(isBlockedAddress("2130706433")).toBe(true);
    expect(parseIpAddress("127.1")).toBeNull();
  });
});

describe("parseIpAddress", () => {
  it("reads a dotted quad and a compressed IPv6", () => {
    expect(parseIpAddress("192.168.0.1")).toEqual([192, 168, 0, 1]);
    expect(parseIpAddress("::1")).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
    expect(parseIpAddress("2001:db8::1")?.slice(0, 4)).toEqual([
      0x20, 0x01, 0x0d, 0xb8,
    ]);
  });

  it("returns null for a hostname", () => {
    expect(parseIpAddress("povar.ru")).toBeNull();
    expect(parseIpAddress("1.2.3.4.5")).toBeNull();
    expect(parseIpAddress("fe80:::1")).toBeNull();
  });

  it("strips a zone id rather than choking on it", () => {
    expect(isBlockedAddress("fe80::1%eth0")).toBe(true);
  });
});

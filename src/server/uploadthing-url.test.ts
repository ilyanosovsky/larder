import { describe, expect, it } from "vitest";

import {
  decodeAppId,
  UPLOADTHING_KEY_RE,
  uploadThingUrl,
} from "@/server/uploadthing-url";

/** A v7-shaped token, built here rather than copied from a real project. */
function token(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

describe("decodeAppId", () => {
  it("reads the app id out of a v7 token", () => {
    expect(
      decodeAppId(
        token({ apiKey: "sk_live_secret", appId: "abc123", regions: ["sea1"] }),
      ),
    ).toBe("abc123");
  });

  it("throws on JSON without an appId", () => {
    expect(() => decodeAppId(token({ apiKey: "sk_live_secret" }))).toThrow(
      /appId/,
    );
  });

  it("throws on an appId that is present but empty", () => {
    // A blank id would build `https://.ufs.sh/f/<key>` — a URL that resolves
    // nowhere and would surface as «фото не читается».
    expect(() => decodeAppId(token({ appId: "   " }))).toThrow(/appId/);
  });

  it("throws on an appId of the wrong type", () => {
    expect(() => decodeAppId(token({ appId: 42 }))).toThrow(/appId/);
  });

  it("throws when the token does not decode to JSON", () => {
    // `Buffer.from(…, "base64")` never throws — it drops what it cannot read
    // — so the failure surfaces at `JSON.parse`, which is exactly why both
    // steps are guarded rather than only the first.
    expect(() => decodeAppId("not a token at all")).toThrow(/JSON/);
  });

  it("throws on JSON that is not an object", () => {
    expect(() => decodeAppId(token("abc123"))).toThrow(/appId/);
  });
});

describe("UPLOADTHING_KEY_RE", () => {
  it("accepts the key alphabet UploadThing uses", () => {
    expect(UPLOADTHING_KEY_RE.test("abc123XYZ_-")).toBe(true);
  });

  it.each([
    ["a traversal", "../secret"],
    ["a query string", "key?x=1"],
    ["a full URL", "https://evil.example.com/f/key"],
    ["an empty string", ""],
    ["a slash", "a/b"],
    ["a newline-smuggled second line", "abc\nhttp://evil.example.com"],
    ["a percent escape", "abc%2f"],
  ])("rejects %s", (_label, value) => {
    expect(UPLOADTHING_KEY_RE.test(value)).toBe(false);
  });

  it("rejects a key past the length cap", () => {
    expect(UPLOADTHING_KEY_RE.test("a".repeat(201))).toBe(false);
  });
});

describe("uploadThingUrl", () => {
  it("refuses a key that is not key-shaped before reading any environment", () => {
    // The guard has to fire *before* `uploadThingAppId()`, or a malformed key
    // in a fully-configured deployment would be interpolated into the path.
    expect(() => uploadThingUrl("../../etc/passwd")).toThrow(
      /UploadThing file key/,
    );
  });
});

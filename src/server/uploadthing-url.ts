import "server-only";

import { env } from "@/lib/env";

/**
 * Rebuilding an UploadThing image URL from a file key, server-side
 * (blueprint §3.5, decision D5).
 *
 * **`dishImport.fromPhoto` accepts a key, never a URL.** The SSRF question
 * for the photo path is closed by construction rather than by a filter: there
 * is no client-supplied string that can become the thing OpenAI fetches, so
 * there is no allowlist to get wrong, no redirect to re-validate and no
 * `dns.lookup` race to lose. The key is matched against a character class and
 * the host comes from our own token.
 *
 * The regex is deliberately narrow — the alphabet UploadThing actually uses
 * plus `-`/`_`, and nothing else — so `../`, a query string, a scheme and a
 * full URL are all rejected before the value is ever interpolated into a
 * path.
 */
export const UPLOADTHING_KEY_RE = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * The v7 UploadThing token is base64-encoded JSON:
 * `{ apiKey, appId, regions }`. Only `appId` is needed to build a public URL,
 * and it is the one part of the token that is not a secret.
 */
interface UploadThingToken {
  readonly appId?: unknown;
}

let cachedAppId: string | undefined;

/**
 * The app id, decoded out of `UPLOADTHING_TOKEN`.
 *
 * Decoded **inside the function and memoized**, never at import: `pnpm build`
 * runs in CI with no environment at all, the same rule `env()`, `db()` and
 * `openaiClient()` already follow.
 *
 * A token that does not decode, or decodes without a usable `appId`, throws
 * here with a message naming the variable. That is deliberately louder than
 * returning a fallback: a wrong app id would produce URLs that 404 at OpenAI,
 * and the import would fail as «фото не читается» — a misleading answer to a
 * misconfigured deployment.
 */
export function uploadThingAppId(): string {
  if (cachedAppId === undefined) {
    cachedAppId = decodeAppId(env().UPLOADTHING_TOKEN);
  }
  return cachedAppId;
}

/** Exported for the tests: decoding is the part with edge cases, not the cache. */
export function decodeAppId(token: string): string {
  let json: string;
  try {
    json = Buffer.from(token, "base64").toString("utf8");
  } catch {
    throw new Error("UPLOADTHING_TOKEN is not valid base64");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("UPLOADTHING_TOKEN does not decode to JSON");
  }

  const appId = (parsed as UploadThingToken | null)?.appId;

  if (typeof appId !== "string" || appId.trim().length === 0) {
    throw new Error("UPLOADTHING_TOKEN carries no appId");
  }

  return appId;
}

/**
 * The public URL of an uploaded file: `https://<appId>.ufs.sh/f/<key>`.
 *
 * Callers must have validated the key against `UPLOADTHING_KEY_RE` first —
 * this asserts it again rather than trusting them, because the whole security
 * property of the photo path is that nothing but a key-shaped string reaches
 * the path segment.
 */
export function uploadThingUrl(fileKey: string): string {
  if (!UPLOADTHING_KEY_RE.test(fileKey)) {
    throw new Error("Not an UploadThing file key");
  }
  return `https://${uploadThingAppId()}.ufs.sh/f/${fileKey}`;
}

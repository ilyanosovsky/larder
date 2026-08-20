/**
 * Reading the server's error code on the client.
 *
 * `TRPCClientError` carries the original code under `data.code` — the shape
 * `errorFormatter` in `src/server/api/trpc.ts` produces. Matched by shape
 * rather than with `instanceof`: the value crosses the tRPC link and a
 * TanStack Query mutation before a component sees it, and a failed
 * `instanceof` here would silently downgrade a known outcome into "unknown
 * error", which is exactly the case the UI needs to tell apart.
 */
export function trpcErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return null;
  }

  const { data } = error;
  if (typeof data !== "object" || data === null || !("code" in data)) {
    return null;
  }

  return typeof data.code === "string" ? data.code : null;
}

/** Whether a failed call was refused as a conflict with existing state. */
export function isConflictError(error: unknown): boolean {
  return trpcErrorCode(error) === "CONFLICT";
}

/**
 * Whether a failed call was refused by a rate limit — the AI endpoints
 * (`src/server/ai/rate-limit.ts`). Worth telling apart from a generic
 * failure: "подожди минуту" is actionable, "не получилось" is not.
 */
export function isRateLimitedError(error: unknown): boolean {
  return trpcErrorCode(error) === "TOO_MANY_REQUESTS";
}

import type { PersistedClient } from "@tanstack/react-query-persist-client";

import { trpcErrorCode } from "@/lib/trpc-errors";

/**
 * When a queued write may be sent again, and when it must not be — the one
 * question the offline queue cannot get wrong in either direction. Pure, so
 * every branch is covered by `delivery.test.ts` without a network.
 */

/**
 * Whether a failure means **the router never saw this call**.
 *
 * `errorFormatter` (`src/server/api/trpc.ts`) puts a code on every error the
 * router itself produces, and `trpcErrorCode` reads it back through the
 * client error. So the presence of a code is the evidence we need: a coded
 * error is the server's *answer* — the procedure ran and refused — while an
 * uncoded one never got an answer at all. That covers a dead fetch (no
 * connection, DNS, TLS), a proxy's 502 HTML, and a captive portal's
 * interception page: none of them reached a procedure, so none of them can
 * have written anything.
 *
 * The distinction matters because it decides between the two ways an offline
 * queue fails a shopper: replaying a call the server already applied (a
 * `cart.add` merge counted twice) or dropping one it never received (a tick
 * that silently never happened, under a banner promising «изменения
 * сохранятся»).
 *
 * The one case this cannot see: a server that applied the write and then died
 * before answering. That looks uncoded and will be sent again — an
 * at-least-once edge inherent to retrying without idempotency keys, and the
 * one the cart's merge semantics can actually show the user (a quantity they
 * can correct), unlike a silent loss.
 */
export function isUndeliveredFailure(error: unknown): boolean {
  return trpcErrorCode(error) === null;
}

/**
 * The `retry` policy every `cart.*` mutation runs under.
 *
 * **Unbounded for undelivered failures, and that is the point.** TanStack's
 * default of `retry: 0` rejects on the first failure without ever
 * re-consulting `onlineManager` — so a *premature* `online` event (a
 * captive-portal Wi-Fi association, where `navigator.onLine` reports a
 * connection that cannot reach anything) resumes the whole queue, every call
 * dies at the network layer, and every mutation settles as an error. An
 * errored mutation is no longer paused, so the next persist writes an
 * envelope without it: the entire queue is erased from IndexedDB, silently,
 * having never reached the server. Retrying instead keeps the call alive
 * across exactly that mistake.
 *
 * A capped count would only move the cliff a minute later — after N failures
 * the mutation errors and is erased just the same — so there is no bound
 * here. The retryer's own backoff (`1s, 2s, 4s … 30s`) makes an unbounded
 * retry cheap, and it is self-limiting in the case that matters: when the
 * device really goes offline, `canContinue()` fails, the retryer **pauses**
 * instead of running, and the mutation is written back to storage as a paused
 * one. Nothing is lost and nothing spins.
 *
 * A server rejection is the opposite case and fails fast: the row a partner
 * already removed, a CONFLICT, a validation error. Sending it again would
 * only produce the same answer.
 */
export function shouldRetryDelivery(
  _failureCount: number,
  error: unknown,
): boolean {
  return isUndeliveredFailure(error);
}

/** The part of a mutation's state the queue's decisions read. */
export interface DeliverableMutationState {
  readonly status: string;
  readonly isPaused: boolean;
  readonly failureCount: number;
  readonly failureReason: unknown;
  readonly submittedAt?: number;
}

/**
 * Whether a mutation is **waiting to be delivered** — the queue's membership
 * test, used both for what gets persisted and for what gets resumed.
 *
 * Two states qualify, and they share one property: the router provably has
 * not seen the call.
 *
 * - **Paused.** With `networkMode: "online"` a mutation dispatched while
 *   offline pauses *before* its `mutationFn` runs, so it never left the
 *   device.
 * - **Retrying after an undelivered failure.** It left the device and came
 *   back unanswered (see `isUndeliveredFailure`), so the write did not
 *   happen. Persisting these is what stops a captive portal from turning the
 *   queue into an erased envelope: while the retries run, the mutation is not
 *   paused, and a paused-only filter would drop it from storage on the very
 *   first failure.
 *
 * A first attempt still in flight (`failureCount === 0`) is deliberately
 * **not** queued: there is no evidence either way about whether it landed,
 * and `cart.add` merges, so guessing wrong turns «2 шт» into «4 шт».
 */
export function isQueuedMutationState(
  state: DeliverableMutationState,
): boolean {
  if (state.isPaused) {
    return true;
  }

  return (
    state.status === "pending" &&
    state.failureCount > 0 &&
    isUndeliveredFailure(state.failureReason)
  );
}

/**
 * A stable name for one queued mutation across a restore.
 *
 * `mutationId` is assigned per cache and is not dehydrated, so it cannot
 * survive a reload. The key plus `submittedAt` can: the key says which
 * procedure, and `submittedAt` is the millisecond the tap was dispatched,
 * written into the persisted state by TanStack itself. Two taps on the same
 * row in the same millisecond would collide; they would also be the same tap
 * as far as last-write-wins is concerned.
 */
export function mutationIdentity(
  mutationKey: unknown,
  submittedAt: unknown,
): string {
  return `${JSON.stringify(mutationKey ?? null)}|${String(submittedAt ?? "")}`;
}

/**
 * The identities a stored envelope still lists as undelivered.
 *
 * Read back at delivery time to answer "has someone else already sent this?"
 * — the case where the PWA and a browser tab are open at once, both restore
 * the same envelope, and both would otherwise deliver every queued write. The
 * one that gets there first rewrites the envelope without them; the other
 * finds them missing here and drops them instead of sending them twice.
 */
export function persistedMutationIdentities(
  client: PersistedClient | undefined,
): ReadonlySet<string> {
  const identities = new Set<string>();

  for (const mutation of client?.clientState.mutations ?? []) {
    identities.add(
      mutationIdentity(mutation.mutationKey, mutation.state.submittedAt),
    );
  }

  return identities;
}

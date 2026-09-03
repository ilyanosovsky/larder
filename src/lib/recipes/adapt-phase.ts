import type { RecipeDraft } from "@/lib/recipes/draft";
import { isConflictError, isRateLimitedError } from "@/lib/trpc-errors";
import type { AdaptationDiff } from "@/server/recipes/adapt";

/**
 * Where S7's adaptation sheet is, and what each outcome does to it (task 4.6).
 *
 * Lifted out of `adaptation-sheet.tsx` for the reason `next-focus-target.ts`
 * and `import-failure.ts` were: vitest runs in `node` with no DOM harness, so
 * a branch left inside a `.tsx` is unreachable from the suite and a flipped
 * one ships green — which is exactly what happened to the rule this module
 * exists to protect. A save failure keeping the reviewed proposal, and a
 * `CONFLICT` being terminal, are the two decisions in this feature that are
 * expensive to get wrong: the first billed a fresh AI call and discarded the
 * draft the household had just approved, the second offered a retry that
 * could only ever fail again.
 *
 * Pure and copy-free: a phase carries a `failure` *reason*, and the component
 * maps that to a dictionary key. Two of the reasons resolve to `dish.*`
 * messages rather than `dishAdapt.*` ones, so the mapping belongs where the
 * translators are.
 */

/** What the household is being told, before it is worded. */
export type AdaptFailure =
  /** The dish moved under the proposal. Terminal — the version is spent. */
  | "conflict"
  /** The per-user AI limiter refused. Worth retrying in a minute. */
  | "rateLimited"
  /** The adaptation call itself failed. Worth retrying. */
  | "unavailable"
  /** Nothing to adapt: the kitchen covers the recipe at its own yield. */
  | "nothingToAdapt"
  /** The **save** failed. The proposal survives; the retry re-sends it. */
  | "saveFailed";

export interface AdaptProposal {
  readonly draft: RecipeDraft;
  readonly summary: string;
  readonly diff: AdaptationDiff;
}

export type AdaptPhase =
  | { readonly kind: "running" }
  | { readonly kind: "proposed"; readonly proposal: AdaptProposal }
  | { readonly kind: "applying"; readonly proposal: AdaptProposal }
  /**
   * The save failed and the reviewed proposal is still on screen. Its own
   * phase rather than a flag on `failed`, because the two differ in every way
   * that matters: what is rendered, what the primary button says, and what
   * pressing it does.
   */
  | {
      readonly kind: "applyFailed";
      readonly proposal: AdaptProposal;
      readonly failure: AdaptFailure;
    }
  | { readonly kind: "failed"; readonly failure: AdaptFailure };

export type AdaptEvent =
  | { readonly type: "proposed"; readonly proposal: AdaptProposal }
  /** The server answered `outcome: "failed"` — an honest refusal, not a throw. */
  | {
      readonly type: "refused";
      readonly reason: "aiUnavailable" | "nothingToAdapt";
    }
  /** The `dish.adapt` call threw. */
  | { readonly type: "adaptThrew"; readonly cause: unknown }
  | { readonly type: "applyStarted"; readonly proposal: AdaptProposal }
  /** The `dish.update` behind «Применить» threw. */
  | {
      readonly type: "applyThrew";
      readonly cause: unknown;
      readonly proposal: AdaptProposal;
    }
  /** «Ещё раз» on a failed *adaptation* — a fresh call, a fresh proposal. */
  | { readonly type: "retryAdapt" };

/**
 * The whole machine. Deliberately total: every event is answered from every
 * phase, so a late `onError` from a mutation the user has already moved past
 * cannot leave the sheet in a shape nothing renders.
 */
export function adaptPhase(phase: AdaptPhase, event: AdaptEvent): AdaptPhase {
  switch (event.type) {
    case "proposed":
      return { kind: "proposed", proposal: event.proposal };

    case "refused":
      return {
        kind: "failed",
        failure:
          event.reason === "nothingToAdapt" ? "nothingToAdapt" : "unavailable",
      };

    case "adaptThrew":
      return { kind: "failed", failure: classifyAdaptFailure(event.cause) };

    case "applyStarted":
      return { kind: "applying", proposal: event.proposal };

    case "applyThrew": {
      const failure = classifyApplyFailure(event.cause);

      // A conflict is the one save failure worth losing the proposal over:
      // the draft was built against a version the server has spent, so it can
      // never land, and keeping «Применить» on screen would promise otherwise.
      return failure === "conflict"
        ? { kind: "failed", failure }
        : { kind: "applyFailed", proposal: event.proposal, failure };
    }

    case "retryAdapt":
      return { kind: "running" };
  }
}

/** A thrown `dish.adapt`. Anything unclassified is «try again». */
export function classifyAdaptFailure(cause: unknown): AdaptFailure {
  if (isConflictError(cause)) {
    return "conflict";
  }
  return isRateLimitedError(cause) ? "rateLimited" : "unavailable";
}

/**
 * A thrown `dish.update`. Distinct from the above precisely so the copy can
 * be: a `BAD_REQUEST`, a 500 or a dropped connection on «Применить» is not
 * the model having a bad day, and telling the household it was would send
 * them off to buy a second adaptation they do not need.
 */
export function classifyApplyFailure(cause: unknown): AdaptFailure {
  if (isConflictError(cause)) {
    return "conflict";
  }
  return isRateLimitedError(cause) ? "rateLimited" : "saveFailed";
}

/** The proposal a phase is showing, if any. */
export function proposalOf(phase: AdaptPhase): AdaptProposal | null {
  return phase.kind === "proposed" ||
    phase.kind === "applying" ||
    phase.kind === "applyFailed"
    ? phase.proposal
    : null;
}

/** The sentence a phase is showing, if any. */
export function failureOf(phase: AdaptPhase): AdaptFailure | null {
  return phase.kind === "failed" || phase.kind === "applyFailed"
    ? phase.failure
    : null;
}

/** A call is in flight: the sheet holds itself open and every control waits. */
export function isBusy(phase: AdaptPhase): boolean {
  return phase.kind === "running" || phase.kind === "applying";
}

/**
 * What the action row's second button does — `null` when there is no second
 * button at all, which is also the signal to rescue focus (the slot unmounts
 * with whatever had it).
 *
 * `"apply"` re-sends **the same approved draft** in the `applyFailed` phase;
 * it never falls back to `"retryAdapt"`, which would bill a fresh call and
 * return a different proposal than the one the household read.
 */
export function primaryActionOf(
  phase: AdaptPhase,
): "apply" | "retryAdapt" | null {
  if (proposalOf(phase) !== null) {
    return "apply";
  }
  return phase.kind === "failed" && isRetryable(phase.failure)
    ? "retryAdapt"
    : null;
}

/** Whether asking again could plausibly answer differently. */
export function isRetryable(failure: AdaptFailure): boolean {
  // A spent version fails identically forever, and «менять нечего» is a fact
  // about the recipe, not about the call.
  return failure !== "conflict" && failure !== "nothingToAdapt";
}

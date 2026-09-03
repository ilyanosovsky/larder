import { describe, expect, it } from "vitest";

import {
  adaptPhase,
  classifyAdaptFailure,
  classifyApplyFailure,
  failureOf,
  isBusy,
  isRetryable,
  primaryActionOf,
  proposalOf,
  type AdaptPhase,
  type AdaptProposal,
} from "@/lib/recipes/adapt-phase";
import { emptyDraft } from "@/lib/recipes/draft";

/** What the tRPC client hands a component for a given server code. */
function trpcError(code: string) {
  return { data: { code } };
}

const PROPOSAL: AdaptProposal = {
  draft: { ...emptyDraft(), title: "NYC Cookies" },
  summary: "вместо миксера — венчиком вручную",
  diff: {
    changedIngredients: [0],
    changedSteps: [0],
    addedSteps: [],
    removedSteps: [],
    droppedEquipment: ["mixer"],
    portionsChanged: true,
    portionsRangeDropped: true,
    yieldUnitDropped: true,
  },
};

const RUNNING: AdaptPhase = { kind: "running" };
const PROPOSED: AdaptPhase = { kind: "proposed", proposal: PROPOSAL };
const APPLYING: AdaptPhase = { kind: "applying", proposal: PROPOSAL };

describe("classifying a failure", () => {
  it("tells a spent version apart from everything else", () => {
    expect(classifyAdaptFailure(trpcError("CONFLICT"))).toBe("conflict");
    expect(classifyApplyFailure(trpcError("CONFLICT"))).toBe("conflict");
  });

  it("tells the limiter apart, because «подожди минуту» is actionable", () => {
    expect(classifyAdaptFailure(trpcError("TOO_MANY_REQUESTS"))).toBe(
      "rateLimited",
    );
    expect(classifyApplyFailure(trpcError("TOO_MANY_REQUESTS"))).toBe(
      "rateLimited",
    );
  });

  it("never blames the model for a failed save", () => {
    // The whole point of two classifiers: a BAD_REQUEST, a 500 or a dropped
    // connection on «Применить» is not the adaptation having a bad day.
    for (const cause of [
      trpcError("BAD_REQUEST"),
      trpcError("INTERNAL_SERVER_ERROR"),
      new Error("Failed to fetch"),
      null,
    ]) {
      expect(classifyApplyFailure(cause)).toBe("saveFailed");
      expect(classifyAdaptFailure(cause)).toBe("unavailable");
    }
  });
});

describe("the machine", () => {
  it("shows a proposal when one arrives", () => {
    const next = adaptPhase(RUNNING, {
      type: "proposed",
      proposal: PROPOSAL,
    });

    expect(next).toEqual(PROPOSED);
    expect(proposalOf(next)).toBe(PROPOSAL);
    expect(isBusy(next)).toBe(false);
  });

  it("keeps the reviewed proposal when the save fails", () => {
    // The regression this module exists for. Before, any non-CONFLICT save
    // failure discarded the approved draft and offered an «Ещё раз» that
    // billed a fresh adaptation returning a different proposal.
    const next = adaptPhase(APPLYING, {
      type: "applyThrew",
      cause: trpcError("INTERNAL_SERVER_ERROR"),
      proposal: PROPOSAL,
    });

    expect(next.kind).toBe("applyFailed");
    expect(proposalOf(next)).toBe(PROPOSAL);
    expect(failureOf(next)).toBe("saveFailed");
    // And the button re-sends *that* draft rather than asking again.
    expect(primaryActionOf(next)).toBe("apply");
  });

  it("drops the proposal when the save conflicts — it can never land", () => {
    const next = adaptPhase(APPLYING, {
      type: "applyThrew",
      cause: trpcError("CONFLICT"),
      proposal: PROPOSAL,
    });

    expect(next).toEqual({ kind: "failed", failure: "conflict" });
    expect(proposalOf(next)).toBeNull();
    expect(primaryActionOf(next)).toBeNull();
  });

  it("makes a conflict on the adaptation terminal too", () => {
    const next = adaptPhase(RUNNING, {
      type: "adaptThrew",
      cause: trpcError("CONFLICT"),
    });

    expect(failureOf(next)).toBe("conflict");
    expect(primaryActionOf(next)).toBeNull();
  });

  it("offers a retry for a failure that could answer differently", () => {
    const next = adaptPhase(RUNNING, {
      type: "adaptThrew",
      cause: new Error("socket hang up"),
    });

    expect(primaryActionOf(next)).toBe("retryAdapt");
    expect(adaptPhase(next, { type: "retryAdapt" })).toEqual(RUNNING);
  });

  it("has nothing to retry about «менять нечего»", () => {
    const next = adaptPhase(RUNNING, {
      type: "refused",
      reason: "nothingToAdapt",
    });

    expect(next).toEqual({ kind: "failed", failure: "nothingToAdapt" });
    expect(primaryActionOf(next)).toBeNull();
    expect(isRetryable("nothingToAdapt")).toBe(false);
  });

  it("reports an honest server refusal as a retryable failure", () => {
    const next = adaptPhase(RUNNING, {
      type: "refused",
      reason: "aiUnavailable",
    });

    expect(failureOf(next)).toBe("unavailable");
    expect(primaryActionOf(next)).toBe("retryAdapt");
  });

  it("is busy exactly while a call is in flight", () => {
    expect(isBusy(RUNNING)).toBe(true);
    expect(isBusy(APPLYING)).toBe(true);
    expect(isBusy(PROPOSED)).toBe(false);
    expect(
      isBusy(adaptPhase(APPLYING, {
        type: "applyThrew",
        cause: new Error("nope"),
        proposal: PROPOSAL,
      })),
    ).toBe(false);
  });

  it("answers every event from every phase", () => {
    // Totality is what stops a late `onError` from a mutation the user has
    // already moved past leaving the sheet in a shape nothing renders.
    const phases: AdaptPhase[] = [
      RUNNING,
      PROPOSED,
      APPLYING,
      { kind: "applyFailed", proposal: PROPOSAL, failure: "saveFailed" },
      { kind: "failed", failure: "conflict" },
    ];
    const events: Parameters<typeof adaptPhase>[1][] = [
      { type: "proposed", proposal: PROPOSAL },
      { type: "refused", reason: "aiUnavailable" },
      { type: "adaptThrew", cause: new Error("x") },
      { type: "applyStarted", proposal: PROPOSAL },
      { type: "applyThrew", cause: new Error("x"), proposal: PROPOSAL },
      { type: "retryAdapt" },
    ];

    for (const phase of phases) {
      for (const event of events) {
        const next = adaptPhase(phase, event);
        expect(next.kind).toBeTypeOf("string");
        // A phase either shows a proposal or shows a failure, never neither
        // while idle.
        if (!isBusy(next)) {
          expect(
            proposalOf(next) !== null || failureOf(next) !== null,
          ).toBe(true);
        }
      }
    }
  });
});

"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type RefObject } from "react";

import { AiProgress } from "@/components/ai-progress";
import { BottomSheet } from "@/components/bottom-sheet";
import type { RecipeDraft } from "@/lib/recipes/draft";
import { formatRecipeQty } from "@/lib/recipes/rescale";
import { timerDisplay, timerMessage } from "@/lib/recipes/timer";
import { useIsOnline } from "@/lib/sync/use-is-online";
import { isConflictError, isRateLimitedError } from "@/lib/trpc-errors";
import type { DishDetailOutput } from "@/server/api/routers/dish";
import type { EquipmentSlug } from "@/server/kitchen/equipment";
import { useTRPC } from "@/trpc/client";

import styles from "./adaptation-sheet.module.css";

/**
 * S7's «Адаптировать (ИИ)» sheet (DESIGN_BRIEF S7 and §3's MergePreview
 * grammar, task 4.6) — the proposal a household reads before anything is
 * written.
 *
 * **A proposal, and the UI is where that promise is kept.** `dish.adapt`
 * writes nothing but its own `ai_jobs` rows; this sheet shows what the recipe
 * *would* become, and «Применить» is an ordinary `dish.update` carrying the
 * proposed draft and the version the card was opened at. So an adaptation can
 * never bypass draft validation, product ownership or the version guard — and
 * a household that does not like the answer simply closes the sheet.
 *
 * **One mount per request.** The screen renders this component only while a
 * request is open and keys it on the request's own sequence number, so the
 * mutation fires once in a mount effect, every piece of state resets on
 * close, and there is no "did this already run for this open?" bookkeeping to
 * get wrong. `startedRef` is still there for React's development-mode double
 * effect invocation, which would otherwise cost a second billed call.
 *
 * **The version is frozen at mount**, deliberately (blueprint decision D.1):
 * a background `dish.get` refetch that lands between the proposal and
 * «Применить» must not silently retarget the save at a recipe the proposal
 * was not built on. It becomes a `CONFLICT` instead, which is a thing the
 * sheet can say out loud.
 *
 * **Every failure renders inside the sheet's own `aria-modal` subtree.** A
 * page-level toast would be behind the scrim and pruned from the
 * accessibility tree — the rule `cart-screen.tsx` and `revision-mode.tsx`
 * already follow.
 */
export function AdaptationSheet({
  dishId,
  detail,
  beforeEquipment,
  targetPortions,
  equipmentLabels,
  restoreFocusTo,
  onClose,
  onConflict,
  onApplied,
}: {
  dishId: string;
  /** The dish as the card is showing it — the «было» half of every row. */
  detail: DishDetailOutput;
  /** `recipe.equipment` coerced to slugs, exactly as the banner reads it. */
  beforeEquipment: readonly EquipmentSlug[];
  /** The slider's own count when it differs from the recipe's base, else `null`. */
  targetPortions: number | null;
  /** S12's checklist labels, so the banner and this sheet never disagree. */
  equipmentLabels: Readonly<Record<EquipmentSlug, string>>;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** A stale version means the card behind the scrim is stale too. */
  onConflict: () => void;
  /** The saved aggregate + the line to announce; the screen owns the cache. */
  onApplied: (dish: DishDetailOutput, message: string) => void;
}) {
  const t = useTranslations("dishAdapt");
  const dish = useTranslations("dish");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const online = useIsOnline();

  /** Frozen at mount — see the doc comment. */
  const [expectedVersion] = useState(() => detail.version);
  /**
   * The sheet's own phase, rather than `adapt.isPending` / `apply.isPending`.
   *
   * Not a style choice: in the first real run the progress block stayed on
   * screen underneath a finished proposal, because a `setState` from inside
   * `onSuccess` renders while the mutation's own status has not flipped yet —
   * and whether it flips back in a later render is TanStack's business, not
   * something this sheet should be reading tea leaves about. One state
   * variable the component sets itself has exactly one answer at any moment,
   * and every branch below reads it.
   */
  const [phase, setPhase] = useState<Phase>({ kind: "running" });

  /** Synchronous mutex: render state lands a re-render too late for a double tap. */
  const pendingRef = useRef(false);
  const startedRef = useRef(false);

  /**
   * One place decides both the sentence and whether «Ещё раз» is worth
   * offering.
   */
  function report(cause: unknown) {
    if (isConflictError(cause)) {
      onConflict();
      setPhase({ kind: "failed", text: dish("conflict"), retryable: false });
      return;
    }
    setPhase({
      kind: "failed",
      text: isRateLimitedError(cause) ? t("rateLimited") : t("failed"),
      retryable: true,
    });
  }

  const adapt = useMutation(
    trpc.dish.adapt.mutationOptions({
      // Dish writes are never queued offline (`src/lib/sync` persists `cart.*`
      // only), so with the default `"online"` mode this would pause before its
      // `mutationFn` ever ran and the sheet would spin forever.
      networkMode: "always",
      onSuccess: (result) => {
        setPhase(
          result.outcome === "proposed"
            ? {
                kind: "proposed",
                proposal: {
                  draft: result.draft,
                  summary: result.summary,
                  diff: result.diff,
                },
              }
            : {
                kind: "failed",
                text:
                  result.reason === "nothingToAdapt"
                    ? t("nothingToAdapt")
                    : t("failed"),
                retryable: result.reason !== "nothingToAdapt",
              },
        );
      },
      onError: report,
      onSettled: () => {
        pendingRef.current = false;
      },
    }),
  );

  const apply = useMutation(
    trpc.dish.update.mutationOptions({
      networkMode: "always",
      onSuccess: (result) => {
        onApplied(result.dish, t("applied"));
      },
      onError: report,
      onSettled: () => {
        pendingRef.current = false;
      },
    }),
  );

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    pendingRef.current = true;
    adapt.mutate({ dishId, expectedVersion, targetPortions });
    // Mount-only: the screen remounts this component per request (`key`), so
    // "run once per open" and "run once per mount" are the same statement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function retry() {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setPhase({ kind: "running" });
    adapt.mutate({ dishId, expectedVersion, targetPortions });
  }

  function applyProposal(accepted: Proposal) {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setPhase({ kind: "applying", proposal: accepted });
    apply.mutate({
      id: dishId,
      expectedVersion,
      draft: accepted.draft,
      // The summary the household just read and approved. Empty only if the
      // model said nothing; the dictionary carries the fallback rather than
      // the server inventing Russian copy.
      adaptation: { note: accepted.summary.trim() || t("defaultNote") },
    });
  }

  const busy = phase.kind === "running" || phase.kind === "applying";
  const proposal =
    phase.kind === "proposed" || phase.kind === "applying"
      ? phase.proposal
      : null;

  return (
    <BottomSheet
      open
      onClose={busy ? () => undefined : onClose}
      title={t("title")}
      closeLabel={common("close")}
      restoreFocusTo={restoreFocusTo}
    >
      <div className={styles.sheet}>
        {phase.kind === "running" ? (
          <AiProgress label={t("running")} hint={t("runningHint")} />
        ) : null}

        {proposal === null ? null : (
          <ProposalView
            before={detail}
            beforeEquipment={beforeEquipment}
            proposal={proposal}
            equipmentLabels={equipmentLabels}
          />
        )}

        {phase.kind === "failed" ? (
          // Inside the `aria-modal` subtree, always — a page-level region is
          // behind the scrim and pruned from the accessibility tree.
          <p className={styles.error} role="alert">
            {phase.text}
          </p>
        ) : null}

        {online || busy ? null : <p className={styles.offline}>{t("offline")}</p>}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.cancel}
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : onClose}
          >
            {proposal === null ? common("cancel") : t("cancel")}
          </button>

          {proposal === null ? (
            phase.kind === "failed" && phase.retryable ? (
              <button type="button" className={styles.primary} onClick={retry}>
                {t("retry")}
              </button>
            ) : null
          ) : (
            <button
              type="button"
              className={styles.primary}
              aria-disabled={phase.kind === "applying" || undefined}
              onClick={() => applyProposal(proposal)}
            >
              {phase.kind === "applying" ? t("applying") : t("apply")}
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  );
}

/**
 * «Вернуть как было» — the confirmation, and the two calls behind it.
 *
 * The original draft is fetched **here**, on confirmation, rather than ridden
 * along on every `dish.get`: it is a whole second recipe of JSON for a button
 * most people never press (see `dish.originalDraft`). The revert itself is
 * the same `dish.update` «Применить» uses, with `adaptation: null` clearing
 * the stamps — so a restore is an ordinary, version-guarded save and not a
 * second write path with its own rules.
 */
export function RevertSheet({
  dishId,
  detail,
  restoreFocusTo,
  onClose,
  onConflict,
  onApplied,
}: {
  dishId: string;
  detail: DishDetailOutput;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  onConflict: () => void;
  onApplied: (dish: DishDetailOutput, message: string) => void;
}) {
  const t = useTranslations("dishAdapt");
  const dish = useTranslations("dish");
  const common = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const online = useIsOnline();

  const [expectedVersion] = useState(() => detail.version);
  const [error, setError] = useState<string | null>(null);
  /** True from the tap until both the fetch and the save have settled. */
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  /** Same split as the proposal sheet's — see `AdaptationSheet.report`. */
  function report(cause: unknown) {
    if (isConflictError(cause)) {
      onConflict();
      setError(dish("conflict"));
      return;
    }
    setError(isRateLimitedError(cause) ? t("rateLimited") : t("failed"));
  }

  const revert = useMutation(
    trpc.dish.update.mutationOptions({
      networkMode: "always",
      onSuccess: (result) => {
        onApplied(result.dish, t("reverted"));
      },
      onError: report,
      onSettled: () => {
        pendingRef.current = false;
        // `busy` is this component's own flag, not `revert.isPending`, for the
        // same reason the proposal sheet keeps a `phase` — and because half of
        // this flow is a query, which has no mutation status at all.
        setBusy(false);
      },
    }),
  );

  /** «Отмена», not «Вернуть»: a stray Enter must not undo an adaptation. */
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  async function confirm() {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setBusy(true);
    setError(null);

    let original: RecipeDraft | null;
    try {
      original = await queryClient.fetchQuery(
        // `networkMode: "always"` for the same reason the mutations declare
        // it: a query left on the default `"online"` mode simply never
        // settles while the browser thinks it is offline, and this one is
        // awaited inside a confirmation the user is watching.
        trpc.dish.originalDraft.queryOptions(
          { id: dishId },
          { networkMode: "always", retry: false, staleTime: 0 },
        ),
      );
    } catch (cause) {
      pendingRef.current = false;
      setBusy(false);
      report(cause);
      return;
    }

    if (original === null) {
      pendingRef.current = false;
      setBusy(false);
      setError(t("revertMissing"));
      return;
    }

    // Not awaited: `onSettled` releases the mutex, and awaiting a mutation
    // that may never settle is the bug class this repo already documents.
    revert.mutate({
      id: dishId,
      expectedVersion,
      draft: original,
      // Clears `adapted_at` / `adapted_note`: the recipe on screen is once
      // again the one that was imported.
      adaptation: null,
    });
  }

  return (
    <BottomSheet
      open
      onClose={busy ? () => undefined : onClose}
      title={t("revertTitle")}
      closeLabel={common("close")}
      restoreFocusTo={restoreFocusTo}
    >
      <div className={styles.sheet}>
        <p className={styles.hint}>{t("revertHint")}</p>

        {error === null ? null : (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        {online || busy ? null : <p className={styles.offline}>{t("offline")}</p>}

        <div className={styles.actions}>
          <button
            type="button"
            ref={cancelRef}
            className={styles.cancel}
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : onClose}
          >
            {common("cancel")}
          </button>
          <button
            type="button"
            className={styles.primary}
            aria-disabled={busy || undefined}
            onClick={() => void confirm()}
          >
            {busy ? t("reverting") : t("revertConfirm")}
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

/**
 * Where the sheet is, as one value.
 *
 * `retryable` rides along with the failure because the two are decided
 * together: retrying a `CONFLICT` re-sends the same frozen version and fails
 * identically, and there is nothing to retry about «менять нечего».
 */
type Phase =
  | { kind: "running" }
  | { kind: "proposed"; proposal: Proposal }
  | { kind: "applying"; proposal: Proposal }
  | { kind: "failed"; text: string; retryable: boolean };

interface Proposal {
  draft: RecipeDraft;
  summary: string;
  diff: {
    changedIngredients: number[];
    changedSteps: number[];
    addedSteps: number[];
    removedSteps: number[];
  };
}

/**
 * The diff itself, in the MergePreview grammar: a summary line, then only the
 * rows that moved — «было → стало» on one line apiece.
 *
 * Nothing here is a live region: it appears as a whole new subtree inside a
 * dialog that has just claimed focus, so it is announced on insertion, and a
 * row-by-row announcement of twenty quantities would be unusable.
 */
function ProposalView({
  before,
  beforeEquipment,
  proposal,
  equipmentLabels,
}: {
  before: DishDetailOutput;
  beforeEquipment: readonly EquipmentSlug[];
  proposal: Proposal;
  equipmentLabels: Readonly<Record<EquipmentSlug, string>>;
}) {
  const t = useTranslations("dishAdapt");
  const dish = useTranslations("dish");
  const { draft, diff } = proposal;

  const portionsChanged = draft.portionsBase !== before.recipe.portionsBase;
  const droppedEquipment = beforeEquipment.filter(
    (slug) => !draft.equipment.includes(slug),
  );
  const nothing =
    diff.changedIngredients.length === 0 &&
    diff.changedSteps.length === 0 &&
    diff.addedSteps.length === 0 &&
    diff.removedSteps.length === 0;

  return (
    <div className={styles.proposal}>
      <p className={styles.summary}>{proposal.summary}</p>

      {nothing ? <p className={styles.hint}>{t("noChanges")}</p> : null}

      {portionsChanged ? (
        <p className={styles.meta}>
          {t("portionsChange", {
            from: before.recipe.portionsBase,
            to: draft.portionsBase,
          })}
        </p>
      ) : null}

      {droppedEquipment.length === 0 ? null : (
        <p className={styles.meta}>
          {t("equipmentDropped", {
            list: droppedEquipment.map((slug) => equipmentLabels[slug]).join(", "),
          })}
        </p>
      )}

      {diff.changedIngredients.length === 0 ? null : (
        <section className={styles.block}>
          <h3 className={styles.blockTitle}>{t("ingredientsTitle")}</h3>
          <ul className={styles.rows}>
            {diff.changedIngredients.map((index) => {
              const row = draft.ingredients[index];
              const original = before.ingredients[index];
              if (row === undefined) {
                return null;
              }

              // Every listed row shows what actually moved, and nothing else:
              // an unchanged amount would render «180 г → 180 г» beside a row
              // whose only real change was its note, which reads as noise and
              // trains people to skim the diff.
              const amountChanged =
                row.qty !== (original?.qty ?? null) ||
                row.unit !== (original?.unit ?? null);
              const noteChanged = row.note !== (original?.note ?? null);
              const sourceChanged = row.rawText !== (original?.rawText ?? "");

              return (
                <li key={index} className={styles.row}>
                  <span className={styles.rowName}>{row.name}</span>
                  <span className={styles.rowChange}>
                    {amountChanged ? (
                      <>
                        <span className={styles.was}>
                          {formatRecipeQty(
                            original?.qty ?? null,
                            original?.unit ?? null,
                          )}
                        </span>
                        <span aria-hidden="true"> → </span>
                      </>
                    ) : null}
                    <span className={styles.now}>
                      {formatRecipeQty(row.qty, row.unit)}
                    </span>
                  </span>
                  {noteChanged ? (
                    // `—` when the adaptation dropped a qualifier: a row that
                    // silently lost «холодное» would look unchanged.
                    <span className={styles.rowNote}>{row.note ?? "—"}</span>
                  ) : null}
                  {sourceChanged ? (
                    <span className={styles.rowSource}>{row.rawText}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {diff.changedSteps.length === 0 &&
      diff.addedSteps.length === 0 &&
      diff.removedSteps.length === 0 ? null : (
        <section className={styles.block}>
          <h3 className={styles.blockTitle}>{t("stepsTitle")}</h3>
          <ul className={styles.rows}>
            {diff.removedSteps.map((index) => (
              <li key={`removed-${index}`} className={styles.stepRemoved}>
                <span className={styles.marker} aria-hidden="true">
                  −
                </span>
                <span>{before.steps[index]?.text ?? ""}</span>
              </li>
            ))}
            {[...diff.changedSteps, ...diff.addedSteps]
              .sort((a, b) => a - b)
              .map((index) => {
                const step = draft.steps[index];
                if (step === undefined) {
                  return null;
                }
                const added = diff.addedSteps.includes(index);
                const timer = timerDisplay(step.timerSec, step.timerMaxSec);

                return (
                  <li key={`next-${index}`} className={styles.step}>
                    <span className={styles.marker} aria-hidden="true">
                      {added ? "+" : "→"}
                    </span>
                    <span>
                      {step.text}
                      {timer === null ? null : (
                        <span className={styles.timer}>
                          {" "}
                          {dish(timerMessage(timer).key, timerMessage(timer).values)}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
          </ul>
        </section>
      )}

      <p className={styles.disclaimer}>{t("disclaimer")}</p>
    </div>
  );
}


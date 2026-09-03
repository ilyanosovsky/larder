"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type RefObject } from "react";

import { AiProgress } from "@/components/ai-progress";
import { BottomSheet } from "@/components/bottom-sheet";
import {
  adaptPhase,
  classifyApplyFailure,
  failureOf,
  isBusy,
  primaryActionOf,
  proposalOf,
  type AdaptFailure,
  type AdaptPhase,
  type AdaptProposal,
} from "@/lib/recipes/adapt-phase";
import type { RecipeDraft } from "@/lib/recipes/draft";
import { formatRecipeQty } from "@/lib/recipes/rescale";
import { timerDisplay, timerMessage } from "@/lib/recipes/timer";
import { useIsOnline } from "@/lib/sync/use-is-online";
import type { DishDetailOutput } from "@/server/api/routers/dish";
import type { EquipmentSlug } from "@/server/kitchen/equipment";
// Pure, database-free server helpers, imported into a client component the
// same way `equipment-banner.tsx` imports `missingEquipment` — the alternative
// is a second copy of the predicate that drifts from the one under test.
import { isEmptyDiff } from "@/server/recipes/adapt";
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

  /**
   * Frozen at mount — see the doc comment — and **the whole aggregate with
   * it**, not just the number.
   *
   * `diff`'s four index arrays are positions in the snapshot the server read
   * under this exact version. Resolving them through a live `detail` means a
   * partner's edit landing on a background `dish.get` refetch (default
   * `refetchOnWindowFocus`, 30 s `staleTime`, inside a window the AI call can
   * easily fill) would render a proposal-draft ingredient name beside a «было»
   * amount belonging to a different ingredient. The write is already safe —
   * the frozen version turns it into a `CONFLICT` — but the diff on screen has
   * to describe the version it was computed for, or «Применить» is approving
   * something other than what was read.
   */
  const [expectedVersion] = useState(() => detail.version);
  const [snapshot] = useState(() => detail);
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
  const [phase, setPhase] = useState<AdaptPhase>({ kind: "running" });

  /** Synchronous mutex: render state lands a re-render too late for a double tap. */
  const pendingRef = useRef(false);
  const startedRef = useRef(false);
  /** The proposal a save is in flight for, so a failure can hand it back. */
  const applyingRef = useRef<AdaptProposal | null>(null);
  /** The summary paragraph, focused when the proposal lands (see the effect). */
  const summaryRef = useRef<HTMLParagraphElement>(null);
  /** «Отмена» — where focus is rescued when the primary slot unmounts. */
  const cancelRef = useRef<HTMLButtonElement>(null);

  /**
   * Every transition goes through the pure machine in
   * `src/lib/recipes/adapt-phase.ts`, so the rules that matter — a save
   * failure keeps the proposal, a conflict is terminal — are pinned by tests
   * this node-environment suite can actually run. All this component adds is
   * the one side effect a reducer must not have: refreshing the card behind
   * the scrim when the version it was built on turns out to be spent.
   */
  function dispatch(event: Parameters<typeof adaptPhase>[1]) {
    setPhase((current) => {
      const next = adaptPhase(current, event);
      if (failureOf(next) === "conflict") {
        onConflict();
      }
      return next;
    });
  }

  const adapt = useMutation(
    trpc.dish.adapt.mutationOptions({
      // Dish writes are never queued offline (`src/lib/sync` persists `cart.*`
      // only), so with the default `"online"` mode this would pause before its
      // `mutationFn` ever ran and the sheet would spin forever.
      networkMode: "always",
      onSuccess: (result) => {
        if (result.outcome === "proposed") {
          dispatch({
            type: "proposed",
            proposal: {
              draft: result.draft,
              // Normalized once, here, where the proposal enters the sheet:
              // `summary` is an unbounded `z.string()` the strict schema
              // cannot require content from, and an empty one would leave the
              // focus target with nothing to announce *and* disagree with the
              // note «Применить» stores.
              summary: result.summary.trim() || t("defaultNote"),
              diff: result.diff,
            },
          });
          return;
        }
        dispatch({ type: "refused", reason: result.reason });
      },
      onError: (cause) => dispatch({ type: "adaptThrew", cause }),
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
      onError: (cause) => {
        const accepted = applyingRef.current;
        // `applyingRef` is set synchronously by `applyProposal` and is the
        // only thing that survives the failure — `phase` is `applying` at this
        // point, but reading it here would close over a stale render.
        if (accepted === null) {
          dispatch({ type: "adaptThrew", cause });
          return;
        }
        dispatch({ type: "applyThrew", cause, proposal: accepted });
      },
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

  const busy = isBusy(phase);
  const proposal = proposalOf(phase);
  const failure = failureOf(phase);
  /**
   * Which dictionary key a failure resolves to. `conflict` is the screen's
   * own copy, so the sheet and the card word the same event the same way.
   */
  const failureText =
    failure === null
      ? null
      : failure === "conflict"
        ? dish("conflict")
        : t(FAILURE_KEY[failure]);
  /**
   * Whether the action row has a second button at all. Both transitions that
   * remove it — «Ещё раз» (`failed` → `running`) and a `CONFLICT` on apply
   * (`applying` → terminal `failed`) — can unmount the element holding focus,
   * and `BottomSheet`'s own focus effect is keyed on `open`, which does not
   * change while the sheet is up.
   */
  const primary = primaryActionOf(phase);
  const hasPrimary = primary !== null;

  /**
   * Moves focus to the summary when the proposal lands (A5).
   *
   * The `running` → `proposed` transition unmounts the sheet's only live
   * region (`AiProgress`'s `role="status"`) and inserts the diff with nothing
   * to announce it, so after a 6–15 s wait a screen-reader user gets silence
   * and a «Применить» button that appeared without a word. Moving focus both
   * announces the summary and lands the reader at the top of the diff, one
   * step ahead of the button — the same rescue shape `import-screen.tsx`
   * uses, and cheaper than a second live region that would need its own copy.
   */
  useEffect(() => {
    if (phase.kind === "proposed") {
      summaryRef.current?.focus();
    }
  }, [phase.kind]);

  /**
   * Rescues focus when the primary slot disappears (A10). Guarded on
   * `activeElement` exactly like `dish-screen.tsx`'s own rescue, so it is a
   * rescue and never a steal — and a no-op on the initial mount, where
   * `BottomSheet` has already focused the panel.
   */
  useEffect(() => {
    if (hasPrimary) {
      return;
    }
    const active = document.activeElement;
    if (active === null || active === document.body) {
      cancelRef.current?.focus();
    }
  }, [hasPrimary]);

  function retry() {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    applyingRef.current = null;
    dispatch({ type: "retryAdapt" });
    adapt.mutate({ dishId, expectedVersion, targetPortions });
  }

  function applyProposal(accepted: AdaptProposal) {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    applyingRef.current = accepted;
    dispatch({ type: "applyStarted", proposal: accepted });
    apply.mutate({
      id: dishId,
      expectedVersion,
      draft: accepted.draft,
      // Already non-empty by construction (see `onSuccess`); the fallback
      // stays as a backstop, and `dishAdaptationStamp`'s own `.min(1)` is the
      // server-side one — an empty `adapted_note` can never be persisted.
      adaptation: { note: accepted.summary.trim() || t("defaultNote") },
    });
  }

  return (
    <BottomSheet
      open
      onClose={busy ? () => undefined : onClose}
      // Esc, the scrim and ✕ are all one handler, and it is a no-op while a
      // call is in flight — so the ✕ has to *say* so rather than look
      // ordinary and do nothing (never `disabled`: that drops focus).
      closeDisabled={busy}
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
            before={snapshot}
            proposal={proposal}
            equipmentLabels={equipmentLabels}
            summaryRef={summaryRef}
          />
        )}

        {failureText === null ? null : (
          // Inside the `aria-modal` subtree, always — a page-level region is
          // behind the scrim and pruned from the accessibility tree.
          <p className={styles.error} role="alert">
            {failureText}
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
            {proposal === null ? common("cancel") : t("cancel")}
          </button>

          {primary === "retryAdapt" ? (
            <button type="button" className={styles.primary} onClick={retry}>
              {t("retry")}
            </button>
          ) : proposal === null ? null : (
            // One button for three phases: it re-sends the **same approved
            // draft** after a save failure, and never falls back to a fresh
            // billed adaptation that would return a different proposal.
            <button
              type="button"
              className={styles.primary}
              aria-disabled={phase.kind === "applying" || undefined}
              onClick={() => applyProposal(proposal)}
            >
              {phase.kind === "applying"
                ? t("applying")
                : phase.kind === "applyFailed"
                  ? t("retry")
                  : t("apply")}
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
  /**
   * A `CONFLICT` is terminal here, exactly as it is in `AdaptationSheet`.
   *
   * `expectedVersion` is frozen at mount and the screen renders this sheet
   * without a `key`, so a second «Вернуть» would re-send the same spent token
   * and fail identically — forever. The confirm button is withdrawn instead,
   * leaving «Отмена» as the only action; the card behind the scrim has
   * already been refreshed by `onConflict`.
   */
  const [conflicted, setConflicted] = useState(false);
  const pendingRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  /** The same classifier the proposal sheet's machine uses — one rule for
   *  «the version is spent», in one tested place. */
  function report(cause: unknown) {
    const failure = classifyApplyFailure(cause);

    if (failure === "conflict") {
      onConflict();
      setConflicted(true);
      setError(dish("conflict"));
      return;
    }
    // A revert is a save, but «Не удалось сохранить» would be odd copy under
    // «Вернуть исходный рецепт» — this sheet has one generic failure line.
    setError(failure === "rateLimited" ? t("rateLimited") : t("failed"));
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

  /**
   * The confirm button is withdrawn on a conflict, and it may well be holding
   * focus when that happens. Same `activeElement` guard as everywhere else, so
   * it rescues and never steals.
   */
  useEffect(() => {
    if (!conflicted) {
      return;
    }
    const active = document.activeElement;
    if (active === null || active === document.body) {
      cancelRef.current?.focus();
    }
  }, [conflicted]);

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
      closeDisabled={busy}
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
          {conflicted ? null : (
            <button
              type="button"
              className={styles.primary}
              aria-disabled={busy || undefined}
              onClick={() => void confirm()}
            >
              {busy ? t("reverting") : t("revertConfirm")}
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  );
}

/**
 * Failure reason → dictionary key, spelled out rather than derived from the
 * value. `conflict` is deliberately absent: it resolves to the *screen's*
 * `dish.conflict`, in another namespace, and is handled at the call site.
 */
const FAILURE_KEY = {
  rateLimited: "rateLimited",
  unavailable: "failed",
  nothingToAdapt: "nothingToAdapt",
  saveFailed: "applyFailed",
} as const satisfies Partial<Record<AdaptFailure, string>>;


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
  proposal,
  equipmentLabels,
  summaryRef,
}: {
  /** The dish as it stood when the proposal was computed — frozen upstream. */
  before: DishDetailOutput;
  proposal: AdaptProposal;
  equipmentLabels: Readonly<Record<EquipmentSlug, string>>;
  summaryRef: RefObject<HTMLParagraphElement | null>;
}) {
  const t = useTranslations("dishAdapt");
  const dish = useTranslations("dish");
  const { draft, diff } = proposal;

  // Read off the diff rather than recomputed here: the equipment removal is a
  // persisted change like any other, and `isEmptyDiff` counts it — so «менять
  // ничего не пришлось» can never sit above «Больше не нужно: Миксер».
  const droppedEquipment = diff.droppedEquipment;
  const nothing = isEmptyDiff(diff);

  return (
    <div className={styles.proposal}>
      {/* `tabIndex={-1}` + the focus effect upstream: the arrival of the
          proposal has to be announced somehow, and the sheet's only live
          region (AiProgress) is unmounted by the same transition. */}
      <p className={styles.summary} ref={summaryRef} tabIndex={-1}>
        {proposal.summary}
      </p>

      {nothing ? <p className={styles.hint}>{t("noChanges")}</p> : null}

      {diff.portionsChanged ? (
        <p className={styles.meta}>
          {t("portionsChange", {
            from: before.recipe.portionsBase,
            to: draft.portionsBase,
          })}
        </p>
      ) : null}

      {/* Both of these disappear with a rescale and are worth saying out
          loud: for a dish that was never imported there is no
          `original_draft` to get them back from. */}
      {diff.portionsRangeDropped && before.recipe.portionsMin !== null ? (
        <p className={styles.meta}>
          {t("portionsRangeDropped", {
            from: before.recipe.portionsMin,
            to: before.recipe.portionsBase,
          })}
        </p>
      ) : null}

      {diff.yieldUnitDropped && before.recipe.yieldUnit !== null ? (
        <p className={styles.meta}>
          {t("yieldUnitDropped", { unit: before.recipe.yieldUnit })}
        </p>
      ) : null}

      {droppedEquipment.length === 0 ? null : (
        <p className={styles.meta}>
          {t("equipmentDropped", {
            list: droppedEquipment
              .map((slug) => equipmentLabels[slug])
              .join(", "),
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
                        {/* The `→` is decorative, so the two amounts need
                            words of their own — otherwise the row reads as
                            «Мука 285 г 142½ г» and the direction is lost. */}
                        <span className={styles.srOnly}>{t("wasLabel")} </span>
                        <span className={styles.was}>
                          {formatRecipeQty(
                            original?.qty ?? null,
                            original?.unit ?? null,
                          )}
                        </span>
                        <span aria-hidden="true"> → </span>
                        <span className={styles.srOnly}>{t("nowLabel")} </span>
                      </>
                    ) : null}
                    <span className={styles.now}>
                      {formatRecipeQty(row.qty, row.unit)}
                    </span>
                  </span>
                  {noteChanged ? (
                    <span className={styles.rowNote}>
                      <span className={styles.srOnly}>{t("noteLabel")} </span>
                      {row.note === null ? (
                        // A dropped qualifier renders as a bare «—», which
                        // most screen readers skip at default punctuation
                        // settings — so the removal gets a word of its own and
                        // the glyph stays for sighted readers.
                        <>
                          <span aria-hidden="true">—</span>
                          <span className={styles.srOnly}>
                            {t("noteRemoved")}
                          </span>
                        </>
                      ) : (
                        row.note
                      )}
                    </span>
                  ) : null}
                  {sourceChanged ? (
                    <span className={styles.rowSource}>
                      <span className={styles.srOnly}>{t("sourceLabel")} </span>
                      {row.rawText}
                    </span>
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
            {/* Removed, changed and added steps are siblings under one
                heading, and the `−`/`→`/`+` markers are aria-hidden glyphs
                over a colour difference — so each row carries its own
                visually-hidden verb. Approving a proposal is unrecoverable
                for a dish that was never imported, which is precisely when a
                reader must not have to guess which group a step is in. */}
            {diff.removedSteps.map((index) => (
              <li key={`removed-${index}`} className={styles.stepRemoved}>
                <span className={styles.marker} aria-hidden="true">
                  −
                </span>
                <span>
                  <span className={styles.srOnly}>{t("removedLabel")} </span>
                  {before.steps[index]?.text ?? ""}
                </span>
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
                      <span className={styles.srOnly}>
                        {added ? t("addedLabel") : t("changedLabel")}{" "}
                      </span>
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


"use client";

import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { CookTimer } from "@/components/cook-timer";
import { useWakeLock } from "@/components/use-wake-lock";
import { cx } from "@/lib/cx";
import { COOK_TIMER_FINISH_SOUND_DATA_URI } from "@/lib/cooking/finish-sound";
import { decideStepSwipe } from "@/lib/cooking/step-swipe";
import {
  needsExitConfirmation,
  restoreCookingState,
  stepNavigation,
  type CookingState,
  type StepNavAction,
} from "@/lib/cooking/steps";
import { ingredientsForMessage } from "@/lib/recipes/portions";
import { formatRecipeQty } from "@/lib/recipes/rescale";
import {
  formatTimerClock,
  startTimer,
  timerDisplay,
  timerRemainingMs,
  timerState,
  type TimerRunState,
} from "@/lib/recipes/timer";
import type {
  DishDetailOutput,
  DishIngredientOutput,
} from "@/server/api/routers/dish";
import { isUnquantifiable } from "@/server/recipes/needs-review";

import styles from "./cooking-overlay.module.css";

/** Same set `bottom-sheet.tsx`/`revision-mode.tsx` trap Tab within, copied rather than imported — see `revision-mode.tsx`'s own doc comment on why this is not shared. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** How far back (ms) release velocity looks — same window `revision-mode.tsx` uses, for the same reason (a drag that holds still and then flings at the end must still read as fast). */
const VELOCITY_WINDOW_MS = 100;
const SPRING_BACK_DURATION_MS = 200;
/** The overlay's single tick — see `CookingSession`'s own doc comment on why this lives here and not inside `cook-timer.tsx`. */
const TICK_MS = 250;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** One recorded pointermove sample, trimmed to `VELOCITY_WINDOW_MS` on every move. */
interface DragSample {
  readonly x: number;
  readonly t: number;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly recent: readonly DragSample[];
}

/**
 * S9 «Режим готовки» (DESIGN_BRIEF S9, VISION §6.6) — the fixed, full-screen
 * overlay `dish-screen.tsx` mounts unconditionally, driven entirely by its
 * own `?cook=1` search param.
 *
 * **Two components, one reason.** `CookingOverlay` (this one) owns only the
 * URL ↔ open-state wiring; `CookingSession` (below) owns everything about
 * one actual cooking run — step, timer, drawer, focus trap. They are split
 * because those two concerns need to *reset* on different events:
 * `CookingOverlay` must survive for `dish-screen.tsx`'s whole life (mounted
 * once, alongside `BottomSheet`, exactly like every other always-mounted
 * overlay in this app), while a fresh `CookingSession` — a fresh recipe
 * snapshot in particular — is needed **every time `?cook=1` reappears**, not
 * only the first time this component ever mounts. `key={sessionKey}`, bumped
 * on every closed→open transition, is what forces that remount; without the
 * split, `CookingSession`'s own `useState(() => initialDetail)` snapshot
 * would run exactly once, on this component's first-ever render, and every
 * later re-open would cook from data that might be edits old.
 *
 * **SSR-safe by construction.** `open` starts `false` and only ever changes
 * inside a `useEffect` — never read from `searchParams` during the first
 * render — so the very first client render matches the server's (nothing
 * rendered) regardless of whether the URL already carries `?cook=1` (a
 * reload while cooking). This task's own addendum calls this out explicitly;
 * see also PR #28's `HydrateClient` fix for the same class of bug on the
 * data side. The visible cost is one client-only paint after mount before
 * the overlay appears — imperceptible next to a hydration mismatch.
 */
export function CookingOverlay({
  dishId,
  detail,
  restoreFocusTo,
}: {
  dishId: string;
  detail: DishDetailOutput;
  restoreFocusTo?: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const next = searchParams.get("cook") === "1";
    setOpen(next);
    if (next && !wasOpenRef.current) {
      setSessionKey((key) => key + 1);
    }
    wasOpenRef.current = next;
  }, [searchParams]);

  if (!open) {
    return null;
  }

  return (
    <CookingSession
      key={sessionKey}
      dishId={dishId}
      initialDetail={detail}
      onClose={() => router.replace(`/dishes/${dishId}`)}
      restoreFocusTo={restoreFocusTo}
    />
  );
}

function CookingSession({
  dishId,
  initialDetail,
  onClose,
  restoreFocusTo,
}: {
  dishId: string;
  initialDetail: DishDetailOutput;
  /**
   * Closing always goes through `router.replace` (never `router.back()`):
   * this task's own addendum fixes the contract as "open = push the param;
   * close = replace without it", so the hardware Back gesture (which *does*
   * pop the pushed entry) and an explicit ✕/confirm exit both land on the
   * exact same URL, and Back specifically never has to run through this
   * component's own confirmation at all — it is a `searchParams` change
   * `CookingOverlay` reacts to from the outside, not a call into here.
   */
  onClose: () => void;
  restoreFocusTo?: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("cooking");
  const td = useTranslations("dish");
  const common = useTranslations("common");
  const wakeLockStatus = useWakeLock();

  // The recipe as it stood the instant this session started — see this
  // module's own doc comment on why a fresh one is taken per session
  // (`sessionKey`) rather than once for this component's whole life.
  const [recipe] = useState(() => initialDetail);
  const totalSteps = recipe.steps.length;
  const storageKey = `larder.cook.${dishId}`;

  const [cooking, setCooking] = useState<CookingState>(() => {
    let raw: unknown = null;
    try {
      const stored = window.localStorage.getItem(storageKey);
      raw = stored === null ? null : JSON.parse(stored);
    } catch {
      raw = null;
    }
    return restoreCookingState(raw, totalSteps);
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(cooking));
    } catch {
      // Private browsing / a full quota — cooking mode still works for the
      // rest of this tab's life, it just won't resume on the next open.
    }
  }, [cooking, storageKey]);

  // The single 250ms tick for the whole session (this file's own doc
  // comment on `cook-timer.tsx` explains why it lives here): only runs
  // while a timer is actually set, and restarts only when `cooking.timer`
  // itself is reassigned (a start or a reset), not on every `stepIndex`
  // change — `cooking.timer`'s object identity is stable across a plain
  // step navigation, since `setCooking` spreads the previous timer through
  // unchanged.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (cooking.timer === null) {
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [cooking.timer]);

  const activeTimer = cooking.timer;
  const timerRunState: TimerRunState | null =
    activeTimer === null ? null : timerState(activeTimer.endsAt, now);
  const timerRemaining =
    activeTimer === null ? null : timerRemainingMs(activeTimer.endsAt, now);

  // Primed on the «запустить» tap (iOS: the first `play()` on an element
  // must originate in a real gesture) and never re-created for the
  // session's whole life — see `cook-timer.tsx`'s own doc comment on why
  // that component cannot own this itself.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const finishAnnouncedRef = useRef(false);

  const [announce, setAnnounce] = useState<{
    text: string;
    seq: number;
  } | null>(null);
  const announceSeq = useRef(0);
  function announceLive(text: string) {
    announceSeq.current += 1;
    setAnnounce({ text, seq: announceSeq.current });
  }

  // Fires exactly once per finish, regardless of which step is on screen —
  // the whole reason the tick lives at this level rather than per-step. The
  // ref resets the moment a *new* timer is started (`timerRunState` reads
  // "running" again), so a second bake in the same session gets its own alert.
  useEffect(() => {
    if (timerRunState === "finished") {
      if (!finishAnnouncedRef.current) {
        finishAnnouncedRef.current = true;
        audioRef.current?.play().catch(() => {
          // Priming on the start tap failed, or this browser refuses an
          // unprompted play regardless — the in-app alert text is the part
          // of the promise that always holds (VISION §6.6).
        });
        announceLive(t("timerFinishedSr"));
      }
    } else {
      finishAnnouncedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerRunState]);

  // Announces every step change, including the very first render — a
  // screen-reader user must hear "шаг 1 из 6" the instant the overlay opens,
  // not only after their first navigation (the same gap `revision-mode.tsx`
  // closes with its own once-on-mount effect).
  useEffect(() => {
    announceLive(
      t("progress", { current: cooking.stepIndex + 1, total: totalSteps }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cooking.stepIndex]);

  function startStepTimer(stepIndex: number, timerSec: number) {
    if (cooking.timer !== null) {
      return;
    }
    if (audioRef.current === null) {
      audioRef.current = new Audio(COOK_TIMER_FINISH_SOUND_DATA_URI);
    }
    const audio = audioRef.current;
    audio
      .play()
      .then(() => {
        audio.pause();
        audio.currentTime = 0;
      })
      .catch(() => {
        // Priming failed — the later automatic play on finish likely will
        // too, silently. Nothing else to do here; see the finish effect above.
      });

    const { endsAt } = startTimer(Date.now(), timerSec);
    setCooking((previous) => ({ ...previous, timer: { endsAt, stepIndex } }));
  }

  function resetTimer() {
    setCooking((previous) => ({ ...previous, timer: null }));
  }

  function goToStep(action: StepNavAction) {
    setCooking((previous) => ({
      ...previous,
      stepIndex: stepNavigation(previous.stepIndex, totalSteps, action),
    }));
  }

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  function requestClose() {
    if (confirmOpen) {
      // Already showing the confirmation — its own two buttons are the
      // only way out of it; a second ✕ tap is a no-op rather than a
      // shortcut that bypasses «Выйти» / «Продолжить».
      return;
    }
    if (needsExitConfirmation(cooking.stepIndex, timerRunState)) {
      setConfirmOpen(true);
      return;
    }
    onClose();
  }

  function cancelExit() {
    setConfirmOpen(false);
  }

  function confirmExit() {
    setConfirmOpen(false);
    onClose();
  }

  const panelRef = useRef<HTMLDivElement>(null);
  const confirmStayRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (confirmOpen) {
      confirmStayRef.current?.focus();
    }
  }, [confirmOpen]);

  // Refreshed every render so the stable `keydown` listener below (added
  // once, on mount) always routes through the *current* render's state and
  // callbacks — the same `onCloseRef`/`arrowCommitRef` trick
  // `revision-mode.tsx` and `bottom-sheet.tsx` both use.
  const routingRef = useRef({
    confirmOpen,
    drawerOpen,
    cancelExit,
    closeDrawer: () => setDrawerOpen(false),
    requestClose,
    next: () => goToStep({ type: "next" }),
    prev: () => goToStep({ type: "prev" }),
  });
  useEffect(() => {
    routingRef.current = {
      confirmOpen,
      drawerOpen,
      cancelExit,
      closeDrawer: () => setDrawerOpen(false),
      requestClose,
      next: () => goToStep({ type: "next" }),
      prev: () => goToStep({ type: "prev" }),
    };
  });

  useEffect(() => {
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      panel.focus();
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      const routing = routingRef.current;

      if (event.key === "Escape") {
        if (routing.confirmOpen) {
          routing.cancelExit();
        } else if (routing.drawerOpen) {
          routing.closeDrawer();
        } else {
          routing.requestClose();
        }
        return;
      }

      if (routing.confirmOpen) {
        // Tab still cycles below; arrow-key navigation is suppressed while
        // the confirmation is up so a stray ArrowRight cannot walk the
        // recipe forward behind it.
      } else if (event.key === "ArrowRight" && !event.repeat) {
        event.preventDefault();
        routing.next();
        return;
      } else if (event.key === "ArrowLeft" && !event.repeat) {
        event.preventDefault();
        routing.prev();
        return;
      }

      if (event.key !== "Tab" || !panel) {
        return;
      }

      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!first || !last) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const active = document.activeElement;
      const inside = panel.contains(active);

      if (event.shiftKey) {
        if (!inside || active === first || active === panel) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Read fresh at cleanup, not captured up front — same reasoning
      // `revision-mode.tsx`'s own cleanup documents.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const opener = restoreFocusTo?.current ?? null;
      if (opener?.isConnected) {
        opener.focus();
      }
    };
  }, [restoreFocusTo]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      confirmOpen ||
      drawerOpen ||
      !event.isPrimary ||
      event.button !== 0 ||
      dragRef.current !== null
    ) {
      return;
    }
    const el = bodyRef.current;
    if (!el) {
      return;
    }
    el.setPointerCapture(event.pointerId);
    const now = performance.now();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      recent: [{ x: event.clientX, t: now }],
    };
    el.style.transition = "none";
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const el = bodyRef.current;
    if (!drag || !el || drag.pointerId !== event.pointerId) {
      return;
    }
    const now = performance.now();
    const recent = [...drag.recent, { x: event.clientX, t: now }].filter(
      (sample) => now - sample.t <= VELOCITY_WINDOW_MS,
    );
    dragRef.current = { ...drag, recent };
    el.style.transform = `translateX(${event.clientX - drag.startX}px)`;
  }

  function releaseDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean,
  ) {
    const drag = dragRef.current;
    const el = bodyRef.current;
    if (!drag || !el || drag.pointerId !== event.pointerId) {
      return;
    }
    // Cleared before evaluating the decision — the same discipline
    // `revision-mode.tsx`'s `commitDecision` documents: whatever happens
    // next must never be able to re-enter this drag.
    dragRef.current = null;

    if (commit) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const releaseTime = performance.now();
      const windowStart =
        drag.recent.find(
          (sample) => releaseTime - sample.t <= VELOCITY_WINDOW_MS,
        ) ?? drag.recent[drag.recent.length - 1];
      const recentDx = windowStart ? event.clientX - windowStart.x : 0;
      const recentElapsedMs = windowStart ? releaseTime - windowStart.t : 0;

      const decision = decideStepSwipe({ dx, dy, recentDx, recentElapsedMs });
      if (decision !== null) {
        el.style.transition = "none";
        el.style.transform = "";
        goToStep({ type: decision });
        return;
      }
    }

    if (prefersReducedMotion()) {
      el.style.transition = "none";
      el.style.transform = "";
    } else {
      el.style.transition = `transform ${SPRING_BACK_DURATION_MS}ms var(--ease-out)`;
      el.style.transform = "translateX(0px)";
    }
  }

  if (totalSteps === 0) {
    // Defensive only — `dish-screen.tsx` gates the «Готовить» link itself
    // on `steps.length > 0`, so this is unreachable except via a hand-typed
    // `?cook=1` on a dish saved with no steps at all.
    return (
      <div className={styles.overlay}>
        <div
          ref={panelRef}
          className={styles.panel}
          role="dialog"
          aria-modal="true"
          aria-label={recipe.title}
          tabIndex={-1}
        >
          <div className={styles.header}>
            <span />
            <button
              type="button"
              className={styles.close}
              onClick={onClose}
              aria-label={common("close")}
            >
              ✕
            </button>
          </div>
          <div className={styles.emptyBody}>
            <p>{t("noSteps")}</p>
          </div>
        </div>
      </div>
    );
  }

  const step = recipe.steps[cooking.stepIndex];
  if (!step) {
    return null;
  }
  const stepTimerSec = step.timerSec;
  const stepTimer = timerDisplay(step.timerSec, step.timerMaxSec);
  const timerBelongsHere =
    activeTimer !== null && activeTimer.stepIndex === cooking.stepIndex;
  const timerElsewhereStepIndex =
    activeTimer !== null && activeTimer.stepIndex !== cooking.stepIndex
      ? activeTimer.stepIndex
      : null;
  const ingredientsForMsg = ingredientsForMessage(
    recipe.recipe,
    recipe.recipe.portionsBase,
  );
  const ingredientsFor = td(ingredientsForMsg.key, ingredientsForMsg.values);

  return (
    <div className={styles.overlay}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t("dialogTitle", { title: recipe.title })}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <span className={styles.progress}>
            {t("progress", {
              current: cooking.stepIndex + 1,
              total: totalSteps,
            })}
          </span>
          {!confirmOpen && timerElsewhereStepIndex !== null ? (
            <button
              type="button"
              className={styles.timerChip}
              aria-label={t("timerJumpAria")}
              onClick={() =>
                goToStep({ type: "goto", index: timerElsewhereStepIndex })
              }
            >
              <span aria-hidden="true">⏱</span>{" "}
              {timerRunState === "finished"
                ? t("timerFinished")
                : formatTimerClock(timerRemaining ?? 0)}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.close}
            onClick={requestClose}
            aria-label={common("close")}
          >
            ✕
          </button>
        </div>

        {confirmOpen ? (
          <div className={styles.confirmBody}>
            <p className={styles.confirmTitle}>{t("exitTitle")}</p>
            <p className={styles.confirmHint}>{t("exitHint")}</p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                ref={confirmStayRef}
                className={styles.confirmStay}
                onClick={cancelExit}
              >
                {t("exitCancel")}
              </button>
              <button
                type="button"
                className={styles.confirmLeave}
                onClick={confirmExit}
              >
                {t("exitConfirm")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              ref={bodyRef}
              className={styles.body}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={(event) => releaseDrag(event, true)}
              onPointerCancel={(event) => releaseDrag(event, false)}
              onLostPointerCapture={(event) => releaseDrag(event, false)}
            >
              <span className={styles.stepNumber} aria-hidden="true">
                {cooking.stepIndex + 1}
              </span>
              <p className={styles.stepText}>{step.text}</p>

              {stepTimer && stepTimerSec !== null ? (
                <CookTimer
                  display={stepTimer}
                  runState={timerBelongsHere ? timerRunState : null}
                  remainingMs={timerBelongsHere ? timerRemaining : null}
                  blockedByOtherStep={timerElsewhereStepIndex !== null}
                  onStart={() =>
                    startStepTimer(cooking.stepIndex, stepTimerSec)
                  }
                  onReset={resetTimer}
                />
              ) : null}
            </div>

            {wakeLockStatus === "unsupported" ? (
              <p className={styles.wakeLockHint}>{t("wakeLockHint")}</p>
            ) : null}

            <div className={cx(styles.drawer, drawerOpen && styles.drawerOpen)}>
              <button
                type="button"
                className={styles.drawerHandle}
                aria-expanded={drawerOpen}
                onClick={() => setDrawerOpen((previous) => !previous)}
              >
                <span aria-hidden="true">{drawerOpen ? "˅" : "˄"}</span>{" "}
                {t("ingredientsToggle")}
              </button>
              {drawerOpen ? (
                <div className={styles.drawerBody}>
                  <p className={styles.drawerHeading}>{ingredientsFor}</p>
                  <ul className={styles.drawerList}>
                    {recipe.ingredients.map((row) => (
                      <DrawerIngredientRow key={row.id} row={row} td={td} />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <div className={styles.footer}>
              <button
                type="button"
                className={styles.navButton}
                aria-disabled={cooking.stepIndex === 0 || undefined}
                onClick={() => goToStep({ type: "prev" })}
              >
                {t("prev")}
              </button>
              <button
                type="button"
                className={styles.navButtonPrimary}
                aria-disabled={
                  cooking.stepIndex === totalSteps - 1 || undefined
                }
                onClick={() => goToStep({ type: "next" })}
              >
                {t("next")}
              </button>
            </div>
          </>
        )}

        {/* Permanently mounted, same reasoning as `revision-mode.tsx`'s own
            live region: assistive tech must already be watching this node
            before the first announcement lands. */}
        <p className={styles.srOnly} role="status">
          <span key={announce?.seq ?? "empty"}>{announce?.text ?? ""}</span>
        </p>
      </div>
    </div>
  );
}

function DrawerIngredientRow({
  row,
  td,
}: {
  row: DishIngredientOutput;
  td: ReturnType<typeof useTranslations<"dish">>;
}) {
  const noteIsAmount =
    row.qty === null &&
    !row.needsReview &&
    !row.isOptional &&
    isUnquantifiable(row.note);

  return (
    <li className={styles.drawerRow}>
      <span className={styles.drawerName}>
        {row.name}
        {row.needsReview ? (
          <span className={styles.drawerFlag}> · {td("needsReview")}</span>
        ) : row.isOptional ? (
          <span className={styles.drawerFlag}> · {td("optional")}</span>
        ) : null}
      </span>
      <span className={styles.drawerAmount}>
        {noteIsAmount ? row.note : formatRecipeQty(row.qty, row.unit)}
      </span>
    </li>
  );
}

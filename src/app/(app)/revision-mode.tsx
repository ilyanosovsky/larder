"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { useTranslations } from "next-intl";

import {
  buildRevisionDeck,
  decideRevisionCard,
  initialRevisionState,
  revisionProgress,
  summarizeRevision,
  type RevisionDecision,
  type RevisionState,
} from "@/lib/pantry/revision-deck";
import { decideSwipeCommit } from "@/lib/pantry/swipe-commit";
import type { PantryListItemOutput } from "@/server/api/routers/pantry";

import styles from "./revision-mode.module.css";

/** Everything that can hold focus inside the overlay — the same set
 * `bottom-sheet.tsx` traps Tab within, copied rather than imported: this
 * overlay is its own full-screen dialog, not a `BottomSheet` instance (see
 * this component's own doc comment), and the selector is a three-line
 * constant, not worth a shared module for one more caller. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** How long the fling-away transition runs before the deck actually
 * advances to the next card — kept in one JS constant, not duplicated into a
 * CSS `transition-duration`, so the `setTimeout` below can never drift out
 * of step with what the card visually does (`animateTransform` reads this
 * same value). */
const FLING_DURATION_MS = 220;
const SPRING_BACK_DURATION_MS = 200;

/** Whether the OS/browser asks for reduced motion — checked at the moment
 * of each commit, not once at mount, for the same reason `pantry-screen.tsx`
 * checks it per tap rather than caching it: a setting change mid-run should
 * take effect on the very next card. Copied rather than shared for the same
 * reasoning as `FOCUSABLE_SELECTOR` above. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function animateTransform(
  el: HTMLElement,
  durationMs: number,
  transform: string,
  opacity?: string,
) {
  el.style.transition =
    opacity === undefined
      ? `transform ${durationMs}ms var(--ease-out)`
      : `transform ${durationMs}ms var(--ease-out), opacity ${durationMs}ms var(--ease-out)`;
  el.style.transform = transform;
  if (opacity !== undefined) {
    el.style.opacity = opacity;
  }
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
}

/**
 * S5's «Ревизия» (DESIGN_BRIEF, VISION §3.2): a full-screen, one-card-at-a-
 * time pass through the pantry snapshot the shopper opened it with — swipe
 * (or tap the two buttons below the card, or ArrowRight/ArrowLeft) «есть» /
 * «кончилось» for each, watch the progress climb, land on a summary once the
 * deck runs out.
 *
 * **Not a `BottomSheet` instance.** The design calls this a "полноэкранный
 * режим", a different register from the bottom-sheet-with-scrim pattern
 * every "add/edit a thing" flow in this app uses — no room left below the
 * card for a scrim to peek through, and no sense in which this is a small
 * panel over the pantry rather than a takeover of the whole screen. It does
 * copy `BottomSheet`'s focus-trap / Esc / body-scroll-lock conventions
 * (`bottom-sheet.tsx`'s own doc comment), because none of that behaviour is
 * specific to the sheet shape.
 *
 * **The deck is a one-time snapshot, not a live view.** `buildRevisionDeck`
 * runs exactly once, inside a lazy `useState` initializer — so even if the
 * parent (`pantry-screen.tsx`) re-renders with a fresh `items` array
 * mid-run (its own `pantry.list` refetching on a background poll or a
 * partner's tap while this overlay sits on top of it), the deck this
 * component walks through never reshuffles or grows. A partner's own
 * addition simply isn't part of this session.
 *
 * **«Кончилось» fires the caller's mutation immediately on commit, not after
 * the fling animation plays.** `onRanOut` is called synchronously inside
 * `commitDecision`, before the card's own visual exit even starts — closing
 * the overlay mid-fling (the crest, or Esc) must not "un-decide" a swipe
 * that already committed. The animation is purely cosmetic and deliberately
 * decoupled from it: `setState` (the actual deck advance) is what waits for
 * the fling to finish, not the mutation.
 *
 * **Double-tap/double-swipe guard is a synchronous ref (`decidingRef`), not
 * render state** — the same reasoning `pantry-screen.tsx`'s own `pendingRef`
 * documents: a second pointerup or button click landing before the
 * animation-deferred re-render lands must not commit the same card twice.
 * `pendingCardId` (render state) exists purely to paint `aria-disabled` on
 * the buttons for that same window; it is not itself the guard.
 */
export function RevisionMode({
  items,
  onRanOut,
  onClose,
  restoreFocusTo,
}: {
  /** The pantry list as it stood the moment «Ревизия» was tapped
   * (`pantry-screen.tsx` passes its own `items`, already read at that exact
   * moment — see this component's own note on why a second defensive copy
   * happens here too). */
  items: readonly PantryListItemOutput[];
  /** Fires the shared `pantry.ranOut` mutation — same optimistic cache
   * removal, rollback and outcome toast `pantry-screen.tsx`'s own
   * «Кончилось» button uses, reused rather than duplicated. Never awaited
   * here; the caller's mutation is already fire-and-observe on its own
   * side. */
  onRanOut: (item: PantryListItemOutput) => void;
  onClose: () => void;
  restoreFocusTo?: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("pantryRevision");
  const tCommon = useTranslations("common");

  const [deck] = useState(() => buildRevisionDeck(items));
  const [state, setState] = useState<RevisionState>(initialRevisionState);
  const [pendingCardId, setPendingCardId] = useState<string | null>(null);

  const [announce, setAnnounce] = useState<{
    text: string;
    seq: number;
  } | null>(null);
  const announceSeq = useRef(0);

  function announceLive(text: string) {
    announceSeq.current += 1;
    setAnnounce({ text, seq: announceSeq.current });
  }

  const panelRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const decidingRef = useRef(false);
  // `number`, not `ReturnType<typeof window.setTimeout>`: this repo also
  // loads `@types/node`, whose ambient `setTimeout` returns `NodeJS.Timeout`
  // and wins that lookup — but `window.setTimeout` (used below) is
  // unambiguously the DOM overload, which returns a plain `number`.
  const flingTimeoutRef = useRef<number | null>(null);

  const progress = revisionProgress(state, deck.length);
  const currentCard = progress.finished ? undefined : deck[state.index];
  const summary = progress.finished ? summarizeRevision(state) : null;

  function commitDecision(
    card: PantryListItemOutput,
    decision: RevisionDecision,
  ) {
    if (decidingRef.current) {
      return;
    }
    decidingRef.current = true;

    if (decision === "ranOut") {
      onRanOut(card);
    }

    const next = decideRevisionCard(state, card.id, decision);
    const nextProgress = revisionProgress(next, deck.length);

    if (nextProgress.finished) {
      const nextSummary = summarizeRevision(next);
      announceLive(
        nextSummary.kind === "empty"
          ? t("summaryEmptySr")
          : t("summaryDoneSr", { count: nextSummary.count }),
      );
    } else {
      const nextCard = deck[next.index];
      if (nextCard) {
        announceLive(
          t("progressSr", {
            current: nextProgress.current,
            total: nextProgress.total,
            name: nextCard.productName,
          }),
        );
      }
    }

    function finish() {
      const el = cardRef.current;
      if (el) {
        el.style.transition = "none";
        el.style.transform = "";
        el.style.opacity = "";
      }
      decidingRef.current = false;
      setPendingCardId(null);
      setState(next);
    }

    const el = cardRef.current;
    if (prefersReducedMotion() || !el) {
      finish();
      return;
    }

    setPendingCardId(card.id);
    const distance = Math.max(el.offsetWidth, 320) * 1.2;
    const targetX = decision === "have" ? distance : -distance;
    animateTransform(el, FLING_DURATION_MS, `translateX(${targetX}px)`, "0");
    flingTimeoutRef.current = window.setTimeout(finish, FLING_DURATION_MS);
  }

  useEffect(() => {
    return () => {
      if (flingTimeoutRef.current !== null) {
        window.clearTimeout(flingTimeoutRef.current);
      }
    };
  }, []);

  // Always points at a closure over the *current* render's `currentCard` and
  // `commitDecision`, refreshed every render — the stable `keydown` listener
  // below (added once on mount) reads through this ref instead of closing
  // over either directly, the same `onCloseRef` trick `bottom-sheet.tsx`
  // uses for its own Esc handler.
  const arrowCommitRef = useRef<(decision: RevisionDecision) => void>(() => {});
  useEffect(() => {
    arrowCommitRef.current = (decision) => {
      if (currentCard) {
        commitDecision(currentCard, decision);
      }
    };
  });

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const panel = panelRef.current;
    const opener = restoreFocusTo?.current ?? null;

    if (panel && !panel.contains(document.activeElement)) {
      panel.focus();
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        arrowCommitRef.current("have");
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        arrowCommitRef.current("ranOut");
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
      if (opener?.isConnected) {
        opener.focus();
      }
    };
  }, [restoreFocusTo]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!currentCard || decidingRef.current) {
      return;
    }
    const el = cardRef.current;
    if (!el) {
      return;
    }
    el.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: performance.now(),
    };
    el.style.transition = "none";
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const el = cardRef.current;
    if (!drag || !el || drag.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - drag.startX;
    el.style.transform = `translateX(${dx}px)`;
  }

  function releaseDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean,
  ) {
    const drag = dragRef.current;
    const el = cardRef.current;
    dragRef.current = null;
    if (!drag || !el || drag.pointerId !== event.pointerId) {
      return;
    }

    if (commit && currentCard) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const elapsedMs = performance.now() - drag.startTime;
      const decision = decideSwipeCommit({ dx, dy, elapsedMs });
      if (decision !== null) {
        commitDecision(currentCard, decision);
        return;
      }
    }

    if (prefersReducedMotion()) {
      el.style.transition = "none";
      el.style.transform = "";
    } else {
      animateTransform(el, SPRING_BACK_DURATION_MS, "translateX(0px)");
    }
  }

  return (
    <div className={styles.overlay}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t("dialogTitle")}
        tabIndex={-1}
      >
        <div className={styles.header}>
          {currentCard ? (
            <span className={styles.progress} aria-hidden="true">
              {t("progress", {
                current: progress.current,
                total: progress.total,
              })}
            </span>
          ) : (
            <span />
          )}
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label={tCommon("close")}
          >
            ✕
          </button>
        </div>

        {currentCard ? (
          <div className={styles.body}>
            <div
              ref={cardRef}
              className={styles.card}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={(event) => releaseDrag(event, true)}
              onPointerCancel={(event) => releaseDrag(event, false)}
            >
              <span className={styles.cardIcon} aria-hidden="true">
                {currentCard.productIcon}
              </span>
              <span className={styles.cardDepartment}>
                {currentCard.categoryName}
              </span>
              <span className={styles.cardName}>{currentCard.productName}</span>
            </div>

            <p className={styles.hint}>{t("hint")}</p>

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.actionRanOut}
                aria-disabled={pendingCardId === currentCard.id || undefined}
                aria-label={t("ranOutAria", { name: currentCard.productName })}
                onClick={() => commitDecision(currentCard, "ranOut")}
              >
                {t("ranOut")}
              </button>
              <button
                type="button"
                className={styles.actionHave}
                aria-disabled={pendingCardId === currentCard.id || undefined}
                aria-label={t("haveAria", { name: currentCard.productName })}
                onClick={() => commitDecision(currentCard, "have")}
              >
                {t("have")}
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.summary}>
            <p className={styles.summaryMark} aria-hidden="true">
              {summary?.kind === "counted" ? "🛒" : "🗄️"}
            </p>
            <p className={styles.summaryText}>
              {summary?.kind === "counted"
                ? t("summaryDone", { count: summary.count })
                : t("summaryEmpty")}
            </p>
            <button
              type="button"
              className={styles.summaryButton}
              onClick={onClose}
            >
              {t("summaryClose")}
            </button>
          </div>
        )}
      </div>

      {/* Permanently mounted for the overlay's whole life, same reasoning as
          `pantry-screen.tsx`'s own live region: assistive tech needs to
          already be watching the node before the text arrives. The `seq`
          key forces a real node replacement on every announcement, so two
          consecutive identical strings (progress landing on the same digits
          is impossible here, but a summary revisited is not) still get
          announced. */}
      <p className={styles.srOnly} role="status">
        <span key={announce?.seq ?? "empty"}>{announce?.text ?? ""}</span>
      </p>
    </div>
  );
}

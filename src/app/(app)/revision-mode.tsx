"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { useTranslations } from "next-intl";

import type { RanOutFeedback } from "@/lib/pantry/ran-out-outcome";
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

/** The same beat `pantry-screen.tsx`'s own toast uses. */
const MODE_TOAST_MS = 2500;

/** The minimum gap between two commits, regardless of what triggered them —
 * closes a gap `decidingRef` alone does not: under `prefers-reduced-motion`,
 * `commitDecision` unlocks `decidingRef` synchronously (there is no fling
 * animation to wait out), so nothing else stood between one commit and the
 * very next event being able to commit again immediately. A held arrow key's
 * OS auto-repeat is filtered separately (`event.repeat`, below), but this
 * cooldown is what actually stops a run of rapid commits from emptying the
 * whole deck in about a second — comfortably longer than a typical OS key
 * -repeat interval (commonly 30–50ms) and any real double-tap, short enough
 * that two deliberate, distinct swipes never feel throttled. */
const COMMIT_COOLDOWN_MS = 250;

/** How far back (ms) release velocity looks when deciding a fling — only
 * the *recent* window of movement, never the whole gesture's average speed.
 * A drag that holds still for a while and then flings at the very end must
 * still read as fast: averaging over the total elapsed time since the
 * finger went down would dilute a genuinely fast release into a slow one,
 * since most of that time was spent not moving at all. */
const VELOCITY_WINDOW_MS = 100;

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

/** One recorded pointermove sample — just enough to compute a *recent*
 * velocity at release (see `VELOCITY_WINDOW_MS`), not a full gesture log. */
interface DragSample {
  readonly x: number;
  readonly t: number;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  /** Recent samples, oldest first, re-trimmed to `VELOCITY_WINDOW_MS` on
   * every move. Always has at least one entry (seeded at pointerdown). */
  readonly recent: readonly DragSample[];
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
 * **Its settled outcome (or a rollback error) surfaces inside this dialog,
 * not `pantry-screen.tsx`'s own toast.** `onRanOut`'s second argument is a
 * callback the caller (`handleRevisionRanOut`) invokes once the mutation
 * settles; this component renders that as its own toast (`showModeToast`)
 * plus an `aria-live` announcement, both inside the panel subtree. This
 * matters specifically for a failed «кончилось»: `pantry-screen.tsx`'s own
 * toast sits at a lower z-index than this overlay and its live region lives
 * outside this dialog's `aria-modal` subtree, so without this redirection a
 * rollback would be both invisible and unannounced — the card would have
 * already flung off screen as if the tap succeeded, the summary still
 * counts the tap (see `summarizeRevision`'s own doc comment on why that
 * count is never revised after the fact), and the only sign anything went
 * wrong would be the product quietly still sitting in the pantry afterwards.
 *
 * **Double-tap/double-swipe guard is a synchronous ref (`decidingRef`), not
 * render state** — the same reasoning `pantry-screen.tsx`'s own `pendingRef`
 * documents: a second pointerup or button click landing before the
 * animation-deferred re-render lands must not commit the same card twice.
 * `pendingCardId` (render state) exists purely to paint `aria-disabled` on
 * the buttons for that same window; it is not itself the guard.
 * `COMMIT_COOLDOWN_MS` is the belt-and-suspenders on top of that ref: under
 * `prefers-reduced-motion`, `decidingRef` itself unlocks synchronously
 * (there is no fling to wait out), so a held arrow key's OS auto-repeat
 * (also filtered directly via `event.repeat`) or a mashed button could
 * otherwise commit the entire remaining deck in well under a second.
 *
 * **A drag in progress is always cancelled the instant any commit starts**
 * (`cancelActiveDrag`, called first thing inside `commitDecision`,
 * synchronously before anything else) — regardless of what triggered that
 * commit. Without this, a keyboard/button commit landing while a finger is
 * still down on the card would leave `dragRef` pointing at a drag that now
 * belongs, semantically, to whichever card comes *next*: that finger's
 * eventual lift would be evaluated against the new card, potentially firing
 * `ranOut` on a card the shopper never actually looked at.
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
  /**
   * Fires the shared `pantry.ranOut` mutation — same optimistic cache
   * removal and rollback `pantry-screen.tsx`'s own «Кончилось» button uses,
   * reused rather than duplicated. Never awaited here; the caller's
   * mutation is already fire-and-observe on its own side.
   *
   * `onOutcome` is invoked once the mutation settles (or fails) —
   * `RevisionMode` passes its own closure so the caller can hand back the
   * settled `RanOutFeedback` (or `null` for the silent `gone` outcome)
   * without either side needing to know how the other renders it.
   */
  onRanOut: (
    item: PantryListItemOutput,
    onOutcome: (feedback: RanOutFeedback | null) => void,
  ) => void;
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

  const [modeToast, setModeToast] = useState<{
    visible: string;
    seq: number;
  } | null>(null);
  const modeToastSeq = useRef(0);

  useEffect(() => {
    if (modeToast === null) {
      return;
    }
    const timer = setTimeout(() => setModeToast(null), MODE_TOAST_MS);
    return () => clearTimeout(timer);
  }, [modeToast]);

  function showModeToast(feedback: RanOutFeedback) {
    modeToastSeq.current += 1;
    setModeToast({ visible: feedback.visible, seq: modeToastSeq.current });
    announceLive(feedback.sr);
  }

  const panelRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const summaryButtonRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const decidingRef = useRef(false);
  const lastCommitAtRef = useRef(0);
  // `number`, not `ReturnType<typeof window.setTimeout>`: this repo also
  // loads `@types/node`, whose ambient `setTimeout` returns `NodeJS.Timeout`
  // and wins that lookup — but `window.setTimeout` (used below) is
  // unambiguously the DOM overload, which returns a plain `number`.
  const flingTimeoutRef = useRef<number | null>(null);

  const progress = revisionProgress(state, deck.length);
  const currentCard = progress.finished ? undefined : deck[state.index];
  const summary = progress.finished ? summarizeRevision(state) : null;

  /** Releases whatever drag is in progress without resolving it either way
   * — no spring-back, no commit. Called first thing inside `commitDecision`
   * (see this component's own doc comment on why) and safe to call when
   * there is nothing to cancel. */
  function cancelActiveDrag() {
    const drag = dragRef.current;
    const el = cardRef.current;
    dragRef.current = null;
    if (!drag || !el) {
      return;
    }
    try {
      el.releasePointerCapture(drag.pointerId);
    } catch {
      // Already released — a pointerup/pointercancel/lostpointercapture
      // that raced this call already did it, or the browser took capture
      // away on its own (e.g. a context menu). Nothing left to undo.
    }
  }

  function commitDecision(
    card: PantryListItemOutput,
    decision: RevisionDecision,
  ) {
    if (decidingRef.current) {
      return;
    }
    const now = performance.now();
    if (now - lastCommitAtRef.current < COMMIT_COOLDOWN_MS) {
      return;
    }
    lastCommitAtRef.current = now;
    decidingRef.current = true;
    cancelActiveDrag();

    if (decision === "ranOut") {
      onRanOut(card, (feedback) => {
        if (feedback) {
          showModeToast(feedback);
        }
      });
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

  // Seeds the live region once, right after mount, with the first card's
  // own context — without this, a screen-reader user hears nothing at all
  // about "1 из N: <name>" until their very first decision, since the
  // visible progress text (`.progress`) is `aria-hidden`. `deck` is a
  // stable snapshot for this component's whole life, and `t`/`announceLive`
  // are only ever read as of this one, deliberately-once run.
  useEffect(() => {
    const firstProgress = revisionProgress(initialRevisionState, deck.length);
    if (firstProgress.finished) {
      const firstSummary = summarizeRevision(initialRevisionState);
      announceLive(
        firstSummary.kind === "empty"
          ? t("summaryEmptySr")
          : t("summaryDoneSr", { count: firstSummary.count }),
      );
      return;
    }
    const firstCard = deck[0];
    if (firstCard) {
      announceLive(
        t("progressSr", {
          current: firstProgress.current,
          total: firstProgress.total,
          name: firstCard.productName,
        }),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Moves focus to the summary's own primary control the moment the run
  // finishes — the body branch (including whichever button was just
  // focused) unmounts wholesale when the summary replaces it, and nothing
  // else would otherwise claim focus, dropping it to `<body>`.
  useEffect(() => {
    if (progress.finished) {
      summaryButtonRef.current?.focus();
    }
  }, [progress.finished]);

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
        // A held key's OS auto-repeat must not walk the deck on its own —
        // `COMMIT_COOLDOWN_MS` inside `commitDecision` is the general
        // backstop, but rejecting the repeat outright here is what keeps a
        // long-held arrow from firing dozens of prevented-but-still-queued
        // commit attempts in the first place.
        if (!event.repeat) {
          arrowCommitRef.current("have");
        }
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (!event.repeat) {
          arrowCommitRef.current("ranOut");
        }
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
      // Read fresh here, never captured into a local at the top of this
      // effect: `pantry-screen.tsx`'s own `onClose` handler redirects
      // `restoreFocusTo.current` to `screenRef` right before it closes this
      // overlay, for the case its original opener button has itself
      // unmounted mid-run (the shopper ran the pantry empty). That redirect
      // only has anywhere to land if this reads the ref's value at the
      // moment of cleanup rather than whatever it held back at mount — the
      // exact opposite of `react-hooks/exhaustive-deps`'s usual advice to
      // snapshot a ref into a variable up front, which is what reintroduces
      // the staleness this is fixing (finding 10 of the adversarial review).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const opener = restoreFocusTo?.current ?? null;
      if (opener?.isConnected) {
        opener.focus();
      }
    };
  }, [restoreFocusTo]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (
      !currentCard ||
      decidingRef.current ||
      dragRef.current !== null ||
      !event.isPrimary ||
      event.button !== 0
    ) {
      // `dragRef.current !== null` rejects a second finger touching the
      // card while the first is still down, rather than letting it silently
      // overwrite the active drag's own baseline. `!event.isPrimary` is the
      // same rejection for the platforms that already flag a second
      // simultaneous touch point that way; `event.button !== 0` rejects a
      // right-click (button 2) or other non-primary mouse button, whose
      // context menu can suppress the matching `pointerup` in some browsers
      // and would otherwise strand the card mid-drag.
      return;
    }
    const el = cardRef.current;
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
    const el = cardRef.current;
    if (
      !drag ||
      !el ||
      drag.pointerId !== event.pointerId ||
      decidingRef.current
    ) {
      return;
    }
    const now = performance.now();
    const recent = [...drag.recent, { x: event.clientX, t: now }].filter(
      (sample) => now - sample.t <= VELOCITY_WINDOW_MS,
    );
    dragRef.current = { ...drag, recent };

    const dx = event.clientX - drag.startX;
    el.style.transform = `translateX(${dx}px)`;
  }

  function releaseDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean,
  ) {
    const drag = dragRef.current;
    const el = cardRef.current;
    if (!drag || !el || drag.pointerId !== event.pointerId) {
      // Not the pointer this drag belongs to — a second finger's up,
      // cancel, or lost-capture event, or no drag in progress at all.
      // Checked BEFORE clearing `dragRef` below, so a mismatched event can
      // never wipe out a drag that actually belongs to a different,
      // still-active pointer.
      return;
    }
    dragRef.current = null;

    if (commit && currentCard && !decidingRef.current) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const releaseTime = performance.now();
      const windowStart =
        drag.recent.find(
          (sample) => releaseTime - sample.t <= VELOCITY_WINDOW_MS,
        ) ?? drag.recent[drag.recent.length - 1];
      const recentDx = windowStart ? event.clientX - windowStart.x : 0;
      const recentElapsedMs = windowStart ? releaseTime - windowStart.t : 0;

      const decision = decideSwipeCommit({ dx, dy, recentDx, recentElapsedMs });
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
              onLostPointerCapture={(event) => releaseDrag(event, false)}
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
              ref={summaryButtonRef}
              className={styles.summaryButton}
              onClick={onClose}
            >
              {t("summaryClose")}
            </button>
          </div>
        )}

        {modeToast === null ? null : (
          <p className={styles.modeToast} aria-hidden="true">
            {modeToast.visible}
          </p>
        )}

        {/* Permanently mounted for the overlay's whole life, same reasoning
            as `pantry-screen.tsx`'s own live region: assistive tech needs to
            already be watching the node before the text arrives. Inside the
            `role="dialog" aria-modal="true"` panel, not a sibling of it —
            outside that subtree, assistive tech that honors `aria-modal`
            (e.g. VoiceOver) prunes it from the accessibility tree entirely
            and nothing it says is ever spoken. The `seq` key forces a real
            node replacement on every announcement, so two consecutive
            identical strings (a repeated error, or a summary revisited)
            still get announced. */}
        <p className={styles.srOnly} role="status">
          <span key={announce?.seq ?? "empty"}>{announce?.text ?? ""}</span>
        </p>
      </div>
    </div>
  );
}

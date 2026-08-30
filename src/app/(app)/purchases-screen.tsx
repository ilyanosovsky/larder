"use client";

import { useRef, useState, type CSSProperties } from "react";

import { useTranslations } from "next-intl";

import { cx } from "@/lib/cx";
import { flyToCartDelta, type FlightDelta } from "@/lib/pantry/fly-to-cart";

import { CartScreen } from "./cart-screen";
import { PantryScreen, type PantryRanOutFlight } from "./pantry-screen";
import styles from "./purchases-screen.module.css";

type PurchasesTab = "cart" | "pantry";

/**
 * How long the fly-over ghost's CSS animation runs
 * (`.flyGhost` in `purchases-screen.module.css`) — kept in one place so the
 * JS cleanup timeout below cannot silently drift out of step with it.
 */
const FLIGHT_DURATION_MS = 360;

/** A little slack past the CSS animation's own duration: the `setTimeout`
 * fallback exists for the case `onAnimationEnd` does not fire at all (a
 * backgrounded tab throttles timers and rAF-driven work alike, so this is a
 * true belt-and-suspenders margin, not a race to win against the event). */
const FLIGHT_CLEANUP_MS = FLIGHT_DURATION_MS + 150;

interface Flight {
  key: number;
  icon: string;
  name: string;
  delta: FlightDelta;
}

/**
 * The «Покупки» tab's own root (DESIGN_BRIEF S3): the «Корзина | Кладовая»
 * segment control, and whichever of the two full screens is currently
 * selected underneath it (task 3.1).
 *
 * The control sits **above** both screens rather than folded into
 * `CartScreen`'s own toolbar. `cart-screen.module.css` had speculated the
 * segment control would replace that toolbar's title/count pair; it does
 * not, on purpose — `CartScreen` is a large, already-tested, actively-synced
 * component (task 2.2–2.5), and reaching into its toolbar to swap out
 * "Корзина" + the item count for a control that also has to drive a sibling
 * screen would mean threading tab state through it for no benefit to the
 * cart itself. A thin wrapper above both screens gets the same DESIGN_BRIEF
 * layout — the control still reads as "the first thing on this tab" — with
 * a far smaller blast radius: neither screen needs to know the other exists.
 *
 * State is local and resets to «Корзина» on remount, matching the plan's own
 * wording ("Local state, default «Корзина»"). Nothing here is persisted
 * across a reload — the pantry is a secondary view, not a screen worth a
 * bookmark of its own in the MVP.
 *
 * **Toggle buttons, deliberately not an ARIA tablist.** `role="tab"` +
 * `aria-selected` advertises the full WAI-ARIA tabs pattern to assistive
 * tech — roving-tabindex arrow-key navigation between the two controls, and
 * an `aria-controls` link from each tab to an identified `tabpanel` — none of
 * which this control implements; the two screens below are plain content,
 * not `role="tabpanel"` regions with ids to point at. Two labelled toggle
 * buttons in a `role="group"` need none of that: a screen reader still
 * announces the group's label and each button's pressed state, and Tab-order
 * navigation (which the browser already gives a `<button>` for free) is the
 * only navigation contract a group makes, unlike a tablist.
 *
 * **The «Кончилось» fly-over ghost lives here, not in `PantryScreen`**
 * (DESIGN_BRIEF S5, §6 — "the single place with pronounced motion"). Its
 * destination is the «Корзина» segment button, which is this component's own
 * DOM, not the pantry screen's — `PantryScreen` only ever reports that a row
 * flew off and from where (`onRanOutStart`), already gated on
 * `prefers-reduced-motion` on its side so a skipped flight never reaches
 * here at all. The ghost is decorative only: no cache semantics change
 * because of it, the optimistic removal in `PantryScreen`'s own `onMutate`
 * stays exactly as synchronous as it always was, and this component's state
 * exists purely to mount and then unmount a `position: fixed` overlay.
 */
export function PurchasesScreen() {
  const t = useTranslations("purchases");
  const [tab, setTab] = useState<PurchasesTab>("cart");

  const cartButtonRef = useRef<HTMLButtonElement>(null);
  const [flights, setFlights] = useState<Flight[]>([]);
  const flightSeq = useRef(0);

  function removeFlight(key: number) {
    setFlights((current) => current.filter((flight) => flight.key !== key));
  }

  function handleRanOutStart(flight: PantryRanOutFlight) {
    const destination = cartButtonRef.current;
    if (!destination) {
      // Unreachable in practice — the segment control above always renders
      // both buttons — but a flight with nowhere to fly to is simply skipped
      // rather than animated toward `(0, 0)`.
      return;
    }

    const delta = flyToCartDelta(
      flight.rect,
      destination.getBoundingClientRect(),
    );
    flightSeq.current += 1;
    const key = flightSeq.current;

    setFlights((current) => [
      ...current,
      { key, icon: flight.icon, name: flight.name, delta },
    ]);
    setTimeout(() => removeFlight(key), FLIGHT_CLEANUP_MS);
  }

  return (
    <div className={styles.wrap}>
      <div
        className={styles.segment}
        role="group"
        aria-label={t("segmentAria")}
      >
        <button
          type="button"
          ref={cartButtonRef}
          aria-pressed={tab === "cart"}
          className={cx(
            styles.segmentButton,
            tab === "cart" && styles.segmentButtonActive,
          )}
          onClick={() => setTab("cart")}
        >
          {t("cart")}
        </button>
        <button
          type="button"
          aria-pressed={tab === "pantry"}
          className={cx(
            styles.segmentButton,
            tab === "pantry" && styles.segmentButtonActive,
          )}
          onClick={() => setTab("pantry")}
        >
          {t("pantry")}
        </button>
      </div>

      {tab === "cart" ? (
        <CartScreen />
      ) : (
        <PantryScreen onRanOutStart={handleRanOutStart} />
      )}

      {/* Purely decorative — the pantry screen's own sr-only live region
          already announces the outcome; this is motion for sighted users,
          nothing a screen reader needs to know about. */}
      {flights.map((flight) => (
        <div
          key={flight.key}
          className={styles.flyGhost}
          aria-hidden="true"
          style={
            {
              left: flight.delta.left,
              top: flight.delta.top,
              // Read by the `@keyframes` in purchases-screen.module.css. Cast
              // as a whole: custom properties are not part of the typed
              // `CSSProperties` surface, so the object needs one assertion
              // rather than a per-property escape hatch.
              "--fly-dx": `${flight.delta.dx}px`,
              "--fly-dy": `${flight.delta.dy}px`,
            } as CSSProperties
          }
          onAnimationEnd={() => removeFlight(flight.key)}
        >
          <span className={styles.flyGhostIcon}>{flight.icon}</span>
          <span className={styles.flyGhostName}>{flight.name}</span>
        </div>
      ))}
    </div>
  );
}

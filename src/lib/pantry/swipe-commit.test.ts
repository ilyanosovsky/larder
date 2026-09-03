import { describe, expect, it } from "vitest";

import { decideSwipeCommit } from "@/lib/pantry/swipe-commit";

describe("decideSwipeCommit", () => {
  it("springs back for a small, slow drag below both thresholds", () => {
    expect(
      decideSwipeCommit({ dx: 10, dy: 0, recentDx: 10, recentElapsedMs: 400 }),
    ).toBeNull();
  });

  it("commits «have» once the distance threshold is crossed to the right", () => {
    expect(
      decideSwipeCommit({
        dx: 120,
        dy: 0,
        recentDx: 120,
        recentElapsedMs: 500,
      }),
    ).toBe("have");
  });

  it("commits «ranOut» once the distance threshold is crossed to the left", () => {
    expect(
      decideSwipeCommit({
        dx: -120,
        dy: 0,
        recentDx: -120,
        recentElapsedMs: 500,
      }),
    ).toBe("ranOut");
  });

  it("does not commit right at the distance floor minus one", () => {
    expect(
      decideSwipeCommit({ dx: 95, dy: 0, recentDx: 95, recentElapsedMs: 500 }),
    ).toBeNull();
  });

  it("commits exactly at the distance threshold", () => {
    expect(
      decideSwipeCommit({ dx: 96, dy: 0, recentDx: 96, recentElapsedMs: 500 }),
    ).toBe("have");
  });

  it("commits a fast short flick even under the distance threshold", () => {
    // 40px in 50ms = 0.8 px/ms, above the fling velocity floor.
    expect(
      decideSwipeCommit({ dx: 40, dy: 0, recentDx: 40, recentElapsedMs: 50 }),
    ).toBe("have");
  });

  it("does not commit a fast but tiny jitter under the fling distance floor", () => {
    // 10px in 5ms = 2 px/ms — fast, but too short a distance to count as a
    // deliberate flick rather than a shaky lift-off.
    expect(
      decideSwipeCommit({ dx: 10, dy: 0, recentDx: 10, recentElapsedMs: 5 }),
    ).toBeNull();
  });

  it("does not commit a slow drag that crossed the fling distance floor but not the velocity floor", () => {
    // 40px in 200ms = 0.2 px/ms, below the fling velocity floor and below
    // the full distance threshold.
    expect(
      decideSwipeCommit({ dx: 40, dy: 0, recentDx: 40, recentElapsedMs: 200 }),
    ).toBeNull();
  });

  it("never commits a drag that moved more vertically than horizontally", () => {
    expect(
      decideSwipeCommit({
        dx: 100,
        dy: 150,
        recentDx: 100,
        recentElapsedMs: 300,
      }),
    ).toBeNull();
  });

  it("commits when horizontal movement equals vertical movement (the tie favors horizontal)", () => {
    expect(
      decideSwipeCommit({
        dx: 100,
        dy: 100,
        recentDx: 100,
        recentElapsedMs: 300,
      }),
    ).toBe("have");
  });

  it("handles a zero-duration recent window without dividing by zero", () => {
    expect(
      decideSwipeCommit({ dx: 120, dy: 0, recentDx: 120, recentElapsedMs: 0 }),
    ).toBe("have");
    expect(
      decideSwipeCommit({ dx: 10, dy: 0, recentDx: 10, recentElapsedMs: 0 }),
    ).toBeNull();
  });

  it("does not commit a perfectly still release", () => {
    expect(
      decideSwipeCommit({ dx: 0, dy: 0, recentDx: 0, recentElapsedMs: 300 }),
    ).toBeNull();
  });

  it("commits the direction the drag actually ended in (total dx), not the recent window's own sign", () => {
    // A contrived case — a real single continuous gesture never actually
    // disagrees like this — but the contract is that the committed
    // direction always reads off the total displacement.
    expect(
      decideSwipeCommit({
        dx: 120,
        dy: 0,
        recentDx: -30,
        recentElapsedMs: 500,
      }),
    ).toBe("have");
  });

  it("never commits a fling on a reversal that ends back at the origin", () => {
    // Drag left fast, reverse, release exactly where the drag began: total
    // displacement is zero, but the *recent* window (the final flick back)
    // easily clears both fling floors on its own. Without requiring
    // `distance > 0`, `dx > 0 ? "have" : "ranOut"` would fall through to
    // "ranOut" purely because `0 > 0` is false — sending the removal
    // mutation for a card that visually ended up right back where it
    // started.
    expect(
      decideSwipeCommit({ dx: 0, dy: 0, recentDx: 40, recentElapsedMs: 50 }),
    ).toBeNull();
  });

  it("never commits a fling on a reversal, in either recent direction", () => {
    expect(
      decideSwipeCommit({ dx: 0, dy: 0, recentDx: -40, recentElapsedMs: 50 }),
    ).toBeNull();
  });

  // ── Direction agreement: the `distance > 0` guard above only covers the
  // exact-origin reversal. A reversal that stops *short* of the origin still
  // has a non-zero total `dx` pointing the old way while the recent flick
  // points the new way — the fling must agree with the drag's own direction. ──

  it("does not commit a fling whose recent direction disagrees with the drag's total direction", () => {
    // Dragged left 30px, then flicked right 40px in the last 50ms — the
    // *net* displacement is still left (`dx: -30`), but the actual last
    // motion was rightward («есть»). Committing «кончилось» (from `dx`'s
    // sign) would send the removal mutation for a card the shopper just
    // pushed back the other way; springing back is correct.
    expect(
      decideSwipeCommit({ dx: -30, dy: 0, recentDx: 40, recentElapsedMs: 50 }),
    ).toBeNull();
  });

  it("does not commit the mirror-image disagreeing fling either", () => {
    // Dragged right 30px («есть» side), then flicked left 40px in the last
    // 50ms without crossing back past the origin.
    expect(
      decideSwipeCommit({ dx: 30, dy: 0, recentDx: -40, recentElapsedMs: 50 }),
    ).toBeNull();
  });

  it("still commits a fling whose recent direction agrees with the drag's own", () => {
    expect(
      decideSwipeCommit({ dx: -30, dy: 0, recentDx: -40, recentElapsedMs: 50 }),
    ).toBe("ranOut");
    expect(
      decideSwipeCommit({ dx: 30, dy: 0, recentDx: 40, recentElapsedMs: 50 }),
    ).toBe("have");
  });

  it("still commits on distance alone even when the recent flick disagrees", () => {
    // Past the 96px floor the drag is deliberate; a last-instant twitch back
    // toward the origin does not un-decide it (the card is visibly across).
    expect(
      decideSwipeCommit({
        dx: -120,
        dy: 0,
        recentDx: 30,
        recentElapsedMs: 50,
      }),
    ).toBe("ranOut");
  });

  // ── Recent-window velocity (finding 8): a long hold before a fast final
  // flick must still read as fast — averaging over the whole gesture's
  // elapsed time would dilute it into "slow". ──

  it("commits a deliberate flick that follows a long hold, using only the recent window's velocity", () => {
    // The finger sat still for 900ms, then flicked 40px in the final 50ms.
    // `dx` (total) is small and `recentElapsedMs` reflects only the flick
    // itself, not the 950ms the whole gesture took.
    expect(
      decideSwipeCommit({ dx: 40, dy: 0, recentDx: 40, recentElapsedMs: 50 }),
    ).toBe("have");
  });

  it("does not commit when the recent window itself was slow, even after a long total gesture", () => {
    // Same total displacement as above, but this time the caller reports a
    // slow recent window (as if averaged over the whole 950ms gesture) —
    // pins that `decideSwipeCommit` trusts `recentElapsedMs` as given and
    // never falls back to a total-gesture average on its own.
    expect(
      decideSwipeCommit({ dx: 40, dy: 0, recentDx: 40, recentElapsedMs: 950 }),
    ).toBeNull();
  });

  // ── Exact boundaries (finding 12) — pins `>=` so a future `>` typo or a
  // constant drift shows up as a failing test, not a silent behavior change. ──

  it("commits exactly at the fling distance floor with velocity exactly at the floor", () => {
    // 24px in 48ms = 0.5 px/ms — both floors met exactly, neither exceeded.
    expect(
      decideSwipeCommit({ dx: 24, dy: 0, recentDx: 24, recentElapsedMs: 48 }),
    ).toBe("have");
  });

  it("does not commit one px short of the fling distance floor, even at very high velocity", () => {
    // 23px in 1ms = 23 px/ms — velocity is nowhere near the limiting
    // factor; the distance floor alone rejects this.
    expect(
      decideSwipeCommit({ dx: 23, dy: 0, recentDx: 23, recentElapsedMs: 1 }),
    ).toBeNull();
  });

  it("does not commit just below the fling velocity floor, at exactly the distance floor", () => {
    // 24px in 49ms ≈ 0.49 px/ms — a hair under the velocity floor.
    expect(
      decideSwipeCommit({ dx: 24, dy: 0, recentDx: 24, recentElapsedMs: 49 }),
    ).toBeNull();
  });
});

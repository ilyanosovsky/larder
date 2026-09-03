"use client";

import { useEffect, useRef, useState } from "react";

/**
 * `"unsupported"` when `navigator.wakeLock` does not exist at all — the
 * iOS-standalone-PWA-under-18.4 case VISION §6.6 already names, and the only
 * one the cooking overlay renders anything for (its own honest hint).
 * `"active"`/`"inactive"` both mean "the API exists"; `"inactive"` covers
 * both "still requesting" and "the request itself was refused" (a battery
 * saver mode, an origin restriction) — the overlay does not distinguish
 * those, since neither has a different honest thing to say to a cook.
 */
export type WakeLockStatus = "unsupported" | "active" | "inactive";

/** `false` on the server (no `navigator`) and on any browser without the Screen Wake Lock API — iOS standalone below 18.4 chief among them (VISION §6.6). */
function wakeLockSupported(): boolean {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

/**
 * Keeps the screen on for as long as the caller stays mounted — the cooking
 * overlay's whole life, and nothing longer (DESIGN_BRIEF S9: «Экран не
 * гаснет»).
 *
 * **Re-requests on `visibilitychange`, never on a timer.** The platform
 * releases every `WakeLockSentinel` the instant its tab is hidden — there is
 * no way to hold the lock through a backgrounding, only to ask again the
 * moment the tab is visible again (requesting while hidden throws in every
 * implementation, so the effect only ever calls `request()` when
 * `document.visibilityState === "visible"`). The sentinel's own `"release"`
 * event, not a locally-tracked boolean, is what clears the ref back to
 * `null` — that event also fires for a release this hook never asked for
 * (the OS taking the lock away, e.g. a low-battery mode).
 *
 * **No NoSleep.js-style looped-video fallback.** VISION §6.6 sanctions the
 * honest hint over it deliberately: a silent looped `<video>` drains battery
 * for the whole session, can steal audio focus from whatever the cook is
 * listening to, and iOS standalone PWAs below 18.4 are exactly the
 * environment where autoplaying *any* media without a fresh gesture is
 * itself unreliable — the hack would not even reliably work where it is
 * needed. `wakeLockSupported()` being `false` is the honest end state, not
 * a gap this hook tries to paper over.
 */
export function useWakeLock(): WakeLockStatus {
  // Starts `"inactive"` unconditionally — never `wakeLockSupported() ?
  // "inactive" : "unsupported"` computed during render (a CodeRabbit finding
  // on this PR). `navigator` differs between a server render and the
  // client's first render, so branching on it inside the initializer risked
  // exactly the hydration-mismatch bug class `useIsOnline` (`src/lib/sync/
  // use-is-online.ts`) already documents a fix for — this hook currently
  // only ever mounts client-side, post-hydration (`cooking-overlay.tsx`'s
  // own doc comment), but making the hook correct on its own rather than
  // relying on that caller detail is the same discipline. Detection instead
  // happens inside the effect below, which only ever runs on the client.
  const [status, setStatus] = useState<WakeLockStatus>("inactive");
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!wakeLockSupported()) {
      setStatus("unsupported");
      return;
    }

    // Guards the async `request()` below against resolving after this
    // effect has already cleaned up (StrictMode's mount→unmount→remount, or
    // the overlay closing mid-request) — without it, a sentinel could be
    // stashed into `sentinelRef` and left un-released after the component
    // that owns it is already gone.
    let cancelled = false;
    // A second guard, orthogonal to `cancelled` (CodeRabbit finding on this
    // PR): `visibilitychange` can fire while the very first `request()` is
    // still pending — `sentinelRef.current` reads `null` right up until it
    // resolves, so without this a rapid hide→show would start a *second*
    // concurrent request. If both later resolved, only the last one written
    // to `sentinelRef` would ever get released on cleanup, leaking the other.
    let pending = false;

    async function acquire() {
      if (pending) {
        return;
      }
      pending = true;
      try {
        const sentinel = await navigator.wakeLock.request("screen");

        if (cancelled) {
          void sentinel.release().catch(() => {});
          return;
        }

        sentinelRef.current = sentinel;
        setStatus("active");

        sentinel.addEventListener("release", () => {
          // Only clear the ref (and re-arm re-acquisition) if this sentinel
          // is still the one this hook is tracking — a stale listener from
          // an already-superseded sentinel must not clobber a newer one.
          if (sentinelRef.current === sentinel) {
            sentinelRef.current = null;
            setStatus("inactive");
          }
        });
      } catch {
        // Refused (battery saver, an origin restriction) — the honest
        // `"inactive"` state, same as "never requested".
        if (!cancelled) {
          setStatus("inactive");
        }
      } finally {
        pending = false;
      }
    }

    void acquire();

    function onVisibilityChange() {
      if (
        document.visibilityState === "visible" &&
        sentinelRef.current === null &&
        !pending
      ) {
        void acquire();
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel) {
        void sentinel.release().catch(() => {});
      }
    };
  }, []);

  return status;
}

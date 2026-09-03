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
  const [status, setStatus] = useState<WakeLockStatus>(() =>
    wakeLockSupported() ? "inactive" : "unsupported",
  );
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!wakeLockSupported()) {
      return;
    }

    // Guards the async `request()` below against resolving after this
    // effect has already cleaned up (StrictMode's mount→unmount→remount, or
    // the overlay closing mid-request) — without it, a sentinel could be
    // stashed into `sentinelRef` and left un-released after the component
    // that owns it is already gone.
    let cancelled = false;

    async function acquire() {
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
      }
    }

    void acquire();

    function onVisibilityChange() {
      if (
        document.visibilityState === "visible" &&
        sentinelRef.current === null
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

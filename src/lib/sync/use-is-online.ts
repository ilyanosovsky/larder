"use client";

import { onlineManager } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

/** `onlineManager` is already an external store; this is the adapter shape. */
function subscribe(onStoreChange: () => void): () => void {
  return onlineManager.subscribe(onStoreChange);
}

function getSnapshot(): boolean {
  return onlineManager.isOnline();
}

/**
 * The server has no opinion about the *browser's* connection, and rendering
 * «Нет связи» into HTML that by definition arrived over the network would be
 * absurd. Always online on the server, so the client's first render matches
 * and the banner appears only once `onlineManager` says otherwise.
 */
function getServerSnapshot(): boolean {
  return true;
}

/**
 * Whether TanStack Query considers the app online — the banner in mockup 1c
 * and the header's offline mark.
 *
 * Deliberately **not** a `navigator.onLine` read: `onlineManager` is the same
 * source of truth that decides whether a mutation runs or pauses, so a banner
 * driven by it can never disagree with what the queue is actually doing. It
 * is also overridable (`onlineManager.setOnline`), which is how the offline
 * path can be exercised by hand in a browser.
 */
export function useIsOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Seeds `onlineManager` from `navigator.onLine` once, at client creation.
 *
 * It starts out optimistically `true` and only ever moves on the window's
 * `online`/`offline` events — so a tab that is *loaded* while offline (a
 * back-forward-cache restore, a reload served from the HTTP cache) would
 * report online until the connection came back, and every mutation made in
 * that window would fail outright instead of joining the queue. Reading the
 * browser's own flag once at startup is what makes "opened it offline"
 * behave like "went offline while it was open".
 *
 * Safe to call before anything subscribes: `setOnline` only notifies on an
 * actual change, and the window listeners it does not touch stay in charge
 * from then on.
 */
export function primeOnlineManager(): void {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.onLine !== "boolean"
  ) {
    return;
  }

  onlineManager.setOnline(navigator.onLine);
}

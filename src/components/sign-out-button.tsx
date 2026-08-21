"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import { LOGIN_PATH } from "@/lib/auth-redirect";

import styles from "./sign-out-button.module.css";

/**
 * How long signing out waits for the offline queue to land, in ms. Long
 * enough for a handful of writes on a slow connection, short enough that
 * «Выйти» never feels stuck.
 */
const QUEUE_FLUSH_TIMEOUT_MS = 2000;

export function SignOutButton() {
  const t = useTranslations("auth");
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);

    try {
      /**
       * One bounded attempt to land the offline queue, **before** the session
       * is invalidated — after `signOut()` every queued write would come back
       * UNAUTHORIZED, and after `clear()` there would be nothing left to send.
       *
       * An attempt, not a guarantee. `resumePausedMutations` resolves
       * immediately when the device is offline, and the race caps how long
       * signing out can be held up by a slow one. Whatever has not landed by
       * then is dropped together with the cache below: the auth boundary wins
       * over an undelivered tap, because the alternative is keeping one
       * person's writes on a device the next person is about to sign in on.
       */
      await Promise.race([
        queryClient.resumePausedMutations(),
        new Promise((resolve) => setTimeout(resolve, QUEUE_FLUSH_TIMEOUT_MS)),
      ]);

      // Better Auth client methods resolve with { data, error } instead of
      // rejecting — an error must block navigation, or the login page would
      // bounce the still-active session straight back home.
      const { error } = await authClient.signOut();
      if (error) {
        setFailed(true);
        setPending(false);
        return;
      }

      // Signing out does not reload the page, so the query cache — a
      // singleton for the tab's lifetime — would otherwise outlive the
      // session, and since task 2.4 it is written to IndexedDB as well.
      // Another person signing in on this device would then be shown the
      // previous household's cart out of storage. Clearing also emits the
      // cache events the persister listens to, so the stored copy goes with
      // it.
      queryClient.clear();

      router.replace(LOGIN_PATH);
      // Drop the cached server-rendered tree so the shell cannot be shown
      // from the router cache after the session cookie is gone.
      router.refresh();
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <div className={styles.wrapper}>
      <button
        type="button"
        className={styles.button}
        onClick={signOut}
        disabled={pending}
      >
        {pending ? t("signOutPending") : t("signOut")}
      </button>
      {failed ? (
        <p className={styles.error} role="alert">
          {t("error")}
        </p>
      ) : null}
    </div>
  );
}

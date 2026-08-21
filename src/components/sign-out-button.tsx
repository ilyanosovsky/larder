"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import { LOGIN_PATH } from "@/lib/auth-redirect";

import styles from "./sign-out-button.module.css";

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
      // it. A queued offline change is dropped along the way: reaching this
      // line means `signOut()` just made a successful request, so the queue
      // had already been delivered.
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

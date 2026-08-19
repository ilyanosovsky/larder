"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import { LOGIN_PATH } from "@/lib/auth-redirect";

import styles from "./sign-out-button.module.css";

export function SignOutButton() {
  const t = useTranslations("auth");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);

    try {
      await authClient.signOut();
      router.replace(LOGIN_PATH);
      // Drop the cached server-rendered tree so the shell cannot be shown
      // from the router cache after the session cookie is gone.
      router.refresh();
    } catch {
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
    </div>
  );
}

"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { HOME_PATH } from "@/lib/auth-redirect";
import { useTRPC } from "@/trpc/client";

import styles from "./invite-screen.module.css";

/** «Вступить» — the only interactive part of the join screen. */
export function JoinInviteButton({ token }: { token: string }) {
  const t = useTranslations("invite");
  const trpc = useTRPC();
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  const accept = useMutation(trpc.invite.accept.mutationOptions());

  async function join() {
    setFailed(false);

    try {
      await accept.mutateAsync({ token });
      router.push(HOME_PATH);
      // The household gate in the (app) layout must see the new membership,
      // so the cached server tree has to go.
      router.refresh();
    } catch {
      setFailed(true);
      // Whatever went wrong — the link was claimed a second ago, or this user
      // joined elsewhere in another tab — the server knows the truth. Re-render
      // the page so it states it instead of leaving a stale «Вступить».
      router.refresh();
    }
  }

  return (
    <>
      <button
        type="button"
        className={styles.primaryButton}
        onClick={() => void join()}
        disabled={accept.isPending}
      >
        {accept.isPending ? t("joinPending") : t("join")}
      </button>
      {failed ? (
        <p className={styles.error} role="alert">
          {t("error")}
        </p>
      ) : null}
    </>
  );
}

"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { HOME_PATH } from "@/lib/auth-redirect";
import { useTRPC } from "@/trpc/client";

import styles from "./onboarding-screen.module.css";

/**
 * S2 «Онбординг household» (DESIGN_BRIEF §4).
 *
 * Two paths, exactly one of which needs a form: creating a household, and
 * joining one — the latter happens entirely through the invite link, so there
 * is deliberately no "paste your token here" field to get wrong.
 */
export function OnboardingScreen() {
  const t = useTranslations("onboarding");
  const trpc = useTRPC();
  const router = useRouter();
  const nameFieldId = useId();
  const linkFieldId = useId();

  const [name, setName] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const createHousehold = useMutation(trpc.household.create.mutationOptions());
  const createInvite = useMutation(trpc.invite.create.mutationOptions());

  const busy = createHousehold.isPending || createInvite.isPending;

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailed(false);

    try {
      await createHousehold.mutateAsync({ name });
      // The link is minted right away: the reward for creating a household is
      // something to send your partner, not an empty screen.
      const invite = await createInvite.mutateAsync();
      setInviteLink(invite.url);
    } catch {
      setFailed(true);
    }
  }

  async function copyLink(link: string) {
    setCopyFailed(false);

    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard permission, or an insecure context — the link stays
      // visible and selectable, so this is a nudge rather than a failure.
      setCopyFailed(true);
    }
  }

  function goToApp() {
    setLeaving(true);
    router.push(HOME_PATH);
    // Drop the cached server tree so the household gate in the (app) layout
    // re-runs against the membership that now exists.
    router.refresh();
  }

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        {inviteLink === null ? (
          <>
            <h1 className={styles.title}>{t("title")}</h1>
            <p className={styles.subtitle}>{t("subtitle")}</p>

            <form className={styles.form} onSubmit={create}>
              <label className={styles.label} htmlFor={nameFieldId}>
                {t("nameLabel")}
              </label>
              <input
                id={nameFieldId}
                className={styles.input}
                type="text"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("namePlaceholder")}
                maxLength={100}
                autoComplete="off"
                required
                disabled={busy}
              />
              <button
                type="submit"
                className={styles.primaryButton}
                disabled={busy || name.trim().length === 0}
              >
                {busy ? t("createPending") : t("create")}
              </button>
            </form>

            <section className={styles.aside}>
              <h2 className={styles.asideTitle}>{t("haveInviteTitle")}</h2>
              <p className={styles.asideHint}>{t("haveInviteHint")}</p>
            </section>
          </>
        ) : (
          <div>
            <h1 className={styles.title}>{t("readyTitle")}</h1>
            <p className={styles.readyHint}>{t("readyHint")}</p>

            <div className={styles.linkBlock}>
              <label className={styles.label} htmlFor={linkFieldId}>
                {t("linkLabel")}
              </label>
              <input
                id={linkFieldId}
                className={styles.linkField}
                type="text"
                value={inviteLink}
                readOnly
                onFocus={(event) => event.target.select()}
              />
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => void copyLink(inviteLink)}
              >
                {copied ? t("copied") : t("copy")}
              </button>
              {copyFailed ? (
                <p className={styles.error} role="alert">
                  {t("copyFailed")}
                </p>
              ) : null}
            </div>

            <button
              type="button"
              className={styles.primaryButton}
              onClick={goToApp}
              disabled={leaving}
            >
              {t("continue")}
            </button>
          </div>
        )}

        {failed ? (
          <p className={styles.error} role="alert">
            {t("error")}
          </p>
        ) : null}
      </div>
    </main>
  );
}

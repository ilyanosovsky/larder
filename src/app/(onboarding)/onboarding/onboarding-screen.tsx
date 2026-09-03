"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { InviteLink } from "@/components/invite-link";
import { ONBOARDING_KITCHEN_PATH } from "@/lib/auth-redirect";
import { isConflictError } from "@/lib/trpc-errors";
import { useTRPC } from "@/trpc/client";

import styles from "./onboarding-screen.module.css";

/**
 * S2 «Онбординг household» (DESIGN_BRIEF §4).
 *
 * Two paths, exactly one of which needs a form: creating a household, and
 * joining one — the latter happens entirely through the invite link, so there
 * is deliberately no "paste your token here" field to get wrong.
 *
 * The screen runs in two phases, and the split matters: once the household
 * exists it exists for good. Folding a failed invite mint back into the create
 * form would strand the user, because every retry would hit the "one household
 * per user" CONFLICT and show the same generic error forever. So the invite
 * step owns its own error and retry, and «Продолжить» is always available —
 * the link can be minted later, the household cannot be created twice.
 */
export function OnboardingScreen() {
  const t = useTranslations("onboarding");
  const trpc = useTRPC();
  const router = useRouter();
  const nameFieldId = useId();

  const [name, setName] = useState("");
  const [householdReady, setHouseholdReady] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [createFailed, setCreateFailed] = useState(false);
  const [inviteFailed, setInviteFailed] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const createHousehold = useMutation(trpc.household.create.mutationOptions());
  const createInvite = useMutation(trpc.invite.create.mutationOptions());

  async function mintInvite() {
    setInviteFailed(false);

    try {
      const invite = await createInvite.mutateAsync();
      setInviteLink(invite.url);
    } catch {
      setInviteFailed(true);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateFailed(false);

    try {
      await createHousehold.mutateAsync({ name });
    } catch (error) {
      // CONFLICT means the household is already there — this submit is a retry
      // after an earlier attempt got as far as creating it, or a second tab
      // got there first. Either way the work is done; move on.
      if (!isConflictError(error)) {
        setCreateFailed(true);
        return;
      }
    }

    // The link is minted right away: the reward for creating a household is
    // something to send your partner, not an empty screen.
    setHouseholdReady(true);
    await mintInvite();
  }

  function continueToKitchenProfile() {
    setLeaving(true);
    router.push(ONBOARDING_KITCHEN_PATH);
    // Drop the cached server tree so the next step's own household check
    // (and eventually the (app) layout's) re-runs against the membership
    // that now exists.
    router.refresh();
  }

  if (!householdReady) {
    return (
      <main className={styles.screen}>
        <div className={styles.card}>
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
              disabled={createHousehold.isPending}
            />
            <button
              type="submit"
              className={styles.primaryButton}
              disabled={createHousehold.isPending || name.trim().length === 0}
            >
              {createHousehold.isPending ? t("createPending") : t("create")}
            </button>
          </form>

          <section className={styles.aside}>
            <h2 className={styles.asideTitle}>{t("haveInviteTitle")}</h2>
            <p className={styles.asideHint}>{t("haveInviteHint")}</p>
          </section>

          {createFailed ? (
            <p className={styles.error} role="alert">
              {t("error")}
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>{t("readyTitle")}</h1>
        <p className={styles.readyHint}>{t("readyHint")}</p>

        {inviteLink === null ? (
          <div className={styles.linkBlock}>
            {createInvite.isPending ? (
              <p className={styles.pending} role="status">
                {t("linkPending")}
              </p>
            ) : (
              <>
                {inviteFailed ? (
                  <p className={styles.error} role="alert">
                    {t("linkFailed")}
                  </p>
                ) : null}
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void mintInvite()}
                >
                  {t("retryLink")}
                </button>
              </>
            )}
          </div>
        ) : (
          <div className={styles.linkBlock}>
            <InviteLink key={inviteLink} url={inviteLink} />
          </div>
        )}

        <button
          type="button"
          className={styles.primaryButton}
          onClick={continueToKitchenProfile}
          disabled={leaving}
        >
          {t("continue")}
        </button>
      </div>
    </main>
  );
}

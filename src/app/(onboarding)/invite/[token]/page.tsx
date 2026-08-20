import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { HOME_PATH, LOGIN_PATH, ONBOARDING_PATH } from "@/lib/auth-redirect";
import { getSession } from "@/lib/session";
import { caller } from "@/trpc/server";

import styles from "./invite-screen.module.css";
import { JoinInviteButton } from "./join-invite-button";

/**
 * The screen an invite link opens (DESIGN_BRIEF §4 S2, §5: «Аня приглашает
 * тебя в „Наш дом“»).
 *
 * Lives outside the `(app)` group on purpose: its whole audience is people
 * who do not have a household yet, and the household gate in that layout
 * would bounce them to onboarding before they ever saw the invitation. The
 * middleware still requires a session, so only signed-in visitors get here.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const session = await getSession();

  if (!session) {
    redirect(LOGIN_PATH);
  }

  const { token } = await params;
  const [t, preview] = await Promise.all([
    getTranslations("invite"),
    caller.invite.preview({ token }),
  ]);

  if (preview.status === "valid" && !preview.alreadyMember) {
    return (
      <main className={styles.screen}>
        <div className={styles.card}>
          <h1 className={styles.title}>
            {t("heading", {
              inviter: preview.inviterName,
              household: preview.householdName,
            })}
          </h1>
          <p className={styles.hint}>{t("hint")}</p>
          <div className={styles.actions}>
            <JoinInviteButton token={token} />
          </div>
        </div>
      </main>
    );
  }

  if (preview.status === "valid") {
    return (
      <main className={styles.screen}>
        <div className={styles.card}>
          <h1 className={styles.title}>
            {t("alreadyMemberTitle", { household: preview.householdName })}
          </h1>
          <p className={styles.hint}>{t("alreadyMemberHint")}</p>
          <div className={styles.actions}>
            <Link className={styles.link} href={HOME_PATH}>
              {t("openApp")}
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (preview.status === "otherHousehold") {
    return (
      <main className={styles.screen}>
        <div className={styles.card}>
          <h1 className={styles.title}>{t("otherHouseholdTitle")}</h1>
          <p className={styles.hint}>{t("otherHouseholdHint")}</p>
          <div className={styles.actions}>
            <Link className={styles.link} href={HOME_PATH}>
              {t("openApp")}
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>{t("invalidTitle")}</h1>
        <p className={styles.hint}>{t("invalidHint")}</p>
        <div className={styles.actions}>
          <Link className={styles.link} href={ONBOARDING_PATH}>
            {t("toOnboarding")}
          </Link>
        </div>
      </div>
    </main>
  );
}

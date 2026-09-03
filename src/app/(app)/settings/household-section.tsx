"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { InviteLink } from "@/components/invite-link";
import { SignOutButton } from "@/components/sign-out-button";
import { avatarInitial } from "@/lib/avatar-initial";
import { isCallerMember, isShareCancelled } from "@/lib/household-invite";
import { useIsOnline } from "@/lib/sync/use-is-online";
import { useTRPC } from "@/trpc/client";

import styles from "./settings-page.module.css";

function MemberAvatar({ name, image }: { name: string; image: string | null }) {
  return image ? (
    // Same reasoning as the header's own avatar (`app-header.tsx`): the URL
    // is an arbitrary OAuth/upload host, so `next/image`'s domain allowlist
    // buys nothing here.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt="" className={styles.householdMemberAvatarImage} />
  ) : (
    <span className={styles.householdMemberAvatarInitial} aria-hidden="true">
      {avatarInitial(name)}
    </span>
  );
}

/**
 * S12 «Дом» (task 7.1a) — household name, its members, and the invite link
 * that gets a partner in. Rendered first on `/settings`, above the kitchen
 * profile: this is the block a household is actually shared through, and
 * task 1.1 only ever minted the first link during `/onboarding` — once that
 * screen is behind you there was nowhere left to get one, which is the whole
 * reason this task exists.
 *
 * The identity line and `SignOutButton` live at the bottom of this section
 * rather than in the page footer, per `page.tsx`'s own doc comment: they are
 * "who is signed in, and a way out of it", which is a household-and-account
 * concern, not a free-floating page footer.
 *
 * **`invite.create` uses `networkMode: "always"`.** Like `dish.*`'s writes
 * (see the wiki), an invite is not in the persisted offline queue — with the
 * default `"online"` mode a tap made offline would *pause* before
 * `mutationFn` ran, the button would sit `aria-disabled` for the whole
 * outage, and the mint would die with the tab instead of failing visibly.
 *
 * **The mint button is guarded by a synchronous ref, not `mutation.isPending`
 * alone.** `isPending` lands a render after the tap; two fast taps before
 * that render would send two mints. `aria-disabled`, never `disabled` — a
 * disabled control drops the keyboard focus of the button just activated.
 *
 * **`navigator.share` is detected in a `useEffect`, never during render.** A
 * render-time `typeof navigator.share` check would hydrate differently on
 * the server (no `navigator`) than the client — the exact bug fixed in
 * PR #28's hydration pass.
 */
export function HouseholdSection({
  callerId,
  email,
}: {
  callerId: string;
  email: string;
}) {
  const t = useTranslations("settings");
  const format = useFormatter();
  const trpc = useTRPC();
  const online = useIsOnline();

  const household = useQuery(trpc.household.current.queryOptions());
  const data = household.data;

  const [invite, setInvite] = useState<{ url: string; expiresAt: Date } | null>(
    null,
  );
  const [minting, setMinting] = useState(false);
  const [inviteFailed, setInviteFailed] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  const mintingRef = useRef(false);

  const createInvite = useMutation(
    trpc.invite.create.mutationOptions({ networkMode: "always" }),
  );

  useEffect(() => {
    setCanShare(
      typeof navigator !== "undefined" &&
        typeof navigator.share === "function",
    );
  }, []);

  async function mintInvite() {
    if (mintingRef.current) {
      return;
    }
    mintingRef.current = true;
    setMinting(true);
    setInviteFailed(false);
    setShareFailed(false);

    try {
      const result = await createInvite.mutateAsync();
      setInvite(result);
    } catch {
      setInviteFailed(true);
    } finally {
      mintingRef.current = false;
      setMinting(false);
    }
  }

  async function share() {
    if (invite === null || data === null || data === undefined) {
      return;
    }
    setShareFailed(false);

    try {
      await navigator.share({
        title: t("householdShareTitle"),
        text: t("householdShareText", { household: data.household.name }),
        url: invite.url,
      });
    } catch (error) {
      // The person closing the share sheet is not a failure — only a real
      // rejection falls back to the copy hint already sitting right above.
      if (!isShareCancelled(error)) {
        setShareFailed(true);
      }
    }
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{t("householdTitle")}</h2>

      {data === undefined ? (
        <p className={styles.pending} role="status">
          {t("householdLoading")}
        </p>
      ) : household.isError || data === null ? (
        <div className={styles.error} role="alert">
          <p>{t("householdLoadFailed")}</p>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => void household.refetch()}
          >
            {t("householdRetry")}
          </button>
        </div>
      ) : (
        <>
          <p className={styles.householdName}>{data.household.name}</p>

          <ul className={styles.householdMemberList}>
            {data.members.map((member) => (
              <li key={member.userId} className={styles.householdMemberRow}>
                <span
                  className={styles.householdMemberAvatar}
                  role="img"
                  aria-label={member.name}
                >
                  <MemberAvatar name={member.name} image={member.image} />
                </span>
                <span className={styles.householdMemberName}>
                  {member.name}
                  {isCallerMember(member, callerId) ? (
                    <span className={styles.householdMemberYou}>
                      {t("householdYou")}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>

          <button
            type="button"
            className={styles.retryButton}
            aria-disabled={minting || undefined}
            onClick={() => void mintInvite()}
          >
            {minting
              ? t("householdInvitePending")
              : invite === null
                ? t("householdInvite")
                : t("householdNewLink")}
          </button>

          {inviteFailed ? (
            <p className={styles.error} role="alert">
              {t("householdInviteFailed")}
            </p>
          ) : null}

          {online ? null : (
            <p className={styles.pending}>{t("householdOffline")}</p>
          )}

          {invite === null ? null : (
            <div className={styles.householdLinkBlock} role="status">
              <InviteLink key={invite.url} url={invite.url} />

              <p className={styles.pending}>
                {t("householdInviteHint", {
                  date: format.dateTime(invite.expiresAt, {
                    day: "numeric",
                    month: "long",
                  }),
                })}
              </p>

              {canShare ? (
                <button
                  type="button"
                  className={styles.retryButton}
                  onClick={() => void share()}
                >
                  {t("householdShare")}
                </button>
              ) : null}

              {shareFailed ? (
                <p className={styles.error} role="alert">
                  {t("householdShareFailed")}
                </p>
              ) : null}
            </div>
          )}

          <div className={styles.householdIdentity}>
            <p className={styles.identity}>{t("signedInAs", { email })}</p>
            <SignOutButton />
          </div>
        </>
      )}
    </section>
  );
}

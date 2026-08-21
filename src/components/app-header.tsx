import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { useIsOnline } from "@/lib/sync/use-is-online";
import { useTRPC } from "@/trpc/client";

import styles from "./app-header.module.css";

/** One household member as the header draws them. */
export interface HeaderMember {
  userId: string;
  name: string;
  image: string | null;
}

/** The letter an avatar falls back to when a member has no picture. */
function avatarInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

function Avatar({ name, image }: { name: string; image: string | null }) {
  return image ? (
    // Avatar URLs come from OAuth providers or user uploads — an arbitrary
    // external host, so next/image's optimizer (which requires a configured
    // domain allowlist) is more than this minimal header needs.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt="" className={styles.avatarImage} />
  ) : (
    <span className={styles.avatarInitial} aria-hidden="true">
      {avatarInitial(name)}
    </span>
  );
}

/**
 * The household-context header (DESIGN_BRIEF §2, §4 S3): household name on the
 * left, the other members' avatars beside the caller's own, and a quiet sync
 * mark while the cart is talking to the server. The caller's avatar is the tap
 * target into Settings (S12).
 *
 * Not marked `"use client"` itself — like `nav-icons.tsx`/`nav-items.ts`, it is
 * only ever reached through `AppShell`, whose own directive already puts the
 * whole subtree in the client bundle.
 *
 * **Avatar order deviates from mockup 1a on purpose.** The mock draws the
 * caller first and overlaps the partner on top of them; here the partners come
 * first and the caller's link is last, so the one avatar that is also a 44px
 * tap target is never partly covered by a decorative one — and it stays where
 * it has been since task 1.4, at the right edge under the thumb.
 *
 * **The sync mark is DESIGN_BRIEF's «тихая иконка-часики», not a spinner.**
 * Idle shows nothing at all. Offline — the brief's third state, drawn as a
 * banner on S3 itself (mockup 1c) — takes the same slot as a quiet dot, and
 * takes it *first*: a paused mutation still counts as mutating, so without
 * that precedence the header would claim to be synchronising for as long as
 * the connection is gone.
 */
export function AppHeader({
  householdName,
  userName,
  userImage,
  partners,
}: {
  householdName: string;
  userName: string;
  userImage: string | null;
  /** Household members other than the caller, in join order. */
  partners: readonly HeaderMember[];
}) {
  const t = useTranslations("common");
  const trpc = useTRPC();

  // Scoped to the `cart` router rather than the whole cache: the mark means
  // "the shared list is catching up", and a settings screen saving its own
  // form is not that. `pathFilter()`/`pathKey()` are tRPC's router-level
  // key helpers, and TanStack matches keys by prefix — so one filter each
  // covers `cart.list`'s refetches and every `cart.*` mutation, including
  // the ones tasks 2.4/2.5 will add.
  const cartFetching = useIsFetching(trpc.cart.pathFilter());
  const cartMutating = useIsMutating({ mutationKey: trpc.cart.pathKey() });
  const offline = !useIsOnline();
  const syncing = !offline && (cartFetching > 0 || cartMutating > 0);

  return (
    <header className={styles.header}>
      <span className={styles.householdName}>{householdName}</span>

      {offline || syncing ? (
        <span
          className={styles.sync}
          role="status"
          aria-label={offline ? t("offline") : t("syncing")}
        >
          {offline ? (
            <span className={styles.offlineDot} aria-hidden="true" />
          ) : (
            <span className={styles.syncIcon} aria-hidden="true">
              🕐
            </span>
          )}
        </span>
      ) : null}

      <div className={styles.avatars}>
        {partners.map((member) => (
          <span
            key={member.userId}
            className={styles.avatar}
            role="img"
            aria-label={member.name}
          >
            <Avatar name={member.name} image={member.image} />
          </span>
        ))}

        <Link
          href="/settings"
          className={styles.avatarLink}
          aria-label={t("openSettingsAria")}
        >
          <Avatar name={userName} image={userImage} />
        </Link>
      </div>
    </header>
  );
}

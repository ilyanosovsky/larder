import { useTranslations } from "next-intl";
import Link from "next/link";

import styles from "./app-header.module.css";

/**
 * The slim household-context header (task 1.4): household name on the left,
 * the caller's own avatar on the right as the tap target into Settings
 * (S12) — DESIGN_BRIEF §2's "tapping your own avatar opens Settings", §4
 * S3. Shown on every `(app)` screen, mobile and desktop alike.
 *
 * Not marked `"use client"` itself — like `nav-icons.tsx`/`nav-items.ts`, it
 * is only ever reached through `AppShell`, whose own directive already puts
 * the whole subtree in the client bundle, so `useTranslations` (the client
 * hook, not the `next-intl/server` one) works here without a boundary of
 * its own.
 *
 * TODO(2.3): this is the minimal S3 header. The full version adds the
 * partner's avatar (mobile shows both participants' avatars) and the sync
 * indicator (online / syncing / offline).
 */
export function AppHeader({
  householdName,
  userName,
  userImage,
}: {
  householdName: string;
  userName: string;
  userImage: string | null;
}) {
  const t = useTranslations("common");
  const initial = userName.trim().charAt(0).toUpperCase() || "?";

  return (
    <header className={styles.header}>
      <span className={styles.householdName}>{householdName}</span>
      <Link
        href="/settings"
        className={styles.avatarLink}
        aria-label={t("openSettingsAria")}
      >
        {userImage ? (
          // Avatar URLs come from OAuth providers or user uploads — an
          // arbitrary external host, so next/image's optimizer (which
          // requires a configured domain allowlist) is more than this
          // minimal header needs.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={userImage} alt="" className={styles.avatarImage} />
        ) : (
          <span className={styles.avatarInitial} aria-hidden="true">
            {initial}
          </span>
        )}
      </Link>
    </header>
  );
}

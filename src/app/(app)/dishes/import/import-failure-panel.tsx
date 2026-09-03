"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { DishPhotoUpload, type UploadedPhoto } from "@/components/dish-photo-upload";
import {
  fallbackActions,
  importFailureCopyKey,
  type FallbackAction,
  type ImportFailureReason,
} from "@/lib/recipes/import-failure";

import styles from "./import-screen.module.css";

/**
 * S8.2's failure state (DESIGN_BRIEF S8.2) — the honest fork, not an error
 * screen.
 *
 * Amber and calm, never `--neg`: nothing broke. A photo the model could not
 * read is a fork in the road, and every branch below leads somewhere — the
 * ordering comes from `fallbackActions`, which also guarantees «вручную» is
 * always the last one.
 *
 * The «Вставить текст» action renders `aria-disabled` with «скоро» until task
 * 4.4 gives it a field. `aria-disabled` rather than `disabled` for the reason
 * this codebase repeats everywhere: a disabled control cannot be focused, so
 * a keyboard user would never learn the option exists.
 */
export function ImportFailurePanel({
  reason,
  partial,
  onRetryPhoto,
  onRetry,
  onPicked,
  onSoon,
  manualHref,
}: {
  reason: ImportFailureReason;
  partial: {
    title: string | null;
    photoUrl: string | null;
    photoKey: string | null;
  };
  /** Discards the photo that did not work, then reopens the picker. */
  onRetryPhoto: () => void;
  /** Runs the same import again — `aiUnavailable` only. */
  onRetry: () => void;
  onPicked: (photo: UploadedPhoto) => void;
  /** Announces «скоро» for an action task 4.4 has not landed yet. */
  onSoon: (label: string) => void;
  manualHref: string;
}) {
  const t = useTranslations("dishImport");
  const actions = fallbackActions(reason, { hasPhoto: partial.photoKey !== null });

  return (
    <div className={styles.failure}>
      {partial.photoUrl === null ? null : (
        // Dimmed rather than removed: seeing the screenshot that did not work
        // is what makes «попробуй другой» a sentence about something.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={styles.failedPhoto}
          src={partial.photoUrl}
          alt={t("photoAlt")}
          decoding="async"
          referrerPolicy="no-referrer"
        />
      )}

      <p className={styles.failureText}>{t(importFailureCopyKey(reason))}</p>

      <div className={styles.actions}>
        {actions.map((action, index) => (
          <Action
            key={action}
            action={action}
            primary={index === 0}
            onRetryPhoto={onRetryPhoto}
            onRetry={onRetry}
            onPicked={onPicked}
            onSoon={onSoon}
            manualHref={manualHref}
          />
        ))}
      </div>
    </div>
  );
}

function Action({
  action,
  primary,
  onRetryPhoto,
  onRetry,
  onPicked,
  onSoon,
  manualHref,
}: {
  action: FallbackAction;
  primary: boolean;
  onRetryPhoto: () => void;
  onRetry: () => void;
  onPicked: (photo: UploadedPhoto) => void;
  onSoon: (label: string) => void;
  manualHref: string;
}) {
  const t = useTranslations("dishImport");
  const className = primary ? styles.primaryAction : styles.secondaryAction;

  switch (action) {
    case "retryPhoto":
      return (
        <button type="button" className={className} onClick={onRetryPhoto}>
          {t("actionRetryPhoto")}
        </button>
      );
    case "usePhoto":
      return (
        <DishPhotoUpload
          className={styles.actionUpload}
          label={t("actionUsePhoto")}
          busyLabel={t("uploading")}
          errorLabels={{
            tooLarge: t("photoTooBig"),
            notAnImage: t("photoNotImage"),
            uploadFailed: t("uploadFailed"),
          }}
          onPicked={onPicked}
        />
      );
    case "useText":
      // Task 4.4 turns this into the inline field DESIGN_BRIEF S8.2 draws.
      return (
        <button
          type="button"
          className={className}
          aria-disabled="true"
          onClick={() => onSoon(t("actionUseText"))}
        >
          {t("actionUseText")} · {t("soon")}
        </button>
      );
    case "retry":
      return (
        <button type="button" className={className} onClick={onRetry}>
          {t("actionRetry")}
        </button>
      );
    case "manual":
      return (
        <Link className={styles.secondaryAction} href={manualHref}>
          {t("actionManual")}
        </Link>
      );
  }
}

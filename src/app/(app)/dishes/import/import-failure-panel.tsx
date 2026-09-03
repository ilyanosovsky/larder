"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import {
  DishPhotoUpload,
  type UploadedPhoto,
} from "@/components/dish-photo-upload";
import {
  fallbackActions,
  importFailureCopyKey,
  importSourceOf,
  type FallbackAction,
  type ImportFailureReason,
} from "@/lib/recipes/import-failure";
import { isTooLong, isWithinTextBounds } from "@/lib/recipes/import-input";

import styles from "./import-screen.module.css";

/**
 * S8.2's failure state (DESIGN_BRIEF S8.2) — the honest fork, not an error
 * screen.
 *
 * Amber and calm, never `--neg`: nothing broke. A page the server could not
 * read is a fork in the road, and every branch below leads somewhere — the
 * ordering comes from `fallbackActions`, which also guarantees «вручную» is
 * always the last one.
 *
 * **«Вставь текст рецепта» is a field, not a button.** DESIGN_BRIEF S8.2
 * spells the requirement out — «без тупика, сразу поля» — so the textarea is
 * rendered inline and focused when text is the *primary* way out (every URL
 * failure), and sits under the screenshot button when it is not (a login
 * wall, where a screenshot genuinely works better). One tap fewer at exactly
 * the moment somebody has already had one thing not work.
 */
export function ImportFailurePanel({
  reason,
  partial,
  onRetryPhoto,
  onRetry,
  onPicked,
  onUseText,
  initialText,
  manualHref,
  photoPickerHref,
  textPaneHref,
}: {
  reason: ImportFailureReason;
  /**
   * What the failure salvaged. `sourceUrl` is here for `importSourceOf`, not
   * for rendering: a reason alone cannot tell a screenshot from a link from a
   * paste, and all three reach this panel.
   */
  partial: {
    title: string | null;
    photoUrl: string | null;
    photoKey: string | null;
    sourceUrl: string | null;
  };
  /** Discards the photo that did not work, then reopens the picker. */
  onRetryPhoto: () => void;
  /** Runs the same import again — `aiUnavailable` only. */
  onRetry: () => void;
  /**
   * Where an uploaded photo goes. **Omit it on a screen that owns no picker**
   * (the review route): the action then renders as a link to S8.1 instead of
   * an uploader, so a person cannot upload a blob the screen would discard a
   * moment later.
   */
  onPicked?: (photo: UploadedPhoto) => void;
  /**
   * Where pasted text goes. Omitted on the review route for the same reason
   * as `onPicked`: that screen owns no import mutation, so the action becomes
   * a link back to S8.1's «Текстом» pane.
   */
  onUseText?: (text: string) => void;
  /**
   * What the person pasted, when the failure came from the text pane — so the
   * field they land on holds their words rather than starting empty.
   */
  initialText?: string;
  manualHref: string;
  /** Used for «Загрузить скриншот» when `onPicked` is absent. */
  photoPickerHref: string;
  /** Used for «Вставить текст» when `onUseText` is absent. */
  textPaneHref: string;
}) {
  const t = useTranslations("dishImport");
  const source = importSourceOf(partial);
  const actions = fallbackActions(reason, source);

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

      <p className={styles.failureText}>
        {t(importFailureCopyKey(reason, source))}
      </p>

      <div className={styles.actions}>
        {actions.map((action, index) => (
          <Action
            key={action}
            action={action}
            primary={index === 0}
            onRetryPhoto={onRetryPhoto}
            onRetry={onRetry}
            onPicked={onPicked}
            onUseText={onUseText}
            initialText={initialText}
            manualHref={manualHref}
            photoPickerHref={photoPickerHref}
            textPaneHref={textPaneHref}
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
  onUseText,
  initialText,
  manualHref,
  photoPickerHref,
  textPaneHref,
}: {
  action: FallbackAction;
  primary: boolean;
  onRetryPhoto: () => void;
  onRetry: () => void;
  onPicked?: (photo: UploadedPhoto) => void;
  onUseText?: (text: string) => void;
  /**
   * What the person pasted, when the failure came from the text pane — so the
   * field they land on holds their words rather than starting empty.
   */
  initialText?: string;
  manualHref: string;
  photoPickerHref: string;
  textPaneHref: string;
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
      if (onPicked === undefined) {
        return (
          <Link className={className} href={photoPickerHref}>
            {t("actionUsePhoto")}
          </Link>
        );
      }
      return (
        <DishPhotoUpload
          className={styles.actionUpload}
          label={t("actionUsePhoto")}
          busyLabel={t("uploading")}
          errorLabels={{
            tooLarge: t("photoTooBig"),
            notAnImage: t("photoNotImage"),
            uploadFailed: t("uploadFailed"),
            rateLimited: t("uploadRateLimited"),
          }}
          onPicked={onPicked}
        />
      );
    case "useText":
      if (onUseText === undefined) {
        return (
          <Link className={className} href={textPaneHref}>
            {t("actionUseText")}
          </Link>
        );
      }
      return (
        <TextFallback
          autoFocus={primary}
          initialText={initialText}
          onSubmit={onUseText}
        />
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

/**
 * The inline «вставь текст» field DESIGN_BRIEF S8.2 draws.
 *
 * Focused on mount when it is the primary way out — this component mounts
 * *because* an import failed, so the focus move is the answer to something
 * the person just did rather than a grab on page load.
 *
 * **Seeded once from `initialText`**, so a paste that came back «не рецепт»
 * is still on screen to be edited instead of asking for twenty thousand
 * characters a second time. Seeded once and not re-seeded: this is a field
 * somebody is typing in, and a prop change must never overwrite it.
 */
function TextFallback({
  autoFocus,
  initialText,
  onSubmit,
}: {
  autoFocus: boolean;
  initialText?: string;
  onSubmit: (text: string) => void;
}) {
  const t = useTranslations("dishImport");
  const [value, setValue] = useState(initialText ?? "");
  const [invalid, setInvalid] = useState(false);
  const valid = isWithinTextBounds(value);
  // The message is announced once by the live region; the association is
  // what re-reads it when the field regains focus (WCAG 4.1.3) — the same
  // pairing `SourcePane` makes on S8.1.
  const errorId = `${useId()}-error`;

  return (
    <form
      className={styles.fallbackText}
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) {
          setInvalid(true);
          return;
        }
        onSubmit(value.trim());
      }}
    >
      <textarea
        className={styles.fallbackTextField}
        aria-label={t("byTextFieldLabel")}
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={errorId}
        placeholder={t("byTextPlaceholder")}
        value={value}
        rows={3}
        // No `maxLength`: the browser would truncate a long paste silently
        // instead of letting the «слишком длинно» rule below refuse it.
        autoFocus={autoFocus}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
      />
      <p id={errorId} className={styles.fallbackTextHint} role="status">
        {invalid
          ? isTooLong(value)
            ? t("byTextTooLong")
            : t("byTextTooShort")
          : ""}
      </p>
      <button
        type="submit"
        className={styles.primaryAction}
        aria-disabled={valid ? undefined : "true"}
      >
        {t("byTextSubmit")}
      </button>
    </form>
  );
}

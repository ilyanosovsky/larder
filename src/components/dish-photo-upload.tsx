"use client";

import { useRef, useState } from "react";

import { compressImage } from "@/lib/images/compress";
import { isUploadLimitMessage } from "@/lib/images/upload-errors";
import { useUploadThing } from "@/lib/uploadthing";

import styles from "./dish-photo-upload.module.css";

export interface UploadedPhoto {
  readonly url: string;
  readonly key: string;
}

/**
 * «Добавить фото» / «Заменить фото» — the picker plus the whole
 * compress-then-upload path, in one control (task 4.3).
 *
 * **No `capture` attribute on the input.** The main road (VISION scenario Б)
 * is a screenshot already sitting in the gallery; `capture` forces the camera
 * on iOS and makes that flow impossible. `accept="image/*"` still offers the
 * camera on a phone — it just does not insist on it.
 *
 * The input is hidden and driven by a real `<button>` rather than wrapped in
 * a `<label>`: a label is not focusable, so a keyboard user would have to
 * find the bare file input to use this at all.
 *
 * Errors render **here**, next to the control that produced them, because
 * this component is dropped into other people's layouts (`DishForm`'s photo
 * slot) and has no idea whether a page-level message would even be visible.
 */
export function DishPhotoUpload({
  label,
  busyLabel,
  errorLabels,
  onPicked,
  autoFocus = false,
  className,
}: {
  label: string;
  /** «Готовлю фото…» / «Загружаю фото…» — shown while the control is busy. */
  busyLabel: string;
  errorLabels: {
    tooLarge: string;
    notAnImage: string;
    uploadFailed: string;
    /** The per-user upload cap — «подожди минуту», not «проверь связь». */
    rateLimited: string;
  };
  onPicked: (photo: UploadedPhoto) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  /** Synchronous: a second tap lands before `busy` has re-rendered. */
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Why the upload failed, captured from the hook's own callback.
   *
   * `startUpload` **swallows every non-abort error and resolves `undefined`**
   * (@uploadthing/react), so the `catch` below is unreachable for an upload
   * refusal and the `!first` branch is what renders. Without `onUploadError`
   * there is no channel at all: the cap's «Upload limit reached», an expired
   * session and a dropped connection all became «Проверь связь».
   */
  const failureRef = useRef<string | null>(null);

  const { startUpload } = useUploadThing("dishPhoto", {
    onUploadError: (error) => {
      failureRef.current = isUploadLimitMessage(error.message)
        ? errorLabels.rateLimited
        : errorLabels.uploadFailed;
    },
  });

  async function handle(file: File) {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    failureRef.current = null;

    try {
      const compressed = await compressImage(file);
      if (!compressed.ok) {
        setError(
          compressed.reason === "tooLarge"
            ? errorLabels.tooLarge
            : errorLabels.notAnImage,
        );
        return;
      }

      const uploaded = await startUpload([compressed.file]);
      const first = uploaded?.[0];

      if (!first) {
        setError(failureRef.current ?? errorLabels.uploadFailed);
        return;
      }

      onPicked({ url: first.serverData.url, key: first.serverData.fileKey });
    } catch {
      setError(errorLabels.uploadFailed);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        className={styles.button}
        // `aria-disabled`, never `disabled`: a disabled control drops the
        // focus off the button that was just activated.
        aria-disabled={busy}
        onClick={() => {
          if (!busyRef.current) {
            inputRef.current?.click();
          }
        }}
        autoFocus={autoFocus}
      >
        {busy ? busyLabel : label}
      </button>

      <input
        ref={inputRef}
        className={styles.input}
        type="file"
        accept="image/*"
        tabIndex={-1}
        // Hidden with `clip-path` rather than `display: none` so it stays
        // clickable — which also leaves it in the accessibility tree as a
        // second, browser-named «Выбрать файл» control right beside the real
        // button. `aria-hidden` removes that duplicate. Safe: it is not
        // tab-focusable and is only ever reached through
        // `inputRef.current?.click()`, which does not move focus into it.
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared before the async work so picking the *same* file again
          // after a failure still fires `change`.
          event.target.value = "";
          if (file) {
            void handle(file);
          }
        }}
      />

      {error === null ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

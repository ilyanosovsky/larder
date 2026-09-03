"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { AiProgress } from "@/components/ai-progress";
import {
  DishPhotoUpload,
  type UploadedPhoto,
} from "@/components/dish-photo-upload";
import type { ImportFailureReason } from "@/lib/recipes/import-failure";
import { isRateLimitedError } from "@/lib/trpc-errors";
import { useIsOnline } from "@/lib/sync/use-is-online";
import { useTRPC } from "@/trpc/client";

import { ImportFailurePanel } from "./import-failure-panel";
import styles from "./import-screen.module.css";

/**
 * S8.1 + S8.2 (DESIGN_BRIEF S8) — pick a source, watch it being read, and get
 * a fork in the road if it did not work.
 *
 * The whole screen is three phases and nothing else. The *result* lives at
 * `/dishes/import/[jobId]`, not here (decision D4): the draft is written into
 * `ai_jobs.output_json`, so a reload, a Back gesture or an iOS PWA eviction
 * while the user is in Photos cannot destroy a parse the household has
 * already paid for.
 *
 * Three rules this screen exists to keep:
 *
 * 1. **`networkMode: "always"` on the import mutation.** The global default
 *    pauses a mutation started offline, and a paused mutation's `mutateAsync`
 *    never resolves — the spinner would sit there for the whole outage. An
 *    import needs the network by definition, so it fails fast and says so.
 * 2. **The busy flag is a synchronous ref**, not render state: a second tap
 *    on «Загрузить фото» lands before React has re-rendered, and two uploads
 *    would mean two paid parses of the same screenshot.
 * 3. **A parse failure is a phase, not an error.** `fromPhoto` returns an
 *    outcome; only rate limiting throws.
 */

type Phase =
  | { kind: "source" }
  /** The upload's own progress is owned by `DishPhotoUpload`'s button. */
  | { kind: "parsing"; photoUrl: string }
  | {
      kind: "failed";
      reason: ImportFailureReason;
      partial: {
        title: string | null;
        photoUrl: string | null;
        photoKey: string | null;
      };
      jobId: string | null;
    };

export function ImportScreen() {
  const t = useTranslations("dishImport");
  const trpc = useTRPC();
  const router = useRouter();
  const searchParams = useSearchParams();
  const online = useIsOnline();

  const [phase, setPhase] = useState<Phase>({ kind: "source" });
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<{ text: string; seq: number } | null>(null);
  const hintSeq = useRef(0);
  const failureRef = useRef<HTMLDivElement>(null);
  /**
   * Set when the picker is re-shown after a failure, so focus follows the
   * user back instead of dropping to `<body>` — the same rescue as below, in
   * the other direction. `DishPhotoUpload` unmounts with the failure panel
   * and mounts again with S8.1, so React's own `autoFocus` is exactly the
   * right mechanism: it fires on that mount and never on a re-render.
   */
  const [refocusPicker, setRefocusPicker] = useState(false);
  /** Render state lands a re-render too late for a double tap. */
  const runningRef = useRef(false);

  const fromPhoto = useMutation(
    trpc.dishImport.fromPhoto.mutationOptions({ networkMode: "always" }),
  );
  const discardPhoto = useMutation(
    trpc.dishImport.discardPhoto.mutationOptions({ networkMode: "always" }),
  );

  /**
   * **Focus rescue.** The picker button is the element that had focus when it
   * was tapped, and the phase change unmounts the whole of S8.1 — so without
   * this, focus lands on `<body>` and the fallbacks the failure panel just
   * put on screen are reachable only by tabbing from the top of the page.
   * The recurring bug class this codebase already documents: any flow that
   * unmounts the focused element rescues focus explicitly.
   *
   * Only the failure phase is rescued. «Разбираю рецепт…» has nothing to
   * interact with and announces itself through `role="status"`; a `parsed`
   * result navigates, which resets focus on its own.
   */
  useEffect(() => {
    if (phase.kind === "failed") {
      failureRef.current?.focus();
    }
  }, [phase.kind]);

  /**
   * `?src=photo` — the S6 empty state and the source sheet's «📷 С фото» row.
   *
   * It focuses the picker; it deliberately does **not** click it. Browsers
   * only open a file dialog under transient user activation, and a tap that
   * caused a navigation does not carry activation into the new page — so an
   * auto-click would either be silently ignored or, worse, blocked with a
   * console warning while the user stared at an unchanged screen.
   */
  const focusPicker = searchParams.get("src") === "photo";

  async function runImport(photo: UploadedPhoto) {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    setError(null);
    setRefocusPicker(false);
    setPhase({ kind: "parsing", photoUrl: photo.url });

    try {
      const result = await fromPhoto.mutateAsync({ fileKey: photo.key });

      if (result.outcome === "parsed") {
        // `replace`, not `push`: Back from the review screen should return to
        // the library, not to a progress screen whose work is already done.
        router.replace(`/dishes/import/${result.jobId}`);
        return;
      }

      setPhase({
        kind: "failed",
        reason: result.outcome === "failed" ? result.reason : "aiUnavailable",
        partial: {
          title: result.partial.title,
          photoUrl: result.partial.photoUrl ?? photo.url,
          photoKey: result.partial.photoKey ?? photo.key,
        },
        jobId: result.jobId,
      });
    } catch (caught) {
      if (isRateLimitedError(caught)) {
        // Thrown, not an outcome, so the existing helper keeps working — and
        // so «вручную» is still one tap away. The photo goes back with it:
        // this screen forgets the key when it returns to the picker, so
        // keeping the blob would leak one every time somebody hits the limit.
        discardPhoto.mutate({ fileKey: photo.key });
        setError(t("rateLimited"));
        setPhase({ kind: "source" });
        setRefocusPicker(true);
        return;
      }

      // The call never came back, so there is no `jobId` to poll: the photo
      // is still uploaded and still ours, and «Ещё раз» spends it again
      // rather than asking for a new screenshot.
      setPhase({
        kind: "failed",
        reason: "aiUnavailable",
        partial: { title: null, photoUrl: photo.url, photoKey: photo.key },
        jobId: null,
      });
      if (!online) {
        setError(t("offline"));
      }
    } finally {
      runningRef.current = false;
    }
  }

  function announceSoon(action: string) {
    hintSeq.current += 1;
    setHint({ text: t("soonHint", { action }), seq: hintSeq.current });
  }

  /** «Другое фото»: the screenshot that failed is thrown away first. */
  function retryPhoto(fileKey: string | null) {
    if (fileKey !== null) {
      // Not awaited: the user is being taken back to the picker either way,
      // and an orphaned blob is hygiene, not correctness (R5).
      discardPhoto.mutate({ fileKey });
    }
    setPhase({ kind: "source" });
    setRefocusPicker(true);
    setError(null);
  }

  const manualHref =
    phase.kind === "failed" && phase.jobId !== null
      ? `/dishes/new?from=${phase.jobId}`
      : "/dishes/new";

  return (
    <section className={styles.screen}>
      <div className={styles.header}>
        <Link className={styles.back} href="/dishes">
          {t("back")}
        </Link>
        <h1 className={styles.title}>{t("title")}</h1>
      </div>

      {error === null ? null : (
        <p className={styles.error} role="alert">
          {error}{" "}
          <Link className={styles.errorLink} href="/dishes/new">
            {t("manualLink")}
          </Link>
        </p>
      )}

      {phase.kind === "parsing" ? (
        <AiProgress
          label={t("parsing")}
          hint={t("parsingHint")}
          photoUrl={phase.photoUrl}
          photoAlt={t("photoAlt")}
        />
      ) : null}

      {phase.kind === "failed" ? (
        // `tabIndex={-1}` so the rescue above has something to land on: the
        // container is programmatically focusable but stays out of the tab
        // order, so nobody tabs *into* a plain wrapper afterwards.
        <div ref={failureRef} tabIndex={-1} className={styles.failureShell}>
          <ImportFailurePanel
            reason={phase.reason}
            partial={phase.partial}
            manualHref={manualHref}
            photoPickerHref="/dishes/import?src=photo"
            onRetryPhoto={() => retryPhoto(phase.partial.photoKey)}
            onRetry={() => {
              if (
                phase.partial.photoKey !== null &&
                phase.partial.photoUrl !== null
              ) {
                void runImport({
                  key: phase.partial.photoKey,
                  url: phase.partial.photoUrl,
                });
              }
            }}
            onPicked={(photo) => void runImport(photo)}
            onSoon={announceSoon}
          />
        </div>
      ) : null}

      {phase.kind === "source" ? (
        <div className={styles.source}>
          <div className={styles.photoZone}>
            <span className={styles.photoIcon} aria-hidden="true">
              📷
            </span>
            <DishPhotoUpload
              label={t("photoZone")}
              busyLabel={t("compressing")}
              errorLabels={{
                tooLarge: t("photoTooBig"),
                notAnImage: t("photoNotImage"),
                uploadFailed: t("uploadFailed"),
              }}
              onPicked={(photo) => void runImport(photo)}
              autoFocus={focusPicker || refocusPicker}
            />
            <p className={styles.photoHint}>{t("photoZoneHint")}</p>
          </div>

          <div className={styles.divider}>
            <span className={styles.dividerWord}>{t("or")}</span>
          </div>

          {/* Rendered, not hidden: DESIGN_BRIEF S8.1 draws all three sources,
              and a pane that appears only in task 4.4 would make the screen
              change shape under someone who had learned it. `aria-disabled`
              so a keyboard user can still find out they exist. */}
          <SoonPane
            label={t("byUrl")}
            placeholder={t("byUrlPlaceholder")}
            soon={t("soon")}
            fieldLabel={t("soonHint", { action: t("byUrl") })}
            onActivate={() => announceSoon(t("byUrl"))}
          />
          <SoonPane
            label={t("byText")}
            placeholder={t("byTextPlaceholder")}
            soon={t("soon")}
            fieldLabel={t("soonHint", { action: t("byText") })}
            tall
            onActivate={() => announceSoon(t("byText"))}
          />

          <p className={styles.manual}>
            <Link className={styles.manualLink} href="/dishes/new">
              {t("manualLead")}
            </Link>
          </p>
        </div>
      ) : null}

      {/* Mounted for the screen's whole life so assistive tech is already
          watching it before any text arrives; the keyed child forces a real
          node replacement when the same hint fires twice in a row. */}
      <p className={styles.status} role="status">
        <span key={hint?.seq ?? "empty"}>{hint?.text ?? ""}</span>
      </p>
    </section>
  );
}

/**
 * A source pane DESIGN_BRIEF S8.1 draws but task 4.4 has not built yet.
 *
 * Rendered rather than hidden, so the screen does not change shape under
 * someone who has learned it — and `aria-disabled` rather than `disabled`, so
 * a keyboard user can still find out the option exists. The button's own text
 * is the field's placeholder («https://…»), which would be a useless
 * accessible name on its own, so `fieldLabel` carries «„По ссылке“ — скоро»
 * instead.
 */
function SoonPane({
  label,
  placeholder,
  soon,
  fieldLabel,
  tall = false,
  onActivate,
}: {
  label: string;
  placeholder: string;
  soon: string;
  fieldLabel: string;
  tall?: boolean;
  onActivate: () => void;
}) {
  return (
    <div className={styles.pane}>
      <div className={styles.paneHead}>
        <span className={styles.paneLabel}>{label}</span>
        <span className={styles.paneSoon}>{soon}</span>
      </div>
      <button
        type="button"
        className={tall ? styles.paneFieldTall : styles.paneField}
        aria-disabled="true"
        aria-label={fieldLabel}
        onClick={onActivate}
      >
        {placeholder}
      </button>
    </div>
  );
}

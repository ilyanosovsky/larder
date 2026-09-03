"use client";

import { onlineManager, useMutation } from "@tanstack/react-query";
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
import { isRateLimitedError, trpcErrorCode } from "@/lib/trpc-errors";
import type { ImportResultOutput } from "@/server/api/routers/dish-import";
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
 * Four rules this screen exists to keep:
 *
 * 1. **`networkMode: "always"` on every import mutation.** The global default
 *    pauses a mutation started offline, and a paused mutation's `mutateAsync`
 *    never resolves — the spinner would sit there for the whole outage. An
 *    import needs the network by definition, so it fails fast and says so.
 * 2. **The busy flag is a synchronous ref**, not render state: a second tap
 *    on «Разобрать» lands before React has re-rendered, and two runs would
 *    mean two paid parses of the same page.
 * 3. **A parse failure is a phase, not an error.** The router returns an
 *    outcome; only rate limiting and a refused URL throw.
 * 4. **Every failure remembers what to re-run.** «Ещё раз» has to replay the
 *    *same* import — the photo key, the URL, or the pasted text — and the
 *    result screen it lands on is the same one either way.
 */

/** What «Ещё раз» replays. */
type ImportRun =
  | { kind: "photo"; photo: UploadedPhoto }
  | { kind: "url"; url: string }
  | { kind: "text"; text: string };

type FailedPartial = {
  title: string | null;
  photoUrl: string | null;
  photoKey: string | null;
  sourceUrl: string | null;
};

type Phase =
  | { kind: "source" }
  /** The upload's own progress is owned by `DishPhotoUpload`'s button. */
  | { kind: "parsing"; source: ImportRun["kind"]; photoUrl: string | null }
  | {
      kind: "failed";
      reason: ImportFailureReason;
      partial: FailedPartial;
      jobId: string | null;
    };

const EMPTY_PARTIAL: FailedPartial = {
  title: null,
  photoUrl: null,
  photoKey: null,
  sourceUrl: null,
};

export function ImportScreen() {
  const t = useTranslations("dishImport");
  const trpc = useTRPC();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [phase, setPhase] = useState<Phase>({ kind: "source" });
  const [error, setError] = useState<string | null>(null);
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
  /** The last import started, so «Ещё раз» replays it rather than guessing. */
  const lastRunRef = useRef<ImportRun | null>(null);

  const mutationOptions = { networkMode: "always" } as const;
  const fromPhoto = useMutation(
    trpc.dishImport.fromPhoto.mutationOptions(mutationOptions),
  );
  const fromUrl = useMutation(
    trpc.dishImport.fromUrl.mutationOptions(mutationOptions),
  );
  const fromText = useMutation(
    trpc.dishImport.fromText.mutationOptions(mutationOptions),
  );
  const discardPhoto = useMutation(
    trpc.dishImport.discardPhoto.mutationOptions(mutationOptions),
  );

  /**
   * **Focus rescue.** The control the user just activated is unmounted by the
   * phase change — so without this, focus lands on `<body>` and the fallbacks
   * the failure panel just put on screen are reachable only by tabbing from
   * the top of the page. The recurring bug class this codebase already
   * documents: any flow that unmounts the focused element rescues focus
   * explicitly.
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
   * `?src=photo|url|text` — the S6 source sheet's rows and the S6 empty
   * state.
   *
   * It focuses the control; for the photo pane it deliberately does **not**
   * click it. Browsers only open a file dialog under transient user
   * activation, and a tap that caused a navigation does not carry activation
   * into the new page — so an auto-click would either be silently ignored
   * or, worse, blocked with a console warning while the user stared at an
   * unchanged screen.
   */
  const requested = searchParams.get("src");

  /**
   * One runner for all three sources.
   *
   * The three mutations differ only in their input, and everything around
   * them — the double-tap lock, the parsing phase, the navigation on
   * success, the rate-limit branch, the offline line — is identical. Three
   * copies of it is three places for the next fix to miss one.
   */
  async function runImport(run: ImportRun) {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    lastRunRef.current = run;
    setError(null);
    setRefocusPicker(false);
    setPhase({
      kind: "parsing",
      source: run.kind,
      photoUrl: run.kind === "photo" ? run.photo.url : null,
    });

    try {
      const result = await start(run);

      if (result.outcome === "parsed") {
        // `replace`, not `push`: Back from the review screen should return to
        // the library, not to a progress screen whose work is already done.
        router.replace(`/dishes/import/${result.jobId}`);
        return;
      }

      setPhase({
        kind: "failed",
        reason: result.outcome === "failed" ? result.reason : "aiUnavailable",
        partial: partialFor(run, result),
        jobId: result.jobId,
      });
    } catch (caught) {
      if (isRateLimitedError(caught)) {
        // Thrown, not an outcome, so the existing helper keeps working — and
        // so «вручную» is still one tap away. A photo goes back with it: this
        // screen forgets the key when it returns to the picker, so keeping
        // the blob would leak one every time somebody hits the limit.
        if (run.kind === "photo") {
          discardPhoto.mutate({ fileKey: run.photo.key });
        }
        setError(t("rateLimited"));
        setPhase({ kind: "source" });
        setRefocusPicker(true);
        return;
      }

      if (run.kind === "url" && trpcErrorCode(caught) === "BAD_REQUEST") {
        // The SSRF guard lives on the input schema (decision C.8), so a URL
        // pointing inside the network is refused *at validation* and there is
        // deliberately no job row to show — but the fork in the road is the
        // same one every other failure gets.
        setPhase({
          kind: "failed",
          reason: "blockedUrl",
          partial: { ...EMPTY_PARTIAL, sourceUrl: run.url },
          jobId: null,
        });
        return;
      }

      // The call never came back, so there is no `jobId` to poll. Whatever
      // the run was is still in hand, and «Ещё раз» spends it again rather
      // than asking for it a second time.
      setPhase({
        kind: "failed",
        reason: "aiUnavailable",
        partial: partialFor(run, null),
        jobId: null,
      });
      // Read from the store at failure time, not from the render that started
      // the import: that closure is frozen through compression, upload and a
      // parse that can take half a minute, so connectivity dropping in the
      // middle would show the generic failure with no «нет связи» line.
      // `onlineManager.isOnline()` is a synchronous field the window's own
      // `offline` listener writes, and it is the same source of truth
      // `useIsOnline()` and the header dot read.
      if (!onlineManager.isOnline()) {
        setError(t("offline"));
      }
    } finally {
      runningRef.current = false;
    }
  }

  function start(run: ImportRun): Promise<ImportResultOutput> {
    switch (run.kind) {
      case "photo":
        return fromPhoto.mutateAsync({ fileKey: run.photo.key });
      case "url":
        return fromUrl.mutateAsync({ url: run.url });
      case "text":
        return fromText.mutateAsync({ text: run.text });
    }
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
          label={phase.source === "url" ? t("parsingPage") : t("parsing")}
          hint={
            phase.source === "url" ? t("parsingPageHint") : t("parsingHint")
          }
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
            textPaneHref="/dishes/import?src=text"
            onRetryPhoto={() => retryPhoto(phase.partial.photoKey)}
            onRetry={() => {
              const run = lastRunRef.current;
              if (run !== null) {
                void runImport(run);
              }
            }}
            onPicked={(photo) => void runImport({ kind: "photo", photo })}
            onUseText={(text) => void runImport({ kind: "text", text })}
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
                rateLimited: t("uploadRateLimited"),
              }}
              onPicked={(photo) => void runImport({ kind: "photo", photo })}
              autoFocus={requested === "photo" || refocusPicker}
            />
            <p className={styles.photoHint}>{t("photoZoneHint")}</p>
          </div>

          <div className={styles.divider}>
            <span className={styles.dividerWord}>{t("or")}</span>
          </div>

          <SourcePane
            label={t("byUrl")}
            fieldLabel={t("byUrlFieldLabel")}
            placeholder={t("byUrlPlaceholder")}
            submitLabel={t("byUrlSubmit")}
            invalidLabel={t("byUrlInvalid")}
            hint={t("byUrlHint")}
            autoFocus={requested === "url"}
            isValid={looksLikeUrl}
            onSubmit={(url) => void runImport({ kind: "url", url })}
          />

          <SourcePane
            label={t("byText")}
            fieldLabel={t("byTextFieldLabel")}
            placeholder={t("byTextPlaceholder")}
            submitLabel={t("byTextSubmit")}
            invalidLabel={t("byTextTooShort")}
            hint={t("byTextHint")}
            autoFocus={requested === "text"}
            multiline
            isValid={isLongEnough}
            onSubmit={(text) => void runImport({ kind: "text", text })}
          />

          <p className={styles.manual}>
            <Link className={styles.manualLink} href="/dishes/new">
              {t("manualLead")}
            </Link>
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * What a failed import can still hand «создать вручную».
 *
 * The server's own `partial` wins where it has something — it saw the page's
 * `<title>` and we did not — and the run fills in what only the client knows
 * (the photo it just uploaded, the URL it just submitted). VISION's «без
 * тупика» is only true if the dead end still hands you something.
 */
function partialFor(
  run: ImportRun,
  result: ImportResultOutput | null,
): FailedPartial {
  const partial =
    result !== null && result.outcome !== "parsed"
      ? result.partial
      : EMPTY_PARTIAL;

  return {
    title: partial.title,
    photoUrl:
      partial.photoUrl ?? (run.kind === "photo" ? run.photo.url : null),
    photoKey:
      partial.photoKey ?? (run.kind === "photo" ? run.photo.key : null),
    sourceUrl: partial.sourceUrl ?? (run.kind === "url" ? run.url : null),
  };
}

/** The shape of a link, checked before a round trip rather than after one. */
export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/[^\s/]+\./i.test(value.trim());
}

/** `fromTextInput`'s own floor, so the refusal is instant instead of a 400. */
export function isLongEnough(value: string): boolean {
  return value.trim().length >= 20;
}

/**
 * One of S8.1's two typed sources.
 *
 * The validation is client-side **as well as** on the server, for one reason:
 * a person who pasted «povar.ru/…» without the scheme should be told so in
 * the field they are looking at, not after a spinner. The server's own rules
 * are still the ones that decide anything (`fromUrlInput` refuses a URL
 * pointing inside the network whatever this thinks of it).
 *
 * `aria-disabled` rather than `disabled` on the submit — the rule this
 * codebase repeats everywhere: a disabled control cannot hold focus, so
 * pressing it and having nothing happen is worse than pressing it and being
 * told why.
 */
function SourcePane({
  label,
  fieldLabel,
  placeholder,
  submitLabel,
  invalidLabel,
  hint,
  autoFocus = false,
  multiline = false,
  isValid,
  onSubmit,
}: {
  label: string;
  fieldLabel: string;
  placeholder: string;
  submitLabel: string;
  invalidLabel: string;
  hint: string;
  autoFocus?: boolean;
  multiline?: boolean;
  isValid: (value: string) => boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);

  function submit() {
    const trimmed = value.trim();
    if (!isValid(trimmed)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSubmit(trimmed);
  }

  return (
    <form
      className={styles.pane}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={styles.paneHead}>
        <span className={styles.paneLabel}>{label}</span>
      </div>

      {multiline ? (
        <textarea
          className={styles.paneFieldTall}
          aria-label={fieldLabel}
          placeholder={placeholder}
          value={value}
          rows={4}
          autoFocus={autoFocus}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
        />
      ) : (
        <input
          className={styles.paneField}
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={fieldLabel}
          placeholder={placeholder}
          value={value}
          autoFocus={autoFocus}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
        />
      )}

      <div className={styles.paneFoot}>
        <p className={styles.paneHint}>{invalid ? invalidLabel : hint}</p>
        <button
          type="submit"
          className={styles.paneSubmit}
          aria-disabled={isValid(value) ? undefined : "true"}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

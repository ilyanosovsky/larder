"use client";

import { onlineManager, useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { AiProgress } from "@/components/ai-progress";
import {
  DishPhotoUpload,
  type UploadedPhoto,
} from "@/components/dish-photo-upload";
import type { ImportFailureReason } from "@/lib/recipes/import-failure";
import {
  isTooLong,
  isWithinTextBounds,
  looksLikeUrl,
  MAX_IMPORT_TEXT,
} from "@/lib/recipes/import-input";
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
  /**
   * Which pane to focus when S8.1 comes back after a failure — the pane the
   * person was actually using, not always the photo picker.
   */
  const [refocusPane, setRefocusPane] = useState<"url" | "text" | null>(null);
  /**
   * **The panes' text lives here, not inside them.** A rate-limit refusal
   * returns to `phase: "source"`, which unmounts both panes — and a value
   * held in the pane's own `useState` would go with them, losing a URL the
   * person had just typed or up to twenty thousand characters they had
   * pasted, with nothing on screen to recover it from.
   */
  const [urlValue, setUrlValue] = useState("");
  const [textValue, setTextValue] = useState("");
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
   *
   * **And it yields when the panel has already placed focus inside itself.**
   * `autoFocus` runs in the layout phase, before this passive effect, so an
   * unconditional `.focus()` here took focus straight back off the inline
   * text field for the five reasons whose first fallback *is* that field —
   * landing it on an outline-less wrapper instead, one Tab away from the
   * thing the panel had just pointed at.
   */
  useEffect(() => {
    if (phase.kind !== "failed") {
      return;
    }
    const shell = failureRef.current;
    if (shell !== null && !shell.contains(document.activeElement)) {
      shell.focus();
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
    setRefocusPane(null);
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
        // Focus follows the pane that was refused, not always the picker: the
        // URL or the text is still in its field, and pointing somewhere else
        // would read as though it had been thrown away.
        setRefocusPicker(run.kind === "photo");
        setRefocusPane(run.kind === "photo" ? null : run.kind);
        return;
      }

      if (trpcErrorCode(caught) === "BAD_REQUEST") {
        // Input the server refuses before it opens a job row, so there is
        // deliberately no `jobId` — but the fork in the road is the same one
        // every other failure gets. The two cases are different sentences:
        // a URL pointing inside the network is `blockedUrl` (decision C.8's
        // validation rejection), and a paste past `MAX_IMPORT_TEXT` is
        // `tooLarge`, whose fallback brings the field back so it can be cut
        // down. Reporting either as `aiUnavailable` would offer «Ещё раз»,
        // which replays the identical input and fails identically forever.
        setPhase({
          kind: "failed",
          reason: run.kind === "url" ? "blockedUrl" : "tooLarge",
          partial:
            run.kind === "url"
              ? { ...EMPTY_PARTIAL, sourceUrl: run.url }
              : EMPTY_PARTIAL,
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
            // The words that just failed, so the field they land on holds
            // them rather than asking for twenty thousand characters twice.
            initialText={
              lastRunRef.current?.kind === "text"
                ? lastRunRef.current.text
                : undefined
            }
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
            hint={t("byUrlHint")}
            autoFocus={requested === "url" || refocusPane === "url"}
            value={urlValue}
            onChange={setUrlValue}
            invalidLabel={() => t("byUrlInvalid")}
            isValid={looksLikeUrl}
            onSubmit={(url) => void runImport({ kind: "url", url })}
          />

          <SourcePane
            label={t("byText")}
            fieldLabel={t("byTextFieldLabel")}
            placeholder={t("byTextPlaceholder")}
            submitLabel={t("byTextSubmit")}
            hint={t("byTextHint")}
            autoFocus={requested === "text" || refocusPane === "text"}
            multiline
            maxLength={MAX_IMPORT_TEXT}
            value={textValue}
            onChange={setTextValue}
            // Which rule failed, not just that one did: «слишком коротко»
            // under a wall of pasted text would be nonsense.
            invalidLabel={(value) =>
              isTooLong(value) ? t("byTextTooLong") : t("byTextTooShort")
            }
            isValid={isWithinTextBounds}
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
    photoUrl: partial.photoUrl ?? (run.kind === "photo" ? run.photo.url : null),
    photoKey: partial.photoKey ?? (run.kind === "photo" ? run.photo.key : null),
    sourceUrl: partial.sourceUrl ?? (run.kind === "url" ? run.url : null),
  };
}

/**
 * One of S8.1's two typed sources.
 *
 * The validation is client-side **as well as** on the server, for two
 * reasons: a person who pasted «povar.ru/…» without the scheme should be told
 * so in the field they are looking at rather than after a spinner, and a
 * paste past `MAX_IMPORT_TEXT` would otherwise come back as a `BAD_REQUEST`
 * the screen can only report as «попробуй ещё раз» — with the textarea
 * already unmounted, so the one action offered replays the same too-long
 * string forever. The server's rules still decide anything that matters
 * (`fromUrlInput` refuses a URL pointing inside the network whatever this
 * thinks of it).
 *
 * **The value is owned by the screen, not by this component.** A rate-limit
 * refusal unmounts both panes, and a local `useState` would take the typed
 * URL or the pasted recipe with it.
 *
 * `aria-disabled` rather than `disabled` on the submit — the rule this
 * codebase repeats everywhere: a disabled control cannot hold focus, so
 * pressing it and having nothing happen is worse than pressing it and being
 * told why. The telling is `aria-describedby` + `aria-invalid` + a
 * `role="status"` line, matching `TextFallback`; without them the message is
 * visible and nothing else, which is WCAG 4.1.3 all over.
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
  maxLength,
  value,
  onChange,
  isValid,
  onSubmit,
}: {
  label: string;
  fieldLabel: string;
  placeholder: string;
  submitLabel: string;
  /** Takes the value, so the message can name *which* rule failed. */
  invalidLabel: (value: string) => string;
  hint: string;
  autoFocus?: boolean;
  multiline?: boolean;
  maxLength?: number;
  value: string;
  onChange: (value: string) => void;
  isValid: (value: string) => boolean;
  onSubmit: (value: string) => void;
}) {
  const [invalid, setInvalid] = useState(false);
  // Both panes are mounted at once, so a literal id would collide and every
  // field would describe the same paragraph.
  const paneId = useId();
  const hintId = `${paneId}-hint`;
  const errorId = `${paneId}-error`;

  function submit() {
    const trimmed = value.trim();
    if (!isValid(trimmed)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSubmit(trimmed);
  }

  function change(next: string) {
    onChange(next);
    setInvalid(false);
  }

  const fieldProps = {
    "aria-label": fieldLabel,
    "aria-invalid": invalid ? ("true" as const) : undefined,
    // Both the resting hint and the error line: the hint explains the field,
    // the error says what to fix, and a reader that meets the field mid-form
    // should hear whichever is on screen.
    "aria-describedby": `${hintId} ${errorId}`,
    placeholder,
    value,
    autoFocus,
  };

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
          {...fieldProps}
          className={styles.paneFieldTall}
          rows={4}
          maxLength={maxLength}
          onChange={(event) => change(event.target.value)}
        />
      ) : (
        <input
          {...fieldProps}
          className={styles.paneField}
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={maxLength}
          onChange={(event) => change(event.target.value)}
        />
      )}

      <div className={styles.paneFoot}>
        <p className={styles.paneHints}>
          <span id={hintId} className={styles.paneHint}>
            {invalid ? "" : hint}
          </span>
          {/* Its own node, empty while the value is fine — a `role="status"`
              that also held the resting hint would announce the hint on every
              keystroke. Mounted for the pane's whole life so assistive tech
              is already watching it when the message arrives. */}
          <span id={errorId} className={styles.paneError} role="status">
            {invalid ? invalidLabel(value) : ""}
          </span>
        </p>
        <button
          type="submit"
          className={styles.paneSubmit}
          aria-disabled={isValid(value.trim()) ? undefined : "true"}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

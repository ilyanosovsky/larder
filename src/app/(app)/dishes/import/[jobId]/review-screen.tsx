"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { AiProgress } from "@/components/ai-progress";
import { DishForm } from "@/components/dish-form";
import { DishPhotoUpload } from "@/components/dish-photo-upload";
import type { RecipeDraft } from "@/lib/recipes/draft";
import { consumedDishIdOf } from "@/lib/recipes/import-consumption";
import { trpcErrorCode } from "@/lib/trpc-errors";
import type { ImportResultOutput } from "@/server/api/routers/dish-import";
import { useTRPC } from "@/trpc/client";

import { ImportFailurePanel } from "../import-failure-panel";
import styles from "../import-screen.module.css";

/**
 * S8.3 «Проверь результат» for an import (DESIGN_BRIEF S8.3).
 *
 * The draft is read back from `ai_jobs.output_json` rather than carried in
 * memory (decision D4), which is what makes this a real URL: reloading it,
 * coming back to it from the app switcher, or opening it on the other phone
 * all re-render the identical form.
 *
 * **The seed is frozen at mount**, keyed by the job id — the rule decision
 * D.1 states and the one phase-2 bug class this codebase keeps re-learning. A
 * job's `output_json` never changes after the parse closes, so in practice
 * there is nothing to re-seed *from*; the freeze is there so a background
 * refetch (superjson rebuilds every `Date`, defeating TanStack's structural
 * sharing) can never reach a half-edited recipe.
 *
 * A job that is still `running` polls: the mutation on S8.1 normally answers
 * first, but someone who reloaded that screen mid-parse arrives here with a
 * job in flight and would otherwise see a permanent empty state.
 */
const POLL_MS = 2_000;

export function ReviewScreen({ jobId }: { jobId: string }) {
  const t = useTranslations("dishImport");
  const trpc = useTRPC();
  const router = useRouter();

  const job = useQuery({
    ...trpc.dishImport.getJob.queryOptions({ jobId }),
    refetchInterval: (query) =>
      query.state.data?.outcome === "running" ? POLL_MS : false,
  });

  const discardPhoto = useMutation(
    trpc.dishImport.discardPhoto.mutationOptions({ networkMode: "always" }),
  );

  /** The first *settled* answer, and only that one. */
  const [seed, setSeed] = useState<SettledImport | null>(
    () => stableSeed(job.data) ?? null,
  );
  if (seed === null) {
    const next = stableSeed(job.data);
    if (next) {
      setSeed(next);
    }
  }

  // A failed import can have been consumed too: «создать вручную» saves with
  // the same job id, so reopening this URL afterwards must land on the dish
  // rather than re-offer a dead end whose «Другое фото» would try to discard
  // a photo the new dish is now showing.
  // Shared with `/dishes/new?from=`, so the two screens cannot answer the
  // question differently.
  const consumedDishId = consumedDishIdOf(job.data);

  // A draft already saved must not offer to create a second dish from the
  // same recipe. Redirecting in an effect rather than during render because
  // `router.replace` is a side effect; `replace` so Back does not bounce
  // straight back into the review form.
  useEffect(() => {
    if (consumedDishId !== null) {
      router.replace(`/dishes/${consumedDishId}`);
    }
  }, [consumedDishId, router]);

  const cancellingRef = useRef(false);
  /**
   * **Every** photo key this screen has seen, not just the current one.
   *
   * `DishForm` owns the photo state and hands it to the slot on each render,
   * so replacing A with B shows this ref both. Cancelling has to discard both:
   * A is only in `DishForm`'s `displacedKeysRef`, which is drained on a
   * *successful save* and therefore never on this path — so tracking only the
   * live key would leave A stored with no dish referencing it, and tracking
   * only the frozen seed key would leave B.
   *
   * Discarding a key that turns out to be in use is safe: `discardPhoto`
   * refuses any key a saved dish still points at.
   */
  const seenPhotoKeysRef = useRef(new Set<string>());

  function cancel(seedPhotoKey: string | null) {
    if (cancellingRef.current) {
      return;
    }
    cancellingRef.current = true;

    const keys = new Set(seenPhotoKeysRef.current);
    if (seedPhotoKey !== null) {
      keys.add(seedPhotoKey);
    }

    for (const fileKey of keys) {
      // Not awaited, and safe to lose: an orphaned blob is hygiene, not
      // correctness, and the server refuses any key a dish still references.
      discardPhoto.mutate({ fileKey });
    }
    router.push("/dishes");
  }

  if (seed === null) {
    if (job.isError) {
      return (
        <section className={styles.screen}>
          <Header title={t("reviewTitle")} />
          <p className={styles.error} role="alert">
            {trpcErrorCode(job.error) === "NOT_FOUND"
              ? t("reviewNotFound")
              : t("reviewFailed")}
          </p>
        </section>
      );
    }

    return (
      <section className={styles.screen}>
        <Header title={t("reviewTitle")} />
        <AiProgress
          label={
            job.data?.outcome === "running"
              ? t("reviewRunning")
              : t("reviewLoading")
          }
          hint={t("parsingHint")}
        />
      </section>
    );
  }

  if (seed.outcome === "failed") {
    return (
      <section className={styles.screen}>
        <Header title={t("title")} />
        <ImportFailurePanel
          reason={seed.reason}
          partial={seed.partial}
          manualHref={`/dishes/new?from=${jobId}`}
          // This route owns no picker: every photo action goes back to S8.1,
          // which owns the whole upload flow, rather than growing a second
          // copy of it here. Omitting `onPicked` is what turns «Загрузить
          // скриншот» into a link instead of an uploader whose result this
          // screen would immediately throw away.
          photoPickerHref="/dishes/import?src=photo"
          onRetryPhoto={() => {
            if (seed.partial.photoKey !== null) {
              discardPhoto.mutate({ fileKey: seed.partial.photoKey });
            }
            router.replace("/dishes/import?src=photo");
          }}
          onRetry={() => router.replace("/dishes/import?src=photo")}
          onSoon={() => undefined}
        />
      </section>
    );
  }

  const draft: RecipeDraft = seed.draft;

  return (
    <section className={styles.screen}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.backButton}
          onClick={() => cancel(draft.photoKey)}
        >
          {t("cancel")}
        </button>
        <h1 className={styles.title}>{t("reviewTitle")}</h1>
      </div>

      {/* Only the warnings that have copy — task 4.4's `normalizationFailed`
          is about a page import and has nothing to say on this route; an
          empty amber box would be worse than no box. */}
      {seed.warnings
        .filter(
          (warning) => warning === "noSteps" || warning === "noIngredients",
        )
        .map((warning) => (
          <p key={warning} className={styles.error}>
            {warning === "noSteps"
              ? t("warningNoSteps")
              : t("warningNoIngredients")}
          </p>
        ))}

      <DishForm
        initial={draft}
        target={{
          mode: "create",
          // Stored verbatim as `recipes.original_draft`: the base task 4.6
          // diffs its adaptation against and reverts to.
          originalDraft: draft,
          // Marks the job consumed on save, so this route redirects to the
          // dish instead of offering a second copy.
          jobId,
        }}
        photoUploadSlot={({ current, onPicked }) => {
          // Recorded during render and spent by «Отмена»; `DishForm` re-invokes
          // the slot whenever its photo state changes, so every key the form
          // has held passes through here exactly once.
          if (current.key !== null) {
            seenPhotoKeysRef.current.add(current.key);
          }
          return (
            <DishPhotoUpload
              label={t("replacePhoto")}
              busyLabel={t("compressing")}
              errorLabels={{
                tooLarge: t("photoTooBig"),
                notAnImage: t("photoNotImage"),
                uploadFailed: t("uploadFailed"),
                rateLimited: t("uploadRateLimited"),
              }}
              onPicked={onPicked}
            />
          );
        }}
      />
    </section>
  );
}

function Header({ title }: { title: string }) {
  const t = useTranslations("dishImport");

  return (
    <div className={styles.header}>
      <Link className={styles.back} href="/dishes">
        {t("back")}
      </Link>
      <h1 className={styles.title}>{title}</h1>
    </div>
  );
}

/**
 * An import that has finished one way or the other.
 *
 * A `running` job is deliberately **not** seedable — it is a state the screen
 * polls out of, and freezing it would leave a spinner that never resolved
 * even after the parse landed. Narrowing the type here rather than checking
 * for it again below is what keeps the render free of a branch that can never
 * run.
 */
type SettledImport = Extract<
  ImportResultOutput,
  { outcome: "parsed" | "failed" }
>;

function stableSeed(
  data: ImportResultOutput | undefined,
): SettledImport | null {
  if (!data || data.outcome === "running") {
    return null;
  }
  return data;
}

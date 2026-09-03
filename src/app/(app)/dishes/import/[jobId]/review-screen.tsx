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

  /** The first answer, and only that one. */
  const [seed, setSeed] = useState<ImportResultOutput | null>(
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
  const consumedDishId =
    job.data?.outcome === "running" ? null : (job.data?.consumedDishId ?? null);

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

  function cancel(photoKey: string | null) {
    if (cancellingRef.current) {
      return;
    }
    cancellingRef.current = true;

    if (photoKey !== null) {
      // Not awaited, and safe to lose: `discardPhoto` itself refuses a key any
      // saved dish still references, so the worst case is an orphaned blob.
      discardPhoto.mutate({ fileKey: photoKey });
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

  if (seed.outcome === "running") {
    return (
      <section className={styles.screen}>
        <Header title={t("title")} />
        <AiProgress
          label={t("reviewRunning")}
          hint={t("parsingHint")}
          photoAlt={t("photoAlt")}
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
          className={styles.back}
          onClick={() => cancel(draft.photoKey)}
        >
          {t("cancel")}
        </button>
        <h1 className={styles.title}>{t("reviewTitle")}</h1>
      </div>

      {seed.warnings.map((warning) => (
        <p key={warning} className={styles.error}>
          {warning === "noSteps"
            ? t("warningNoSteps")
            : warning === "noIngredients"
              ? t("warningNoIngredients")
              : null}
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
        photoUploadSlot={({ onPicked }) => (
          <DishPhotoUpload
            label={t("replacePhoto")}
            busyLabel={t("compressing")}
            errorLabels={{
              tooLarge: t("photoTooBig"),
              notAnImage: t("photoNotImage"),
              uploadFailed: t("uploadFailed"),
            }}
            onPicked={onPicked}
          />
        )}
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
 * What may be frozen as the form's seed.
 *
 * A `running` job is deliberately **not** seedable: it is a state the screen
 * polls out of, and freezing it would leave a spinner that never resolves
 * even after the parse landed.
 */
function stableSeed(
  data: ImportResultOutput | undefined,
): ImportResultOutput | null {
  if (!data || data.outcome === "running") {
    return null;
  }
  return data;
}

"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { z } from "zod";

import { DishForm } from "@/components/dish-form";
import { DishPhotoUpload } from "@/components/dish-photo-upload";
import { emptyDraft, type RecipeDraft } from "@/lib/recipes/draft";
import type { ImportResultOutput } from "@/server/api/routers/dish-import";
import { useTRPC } from "@/trpc/client";

import styles from "./new-dish-screen.module.css";

/**
 * The manual-create screen. It owns nothing but the heading — every field,
 * every rule and the save itself live in `DishForm`, which is the same
 * component the edit route and the import review render.
 *
 * The draft is built **once**, in a `useState` initializer: `emptyDraft()`
 * returns a fresh object each call, and a new one on every render would reset
 * nothing (the form seeds itself once) but would keep handing React a changed
 * prop for no reason.
 *
 * **`?from=<jobId>`** is the «создать вручную» exit from a failed import
 * (task 4.3): the title the parser did manage to read and the screenshot
 * already uploaded are carried over, so the dead end still hands you
 * something (VISION's «без тупика»). The form is not rendered until that job
 * has answered — a seed that arrived after mount could not reach the fields,
 * by design.
 */
export function NewDishScreen() {
  const t = useTranslations("dishForm");
  const importCopy = useTranslations("dishImport");
  const trpc = useTRPC();

  // Validated here as well as in `page.tsx`, and for a sharper reason than
  // saving a round trip: `jobId` is handed to `dish.create`, whose input
  // schema is `z.uuid().nullable()`. A mistyped or truncated link would
  // otherwise let the form render normally and then fail *every* save with a
  // BAD_REQUEST about a query parameter nobody can see.
  const fromParam = useSearchParams().get("from");
  const jobId = z.uuid().safeParse(fromParam).success ? fromParam : null;

  const job = useQuery({
    ...trpc.dishImport.getJob.queryOptions({ jobId: jobId ?? "" }),
    enabled: jobId !== null,
    // A failed import's own result is finished data; refetching it would only
    // hand the form a structurally new object it has already frozen.
    staleTime: Infinity,
    retry: false,
  });

  /**
   * Frozen the moment there is something to freeze — `EditDishScreen`'s rule,
   * for the same reason: superjson rebuilds every `Date` on a refetch, so a
   * seed re-derived per render would keep handing React a structurally new
   * object for a form that only ever reads it once.
   */
  const [seed, setSeed] = useState<RecipeDraft | null>(() =>
    jobId === null ? emptyDraft() : draftFrom(job.data),
  );

  if (seed === null && (job.data !== undefined || job.isError)) {
    // A job that cannot be read is not a reason to refuse a blank form.
    setSeed(draftFrom(job.data) ?? emptyDraft());
  }

  /**
   * The job this save is allowed to mark consumed — **only a failed one**.
   *
   * `?from=` accepts any job id the household owns, including one that parsed
   * successfully. That draft has its own review route, so `draftFrom` opens a
   * blank form for it; passing the id on anyway would let saving that blank
   * form stamp `consumedDishId` on the parsed job, and the review route would
   * then redirect to an empty manual dish instead of ever offering the recipe
   * it holds. A job still running must not be consumed either — it has not
   * finished deciding what it is.
   */
  const consumableJobId = job.data?.outcome === "failed" ? jobId : null;

  return (
    <section className={styles.screen}>
      <div className={styles.header}>
        <Link className={styles.back} href="/dishes">
          {t("back")}
        </Link>
        <h1 className={styles.title}>{t("createTitle")}</h1>
      </div>

      {seed === null ? (
        <p role="status">{t("loading")}</p>
      ) : (
        <DishForm
          initial={seed}
          target={{ mode: "create", jobId: consumableJobId }}
          photoUploadSlot={({ current, onPicked }) => (
            <DishPhotoUpload
              label={
                current.url === null
                  ? importCopy("addPhoto")
                  : importCopy("replacePhoto")
              }
              busyLabel={importCopy("compressing")}
              errorLabels={{
                tooLarge: importCopy("photoTooBig"),
                notAnImage: importCopy("photoNotImage"),
                uploadFailed: importCopy("uploadFailed"),
              }}
              onPicked={onPicked}
            />
          )}
        />
      )}
    </section>
  );
}

/**
 * What a failed import can honestly hand a blank form: the title the model
 * read before it gave up, and the screenshot that is already uploaded and
 * already owned by this household.
 *
 * A job that *parsed* never arrives here — that draft has its own review
 * route — so a `parsed` outcome falls through to an empty form rather than
 * silently opening a second editor on the same recipe.
 */
function draftFrom(result: ImportResultOutput | undefined): RecipeDraft | null {
  if (result === undefined) {
    return null;
  }

  if (result.outcome === "parsed") {
    return emptyDraft();
  }

  return {
    ...emptyDraft(),
    title: result.partial.title ?? "",
    photoUrl: result.partial.photoUrl,
    photoKey: result.partial.photoKey,
    // The dish did come from a photo, even though the parse did not work —
    // S7's source line should say so rather than claim it was typed by hand.
    sourceType: result.partial.photoKey === null ? "manual" : "photo",
  };
}

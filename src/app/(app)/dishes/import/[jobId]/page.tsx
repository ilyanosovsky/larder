import { notFound } from "next/navigation";
import { z } from "zod";

import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { ReviewScreen } from "./review-screen";

/**
 * S8.3 in review mode — «Проверь результат» (DESIGN_BRIEF S8.3).
 *
 * One prefetch: the job whose `output_json` holds the draft. **Not
 * `category.list`** — the blueprint asked for it, but task 4.2 established
 * that `DishForm`'s rebind sheet runs `AutocompleteSheet` in
 * `variant="product"`, both of whose paths return before the «Изменить
 * продукт» panel that is `category.list`'s only subscriber. Prefetching it
 * would be a household-scoped SELECT on every open for a query nobody
 * subscribes to; `/dishes/new` and `/dishes/[dishId]/edit` both document the
 * same conclusion.
 *
 * The segment is validated before it becomes a query, exactly as
 * `/dishes/[dishId]` does: `getJobInput` is `z.uuid()`, so a mis-shared URL
 * would otherwise reach tRPC as a `BAD_REQUEST` the screen would render as a
 * retryable failure whose retry fails identically.
 */
export default async function ImportReviewPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;

  if (!z.uuid().safeParse(jobId).success) {
    notFound();
  }

  prefetch(trpc.dishImport.getJob.queryOptions({ jobId }));

  return (
    <HydrateClient>
      <ReviewScreen jobId={jobId} />
    </HydrateClient>
  );
}

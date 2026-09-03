import { Suspense } from "react";
import { z } from "zod";

import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { NewDishScreen } from "./new-dish-screen";

/**
 * «✍️ Вручную» — S8.3 with an empty draft (DESIGN_BRIEF S6: «„Вручную“
 * открывает пустую форму блюда — ту же, что подэкран S8.3»).
 *
 * **Normally nothing is prefetched**: a blank form has no server state. The
 * rebind sheet fetches `product.search` on demand, and it runs in
 * `variant="product"`, which never reaches the «Изменить продукт» panel — so
 * `category.list`, the only thing that panel needs, would be a
 * household-scoped SELECT per render for a query nobody subscribes to.
 *
 * **`?from=<jobId>` is the one exception** (task 4.3): it is how a failed
 * import reaches «создать вручную» *prefilled*. The title the model did read
 * and the screenshot that is already uploaded come from `dishImport.getJob`,
 * server-side — the client never supplies a photo URL, which is the same rule
 * `fromPhoto` follows. Without the prefetch the form would mount blank and
 * then have to re-seed itself, which is precisely the bug class the frozen
 * seed exists to prevent.
 */
export default async function NewDishPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  const jobId = z.uuid().safeParse(from).success ? (from as string) : null;

  if (jobId !== null) {
    prefetch(trpc.dishImport.getJob.queryOptions({ jobId }));
  }

  return (
    <HydrateClient>
      <Suspense>
        <NewDishScreen />
      </Suspense>
    </HydrateClient>
  );
}

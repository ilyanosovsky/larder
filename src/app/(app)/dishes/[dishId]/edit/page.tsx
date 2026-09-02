import { notFound } from "next/navigation";
import { z } from "zod";

import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { EditDishScreen } from "./edit-dish-screen";

/**
 * S8.3 in edit mode — S7's «Редактировать» (DESIGN_BRIEF S7: «открывает форму
 * S8.3, предзаполненную данными блюда»).
 *
 * Two prefetches: the aggregate the form seeds from, and the departments the
 * rebind sheet's edit panel needs on its first tap.
 *
 * The route segment is validated before it becomes a query, exactly as
 * `/dishes/[dishId]` does: `dishIdInput` is `z.uuid()`, so a mis-shared URL
 * would otherwise reach tRPC as a `BAD_REQUEST` the screen would render as a
 * retryable failure whose retry fails identically.
 */
export default async function EditDishPage({
  params,
}: {
  params: Promise<{ dishId: string }>;
}) {
  const { dishId } = await params;

  if (!z.uuid().safeParse(dishId).success) {
    notFound();
  }

  prefetch(trpc.dish.get.queryOptions({ id: dishId }));
  prefetch(trpc.category.list.queryOptions());

  return (
    <HydrateClient>
      <EditDishScreen dishId={dishId} />
    </HydrateClient>
  );
}

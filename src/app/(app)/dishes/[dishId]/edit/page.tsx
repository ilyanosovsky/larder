import { notFound } from "next/navigation";
import { z } from "zod";

import { HydrateClient, prefetch, trpc } from "@/trpc/server";

import { EditDishScreen } from "./edit-dish-screen";

/**
 * S8.3 in edit mode — S7's «Редактировать» (DESIGN_BRIEF S7: «открывает форму
 * S8.3, предзаполненную данными блюда»).
 *
 * One prefetch: the aggregate the form seeds from. Not `category.list` — its
 * only subscriber is `ProductEditForm`, which the rebind sheet cannot reach in
 * `variant="product"` (both of its paths return before the quantity step).
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

  return (
    <HydrateClient>
      <EditDishScreen dishId={dishId} />
    </HydrateClient>
  );
}

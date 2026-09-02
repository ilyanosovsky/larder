import { NewDishScreen } from "./new-dish-screen";

/**
 * «✍️ Вручную» — S8.3 with an empty draft (DESIGN_BRIEF S6: «„Вручную“
 * открывает пустую форму блюда — ту же, что подэкран S8.3»).
 *
 * **Nothing is prefetched**, and there is nothing to hydrate: a blank form has
 * no server state. The rebind sheet fetches `product.search` on demand, and it
 * runs in `variant="product"`, which never reaches the «Изменить продукт»
 * panel — so `category.list`, the only thing that panel needs, would be a
 * household-scoped SELECT per render for a query nobody subscribes to.
 */
export default function NewDishPage() {
  return <NewDishScreen />;
}

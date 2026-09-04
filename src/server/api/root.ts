import { cartRouter } from "@/server/api/routers/cart";
import { categoryRouter } from "@/server/api/routers/category";
import { dishRouter } from "@/server/api/routers/dish";
import { dishImportRouter } from "@/server/api/routers/dish-import";
import { healthRouter } from "@/server/api/routers/health";
import { householdRouter } from "@/server/api/routers/household";
import { inviteRouter } from "@/server/api/routers/invite";
import { kitchenProfileRouter } from "@/server/api/routers/kitchen-profile";
import { menuRouter } from "@/server/api/routers/menu";
import { pantryRouter } from "@/server/api/routers/pantry";
import { productRouter } from "@/server/api/routers/product";
import { tripRouter } from "@/server/api/routers/trip";
import { createCallerFactory, createTRPCRouter } from "@/server/api/trpc";

/**
 * The single API surface. Every feature router (recipes, menu, assistant)
 * gets mounted here under its own namespace.
 */
export const appRouter = createTRPCRouter({
  health: healthRouter,
  household: householdRouter,
  invite: inviteRouter,
  category: categoryRouter,
  product: productRouter,
  cart: cartRouter,
  dish: dishRouter,
  dishImport: dishImportRouter,
  menu: menuRouter,
  pantry: pantryRouter,
  trip: tripRouter,
  kitchenProfile: kitchenProfileRouter,
});

/** Client-side type of the whole API. Import as `import type` only. */
export type AppRouter = typeof appRouter;

/**
 * Builds an in-process caller — no HTTP, no serialization. Used by server
 * components and server actions via `src/trpc/server.tsx`.
 */
export const createCaller = createCallerFactory(appRouter);

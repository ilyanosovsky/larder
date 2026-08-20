import { categoryRouter } from "@/server/api/routers/category";
import { healthRouter } from "@/server/api/routers/health";
import { householdRouter } from "@/server/api/routers/household";
import { inviteRouter } from "@/server/api/routers/invite";
import { productRouter } from "@/server/api/routers/product";
import { createCallerFactory, createTRPCRouter } from "@/server/api/trpc";

/**
 * The single API surface. Every feature router (cart, pantry, recipes, menu,
 * assistant) gets mounted here under its own namespace.
 */
export const appRouter = createTRPCRouter({
  health: healthRouter,
  household: householdRouter,
  invite: inviteRouter,
  category: categoryRouter,
  product: productRouter,
});

/** Client-side type of the whole API. Import as `import type` only. */
export type AppRouter = typeof appRouter;

/**
 * Builds an in-process caller — no HTTP, no serialization. Used by server
 * components and server actions via `src/trpc/server.tsx`.
 */
export const createCaller = createCallerFactory(appRouter);

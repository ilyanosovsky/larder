import { healthRouter } from "@/server/api/routers/health";
import { createCallerFactory, createTRPCRouter } from "@/server/api/trpc";

/**
 * The single API surface. Every feature router (cart, pantry, recipes, menu,
 * assistant) gets mounted here under its own namespace.
 */
export const appRouter = createTRPCRouter({
  health: healthRouter,
});

/** Client-side type of the whole API. Import as `import type` only. */
export type AppRouter = typeof appRouter;

/**
 * Builds an in-process caller — no HTTP, no serialization. Used by server
 * components and server actions via `src/trpc/server.tsx`.
 */
export const createCaller = createCallerFactory(appRouter);

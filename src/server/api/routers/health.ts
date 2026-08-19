import { z } from "zod";

import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "@/server/api/trpc";

/**
 * Output schemas live next to the router so a form or an AI structured output
 * can reuse the exact same contract. Nullable fields are declared with
 * `.nullable()`, never `.optional()` — OpenAI strict mode rejects optional
 * keys, and one schema has to serve both (VISION §6.2).
 */
export const pingOutput = z.object({
  ok: z.literal(true),
  /** A real Date, not a string — proves the superjson transformer is wired. */
  time: z.date(),
});

export const whoamiOutput = z.object({
  id: z.string().min(1),
  email: z.email(),
  name: z.string().nullable(),
});

export type PingOutput = z.infer<typeof pingOutput>;
export type WhoamiOutput = z.infer<typeof whoamiOutput>;

/**
 * Liveness + auth smoke router. Deliberately tiny: it exists to prove the
 * scaffold (context, transformer, protected boundary) end to end, and is the
 * template for the feature routers that follow.
 */
export const healthRouter = createTRPCRouter({
  ping: publicProcedure.output(pingOutput).query(() => ({
    ok: true as const,
    time: new Date(),
  })),

  whoami: protectedProcedure.output(whoamiOutput).query(({ ctx }) => ({
    id: ctx.user.id,
    email: ctx.user.email,
    name: ctx.user.name ?? null,
  })),
});

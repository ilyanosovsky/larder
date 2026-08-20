import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { kitchenProfiles } from "@/db/schema";
import { createTRPCRouter, householdProcedure } from "@/server/api/trpc";
import { normalizeEquipment } from "@/server/kitchen/equipment";

/**
 * Output schema lives next to the router so the S2 onboarding step and the
 * S12 settings section (task 1.4) render the exact same contract.
 */
export const kitchenProfileOutput = z.object({
  householdSize: z.int().min(1).max(10),
  equipment: z.array(z.string()),
});

export const updateKitchenProfileInput = z.object({
  householdSize: z.number().int().min(1).max(10),
  equipment: z.array(z.string().trim().min(1).max(40)).max(50),
});

export type KitchenProfileOutput = z.infer<typeof kitchenProfileOutput>;

const profileColumns = {
  householdSize: kitchenProfiles.householdSize,
  equipment: kitchenProfiles.equipment,
};

/**
 * A household's kitchen equipment + headcount (VISION §3.3, §5) — the S2
 * onboarding step (skippable) and the S12 settings section read and write
 * this and nothing else.
 */
export const kitchenProfileRouter = createTRPCRouter({
  /**
   * `null` means the household has never set one — S2 was skipped, or S12
   * has not been opened yet. The client treats that as the same defaults the
   * form starts from (size 2, no equipment), rather than the server baking
   * those defaults into a row nobody actually chose.
   */
  get: householdProcedure
    .output(kitchenProfileOutput.nullable())
    .query(async ({ ctx }) => {
      const [row] = await ctx.db
        .select(profileColumns)
        .from(kitchenProfiles)
        .where(eq(kitchenProfiles.householdId, ctx.household.id))
        .limit(1);

      return row ?? null;
    }),

  /**
   * Upserts the household's profile. There is no client-sent id to check —
   * the row this writes is always `ctx.household.id`'s own, from the
   * household procedure's own membership check, never a value the client
   * could redirect elsewhere (VISION §6.7).
   *
   * `normalizeEquipment` runs here, not only on the client: the client's own
   * add-a-chip flow already normalizes as it goes, but the server is the
   * actual boundary, so a request built by hand (or a future non-web client)
   * gets the same guarantee.
   */
  update: householdProcedure
    .input(updateKitchenProfileInput)
    .output(kitchenProfileOutput)
    .mutation(async ({ ctx, input }) => {
      const equipment = normalizeEquipment(input.equipment);

      const [updated] = await ctx.db
        .insert(kitchenProfiles)
        .values({
          householdId: ctx.household.id,
          householdSize: input.householdSize,
          equipment,
        })
        .onConflictDoUpdate({
          target: kitchenProfiles.householdId,
          set: {
            householdSize: input.householdSize,
            equipment,
            updatedAt: sql`now()`,
          },
        })
        .returning(profileColumns);

      if (!updated) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Kitchen profile upsert returned no row",
        });
      }

      return updated;
    }),
});

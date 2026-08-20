import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { householdMembers, households, users } from "@/db/schema";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { isUniqueViolation } from "@/server/db-errors";

/**
 * Output schemas live next to the router so a form or an AI structured output
 * can reuse the exact same contract. Nullable fields are declared with
 * `.nullable()`, never `.optional()` (VISION §6.2).
 */
export const householdOutput = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.date(),
});

export const householdMemberOutput = z.object({
  userId: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  joinedAt: z.date(),
});

/** `null` — not an error — while the caller has not finished onboarding. */
export const currentHouseholdOutput = z
  .object({
    household: householdOutput,
    members: z.array(householdMemberOutput),
  })
  .nullable();

export const createHouseholdInput = z.object({
  name: z.string().trim().min(1).max(100),
});

export type HouseholdOutput = z.infer<typeof householdOutput>;
export type CurrentHouseholdOutput = z.infer<typeof currentHouseholdOutput>;

/**
 * Households and their members (VISION §5). Both procedures are
 * `protectedProcedure` rather than `householdProcedure`: they are what a user
 * without a household calls, so requiring a membership would deadlock
 * onboarding.
 */
export const householdRouter = createTRPCRouter({
  /** The caller's household with its members, or null before onboarding. */
  current: protectedProcedure
    .output(currentHouseholdOutput)
    .query(async ({ ctx }) => {
      const [row] = await ctx.db
        .select({ household: households })
        .from(householdMembers)
        .innerJoin(households, eq(households.id, householdMembers.householdId))
        .where(eq(householdMembers.userId, ctx.user.id))
        .limit(1);

      if (!row) {
        return null;
      }

      const members = await ctx.db
        .select({
          userId: householdMembers.userId,
          name: users.name,
          image: users.image,
          joinedAt: householdMembers.joinedAt,
        })
        .from(householdMembers)
        .innerJoin(users, eq(users.id, householdMembers.userId))
        .where(eq(householdMembers.householdId, row.household.id))
        .orderBy(householdMembers.joinedAt);

      return { household: row.household, members };
    }),

  /**
   * Creates a household and makes the caller its first member. One household
   * per user (VISION §5): the pre-check gives a clean CONFLICT, the unique
   * index on `household_members.user_id` catches the concurrent case.
   */
  create: protectedProcedure
    .input(createHouseholdInput)
    .output(householdOutput)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      try {
        return await ctx.db.transaction(async (tx) => {
          const existing = await tx
            .select({ id: householdMembers.id })
            .from(householdMembers)
            .where(eq(householdMembers.userId, userId))
            .limit(1);

          if (existing.length > 0) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Already in a household",
            });
          }

          const [household] = await tx
            .insert(households)
            .values({ name: input.name })
            .returning();

          if (!household) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Household insert returned no row",
            });
          }

          await tx
            .insert(householdMembers)
            .values({ householdId: household.id, userId });

          return household;
        });
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Already in a household",
          });
        }
        throw error;
      }
    }),
});

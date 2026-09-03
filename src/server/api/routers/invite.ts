import { TRPCError } from "@trpc/server";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { householdMembers, households, invites, users } from "@/db/schema";
import { env } from "@/lib/env";
import {
  createTRPCRouter,
  householdProcedure,
  protectedProcedure,
} from "@/server/api/trpc";
import { isUniqueViolation } from "@/server/db-errors";
import {
  createInviteToken,
  decideInviteAccept,
  inviteExpiryFrom,
  inviteUrl,
  previewInvite,
} from "@/server/invites";

export const createInviteOutput = z.object({
  /** Absolute link to share — the screen behind it is `/invite/[token]`. */
  url: z.string(),
  /**
   * When the link stops being redeemable. Added for the Settings «Дом»
   * section (task 7.1a), additively: `/onboarding`'s own mint call simply
   * ignores it, so the field carries no breaking change for that caller.
   */
  expiresAt: z.date(),
});

/**
 * A real token is exactly 43 base64url characters (32 random bytes). The cap
 * is loose rather than exact so the "unknown, expired and used all look the
 * same" property survives — a wrong-length guess still gets NOT_FOUND, not a
 * distinguishable validation error — while a megabyte of garbage is rejected
 * at the boundary instead of becoming a database query.
 */
export const inviteTokenInput = z.object({
  token: z.string().min(1).max(64),
});

/**
 * What the join screen renders. `invalid` deliberately covers unknown,
 * expired and already-used tokens alike — a stranger who guesses a token must
 * not learn which of the three it is (VISION §6.7).
 */
export const invitePreviewOutput = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("valid"),
    householdName: z.string(),
    inviterName: z.string(),
    alreadyMember: z.boolean(),
  }),
  z.object({ status: z.literal("otherHousehold") }),
  z.object({ status: z.literal("invalid") }),
]);

export const acceptInviteOutput = z.object({
  householdId: z.uuid(),
});

export type CreateInviteOutput = z.infer<typeof createInviteOutput>;
export type InvitePreviewOutput = z.infer<typeof invitePreviewOutput>;

/** The invite is one-time and its TTL has passed, or it never existed. */
const invalidInvite = new TRPCError({
  code: "NOT_FOUND",
  message: "Invite is not usable",
});

/**
 * One-time invite links with a TTL (VISION §5, §6.7).
 *
 * `preview` and `accept` are `protectedProcedure`, not `householdProcedure`:
 * the whole point is that the caller has no household yet.
 */
export const inviteRouter = createTRPCRouter({
  /** Mints a fresh link for the caller's household. */
  create: householdProcedure
    .output(createInviteOutput)
    .mutation(async ({ ctx }) => {
      const token = createInviteToken();
      // Computed once and reused for both the write and the response, so the
      // `expiresAt` the caller renders can never drift from the value the
      // database actually stored.
      const expiresAt = inviteExpiryFrom(new Date());

      await ctx.db.insert(invites).values({
        householdId: ctx.household.id,
        token,
        createdBy: ctx.user.id,
        expiresAt,
      });

      return { url: inviteUrl(env().NEXT_PUBLIC_APP_URL, token), expiresAt };
    }),

  /** Read-only look at a link, for rendering the join screen. */
  preview: protectedProcedure
    .input(inviteTokenInput)
    .output(invitePreviewOutput)
    .query(async ({ ctx, input }) => {
      const [invite] = await ctx.db
        .select({
          householdId: invites.householdId,
          householdName: households.name,
          inviterName: users.name,
          expiresAt: invites.expiresAt,
          usedAt: invites.usedAt,
        })
        .from(invites)
        .innerJoin(households, eq(households.id, invites.householdId))
        .innerJoin(users, eq(users.id, invites.createdBy))
        .where(eq(invites.token, input.token))
        .limit(1);

      const [membership] = await ctx.db
        .select({ householdId: householdMembers.householdId })
        .from(householdMembers)
        .where(eq(householdMembers.userId, ctx.user.id))
        .limit(1);

      return previewInvite({
        invite: invite ?? null,
        callerHouseholdId: membership?.householdId ?? null,
        now: new Date(),
      });
    }),

  /**
   * Redeems a link: stamps it used and adds the caller to the household.
   *
   * **The claim UPDATE is the single authority on whether the invite is
   * usable.** `decideInviteAccept` above it only decides what to tell the
   * caller — by the time its answer is acted on, the row may have been
   * claimed by someone else and the TTL may have run out. So every condition
   * that makes an invite usable is repeated in the UPDATE's WHERE, evaluated
   * once, atomically, against the database's own clock: unclaimed
   * (`used_at IS NULL`) and still in date (`expires_at > now()`). Checking
   * expiry only before the UPDATE would let a request that crosses
   * `expires_at` in flight redeem an expired invite.
   *
   * The membership insert is guarded the same way, by the unique index on
   * `user_id`. Two people opening the same link therefore race in Postgres,
   * and the loser gets a clean NOT_FOUND/CONFLICT instead of a duplicate row.
   */
  accept: protectedProcedure
    .input(inviteTokenInput)
    .output(acceptInviteOutput)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;

      try {
        return await ctx.db.transaction(async (tx) => {
          const [invite] = await tx
            .select({
              id: invites.id,
              householdId: invites.householdId,
              expiresAt: invites.expiresAt,
              usedAt: invites.usedAt,
            })
            .from(invites)
            .where(eq(invites.token, input.token))
            .limit(1);

          const [membership] = await tx
            .select({ householdId: householdMembers.householdId })
            .from(householdMembers)
            .where(eq(householdMembers.userId, userId))
            .limit(1);

          const decision = decideInviteAccept({
            invite: invite ?? null,
            callerHouseholdId: membership?.householdId ?? null,
            now: new Date(),
          });

          if (decision.outcome === "invalid") {
            throw invalidInvite;
          }
          if (decision.outcome === "alreadyInHousehold") {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Already in a household",
            });
          }

          const claimed = await tx
            .update(invites)
            // `now()` throughout, so the stamp and the predicate that allowed
            // it come from one clock — the database's, not this process's.
            .set({ usedAt: sql`now()`, usedBy: userId })
            .where(
              and(
                eq(invites.id, decision.invite.id),
                isNull(invites.usedAt),
                gt(invites.expiresAt, sql`now()`),
              ),
            )
            .returning({ id: invites.id });

          // No row matched: someone else claimed it between the read and the
          // update, or it expired in the meantime.
          if (claimed.length === 0) {
            throw invalidInvite;
          }

          await tx.insert(householdMembers).values({
            householdId: decision.invite.householdId,
            userId,
          });

          return { householdId: decision.invite.householdId };
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

import { randomBytes } from "node:crypto";

/**
 * Invite rules, kept free of tRPC and the database so every branch is
 * unit-testable (VISION §6.7: invites are one-time and carry a TTL).
 *
 * The routers in `src/server/api/routers/invite.ts` do the I/O and then hand
 * plain rows to the decision functions below; the decision functions are the
 * only place that knows what "valid" means.
 */

/** How long a fresh invite link stays usable. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 32 random bytes, base64url so the token is URL-safe without escaping. */
export function createInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Expiry stamp for an invite created at `now`. */
export function inviteExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_MS);
}

/** Path of the screen an invite link points at. */
export function invitePath(token: string): string {
  return `/invite/${encodeURIComponent(token)}`;
}

/** Absolute invite URL, built against the app's public origin. */
export function inviteUrl(appUrl: string, token: string): string {
  return new URL(invitePath(token), appUrl).toString();
}

/** The timestamps that decide whether an invite can still be redeemed. */
export interface InviteTiming {
  expiresAt: Date;
  usedAt: Date | null;
}

export type InviteStatus = "valid" | "expired" | "used";

/**
 * An invite is `used` the moment it is stamped, and `expired` from its
 * `expiresAt` instant onwards — the TTL boundary itself is already too late.
 * Redemption checks it first, so a used-then-expired link still reports the
 * more accurate reason.
 */
export function inviteStatus(invite: InviteTiming, now: Date): InviteStatus {
  if (invite.usedAt !== null) {
    return "used";
  }
  if (now.getTime() >= invite.expiresAt.getTime()) {
    return "expired";
  }
  return "valid";
}

/** The invite row plus the display data the join screen needs. */
export interface InvitePreviewSource extends InviteTiming {
  householdId: string;
  householdName: string;
  inviterName: string;
}

/**
 * What the join screen shows. A broken, expired or already-redeemed link is
 * reported as one indistinguishable `invalid` so a stranger holding a random
 * token learns nothing about whether it ever existed.
 */
export type InvitePreview =
  | {
      status: "valid";
      householdName: string;
      inviterName: string;
      /** The caller is already in this household — show a way in, not a button. */
      alreadyMember: boolean;
    }
  | { status: "otherHousehold" }
  | { status: "invalid" };

export interface InvitePreviewInput {
  invite: InvitePreviewSource | null;
  /** The household the caller already belongs to, if any. */
  callerHouseholdId: string | null;
  now: Date;
}

export function previewInvite({
  invite,
  callerHouseholdId,
  now,
}: InvitePreviewInput): InvitePreview {
  if (invite === null) {
    return { status: "invalid" };
  }

  // Membership is checked before the TTL on purpose: the common case is the
  // person who just joined re-opening the link they were sent, and telling
  // them "this link is broken" about a household they are already in would be
  // a lie. Nothing leaks — they are a member of that household.
  if (callerHouseholdId === invite.householdId) {
    return {
      status: "valid",
      householdName: invite.householdName,
      inviterName: invite.inviterName,
      alreadyMember: true,
    };
  }

  if (inviteStatus(invite, now) !== "valid") {
    return { status: "invalid" };
  }

  if (callerHouseholdId !== null) {
    return { status: "otherHousehold" };
  }

  return {
    status: "valid",
    householdName: invite.householdName,
    inviterName: invite.inviterName,
    alreadyMember: false,
  };
}

/**
 * Outcome of redeeming an invite. `accept` carries the row back so the caller
 * keeps it narrowed — the resolver never has to re-check for null.
 */
export type InviteAcceptDecision<TInvite> =
  | { outcome: "accept"; invite: TInvite }
  | { outcome: "invalid" }
  | { outcome: "alreadyInHousehold" };

export interface InviteAcceptInput<TInvite extends InviteTiming> {
  invite: TInvite | null;
  callerHouseholdId: string | null;
  now: Date;
}

export function decideInviteAccept<TInvite extends InviteTiming>({
  invite,
  callerHouseholdId,
  now,
}: InviteAcceptInput<TInvite>): InviteAcceptDecision<TInvite> {
  if (invite === null || inviteStatus(invite, now) !== "valid") {
    return { outcome: "invalid" };
  }

  // MVP: one household per user (VISION §5). Joining a second one — or the
  // same one twice — is refused here and, if two requests race past this
  // check, by the unique index on `household_members.user_id`.
  if (callerHouseholdId !== null) {
    return { outcome: "alreadyInHousehold" };
  }

  return { outcome: "accept", invite };
}

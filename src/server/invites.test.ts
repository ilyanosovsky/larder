import { describe, expect, it } from "vitest";

import {
  createInviteToken,
  decideInviteAccept,
  INVITE_TTL_MS,
  inviteExpiryFrom,
  invitePath,
  inviteStatus,
  inviteUrl,
  previewInvite,
} from "./invites";

const NOW = new Date("2026-08-20T12:00:00.000Z");

function expiresIn(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

describe("createInviteToken", () => {
  it("is URL-safe base64 of 32 bytes", () => {
    const token = createInviteToken();

    // 32 bytes → 43 base64 characters, unpadded, no "+" or "/".
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("survives a round trip through a URL path unescaped", () => {
    const token = createInviteToken();

    expect(invitePath(token)).toBe(`/invite/${token}`);
  });

  it("never repeats", () => {
    const tokens = new Set(
      Array.from({ length: 500 }, () => createInviteToken()),
    );

    expect(tokens.size).toBe(500);
  });
});

describe("inviteExpiryFrom", () => {
  it("is exactly one TTL after creation", () => {
    expect(inviteExpiryFrom(NOW).getTime()).toBe(NOW.getTime() + INVITE_TTL_MS);
  });

  it("uses a seven-day TTL", () => {
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("inviteUrl", () => {
  it("joins the token onto the app origin", () => {
    expect(inviteUrl("https://larder.app", "abc123")).toBe(
      "https://larder.app/invite/abc123",
    );
  });

  it("ignores a path on the configured origin rather than nesting under it", () => {
    expect(inviteUrl("https://larder.app/some/where", "abc123")).toBe(
      "https://larder.app/invite/abc123",
    );
  });

  it("escapes a token that is not URL-safe", () => {
    expect(inviteUrl("https://larder.app", "a/b?c")).toBe(
      "https://larder.app/invite/a%2Fb%3Fc",
    );
  });
});

describe("inviteStatus", () => {
  it("is valid before the TTL runs out", () => {
    expect(inviteStatus({ expiresAt: expiresIn(1), usedAt: null }, NOW)).toBe(
      "valid",
    );
  });

  it("is expired exactly at the TTL boundary", () => {
    expect(inviteStatus({ expiresAt: NOW, usedAt: null }, NOW)).toBe("expired");
  });

  it("is expired after the TTL", () => {
    expect(inviteStatus({ expiresAt: expiresIn(-1), usedAt: null }, NOW)).toBe(
      "expired",
    );
  });

  it("is used the moment it is stamped, TTL notwithstanding", () => {
    expect(
      inviteStatus(
        { expiresAt: expiresIn(INVITE_TTL_MS), usedAt: expiresIn(-1000) },
        NOW,
      ),
    ).toBe("used");
  });

  it("reports used rather than expired for a redeemed, long-past link", () => {
    expect(
      inviteStatus(
        {
          expiresAt: expiresIn(-INVITE_TTL_MS),
          usedAt: expiresIn(-INVITE_TTL_MS),
        },
        NOW,
      ),
    ).toBe("used");
  });
});

describe("previewInvite", () => {
  const invite = {
    expiresAt: expiresIn(INVITE_TTL_MS),
    usedAt: null,
    householdId: "household_1",
    householdName: "Наш дом",
    inviterName: "Аня",
  };

  it("shows the invitation to a household-less caller", () => {
    expect(
      previewInvite({ invite, callerHouseholdId: null, now: NOW }),
    ).toEqual({
      status: "valid",
      householdName: "Наш дом",
      inviterName: "Аня",
      alreadyMember: false,
    });
  });

  it("reports an unknown token as invalid", () => {
    expect(
      previewInvite({ invite: null, callerHouseholdId: null, now: NOW }),
    ).toEqual({ status: "invalid" });
  });

  it("hides an expired link behind the same invalid result", () => {
    expect(
      previewInvite({
        invite: { ...invite, expiresAt: expiresIn(-1) },
        callerHouseholdId: null,
        now: NOW,
      }),
    ).toEqual({ status: "invalid" });
  });

  it("hides a used link behind the same invalid result", () => {
    expect(
      previewInvite({
        invite: { ...invite, usedAt: expiresIn(-1000) },
        callerHouseholdId: null,
        now: NOW,
      }),
    ).toEqual({ status: "invalid" });
  });

  it("greets a caller who is already in this household", () => {
    expect(
      previewInvite({ invite, callerHouseholdId: "household_1", now: NOW }),
    ).toMatchObject({ status: "valid", alreadyMember: true });
  });

  it("still greets them once their own link has been used up", () => {
    // The person who just joined re-opens the link they were sent. Calling it
    // broken would be a lie about a household they are standing in.
    expect(
      previewInvite({
        invite: { ...invite, usedAt: expiresIn(-1000) },
        callerHouseholdId: "household_1",
        now: NOW,
      }),
    ).toMatchObject({ status: "valid", alreadyMember: true });
  });

  it("tells a caller from another household that MVP allows only one", () => {
    expect(
      previewInvite({ invite, callerHouseholdId: "household_2", now: NOW }),
    ).toEqual({ status: "otherHousehold" });
  });

  it("prefers invalid over otherHousehold, so a bad token leaks nothing", () => {
    expect(
      previewInvite({
        invite: { ...invite, expiresAt: expiresIn(-1) },
        callerHouseholdId: "household_2",
        now: NOW,
      }),
    ).toEqual({ status: "invalid" });
  });
});

describe("decideInviteAccept", () => {
  const invite = {
    id: "invite_1",
    householdId: "household_1",
    expiresAt: expiresIn(INVITE_TTL_MS),
    usedAt: null,
  };

  it("accepts a valid invite for a household-less caller", () => {
    expect(
      decideInviteAccept({ invite, callerHouseholdId: null, now: NOW }),
    ).toEqual({ outcome: "accept", invite });
  });

  it("hands the row back so the resolver keeps it narrowed", () => {
    const decision = decideInviteAccept({
      invite,
      callerHouseholdId: null,
      now: NOW,
    });

    expect(decision.outcome === "accept" && decision.invite.id).toBe(
      "invite_1",
    );
  });

  it("rejects an unknown token", () => {
    expect(
      decideInviteAccept({ invite: null, callerHouseholdId: null, now: NOW }),
    ).toEqual({ outcome: "invalid" });
  });

  it("rejects an expired invite", () => {
    expect(
      decideInviteAccept({
        invite: { ...invite, expiresAt: NOW },
        callerHouseholdId: null,
        now: NOW,
      }),
    ).toEqual({ outcome: "invalid" });
  });

  it("rejects an already-used invite", () => {
    expect(
      decideInviteAccept({
        invite: { ...invite, usedAt: expiresIn(-1000) },
        callerHouseholdId: null,
        now: NOW,
      }),
    ).toEqual({ outcome: "invalid" });
  });

  it("rejects a caller who already belongs to a household", () => {
    expect(
      decideInviteAccept({
        invite,
        callerHouseholdId: "household_2",
        now: NOW,
      }),
    ).toEqual({ outcome: "alreadyInHousehold" });
  });

  it("rejects re-joining the same household too", () => {
    expect(
      decideInviteAccept({
        invite,
        callerHouseholdId: "household_1",
        now: NOW,
      }),
    ).toEqual({ outcome: "alreadyInHousehold" });
  });

  it("rejects a bad token before looking at membership", () => {
    expect(
      decideInviteAccept({
        invite: null,
        callerHouseholdId: "household_2",
        now: NOW,
      }),
    ).toEqual({ outcome: "invalid" });
  });
});

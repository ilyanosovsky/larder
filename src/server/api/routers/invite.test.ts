import { TRPCError } from "@trpc/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createCaller } from "@/server/api/root";
import {
  anonymousContext,
  createDbStub,
  signedInContext,
  unusableDb,
  type StubResult,
} from "@/server/api/test-support";
import { INVITE_TTL_MS } from "@/server/invites";

const HOUSEHOLD_ID = "3f1a6d0e-0000-4000-8000-000000000001";

/**
 * `invite.create` builds its link from NEXT_PUBLIC_APP_URL, and `env()`
 * validates the whole schema at once — so the full set has to be present.
 */
const TEST_ENV = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/larder",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  RESEND_API_KEY: "test-resend-key",
  EMAIL_FROM: "Larder <noreply@localhost>",
  OPENAI_API_KEY: "test-openai-key",
  FIRECRAWL_API_KEY: "test-firecrawl-key",
  UPLOADTHING_TOKEN: "test-uploadthing-token",
  NEXT_PUBLIC_APP_URL: "https://larder.example",
} as const;

beforeAll(() => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    vi.stubEnv(key, value);
  }
});

function callerWith(results: StubResult[]) {
  const stub = createDbStub(results);
  return { caller: createCaller(signedInContext(stub.db)), stub };
}

function hasCode(code: TRPCError["code"]) {
  return (error: unknown) => error instanceof TRPCError && error.code === code;
}

function validInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: "invite_1",
    householdId: HOUSEHOLD_ID,
    householdName: "Наш дом",
    inviterName: "Аня",
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    usedAt: null,
    ...overrides,
  };
}

const membershipRow = {
  membership: {
    id: "membership_1",
    householdId: HOUSEHOLD_ID,
    userId: "user_1",
    joinedAt: new Date("2026-08-01T00:00:00.000Z"),
  },
  household: {
    id: HOUSEHOLD_ID,
    name: "Наш дом",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  },
};

describe("invite.create", () => {
  it("is refused to a caller without a household", async () => {
    const { caller } = callerWith([[]]);

    await expect(caller.invite.create()).rejects.toSatisfy(
      hasCode("FORBIDDEN"),
    );
  });

  it("returns a link to the join screen on the configured origin", async () => {
    // householdProcedure lookup → invite insert
    const { caller } = callerWith([[membershipRow], []]);

    const { url } = await caller.invite.create();

    expect(url).toMatch(
      /^https:\/\/larder\.example\/invite\/[A-Za-z0-9_-]{43}$/,
    );
  });

  it("stores the invite against the caller's own household, with a TTL", async () => {
    const { caller, stub } = callerWith([[membershipRow], []]);
    const before = Date.now();

    await caller.invite.create();

    const insert = stub.statements[1];
    expect(insert).toMatchObject({ kind: "insert", table: "invites" });
    expect(insert?.values).toMatchObject({
      householdId: HOUSEHOLD_ID,
      createdBy: "user_1",
    });

    const { expiresAt } = insert?.values as { expiresAt: Date };
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + INVITE_TTL_MS);
  });

  it("mints a different token every time", async () => {
    const first = callerWith([[membershipRow], []]);
    const second = callerWith([[membershipRow], []]);

    const a = await first.caller.invite.create();
    const b = await second.caller.invite.create();

    expect(a.url).not.toBe(b.url);
  });
});

describe("invite.preview", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.invite.preview({ token: "t" })).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("shows the invitation to a household-less caller", async () => {
    // invite lookup → membership lookup
    const { caller } = callerWith([[validInvite()], []]);

    await expect(caller.invite.preview({ token: "t" })).resolves.toEqual({
      status: "valid",
      householdName: "Наш дом",
      inviterName: "Аня",
      alreadyMember: false,
    });
  });

  it("reports an unknown token as invalid rather than erroring", async () => {
    const { caller } = callerWith([[], []]);

    await expect(caller.invite.preview({ token: "nope" })).resolves.toEqual({
      status: "invalid",
    });
  });

  it("gives an expired link the same invalid answer as an unknown one", async () => {
    const { caller } = callerWith([
      [validInvite({ expiresAt: new Date(Date.now() - 1) })],
      [],
    ]);

    await expect(caller.invite.preview({ token: "t" })).resolves.toEqual({
      status: "invalid",
    });
  });

  it("says otherHousehold when the caller already belongs elsewhere", async () => {
    const { caller } = callerWith([
      [validInvite()],
      [{ householdId: "another-household" }],
    ]);

    await expect(caller.invite.preview({ token: "t" })).resolves.toEqual({
      status: "otherHousehold",
    });
  });
});

describe("invite.accept", () => {
  it("requires a session", async () => {
    const caller = createCaller(anonymousContext(unusableDb));

    await expect(caller.invite.accept({ token: "t" })).rejects.toSatisfy(
      hasCode("UNAUTHORIZED"),
    );
  });

  it("adds the caller to the household and stamps the invite used", async () => {
    // invite lookup → membership lookup → claim update → membership insert
    const { caller, stub } = callerWith([
      [validInvite()],
      [],
      [{ id: "invite_1" }],
      [],
    ]);

    await expect(caller.invite.accept({ token: "t" })).resolves.toEqual({
      householdId: HOUSEHOLD_ID,
    });

    expect(stub.statements[2]).toMatchObject({
      kind: "update",
      table: "invites",
    });
    expect(stub.statements[2]?.values).toMatchObject({ usedBy: "user_1" });
    expect(stub.statements[3]).toMatchObject({
      kind: "insert",
      table: "household_members",
      values: { householdId: HOUSEHOLD_ID, userId: "user_1" },
    });
  });

  it("rejects an unknown token with NOT_FOUND", async () => {
    const { caller, stub } = callerWith([[], []]);

    await expect(caller.invite.accept({ token: "nope" })).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );
    expect(stub.statements).toHaveLength(2);
  });

  it("rejects an expired invite with the same NOT_FOUND", async () => {
    const { caller, stub } = callerWith([
      [validInvite({ expiresAt: new Date(Date.now() - 1) })],
      [],
    ]);

    await expect(caller.invite.accept({ token: "t" })).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );
    // Nothing was written.
    expect(stub.statements).toHaveLength(2);
  });

  it("rejects an already-used invite", async () => {
    const { caller } = callerWith([
      [validInvite({ usedAt: new Date(Date.now() - 1000) })],
      [],
    ]);

    await expect(caller.invite.accept({ token: "t" })).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );
  });

  it("rejects a caller who is already in a household with CONFLICT", async () => {
    const { caller, stub } = callerWith([
      [validInvite()],
      [{ householdId: "another-household" }],
    ]);

    await expect(caller.invite.accept({ token: "t" })).rejects.toSatisfy(
      hasCode("CONFLICT"),
    );
    expect(stub.statements).toHaveLength(2);
  });

  it("rejects the loser of a race for the same link", async () => {
    // The claim update matched no row, because someone else stamped it first.
    const { caller, stub } = callerWith([[validInvite()], [], []]);

    await expect(caller.invite.accept({ token: "t" })).rejects.toSatisfy(
      hasCode("NOT_FOUND"),
    );
    // The membership insert never ran.
    expect(stub.statements).toHaveLength(3);
  });

  it("turns a unique-index violation on the membership into CONFLICT", async () => {
    const { caller } = callerWith([
      [validInvite()],
      [],
      [{ id: "invite_1" }],
      Object.assign(new Error("duplicate key"), { code: "23505" }),
    ]);

    await expect(caller.invite.accept({ token: "t" })).rejects.toSatisfy(
      hasCode("CONFLICT"),
    );
  });

  it("does not swallow an unrelated database error", async () => {
    const { caller } = callerWith([new Error("connection lost")]);

    await expect(caller.invite.accept({ token: "t" })).rejects.toThrow(
      "connection lost",
    );
  });
});

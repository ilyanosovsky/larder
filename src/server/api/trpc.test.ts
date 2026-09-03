import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { appRouter, createCaller } from "@/server/api/root";
import { createDbStub } from "@/server/api/test-support";
import {
  createCallerFactory,
  createTRPCRouter,
  householdProcedure,
  publicProcedure,
  type TRPCContext,
} from "@/server/api/trpc";

/**
 * The database must never be reached from these tests — no connection, no
 * env. Any property access blows up loudly instead of silently doing I/O.
 */
const unusableDb = new Proxy({} as TRPCContext["db"], {
  get(_target, property) {
    throw new Error(
      `ctx.db must not be touched in unit tests (accessed "${String(property)}")`,
    );
  },
});

const anonymousContext: TRPCContext = {
  session: null,
  user: null,
  db: unusableDb,
  openai: () => {
    throw new Error("ctx.openai() must not be called in unit tests");
  },
  uploadThing: () => {
    throw new Error("ctx.uploadThing() must not be called in unit tests");
  },
};

const signedInContext: TRPCContext = {
  ...anonymousContext,
  session: {
    id: "session_1",
    token: "token_1",
    userId: "user_1",
    expiresAt: new Date("2100-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  user: {
    id: "user_1",
    email: "kira@example.com",
    name: "Кира",
    emailVerified: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    image: null,
  },
};

/** Same superjson envelope the client link sends for a GET query. */
function inputParam(input: unknown): string {
  return encodeURIComponent(JSON.stringify({ json: input }));
}

describe("publicProcedure", () => {
  it("resolves without a session", async () => {
    const caller = createCaller(anonymousContext);

    await expect(caller.health.ping()).resolves.toMatchObject({ ok: true });
  });

  it("returns a real Date, so superjson has something to preserve", async () => {
    const caller = createCaller(anonymousContext);
    const { time } = await caller.health.ping();

    expect(time).toBeInstanceOf(Date);
  });
});

describe("protectedProcedure", () => {
  it("rejects an anonymous caller with UNAUTHORIZED", async () => {
    const caller = createCaller(anonymousContext);

    await expect(caller.health.whoami()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TRPCError && error.code === "UNAUTHORIZED",
    );
  });

  it("passes the signed-in user through to the resolver", async () => {
    const caller = createCaller(signedInContext);

    await expect(caller.health.whoami()).resolves.toEqual({
      id: "user_1",
      email: "kira@example.com",
      name: "Кира",
    });
  });
});

describe("householdProcedure", () => {
  /** Minimal router so the middleware can be exercised on its own. */
  const householdRouter = createTRPCRouter({
    peek: householdProcedure.query(({ ctx }) => ({
      householdId: ctx.household.id,
      householdName: ctx.household.name,
      membershipId: ctx.membership.id,
    })),
  });
  const createHouseholdCaller = createCallerFactory(householdRouter);

  const membershipRow = {
    membership: {
      id: "membership_1",
      householdId: "household_1",
      userId: "user_1",
      joinedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    household: {
      id: "household_1",
      name: "Наш дом",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    },
  };

  it("rejects an anonymous caller with UNAUTHORIZED, before any query", async () => {
    // `unusableDb` proves the membership lookup is never reached.
    const caller = createHouseholdCaller(anonymousContext);

    await expect(caller.peek()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TRPCError && error.code === "UNAUTHORIZED",
    );
  });

  it("rejects a signed-in caller without a household with FORBIDDEN", async () => {
    const { db } = createDbStub([[]]);
    const caller = createHouseholdCaller({ ...signedInContext, db });

    await expect(caller.peek()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TRPCError && error.code === "FORBIDDEN",
    );
  });

  it("puts the household and the membership on the context", async () => {
    const { db } = createDbStub([[membershipRow]]);
    const caller = createHouseholdCaller({ ...signedInContext, db });

    await expect(caller.peek()).resolves.toEqual({
      householdId: "household_1",
      householdName: "Наш дом",
      membershipId: "membership_1",
    });
  });
});

describe("transformer", () => {
  it("serializes Date over the wire instead of stringifying it", async () => {
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request("http://localhost/api/trpc/health.ping"),
      router: appRouter,
      createContext: () => anonymousContext,
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    // superjson tags the field, which is what lets the client rebuild a Date.
    expect(body).toMatchObject({
      result: { data: { meta: { values: { time: ["Date"] } } } },
    });
  });
});

describe("errorFormatter", () => {
  const inputRouter = createTRPCRouter({
    needsName: publicProcedure
      .input(z.object({ name: z.string().min(3) }))
      .query(({ input }) => input.name),
  });

  async function callNeedsName(input: unknown): Promise<Response> {
    return fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request(
        `http://localhost/api/trpc/needsName?input=${inputParam(input)}`,
      ),
      router: inputRouter,
      createContext: () => anonymousContext,
    });
  }

  it("exposes Zod field errors under data.zodError", async () => {
    const response = await callNeedsName({ name: "no" });
    const body: unknown = await response.json();

    expect(response.status).toBe(400);
    // `error.json` is the superjson envelope the client link unwraps.
    expect(body).toMatchObject({
      error: {
        json: {
          data: {
            code: "BAD_REQUEST",
            zodError: { fieldErrors: { name: [expect.any(String)] } },
          },
        },
      },
    });
  });

  it("keeps zodError null — never absent — for non-validation errors", async () => {
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request("http://localhost/api/trpc/health.whoami"),
      router: appRouter,
      createContext: () => anonymousContext,
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      error: { json: { data: { code: "UNAUTHORIZED", zodError: null } } },
    });
  });
});

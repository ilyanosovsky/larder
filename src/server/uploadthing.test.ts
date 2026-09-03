import { isSQLWrapper, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UPLOAD_LIMIT_MESSAGE_PREFIX } from "@/lib/images/upload-errors";
import {
  createDbStub,
  type DbStub,
  type StubResult,
} from "@/server/api/test-support";

const getSession = vi.fn();
let stub: DbStub;

vi.mock("@/lib/session", () => ({ getSession: () => getSession() }));
vi.mock("@/db", () => ({ db: () => stub.db }));

const { larderFileRouter } = await import("@/server/uploadthing");

/**
 * The upload route is this feature's **only public auth boundary** — and the
 * sole writer of the `photo_uploads` row that `fromPhoto` and `discardPhoto`
 * treat as the capability. `src/middleware.ts` excludes `/api/**`, so nothing
 * else gates it.
 *
 * The guards were unpinned in two rounds. First the callbacks had no tests at
 * all, so deleting the session check, deleting the membership check, or
 * writing a constant instead of `metadata.householdId` each left the repo
 * green. Then a hand-rolled stub that discarded every `.where()` left the
 * *shape* of both queries unpinned: turning the per-user cap into a
 * per-household one, or dropping the scope entirely, still passed. Hence
 * `createDbStub` and compiled predicates, the way `dish-import.test.ts` does
 * it.
 *
 * The route's `.middleware()` / `.onUploadComplete()` callbacks are stored on
 * the route object by the builder, so they are called directly here — no HTTP,
 * no UploadThing runtime.
 */
type Middleware = (args: unknown) => Promise<{
  householdId: string;
  userId: string;
}>;

type OnComplete = (args: {
  metadata: { householdId: string; userId: string };
  file: { key: string; ufsUrl: string };
}) => Promise<{ fileKey: string; url: string }>;

const route = larderFileRouter.dishPhoto as unknown as {
  middleware: Middleware;
  onUploadComplete: OnComplete;
};

const HOUSEHOLD_ID = "3f1a6d0e-0000-4000-8000-000000000001";
const OTHER_HOUSEHOLD = "3f1a6d0e-0000-4000-8000-000000000099";
const USER_ID = "user_1";
const FILE_KEY = "aBcD1234_-key";
const FILE_URL = `https://app1.ufs.sh/f/${FILE_KEY}`;

function compileWithParams(clause: unknown): {
  sql: string;
  params: unknown[];
} {
  expect(isSQLWrapper(clause)).toBe(true);
  return new PgDialect().sqlToQuery((clause as SQLWrapper).getSQL());
}

/** The one bound parameter that reads back as a timestamp, in epoch ms. */
function boundInstant(params: unknown[]): number {
  const instants = params
    .filter((param): param is string => typeof param === "string")
    .map((param) => Date.parse(param))
    .filter((value) => Number.isFinite(value));

  expect(instants).toHaveLength(1);
  return instants[0]!;
}

function withResults(results: StubResult[]) {
  stub = createDbStub(results);
}

function signedIn(userId = USER_ID) {
  getSession.mockResolvedValue({ user: { id: userId } });
}

/** Membership row, then the upload-cap count. */
function membershipAndQuota(
  householdId: string | null,
  counts = { minute: 0, day: 0 },
) {
  withResults([householdId === null ? [] : [{ householdId }], [counts]]);
}

beforeEach(() => {
  vi.resetAllMocks();
  withResults([]);
});

describe("dishPhoto.middleware", () => {
  it("refuses an anonymous upload without touching the database", async () => {
    // Asserting the db is untouched matters: a bare `rejects.toThrow()` still
    // passes with the guard deleted, because the membership lookup would then
    // return nothing and throw FORBIDDEN instead.
    getSession.mockResolvedValue(null);

    await expect(route.middleware({})).rejects.toThrow(/UNAUTHORIZED/);
    expect(stub.statements).toHaveLength(0);
  });

  it("refuses a signed-in user who has no household", async () => {
    signedIn();
    membershipAndQuota(null);

    await expect(route.middleware({})).rejects.toThrow(/FORBIDDEN/);
  });

  it("looks the membership up by the caller's own user id", async () => {
    signedIn();
    membershipAndQuota(HOUSEHOLD_ID);

    await route.middleware({});

    const lookup = stub.statements[0];
    expect(lookup?.table).toBe("household_members");
    const compiled = compileWithParams(lookup?.wheres[0]);
    expect(compiled.sql).toContain('"household_members"."user_id"');
    expect(compiled.params).toContain(USER_ID);
  });

  it("counts only the caller's own uploads, in the caller's own household", async () => {
    // Both halves matter. Without `user_id` the cap becomes per household, so
    // one person's uploads throttle their partner; without `household_id` the
    // count stops using the only index the table has.
    signedIn();
    membershipAndQuota(HOUSEHOLD_ID);

    await route.middleware({});

    const count = stub.statements[1];
    expect(count?.table).toBe("photo_uploads");

    const compiled = compileWithParams(count?.wheres[0]);
    expect(compiled.sql).toContain('"photo_uploads"."household_id"');
    expect(compiled.sql).toContain('"photo_uploads"."user_id"');
    expect(compiled.sql).toContain('"photo_uploads"."created_at"');
    expect(compiled.params).toContain(HOUSEHOLD_ID);
    expect(compiled.params).toContain(USER_ID);
  });

  it("windows the two counts a day and a minute back", async () => {
    signedIn();
    membershipAndQuota(HOUSEHOLD_ID);

    const before = Date.now();
    await route.middleware({});

    // The `WHERE` carries the day boundary; the minute boundary lives in the
    // projection's `FILTER`. Both are compiled, so swapping them shows up
    // here. Timestamps arrive as strings, not `Date`s — drizzle's `timestamp`
    // encoder runs at compile time, which is precisely why the `FILTER`
    // predicate has to go through `gte()` rather than interpolating a bare
    // `Date` (`rate-limit-guard.ts` documents the bind-time failure).
    const count = stub.statements[1];
    const fields = count?.fields as { minute: unknown };

    const dayStart = boundInstant(compileWithParams(count?.wheres[0]).params);
    const minuteStart = boundInstant(compileWithParams(fields.minute).params);

    expect(before - dayStart).toBeCloseTo(24 * 60 * 60 * 1000, -4);
    expect(before - minuteStart).toBeCloseTo(60_000, -4);
  });

  it("passes the caller's own household and user id down as metadata", async () => {
    signedIn();
    membershipAndQuota(HOUSEHOLD_ID);

    await expect(route.middleware({})).resolves.toEqual({
      householdId: HOUSEHOLD_ID,
      userId: USER_ID,
    });
  });

  it("refuses once the caller is holding too many uploads this minute", async () => {
    // Checked before the presign, so a refusal costs no bytes at all. The
    // window is asserted, not just «limit»: swapping the minute and day counts
    // would apply the 100/day allowance to the minute and be invisible to a
    // `/limit/i` match.
    signedIn();
    membershipAndQuota(HOUSEHOLD_ID, { minute: 10, day: 12 });

    await expect(route.middleware({})).rejects.toThrow(
      `${UPLOAD_LIMIT_MESSAGE_PREFIX} (minute)`,
    );
  });

  it("refuses on the daily window too, and says which one", async () => {
    signedIn();
    membershipAndQuota(HOUSEHOLD_ID, { minute: 0, day: 100 });

    await expect(route.middleware({})).rejects.toThrow(
      `${UPLOAD_LIMIT_MESSAGE_PREFIX} (day)`,
    );
  });

  it("allows the tenth upload in a minute — the limit is >=, not >", async () => {
    signedIn();
    membershipAndQuota(HOUSEHOLD_ID, { minute: 9, day: 9 });

    await expect(route.middleware({})).resolves.toMatchObject({
      householdId: HOUSEHOLD_ID,
    });
  });
});

describe("dishPhoto.onUploadComplete", () => {
  it("records the key against the household the middleware authorized", async () => {
    // The row is the capability. Writing anything but `metadata.householdId`
    // here would hand one household a key it could spend against another's.
    withResults([[]]);

    await expect(
      route.onUploadComplete({
        metadata: { householdId: HOUSEHOLD_ID, userId: USER_ID },
        file: { key: FILE_KEY, ufsUrl: FILE_URL },
      }),
    ).resolves.toEqual({ fileKey: FILE_KEY, url: FILE_URL });

    const insert = stub.statements[0];
    expect(insert?.kind).toBe("insert");
    expect(insert?.table).toBe("photo_uploads");
    expect(insert?.values).toEqual({
      fileKey: FILE_KEY,
      householdId: HOUSEHOLD_ID,
      userId: USER_ID,
      url: FILE_URL,
    });
    expect(insert?.values).not.toMatchObject({ householdId: OTHER_HOUSEHOLD });
  });

  it("tolerates a redelivered callback for a key already recorded", async () => {
    // UploadThing may deliver the callback more than once, and the row is
    // identical either way — so a duplicate must not be an error.
    withResults([[]]);

    await route.onUploadComplete({
      metadata: { householdId: HOUSEHOLD_ID, userId: USER_ID },
      file: { key: FILE_KEY, ufsUrl: FILE_URL },
    });

    expect(stub.statements[0]?.onConflictDoNothing).toBe(true);
  });
});

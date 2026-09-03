import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const select = vi.fn();
const insert = vi.fn();

vi.mock("@/lib/session", () => ({ getSession: () => getSession() }));
vi.mock("@/db", () => ({ db: () => ({ select, insert }) }));

const { larderFileRouter } = await import("@/server/uploadthing");

/**
 * The upload route is this feature's **only public auth boundary** — and the
 * sole writer of the `photo_uploads` row that `fromPhoto` and `discardPhoto`
 * treat as the capability. `src/middleware.ts` excludes `/api/**`, so nothing
 * else gates it.
 *
 * It had no tests at all, and the guards were therefore unpinned: deleting the
 * session check, deleting the membership check, or writing a constant instead
 * of `metadata.householdId` each left the whole repo green. The equivalent
 * tRPC boundary is covered in `trpc.test.ts`; this is the same coverage for
 * the other door.
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

/** One `select(...).from(...).where(...).limit(...)` chain resolving to `rows`. */
function selectOnce(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
  };
  return chain;
}

function signedIn(userId = "user_1") {
  getSession.mockResolvedValue({ user: { id: userId } });
}

/** Membership row, then the upload-cap count. */
function membershipAndQuota(
  householdId: string | null,
  counts = { minute: 0, day: 0 },
) {
  select
    .mockReturnValueOnce(
      selectOnce(householdId === null ? [] : [{ householdId }]),
    )
    .mockReturnValueOnce(selectOnce([counts]));
}

beforeEach(() => {
  // `resetAllMocks`, not `clearAllMocks`: the latter clears recorded calls but
  // leaves `mockReturnValueOnce` queues in place, so a test that throws before
  // consuming its second queued value poisons the next one.
  vi.resetAllMocks();
});

describe("dishPhoto.middleware", () => {
  it("refuses an anonymous upload without touching the database", async () => {
    // Asserting the db is untouched matters: a bare `rejects.toThrow()` still
    // passes with the guard deleted, because the membership lookup would then
    // return nothing and throw FORBIDDEN instead.
    getSession.mockResolvedValue(null);

    await expect(route.middleware({})).rejects.toThrow(/UNAUTHORIZED/);
    expect(select).not.toHaveBeenCalled();
  });

  it("refuses a signed-in user who has no household", async () => {
    signedIn();
    membershipAndQuota(null);

    await expect(route.middleware({})).rejects.toThrow(/FORBIDDEN/);
  });

  it("passes the caller's own household and user id down as metadata", async () => {
    signedIn("user_1");
    membershipAndQuota(HOUSEHOLD_ID);

    await expect(route.middleware({})).resolves.toEqual({
      householdId: HOUSEHOLD_ID,
      userId: "user_1",
    });
  });

  it("refuses once the caller is holding too many uploads", async () => {
    // Checked before the presign, so a refusal costs no bytes at all.
    signedIn();
    membershipAndQuota(HOUSEHOLD_ID, { minute: 10, day: 12 });

    await expect(route.middleware({})).rejects.toThrow(/limit/i);
  });

  it("refuses on the daily window too", async () => {
    signedIn();
    membershipAndQuota(HOUSEHOLD_ID, { minute: 0, day: 100 });

    await expect(route.middleware({})).rejects.toThrow(/limit/i);
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
    const values = vi.fn(() => ({
      onConflictDoNothing: () => Promise.resolve(),
    }));
    insert.mockReturnValue({ values });

    await expect(
      route.onUploadComplete({
        metadata: { householdId: HOUSEHOLD_ID, userId: "user_1" },
        file: {
          key: "aBcD1234_-key",
          ufsUrl: "https://app1.ufs.sh/f/aBcD1234_-key",
        },
      }),
    ).resolves.toEqual({
      fileKey: "aBcD1234_-key",
      url: "https://app1.ufs.sh/f/aBcD1234_-key",
    });

    expect(values).toHaveBeenCalledWith({
      fileKey: "aBcD1234_-key",
      householdId: HOUSEHOLD_ID,
      userId: "user_1",
      url: "https://app1.ufs.sh/f/aBcD1234_-key",
    });
    expect(values).not.toHaveBeenCalledWith(
      expect.objectContaining({ householdId: OTHER_HOUSEHOLD }),
    );
  });

  it("tolerates a redelivered callback for a key already recorded", async () => {
    const onConflictDoNothing = vi.fn(() => Promise.resolve());
    insert.mockReturnValue({ values: () => ({ onConflictDoNothing }) });

    await route.onUploadComplete({
      metadata: { householdId: HOUSEHOLD_ID, userId: "user_1" },
      file: { key: "k", ufsUrl: "https://app1.ufs.sh/f/k" },
    });

    expect(onConflictDoNothing).toHaveBeenCalledOnce();
  });
});

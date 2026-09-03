import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";
import { createUploadthing, type FileRouter } from "uploadthing/next";
import { UploadThingError } from "uploadthing/server";

import { db } from "@/db";
import { householdMembers, photoUploads } from "@/db/schema";
import { getSession } from "@/lib/session";
import { checkRateLimit, rateLimitWindows } from "@/server/ai/rate-limit";

/**
 * The UploadThing file router — the browser's direct upload lane for recipe
 * screenshots (task 4.3, blueprint §3.1).
 *
 * **Why the bytes do not go through tRPC.** Vercel caps a serverless request
 * body at 4.5 MB and base64 adds a third on top, so a phone screenshot would
 * be at the edge of the limit before it started; and the photo becomes
 * `dishes.photo_url` regardless, so it has to live somewhere addressable
 * anyway. The browser uploads straight to UploadThing, the app learns the
 * file key from the callback below, and OpenAI is handed a URL — so the
 * bytes cross the wire exactly once.
 *
 * **This is a second public entry point.** `src/middleware.ts` deliberately
 * excludes `/api/**`, so nothing gates this route the way the optimistic
 * cookie check gates a page. `.middleware()` therefore re-does exactly what
 * `householdProcedure` does for tRPC: a validated session *and* a household
 * membership, both before the upload is authorized — **plus a cap**, because
 * sign-up is open and `household.create` is a plain `protectedProcedure`, so
 * anyone with an email address can obtain the membership this gate asks for.
 * The UploadThing tier is app-wide, not per household, so an ungated uploader
 * is the one surface where one account can exhaust everybody's storage.
 *
 * Nothing here runs at import time: `db()`, `getSession()` and the route
 * handler's token are all read inside a request (`pnpm build` runs with no
 * environment at all).
 */
const f = createUploadthing();

/**
 * 4 MB, though the client compresses to ~300 KB (`src/lib/images/compress.ts`).
 * The gap is the fallback path: an image the browser cannot decode — HEIC on
 * desktop Chrome, say (R6) — is uploaded as-is when it is small enough, and
 * refusing it at 1 MB would turn a working long-tail case into a dead end.
 */
const MAX_PHOTO_SIZE = "4MB";

/**
 * How many blobs one person may be holding, per window.
 *
 * Reuses the AI limiter's own numbers and decision function (10/minute,
 * 100/day, `src/server/ai/rate-limit.ts`) rather than inventing a second set:
 * a photo import is one upload followed by one AI call, so the two limits
 * describe the same human behaviour and drifting them apart would only mean
 * one of the pair silently doing nothing.
 *
 * **These are live rows, so the cap is on storage held, not on requests
 * made** — `discardPhoto` deletes the row with the blob, and a person who
 * uploads and immediately discards is not capped. That is the honest shape
 * for what this defends: the risk is somebody filling a shared 2 GB tier, and
 * an uploader who deletes every file as they go is not filling anything. A
 * true request-rate limit would have to count something append-only, which is
 * what `ai_jobs` already does one step later in the flow.
 *
 * Counted with `household_id` alongside `user_id` so the existing
 * `photo_uploads_householdId_idx` serves the query — a household holds tens
 * of rows, so the user filter is applied to a handful of them and no new
 * index (and no migration) is needed.
 */

export const larderFileRouter = {
  dishPhoto: f({
    image: {
      maxFileSize: MAX_PHOTO_SIZE,
      maxFileCount: 1,
    },
  })
    .middleware(async () => {
      const session = await getSession();

      if (!session?.user) {
        // `UploadThingError` is what the SDK turns into a 4xx the client can
        // read; a plain throw would surface as an opaque 500.
        throw new UploadThingError("UNAUTHORIZED");
      }

      const [membership] = await db()
        .select({ householdId: householdMembers.householdId })
        .from(householdMembers)
        .where(eq(householdMembers.userId, session.user.id))
        .limit(1);

      if (!membership) {
        throw new UploadThingError("FORBIDDEN");
      }

      // Checked here, before the presign is issued, so a refusal costs no
      // bytes at all — the browser never starts the transfer.
      const { minuteStart, dayStart } = rateLimitWindows(new Date());
      const [held] = await db()
        .select({
          minute: sql<number>`(count(*) filter (where ${gte(photoUploads.createdAt, minuteStart)}))::int`,
          day: sql<number>`(count(*))::int`,
        })
        .from(photoUploads)
        .where(
          and(
            eq(photoUploads.householdId, membership.householdId),
            eq(photoUploads.userId, session.user.id),
            gte(photoUploads.createdAt, dayStart),
          ),
        );

      const decision = checkRateLimit({
        recentMinuteCount: held?.minute ?? 0,
        recentDayCount: held?.day ?? 0,
      });

      if (!decision.allowed) {
        // An options object, not a bare string: a string forces
        // INTERNAL_SERVER_ERROR, and `TOO_MANY_REQUESTS` is not one of the
        // SDK's codes, so FORBIDDEN with a readable message is the closest
        // honest answer the client can render.
        throw new UploadThingError({
          code: "FORBIDDEN",
          message: `Upload limit reached (${decision.reason})`,
        });
      }

      return { householdId: membership.householdId, userId: session.user.id };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      // The ownership record, written here because this is the only place the
      // file key is born — the browser talks to UploadThing directly, so the
      // app first learns the key exists when this callback runs. Everything
      // downstream (`fromPhoto`, `discardPhoto`) checks the household against
      // this row; see `photo_uploads` in `src/db/schema.ts`.
      await db()
        .insert(photoUploads)
        .values({
          fileKey: file.key,
          householdId: metadata.householdId,
          userId: metadata.userId,
          url: file.ufsUrl,
        })
        // A retried callback for a key we already recorded is not an error —
        // UploadThing may deliver it more than once, and the row is identical
        // either way.
        .onConflictDoNothing();

      // Returned to the browser as `serverData`. The key is what the import
      // mutation is called with; the URL is only ever used to render the
      // thumbnail on S8.2, never sent back to the server as a claim.
      return { fileKey: file.key, url: file.ufsUrl };
    }),
} satisfies FileRouter;

export type LarderFileRouter = typeof larderFileRouter;

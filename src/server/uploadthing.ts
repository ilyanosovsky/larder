import "server-only";

import { eq } from "drizzle-orm";
import { createUploadthing, type FileRouter } from "uploadthing/next";
import { UploadThingError } from "uploadthing/server";

import { db } from "@/db";
import { householdMembers, photoUploads } from "@/db/schema";
import { getSession } from "@/lib/session";

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
 * membership, both before the upload is authorized. Without it any visitor
 * with the URL could fill the household's storage tier.
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

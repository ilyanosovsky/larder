import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  aiJobs,
  categories,
  dishes,
  photoUploads,
  products,
} from "@/db/schema";
import {
  IMPORT_FAILURE_REASONS,
  type ImportFailureReason,
} from "@/lib/recipes/import-failure";
import { recipeDraftSchema, type RecipeDraft } from "@/lib/recipes/draft";
import { parseRecipe, type ParsedRecipe } from "@/server/ai/parse-recipe";
import { formatCostUsd } from "@/server/ai/pricing";
import { assertWithinRateLimit } from "@/server/ai/rate-limit-guard";
import { productColumns, toProductOutput } from "@/server/api/routers/product";
import {
  createTRPCRouter,
  householdProcedure,
  type TRPCContext,
} from "@/server/api/trpc";
import { Deadline, PHOTO_STAGE_MS } from "@/server/recipes/deadline";
import {
  draftFromParsed,
  type DraftSource,
  type ImportWarning,
} from "@/server/recipes/draft-from-parsed";
import { matchIngredients } from "@/server/recipes/match-ingredients";
import { UPLOADTHING_KEY_RE, uploadThingUrl } from "@/server/uploadthing-url";

type Database = TRPCContext["db"];

/**
 * The import router (blueprint §2.7, decision D26) — a file of its own so the
 * 4.2/4.6 pair and the 4.3/4.4 pair never edit `dish.ts` at the same time.
 *
 * **A parse failure is an `outcome`, never a thrown `TRPCError`.** S8.2's
 * whole design is a specific fallback per failure; throwing collapses nine
 * outcomes into one red box and, worse, loses the `jobId` — and with it the
 * cost record and the handle a reload needs to find the draft again. Only
 * `UNAUTHORIZED`, `FORBIDDEN` and `TOO_MANY_REQUESTS` throw; the last so the
 * existing `isRateLimitedError()` helper keeps working unchanged.
 */

export const importFailureReasonSchema = z.enum(IMPORT_FAILURE_REASONS);

/** Which branch produced the draft — S8.3 can say so honestly. */
export const importViaSchema = z.enum([
  "vision",
  "jsonld",
  "microdata",
  "firecrawl",
  "text",
]);

export const importWarningSchema = z.enum([
  "normalizationFailed",
  "noSteps",
  "noIngredients",
]);

/**
 * Anything salvaged from a failed import, so «создать вручную» starts
 * prefilled rather than empty. VISION's «без тупика» is only true if the dead
 * end still hands you something.
 */
export const importPartialOutput = z.object({
  title: z.string().nullable(),
  photoUrl: z.string().nullable(),
  photoKey: z.string().nullable(),
  sourceUrl: z.string().nullable(),
});

export const importResultOutput = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("parsed"),
    jobId: z.uuid(),
    draft: recipeDraftSchema,
    via: importViaSchema,
    warnings: z.array(importWarningSchema),
    /**
     * Set once the draft has been saved as a dish, so reopening the review
     * route redirects instead of offering to create a second copy of a recipe
     * the household already has.
     */
    consumedDishId: z.uuid().nullable(),
  }),
  z.object({
    outcome: z.literal("failed"),
    jobId: z.uuid(),
    reason: importFailureReasonSchema,
    partial: importPartialOutput,
  }),
  z.object({
    /** The job row exists and the call has not come back yet (decision C.5). */
    outcome: z.literal("running"),
    jobId: z.uuid(),
    partial: importPartialOutput,
  }),
]);

export type ImportResultOutput = z.infer<typeof importResultOutput>;

const fileKeyField = z.string().regex(UPLOADTHING_KEY_RE);

export const fromPhotoInput = z.object({ fileKey: fileKeyField });
export const discardPhotoInput = z.object({ fileKey: fileKeyField });
export const getJobInput = z.object({ jobId: z.uuid() });

/** Task 4.4 fills these bodies; the shapes ship now so it only fills bodies. */
export const fromUrlInput = z.object({ url: z.url().max(2000) });
export const fromTextInput = z.object({
  text: z.string().trim().min(20).max(20_000),
});

/**
 * A job still `running` after this long is not coming back: the tRPC route
 * caps at `maxDuration = 60`, so a row older than this lost its function
 * before it could close its own ledger entry. `getJob` reports it as
 * `aiUnavailable`, which is the reason whose fallback is «Ещё раз».
 */
const STALE_JOB_MS = 90_000;

export const dishImportRouter = createTRPCRouter({
  /**
   * The main import path (VISION scenario Б): a screenshot already sitting in
   * the gallery becomes a reviewable draft.
   *
   * The order below is the whole procedure, and each step is load-bearing:
   *
   * 1. **Ownership before anything else.** The input is a file *key*, and the
   *    key must belong to a `photo_uploads` row of this household. A key is a
   *    short guessable-shaped string; without this check any signed-in user
   *    could have OpenAI read another household's screenshot back to them.
   *    This happens before the rate-limit read and long before any network.
   * 2. **The `ai_jobs` row opens before the call**, because
   *    `src/server/ai/rate-limit.ts` counts those rows — a burst of calls
   *    still in flight has to count against the window already.
   * 3. **The ledger closes immediately after `parseRecipe` returns**, on both
   *    branches, *before* catalog matching and draft validation (decision
   *    C.2). Everything after that runs inside `try/finally`, so a throw
   *    downstream still leaves the row stamped `error` with the cost it
   *    already incurred. A ledger that only records the calls whose
   *    *post-processing* also succeeded under-reports exactly when things go
   *    wrong.
   * 4. **Never throws for a parse failure** — see the file comment.
   */
  fromPhoto: householdProcedure
    .input(fromPhotoInput)
    .output(importResultOutput)
    .mutation(async ({ ctx, input }) => {
      const householdId = ctx.household.id;
      const upload = await requireOwnedPhoto(
        ctx.db,
        householdId,
        input.fileKey,
      );

      await assertWithinRateLimit(ctx.db, ctx.user.id);

      const partial = {
        title: null,
        photoUrl: upload.url,
        photoKey: input.fileKey,
        sourceUrl: null,
      };

      const [job] = await ctx.db
        .insert(aiJobs)
        .values({
          householdId,
          userId: ctx.user.id,
          type: "parse_photo",
          status: "running",
          inputRef: input.fileKey,
        })
        .returning({ id: aiJobs.id });

      if (!job) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Opening an import job inserted no row",
        });
      }

      const deadline = new Deadline();
      const parsed = await parseRecipe({
        client: ctx.openai(),
        input: {
          kind: "photo",
          // Rebuilt server-side from the key: no client-supplied URL exists
          // anywhere on this path (decision D5).
          imageUrl: uploadThingUrl(input.fileKey),
        },
        options: {
          timeout: PHOTO_STAGE_MS,
          // No retry: it doubles both the latency someone is watching and the
          // bill, for a call whose fallback is instant and usable.
          maxRetries: 0,
          signal: deadline.signal(PHOTO_STAGE_MS),
        },
      });

      // Step 3 — the ledger, closed before anything else can fail.
      await ctx.db
        .update(aiJobs)
        .set(
          parsed.ok
            ? {
                status: "done",
                costUsd: formatCostUsd(parsed.costUsd),
                finishedAt: sql`now()`,
              }
            : {
                status: "error",
                error: parsed.error,
                costUsd: formatCostUsd(parsed.costUsd),
                finishedAt: sql`now()`,
              },
        )
        .where(and(eq(aiJobs.id, job.id), eq(aiJobs.householdId, householdId)));

      try {
        if (!parsed.ok) {
          return await recordResult(ctx.db, householdId, job.id, {
            outcome: "failed",
            jobId: job.id,
            reason: parsed.reason,
            partial,
          });
        }

        const drafted = await buildDraft(ctx.db, householdId, parsed.value, {
          sourceType: "photo",
          sourceUrl: null,
          photoUrl: upload.url,
          photoKey: input.fileKey,
        });

        if (!drafted.ok) {
          return await recordResult(ctx.db, householdId, job.id, {
            outcome: "failed",
            jobId: job.id,
            reason: drafted.reason,
            // The title the model *did* read is worth carrying into the manual
            // form even when the rest was unusable.
            partial: { ...partial, title: drafted.title },
          });
        }

        return await recordResult(ctx.db, householdId, job.id, {
          outcome: "parsed",
          jobId: job.id,
          draft: drafted.draft,
          via: "vision",
          warnings: drafted.warnings,
          consumedDishId: null,
        });
      } catch (error) {
        // The cost is already recorded above; this only makes the reason
        // visible in the ledger instead of leaving a job that says «done»
        // beside an import the user never received.
        await markJobError(ctx.db, householdId, job.id, error);
        throw error;
      }
    }),

  /**
   * The review route's own read, and S8.2's poll.
   *
   * The draft lives in `ai_jobs.output_json` (decision D4) rather than in a
   * `recipe_drafts` table: the job row and its cost are written anyway, and
   * keeping the draft there means a reload, a Back gesture or an iOS PWA
   * eviction while the user is in Photos cannot destroy a parse the household
   * has already paid for.
   */
  getJob: householdProcedure
    .input(getJobInput)
    .output(importResultOutput)
    .query(async ({ ctx, input }) => {
      const [job] = await ctx.db
        .select({
          id: aiJobs.id,
          status: aiJobs.status,
          inputRef: aiJobs.inputRef,
          outputJson: aiJobs.outputJson,
          createdAt: aiJobs.createdAt,
        })
        .from(aiJobs)
        .where(
          and(
            eq(aiJobs.id, input.jobId),
            eq(aiJobs.householdId, ctx.household.id),
          ),
        )
        .limit(1);

      if (!job) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such import" });
      }

      const stored = importResultOutput.safeParse(job.outputJson);
      if (stored.success) {
        return stored.data;
      }

      const partial = {
        title: null,
        photoUrl: null,
        photoKey: job.inputRef,
        sourceUrl: null,
      };

      // A row with no readable result is either still running or was lost
      // with its function. `maxDuration` is 60 s, so past 90 s the honest
      // answer is «попробуй ещё раз», not a spinner that never stops.
      const running =
        job.status === "running" &&
        Date.now() - job.createdAt.getTime() < STALE_JOB_MS;

      return running
        ? { outcome: "running", jobId: job.id, partial }
        : {
            outcome: "failed",
            jobId: job.id,
            reason: "aiUnavailable",
            partial,
          };
    }),

  /**
   * Throws away an uploaded photo — «Другое фото», and the review screen's
   * «Отмена».
   *
   * Two guards, in this order: the key must belong to this household, and it
   * must not be the photo of a saved dish. The second is what stops «Отмена»
   * on a review screen reopened after the save from deleting the blob a dish
   * is already rendering.
   *
   * A failure to delete the blob is deliberately not an error the user sees:
   * an orphan file is hygiene (R5), and refusing to move on because a
   * third-party delete call failed would be a dead end over nothing.
   */
  discardPhoto: householdProcedure
    .input(discardPhotoInput)
    .output(z.object({ ok: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const householdId = ctx.household.id;
      await requireOwnedPhoto(ctx.db, householdId, input.fileKey);

      const [used] = await ctx.db
        .select({ id: dishes.id })
        .from(dishes)
        .where(
          and(
            eq(dishes.householdId, householdId),
            eq(dishes.photoKey, input.fileKey),
          ),
        )
        .limit(1);

      if (used) {
        return { ok: false };
      }

      await ctx.db
        .delete(photoUploads)
        .where(
          and(
            eq(photoUploads.fileKey, input.fileKey),
            eq(photoUploads.householdId, householdId),
          ),
        );

      await deleteUploadedFile(input.fileKey);

      return { ok: true };
    }),

  /** Task 4.4. Declared now so the client's shape and the plan row are stable. */
  fromUrl: householdProcedure
    .input(fromUrlInput)
    .output(importResultOutput)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "URL import lands in task 4.4",
      });
    }),

  /** Task 4.4, as above. */
  fromText: householdProcedure
    .input(fromTextInput)
    .output(importResultOutput)
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "Text import lands in task 4.4",
      });
    }),
});

/**
 * The ownership check that makes a file key a capability.
 *
 * `FORBIDDEN` rather than `NOT_FOUND` for a key belonging to someone else: we
 * are not telling the caller whether the key exists, and the two cases are
 * indistinguishable from here anyway because the `WHERE` carries both
 * predicates.
 */
async function requireOwnedPhoto(
  db: Database,
  householdId: string,
  fileKey: string,
): Promise<{ url: string }> {
  const [row] = await db
    .select({ url: photoUploads.url })
    .from(photoUploads)
    .where(
      and(
        eq(photoUploads.householdId, householdId),
        eq(photoUploads.fileKey, fileKey),
      ),
    )
    .limit(1);

  if (!row) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Unknown upload for this household",
    });
  }

  return row;
}

type BuildDraftResult =
  | { ok: true; draft: RecipeDraft; warnings: ImportWarning[] }
  | { ok: false; reason: ImportFailureReason; title: string | null };

/**
 * Catalog matching and draft construction — everything between the AI answer
 * and the stored result.
 *
 * Runs *after* the ledger is closed, on purpose: it reads the household's
 * catalog, and a database hiccup here must not be the reason a paid call goes
 * unrecorded.
 */
async function buildDraft(
  db: Database,
  householdId: string,
  parsed: ParsedRecipe,
  source: DraftSource,
): Promise<BuildDraftResult> {
  const title = parsed.title.trim();
  const fallbackTitle = title.length === 0 ? null : title.slice(0, 120);

  // Sequential rather than `Promise.all`, matching `resolve-products.ts`:
  // two indexed reads of a household-sized table are cheap, and a fixed
  // statement order is what lets the router tests pin *which* read is which.
  const catalog = await db
    .select(productColumns)
    .from(products)
    .where(eq(products.householdId, householdId));

  const householdCategories = await db
    .select({
      id: categories.id,
      name: categories.name,
      sortOrder: categories.sortOrder,
    })
    .from(categories)
    .where(eq(categories.householdId, householdId))
    .orderBy(asc(categories.sortOrder));

  // Free and deterministic: a recipe's «Мука» is the household's «Мука» long
  // before anything has to be invented. Only `"catalog"` hits bind into the
  // draft — a `"reference"` hit still has to *create* a product, and products
  // are created on save (DESIGN_BRIEF S8.3), so those rows reach the form as
  // the honest «новый» state.
  const matches = matchIngredients({
    names: parsed.ingredients.map((row) => row.name),
    products: catalog.map((row) => toProductOutput(row)),
    categories: householdCategories,
  });

  const drafted = draftFromParsed({ parsed, matches, source });

  if (!drafted.ok) {
    return { ok: false, reason: drafted.reason, title: fallbackTitle };
  }

  // The output schema is the contract the review form and `dish.create` both
  // read, so it is checked here rather than at the tRPC boundary — where a
  // failure would be a 500 instead of an S8.2 fallback with the photo still
  // in hand.
  const valid = recipeDraftSchema.safeParse(drafted.draft);
  if (!valid.success) {
    return { ok: false, reason: "photoUnreadable", title: fallbackTitle };
  }

  return { ok: true, draft: valid.data, warnings: drafted.warnings };
}

/**
 * Writes the finished result into `ai_jobs.output_json` and hands it back.
 *
 * A second, small `UPDATE` rather than folding it into the one above: that
 * one is the ledger and has to land the instant the model answers, while this
 * one carries a draft that does not exist yet at that point. `jsonb_set` on
 * the existing document (rather than a plain overwrite) is what `dish.create`
 * expects — it later writes `consumedDishId` into the same object.
 */
async function recordResult(
  db: Database,
  householdId: string,
  jobId: string,
  result: ImportResultOutput,
): Promise<ImportResultOutput> {
  await db
    .update(aiJobs)
    .set({ outputJson: result })
    .where(and(eq(aiJobs.id, jobId), eq(aiJobs.householdId, householdId)));

  return result;
}

async function markJobError(
  db: Database,
  householdId: string,
  jobId: string,
  error: unknown,
): Promise<void> {
  await db
    .update(aiJobs)
    .set({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      finishedAt: sql`now()`,
    })
    .where(and(eq(aiJobs.id, jobId), eq(aiJobs.householdId, householdId)));
}

/**
 * Deletes the blob itself.
 *
 * The token is read **inside** the function and the SDK is imported lazily,
 * for the reason every other env reader in this codebase is lazy: `pnpm
 * build` runs with no environment at all. With no token there is no
 * UploadThing to talk to, so the call is skipped outright rather than
 * attempted and failed — which is also what keeps the router's unit tests off
 * the network.
 */
async function deleteUploadedFile(fileKey: string): Promise<void> {
  const token = process.env.UPLOADTHING_TOKEN;
  if (token === undefined || token.length === 0) {
    return;
  }

  try {
    const { UTApi } = await import("uploadthing/server");
    await new UTApi({ token }).deleteFiles([fileKey]);
  } catch {
    // Hygiene, not correctness (R5): the ownership row is already gone, so
    // the key can never be spent again, and an orphaned 300 KB blob costs the
    // free tier nothing measurable. A post-MVP sweep collects them.
  }
}

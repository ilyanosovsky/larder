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
import { MAX_IMPORT_TEXT, MIN_IMPORT_TEXT } from "@/lib/recipes/import-input";
import { parseRecipe, type ParsedRecipe } from "@/server/ai/parse-recipe";
import { formatCostUsd } from "@/server/ai/pricing";
import { assertWithinRateLimit } from "@/server/ai/rate-limit-guard";
import { productColumns, toProductOutput } from "@/server/api/routers/product";
import {
  createTRPCRouter,
  householdProcedure,
  type TRPCContext,
} from "@/server/api/trpc";
import { decideUrlStrategy, pageTitle } from "@/server/recipes/cascade";
import {
  canRunFirecrawl,
  Deadline,
  FETCH_STAGE_MS,
  finalStageMs,
  FIRECRAWL_STAGE_MS,
  PHOTO_STAGE_MS,
} from "@/server/recipes/deadline";
import {
  draftFromParsed,
  type DraftSource,
  type ImportWarning,
} from "@/server/recipes/draft-from-parsed";
import { fetchPage, type FetchPageResult } from "@/server/recipes/fetch-page";
import { firecrawlScrape } from "@/server/recipes/firecrawl";
import { matchIngredients } from "@/server/recipes/match-ingredients";
import {
  normalizeRecipe,
  type NormalizeInput,
  type NormalizeRecipeResult,
} from "@/server/recipes/normalize-recipe";
import { classifyImportUrl } from "@/server/recipes/url-guard";
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

export type ImportVia = z.infer<typeof importViaSchema>;

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

/**
 * The import's answer — and, because the draft is stored rather than held in
 * memory, **the on-disk shape of `ai_jobs.output_json` as well**.
 *
 * That dual role is the reason every field this schema gains later must be
 * readable as absent. `getJob` parses rows written by whatever deploy created
 * them, and a strictly-required new key would make every older document fail
 * validation — which `getJob` can only report as `aiUnavailable`, quietly
 * turning «на фото не рецепт» into «попробуй ещё раз». So a field added after
 * the first release carries `.default(null)`, and a *new* field is nullable
 * rather than optional (the same rule the drafts follow).
 */
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
     *
     * `.default(null)` because this schema **also parses documents written by
     * an earlier deploy** — see the note on `importResultOutput`.
     */
    consumedDishId: z.uuid().nullable().default(null),
  }),
  z.object({
    outcome: z.literal("failed"),
    jobId: z.uuid(),
    reason: importFailureReasonSchema,
    partial: importPartialOutput,
    /**
     * Set when this failed import still became a dish — «создать вручную»
     * saves with the same `jobId`, so `dish.create` stamps it here too and
     * reopening the import URL redirects instead of re-offering a dead end.
     */
    consumedDishId: z.uuid().nullable().default(null),
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

/**
 * The URL import's input — and its SSRF guard.
 *
 * The refusal lives on the **schema**, not in the resolver, because decision
 * C.8 says a blocked URL is a validation rejection with no `ai_jobs` row: the
 * ledger counts calls the household could be billed for, and refusing
 * `http://169.254.169.254/` before anything happens is not one. tRPC turns a
 * failed refinement into `BAD_REQUEST`, which S8.2 renders with the
 * `blockedUrl` copy — the one failure that carries no `jobId` because there
 * is deliberately nothing to record.
 */
export const fromUrlInput = z.object({
  url: z
    .url()
    .max(2000)
    .refine((value) => classifyImportUrl(value).kind !== "blocked", {
      error: "URL is not fetchable",
    }),
});

export const fromTextInput = z.object({
  // The bounds come from `@/lib/recipes/import-input`, which S8.1's field
  // also reads: a client that refuses at a different length than the server
  // either shows a spinner before a 400 or blocks a text the server would
  // have taken.
  text: z.string().trim().min(MIN_IMPORT_TEXT).max(MAX_IMPORT_TEXT),
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
   *    C.2). Everything after that runs inside a `try/catch` that re-throws,
   *    so a failure downstream still leaves the row stamped — with the cost
   *    it already incurred *and* the reason. (`catch` rather than `finally`
   *    precisely so the reason is available to write.) A ledger that only
   *    recorded the calls whose *post-processing* also succeeded would
   *    under-report exactly when things go wrong.
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

      // Built before the ledger row, not after: `uploadThingUrl` throws on a
      // missing or malformed `UPLOADTHING_TOKEN`, and a deployment
      // misconfiguration should fail outright rather than leave a `running`
      // job nothing will ever close.
      const imageUrl = uploadThingUrl(input.fileKey);

      const partial = {
        title: null,
        photoUrl: upload.url,
        photoKey: input.fileKey,
        sourceUrl: null,
      };

      const job = await openJob(ctx.db, {
        householdId,
        userId: ctx.user.id,
        type: "parse_photo",
        inputRef: input.fileKey,
      });

      const deadline = new Deadline();
      const parsed = await parseRecipe({
        client: ctx.openai(),
        // `imageUrl` was rebuilt server-side from the key above: no
        // client-supplied URL exists anywhere on this path (decision D5).
        input: { kind: "photo", imageUrl },
        options: {
          timeout: PHOTO_STAGE_MS,
          // No retry: it doubles both the latency someone is watching and the
          // bill, for a call whose fallback is instant and usable.
          maxRetries: 0,
          signal: deadline.signal(PHOTO_STAGE_MS),
        },
      });

      // Step 3 — the ledger, closed before anything else can fail.
      await closeJob(ctx.db, householdId, job.id, {
        error: parsed.ok ? null : parsed.error,
        costUsd: parsed.costUsd,
      });

      try {
        if (!parsed.ok) {
          return await recordResult(ctx.db, householdId, job.id, {
            outcome: "failed",
            jobId: job.id,
            reason: parsed.reason,
            partial,
            consumedDishId: null,
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
            consumedDishId: null,
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
          type: aiJobs.type,
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

      // `input_ref` is the file key only for a photo job; for task 4.4's URL
      // and text jobs it is a URL and a text prefix, and reading either as a
      // `photoKey` would hand the client a delete handle for nothing.
      const partial = {
        title: null,
        photoUrl: null,
        photoKey: job.type === "parse_photo" ? job.inputRef : null,
        sourceUrl: job.type === "parse_url" ? job.inputRef : null,
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
            consumedDishId: null,
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

      // Not wrapped: `uploadedFileStore.deleteFiles` never throws, by design
      // — the ownership row is already gone, so the key can never be spent
      // again, and a third-party delete failure must not become a dead end.
      await ctx.uploadThing().deleteFiles([input.fileKey]);

      return { ok: true };
    }),

  /**
   * Import by link — the cascade (VISION §6.4, blueprint §3.2).
   *
   * ```
   * classifyImportUrl  ← already ran, on the input schema: blocked never gets here
   * INSERT ai_jobs (parse_url, running)          ← BEFORE the fetch (D16)
   * fetchPage            8 s   → JSON-LD? microdata?   (free)
   * firecrawlScrape     20 s   → only if nothing structured AND ≥10 s left
   * normalizeRecipe     25 s   → ALWAYS, free path included (D15)
   * UPDATE ai_jobs (cost, on both branches)      ← immediately after (C.2)
   * ```
   *
   * Three orderings are load-bearing and each has its own reason:
   *
   * 1. **The job row opens before the fetch, not before the AI call.**
   *    `src/server/ai/rate-limit.ts` counts `ai_jobs` rows, so an endpoint
   *    hammered with unreachable hosts must still count against the window. A
   *    run that dies at the fetch closes as `error` with `costUsd = 0`.
   * 2. **The ledger closes the instant the AI answers**, before catalog
   *    matching and draft validation, exactly as `fromPhoto` does.
   * 3. **One `Deadline` for all three stages.** Independent timeouts would
   *    sum past `maxDuration = 60` and return a 504 — the single outcome S8.2
   *    has no copy for, because it carries no `jobId`.
   */
  fromUrl: householdProcedure
    .input(fromUrlInput)
    .output(importResultOutput)
    .mutation(async ({ ctx, input }) => {
      const householdId = ctx.household.id;
      const classified = classifyImportUrl(input.url);

      if (classified.kind === "blocked") {
        // Unreachable in practice — the input schema refuses these — but the
        // guard is not going to live in one place only.
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "URL is not fetchable",
        });
      }

      const url = classified.url;
      await assertWithinRateLimit(ctx.db, ctx.user.id);

      const job = await openJob(ctx.db, {
        householdId,
        userId: ctx.user.id,
        type: "parse_url",
        inputRef: url,
      });

      const deadline = new Deadline();
      const transport = ctx.pageFetch();

      // A login wall answers a server with a login page, so the direct fetch
      // is skipped rather than spent (VISION §6.4).
      const fetched =
        classified.kind === "social"
          ? null
          : await fetchPage(url, {
              ...transport,
              signal: deadline.signal(FETCH_STAGE_MS),
            });

      const html = fetched?.kind === "html" ? fetched.html : null;
      const partial = {
        title: html === null ? null : pageTitle(html),
        photoUrl: null,
        photoKey: null,
        sourceUrl: url,
      };

      // Two fetch outcomes end the import here rather than falling through:
      // a hop that pointed somewhere private (scraping it through FireCrawl
      // would be the same request with an extra step), and a body past the
      // cap (a page that size has no recipe card in it).
      if (fetched?.kind === "blocked" || fetched?.kind === "tooLarge") {
        return await failImport(ctx.db, householdId, job.id, {
          reason: fetched.kind === "blocked" ? "blockedUrl" : "tooLarge",
          partial,
          error: `fetch ${fetched.kind}`,
        });
      }

      const strategy = decideUrlStrategy({ url, html });
      let via: ImportVia;
      let normalizeInput: NormalizeInput;
      let image: string | null = null;

      if (strategy.kind === "jsonld" || strategy.kind === "microdata") {
        via = strategy.kind;
        image = usablePhotoUrl(strategy.skeleton.image);
        normalizeInput = { kind: "skeleton", skeleton: strategy.skeleton };
      } else {
        if (!canRunFirecrawl(deadline.remainingMs())) {
          return await failImport(ctx.db, householdId, job.id, {
            reason: "pageBlocked",
            partial,
            error: "No budget left for a scrape",
          });
        }

        const scraped = await firecrawlScrape(url, {
          fetch: transport.fetch,
          signal: deadline.signal(FIRECRAWL_STAGE_MS),
        });

        if (!scraped.ok) {
          return await failImport(ctx.db, householdId, job.id, {
            reason: scrapeFailureReason(
              classified.kind,
              fetched,
              scraped.reason,
            ),
            partial,
            error: `firecrawl ${scraped.reason}`,
          });
        }

        via = "firecrawl";
        normalizeInput = { kind: "markdown", markdown: scraped.markdown };
      }

      // The last stage takes what is left: a page that answered in two
      // seconds should not make the model give up at twenty-five.
      const normalizeMs = finalStageMs(deadline.remainingMs());
      if (normalizeMs === 0) {
        // A call with no budget can only be aborted, and an aborted call is
        // still a request somebody's quota paid for. «Ещё раз» is the honest
        // offer: whatever ate the budget — a slow page, a slow scrape — is
        // usually not there the second time.
        return await failImport(ctx.db, householdId, job.id, {
          reason: "aiUnavailable",
          partial,
          error: "No budget left to read the page",
        });
      }

      const normalized = await normalizeRecipe({
        client: ctx.openai(),
        input: normalizeInput,
        options: {
          timeout: normalizeMs,
          maxRetries: 0,
          signal: deadline.signal(normalizeMs),
        },
      });

      await closeJob(ctx.db, householdId, job.id, normalized);

      return await finishImport(ctx.db, householdId, job.id, {
        normalized,
        via,
        partial,
        source: {
          sourceType: "url",
          sourceUrl: url,
          // A page's own image is stored as the **remote URL** with no
          // `photoKey`: it was never uploaded, so there is no blob of ours to
          // discard, and re-hosting somebody's photo to save a hotlink is a
          // decision (and a bill) this feature does not need to make.
          photoUrl: image,
          photoKey: null,
        },
      });
    }),

  /**
   * Import by pasted text (blueprint §3.3).
   *
   * The **same** normalizer, the same prompt family and the same ledger order
   * as the two branches above. There is deliberately no second parser: a fix
   * to ingredient parsing has to fix photo, page and pasted text at once, or
   * the three drift and only one of them stays good.
   */
  fromText: householdProcedure
    .input(fromTextInput)
    .output(importResultOutput)
    .mutation(async ({ ctx, input }) => {
      const householdId = ctx.household.id;
      await assertWithinRateLimit(ctx.db, ctx.user.id);

      const job = await openJob(ctx.db, {
        householdId,
        userId: ctx.user.id,
        type: "parse_text",
        // The ledger is not a document store: enough to recognise the row in
        // a spend report, and nothing like a copy of what was pasted.
        inputRef: `text:${input.text.slice(0, 80)}`,
      });

      // The only stage there is, so it gets the whole budget less the
      // reserve — same rule as the URL path's last stage.
      const deadline = new Deadline();
      const normalizeMs = finalStageMs(deadline.remainingMs());
      const normalized = await normalizeRecipe({
        client: ctx.openai(),
        input: { kind: "text", text: input.text },
        options: {
          timeout: normalizeMs,
          maxRetries: 0,
          signal: deadline.signal(normalizeMs),
        },
      });

      await closeJob(ctx.db, householdId, job.id, normalized);

      return await finishImport(ctx.db, householdId, job.id, {
        normalized,
        via: "text",
        partial: {
          title: null,
          photoUrl: null,
          photoKey: null,
          sourceUrl: null,
        },
        source: {
          sourceType: "text",
          sourceUrl: null,
          photoUrl: null,
          photoKey: null,
        },
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

/**
 * Opens the ledger row every import path shares.
 *
 * One helper rather than three copies, because the *timing* is the contract:
 * `src/server/ai/rate-limit.ts` counts these rows, so the insert has to
 * happen before the work — before the vision call on the photo path, and
 * before the network on the URL path (decision D16).
 */
async function openJob(
  db: Database,
  values: {
    householdId: string;
    userId: string;
    type: "parse_photo" | "parse_url" | "parse_text";
    inputRef: string;
  },
): Promise<{ id: string }> {
  const [job] = await db
    .insert(aiJobs)
    .values({ ...values, status: "running" })
    .returning({ id: aiJobs.id });

  if (!job) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Opening an import job inserted no row",
    });
  }

  return job;
}

/**
 * Closes the ledger row — **the statement that runs immediately after the
 * model answers**, on both branches, before coercion, catalog matching and
 * draft validation (decision C.2).
 *
 * The cost is written whether or not the answer was usable: a response that
 * arrived and then failed validation was billed, and a ledger that counts
 * only the successes under-reports exactly when things go wrong.
 *
 * Also called by the URL path's pre-AI failures with `costUsd: 0` — a run
 * that died at the fetch still has to close the row it opened, or the
 * limiter's count and the spend report would disagree about what happened.
 */
async function closeJob(
  db: Database,
  householdId: string,
  jobId: string,
  outcome: { error: string | null; costUsd: number },
): Promise<void> {
  await db
    .update(aiJobs)
    .set({
      status: outcome.error === null ? "done" : "error",
      error: outcome.error,
      costUsd: formatCostUsd(outcome.costUsd),
      finishedAt: sql`now()`,
    })
    .where(and(eq(aiJobs.id, jobId), eq(aiJobs.householdId, householdId)));
}

/**
 * A URL import that ended before the AI: closes the row with no cost and
 * stores the S8.2 outcome.
 */
async function failImport(
  db: Database,
  householdId: string,
  jobId: string,
  failure: {
    reason: ImportFailureReason;
    partial: z.infer<typeof importPartialOutput>;
    error: string;
  },
): Promise<ImportResultOutput> {
  await closeJob(db, householdId, jobId, {
    error: failure.error,
    costUsd: 0,
  });

  return await recordResult(db, householdId, jobId, {
    outcome: "failed",
    jobId,
    reason: failure.reason,
    partial: failure.partial,
    consumedDishId: null,
  });
}

/**
 * Everything after the ledger closed: catalog matching, the draft, and the
 * stored result.
 *
 * Wrapped in the same `try/catch` `fromPhoto` uses, and for the same reason —
 * the cost is already recorded, so this only makes a later failure *visible*
 * in the ledger instead of leaving a row that says «done» beside an import
 * nobody received.
 */
async function finishImport(
  db: Database,
  householdId: string,
  jobId: string,
  args: {
    normalized: NormalizeRecipeResult;
    via: ImportVia;
    partial: z.infer<typeof importPartialOutput>;
    source: DraftSource;
  },
): Promise<ImportResultOutput> {
  const { normalized, via, partial, source } = args;

  try {
    if (normalized.parsed === null) {
      return await recordResult(db, householdId, jobId, {
        outcome: "failed",
        jobId,
        reason: normalized.reason ?? "aiUnavailable",
        partial,
        consumedDishId: null,
      });
    }

    const drafted = await buildDraft(
      db,
      householdId,
      normalized.parsed,
      source,
    );

    if (!drafted.ok) {
      return await recordResult(db, householdId, jobId, {
        outcome: "failed",
        jobId,
        reason: drafted.reason,
        partial: { ...partial, title: drafted.title ?? partial.title },
        consumedDishId: null,
      });
    }

    return await recordResult(db, householdId, jobId, {
      outcome: "parsed",
      jobId,
      draft: drafted.draft,
      via,
      warnings: [...normalized.warnings, ...drafted.warnings],
      consumedDishId: null,
    });
  } catch (error) {
    await markJobError(db, householdId, jobId, error);
    throw error;
  }
}

/**
 * Which S8.2 copy a failed scrape earns (blueprint §3.6).
 *
 * The order matters. A login wall is `loginWalled` whatever else happened —
 * that is the branch whose copy names the screenshot as the better road. A
 * scrape that came back but was too thin is `noRecipeOnPage`: the page was
 * reachable, it simply had no recipe on it. Otherwise the *direct* fetch's
 * own verdict decides, because it is the more specific one: a dead host is
 * «не удалось прочитать страницу», a 403 is «страница не отдала рецепт».
 */
function scrapeFailureReason(
  classified: "ok" | "social",
  fetched: FetchPageResult | null,
  scrape: "blocked" | "empty",
): ImportFailureReason {
  if (classified === "social") {
    return "loginWalled";
  }
  if (scrape === "empty") {
    return "noRecipeOnPage";
  }
  if (fetched?.kind === "unreachable" || fetched?.kind === "notHtml") {
    return "pageUnreachable";
  }
  return "pageBlocked";
}

/**
 * A page's own image, if it fits where it is going.
 *
 * `recipeDraftSchema.photoUrl` caps at 500 characters, and a longer CDN URL
 * would fail the *whole* draft's validation — reporting a perfectly good
 * import as a failure over a picture. Dropping the image instead costs a
 * thumbnail.
 */
function usablePhotoUrl(url: string | null): string | null {
  if (url === null || url.length > 500 || !/^https?:\/\//i.test(url)) {
    return null;
  }
  return url;
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
    return {
      ok: false,
      // «Попробуй другой скриншот» is only sensible when there *is* a
      // screenshot. On the URL and text paths the same failure means the
      // model produced something this app cannot store, and the way out is
      // «ещё раз» or «вручную».
      reason:
        source.sourceType === "photo" ? "photoUnreadable" : "aiUnavailable",
      title: fallbackTitle,
    };
  }

  return { ok: true, draft: valid.data, warnings: drafted.warnings };
}

/**
 * Writes the finished result into `ai_jobs.output_json` and hands it back.
 *
 * A second, small `UPDATE` rather than folding it into the one above: that
 * one is the ledger and has to land the instant the model answers, while this
 * one carries a draft that does not exist yet at that point. This write is a
 * plain overwrite; `dish.create` is the one that later merges
 * `consumedDishId` into the same document with `jsonb_set`, which is why it
 * must survive an older shape — see the note on `importResultOutput`.
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

import { z } from "zod";

/**
 * The recipe a model returns, and the only shape any import branch produces
 * (blueprint §2.2, decision D7).
 *
 * **Primitives only.** No `z.enum`, no `z.uuid()`, no unions, and no
 * `.min()`/`.max()`/`.trim()` at any depth — `z.toJSONSchema` emits
 * `minLength`/`maxLength`/`minimum`/`maximum`/`format`/`pattern` for those,
 * and OpenAI's strict mode rejects every one of them with a 400 on the *first
 * real call*, not at build time. `enrichedProductSchema` never exercised
 * nesting, arrays of objects or nullables, so this is untested ground in this
 * repo; the colocated `parse-recipe.schema.test.ts` walks the emitted
 * document at every depth and is what stops a later tidy-up `.max(200)` from
 * breaking every import in production.
 *
 * Bounds are not lost, only moved: `recipeDraftSchema`
 * (`src/lib/recipes/draft.ts`) applies all of them on the way into a draft,
 * where an out-of-range value can be turned into `null` + «уточнить» for that
 * one row instead of failing the whole recipe.
 *
 * `.nullable()` and never `.optional()` (AGENTS.md): strict mode requires
 * every property to be `required`, so an optional property is simply not
 * expressible.
 */
export const parsedRecipeSchema = z.object({
  /**
   * The model's own escape hatch. A photo of a cat comes back `false`, and
   * S8.2 shows the honest «это не рецепт» copy instead of a hallucinated
   * recipe — which is exactly what a vision model produces when handed a
   * non-recipe. Inferring failure from an empty ingredient list does not
   * catch that; a boolean does (decision D6).
   */
  isRecipe: z.boolean(),
  title: z.string(),
  /**
   * The portion count the quantities below are stated for, and the **upper**
   * end of a stated range («7–8 печений» → 8). Upper, not lower: a source
   * that says «7–8» weighed its flour for the batch it actually makes.
   */
  portionsBase: z.number().nullable(),
  /** The lower end of a stated range, else null. Display only. */
  portionsMin: z.number().nullable(),
  /** The source's own yield noun — «печений», «шт». `null` means «порции». */
  yieldUnit: z.string().nullable(),
  totalTimeMin: z.number().nullable(),
  /** Free Russian words: «духовка», «миксер». Coerced to slugs server-side. */
  equipment: z.array(z.string()),
  tags: z.array(z.string()),
  ingredients: z.array(
    z.object({
      /** The source line, verbatim — the honesty anchor VISION §6.4 asks for. */
      rawText: z.string(),
      /** The buyable noun ONLY: «Шоколад» out of «Шоколад крупными кусками». */
      name: z.string(),
      qty: z.number().nullable(),
      /**
       * Free Russian text, **not** `z.enum(RECIPE_UNITS)`. An enum forces the
       * model to bucket «зубчик» into the nearest listed unit and emit a
       * confidently wrong quantity — the exact honesty failure VISION §6.4
       * forbids. `coerceRecipeUnit` maps what it can and routes the rest into
       * `note`, where it survives as words instead of as a wrong number.
       */
      unit: z.string().nullable(),
      /** «холодное», «по вкусу», «зубчик». */
      note: z.string().nullable(),
      isOptional: z.boolean(),
    }),
  ),
  steps: z.array(
    z.object({
      text: z.string(),
      /** Countdown length in seconds — the LOWER bound of a stated range. */
      timerSec: z.number().nullable(),
      /** Upper bound, so «9–11 мин» is two numbers and one ICU message. */
      timerMaxSec: z.number().nullable(),
    }),
  ),
});

export type ParsedRecipe = z.infer<typeof parsedRecipeSchema>;

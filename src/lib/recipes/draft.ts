import { z } from "zod";

import { recipeUnitSchema } from "@/lib/units";
import { MAX_TAG_LENGTH, MAX_TAGS, normalizeTags } from "@/lib/recipes/tags";
import { MAX_QTY, MIN_QTY } from "@/server/cart/merge";
import { EQUIPMENT_PRESETS } from "@/server/kitchen/equipment";
import { deriveNeedsReview } from "@/server/recipes/needs-review";
import type { DishDetailOutput } from "@/server/api/routers/dish";

/**
 * `RecipeDraft` — the one recipe contract phase 4 has, and the reason the
 * phase holds together.
 *
 * It has six producers (vision parsing, JSON-LD, microdata, FireCrawl + AI,
 * pasted text, the manual form) and one consumer: the S8.3 form, which is at
 * the same time the manual-create form, the import-review form and the edit
 * form. Everything here exists to keep that single shape honest — bounded on
 * every field, nullable rather than optional, and identical whether it came
 * out of a model, off the wire or out of a text input.
 *
 * **Client-safe by construction.** This module imports `zod`, the unit canon
 * and two pure server modules that hold no database (`@/server/cart/merge`
 * for the quantity bounds — `src/lib/cart/qty-step.ts` already does the same
 * — and `@/server/kitchen/equipment` for the preset slugs). No `server-only`,
 * no drizzle: `src/db/schema.ts` takes `DISH_SOURCE_TYPES` from *here*, not
 * the other way round, so an output schema never drags the schema module into
 * a client bundle.
 *
 * `.nullable()` everywhere, never `.optional()`: a draft with a missing key
 * and a draft with an explicit `null` would be two shapes for one thing, and
 * the form would have to handle both.
 *
 * **React list keys do not live here.** The form holds
 * `{ key: string; value: DraftIngredient }[]` in its own state with
 * `crypto.randomUUID()` keys; `key` never crosses the wire. An array index as
 * a React key breaks reorder.
 */

/**
 * Where a dish came from. Drives S7's «~30 мин · 📷 с фото» source line and
 * which re-import affordance S8.2 offers, so it is a real enum in Postgres
 * (`dish_source_type`) — a closed four-value set with no safe fallback for an
 * unknown member.
 *
 * Declared here rather than in `src/db/schema.ts` for the same reason `UNITS`
 * lives in `src/lib/units.ts`: the vocabulary is shared by the client and the
 * database, and only one of the two may be imported from a browser bundle.
 */
export const DISH_SOURCE_TYPES = ["photo", "url", "text", "manual"] as const;

export type DishSourceType = (typeof DISH_SOURCE_TYPES)[number];

export const dishSourceTypeSchema = z.enum(DISH_SOURCE_TYPES);

/**
 * The bounds `recipeDraftSchema` enforces, **exported** because a producer has
 * to truncate to exactly these numbers before it validates against them.
 *
 * `draftFromParsed` (task 4.3) is the producer that needs them: it turns an
 * unbounded model answer into a draft, and a cap that drifted from the schema
 * would make it emit drafts the schema then rejects — which the import router
 * can only report as «фото не читается» for a parse the household was already
 * billed for. They were duplicated there once; importing them makes the drift
 * unrepresentable rather than merely tested for.
 */

/** Longest a verbatim source line may be before it stops being a line. */
export const MAX_RAW_TEXT = 300;
/** The buyable noun only — anything longer is a sentence, not a name. */
export const MAX_NAME = 100;
/** «(холодное)», «крупными кусками», «по вкусу». */
export const MAX_NOTE = 100;
export const MAX_TITLE = 120;
export const MAX_STEP_TEXT = 2000;
export const MAX_INGREDIENTS = 60;
export const MAX_STEPS = 60;
export const MAX_EQUIPMENT = 12;
/** «печений», «шт» — the source's own yield noun, not a sentence. */
export const MAX_YIELD_UNIT = 24;
/** A day. Longer than any countdown a step can honestly ask a cook to wait. */
export const MAX_TIMER_SEC = 86_400;
/** A hundred portions is a catering job, not a household recipe. */
export const MAX_PORTIONS = 100;
/** 100 hours. A cold ferment is long; nothing is longer than this. */
export const MAX_TOTAL_TIME_MIN = 6000;
/**
 * `recipes.source_url` as stored. `classifyImportUrl` refuses a link whose
 * *normalized* href would not fit, before a job row exists — see there.
 */
export const MAX_SOURCE_URL = 2000;

/**
 * A URL we are willing to store and later render.
 *
 * zod 4's `z.url()` accepts **any** scheme that `new URL()` parses, including
 * `javascript:` and `data:` — so the protocol constraint is explicit. Without
 * it, an imported `photoUrl` could end up in an `<img src>` (or a `sourceUrl`
 * in an `<a href>`) carrying a scheme the browser executes.
 */
function httpUrl(max: number) {
  return z.url({ protocol: /^https?$/ }).max(max);
}

export const draftIngredientSchema = z.object({
  /**
   * The source line verbatim — the honesty anchor VISION §6.4 asks for, what
   * a re-match or a 4.6 adaptation diffs against. Empty for a row typed by
   * hand, which never had a source line.
   */
  rawText: z.string().trim().max(MAX_RAW_TEXT),
  /** The buyable noun: «Шоколад» out of «Шоколад крупными кусками — 150 г». */
  name: z.string().trim().min(1).max(MAX_NAME),
  /**
   * Bounded by what `numeric(10, 3)` can hold without rounding to nothing —
   * the same `MIN_QTY`/`MAX_QTY` the cart validates against, because phase
   * 5.2 sums these numbers straight into cart rows.
   */
  qty: z.number().min(MIN_QTY).max(MAX_QTY).nullable(),
  unit: recipeUnitSchema.nullable(),
  note: z.string().trim().max(MAX_NOTE).nullable(),
  isOptional: z.boolean(),
  /**
   * Carried so the form can render the chip it is already showing, but never
   * trusted: `dish.create`/`dish.update` recompute it with
   * `deriveNeedsReview` on every save.
   */
  needsReview: z.boolean(),
  /**
   * The bound catalog row, or `null` = «новый». The server verifies any
   * non-null id against the caller's own catalog before it writes, and
   * decides reference-vs-enrich itself (task 4.2) — the client cannot claim
   * either.
   */
  productId: z.uuid().nullable(),
});

export const draftStepSchema = z.object({
  text: z.string().trim().min(1).max(MAX_STEP_TEXT),
  /** Countdown length, the LOWER bound of a range: you check at 9, not at 11. */
  timerSec: z.number().int().min(1).max(MAX_TIMER_SEC).nullable(),
  /** Upper bound, so S9 renders «9–11 мин» from two integers, not a stored label. */
  timerMaxSec: z.number().int().min(1).max(MAX_TIMER_SEC).nullable(),
});

export type DraftIngredient = z.infer<typeof draftIngredientSchema>;
export type DraftStep = z.infer<typeof draftStepSchema>;

export const recipeDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE),
    photoUrl: httpUrl(500).nullable(),
    /** The UploadThing file key — the only handle that can delete the blob. */
    photoKey: z.string().trim().max(200).nullable(),
    /**
     * The caps come from `tags.ts`, not from literals repeated here: the
     * client normalizes with `normalizeTags` and the server validates with
     * this schema, so two numbers that drifted apart would reject a payload
     * the form itself had just produced.
     */
    tags: z.array(z.string().trim().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS),
    sourceType: dishSourceTypeSchema,
    sourceUrl: httpUrl(MAX_SOURCE_URL).nullable(),
    /**
     * The portion count the quantities below are stated for — the number
     * every rescale divides by, and the **upper** end of a stated range
     * («7–8 печений» → 8). Ingredient amounts always belong to this number.
     */
    portionsBase: z.number().int().min(1).max(MAX_PORTIONS),
    /** The lower end of a stated range, or null. Display only. */
    portionsMin: z.number().int().min(1).max(MAX_PORTIONS).nullable(),
    /**
     * The source's own yield noun — «печений», «шт». `null` means «порции».
     * Imported data like `rawText`, never UI copy: it is rendered *through* an
     * ICU message that takes the noun as a parameter, so the surrounding
     * words still come from next-intl.
     */
    yieldUnit: z.string().trim().max(MAX_YIELD_UNIT).nullable(),
    totalTimeMin: z.number().int().min(1).max(MAX_TOTAL_TIME_MIN).nullable(),
    /**
     * Preset slugs only — a deliberate deviation from
     * `kitchen_profiles.equipment`, which stores slugs and free text side by
     * side. This array exists solely to be compared against that profile
     * (4.5's banner, 4.6's adaptation), and comparing a parser's «миксер»
     * against a profile's `mixer` silently never matches.
     */
    equipment: z.array(z.enum(EQUIPMENT_PRESETS)).max(MAX_EQUIPMENT),
    /**
     * `min(0)` on purpose: an ingredient card with no numbered steps and a
     * bake sheet with no ingredient list must both reach the review form.
     * **`ingredients.min(1)` is enforced at save**, in the router, not here.
     */
    ingredients: z.array(draftIngredientSchema).max(MAX_INGREDIENTS),
    steps: z.array(draftStepSchema).max(MAX_STEPS),
  })
  .refine(
    (draft) =>
      draft.steps.every(
        (step) =>
          step.timerMaxSec === null ||
          (step.timerSec !== null && step.timerMaxSec >= step.timerSec),
      ),
    {
      // An upper bound with no lower bound is not a range, it is a countdown
      // S9 could not start; and an upper below the lower is a misread.
      message: "timerMaxSec needs a timerSec at or below it",
      path: ["steps"],
    },
  )
  .refine(
    (draft) =>
      draft.portionsMin === null || draft.portionsMin < draft.portionsBase,
    {
      // Equal bounds are not a range — «8–8 порций» is «8 порций», and
      // storing it would make S7 render a range for a single number.
      message: "portionsMin must be below portionsBase",
      path: ["portionsMin"],
    },
  );

export type RecipeDraft = z.infer<typeof recipeDraftSchema>;

/** The «✍️ Вручную» starting point (task 4.2's `/dishes/new`). */
export function emptyDraft(): RecipeDraft {
  return {
    title: "",
    photoUrl: null,
    photoKey: null,
    tags: [],
    sourceType: "manual",
    sourceUrl: null,
    portionsBase: 2,
    portionsMin: null,
    yieldUnit: null,
    totalTimeMin: null,
    equipment: [],
    ingredients: [],
    steps: [],
  };
}

/**
 * Seeds the edit form from a saved dish — the round trip that makes S8.3 one
 * form rather than three.
 *
 * `id`/`sortOrder`/`inPantry` and the joined product columns are dropped:
 * they are facts about the stored aggregate, not about the recipe, and the
 * save path mints fresh child rows anyway (full replace, §3.7).
 */
export function draftFromDetail(detail: DishDetailOutput): RecipeDraft {
  return {
    title: detail.title,
    photoUrl: detail.photoUrl,
    photoKey: detail.photoKey,
    tags: [...detail.tags],
    sourceType: detail.sourceType,
    sourceUrl: detail.sourceUrl,
    portionsBase: detail.recipe.portionsBase,
    portionsMin: detail.recipe.portionsMin,
    yieldUnit: detail.recipe.yieldUnit,
    totalTimeMin: detail.recipe.totalTimeMin,
    equipment: detail.recipe.equipment.filter(isEquipmentSlug),
    ingredients: detail.ingredients.map((row) => ({
      rawText: row.rawText,
      name: row.name,
      qty: row.qty,
      unit: row.unit,
      note: row.note,
      isOptional: row.isOptional,
      needsReview: row.needsReview,
      productId: row.productId,
    })),
    steps: detail.steps.map((step) => ({
      text: step.text,
      timerSec: step.timerSec,
      timerMaxSec: step.timerMaxSec,
    })),
  };
}

/**
 * `recipes.equipment` is a text array, so a slug retired from
 * `EQUIPMENT_PRESETS` could still be sitting in an old row. Dropped on the
 * way into a draft rather than failing the whole edit for one stale word —
 * the same "degrade one field, never the aggregate" rule the unit column
 * follows on read.
 */
function isEquipmentSlug(
  value: string,
): value is (typeof EQUIPMENT_PRESETS)[number] {
  return (EQUIPMENT_PRESETS as readonly string[]).includes(value);
}

/** Blank means absent — an empty text input is not a note. */
function emptyToNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The last thing that happens to a draft before it is written, and the same
 * function the form runs so what it shows is what gets stored.
 *
 * - trims every string and turns blank optionals into `null`;
 * - drops ingredient rows with no name and steps with no text — a row the
 *   user emptied is a row they deleted;
 * - normalizes tags (`normalizeTags`);
 * - **recomputes `needsReview`** from `deriveNeedsReview`, never copying what
 *   arrived;
 * - drops a `timerMaxSec` that has no `timerSec` under it, and a
 *   `portionsMin` that is not actually below `portionsBase` — so the result
 *   still satisfies `recipeDraftSchema`'s refinements.
 *
 * Order is preserved and *is* the meaning: the router mints `sort_order` /
 * `step_order` `0..n-1` from the surviving array positions.
 */
export function normalizeDraftForSave(draft: RecipeDraft): RecipeDraft {
  const ingredients = draft.ingredients
    .map((row) => ({
      ...row,
      rawText: row.rawText.trim(),
      name: row.name.trim(),
      note: emptyToNull(row.note),
    }))
    .filter((row) => row.name.length > 0)
    .map((row) => ({ ...row, needsReview: deriveNeedsReview(row) }));

  const steps = draft.steps
    .map((step) => ({ ...step, text: step.text.trim() }))
    .filter((step) => step.text.length > 0)
    .map((step) => ({
      ...step,
      timerMaxSec:
        step.timerSec !== null &&
        step.timerMaxSec !== null &&
        step.timerMaxSec >= step.timerSec
          ? step.timerMaxSec
          : null,
    }));

  return {
    ...draft,
    title: draft.title.trim(),
    photoKey: emptyToNull(draft.photoKey),
    yieldUnit: emptyToNull(draft.yieldUnit),
    tags: normalizeTags(draft.tags),
    portionsMin:
      draft.portionsMin !== null && draft.portionsMin < draft.portionsBase
        ? draft.portionsMin
        : null,
    ingredients,
    steps,
  };
}

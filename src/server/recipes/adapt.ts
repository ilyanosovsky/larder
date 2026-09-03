import {
  MAX_NOTE,
  MAX_RAW_TEXT,
  MAX_STEP_TEXT,
  MAX_STEPS,
  MAX_TIMER_SEC,
  recipeDraftSchema,
  type RecipeDraft,
} from "@/lib/recipes/draft";
import { rescaleQty } from "@/lib/recipes/rescale";
import { MAX_QTY, MIN_QTY } from "@/server/cart/merge";
import type { EquipmentSlug } from "@/server/kitchen/equipment";
import type { RecipeAdaptation } from "@/server/ai/adapt-recipe";
import { coerceEquipmentList } from "@/server/recipes/coerce-equipment";
import { coerceRecipeUnit } from "@/server/recipes/coerce-unit";
import { deriveNeedsReview } from "@/server/recipes/needs-review";

/**
 * Turning a model's index-addressed proposal into a real `RecipeDraft`, and
 * saying exactly what changed (task 4.6, blueprint §5 row `adapt`).
 *
 * Pure, database-free and framework-free, because everything interesting
 * about an adaptation is a decision about *edits*, not about I/O:
 *
 * - **An index that no longer exists is DROPPED, never clamped onto a
 *   neighbour.** The single rule this module exists for. A proposal is
 *   written against the recipe the model was shown; if that recipe has moved
 *   under it (a partner's edit between the read and the response, a model
 *   counting past the end), the honest answer is to apply the edits that
 *   still resolve and silently skip the ones that do not. Clamping `index: 9`
 *   onto row 5 would put a quantity meant for one ingredient onto a different
 *   ingredient — a wrong number that looks exactly like a right one, which is
 *   precisely the failure VISION §6.4 forbids.
 * - **The portion arithmetic is ours, not the model's.** `rescaleDraft`
 *   multiplies before the proposal is even requested (see `adaptRecipe`'s
 *   `draft` argument), so a model can only ever *override* a quantity where
 *   linear scaling is meaningless — half an egg, one tin, one pinch — and can
 *   never introduce a wrong product for a row nobody was worried about.
 * - **An adaptation never renames anything.** `name`, `isOptional` and
 *   `productId` are not in the proposal schema at all, and this module copies
 *   them across untouched, so a household's catalog bindings survive an
 *   adaptation intact and «Применить» does not become a re-import.
 * - **Nothing fails the whole proposal.** Out-of-range values degrade one
 *   field (a quantity becomes `null` and wears «уточнить»), exactly like
 *   `draftFromParsed` — the household paid for this call and should get the
 *   nine rows that worked.
 */

/**
 * What changed, in indexes rather than text: the sheet already holds both
 * drafts and renders «было → стало» from them, so shipping the strings twice
 * would only be a second copy that can disagree with the first.
 *
 * The frames are deliberately different and named here once:
 * `changedIngredients`, `changedSteps` and `addedSteps` index the **result**;
 * `removedSteps` indexes the **original**, because a removed step exists
 * nowhere else.
 */
export interface AdaptationDiff {
  /** Ingredient rows whose quantity, unit, note or source line moved. */
  readonly changedIngredients: number[];
  /** Result steps that replace an original one, with different words. */
  readonly changedSteps: number[];
  /** Result steps that had no original. */
  readonly addedSteps: number[];
  /** Original steps the adaptation dropped. */
  readonly removedSteps: number[];
  /**
   * Appliances the recipe no longer requires. Part of the diff rather than a
   * silent side effect: it is a persisted change to `recipe.equipment` that
   * S7's banner reads forever after, so `isEmptyDiff` must not be able to say
   * «менять ничего не пришлось» beside one.
   */
  readonly droppedEquipment: EquipmentSlug[];
}

export type ApplyAdaptationResult =
  | {
      readonly ok: true;
      readonly draft: RecipeDraft;
      readonly diff: AdaptationDiff;
    }
  | {
      readonly ok: false;
      /** Why the assembled draft was not a draft. Never shown to a user. */
      readonly error: string;
    };

export interface ApplyAdaptationOptions {
  /**
   * The portion count to rescale to first, or `null` to leave the yield
   * alone. `targetPortions === draft.portionsBase` is also a no-op.
   */
  readonly targetPortions: number | null;
  /**
   * The appliances this adaptation was asked to work around — the
   * **candidates** for removal from `recipe.equipment`, not the answer.
   *
   * A slug is dropped only when the proposal's own `droppedEquipment` names
   * it too: a recipe reworked to avoid a mixer no longer needs one, but a
   * proposal that reworked nothing (prompt rule 14 invites exactly that) must
   * not strip a requirement whose steps still say «взбить миксером».
   * Removing it anyway silences S7's banner for that dish permanently, which
   * is the one failure mode a proposal the household approves cannot warn
   * them about — «Больше не нужно: Миксер» beside «менять ничего не пришлось»
   * is contradictory copy over a wrong persisted column.
   *
   * Nothing is ever *added*: the model is told to use only what the household
   * already has, and inferring a new slug from prose would be a guess about
   * the one field the banner reads.
   */
  readonly dropEquipment: readonly EquipmentSlug[];
}

/**
 * Which original step each result step came from — `null` for one the
 * adaptation added. Recorded during the apply rather than reconstructed
 * afterwards: with steps inserted and removed, recovering the mapping from
 * two lists alone would need a longest-common-subsequence *guess*, and the
 * apply already knows the answer for certain.
 */
export type StepOrigins = readonly (number | null)[];

/**
 * Rescales every stated quantity to a new portion count, and nothing else.
 *
 * Separate from the adaptation itself because it is the deterministic half:
 * `rescaleQty` is the same function S7's slider drags over, so the number a
 * proposal is built on is the number the user was already looking at.
 *
 * Three fields move together, and the two that are dropped are the point:
 *
 * - `portionsBase` becomes the target — the quantities below are now stated
 *   for it, which is what that column means.
 * - `portionsMin` is cleared. It is the lower end of the **source's** own
 *   stated range («7–8 печений»); once the batch is a different size the
 *   source never stated a range for it, and keeping 7 beside a base of 4
 *   would also violate `recipeDraftSchema`'s own `portionsMin < portionsBase`
 *   refinement.
 * - `yieldUnit` is cleared for the same reason `ingredientsForMessage` drops
 *   it at any count other than the recorded one: «печений» is a genitive
 *   plural that was grammatical for 8 and is not for 4, and this app has no
 *   declension table for an imported noun.
 *
 * `rawText` is deliberately **not** rewritten. It is the source line, and the
 * source really did say «Мука — 285 г»; the row's own `qty` carries the
 * adapted number, exactly as the slider already shows one beside an unchanged
 * `rawText`. A model may restate it (`RecipeAdaptation.ingredients[].rawText`)
 * where that reads better.
 */
export function rescaleDraft(
  draft: RecipeDraft,
  portions: number,
): RecipeDraft {
  if (portions === draft.portionsBase) {
    return draft;
  }

  return {
    ...draft,
    portionsBase: portions,
    portionsMin: null,
    yieldUnit: null,
    ingredients: draft.ingredients.map((row) => {
      const scaled = usableQty(rescaleQty(row.qty, portions, draft.portionsBase));

      return {
        ...row,
        qty: scaled,
        // Recomputed rather than carried: a quantity that scaled below what
        // the column can hold is now a hole, and the amber chip is how this
        // app says so. `formatRecipeQty` renders the same state as «—».
        needsReview: deriveNeedsReview({ ...row, qty: scaled }),
      };
    }),
  };
}

/**
 * Applies a proposal to a draft and reports what it did.
 *
 * The order is the whole function: rescale (deterministic), then overlay the
 * model's index-addressed edits, then drop the appliances the adaptation was
 * asked to work around, then re-validate — and finally diff the result
 * against the draft as it was **before** the rescale, so a quantity that
 * changed only because the batch got smaller still shows up as a change to
 * the person about to approve it.
 */
export function applyAdaptation(
  draft: RecipeDraft,
  proposal: RecipeAdaptation,
  options: ApplyAdaptationOptions,
): ApplyAdaptationResult {
  const rescaled =
    options.targetPortions === null
      ? draft
      : rescaleDraft(draft, options.targetPortions);

  const ingredients = applyIngredientEdits(rescaled, proposal);
  const steps = applyStepEdits(rescaled, proposal);
  // The intersection, both ways: only an appliance the household was actually
  // missing, and only one the model says it actually worked around. Coerced
  // because the model answers in its own Russian words, and filtered against
  // the candidates because a proposal cannot decide to remove a requirement
  // nobody asked about.
  const droppable = new Set<EquipmentSlug>(options.dropEquipment);
  const dropped = new Set<EquipmentSlug>(
    coerceEquipmentList(proposal.droppedEquipment).filter((slug) =>
      droppable.has(slug),
    ),
  );

  const candidate: RecipeDraft = {
    ...rescaled,
    equipment: rescaled.equipment.filter((slug) => !dropped.has(slug)),
    ingredients,
    steps: steps.steps,
  };

  const parsed = recipeDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    // Unreachable by construction — every field above is degraded into range
    // rather than clamped — which is exactly why it is checked: the day a
    // bound moves, the proposal is refused here (and the user is told the
    // adaptation failed) instead of failing later inside `dish.update`, after
    // «Применить», with the recipe half replaced.
    return {
      ok: false,
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  }

  return {
    ok: true,
    draft: parsed.data,
    diff: describeAdaptation(draft, parsed.data, steps.origins),
  };
}

/**
 * The diff, from the two drafts and the step mapping the apply recorded.
 *
 * `before` is the recipe as it stood — *not* the rescaled intermediate — so
 * «285 г → 142,5 г» is reported as a change even though no model edit touched
 * that row.
 */
export function describeAdaptation(
  before: RecipeDraft,
  after: RecipeDraft,
  stepOrigins: StepOrigins,
): AdaptationDiff {
  const changedIngredients: number[] = [];

  after.ingredients.forEach((row, index) => {
    const original = before.ingredients[index];

    if (
      original === undefined ||
      original.qty !== row.qty ||
      original.unit !== row.unit ||
      original.note !== row.note ||
      original.rawText !== row.rawText
    ) {
      changedIngredients.push(index);
    }
  });

  const changedSteps: number[] = [];
  const addedSteps: number[] = [];
  const kept = new Set<number>();

  after.steps.forEach((step, index) => {
    const origin = stepOrigins[index] ?? null;

    if (origin === null) {
      addedSteps.push(index);
      return;
    }

    kept.add(origin);
    const original = before.steps[origin];

    if (
      original === undefined ||
      original.text !== step.text ||
      original.timerSec !== step.timerSec ||
      original.timerMaxSec !== step.timerMaxSec
    ) {
      changedSteps.push(index);
    }
  });

  const removedSteps = before.steps
    .map((_, index) => index)
    .filter((index) => !kept.has(index));

  const survives = new Set<string>(after.equipment);
  const droppedEquipment = before.equipment.filter(
    (slug) => !survives.has(slug),
  );

  return {
    changedIngredients,
    changedSteps,
    addedSteps,
    removedSteps,
    droppedEquipment,
  };
}

/** True when a diff says the recipe would come out exactly as it went in. */
export function isEmptyDiff(diff: AdaptationDiff): boolean {
  return (
    diff.changedIngredients.length === 0 &&
    diff.changedSteps.length === 0 &&
    diff.addedSteps.length === 0 &&
    diff.removedSteps.length === 0 &&
    diff.droppedEquipment.length === 0
  );
}

function applyIngredientEdits(
  draft: RecipeDraft,
  proposal: RecipeAdaptation,
): RecipeDraft["ingredients"] {
  const edits = new Map<number, RecipeAdaptation["ingredients"][number]>();

  for (const edit of proposal.ingredients) {
    const index = resolveIndex(edit.index, draft.ingredients.length);
    // First statement wins. A proposal that names one row twice is a model
    // repeating itself, and the edit it reasoned about is the first one; a
    // later echo is the one likelier to have drifted.
    if (index !== null && !edits.has(index)) {
      edits.set(index, edit);
    }
  }

  return draft.ingredients.map((row, index) => {
    const edit = edits.get(index);
    if (edit === undefined) {
      return row;
    }

    const coerced = coerceRecipeUnit(edit.unit);
    const qty = usableQty(edit.qty);
    // The unmapped measure survives as words rather than becoming a wrong
    // number — «2 зубчика» stays «2» + note «зубчик», the same trade
    // `draftFromParsed` makes on the way in. The model's own prose is capped
    // first, with room reserved for the leftover, so a long note can never
    // eat the one word this path promises to keep.
    const note =
      coerced.leftover === null
        ? capped(edit.note, MAX_NOTE)
        : capped(
            joinNote(
              capped(edit.note, Math.max(0, MAX_NOTE - coerced.leftover.length - 2)),
              coerced.leftover,
            ),
            MAX_NOTE,
          );

    const next = {
      ...row,
      qty,
      unit: coerced.unit,
      note,
      // `null` keeps the source line: the recipe really did say what it said,
      // and an adaptation that has nothing better to write should not erase
      // it. Only an actual replacement replaces it.
      rawText: capped(edit.rawText, MAX_RAW_TEXT) ?? row.rawText,
    };

    // The router recomputes this on save (`childRows`); recomputing it here
    // too is what makes the *proposal sheet* honest — a row whose quantity
    // the adaptation could not state must show the amber chip before it is
    // applied, not after.
    return { ...next, needsReview: deriveNeedsReview(next) };
  });
}

/**
 * Steps, in one deterministic pass over the original order.
 *
 * Replacements land in place, removals drop, and additions are appended after
 * the original index they name — so «убери шаг 3 и вставь два новых после
 * него» is expressible, and produces exactly the order a human would write.
 * An addition anchored at `-1` goes first.
 */
function applyStepEdits(
  draft: RecipeDraft,
  proposal: RecipeAdaptation,
): { steps: RecipeDraft["steps"]; origins: (number | null)[] } {
  const total = draft.steps.length;

  const replacements = new Map<number, RecipeDraft["steps"][number]>();
  for (const edit of proposal.steps) {
    const index = resolveIndex(edit.index, total);
    if (index === null || replacements.has(index)) {
      continue;
    }
    const step = toStep(edit.text, edit.timerSec, edit.timerMaxSec);
    if (step !== null) {
      replacements.set(index, step);
    }
  }

  const removed = new Set<number>();
  for (const index of proposal.removedStepIndexes) {
    const resolved = resolveIndex(index, total);
    if (resolved !== null) {
      removed.add(resolved);
    }
  }

  /** Additions grouped by the original index they follow; `-1` = prepend. */
  const additions = new Map<number, RecipeDraft["steps"][number][]>();
  for (const addition of proposal.addedSteps) {
    // `-1` is the only out-of-list anchor with a meaning; every other one is
    // dropped rather than clamped to an end, for the same reason an edit
    // index is.
    const anchor =
      Number.isInteger(addition.afterIndex) &&
      addition.afterIndex >= -1 &&
      addition.afterIndex < total
        ? addition.afterIndex
        : null;
    if (anchor === null) {
      continue;
    }
    const step = toStep(addition.text, addition.timerSec, addition.timerMaxSec);
    if (step === null) {
      continue;
    }
    const bucket = additions.get(anchor);
    if (bucket === undefined) {
      additions.set(anchor, [step]);
    } else {
      bucket.push(step);
    }
  }

  const steps: RecipeDraft["steps"][number][] = [];
  const origins: (number | null)[] = [];

  const push = (step: RecipeDraft["steps"][number], origin: number | null) => {
    // Overflow is dropped rather than failing the proposal: sixty steps is
    // already past any real recipe, and losing the tail beats losing the fix.
    if (steps.length < MAX_STEPS) {
      steps.push(step);
      origins.push(origin);
    }
  };

  for (const step of additions.get(-1) ?? []) {
    push(step, null);
  }

  draft.steps.forEach((step, index) => {
    if (!removed.has(index)) {
      push(replacements.get(index) ?? step, index);
    }
    // Anchored additions survive their anchor's removal on purpose: «замени
    // этот шаг на два новых» is a removal plus two additions at the same
    // index, and dropping them would silently turn it into a deletion.
    for (const addition of additions.get(index) ?? []) {
      push(addition, null);
    }
  });

  return { steps, origins };
}

/** A step with its timers normalized, or `null` when there is no text. */
function toStep(
  rawText: string,
  rawTimerSec: number | null,
  rawTimerMaxSec: number | null,
): RecipeDraft["steps"][number] | null {
  const text = capped(rawText, MAX_STEP_TEXT);
  if (text === null) {
    return null;
  }

  const timerSec = intInRange(rawTimerSec, 1, MAX_TIMER_SEC);
  const timerMaxSec = intInRange(rawTimerMaxSec, 1, MAX_TIMER_SEC);

  return {
    text,
    timerSec,
    // An upper bound with no lower bound is not a range but a countdown S9
    // could not start; an upper below the lower is a misread. Either way the
    // honest answer is one number, not two wrong ones — the same rule
    // `draftFromParsed` and `recipeDraftSchema` already enforce.
    timerMaxSec:
      timerSec !== null && timerMaxSec !== null && timerMaxSec >= timerSec
        ? timerMaxSec
        : null,
  };
}

/** A whole, in-range position in a list of `length`, or `null`. */
function resolveIndex(value: number, length: number): number | null {
  if (!Number.isInteger(value) || value < 0 || value >= length) {
    return null;
  }
  return value;
}

/**
 * A quantity we are willing to store, or `null` — never a clamp, never a
 * rounding, exactly as `draftFromParsed` decides it. A rescale that lands
 * below the storage floor is a recipe that no longer states a usable amount,
 * and «уточнить» is the honest rendering of that.
 */
function usableQty(qty: number | null): number | null {
  if (qty === null || !Number.isFinite(qty)) {
    return null;
  }
  return qty >= MIN_QTY && qty <= MAX_QTY ? qty : null;
}

/** An integer in range, or `null`. Non-integers round; out-of-range does not. */
function intInRange(
  value: number | null,
  min: number,
  max: number,
): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  return rounded >= min && rounded <= max ? rounded : null;
}

/** Trimmed and capped; blank becomes `null`, because blank means absent. */
function capped(value: string | null, max: number): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
}

/** The model's note plus whatever the unit coercion could not map, once. */
function joinNote(...parts: (string | null)[]): string | null {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const part of parts) {
    const trimmed = part?.trim() ?? "";
    if (trimmed.length === 0) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(trimmed);
  }

  return kept.length === 0 ? null : kept.join(", ");
}

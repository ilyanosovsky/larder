/**
 * How many portions a recipe makes (DESIGN_BRIEF S7: «Порции: 8», §5: «7–8
 * печений»).
 *
 * Two integers and a yield noun, never a stored Russian label — a label would
 * be a user-visible string living outside next-intl. `parsePortions` turns
 * whatever a source or a form field said into those integers;
 * `portionsDisplay` turns them back into the arguments an ICU message needs.
 */

/** Matches `recipeDraftSchema.portionsBase` — catering is out of scope. */
const MAX_PORTIONS = 100;

export interface ParsedPortions {
  /**
   * The portion count the quantities are stated for — the **upper** end of a
   * range («7–8 печений» → 8). A source that offers a range has weighed its
   * flour for the batch it actually makes.
   */
  base: number;
  /** The lower end of a stated range, or `null` when a single number was given. */
  min: number | null;
}

/** En dash, em dash, minus sign and hyphen all show up in real recipes. */
const RANGE = /(\d+)\s*[-–—−]\s*(\d+)/;
/**
 * Whole runs of digits, not "up to three digits": «2026» has to read as one
 * impossible number and be refused, not as «202» followed by a plausible «6».
 */
const NUMBERS = /\d+/g;

function inRange(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PORTIONS;
}

/**
 * «8» · «7–8» · «7-8 порций» · «на 4» → the two integers. `null` when there
 * is no number worth trusting.
 *
 * Deliberately liberal about the words around the number — «на 4 порции»,
 * «Порций: 4» and «4» are the same statement — and deliberately strict about
 * the number itself: anything outside 1…100 is a year, a temperature or a
 * misread, and `null` (which the caller turns into the default of 2) beats a
 * confidently wrong portion count that silently rescales every quantity.
 */
export function parsePortions(text: string): ParsedPortions | null {
  const range = RANGE.exec(text);
  if (range) {
    const first = Number(range[1]);
    const second = Number(range[2]);

    if (inRange(first) && inRange(second)) {
      const base = Math.max(first, second);
      const min = Math.min(first, second);
      return { base, min: min === base ? null : min };
    }
  }

  for (const match of text.matchAll(NUMBERS)) {
    const value = Number(match[0]);
    if (inRange(value)) {
      return { base: value, min: null };
    }
  }

  return null;
}

/** What a recipe row states about its yield, as stored. */
export interface PortionsSource {
  portionsBase: number;
  portionsMin: number | null;
  /** The source's own noun («печений»); `null` means «порции». */
  yieldUnit: string | null;
}

/**
 * Which of the four `dish.portions*` messages to render, and with what.
 *
 * The branch lives here, as a tested pure function, rather than inline in the
 * screen: «8 порций», «7–8 порций», «8 печений» and «7–8 печений» are four
 * different ICU messages (a plural over a count, versus a range that has no
 * single count to pluralize), and picking the wrong one is the kind of bug
 * that only shows up for the one dish that has a range.
 */
export type PortionsDisplay =
  | { kind: "single"; count: number; unit: string | null }
  | { kind: "range"; from: number; to: number; unit: string | null };

export function portionsDisplay(recipe: PortionsSource): PortionsDisplay {
  const unit = recipe.yieldUnit === null ? null : recipe.yieldUnit.trim();
  const yieldUnit = unit === null || unit.length === 0 ? null : unit;

  if (recipe.portionsMin !== null && recipe.portionsMin < recipe.portionsBase) {
    return {
      kind: "range",
      from: recipe.portionsMin,
      to: recipe.portionsBase,
      unit: yieldUnit,
    };
  }

  return { kind: "single", count: recipe.portionsBase, unit: yieldUnit };
}

/**
 * The yield noun the **ingredient list's** header should carry — «на 8
 * печений» — or `null` when the recipe never stated one and next-intl's own
 * «порций» applies.
 *
 * A separate, named answer rather than a field read off `portionsDisplay`,
 * because the mistake it prevents is specific and was made once already:
 * the header is stated for `portionsBase` whether or not the source gave a
 * range, so it must branch on the **noun alone**. Branching on
 * `display.kind` instead drops «печений» for exactly the recipes that state
 * a range — leaving S7 saying «7–8 печений» two lines above «на 8 порций».
 */
export function ingredientsYieldUnit(recipe: PortionsSource): string | null {
  return portionsDisplay(recipe).unit;
}

/**
 * Which `dish.ingredientsFor*` message the S7 header should render, and with
 * what — the whole branch, not just its input.
 *
 * The decision lives here rather than in the screen because the screen cannot
 * be tested: vitest runs in `node` with no DOM harness, so a module-private
 * ternary inside a `.tsx` is unreachable from the suite and a flipped branch
 * ships green (which is exactly how «7–8 печений» once ended up above «на 8
 * порций»). Returning the key and its values keeps the component down to one
 * `t(...)` call and puts the branch somewhere a test can flip.
 *
 * `count` is a **separate argument from `recipe.portionsBase`**, not read off
 * the recipe, because task 4.5's slider can drive this same header at any
 * count in `portionsRange(recipe.portionsBase)` — not only the stored one.
 * `dish.ingredientsForUnit` interpolates `yieldUnit` verbatim with no plural
 * forms (it is imported data, not a declinable word this app owns), so it is
 * only grammatical at the exact count the noun was recorded for: «7 печений»
 * scaled to 3 portions is not «3 печений». The unit branch therefore fires
 * only when `count === recipe.portionsBase`; every other count — including
 * every recipe with no `yieldUnit` at all — falls back to the correctly
 * declined `dish.ingredientsFor` («на 3 порции»), accepting that a scaled
 * «печений» recipe reads as «порции» once it is actually rescaled.
 */
export type IngredientsForMessage =
  | { key: "ingredientsFor"; values: { count: number } }
  | { key: "ingredientsForUnit"; values: { count: number; unit: string } };

export function ingredientsForMessage(
  recipe: PortionsSource,
  count: number,
): IngredientsForMessage {
  const unit = ingredientsYieldUnit(recipe);

  return unit === null || count !== recipe.portionsBase
    ? { key: "ingredientsFor", values: { count } }
    : { key: "ingredientsForUnit", values: { count, unit } };
}

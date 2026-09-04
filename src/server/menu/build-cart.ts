import { z } from "zod";

import { formatRecipeQty, rescaleQty } from "@/lib/recipes/rescale";
import {
  areCommensurable,
  convertQty,
  isPurchaseUnit,
  recipeUnitSchema,
  unitFamily,
  unitSchema,
  type RecipeUnit,
  type Unit,
} from "@/lib/units";
import {
  MAX_QTY,
  MIN_QTY,
  roundQty,
  type CartItemStatus,
} from "@/server/cart/merge";
import { RAN_OUT_QTY } from "@/server/pantry/ran-out";
import { isUnquantifiable } from "@/server/recipes/needs-review";

/**
 * «Собрать корзину» — the whole decision, with no database and no React in it
 * (VISION §3.4, DESIGN_BRIEF §5's MergePreview).
 *
 * Two entrances share it: S10's «Собрать корзину» over the week's menu and
 * S7's «Ингредиенты в корзину» for one dish. `menu.previewCart` supplies the
 * rows, this module decides what the sheet offers, and `menu.applyCart` writes
 * exactly what the person confirmed through `decideCartAdd` — the cart's own
 * merge rules, which this module never duplicates and never widens.
 *
 * Pure for the reason this repo states twice: vitest runs in a **node**
 * environment and collects `src/**\/*.test.ts` only, so a rule left inside a
 * `.tsx` — or inside a router — is unreachable from the suite and a flipped
 * branch ships green. It is also client-safe on purpose: the sheet imports
 * `PREVIEW_GROUP_ORDER` and these types at runtime, so nothing here may reach
 * for drizzle, the database schema or the tRPC context.
 *
 * **The invariant this module carries** is the cart's own, one level up: the
 * partial unique index `(product_id) WHERE trip_id IS NULL` allows one active
 * line per product, and this is the first feature that writes many lines from
 * one tap — so it produces **one preview line per product**, never two.
 */

/**
 * The three cart statuses, spelled out here rather than imported from
 * `routers/cart.ts`.
 *
 * That router pulls in drizzle and the tRPC context, and the MergePreview
 * sheet imports this module at runtime — so importing `cartItemStatusSchema`
 * would drag a server-only dependency graph into a client bundle. The tuple is
 * checked against `CartItemStatus` (itself derived from the database enum) by
 * `satisfies`, and `build-cart.test.ts` pins it against
 * `cartItemStatusEnum.enumValues` so a fourth status cannot land here
 * unnoticed.
 */
const CART_ITEM_STATUSES = [
  "needed",
  "ordered",
  "bought",
] as const satisfies readonly CartItemStatus[];

export const planCartStatusSchema = z.enum(CART_ITEM_STATUSES);

/**
 * Why a contribution's own quantity is, or is not, part of the number offered.
 *
 * | kind            | the row said                                   |
 * | --------------- | ---------------------------------------------- |
 * | `summed`        | a purchase quantity — «Пармезан 150 г»          |
 * | `recipeUnit`    | a kitchen measure — «Соль ¾ ч.л.»               |
 * | `noUnit`        | a number with no unit — «2 зубчика»             |
 * | `needsReview`   | nothing the parser could read — «уточнить»      |
 * | `unquantifiable`| deliberately no amount — «по вкусу»             |
 * | `tooSmall`      | an amount that rounds below `MIN_QTY`           |
 * | `optional`      | set aside because the row is `is_optional`      |
 *
 * `optional` is used **only** in a bucket that also has non-optional rows —
 * there the optional row is set aside and named in the «не считали» sub-line.
 * In a bucket where every row is optional the rows *are* the line, so they
 * carry their own class instead, and `previewLineOutput.optional` is what says
 * the whole line is a garnish.
 *
 * The amber «уточнить» chip is driven by `previewLineOutput.needsReview` (the
 * stored flag), not by this field: class F of §3.3 — a row with no quantity
 * and no explanation whose stored flag is somehow `false` — is honestly
 * described as `needsReview` here while wearing no chip.
 */
export const previewContributionKindSchema = z.enum([
  "summed",
  "recipeUnit",
  "noUnit",
  "needsReview",
  "unquantifiable",
  "tooSmall",
  "optional",
]);

/** One dish's contribution to a line — «лазанья 2 + шакшука 1 → 3 шт». */
export const previewContributionOutput = z.object({
  /** `menu_items.id` on the week path, the dish id on the S7 path. */
  sourceId: z.uuid(),
  dishId: z.uuid(),
  dishTitle: z.string(),
  /** Rescaled to this source's portions. `null` when the row stated none. */
  qty: z.number().nullable(),
  /** Exactly what the recipe said — «¾ ч.л.», «200 мл». Rendered verbatim. */
  unit: recipeUnitSchema.nullable(),
  kind: previewContributionKindSchema,
  /**
   * What this row states, already formatted — «¾ ч.л.», «по вкусу»,
   * «зубчик» — or `null` when it states nothing a person could read.
   *
   * Composed here rather than in the sheet because it is a *quantity*, and
   * this codebase formats those with `formatRecipeQty` in exactly one place; a
   * unit is stored data rendered verbatim, not copy (the same treatment S7's
   * ingredient list gets). The words around it are the dictionary's:
   * `stated !== null` renders `menuBuild.fallback` («по рецепту {stated} ·
   * берём {qty} {unit}»), `null` with `kind: "tooSmall"` renders
   * `fallbackTiny`, and `null` otherwise renders `fallbackUnknown`.
   */
  stated: z.string().nullable(),
});

/**
 * One selectable quantity for a product. Normally exactly one; more than one
 * only for a `unitConflict` bucket, where each option is one unit's own sum
 * and the sheet renders them as a radio group with nothing preselected (D12).
 */
export const previewOptionOutput = z.object({
  qty: z.number().min(MIN_QTY).max(MAX_QTY),
  unit: unitSchema,
  /**
   * `summed` — real quantities added up, converted into one unit where they
   * are exactly convertible (г↔кг, мл↔л). `fallback` — nothing summable was
   * stated («¾ ч.л. соли», «уточнить», «по вкусу», «2 зубчика», or a total
   * below `MIN_QTY`), so this is `RAN_OUT_QTY` × the product's `default_unit`
   * and the row says so («по каталогу»).
   */
  qtySource: z.enum(["summed", "fallback"]),
  /** Which contributions this option's number came from, in source order. */
  contributions: z.array(previewContributionOutput),
});

export const previewLineOutput = z.object({
  productId: z.uuid(),
  productName: z.string(),
  productIcon: z.string(),
  categoryId: z.uuid(),
  group: z.enum(["add", "pantry", "inCart", "manual"]),
  /**
   * Always at least one. A line that cannot be written expresses that with
   * `selectable: false` and a null `defaultUnit`, never by shipping an empty
   * list: «в корзине 1 мешок · по рецепту 285 г» needs the 285 г to say
   * anything at all, and an empty array would leave the sheet nothing to name.
   */
  options: z.array(previewOptionOutput).min(1),
  /** The option preselected on open; `null` ⇒ nothing is (D9, D10, D12). */
  defaultUnit: unitSchema.nullable(),
  /** `false` ⇒ no control at all: nothing here could be written. */
  selectable: z.boolean(),
  /** What checking it means. `restore` only for a line bought in this trip. */
  intent: z.enum(["add", "restore"]),
  /** Why this row is where it is. */
  reason: z.enum([
    "new",
    "inPantry",
    "inCart",
    "inCartBought",
    "inCartUnits",
    "unitConflict",
    "optional",
  ]),
  /**
   * Every row of this product is `is_optional` — the «опционально» chip.
   *
   * Carried beside `reason` rather than folded into it because a garnish can
   * also already be in the cart, and then the row has two things to say at
   * once: the chip and the «уже в корзине» sub-line. Keeping them separate is
   * also what keeps DESIGN_BRIEF §5's counts disjoint — the line is counted
   * once, in `inCart`.
   */
  optional: z.boolean(),
  /**
   * Contributions no kept option absorbed — the «не считали» sub-line (D12).
   *
   * In source order, followed by the contributions of any option an `inCart`
   * row's unit filter dropped (in that option's own source order). The two
   * groups are appended rather than interleaved because they are two different
   * statements: «this row stated nothing summable» and «this row is in another
   * unit than the one already in your cart».
   */
  uncounted: z.array(previewContributionOutput),
  /** Any contributing row still wears the amber chip. */
  needsReview: z.boolean(),
  /** The product's active line as the plan saw it. */
  inCart: z
    .object({
      qty: z.number(),
      /** As the row stores it — never through `toUnit`; see `ActiveCartLine`. */
      unit: z.string(),
      status: planCartStatusSchema,
    })
    .nullable(),
  /** The note a *new* line would carry; never applied to an existing one. */
  note: z.string().nullable(),
});

/** An ingredient that can never become a cart line. Informative only (D13). */
export const previewSkippedOutput = z.object({
  ingredientId: z.uuid(),
  dishId: z.uuid(),
  dishTitle: z.string(),
  name: z.string(),
  /** Rescaled like a contribution's, so the sheet shows this build's number. */
  qty: z.number().nullable(),
  unit: recipeUnitSchema.nullable(),
  reason: z.literal("unbound"),
});

export const previewCountsOutput = z.object({
  add: z.int().nonnegative(),
  pantry: z.int().nonnegative(),
  inCart: z.int().nonnegative(),
  manual: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
});

export type PreviewContribution = z.infer<typeof previewContributionOutput>;
export type PreviewContributionKind = z.infer<
  typeof previewContributionKindSchema
>;
export type PreviewOption = z.infer<typeof previewOptionOutput>;
export type PreviewLine = z.infer<typeof previewLineOutput>;
export type PreviewSkipped = z.infer<typeof previewSkippedOutput>;
export type PreviewCounts = z.infer<typeof previewCountsOutput>;
export type PreviewGroup = PreviewLine["group"];

/** Section order in the sheet: DESIGN_BRIEF §5's own, plus the honest fourth. */
export const PREVIEW_GROUP_ORDER = [
  "add",
  "pantry",
  "inCart",
  "manual",
] as const satisfies readonly PreviewGroup[];

/**
 * One thing the build is asked to cook — a `menu_items` row on the week path,
 * the dish itself on the S7 path.
 */
export interface PlanSource {
  /** `menu_items.id` on the week path, the dish id on the S7 path. */
  sourceId: string;
  dishId: string;
  dishTitle: string;
  /** What this build wants — the card's count, or S7's slider. */
  portions: number;
  /** What the recipe states its quantities for. */
  portionsBase: number;
  /**
   * Set ⇒ the dish was already cooked this week and is dropped (D17).
   *
   * Read and partitioned **here**, not filtered away in SQL, so `cookedSkipped`
   * and `dishCount` come from one place and the «2 блюда уже приготовили»
   * sentence cannot disagree with the plan it describes.
   */
  cookedAt: Date | null;
}

/** One `recipe_ingredients` row as the build sees it, joined to its product. */
export interface PlanIngredient {
  ingredientId: string;
  /** Which `PlanSource` asked for it. */
  sourceId: string;
  /** `null` = unbound: nothing in the catalog answers to this name. */
  productId: string | null;
  name: string;
  qty: number | null;
  /** `RECIPE_UNITS`-validated on read; `null` for anything unrecognized. */
  unit: RecipeUnit | null;
  note: string | null;
  isOptional: boolean;
  needsReview: boolean;
}

export interface PlanProduct {
  id: string;
  name: string;
  icon: string;
  categoryId: string;
  /** Department order — the preview sorts by it, the cart's walking order. */
  categorySortOrder: number;
  /**
   * `products.default_unit`, degraded through `toUnit` on read. **The bridge
   * for every row the recipe stated no usable unit for** — «2 зубчика»,
   * «¾ ч.л.», «по вкусу».
   */
  defaultUnit: Unit;
}

/** A product's active cart line (`trip_id IS NULL`), as the rules see it. */
export interface PlanCartLine {
  qty: number;
  /**
   * **Raw, exactly as the row stores it** — never through `toUnit`. Degrading
   * an unrecognized unit to «шт» here would make a «мешок» row look like a
   * «шт» row and propose a merge that changes the quantity while leaving the
   * stored unit alone. That is `ActiveCartLine.unit`'s own rule, restated
   * because this is the module that could make the mistake at scale.
   */
  unit: string;
  status: CartItemStatus;
}

export interface PlanInput {
  /** In pool order — contributions are listed in it. */
  sources: readonly PlanSource[];
  ingredients: readonly PlanIngredient[];
  products: ReadonlyMap<string, PlanProduct>;
  /** Active lines by productId. */
  cart: ReadonlyMap<string, PlanCartLine>;
  /** Products with a `pantry_items` row. */
  pantry: ReadonlySet<string>;
}

export interface CartPlan {
  lines: PreviewLine[];
  skipped: PreviewSkipped[];
  counts: PreviewCounts;
  /** Sources actually counted — «из 4 блюд». */
  dishCount: number;
  /** Sources left out because they are already cooked (D17). */
  cookedSkipped: number;
}

/** The longest a `cart_items.note` may be — `addCartItemInput`'s own bound. */
const MAX_NOTE_LENGTH = 200;

interface BucketRow {
  ingredient: PlanIngredient;
  source: PlanSource;
  /** Position of the source in the pool — contributions sort by it. */
  sourceIndex: number;
  /** Position of the row in the input — the tie-break inside one source. */
  rowIndex: number;
  /** The stated quantity rescaled to this source's portions. */
  qty: number | null;
}

/**
 * A quantified row, with its purchase unit already resolved.
 *
 * The unit is carried rather than re-narrowed at every use: `PlanIngredient`
 * types it `RecipeUnit | null`, and every later step (grouping, conversion,
 * the fold) needs the `Unit` this row's `isPurchaseUnit` check already proved
 * it to be.
 */
interface QuantifiedRow {
  row: BucketRow;
  kind: "summed";
  quantified: true;
  unit: Unit;
  qty: number;
}

interface PresenceRow {
  row: BucketRow;
  kind: PreviewContributionKind;
  quantified: false;
}

type ClassifiedRow = QuantifiedRow | PresenceRow;

function trimmedNote(note: string | null): string | null {
  if (note === null) {
    return null;
  }
  const trimmed = note.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * §3.3 step 3 — what one row states, decided **before** any bucket-level
 * arithmetic and with `isOptional` already handled by the caller.
 *
 * The one summable class is a bound row with a purchase unit whose rescaled
 * quantity survives `MIN_QTY`. Everything else is a *presence* contribution:
 * the recipe needs the thing and this build cannot turn what it said into a
 * shopping quantity. «2 зубчика» is the case worth naming — the number 2 is
 * deliberately dropped, because two cloves are not two heads of garlic, and
 * `deriveNeedsReview` explicitly refuses to call that row a parser failure.
 */
function classifyRow(row: BucketRow): ClassifiedRow {
  const { unit, note, needsReview } = row.ingredient;
  const qty = row.qty;

  if (qty !== null && unit !== null && isPurchaseUnit(unit)) {
    return roundQty(qty) >= MIN_QTY
      ? { row, kind: "summed", quantified: true, unit, qty }
      : { row, kind: "tooSmall", quantified: false };
  }

  if (qty !== null && unit !== null) {
    return { row, kind: "recipeUnit", quantified: false };
  }

  if (qty !== null) {
    return { row, kind: "noUnit", quantified: false };
  }

  if (needsReview) {
    return { row, kind: "needsReview", quantified: false };
  }

  if (isUnquantifiable(note)) {
    return { row, kind: "unquantifiable", quantified: false };
  }

  // Class F: no quantity, no explanation, and a stored flag that says it is
  // fine. `deriveNeedsReview` makes exactly this row `needsReview: true` on
  // every save, so it can only arrive here from a stale flag — described
  // honestly, and without the chip, which reads the stored value.
  return { row, kind: "needsReview", quantified: false };
}

/** What `menuBuild.fallback` interpolates as «по рецепту {stated}». */
function statedFor(
  row: BucketRow,
  kind: PreviewContributionKind,
): string | null {
  if (kind === "tooSmall") {
    // Rendering it would print `formatRecipeQty`'s «—», which says nothing.
    // The dictionary has its own sentence for this: «совсем чуть-чуть».
    return null;
  }

  const { unit, note } = row.ingredient;

  if (row.qty !== null && unit !== null) {
    return formatRecipeQty(row.qty, unit);
  }

  // «2 зубчика» and «по вкусу» both live in the note; the bare number the
  // first one carries is meaningless without it (D10's class B).
  return trimmedNote(note);
}

function toContribution(
  classified: ClassifiedRow,
  kind: PreviewContributionKind = classified.kind,
): PreviewContribution {
  const { row } = classified;
  return {
    sourceId: row.source.sourceId,
    dishId: row.source.dishId,
    dishTitle: row.source.dishTitle,
    qty: row.qty,
    unit: row.ingredient.unit,
    kind,
    stated: statedFor(row, kind),
  };
}

/** Source order, then the order the rows arrived in — what the eye scrolled. */
function bySourceOrder(a: ClassifiedRow, b: ClassifiedRow): number {
  return (
    a.row.sourceIndex - b.row.sourceIndex || a.row.rowIndex - b.row.rowIndex
  );
}

/** The finer of two commensurable units — «г» over «кг», «мл» over «л». */
function finerUnit(a: Unit, b: Unit): Unit {
  const ratio = convertQty(1, a, b);
  return ratio !== null && ratio < 1 ? a : b;
}

/**
 * Which unit a group of commensurable contributions is summed into (A2).
 *
 * The ladder, and why it is in this order:
 *
 * 1. **The active cart line's stored unit**, when it parses and is
 *    commensurable. This is what makes DESIGN_BRIEF §5's «🌾 Мука · в корзине
 *    1 кг — хватает» renderable at all, and it is also invariant 5: an option
 *    stated in the unit the row already holds is one `decideCartAdd` merges
 *    rather than refuses.
 * 2. **The product's own `default_unit`**, when commensurable — the household
 *    already said how it buys this thing.
 * 3. **The unit of the largest single contribution**, ties going to the finer
 *    one. Never a unit nobody stated: minting «кг» because a sum crossed 1000
 *    г would write a unit no recipe, no cart row and no catalog entry ever
 *    used.
 */
function targetUnitFor(
  members: readonly [QuantifiedRow, ...QuantifiedRow[]],
  cart: PlanCartLine | null,
  product: PlanProduct,
): Unit {
  // The group is commensurable throughout, so its first member's unit is as
  // good a common yardstick as any.
  const representative = members[0].unit;

  if (cart !== null) {
    const parsed = unitSchema.safeParse(cart.unit);
    if (parsed.success && areCommensurable(parsed.data, representative)) {
      return parsed.data;
    }
  }

  if (areCommensurable(product.defaultUnit, representative)) {
    return product.defaultUnit;
  }

  let best = representative;
  let bestSize = -Infinity;

  for (const member of members) {
    // Measured against one common unit, so «0,3 кг» beats «200 г» honestly.
    const size = convertQty(member.qty, member.unit, representative) ?? 0;

    if (size > bestSize) {
      best = member.unit;
      bestSize = size;
    } else if (size === bestSize) {
      best = finerUnit(best, member.unit);
    }
  }

  return best;
}

/**
 * §3.3 step 4 — the bucket's quantified rows folded into one option per
 * group, or demoted when the total is smaller than the column can hold.
 *
 * Groups are keyed by **family** (mass, volume) so «200 г» and «85 г» and
 * «0,3 кг» are one number, and by the exact unit for everything else, so
 * «200 г» + «1 шт» stays the two-option `unitConflict` VISION §3.4 describes.
 *
 * The fold is `roundQty(total + part)` after **each** addition and then a cap
 * at `MAX_QTY` — `decideCartAdd`'s own merge line, so «⅓ + ⅓ + ⅓ = 0,999» is
 * the cost this codebase already lives with rather than a second, disagreeing
 * rule.
 */
function foldOptions(
  quantified: readonly QuantifiedRow[],
  cart: PlanCartLine | null,
  product: PlanProduct,
): { options: PreviewOption[]; demoted: PresenceRow[] } {
  const groups = new Map<string, [QuantifiedRow, ...QuantifiedRow[]]>();

  for (const member of quantified) {
    const key = unitFamily(member.unit) ?? member.unit;
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [member]);
    } else {
      bucket.push(member);
    }
  }

  const options: PreviewOption[] = [];
  const demoted: PresenceRow[] = [];

  for (const members of groups.values()) {
    const unit = targetUnitFor(members, cart, product);
    let total = 0;

    for (const member of members) {
      total = roundQty(
        total + (convertQty(member.qty, member.unit, unit) ?? 0),
      );
    }

    total = Math.min(total, MAX_QTY);

    if (total < MIN_QTY) {
      // «0,4 г» folded into a «кг» line is 0,0004 — which `numeric(10, 3)`
      // stores as 0,000. An option of «0 кг» would claim the recipe needs
      // none of something, so the whole group becomes presence instead and
      // the line falls back to «1 × default_unit» like any other row that
      // stated no usable amount.
      demoted.push(
        ...members.map((member): PresenceRow => ({
          row: member.row,
          kind: "tooSmall",
          quantified: false,
        })),
      );
      continue;
    }

    options.push({
      qty: total,
      unit,
      qtySource: "summed",
      contributions: [...members]
        .sort(bySourceOrder)
        .map((member) => toContribution(member)),
    });
  }

  // Descending by quantity, then by unit — a stable, readable order for the
  // radio group a `unitConflict` renders, and the reason «the largest option»
  // is a thing `menuBuild.inCartUnits` can name.
  options.sort((a, b) => b.qty - a.qty || a.unit.localeCompare(b.unit, "ru"));

  return { options, demoted };
}

/**
 * §3.3 steps 5 and 6 — where the bucket lands, and what checking it means.
 *
 * The ladder is strictly top-down and the cart comes **first** (B2): a product
 * that is both at home and on the list is a decision somebody already made,
 * and the cart is where a further one has consequences. An optional product
 * that is also in the cart therefore renders as an `inCart` row wearing the
 * «опционально» chip, which is what keeps the header's three counts disjoint.
 */
function placeLine(
  options: PreviewOption[],
  uncounted: PreviewContribution[],
  cart: PlanCartLine | null,
  optional: boolean,
  inPantry: boolean,
): {
  group: PreviewGroup;
  reason: PreviewLine["reason"];
  defaultUnit: Unit | null;
  selectable: boolean;
  intent: PreviewLine["intent"];
  options: PreviewOption[];
} {
  if (cart !== null) {
    // Row i — status before unit, `decideCartAdd`'s own order: a bought line
    // is a question about the purchase, and restoring replaces the unit
    // anyway, so the options are deliberately unfiltered.
    if (cart.status === "bought") {
      return {
        group: "inCart",
        reason: "inCartBought",
        defaultUnit: null,
        selectable: true,
        intent: "restore",
        options,
      };
    }

    const parsed = unitSchema.safeParse(cart.unit);
    const matching = parsed.success
      ? options.filter((option) => option.unit === parsed.data)
      : [];

    // Row ii — one option is already stated in the unit the row holds
    // (`targetUnitFor` saw to that), so ticking it is a merge, never a
    // `unitMismatch`. Every other group is named in «не считали» instead.
    if (matching.length > 0) {
      for (const option of options) {
        if (!matching.includes(option)) {
          uncounted.push(...option.contributions);
        }
      }

      return {
        group: "inCart",
        reason: "inCart",
        defaultUnit: null,
        selectable: true,
        intent: "add",
        options: matching,
      };
    }

    // Row iii — the stored unit does not parse («мешок»), or nothing here is
    // commensurable with it. The options stay so the row can still say «по
    // рецепту 285 г»; `selectable: false` is the whole of the refusal.
    return {
      group: "inCart",
      reason: "inCartUnits",
      defaultUnit: null,
      selectable: false,
      intent: "add",
      options,
    };
  }

  if (optional) {
    return {
      group: "manual",
      reason: "optional",
      defaultUnit: null,
      selectable: true,
      intent: "add",
      options,
    };
  }

  if (inPantry) {
    return {
      group: "pantry",
      reason: "inPantry",
      defaultUnit: null,
      selectable: true,
      intent: "add",
      options,
    };
  }

  if (options.length >= 2) {
    return {
      group: "manual",
      reason: "unitConflict",
      defaultUnit: null,
      selectable: true,
      intent: "add",
      options,
    };
  }

  // The only row that preselects anything (D9) — which is what makes the
  // footer's «Добавить 8 позиций» equal `counts.add` the moment it opens.
  return {
    group: "add",
    reason: "new",
    defaultUnit: options[0]?.unit ?? null,
    selectable: true,
    intent: "add",
    options,
  };
}

/**
 * Turns a week's menu (or one dish) into the MergePreview the sheet renders.
 *
 * The order of the nine steps is itself an invariant: rows are **bucketed by
 * product before anything is classified**, so one product can never leave with
 * two lines, and `is_optional` is read **before any quantity**, so «Biscoff
 * 150 г — опционально» can never join a sum and land pre-ticked
 * (`recipe_ingredients.is_optional`'s own schema comment says stopping that is
 * what the column is for).
 *
 * What this function deliberately does **not** do:
 *
 * - **Invent a unit.** Conversion is exact and metric-only — г↔кг, мл↔л, factor
 *   1000 — and always into a unit somebody actually stated (the cart row's,
 *   the catalog's, or the largest contribution's). Kitchen measures never
 *   become purchase units: VISION §3.4 normalizes those at import, «а не
 *   изобретаются на этапе сборки», and the grams in a teaspoon differ for salt
 *   and for honey.
 * - **Promise something the cart would refuse.** Every pickable option on a
 *   line with an active cart row is stated in that row's own unit, so
 *   `decideCartAdd` answers `merged` (or `restored`) and never `unitMismatch`.
 * - **Drop anything silently.** Every ingredient row of a counted source ends
 *   in exactly one of `lines[].options[].contributions`, `lines[].uncounted`
 *   or `skipped[]`. A preview that hides what it could not do is a preview
 *   that lies.
 */
export function buildCartPlan(input: PlanInput): CartPlan {
  const sourceIndex = new Map<string, { source: PlanSource; index: number }>();
  let cookedSkipped = 0;
  let dishCount = 0;

  for (const [index, source] of input.sources.entries()) {
    if (source.cookedAt !== null) {
      cookedSkipped += 1;
      continue;
    }
    dishCount += 1;
    sourceIndex.set(source.sourceId, { source, index });
  }

  const buckets = new Map<
    string,
    { product: PlanProduct; rows: BucketRow[] }
  >();
  const skipped: PreviewSkipped[] = [];

  for (const [rowIndex, ingredient] of input.ingredients.entries()) {
    const entry = sourceIndex.get(ingredient.sourceId);

    // A cooked dish was shopped for and eaten; counting it again would re-buy
    // a week's groceries for anyone who taps the button twice (D17). A row
    // whose source is not in the list at all cannot be rendered — it has no
    // dish to name — and is unreachable through the router's own reads.
    if (entry === undefined) {
      continue;
    }

    const qty = rescaleQty(
      ingredient.qty,
      entry.source.portions,
      entry.source.portionsBase,
    );

    const product =
      ingredient.productId === null
        ? undefined
        : input.products.get(ingredient.productId);

    // The cart takes catalog products only (VISION §3.1), and inventing one
    // from a recipe string is exactly the duplicate the catalog exists to
    // prevent. Two unbound rows naming the same string stay two rows: nothing
    // has said they are one product, and this module does not get to decide
    // that — `resolveIngredientProducts` does, at save time.
    if (product === undefined) {
      skipped.push({
        ingredientId: ingredient.ingredientId,
        dishId: entry.source.dishId,
        dishTitle: entry.source.dishTitle,
        name: ingredient.name,
        qty,
        unit: ingredient.unit,
        reason: "unbound",
      });
      continue;
    }

    const row: BucketRow = {
      ingredient,
      source: entry.source,
      sourceIndex: entry.index,
      rowIndex,
      qty,
    };

    const bucket = buckets.get(product.id);
    if (bucket === undefined) {
      buckets.set(product.id, { product, rows: [row] });
    } else {
      bucket.rows.push(row);
    }
  }

  const lines: PreviewLine[] = [];

  const sortOrder = new Map<string, PlanProduct>();

  for (const [productId, { product, rows }] of buckets) {
    sortOrder.set(productId, product);
    const cart = input.cart.get(productId) ?? null;

    const optionalRows = rows.filter((row) => row.ingredient.isOptional);
    const requiredRows = rows.filter((row) => !row.ingredient.isOptional);
    const optional = requiredRows.length === 0;

    // An optional row never contributes to a non-optional bucket's number
    // (D10). In a bucket that is optional all the way down the rows *are* the
    // line, so they are classified like any other; otherwise they are set
    // aside and named in the «не считали» sub-line (C10).
    const effective = optional ? optionalRows : requiredRows;
    const setAside = optional ? [] : optionalRows;

    const classified = effective.map(classifyRow);
    const quantified = classified.filter((entry) => entry.quantified);
    const { options, demoted } = foldOptions(quantified, cart, product);

    const presence = [
      ...classified.filter((entry) => !entry.quantified),
      ...demoted,
    ].sort(bySourceOrder);

    // An optional row set aside from a mixed bucket is named for what it is,
    // not for what it stated: «опционально» is the reason it was not counted.
    const setAsideRows: ClassifiedRow[] = setAside.map((row) => ({
      row,
      kind: "optional",
      quantified: false,
    }));

    const unabsorbed: ClassifiedRow[] = [...setAsideRows];

    if (options.length === 0) {
      // D11: «кончилось» and «рецепт просит соль, а сколько — не сказал» are
      // the same assertion of presence, so this reuses `RAN_OUT_QTY` rather
      // than writing a literal 1 — and `pantry.ranOut` already puts exactly
      // this quantity into the cart with no preview at all, which makes a
      // preview row with a checkbox strictly more conservative.
      options.push({
        qty: RAN_OUT_QTY,
        unit: product.defaultUnit,
        qtySource: "fallback",
        contributions: presence.map((entry) => toContribution(entry)),
      });
    } else {
      unabsorbed.push(...presence);
    }

    const uncounted: PreviewContribution[] = unabsorbed
      .sort(bySourceOrder)
      .map((entry) => toContribution(entry));

    const placed = placeLine(
      options,
      uncounted,
      cart,
      optional,
      input.pantry.has(productId),
    );

    // Step 7 — the note belongs to the shopper («покрупнее»), so it is carried
    // only when one row unambiguously owns it. Two contributions describe two
    // different uses of one product and joining them describes neither; an
    // existing line's note is never touched at all.
    const only =
      rows.length === 1 ? trimmedNote(rows[0]?.ingredient.note ?? null) : null;

    lines.push({
      productId,
      productName: product.name,
      productIcon: product.icon,
      categoryId: product.categoryId,
      group: placed.group,
      options: placed.options,
      defaultUnit: placed.defaultUnit,
      selectable: placed.selectable,
      intent: placed.intent,
      reason: placed.reason,
      optional,
      uncounted,
      needsReview: rows.some((row) => row.ingredient.needsReview),
      inCart: cart === null ? null : { ...cart },
      note: only !== null && only.length <= MAX_NOTE_LENGTH ? only : null,
    });
  }

  // Step 8 — the walking order `cart.list` and `pantry.list` already return,
  // so the preview reads like the cart it is about to become.
  lines.sort((a, b) => {
    const left = sortOrder.get(a.productId);
    const right = sortOrder.get(b.productId);
    return (
      (left?.categorySortOrder ?? 0) - (right?.categorySortOrder ?? 0) ||
      a.productName.localeCompare(b.productName, "ru")
    );
  });

  const counts: PreviewCounts = {
    add: lines.filter((line) => line.group === "add").length,
    pantry: lines.filter((line) => line.group === "pantry").length,
    inCart: lines.filter((line) => line.group === "inCart").length,
    manual: lines.filter((line) => line.group === "manual").length,
    skipped: skipped.length,
  };

  return { lines, skipped, counts, dishCount, cookedSkipped };
}

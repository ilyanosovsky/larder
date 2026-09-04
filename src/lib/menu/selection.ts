import type { Unit } from "@/lib/units";
import type {
  CartPlan,
  PreviewLine,
  PreviewOption,
} from "@/server/menu/build-cart";

/**
 * What the MergePreview sheet has ticked, as a pure value.
 *
 * Lifted out of the component for the reason `next-focus-target.ts` and
 * `adapt-phase.ts` were: vitest runs in **node** with no DOM harness, so a
 * rule left inside a `.tsx` is unreachable from the suite and a flipped branch
 * ships green. Here that matters more than usual — the footer says «Добавить 8
 * позиций» and the request has to contain exactly those eight, so the number
 * and the payload must come from one place and cannot be allowed to drift.
 *
 * The import from `@/server/menu/build-cart` is **type-only** and therefore
 * fully erased (the `ran-out-outcome.ts` precedent): this module ships to the
 * browser, and the plan's shape is the server's to define.
 */

/** productId → the chosen option's unit. Absent = not selected. */
export type SelectionState = ReadonlyMap<string, Unit>;

/**
 * One instruction on the wire, as `applyCartSelection` mirrors it in zod.
 *
 * **Additive, always** (D14): «add 3 шт», never «make it 5 шт». An additive
 * instruction composes with whatever a partner did in the gap between the
 * preview and the confirm; an absolute one silently undoes their change.
 */
export interface ApplySelectionLine {
  productId: string;
  qty: number;
  unit: Unit;
  /** For a *new* line only; a merge and a restore keep the row's own note. */
  note: string | null;
  /** «вернуть в „нужно"» for a line bought in the still-open trip (D16). */
  restore: boolean;
}

export interface SelectionCounts {
  /** The footer's number — what the confirm will actually send. */
  include: number;
  /** The header's three (plus the fourth), from the plan — not the selection. */
  add: number;
  pantry: number;
  inCart: number;
  manual: number;
}

type PlanLines = Pick<CartPlan, "lines">;

/**
 * The option a line is currently set to, or `null`.
 *
 * `selectable` is checked here rather than at every call site, so a line the
 * plan refuses can never be counted, rendered as ticked, or sent — even if a
 * stale key for it survives in the map.
 */
function chosenOption(
  line: PreviewLine,
  state: SelectionState,
): PreviewOption | null {
  if (!line.selectable) {
    return null;
  }

  const unit = state.get(line.productId);
  if (unit === undefined) {
    return null;
  }

  return line.options.find((option) => option.unit === unit) ?? null;
}

/**
 * The state the sheet opens with: every line's own `defaultUnit`, and nothing
 * else.
 *
 * Which is D9 in one line — only a plain «add» row carries a `defaultUnit`, so
 * every pantry row, every «уже в корзине» row and every optional row opens
 * unticked, and the footer's number equals `counts.add` on open.
 */
export function seedSelection(plan: PlanLines): SelectionState {
  const state = new Map<string, Unit>();

  for (const line of plan.lines) {
    if (line.defaultUnit !== null) {
      state.set(line.productId, line.defaultUnit);
    }
  }

  return state;
}

/**
 * Sets a line to one of its own options, or clears it with `null`.
 *
 * A checkbox row passes `line.options[0].unit` or `null`; a `unitConflict`
 * row's radio passes the option the person picked. A unit the line does not
 * offer, and any change at all to an unselectable line, are refused — and
 * refused by returning the **same** map, so React skips the re-render rather
 * than seeing a new identity for an unchanged value.
 */
export function toggleLine(
  state: SelectionState,
  line: PreviewLine,
  unit: Unit | null,
): SelectionState {
  if (!line.selectable) {
    return state;
  }

  if (unit === null) {
    if (!state.has(line.productId)) {
      return state;
    }
    const next = new Map(state);
    next.delete(line.productId);
    return next;
  }

  if (!line.options.some((option) => option.unit === unit)) {
    return state;
  }

  if (state.get(line.productId) === unit) {
    return state;
  }

  const next = new Map(state);
  next.set(line.productId, unit);
  return next;
}

/**
 * The header's counts and the footer's, side by side.
 *
 * **They are different numbers and pretending otherwise would make one of them
 * a lie.** The header describes the plan («+8 позиций · 4 уже дома · 2 уже в
 * корзине»); the footer describes the selection, and the two diverge the
 * moment somebody ticks a «уже дома» row on or an «add» row off.
 */
export function selectionCounts(
  plan: Pick<CartPlan, "lines" | "counts">,
  state: SelectionState,
): SelectionCounts {
  let include = 0;

  for (const line of plan.lines) {
    if (chosenOption(line, state) !== null) {
      include += 1;
    }
  }

  return {
    include,
    add: plan.counts.add,
    pantry: plan.counts.pantry,
    inCart: plan.counts.inCart,
    manual: plan.counts.manual,
  };
}

/**
 * The mutation's `selections`, and the **only** function allowed to build them.
 *
 * Drops anything unselectable regardless of what the map holds, so a stale key
 * from a preview the sheet re-fetched can never turn into a write, and asserts
 * the payload's own invariant: one selection per product. It is the client
 * half of `applyCartInput`'s `refine` — both exist because either alone could
 * be bypassed, and two selections for one product would take the same row lock
 * twice inside one transaction, which is the only way this flow could produce
 * a quantity nobody chose.
 *
 * `selectionCounts(plan, s).include === selectionToApplyLines(plan, s).length`
 * is pinned by a test on a randomised plan. That identity is what makes
 * «Добавить 8 позиций» a promise the request can keep.
 */
export function selectionToApplyLines(
  plan: PlanLines,
  state: SelectionState,
): ApplySelectionLine[] {
  const lines: ApplySelectionLine[] = [];
  const seen = new Set<string>();

  for (const line of plan.lines) {
    const option = chosenOption(line, state);

    if (option === null || seen.has(line.productId)) {
      continue;
    }

    seen.add(line.productId);
    lines.push({
      productId: line.productId,
      qty: option.qty,
      unit: option.unit,
      note: line.note,
      restore: line.intent === "restore",
    });
  }

  return lines;
}

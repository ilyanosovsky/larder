import { portionsDisplay } from "@/lib/recipes/portions";

/** What the decision needs off a `menu.current` row. */
export interface MenuCardPortions {
  /** What this household is cooking — the number the ± control shows. */
  portions: number;
  /** The recipe's own stated yield. */
  portionsBase: number;
  /** The source's own noun («печений»); `null` means «порции». */
  yieldUnit: string | null;
}

/**
 * Which of the two `menu.cardPortions*` messages the S10 card renders under
 * its ± control, and with what.
 *
 * The branch lives here rather than inline in `menu-screen.tsx` for the
 * reason `ingredientsForMessage` states about its own: vitest runs in `node`
 * with no DOM harness, so a ternary inside a `.tsx` is unreachable from the
 * suite and a flipped branch ships green.
 *
 * **The yield noun survives only at the recipe's own count.**
 * `menu.cardPortionsUnit` interpolates «печений» verbatim — it is imported
 * data, not a declinable word this app owns — so it is grammatical only at
 * the count it was recorded for: «7 печений» cooked at 3 portions is not «3
 * печений». Every other count falls back to the correctly declined
 * `menu.cardPortions` («3 порции»), which is exactly the rule
 * `ingredientsForMessage` applies two screens away, and applying a different
 * one here is how S7 and S10 would end up disagreeing about one dish.
 *
 * Only the two *single* messages exist, not the four S7 needs: the ± control
 * always yields one number, never a range.
 */
export type CardPortionsMessage =
  | { key: "cardPortions"; values: { count: number } }
  | { key: "cardPortionsUnit"; values: { count: number; unit: string } };

export function cardPortionsMessage(
  item: MenuCardPortions,
): CardPortionsMessage {
  // Through `portionsDisplay` rather than a bare `yieldUnit !== null`, so a
  // recipe whose noun is «   » is treated as absent here exactly as it is on
  // S6 and S7. `portionsMin: null` because a range is the recipe's statement
  // about itself, and this line is about the household's own count.
  const display = portionsDisplay({
    portionsBase: item.portions,
    portionsMin: null,
    yieldUnit: item.portions === item.portionsBase ? item.yieldUnit : null,
  });

  return display.kind === "single" && display.unit !== null
    ? { key: "cardPortionsUnit", values: { count: display.count, unit: display.unit } }
    : { key: "cardPortions", values: { count: item.portions } };
}

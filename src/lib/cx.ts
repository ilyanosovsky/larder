/**
 * Joins the CSS Modules class names that apply and skips the ones that do
 * not. Shared rather than redeclared per component — `cart-screen.tsx` and
 * `cart-item-sheet.tsx` (task 2.5) both need it, and a one-line helper is
 * exactly the kind of thing that quietly drifts if it is copy-pasted.
 */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

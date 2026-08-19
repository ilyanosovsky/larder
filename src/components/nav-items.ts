// Navigation structure for the app shell (DESIGN_BRIEF.md §2). Mobile gets a
// bottom tab bar with 4 tabs; desktop gets the same 4 items in a sidebar plus
// a "Настройки" item pinned at the bottom. Keys double as message keys in
// both the `nav` (label) and `placeholders` (placeholder screen copy)
// namespaces of src/messages/ru.json.

export type NavKey = "purchases" | "menu" | "dishes" | "assistant" | "settings";

export interface NavItem {
  key: NavKey;
  href: string;
}

export const TAB_ITEMS: readonly NavItem[] = [
  { key: "purchases", href: "/" },
  { key: "menu", href: "/menu" },
  { key: "dishes", href: "/dishes" },
  { key: "assistant", href: "/assistant" },
];

export const SIDEBAR_FOOTER_ITEM: NavItem = {
  key: "settings",
  href: "/settings",
};

/**
 * Whether a nav item should render as active for the given pathname.
 * The root route ("/") only matches exactly, otherwise every route would
 * appear active; other routes also match their own sub-paths.
 */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

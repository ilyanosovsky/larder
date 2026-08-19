import type { JSX } from "react";

import type { NavKey } from "./nav-items";

// Hand-drawn, single-stroke line icons matching the Paper Ledger aesthetic
// (design/uploads/tokens.css) — no icon library dependency. `currentColor`
// lets the active/inactive nav styles drive the color.
const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function PurchasesIcon(): JSX.Element {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M6 8h12l-1 12H7L6 8Z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

function MenuIcon(): JSX.Element {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <rect x="4" y="5" width="16" height="15" />
      <path d="M4 9h16" />
      <path d="M8 3v4M16 3v4" />
    </svg>
  );
}

function DishesIcon(): JSX.Element {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M12 6c-1.6-1.2-3.6-1.6-6-1.2v13c2.4-.4 4.4 0 6 1.2 1.6-1.2 3.6-1.6 6-1.2V4.8c-2.4-.4-4.4 0-6 1.2Z" />
      <path d="M12 6v13" />
    </svg>
  );
}

function AssistantIcon(): JSX.Element {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M4 6h16v10H9l-4 3v-3H4V6Z" />
      <path d="M9 11h6" />
    </svg>
  );
}

function SettingsIcon(): JSX.Element {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M4.2 7.2l2.1 1.6M17.7 15.2l2.1 1.6M3 12h3M18 12h3M4.2 16.8l2.1-1.6M17.7 8.8l2.1-1.6" />
    </svg>
  );
}

export const NAV_ICONS: Record<NavKey, () => JSX.Element> = {
  purchases: PurchasesIcon,
  menu: MenuIcon,
  dishes: DishesIcon,
  assistant: AssistantIcon,
  settings: SettingsIcon,
};

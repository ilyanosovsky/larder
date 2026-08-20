/**
 * The 7 store departments every new household starts with (VISION §3.1,
 * §5; DESIGN_BRIEF §5 "Отделы (в порядке маршрута)"). Array order is the
 * default `sortOrder` — `household.create` inserts these, in this order,
 * for the household it just made; the migration backs the same 7 into any
 * household that predates this table. A household can reorder its own
 * copy afterwards (`category.reorder`), so this list is only ever a seed.
 */
export interface DefaultCategory {
  readonly slug: DefaultCategorySlug;
  readonly name: string;
  readonly icon: string;
}

export const DEFAULT_CATEGORY_SLUGS = [
  "produce",
  "dairy",
  "meat",
  "bakery",
  "grocery",
  "frozen",
  "household",
] as const;

export type DefaultCategorySlug = (typeof DEFAULT_CATEGORY_SLUGS)[number];

export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  { slug: "produce", name: "Овощи и фрукты", icon: "🥬" },
  { slug: "dairy", name: "Молочное и яйца", icon: "🥛" },
  { slug: "meat", name: "Мясо и курица", icon: "🥩" },
  { slug: "bakery", name: "Хлеб и выпечка", icon: "🥖" },
  { slug: "grocery", name: "Бакалея", icon: "🍝" },
  { slug: "frozen", name: "Заморозка", icon: "🧊" },
  { slug: "household", name: "Хозяйственное", icon: "🧴" },
];

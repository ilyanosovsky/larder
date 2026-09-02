// Run via `pnpm db:seed` (tsx src/db/seed.ts). Deliberately independent of
// `./index.ts`'s `db()`: that module is guarded by `import "server-only"`,
// which throws when run directly under Node/tsx outside a Next.js
// server-component bundle. This script opens its own connection instead.
import { existsSync } from "node:fs";

import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { RecipeUnit } from "@/lib/units";
import { normalizeProductName } from "@/server/catalog/normalize";
import { normalizeDishTitle } from "@/server/dishes/normalize";
import { deriveNeedsReview } from "@/server/recipes/needs-review";

import * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

/**
 * Seeds baseline data into a fresh database.
 *
 * Deliberately still a no-op after task 1.2: the default 7 departments are
 * per-household data, not global rows, so they are inserted by
 * `household.create` (and backed into existing households by migration
 * `0003_true_tigra`) rather than by this script — see
 * `src/server/catalog/default-categories.ts`. The reference product catalog
 * (`src/server/catalog/reference-products.ts`) is static in-code data for
 * the task 1.3 autocomplete, never rows in the database, so there is
 * nothing for a seed script to write for it either.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept so main() can still call seed(db); nothing here needs it, see above
export async function seed(db: Database): Promise<void> {
  // Nothing to seed: see the comment above.
}

/** One ingredient line of a demo recipe, before it is bound to the catalog. */
interface SeedIngredient {
  /** The source line verbatim, exactly as DESIGN_BRIEF §5 writes it. */
  rawText: string;
  /** The buyable noun the matcher looks up. */
  name: string;
  qty: number | null;
  unit: RecipeUnit | null;
  note?: string;
  isOptional?: boolean;
}

interface SeedStep {
  text: string;
  timerSec?: number;
  timerMaxSec?: number;
}

interface SeedDish {
  title: string;
  tags: string[];
  sourceType: (typeof schema.dishSourceTypeEnum.enumValues)[number];
  totalTimeMin: number;
  portionsBase: number;
  portionsMin: number | null;
  yieldUnit: string | null;
  equipment: string[];
  ingredients: SeedIngredient[];
  steps: SeedStep[];
}

/**
 * DESIGN_BRIEF §5's own recipe, transcribed rather than invented — it is the
 * content every S6/S7 mockup is drawn with, and it happens to contain all
 * three ingredient states at once: «Кукурузный крахмал» with no quantity
 * (the amber «уточнить» chip), «Biscoff / нутелла» as optional, and ordinary
 * rows with notes like «(холодное)».
 *
 * «Шакшука» is composed from the same section's vocabulary (its MergePreview
 * names лук and перец болгарский for this dish; the rest comes from §5's own
 * cart and pantry examples) and adds the third state the cookies do not have:
 * «Соль — по вкусу», a deliberate absence that must render as plain text and
 * wear no chip at all.
 */
const SEED_DISHES: SeedDish[] = [
  {
    title: "NYC Cookies",
    tags: ["выпечка", "духовка"],
    sourceType: "photo",
    totalTimeMin: 30,
    portionsBase: 8,
    portionsMin: 7,
    yieldUnit: "печений",
    equipment: ["oven"],
    ingredients: [
      { rawText: "Мука — 285 г", name: "Мука", qty: 285, unit: "г" },
      {
        rawText: "Кукурузный крахмал",
        name: "Кукурузный крахмал",
        qty: null,
        unit: null,
      },
      { rawText: "Соль — ¾ ч.л.", name: "Соль", qty: 0.75, unit: "ч.л." },
      {
        rawText: "Разрыхлитель — ½ ч.л.",
        name: "Разрыхлитель",
        qty: 0.5,
        unit: "ч.л.",
      },
      {
        rawText: "Масло сливочное (холодное) — 180 г",
        name: "Масло сливочное",
        qty: 180,
        unit: "г",
        note: "холодное",
      },
      {
        rawText: "Сахар белый — 90 г",
        name: "Сахар белый",
        qty: 90,
        unit: "г",
      },
      {
        rawText: "Сахар коричневый — 140 г",
        name: "Сахар коричневый",
        qty: 140,
        unit: "г",
      },
      {
        rawText: "Яйца (холодные) — 2 шт",
        name: "Яйца",
        qty: 2,
        unit: "шт",
        note: "холодные",
      },
      {
        rawText: "Шоколад крупными кусками — 150 г",
        name: "Шоколад тёмный",
        qty: 150,
        unit: "г",
        note: "крупными кусками",
      },
      {
        rawText: "Biscoff / нутелла (замороженные порции) — опционально",
        name: "Biscoff / нутелла",
        qty: null,
        unit: null,
        note: "замороженные порции",
        isOptional: true,
      },
    ],
    steps: [
      { text: "Смешать сухие ингредиенты." },
      { text: "Холодное масло порубить с сахаром, добавить яйца." },
      { text: "Соединить, вмешать шоколад — тесто плотное и липкое." },
      { text: "Слепить руками высокие шары по 140–160 г, НЕ гладкие." },
      {
        text: "Духовка 205 °C, уровень чуть выше середины, двойной противень.",
        timerSec: 540,
        timerMaxSec: 660,
      },
      {
        text: "Готово, когда края золотые, верх с трещинами, центр мягкий и кажется недопечённым.",
      },
    ],
  },
  {
    title: "Шакшука",
    tags: ["завтрак", "быстро"],
    sourceType: "manual",
    totalTimeMin: 25,
    portionsBase: 2,
    portionsMin: null,
    yieldUnit: null,
    equipment: ["induction_hob"],
    ingredients: [
      { rawText: "Яйца — 4 шт", name: "Яйца", qty: 4, unit: "шт" },
      {
        rawText: "Томаты в собственном соку — 1 банка",
        name: "Томаты в собственном соку",
        qty: 1,
        unit: "банка",
      },
      { rawText: "Лук — 1 шт", name: "Лук", qty: 1, unit: "шт" },
      {
        rawText: "Перец болгарский — 1 шт",
        name: "Перец болгарский",
        qty: 1,
        unit: "шт",
      },
      {
        rawText: "Чеснок — 2 зубчика",
        name: "Чеснок",
        qty: 2,
        unit: null,
        note: "зубчика",
      },
      {
        rawText: "Масло оливковое — 1 ст.л.",
        name: "Масло оливковое",
        qty: 1,
        unit: "ст.л.",
      },
      { rawText: "Соль — по вкусу", name: "Соль", qty: null, unit: null, note: "по вкусу" },
      { rawText: "Кинза — 1 пучок", name: "Кинза", qty: 1, unit: "пучок" },
    ],
    steps: [
      { text: "Лук и перец нарезать, обжарить на оливковом масле до мягкости." },
      { text: "Добавить чеснок и томаты, потушить.", timerSec: 480 },
      { text: "Сделать лунки, вбить яйца, накрыть крышкой.", timerSec: 300, timerMaxSec: 420 },
      { text: "Посолить, посыпать кинзой, подавать со сковороды." },
    ],
  },
];

/** Loopback only — the URL forms a local Postgres actually comes as. */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Refuses to run against anything but a local database.
 *
 * `--dishes` writes demo content, and `drizzle.config.ts` already documents
 * how easily a production URL ends up in this process's environment. Two
 * lines close that footgun: a hostname check is cheap, and «случайно засеял
 * прод» is not a mistake worth being able to make.
 */
function assertLocalDatabase(databaseUrl: string): void {
  let hostname: string;

  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid URL; refusing to seed.");
  }

  if (!LOCAL_HOSTNAMES.has(hostname)) {
    throw new Error(
      `Refusing to seed demo dishes into "${hostname}": --dishes is a local ` +
        "development fixture. Point DATABASE_URL at localhost and try again.",
    );
  }
}

/**
 * Inserts the demo dish library into the first household, skipping any dish
 * whose title is already there.
 *
 * Idempotent by `normalized_title` so a second run is a no-op rather than a
 * duplicate library — deliberately a check and not a unique index, because
 * `dishes.normalized_title` is not unique by design (a household is allowed
 * two dishes with one name; a seed script is not).
 *
 * Ingredients bind to catalog products by `normalized_name` **when a product
 * with that name already exists**, and stay unbound otherwise. That is the
 * honest state task 4.1 ships — an unbound row renders as itself, with no
 * «дома есть ✓» and no pantry check — and it is exactly what task 4.2's
 * resolution step will fill in.
 */
async function seedDishes(db: Database): Promise<number> {
  const [household] = await db
    .select({ id: schema.households.id })
    .from(schema.households)
    .orderBy(asc(schema.households.createdAt))
    .limit(1);

  if (!household) {
    throw new Error(
      "No household to seed into — sign in once and create one first.",
    );
  }

  const householdId = household.id;

  const wantedNames = [
    ...new Set(
      SEED_DISHES.flatMap((dish) =>
        dish.ingredients.map((row) => normalizeProductName(row.name)),
      ),
    ),
  ];

  const catalog = await db
    .select({
      id: schema.products.id,
      normalizedName: schema.products.normalizedName,
    })
    .from(schema.products)
    .where(
      and(
        eq(schema.products.householdId, householdId),
        inArray(schema.products.normalizedName, wantedNames),
      ),
    );

  const productIds = new Map(
    catalog.map((product) => [product.normalizedName, product.id]),
  );

  let inserted = 0;

  for (const seedDish of SEED_DISHES) {
    const normalizedTitle = normalizeDishTitle(seedDish.title);

    const [existing] = await db
      .select({ id: schema.dishes.id })
      .from(schema.dishes)
      .where(
        and(
          eq(schema.dishes.householdId, householdId),
          eq(schema.dishes.normalizedTitle, normalizedTitle),
        ),
      )
      .limit(1);

    if (existing) {
      console.log(`skipped "${seedDish.title}" — already in the library`);
      continue;
    }

    await db.transaction(async (tx) => {
      const [dish] = await tx
        .insert(schema.dishes)
        .values({
          householdId,
          title: seedDish.title,
          normalizedTitle,
          tags: seedDish.tags,
          sourceType: seedDish.sourceType,
        })
        .returning({ id: schema.dishes.id });

      if (!dish) {
        throw new Error(`Inserting "${seedDish.title}" returned no row`);
      }

      const [recipe] = await tx
        .insert(schema.recipes)
        .values({
          householdId,
          dishId: dish.id,
          portionsBase: seedDish.portionsBase,
          portionsMin: seedDish.portionsMin,
          yieldUnit: seedDish.yieldUnit,
          totalTimeMin: seedDish.totalTimeMin,
          equipment: seedDish.equipment,
        })
        .returning({ id: schema.recipes.id });

      if (!recipe) {
        throw new Error(`Inserting the recipe for "${seedDish.title}" failed`);
      }

      await tx.insert(schema.recipeIngredients).values(
        seedDish.ingredients.map((row, index) => {
          const note = row.note ?? null;
          const isOptional = row.isOptional ?? false;

          return {
            householdId,
            recipeId: recipe.id,
            productId: productIds.get(normalizeProductName(row.name)) ?? null,
            rawText: row.rawText,
            name: row.name,
            qty: row.qty,
            unit: row.unit,
            note,
            isOptional,
            needsReview: deriveNeedsReview({
              qty: row.qty,
              unit: row.unit,
              isOptional,
              note,
            }),
            sortOrder: index,
          };
        }),
      );

      await tx.insert(schema.recipeSteps).values(
        seedDish.steps.map((step, index) => ({
          householdId,
          recipeId: recipe.id,
          stepOrder: index,
          text: step.text,
          timerSec: step.timerSec ?? null,
          timerMaxSec: step.timerMaxSec ?? null,
        })),
      );
    });

    inserted += 1;
    console.log(`seeded "${seedDish.title}"`);
  }

  return inserted;
}

/**
 * Loads the same env files `drizzle.config.ts` does, with the same effective
 * precedence — which is why `.env` is read **first**, not last.
 *
 * Unlike drizzle-kit, plain `tsx` preloads nothing, so without this the
 * documented `pnpm db:seed` only worked with `DATABASE_URL` exported into the
 * shell. `process.loadEnvFile` never overrides a variable that is already
 * set, so whichever file is read first wins — and drizzle-kit's own bundled
 * dotenv preloads `.env` before `drizzle.config.ts` ever runs (see the note
 * there). Reading `.env` first here reproduces that exactly: shell beats
 * `.env` beats `.env.local`, in both commands. The reverse order would let
 * `pnpm db:seed --dishes` populate one local database while `pnpm db:migrate`
 * migrated another.
 */
function loadEnvFiles(): void {
  for (const file of [".env", ".env.local"]) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
    }
  }
}

async function main(): Promise<void> {
  loadEnvFiles();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set.");
  }

  const withDishes = process.argv.includes("--dishes");
  if (withDishes) {
    assertLocalDatabase(databaseUrl);
  }

  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });

  try {
    await seed(db);

    if (withDishes) {
      const inserted = await seedDishes(db);
      console.log(`done: ${inserted} dish(es) inserted`);
    } else {
      console.log("nothing to seed yet — pass --dishes for the demo library");
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

import { RECIPE_UNITS, type RecipeUnit } from "@/lib/units";

/**
 * A recipe's own unit word → the canon (`RECIPE_UNITS`), or nothing at all.
 *
 * The model returns `unit` as **free Russian text**, deliberately (see
 * `parsedRecipeSchema`): an enum in the strict schema would make it bucket
 * «зубчик» into «шт» and hand back a confidently wrong quantity, which is the
 * honesty failure VISION §6.4 forbids. This module is the other half of that
 * decision — it maps what it can and hands back everything else as
 * `leftover`, which `draftFromParsed` appends to the row's `note`.
 *
 * **Nothing is ever dropped and nothing is ever guessed.** «2 зубчика
 * чеснока» becomes `qty: 2, unit: null, note: "зубчик"` — a quantity that
 * states itself perfectly well in words, and one that `deriveNeedsReview`
 * therefore does *not* flag. Rewriting it as «2 шт» would be a different
 * recipe.
 *
 * Pure and exhaustively tested, because every wrong entry here is a wrong
 * number on a shopping list two screens later.
 */
export interface CoercedUnit {
  /** A canonical unit, or `null` when the word names none. */
  readonly unit: RecipeUnit | null;
  /** The original word, kept for the note when it could not be mapped. */
  readonly leftover: string | null;
}

const CANON: ReadonlySet<string> = new Set(RECIPE_UNITS);

/**
 * Spellings a Russian recipe actually uses, folded to the canon.
 *
 * Keys are already normalized (lower case, ё→е, no internal spaces, no
 * trailing dots), so «Ч. Л.», «ч.л» and «чайной ложки» are one lookup.
 * Genitive and plural forms are listed explicitly rather than stemmed: a
 * stemmer would also match words that are not units, and this list is short
 * and readable enough to audit.
 */
const SPELLINGS: Readonly<Record<string, RecipeUnit>> = {
  // штуки
  шт: "шт",
  штук: "шт",
  штука: "шт",
  штуки: "шт",
  штуки́: "шт",
  штучек: "шт",
  // граммы
  г: "г",
  гр: "г",
  грамм: "г",
  грамма: "г",
  граммов: "г",
  граммы: "г",
  // килограммы
  кг: "кг",
  килограмм: "кг",
  килограмма: "кг",
  килограммов: "кг",
  // литры
  л: "л",
  литр: "л",
  литра: "л",
  литров: "л",
  // миллилитры
  мл: "мл",
  миллилитр: "мл",
  миллилитра: "мл",
  миллилитров: "мл",
  // упаковки
  уп: "уп",
  упак: "уп",
  упаковка: "уп",
  упаковки: "уп",
  упаковок: "уп",
  пачка: "уп",
  пачки: "уп",
  // пучки
  пучок: "пучок",
  пучка: "пучок",
  пучков: "пучок",
  // банки
  банка: "банка",
  банки: "банка",
  банок: "банка",
  // плитки
  плитка: "плитка",
  плитки: "плитка",
  плиток: "плитка",
  // чайные ложки
  "ч.л": "ч.л.",
  чл: "ч.л.",
  "чайная ложка": "ч.л.",
  "чайной ложки": "ч.л.",
  "чайные ложки": "ч.л.",
  "чайных ложек": "ч.л.",
  "ч ложка": "ч.л.",
  // столовые ложки
  "ст.л": "ст.л.",
  стл: "ст.л.",
  "столовая ложка": "ст.л.",
  "столовой ложки": "ст.л.",
  "столовые ложки": "ст.л.",
  "столовых ложек": "ст.л.",
  "ст ложка": "ст.л.",
  "ст.ложка": "ст.л.",
  // стаканы
  стакан: "стакан",
  стакана: "стакан",
  стаканов: "стакан",
  ст: "стакан",
  // щепотки
  щепотка: "щепотка",
  щепотки: "щепотка",
  щепоть: "щепотка",
};

/**
 * Lower-cases, folds ё→е, collapses whitespace and strips the dots people put
 * inside abbreviations — the three variations «ч. л.», «ч.л.» and «ч л» are
 * one word to a cook and must be one key here.
 *
 * Dots are removed rather than kept because they are punctuation in every
 * spelling that uses them; the canon's own «ч.л.» is restored from the table,
 * never from the input.
 */
function normalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\.+$/, "");
}

export function coerceRecipeUnit(raw: string | null): CoercedUnit {
  if (raw === null) {
    return { unit: null, leftover: null };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // An empty unit is "unstated", not "unrecognized": there is nothing worth
    // carrying into the note.
    return { unit: null, leftover: null };
  }

  const normalized = normalize(trimmed);

  // A value already in the canon passes through — a re-coerced draft (task
  // 4.6's adaptation reads stored units back) must be a no-op.
  if (CANON.has(normalized)) {
    return { unit: normalized as RecipeUnit, leftover: null };
  }

  const mapped = SPELLINGS[normalized];
  if (mapped !== undefined) {
    return { unit: mapped, leftover: null };
  }

  const spoon = coerceSpoon(normalized);
  if (spoon !== null) {
    return { unit: spoon, leftover: null };
  }

  // «зубчик», «по вкусу», «веточка»: a real measure the app has no column
  // for. It survives as words on the row rather than becoming a wrong number.
  return { unit: null, leftover: trimmed };
}

/**
 * Every word this module recognizes as a measure, normalized — the canon and
 * `SPELLINGS`' own keys, in one set.
 *
 * Exported for `draft-from-parsed.ts`'s name check: a `name` whose words
 * include one of these is a source line the model failed to reduce to a
 * buyable noun («Стакан йогурта»), and binding the catalog on it would mint a
 * near-duplicate product. Derived from the same two lists the coercion uses,
 * so a spelling added above is covered here without a second edit.
 */
/**
 * Spoons, in every declension, by rule rather than by enumeration.
 *
 * Real recipes write «2 ст. ложки», «1 чайной ложки», «столовых ложек» —
 * Russian declines both words, and the table above would need a dozen entries
 * per spoon to cover it (a real import missed «ст. ложки» that way). The
 * `лож(к|ек)` stem is what makes the shortcut safe: «ст» on its own is
 * «стакан», and only a word carrying that stem can be a spoon. Both halves
 * are needed — the genitive plural «ложек» drops the к's vowel neighbour, so
 * «ложк» alone misses «2 ст. ложек».
 *
 * Deliberately not a general stemmer: it answers one question about one
 * family of words, and everything it does not recognize still survives as a
 * leftover rather than becoming a wrong unit.
 */
function coerceSpoon(normalized: string): RecipeUnit | null {
  if (!/лож(к|ек)/.test(normalized)) {
    return null;
  }
  if (/^(ч|чаин|чайн)/.test(normalized)) {
    return "ч.л.";
  }
  if (/^(ст|столов)/.test(normalized)) {
    return "ст.л.";
  }
  // «Ложка» with no size named is not a measure we can honestly pick.
  return null;
}

export const UNIT_WORDS: ReadonlySet<string> = new Set([
  ...RECIPE_UNITS.map(normalize),
  ...Object.keys(SPELLINGS),
]);

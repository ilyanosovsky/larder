import { z } from "zod";

import type { RecipeDraft } from "@/lib/recipes/draft";
import { RECIPE_UNITS } from "@/lib/units";
import {
  toStrictJsonSchema,
  type AiChatClient,
  type AiRequestOptions,
} from "@/server/ai/openai";
import {
  AI_MODEL,
  computeCostUsd,
  usageFrom,
  type AiUsage,
} from "@/server/ai/pricing";
import { EQUIPMENT_WORD } from "@/server/recipes/coerce-equipment";
import type { EquipmentSlug } from "@/server/kitchen/equipment";

/**
 * The adaptation a model proposes (blueprint §6 «4.6», decision D25) — and
 * the only shape `dish.adapt` will act on.
 *
 * **Edits addressed by index, never a whole new recipe.** The single most
 * important property of this schema: a model that hands back a complete
 * recipe silently rewrites every row it was not asked to touch — names,
 * bindings, the verbatim `rawText` S8.3 checks its own output against — and
 * nothing downstream can tell an intentional change from a re-derivation. An
 * edit that names `index: 3` can only ever be about row 3, and a row nobody
 * mentioned is a row nobody changed. `name`, `isOptional` and `productId` are
 * deliberately absent from this document altogether: an adaptation changes
 * *how much* and *how*, never *what* a recipe is made of, so a catalog
 * binding cannot drift under an adaptation.
 *
 * **Primitives only**, exactly like `parsedRecipeSchema`: no `z.enum`, no
 * `.min()`/`.max()`, no `z.int()` at any depth — `z.toJSONSchema` emits
 * `minimum`/`maximum`/`multipleOf` for those and OpenAI's strict mode rejects
 * every one of them with a 400 on the first real call. `adapt-recipe.schema
 * .test.ts` walks the emitted document and is what keeps a later tidy-up
 * honest; it was written before this prompt existed.
 *
 * `.nullable()`, never `.optional()` (AGENTS.md): strict mode requires every
 * property to be `required`.
 */
export const recipeAdaptationSchema = z.object({
  /** One short Russian phrase: «переделано под духовку вместо аэрогриля». */
  summary: z.string(),
  /**
   * Only the rows that change, each carrying its **whole** new state — a
   * `null` here means "this row states no amount", not "leave it alone". A
   * row the adaptation does not mention keeps everything it had.
   */
  ingredients: z.array(
    z.object({
      /** Position in the ingredient list the model was shown, 0-based. */
      index: z.number(),
      qty: z.number().nullable(),
      /** Free Russian text; `coerceRecipeUnit` maps it or routes it to `note`. */
      unit: z.string().nullable(),
      note: z.string().nullable(),
      /**
       * The source line restated for the new amount, or `null` to keep the
       * one the recipe was imported with. Offered rather than forced: after
       * «227 г» becomes «113 г» the original line is a number that no longer
       * matches the row beside it, and S8.3 shows both.
       */
      rawText: z.string().nullable(),
    }),
  ),
  /** Replacements for existing steps, by the index they were shown at. */
  steps: z.array(
    z.object({
      index: z.number(),
      text: z.string(),
      /** Seconds, the LOWER bound of a range — S9 counts down from it. */
      timerSec: z.number().nullable(),
      timerMaxSec: z.number().nullable(),
    }),
  ),
  /** Steps the adaptation makes unnecessary, by their original index. */
  removedStepIndexes: z.array(z.number()),
  addedSteps: z.array(
    z.object({
      /**
       * The original step index this one follows; `-1` puts it first. An
       * anchor that no longer exists drops the addition rather than guessing
       * a neighbour (see `applyAdaptation`).
       */
      afterIndex: z.number(),
      text: z.string(),
      timerSec: z.number().nullable(),
      timerMaxSec: z.number().nullable(),
    }),
  ),
});

export type RecipeAdaptation = z.infer<typeof recipeAdaptationSchema>;

export type AdaptRecipeResult =
  | {
      readonly ok: true;
      readonly value: RecipeAdaptation;
      readonly usage: AiUsage | null;
      readonly costUsd: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      /**
       * One reason, not the import's two: there is no photo here to be
       * unreadable, and every failure of this call has the same honest
       * answer — «сейчас не получается, попробуй ещё раз», with the recipe
       * still on screen exactly as it was.
       */
      readonly reason: "aiUnavailable";
      readonly usage: AiUsage | null;
      readonly costUsd: number;
    };

/** The household's kitchen, as the prompt describes it. */
export interface AdaptProfile {
  /** `kitchen_profiles.equipment` verbatim — slugs and free text side by side. */
  readonly equipment: readonly string[];
  /** «в доме N человек», or `null` when no profile was ever saved. */
  readonly householdSize: number | null;
}

export interface AdaptRecipeArgs {
  readonly client: AiChatClient;
  /**
   * The recipe as it will be edited — **already rescaled** when the portion
   * count changed (see `applyAdaptation`). The model is shown the arithmetic
   * rather than asked to do it: multiplying twenty numbers is the one part of
   * this job a language model is measurably worse at than a `*` operator, and
   * every wrong product would be a wrong shopping quantity two screens later.
   */
  readonly draft: RecipeDraft;
  readonly profile: AdaptProfile;
  /** What the recipe needs and the profile does not cover (task 4.5). */
  readonly missing: readonly EquipmentSlug[];
  /** The count `draft` was rescaled to, or `null` when nothing was rescaled. */
  readonly targetPortions: number | null;
  /** The recipe's own stated yield, before any rescale — prompt context only. */
  readonly basePortions: number;
  readonly options?: AiRequestOptions;
}

/**
 * A ceiling, not a target. A proposal is a handful of edited rows, not a
 * recipe: anything past this is a model that started rewriting the whole
 * thing, and the honest answer is a retry rather than truncated JSON.
 */
const MAX_OUTPUT_TOKENS = 4_000;

/** Longest a single prompt line may run before it stops being a line. */
const MAX_PROMPT_LINE = 300;
/** How many free-form profile entries are worth listing. */
const MAX_PROFILE_ENTRIES = 20;

/**
 * The adaptation rules, in Russian because the recipes are (VISION §6.4).
 *
 * Every line is a failure this design expects:
 *
 * - **«присылай только то, что меняешь»** — the whole index-addressed
 *   contract. A model that echoes unchanged rows makes every diff meaningless
 *   and every «Применить» a full rewrite.
 * - **«не выдумывай количества»** — the same rule the parser has, for the
 *   same reason: `null` becomes the amber «уточнить» chip, a guessed number
 *   looks exactly like a read one.
 * - **«количества уже пересчитаны»** — the arithmetic is done; what is left
 *   is the part arithmetic cannot do (half an egg, a tray that no longer
 *   fits, a bake time that does not halve with the batch).
 * - **«не переименовывай»** — `name` is not in the response schema at all,
 *   and this says why out loud so the model does not try to smuggle a rename
 *   through `note`.
 * - **«используй только технику из списка «есть»»** — an adaptation that
 *   swaps a mixer for a food processor the household also lacks has solved
 *   nothing.
 */
const SYSTEM_PROMPT = [
  "Ты адаптируешь кулинарный рецепт под конкретную кухню и возвращаешь строго структурированные ПРАВКИ.",
  "",
  "Правила:",
  "1. Присылай ТОЛЬКО то, что меняешь. Строку или шаг, который остаётся как есть, не присылай вообще.",
  "2. Правки адресуются индексами из списков ниже. Не меняй порядок и не присылай рецепт целиком.",
  "3. НЕ ВЫДУМЫВАЙ количества. Если количество неизвестно — qty=null. Пустое поле честнее выдуманного числа.",
  "4. Количества УЖЕ пересчитаны на нужное число порций. Меняй их только там, где линейный пересчёт бессмыслен:",
  "   целые яйца, «1 форма», «1 упаковка», «1 щепотка».",
  "5. Название ингредиента менять нельзя — его нет в ответе. Меняются только qty, unit, note, rawText.",
  `6. unit — единица из списка: ${RECIPE_UNITS.join(", ")}. Другое слово («зубчик», «по вкусу») клади в note, а unit=null.`,
  "7. rawText — строка ингредиента, переписанная под новое количество, или null, чтобы оставить исходную.",
  "8. Замени технику, которой на кухне нет, на то, что есть. Используй ТОЛЬКО технику из списка «есть на кухне»",
  "   или ручной способ («венчиком вручную», «руками»). Не предлагай технику, которой у человека нет.",
  "9. steps — замена текста существующего шага по его индексу. removedStepIndexes — шаги, которые стали не нужны.",
  "   addedSteps — новые шаги; afterIndex — индекс исходного шага, ПОСЛЕ которого вставить (-1 = в самое начало).",
  "10. timerSec / timerMaxSec — в СЕКУНДАХ. «выпекать 9–11 минут» → timerSec=540, timerMaxSec=660.",
  "    Если способ изменился и время меняется — обнови его. Если времени в шаге нет — null.",
  "11. summary — ОДНА короткая фраза по-русски о том, что изменилось: «переделано под духовку вместо аэрогриля»,",
  "    «взбиваем венчиком вручную, пересчитано на 4 порции».",
  "12. Если менять нечего — верни пустые массивы и summary «Ничего менять не нужно».",
].join("\n");

/**
 * The recipe as the model sees it: numbered lines, nothing else.
 *
 * Exported and pure so the indexes the prompt hands out are the same indexes
 * `applyAdaptation` resolves against — a test pins that pairing, because a
 * prompt that numbered from 1 while the code indexed from 0 would produce a
 * proposal that is off by one on every single row and still validates.
 */
export function describeDraftForModel(args: {
  draft: RecipeDraft;
  profile: AdaptProfile;
  missing: readonly EquipmentSlug[];
  targetPortions: number | null;
  basePortions: number;
}): string {
  const { draft, profile, missing, targetPortions, basePortions } = args;

  const lines: string[] = [`Блюдо: ${cap(draft.title)}`];

  if (targetPortions === null) {
    lines.push(`Порций: ${basePortions} (количества указаны для них).`);
  } else {
    lines.push(
      `Порций: ${targetPortions}. Количества ниже УЖЕ пересчитаны с ${basePortions} на ${targetPortions}.`,
    );
  }

  if (profile.householdSize !== null) {
    lines.push(`В доме человек: ${profile.householdSize}.`);
  }

  const have = profileWords(profile.equipment);
  lines.push(
    have.length === 0
      ? "Есть на кухне: ничего из техники не указано — предлагай ручные способы."
      : `Есть на кухне: ${have.join(", ")}.`,
  );

  if (missing.length > 0) {
    lines.push(
      `НЕТ на кухне (от этого нужно уйти): ${missing
        .map((slug) => EQUIPMENT_WORD[slug])
        .join(", ")}.`,
    );
  }

  lines.push("", "Ингредиенты (индекс. строка источника | текущее количество):");
  if (draft.ingredients.length === 0) {
    lines.push("(нет)");
  }
  draft.ingredients.forEach((row, index) => {
    const amount =
      row.qty === null
        ? "количество не указано"
        : `${row.qty}${row.unit === null ? "" : ` ${row.unit}`}`;
    const note = row.note === null ? "" : ` (${row.note})`;
    const source = row.rawText.length === 0 ? row.name : row.rawText;

    lines.push(`${index}. ${cap(source)}${note} | ${amount}`);
  });

  lines.push("", "Шаги (индекс. текст):");
  if (draft.steps.length === 0) {
    lines.push("(нет)");
  }
  draft.steps.forEach((step, index) => {
    const timer =
      step.timerSec === null
        ? ""
        : ` [таймер ${step.timerSec}${
            step.timerMaxSec === null ? "" : `–${step.timerMaxSec}`
          } с]`;

    lines.push(`${index}. ${cap(step.text)}${timer}`);
  });

  return lines.join("\n");
}

/**
 * Proposes an adaptation. **Never throws** — mirrors `parseRecipe` exactly.
 *
 * Every failure comes back as `ok: false` with the usage that was nonetheless
 * billed: a response that arrived and then failed validation was paid for,
 * and a ledger that counts only successes under-reports precisely when things
 * go wrong (AGENTS.md).
 */
export async function adaptRecipe({
  client,
  draft,
  profile,
  missing,
  targetPortions,
  basePortions,
  options,
}: AdaptRecipeArgs): Promise<AdaptRecipeResult> {
  let usage: AiUsage | null = null;

  try {
    const completion = await client.chat.completions.create(
      {
        model: AI_MODEL,
        // AGENTS.md mandates low effort for parsing and normalization;
        // decision D25 keeps adaptation — the phase's one non-parsing call —
        // on the same setting so the whole phase costs what it says it does.
        // Escalating to "medium" is a deliberate future decision that needs
        // the user's sign-off (recorded in the wiki, not taken here).
        reasoning_effort: "low",
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "recipe_adaptation",
            strict: true,
            schema: toStrictJsonSchema(recipeAdaptationSchema),
          },
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: describeDraftForModel({
              draft,
              profile,
              missing,
              targetPortions,
              basePortions,
            }),
          },
        ],
      },
      options,
    );

    usage = usageFrom(completion.usage);

    const choice = completion.choices[0];
    if (!choice) {
      return failure("Model returned no choices", usage);
    }

    if (choice.finish_reason === "length") {
      // Truncated JSON is unparseable no matter what it contains.
      return failure("Model output hit the token ceiling", usage);
    }

    if (choice.message.refusal) {
      return failure(`Model refused: ${choice.message.refusal}`, usage);
    }

    const content = choice.message.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      return failure("Model returned empty content", usage);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      return failure("Model returned malformed JSON", usage);
    }

    const parsed = recipeAdaptationSchema.safeParse(raw);
    if (!parsed.success) {
      return failure(
        `Model output failed validation: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("; ")}`,
        usage,
      );
    }

    return {
      ok: true,
      value: parsed.data,
      usage,
      costUsd: usage === null ? 0 : computeCostUsd(usage),
    };
  } catch (error) {
    // The request itself failed — network, timeout, abort, 4xx, 5xx. Nothing
    // was billed, so `usage` stays `null`.
    return failure(errorMessage(error), usage);
  }
}

/**
 * The household's own equipment, as words the model can reason about.
 *
 * Preset slugs become their Russian noun (`EQUIPMENT_WORD`); a free-form
 * entry — «мультиварка» typed before the checklist existed, «кухонные весы»
 * that never had a box — is passed through verbatim, because it is still a
 * true statement about the kitchen and the point of this line is to tell the
 * model what it may use.
 */
function profileWords(equipment: readonly string[]): string[] {
  const seen = new Set<string>();
  const words: string[] = [];

  for (const entry of equipment.slice(0, MAX_PROFILE_ENTRIES)) {
    const slug = (EQUIPMENT_WORD as Record<string, string | undefined>)[entry];
    const word = (slug ?? entry).trim();
    const key = word.toLowerCase();

    if (word.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    words.push(word);
  }

  return words;
}

/** One line of prompt, never a whole pasted document. */
function cap(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > MAX_PROMPT_LINE
    ? `${trimmed.slice(0, MAX_PROMPT_LINE)}…`
    : trimmed;
}

function failure(error: string, usage: AiUsage | null): AdaptRecipeResult {
  return {
    ok: false,
    error,
    reason: "aiUnavailable",
    usage,
    costUsd: usage === null ? 0 : computeCostUsd(usage),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

import type OpenAI from "openai";
import { z } from "zod";

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

/**
 * The recipe a model returns, and the only shape any import branch produces
 * (blueprint §2.2, decision D7).
 *
 * **Primitives only.** No `z.enum`, no `z.uuid()`, no unions, and no
 * `.min()`/`.max()`/`.trim()` at any depth — `z.toJSONSchema` emits
 * `minLength`/`maxLength`/`minimum`/`maximum`/`format`/`pattern` for those,
 * and OpenAI's strict mode rejects every one of them with a 400 on the *first
 * real call*, not at build time. `enrichedProductSchema` never exercised
 * nesting, arrays of objects or nullables, so this is untested ground in this
 * repo; the colocated `parse-recipe.schema.test.ts` walks the emitted
 * document at every depth and is what stops a later tidy-up `.max(200)` from
 * breaking every import in production.
 *
 * Bounds are not lost, only moved: `recipeDraftSchema`
 * (`src/lib/recipes/draft.ts`) applies all of them on the way into a draft,
 * where an out-of-range value can be turned into `null` + «уточнить» for that
 * one row instead of failing the whole recipe.
 *
 * `.nullable()` and never `.optional()` (AGENTS.md): strict mode requires
 * every property to be `required`, so an optional property is simply not
 * expressible.
 */
export const parsedRecipeSchema = z.object({
  /**
   * The model's own escape hatch. A photo of a cat comes back `false`, and
   * S8.2 shows the honest «это не рецепт» copy instead of a hallucinated
   * recipe — which is exactly what a vision model produces when handed a
   * non-recipe. Inferring failure from an empty ingredient list does not
   * catch that; a boolean does (decision D6).
   */
  isRecipe: z.boolean(),
  title: z.string(),
  /**
   * The portion count the quantities below are stated for, and the **upper**
   * end of a stated range («7–8 печений» → 8). Upper, not lower: a source
   * that says «7–8» weighed its flour for the batch it actually makes.
   */
  portionsBase: z.number().nullable(),
  /** The lower end of a stated range, else null. Display only. */
  portionsMin: z.number().nullable(),
  /** The source's own yield noun — «печений», «шт». `null` means «порции». */
  yieldUnit: z.string().nullable(),
  totalTimeMin: z.number().nullable(),
  /** Free Russian words: «духовка», «миксер». Coerced to slugs server-side. */
  equipment: z.array(z.string()),
  tags: z.array(z.string()),
  ingredients: z.array(
    z.object({
      /** The source line, verbatim — the honesty anchor VISION §6.4 asks for. */
      rawText: z.string(),
      /** The buyable noun ONLY: «Шоколад» out of «Шоколад крупными кусками». */
      name: z.string(),
      qty: z.number().nullable(),
      /**
       * Free Russian text, **not** `z.enum(RECIPE_UNITS)`. An enum forces the
       * model to bucket «зубчик» into the nearest listed unit and emit a
       * confidently wrong quantity — the exact honesty failure VISION §6.4
       * forbids. `coerceRecipeUnit` maps what it can and routes the rest into
       * `note`, where it survives as words instead of as a wrong number.
       */
      unit: z.string().nullable(),
      /** «холодное», «по вкусу», «зубчик». */
      note: z.string().nullable(),
      isOptional: z.boolean(),
    }),
  ),
  steps: z.array(
    z.object({
      text: z.string(),
      /** Countdown length in seconds — the LOWER bound of a stated range. */
      timerSec: z.number().nullable(),
      /** Upper bound, so «9–11 мин» is two numbers and one ICU message. */
      timerMaxSec: z.number().nullable(),
    }),
  ),
});

export type ParsedRecipe = z.infer<typeof parsedRecipeSchema>;

/**
 * How the recipe reached us. One prompt family, one mode line — a fix to
 * ingredient parsing has to fix photo, page and pasted text at once, or the
 * three drift and only one of them stays good.
 *
 * `skeleton` and `text` are task 4.4's; they are declared here so 4.4 fills a
 * branch rather than forking the prompt.
 */
export type ParseRecipeInput =
  | { readonly kind: "photo"; readonly imageUrl: string }
  | { readonly kind: "text"; readonly text: string }
  /** A free JSON-LD/microdata extraction, handed over to be corrected. */
  | { readonly kind: "skeleton"; readonly hint: string };

export type ParseRecipeResult =
  | {
      readonly ok: true;
      readonly value: ParsedRecipe;
      readonly usage: AiUsage | null;
      readonly costUsd: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      /**
       * Which S8.2 copy this maps to. `aiUnavailable` means "try again";
       * `photoUnreadable` means "this image will not work, here is the fork".
       */
      readonly reason: "aiUnavailable" | "photoUnreadable";
      readonly usage: AiUsage | null;
      readonly costUsd: number;
    };

export interface ParseRecipeArgs {
  readonly client: AiChatClient;
  readonly input: ParseRecipeInput;
  /** Per-request timeout / retries / abort signal; see `AiRequestOptions`. */
  readonly options?: AiRequestOptions;
}

/**
 * A ceiling, not a target. A sixty-ingredient recipe with long steps is a few
 * thousand output tokens; anything past this is a model that has started
 * repeating itself, and the honest answer is a retry rather than a truncated
 * JSON document that fails to parse.
 */
const MAX_OUTPUT_TOKENS = 8_000;

/**
 * The parsing rules, in Russian because the recipes are (VISION §6.4).
 *
 * Every line is a failure this design expects:
 *
 * - **«не выдумывай количества»** — the single most damaging thing a vision
 *   model does. A missing number must come back as `null`, which becomes the
 *   amber «уточнить» chip; a guessed one looks exactly like a read one.
 * - **«name — только покупаемое существительное»** — the split that makes a
 *   free deterministic catalog matcher possible at all: «Шоколад крупными
 *   кусками — 150 г» has to arrive as `name: "Шоколад"`, because *that* is
 *   what a string ranker can look up. Two worked examples, because this is
 *   the field the whole binding path depends on (blueprint R3).
 * - **«rawText — строка ровно как в источнике»** — the honesty anchor S8.3's
 *   «ИИ мог ошибиться» is checked against.
 * - **the portions rule** — a stated range means the quantities belong to the
 *   *upper* bound: a source that says «7–8» weighed its flour for the batch it
 *   actually makes (decision A.1).
 * - **`isRecipe`** — one boolean is what turns a photo of a cat into honest
 *   copy instead of a fluent hallucination (decision D6).
 */
const SYSTEM_PROMPT = [
  "Ты разбираешь кулинарные рецепты и возвращаешь строго структурированные данные.",
  "",
  "Правила:",
  "1. Если на входе не рецепт (фото кота, чек, скриншот переписки) — верни isRecipe=false и пустые массивы. Ничего не выдумывай.",
  "2. НЕ ВЫДУМЫВАЙ количества. Если количество не указано — qty=null и unit=null. Пустое поле честнее выдуманного числа.",
  "3. rawText — строка ингредиента ровно как в источнике, со всеми словами и знаками.",
  "4. name — ТОЛЬКО покупаемое существительное, без количества, без единиц, без уточнений.",
  "   «Шоколад крупными кусками — 150 г» → name «Шоколад», note «крупными кусками».",
  "   «Масло сливочное холодное, 227 г» → name «Масло сливочное», note «холодное».",
  "5. Всё, что не влезло в name, клади в note: «холодное», «по вкусу», «зубчик», «комнатной температуры».",
  "6. unit — единица так, как она написана в источнике («г», «ч.л.», «зубчик», «стакан»). Не подгоняй под список.",
  `   Приложение понимает: ${RECIPE_UNITS.join(", ")} — остальное вернётся в note, это нормально.`,
  "7. isOptional=true только если источник прямо говорит «по желанию» / «опционально».",
  "8. Выход: portionsBase — число порций, для которого указаны количества.",
  "   Если выход указан диапазоном («7–8 штук») — portionsBase=8 (верхняя граница), portionsMin=7.",
  "   Если выход указан одним числом — portionsBase это число, portionsMin=null.",
  "   yieldUnit — слово источника («печений», «шт», «порции»), если оно есть; иначе null.",
  "9. totalTimeMin — общее время в минутах, если указано; иначе null.",
  "10. equipment — техника, которая нужна, отдельными словами: «духовка», «миксер», «блендер». Пустой массив, если не упомянута.",
  "11. tags — 1–4 коротких тега по-русски: «десерт», «ужин», «быстро», «выпечка».",
  "12. steps — шаги по порядку. timerSec — длительность в СЕКУНДАХ, если в шаге назван отрезок времени.",
  "    «выпекать 9–11 минут» → timerSec=540, timerMaxSec=660. Одно число — timerSec, timerMaxSec=null.",
  "13. title — название блюда. Если в источнике его нет, назови блюдо коротко по главному ингредиенту.",
].join("\n");

/** The mode line that turns one prompt into three. */
function userMessage(input: ParseRecipeInput): string {
  switch (input.kind) {
    case "photo":
      return "Режим: фото. На изображении — рецепт (чаще всего скриншот). Прочитай его и разбери по правилам. Внимательно читай цифры количеств.";
    case "text":
      return `Режим: текст. Разбери этот рецепт по правилам.\n\n${input.text}`;
    case "skeleton":
      return `Режим: черновик. Ниже — то, что удалось вытащить со страницы автоматически. Исправь и дополни по правилам, ничего не придумывая сверх текста.\n\n${input.hint}`;
  }
}

/**
 * Parses a recipe. **Never throws** — mirrors `enrichProduct` exactly.
 *
 * Every failure comes back as `ok: false` with the usage that was
 * nonetheless billed: a response that arrived and then failed validation was
 * paid for, and a ledger that counts only successes under-reports precisely
 * when things go wrong (AGENTS.md).
 */
export async function parseRecipe({
  client,
  input,
  options,
}: ParseRecipeArgs): Promise<ParseRecipeResult> {
  let usage: AiUsage | null = null;

  try {
    const completion = await client.chat.completions.create(
      {
        model: AI_MODEL,
        // AGENTS.md: cheap model + low effort for parsing. Invisible
        // reasoning tokens are billed as output and would multiply a
        // sub-cent call several times over (decision D25).
        reasoning_effort: "low",
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "parsed_recipe",
            strict: true,
            schema: toStrictJsonSchema(parsedRecipeSchema),
          },
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent(input) },
        ],
      },
      options,
    );

    usage = usageFrom(completion.usage);

    const choice = completion.choices[0];
    if (!choice) {
      return failure("Model returned no choices", "aiUnavailable", usage);
    }

    if (choice.finish_reason === "length") {
      // Truncated JSON is unparseable no matter what it contains, and the
      // useful thing to offer is a retry — not «это фото не читается».
      return failure(
        "Model output hit the token ceiling",
        "aiUnavailable",
        usage,
      );
    }

    if (choice.message.refusal) {
      return failure(
        `Model refused: ${choice.message.refusal}`,
        "photoUnreadable",
        usage,
      );
    }

    const content = choice.message.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      return failure("Model returned empty content", "aiUnavailable", usage);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      return failure("Model returned malformed JSON", "photoUnreadable", usage);
    }

    const parsed = parsedRecipeSchema.safeParse(raw);
    if (!parsed.success) {
      return failure(
        `Model output failed validation: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("; ")}`,
        "photoUnreadable",
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
    // The request itself failed — network, timeout, abort, 5xx, auth. Nothing
    // was billed, so `usage` stays as it was: `null`.
    return failure(errorMessage(error), "aiUnavailable", usage);
  }
}

/**
 * The user turn. A photo goes as two parts — the instruction and the image —
 * with `detail: "high"`.
 *
 * **`"high"` is load-bearing, not a default.** The entire feature is reading
 * small digits off a screenshot; `"low"` downsamples to 512 px, and «285 г»
 * misread as «235 г» is precisely the failure the review screen cannot catch,
 * because both look equally plausible. ~1.1–1.5k image tokens at gpt-5-mini
 * keeps the call inside VISION §6.5's $0.005–0.01.
 */
function userContent(
  input: ParseRecipeInput,
): OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"] {
  const text = userMessage(input);

  if (input.kind !== "photo") {
    return text;
  }

  return [
    { type: "text", text },
    { type: "image_url", image_url: { url: input.imageUrl, detail: "high" } },
  ];
}

function failure(
  error: string,
  reason: "aiUnavailable" | "photoUnreadable",
  usage: AiUsage | null,
): ParseRecipeResult {
  return {
    ok: false,
    error,
    reason,
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

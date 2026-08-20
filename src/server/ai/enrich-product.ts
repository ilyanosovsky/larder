import { z } from "zod";

import { unitSchema, UNITS, type Unit } from "@/lib/units";
import { toStrictJsonSchema, type AiChatClient } from "@/server/ai/openai";
import {
  AI_MODEL,
  computeCostUsd,
  usageFrom,
  type AiUsage,
} from "@/server/ai/pricing";

/**
 * What the model must return for a product it has never seen (VISION §3.1:
 * «для нестандартного („буррата“) иконку и отдел подбирает ИИ»).
 *
 * `.nullable()` never `.optional()` (AGENTS.md): OpenAI strict mode cannot
 * express an optional property, so a field that might be absent has to be a
 * field that might be null. All three here are always required, so neither
 * applies — the rule matters for the next schema, not this one.
 */
export const enrichedProductSchema = z.object({
  /** A single emoji, e.g. "🧀". */
  icon: z.string(),
  /** One of the ids listed in the prompt — re-checked below, not trusted. */
  categoryId: z.string(),
  unit: unitSchema,
});

export type EnrichedProduct = {
  readonly icon: string;
  readonly categoryId: string;
  readonly unit: Unit;
};

export interface EnrichProductArgs {
  readonly client: AiChatClient;
  readonly name: string;
  readonly categories: readonly {
    readonly id: string;
    readonly name: string;
  }[];
}

/**
 * Every enrichment attempt, successful or not, carries the usage it was
 * billed for. `usage` is `null` only when the HTTP call itself never
 * completed — anything that came back was paid for, including a response we
 * then rejected as invalid.
 */
export type EnrichProductResult =
  | {
      readonly ok: true;
      readonly value: EnrichedProduct;
      readonly usage: AiUsage | null;
      readonly costUsd: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly usage: AiUsage | null;
      readonly costUsd: number;
    };

const MAX_ICON_CODE_POINTS = 4;

/**
 * Below this code point everything is plain text — Latin, Cyrillic,
 * punctuation, digits. Every pictograph, symbol and dingbat we would accept
 * as an icon sits above it. One comparison instead of a table of emoji
 * blocks, and instead of a `\p{Extended_Pictographic}` regex the ES2017
 * target cannot compile.
 */
const SYMBOL_RANGE_START = 0x2000;

/**
 * Whether a string is plausibly a single emoji.
 *
 * Deliberately a shape check, not an emoji database: it has to reject the
 * failure modes that actually happen (the model answering "сыр", or
 * "🧀 сыр", or a sentence) without maintaining a Unicode table that goes
 * stale every year. Up to four code points leaves room for a variation
 * selector, a skin-tone modifier or a short ZWJ sequence.
 */
export function isEmojiIcon(icon: string): boolean {
  const codePoints = [...icon];
  if (codePoints.length === 0 || codePoints.length > MAX_ICON_CODE_POINTS) {
    return false;
  }

  let hasSymbol = false;
  for (const character of codePoints) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      return false;
    }
    // ASCII (letters, digits, punctuation, spaces) and any whitespace at all
    // mean this is text, not an icon.
    if (codePoint < 0x80 || /\s/.test(character)) {
      return false;
    }
    if (codePoint >= SYMBOL_RANGE_START) {
      hasSymbol = true;
    }
  }

  return hasSymbol;
}

const SYSTEM_PROMPT = [
  "Ты помогаешь вести каталог продуктов для семейного списка покупок.",
  "По названию продукта верни: иконку-эмодзи, id отдела магазина из списка и",
  "единицу измерения по умолчанию.",
  "Иконка — ровно один эмодзи, максимально близкий к продукту.",
  "categoryId — строго один из перечисленных id, ничего другого.",
  `unit — строго одно из: ${UNITS.join(", ")}.`,
].join(" ");

/**
 * Picks an icon, a department and a default unit for a product nobody in the
 * reference catalog has heard of.
 *
 * **This function never throws.** Every failure — a network error, a refusal,
 * malformed JSON, a hallucinated department — comes back as `ok: false` with
 * the usage that was nonetheless billed, because the caller's job is to
 * create the product anyway with sensible defaults (VISION: ИИ — помощник,
 * всё редактируемо) and record the failed job. An exception here would turn a
 * cosmetic miss into a failed «Создать».
 */
export async function enrichProduct({
  client,
  name,
  categories,
}: EnrichProductArgs): Promise<EnrichProductResult> {
  if (categories.length === 0) {
    return failure("No categories to choose from", null);
  }

  const departments = categories
    .map((category) => `${category.id} — ${category.name}`)
    .join("\n");

  let usage: AiUsage | null = null;

  try {
    const completion = await client.chat.completions.create({
      model: AI_MODEL,
      // Cheap model + low effort for parsing/normalization (VISION §6.5):
      // invisible reasoning tokens are billed as output and would multiply
      // the cost of a sub-cent call several times over.
      reasoning_effort: "low",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "enriched_product",
          strict: true,
          schema: toStrictJsonSchema(enrichedProductSchema),
        },
      },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Продукт: ${name}\n\nОтделы:\n${departments}`,
        },
      ],
    });

    usage = usageFrom(completion.usage);

    const choice = completion.choices[0];
    if (!choice) {
      return failure("Model returned no choices", usage);
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

    const parsed = enrichedProductSchema.safeParse(raw);
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

    // Checked after parsing, against the ids we actually sent: strict mode
    // constrains the *shape* of `categoryId`, never its value, so a model
    // that invents a plausible-looking uuid would otherwise get a product
    // filed into another household's department — or into nothing at all.
    const known = new Set(categories.map((category) => category.id));
    if (!known.has(parsed.data.categoryId)) {
      return failure(
        `Model returned an unknown categoryId: ${parsed.data.categoryId}`,
        usage,
      );
    }

    if (!isEmojiIcon(parsed.data.icon)) {
      return failure(
        `Model returned a non-emoji icon: ${parsed.data.icon}`,
        usage,
      );
    }

    return {
      ok: true,
      value: {
        icon: parsed.data.icon,
        categoryId: parsed.data.categoryId,
        unit: parsed.data.unit,
      },
      usage,
      costUsd: computeCostUsd(usage),
    };
  } catch (error) {
    // The request itself failed (network, timeout, 5xx, auth): nothing was
    // billed, so whatever usage we had stays as it is — `null`.
    return failure(errorMessage(error), usage);
  }
}

function failure(error: string, usage: AiUsage | null): EnrichProductResult {
  return {
    ok: false,
    error,
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

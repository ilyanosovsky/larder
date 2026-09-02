import { z } from "zod";

import { unitSchema, UNITS } from "@/lib/units";
import { isEmojiIcon, type EnrichedProduct } from "@/server/ai/enrich-product";
import { toStrictJsonSchema, type AiChatClient } from "@/server/ai/openai";
import {
  AI_MODEL,
  computeCostUsd,
  usageFrom,
  type AiUsage,
} from "@/server/ai/pricing";
import { normalizeProductName } from "@/server/catalog/normalize";

/**
 * The batched sibling of `enrich-product.ts`: icons, departments and default
 * units for **every** unfamiliar ingredient of one recipe, in a single call
 * (blueprint §3.7, decision D13).
 *
 * Why batched rather than one call per name: a recipe save can carry ten
 * unmatched ingredients, and ten sequential enrichments would burn the
 * function's `maxDuration` and ten rate-limit slots on a single tap of
 * «Сохранить блюдо» — for a cosmetic result. One call is ~$0.001 and one
 * `ai_jobs` row, which is also what makes the ledger readable: one save, one
 * entry.
 *
 * Why not skip enrichment entirely: after twenty imports the catalog — the
 * app's main surface — would be two hundred identical grey 🛒 rows filed
 * under one department.
 *
 * **This function never throws.** Every failure comes back as a result with
 * `null`s in `values`, plus the usage that was nonetheless billed. The caller
 * creates the products anyway with its own fallbacks: someone who has just
 * spent a minute reviewing a recipe wants it saved, not an apology, and a
 * wrong emoji is one tap (VISION §3.1: всё редактируемо).
 */

/**
 * What the model must answer for the whole batch.
 *
 * Primitives and one enum only — no `.min()`, no `.max()`, no `.optional()`.
 * OpenAI strict mode rejects `minLength`/`maxLength`/`format`, and
 * `z.toJSONSchema` emits those for Zod's own bounds; the shape is validated
 * again here in TypeScript anyway, where a bad value can be rejected *per
 * name* instead of failing the whole response.
 *
 * `name` is echoed back so the answers can be paired to the questions by
 * value rather than by array position — a model that returns nine items for
 * ten names would otherwise shift every later product onto the wrong
 * ingredient.
 */
export const enrichedProductsSchema = z.object({
  items: z.array(
    z.object({
      /** The requested product name, echoed verbatim. */
      name: z.string(),
      /** A single emoji, e.g. "🧀". */
      icon: z.string(),
      /** One of the ids listed in the prompt — re-checked below, not trusted. */
      categoryId: z.string(),
      unit: unitSchema,
    }),
  ),
});

/**
 * How many names one call may carry. A recipe may hold up to sixty
 * ingredients; past this many unfamiliar ones the answer stops being reliable
 * long before it stops being affordable, and the rest fall back — which is a
 * default icon on a product that exists, not a lost recipe.
 */
export const MAX_ENRICH_NAMES = 20;

export interface EnrichProductsArgs {
  readonly client: AiChatClient;
  /** Names to enrich, in the caller's own order. */
  readonly names: readonly string[];
  /** Only the ids and names go into the prompt — `enrichProduct`'s shape. */
  readonly categories: readonly {
    readonly id: string;
    readonly name: string;
  }[];
}

export interface EnrichProductsResult {
  /**
   * **1:1 with `names`, in the same order.** `null` where the model returned
   * nothing usable for that name — an unknown `categoryId`, an icon that is
   * not an emoji, a name it simply skipped, or a call that failed outright.
   *
   * The fallback itself (🛒 / первый отдел / шт) is applied by the caller, not
   * here: the router is what actually mints products and already owns those
   * constants for `product.create`, and duplicating them would give one
   * feature two answers to "what does an un-enriched product look like".
   */
  readonly values: readonly (EnrichedProduct | null)[];
  /** Why the call did not fully succeed; `null` when everything came back. */
  readonly error: string | null;
  readonly usage: AiUsage | null;
  readonly costUsd: number;
}

const SYSTEM_PROMPT = [
  "Ты помогаешь вести каталог продуктов для семейного списка покупок.",
  "Для каждого продукта из списка верни: его название без изменений,",
  "иконку-эмодзи, id отдела магазина из списка и единицу измерения.",
  "Иконка — ровно один эмодзи, максимально близкий к продукту.",
  "categoryId — строго один из перечисленных id, ничего другого.",
  `unit — строго одно из: ${UNITS.join(", ")}.`,
  "Верни ровно по одному объекту на каждый продукт, в том же порядке.",
].join(" ");

export async function enrichProducts({
  client,
  names,
  categories,
}: EnrichProductsArgs): Promise<EnrichProductsResult> {
  const empty = names.map(() => null);

  if (names.length === 0) {
    return { values: [], error: null, usage: null, costUsd: 0 };
  }
  if (categories.length === 0) {
    // Impossible in practice — `household.create` seeds seven departments in
    // the same transaction that creates the membership — but a department is
    // the one thing a product cannot be created without, so it is refused
    // here rather than half-answered.
    return failure("No categories to choose from", empty, null);
  }

  // A blank name is never sent: it would cost a line of prompt and could only
  // come back as an answer nothing can be paired to. The stricter judgement —
  // «—» and «(см. шаг 3)» are bad parses, not ingredients — belongs to the
  // caller (`isUsableProductName`), which also has to decide whether to create
  // a product at all; this is only the gate that keeps the prompt honest.
  const asked = names
    .filter((name) => normalizeProductName(name).length > 0)
    .slice(0, MAX_ENRICH_NAMES);

  if (asked.length === 0) {
    return { values: empty, error: null, usage: null, costUsd: 0 };
  }

  const departments = categories
    .map((category) => `${category.id} — ${category.name}`)
    .join("\n");

  let usage: AiUsage | null = null;

  try {
    const completion = await client.chat.completions.create({
      model: AI_MODEL,
      // Cheap model + low effort for normalization (AGENTS.md): invisible
      // reasoning tokens are billed as output and would multiply the cost of
      // a sub-cent call several times over.
      reasoning_effort: "low",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "enriched_products",
          strict: true,
          schema: toStrictJsonSchema(enrichedProductsSchema),
        },
      },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Продукты:\n${asked.join("\n")}\n\nОтделы:\n${departments}`,
        },
      ],
    });

    usage = usageFrom(completion.usage);

    const choice = completion.choices[0];
    if (!choice) {
      return failure("Model returned no choices", empty, usage);
    }
    if (choice.message.refusal) {
      return failure(`Model refused: ${choice.message.refusal}`, empty, usage);
    }

    const content = choice.message.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      return failure("Model returned empty content", empty, usage);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      return failure("Model returned malformed JSON", empty, usage);
    }

    const parsed = enrichedProductsSchema.safeParse(raw);
    if (!parsed.success) {
      return failure(
        `Model output failed validation: ${parsed.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("; ")}`,
        empty,
        usage,
      );
    }

    // Validated **per name**, never per response: one hallucinated department
    // among ten answers must cost that one product its icon, not the other
    // nine theirs. Strict mode constrains the *shape* of `categoryId`, never
    // its value, so a plausible-looking uuid would otherwise file a product
    // into another household's department — the foreign key would allow it.
    const known = new Set(categories.map((category) => category.id));
    const byName = new Map<string, EnrichedProduct>();
    let rejected = 0;

    for (const item of parsed.data.items) {
      if (!known.has(item.categoryId) || !isEmojiIcon(item.icon)) {
        rejected += 1;
        continue;
      }
      const key = normalizeProductName(item.name);
      if (key.length === 0 || byName.has(key)) {
        continue;
      }
      byName.set(key, {
        icon: item.icon,
        categoryId: item.categoryId,
        unit: item.unit,
      });
    }

    // Only the names that were actually sent may take a value. Past the cap
    // (or for a name with no text) the model was never asked, so an item it
    // volunteered anyway must not slip past the caller's fallback — that is
    // the whole meaning of the cap.
    const askedKeys = new Set(asked.map((name) => normalizeProductName(name)));
    const values = names.map((name) => {
      const key = normalizeProductName(name);
      return askedKeys.has(key) ? (byName.get(key) ?? null) : null;
    });

    const answered = [...askedKeys].filter((key) => byName.has(key)).length;

    return {
      values,
      // Measured against what was **asked**, not against `names`: a name held
      // back by the cap is a decision of ours, not a failure of the model's.
      error:
        answered === askedKeys.size
          ? null
          : `Model answered ${answered}/${askedKeys.size} names (${rejected} rejected)`,
      usage,
      costUsd: usage === null ? 0 : computeCostUsd(usage),
    };
  } catch (error) {
    // The request itself failed (network, timeout, 5xx, auth): nothing was
    // billed, so whatever usage we had stays as it is — `null`.
    return failure(errorMessage(error), empty, usage);
  }
}

function failure(
  error: string,
  values: readonly (EnrichedProduct | null)[],
  usage: AiUsage | null,
): EnrichProductsResult {
  return {
    values,
    error,
    usage,
    // Recorded on the failure branch too: a response that came back and then
    // failed validation was still billed, and a ledger that only counts
    // successes under-reports exactly when things go wrong (AGENTS.md).
    costUsd: usage === null ? 0 : computeCostUsd(usage),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

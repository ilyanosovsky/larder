import { describe, expect, it } from "vitest";

import { recipeAdaptationSchema } from "@/server/ai/adapt-recipe";
import { toStrictJsonSchema } from "@/server/ai/openai";

/**
 * The shape gate for task 4.6's structured output — the same discipline
 * `parse-recipe.schema.test.ts` established, and written before the
 * adaptation prompt for the same reason.
 *
 * OpenAI's strict mode rejects a JSON Schema carrying validation keywords
 * (`minimum`, `maximum`, `multipleOf`, `minLength`, …), and `z.toJSONSchema`
 * emits exactly those for Zod's own bounds. The rejection is a 400 on the
 * first real call, so nothing before production would catch a `z.int()` or a
 * `.max(300)` added later "for safety" — and this schema is *especially*
 * tempting to bound, because every one of its numbers is an array index.
 *
 * The bounds are not lost, only moved: `applyAdaptation`
 * (`src/server/recipes/adapt.ts`) drops an index that names nothing, clamps
 * nothing, and re-validates the result against `recipeDraftSchema`, where an
 * out-of-range value degrades one row instead of failing the whole proposal.
 */

type JsonObject = Record<string, unknown>;

const document = toStrictJsonSchema(recipeAdaptationSchema);

/** Every node of the emitted schema, depth-first, including the root. */
function walk(
  node: unknown,
  path = "(root)",
): { path: string; node: JsonObject }[] {
  if (node === null || typeof node !== "object") {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap((entry, index) => walk(entry, `${path}[${index}]`));
  }

  const self = { path, node: node as JsonObject };

  return [
    self,
    ...Object.entries(node as JsonObject).flatMap(([key, value]) =>
      walk(value, `${path}.${key}`),
    ),
  ];
}

const nodes = walk(document);

function typedNodes(type: string) {
  return nodes.filter(({ node }) => node.type === type);
}

describe("the strict JSON Schema for a recipe adaptation", () => {
  it("emits a schema at all, and drops $schema", () => {
    expect(document.type).toBe("object");
    expect(document.$schema).toBeUndefined();
  });

  it.each([
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "format",
    "pattern",
    "minItems",
    "maxItems",
    "multipleOf",
  ])("carries no %s at any depth", (keyword) => {
    const offenders = nodes
      .filter(({ node }) => Object.hasOwn(node, keyword))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("marks every object closed", () => {
    const open = typedNodes("object")
      .filter(({ node }) => node.additionalProperties !== false)
      .map(({ path }) => path);

    expect(open).toEqual([]);
  });

  it("requires every property of every object", () => {
    for (const { path, node } of typedNodes("object")) {
      const properties = Object.keys((node.properties ?? {}) as JsonObject);
      expect(
        [...((node.required ?? []) as string[])].sort(),
        `required mismatch at ${path}`,
      ).toEqual([...properties].sort());
    }
  });

  it("encodes .nullable() as anyOf [type, null] rather than a type array", () => {
    // zod 4's own encoding, pinned because it is what the model is told and
    // what `safeParse` will accept back.
    const properties = document.properties as JsonObject;
    const item = (properties.ingredients as JsonObject).items as JsonObject;
    const itemProperties = item.properties as JsonObject;

    expect(itemProperties.qty).toEqual({
      anyOf: [{ type: "number" }, { type: "null" }],
    });
    expect(itemProperties.rawText).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("keeps an index a plain number, never a bounded integer", () => {
    // `z.int()` emits `type: "integer"` *and* `minimum`/`maximum` for the
    // safe-integer range under zod 4 — a 400 from strict mode, for a bound
    // `applyAdaptation` enforces anyway by dropping what it cannot resolve.
    const properties = document.properties as JsonObject;
    const item = (properties.ingredients as JsonObject).items as JsonObject;

    expect((item.properties as JsonObject).index).toEqual({ type: "number" });
    expect(properties.removedStepIndexes).toEqual({
      type: "array",
      items: { type: "number" },
    });
  });

  it("describes the array members, not just the arrays", () => {
    const properties = document.properties as JsonObject;
    for (const key of [
      "ingredients",
      "steps",
      "removedStepIndexes",
      "addedSteps",
    ]) {
      const array = properties[key] as JsonObject;
      expect(array.type, key).toBe("array");
      expect(array.items, key).toBeTypeOf("object");
    }
  });

  it("never offers the model a name, a binding or an isOptional flag", () => {
    // The contract, machine-checked: an adaptation changes how much and how,
    // never *what* a recipe is made of. A `name` here would let a proposal
    // rewrite an ingredient the household has already bound to a catalog
    // product, and `applyAdaptation` would have no way to tell that apart
    // from a legitimate edit.
    const properties = document.properties as JsonObject;
    const item = (properties.ingredients as JsonObject).items as JsonObject;
    const fields = Object.keys(item.properties as JsonObject).sort();

    expect(fields).toEqual(["index", "note", "qty", "rawText", "unit"]);
  });
});

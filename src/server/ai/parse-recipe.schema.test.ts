import { describe, expect, it } from "vitest";

import { toStrictJsonSchema } from "@/server/ai/openai";
import { parsedRecipeSchema } from "@/server/ai/parse-recipe";

/**
 * The shape gate for OpenAI structured outputs (decision D7).
 *
 * OpenAI's strict mode rejects a JSON Schema carrying validation keywords —
 * `minLength`, `maxLength`, `minimum`, `maximum`, `format`, `pattern` — and
 * `z.toJSONSchema` emits exactly those for Zod's own bounds. The rejection is
 * a 400 on the first real call, so nothing before production would catch a
 * `.max(200)` added later "for safety".
 *
 * These assertions walk the whole emitted document rather than spot-checking
 * the top level: `parsedRecipeSchema` is the first schema in this repo with
 * nested objects inside arrays, and a bound added three levels down is
 * precisely the one a reviewer would not see.
 *
 * This file is deliberately the first thing written for task 4.3 — before any
 * prompt work — so the schema could never grow a keyword that only fails
 * against the real API.
 */

type JsonObject = Record<string, unknown>;

const document = toStrictJsonSchema(parsedRecipeSchema);

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

/** Nodes that describe a type, as opposed to a `properties` bag or a list. */
function typedNodes(type: string) {
  return nodes.filter(({ node }) => node.type === type);
}

describe("the strict JSON Schema for a parsed recipe", () => {
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
    // Strict mode has no notion of an optional property: a key absent from
    // `required` is a 400, which is the machine-checked reason AGENTS.md says
    // `.nullable()` and never `.optional()`.
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
    // what `safeParse` will accept back. A zod upgrade that switched to
    // `type: ["number", "null"]` would still be valid JSON Schema and would
    // still pass every other assertion here.
    const properties = document.properties as JsonObject;
    expect(properties.portionsBase).toEqual({
      anyOf: [{ type: "number" }, { type: "null" }],
    });
    expect(properties.yieldUnit).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("keeps the nested ingredient object closed and fully required", () => {
    const properties = document.properties as JsonObject;
    const ingredients = properties.ingredients as JsonObject;
    const item = ingredients.items as JsonObject;

    expect(item.type).toBe("object");
    expect(item.additionalProperties).toBe(false);
    expect([...((item.required ?? []) as string[])].sort()).toEqual([
      "isOptional",
      "name",
      "note",
      "qty",
      "rawText",
      "unit",
    ]);
  });

  it("describes the array members, not just the arrays", () => {
    // A `z.array(...)` whose `items` went missing would let the model return
    // anything at all inside a shape that still validates as "an array".
    const properties = document.properties as JsonObject;
    for (const key of ["equipment", "tags", "ingredients", "steps"]) {
      const array = properties[key] as JsonObject;
      expect(array.type, key).toBe("array");
      expect(array.items, key).toBeTypeOf("object");
    }
  });
});

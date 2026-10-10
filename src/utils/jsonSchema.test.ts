import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { jsonSchemaToTypeBox, validateJsonSchema } from "./jsonSchema";

describe("validateJsonSchema", () => {
  const schema = {
    type: "object",
    properties: {
      approved: { type: "boolean" },
      amount: { type: "number", minimum: 0 },
      count: { type: "integer" },
      note: { type: "string", maxLength: 5 },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
      level: { enum: ["low", "high"] },
      nullable: { type: ["string", "null"] },
    },
    required: ["approved"],
  };

  test("accepts a matching value", () => {
    expect(
      validateJsonSchema(schema, {
        approved: true,
        amount: 2.5,
        count: 3,
        note: "ok",
        tags: ["a"],
        level: "low",
        nullable: null,
      }),
    ).toEqual({ valid: true });
  });

  test.each([
    [{}, "/approved"],
    [{ approved: "yes" }, "/approved"],
    [{ approved: true, amount: -1 }, "/amount"],
    [{ approved: true, count: 1.5 }, "/count"],
    [{ approved: true, note: "too long" }, "/note"],
    [{ approved: true, tags: ["a", "b", "c"] }, "/tags"],
    [{ approved: true, tags: [1] }, "/tags/0"],
    [{ approved: true, level: "mid" }, "/level"],
    [{ approved: true, nullable: 3 }, "/nullable"],
  ])("rejects %j at %s", (value, path) => {
    const result = validateJsonSchema(schema, value);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors.some((e) => e.path === path)).toBe(true);
  });

  test("honors additionalProperties: false", () => {
    const strict = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
    expect(validateJsonSchema(strict, { a: "x" }).valid).toBe(true);
    expect(validateJsonSchema(strict, { a: "x", b: 1 }).valid).toBe(false);
  });

  test("supports anyOf, allOf and const", () => {
    expect(validateJsonSchema({ anyOf: [{ type: "string" }, { type: "number" }] }, 1).valid).toBe(true);
    expect(validateJsonSchema({ anyOf: [{ type: "string" }, { type: "number" }] }, true).valid).toBe(false);
    expect(
      validateJsonSchema(
        {
          allOf: [
            { type: "object", required: ["a"] },
            { type: "object", required: ["b"] },
          ],
        },
        { a: 1, b: 2 },
      ).valid,
    ).toBe(true);
    expect(validateJsonSchema({ const: "x" }, "y").valid).toBe(false);
  });

  test("unsupported keywords accept any value", () => {
    expect(validateJsonSchema({ $ref: "#/defs/x" }, 42).valid).toBe(true);
    expect(validateJsonSchema(true, "anything").valid).toBe(true);
    expect(validateJsonSchema(false, "anything").valid).toBe(false);
  });

  test("passes TypeBox schemas through unchanged", () => {
    const tb = Type.Object({ a: Type.String() });
    expect(jsonSchemaToTypeBox(tb)).toBe(tb);
  });
});

import { describe, expect, test } from "bun:test";
import type { OutputSchemaShorthand } from "$shared/workflows";
import { formatShorthand, parseShorthand } from "./outputSchemaShorthand";

describe("parseShorthand", () => {
  test("empty text means no schema", () => {
    expect(parseShorthand("  ")).toEqual({ ok: true, value: undefined });
  });

  test("accepts leaves, nested maps, and [item] arrays", () => {
    const text = '{ "id": "string", "meta": { "size": "number" }, "tags": ["string"], "rows": [{ "a": "any" }] }';
    expect(parseShorthand(text)).toEqual({
      ok: true,
      value: { id: "string", meta: { size: "number" }, tags: ["string"], rows: [{ a: "any" }] },
    });
  });

  test("rejects invalid JSON, non-objects, bad arrays, and non-string leaves", () => {
    expect(parseShorthand("{").ok).toBe(false);
    expect(parseShorthand('["string"]').ok).toBe(false);
    expect(parseShorthand('{ "tags": [] }')).toMatchObject({ ok: false, error: expect.stringContaining('"tags"') });
    expect(parseShorthand('{ "a": { "b": 1 } }')).toMatchObject({ ok: false, error: expect.stringContaining('"a.b"') });
  });

  test("formatShorthand round-trips", () => {
    const value: OutputSchemaShorthand = { a: "string", b: ["number"] };
    expect(parseShorthand(formatShorthand(value))).toEqual({ ok: true, value });
    expect(formatShorthand(undefined)).toBe("");
  });
});

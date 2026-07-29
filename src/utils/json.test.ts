/**
 * Tests for the JSON extraction and validation utilities.
 */

import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { extractJson, validateJsonInput, validateJsonOutput } from "./json";

describe("extractJson", () => {
  test("extracts a plain JSON array", () => {
    const result = extractJson('[{"a": 1}, {"a": 2}]');
    expect(result).toBe('[{"a": 1}, {"a": 2}]');
  });

  test("extracts a plain JSON object", () => {
    const result = extractJson('{"key": "value"}');
    expect(result).toBe('{"key": "value"}');
  });

  test("extracts JSON from markdown code fences", () => {
    const input = '```json\n[{"name": "Alice"}]\n```';
    const result = extractJson(input);
    expect(result).toBe('[{"name": "Alice"}]');
  });

  test("extracts JSON from code fences without language tag", () => {
    const input = '```\n{"x": 42}\n```';
    const result = extractJson(input);
    expect(result).toBe('{"x": 42}');
  });

  test("extracts JSON surrounded by prose", () => {
    const input = 'Here is the data:\n\n[{"id": 1}]\n\nLet me know if you need more.';
    const result = extractJson(input);
    expect(result).toBe('[{"id": 1}]');
  });

  test("extracts JSON with leading prose containing brackets", () => {
    const input = 'I found [some things] in the data:\n[{"valid": true}]';
    const result = extractJson(input);
    expect(result).toBe('[{"valid": true}]');
  });

  test("handles nested objects and arrays", () => {
    const nested = '{"a": [1, 2], "b": {"c": "d"}}';
    const input = `Some text ${nested} more text`;
    const result = extractJson(input);
    expect(result).toBe(nested);
  });

  test("handles escaped quotes in strings", () => {
    const json = '{"message": "He said \\"hello\\""}';
    const result = extractJson(json);
    expect(JSON.parse(result)).toEqual({ message: 'He said "hello"' });
  });

  test("handles strings containing brackets", () => {
    const json = '{"formula": "[x + y] = {z}"}';
    const result = extractJson(json);
    expect(JSON.parse(result)).toEqual({ formula: "[x + y] = {z}" });
  });

  test("throws when no JSON is found", () => {
    expect(() => extractJson("no json here at all")).toThrow("No valid JSON array or object found in input");
  });

  test("throws for empty string", () => {
    expect(() => extractJson("")).toThrow("No valid JSON array or object found in input");
  });

  test("skips invalid bracket positions and finds valid JSON later", () => {
    const input = 'array [1,2,3 is broken but {"valid": true} works';
    const result = extractJson(input);
    expect(result).toBe('{"valid": true}');
  });

  test("extracts first valid JSON when multiple structures exist", () => {
    const input = '[{"first": 1}] and also [{"second": 2}]';
    const result = extractJson(input);
    expect(result).toBe('[{"first": 1}]');
  });
});

describe("validateJsonOutput", () => {
  const ArraySchema = Type.Array(Type.Object({ name: Type.String(), age: Type.Number() }), { minItems: 1 });

  test("returns valid with parsed data for conforming output", () => {
    const output = '[{"name": "Alice", "age": 30}]';
    const result = validateJsonOutput(output, ArraySchema);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual([{ name: "Alice", age: 30 }]);
    }
  });

  test("returns valid when JSON is wrapped in code fences", () => {
    const output = '```json\n[{"name": "Bob", "age": 25}]\n```';
    const result = validateJsonOutput(output, ArraySchema);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual([{ name: "Bob", age: 25 }]);
    }
  });

  test("returns valid when JSON is surrounded by prose", () => {
    const output = 'Here are the results:\n[{"name": "Eve", "age": 40}]\nDone.';
    const result = validateJsonOutput(output, ArraySchema);
    expect(result.valid).toBe(true);
  });

  test("returns invalid for non-string output", () => {
    const result = validateJsonOutput(42, ArraySchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics[0]).toContain("Expected a string containing JSON");
    }
  });

  test("returns invalid when no JSON structure is found", () => {
    const result = validateJsonOutput("just some text without json", ArraySchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics[0]).toContain("No JSON structure found");
    }
  });

  test("returns invalid for JSON that does not match schema", () => {
    const output = '[{"name": "Alice", "age": "not a number"}]';
    const result = validateJsonOutput(output, ArraySchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  test("returns invalid for empty array when minItems is set", () => {
    const output = "[]";
    const result = validateJsonOutput(output, ArraySchema);
    expect(result.valid).toBe(false);
  });

  test("returns invalid for missing required properties", () => {
    const output = '[{"name": "Alice"}]';
    const result = validateJsonOutput(output, ArraySchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics.some((d) => d.includes("age"))).toBe(true);
    }
  });

  test("returns invalid for bare JSON primitives (only objects/arrays are extracted)", () => {
    const result = validateJsonOutput('"hello"', Type.String());
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics[0]).toContain("No JSON structure found");
    }
  });

  test("works with object schema", () => {
    const schema = Type.Object({ id: Type.Number(), label: Type.String() });
    const output = '{"id": 5, "label": "test"}';
    const result = validateJsonOutput(output, schema);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data).toEqual({ id: 5, label: "test" });
    }
  });

  test("returns invalid for null output", () => {
    const result = validateJsonOutput(null, ArraySchema);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics[0]).toContain("Expected a string");
    }
  });

  test("returns invalid for undefined output", () => {
    const result = validateJsonOutput(undefined, ArraySchema);
    expect(result.valid).toBe(false);
  });
});

describe("validateJsonInput", () => {
  const Schema = Type.Array(Type.Object({ x: Type.Number() }), { minItems: 1 });

  test("returns { valid: true } for conforming output", () => {
    const result = validateJsonInput('[{"x": 1}]', Schema);
    expect(result).toEqual({ valid: true });
  });

  test("returns { valid: false, diagnostics } for non-conforming output", () => {
    const result = validateJsonInput('[{"x": "not a number"}]', Schema);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics!.length).toBeGreaterThan(0);
  });

  test("returns { valid: false } for non-string input", () => {
    const result = validateJsonInput(123, Schema);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toBeDefined();
  });

  test("returns { valid: false } when no JSON found", () => {
    const result = validateJsonInput("no json here", Schema);
    expect(result.valid).toBe(false);
  });

  test("does not include parsed data in result (only valid/diagnostics)", () => {
    const result = validateJsonInput('[{"x": 1}]', Schema);
    expect(result).toEqual({ valid: true });
    expect("data" in result).toBe(false);
  });
});

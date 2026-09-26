/**
 * Tests for unwrapArrayItems - the shared helper that steps from a JSON Schema
 * array node into its element (item) schema. It is the array counterpart to the
 * object descent in walkSchemaPath, and underpins iterator loop-variable
 * autocomplete (`{{item.<path>}}`), where `item` is one element of the array the
 * iterator's `items` expression resolves to.
 */

import { describe, expect, test } from "bun:test";
import { type OutputSchema, unwrapArrayItems } from "@shared/workflows";

describe("unwrapArrayItems", () => {
  describe("array nodes", () => {
    test("returns the element schema of a homogeneous object array", () => {
      const element: OutputSchema = {
        type: "object",
        properties: { subject: { type: "string" }, text: { type: "string" } },
      };
      const node: OutputSchema = { type: "array", items: element };
      expect(unwrapArrayItems(node)).toEqual(element);
    });

    test("returns the element schema of a primitive array", () => {
      const node: OutputSchema = { type: "array", items: { type: "string" } };
      expect(unwrapArrayItems(node)).toEqual({ type: "string" });
    });

    test("treats a node with `items` but no explicit type as an array", () => {
      const node: OutputSchema = { items: { type: "number" } };
      expect(unwrapArrayItems(node)).toEqual({ type: "number" });
    });
  });

  describe("non-single-element nodes", () => {
    test("returns null for a tuple form (items is an array of schemas)", () => {
      const node: OutputSchema = { type: "array", items: [{ type: "string" }, { type: "number" }] };
      expect(unwrapArrayItems(node)).toBeNull();
    });

    test("returns null for an array node with no items", () => {
      const node: OutputSchema = { type: "array" };
      expect(unwrapArrayItems(node)).toBeNull();
    });

    test("returns null for an object node", () => {
      const node: OutputSchema = { type: "object", properties: { a: { type: "string" } } };
      expect(unwrapArrayItems(node)).toBeNull();
    });

    test("returns null for a primitive leaf node", () => {
      expect(unwrapArrayItems({ type: "string" })).toBeNull();
    });
  });

  describe("absent / malformed input", () => {
    test("returns null for null", () => {
      expect(unwrapArrayItems(null)).toBeNull();
    });

    test("returns null for undefined", () => {
      expect(unwrapArrayItems(undefined)).toBeNull();
    });

    test("returns null when items is null", () => {
      const node = { type: "array", items: null } as unknown as OutputSchema;
      expect(unwrapArrayItems(node)).toBeNull();
    });
  });
});

import { describe, expect, test } from "bun:test";
import { getAvailableItems, getInputType, type SchemaProperty } from "./schemaForm";

describe("getInputType", () => {
  describe("select (single string with availableItems)", () => {
    test("returns 'select' for a string with a non-empty availableItems list", () => {
      const prop: SchemaProperty = { type: "string", availableItems: ["a", "b"] };
      expect(getInputType(prop)).toBe("select");
    });

    test("returns 'text' for a string with an empty availableItems list", () => {
      const prop: SchemaProperty = { type: "string", availableItems: [] };
      expect(getInputType(prop)).toBe("text");
    });

    test("returns 'text' for a plain string without availableItems", () => {
      const prop: SchemaProperty = { type: "string" };
      expect(getInputType(prop)).toBe("text");
    });

    test("multiline strings stay 'textarea' even with availableItems", () => {
      const prop: SchemaProperty = { type: "string", multiline: true, availableItems: ["a"] };
      expect(getInputType(prop)).toBe("textarea");
    });

    test("sensitive strings stay 'password' even with availableItems", () => {
      const prop: SchemaProperty = { type: "string", sensitive: true, availableItems: ["a"] };
      expect(getInputType(prop)).toBe("password");
    });
  });

  describe("existing behavior is preserved", () => {
    test("array with availableItems stays 'multiselect'", () => {
      const prop: SchemaProperty = { type: "array", availableItems: ["a"], items: { type: "string" } };
      expect(getInputType(prop)).toBe("multiselect");
    });

    test("simple string array stays 'tags'", () => {
      const prop: SchemaProperty = { type: "array", items: { type: "string" } };
      expect(getInputType(prop)).toBe("tags");
    });

    test("anyOf-of-const stays 'enum'", () => {
      const prop: SchemaProperty = { anyOf: [{ const: "x" }, { const: "y" }] };
      expect(getInputType(prop)).toBe("enum");
    });
  });
});

describe("getAvailableItems", () => {
  test("returns the string items", () => {
    expect(getAvailableItems({ availableItems: ["a", "b"] })).toEqual(["a", "b"]);
  });

  test("coerces non-string items to strings", () => {
    expect(getAvailableItems({ availableItems: [1, 2] })).toEqual(["1", "2"]);
  });

  test("returns an empty array when availableItems is missing", () => {
    expect(getAvailableItems({ type: "string" })).toEqual([]);
  });

  test("returns an empty array when availableItems is not an array", () => {
    expect(getAvailableItems({ availableItems: "nope" })).toEqual([]);
  });
});

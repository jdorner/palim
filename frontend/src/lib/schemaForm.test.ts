import { describe, expect, test } from "bun:test";
import { buildInitialValues, getAvailableItems, getEmptyValue, getInputType, type SchemaProperty } from "./schemaForm";

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

describe("getEmptyValue", () => {
  test("returns {} for object/record types (not an empty string)", () => {
    expect(getEmptyValue({ type: "object" })).toEqual({});
  });

  test("returns false for boolean, 0 for number, [] for array", () => {
    expect(getEmptyValue({ type: "boolean" })).toBe(false);
    expect(getEmptyValue({ type: "number" })).toBe(0);
    expect(getEmptyValue({ type: "array" })).toEqual([]);
  });

  test("returns empty string for plain string", () => {
    expect(getEmptyValue({ type: "string" })).toBe("");
  });
});

describe("buildInitialValues", () => {
  // Mirrors the http-request config schema shape: url required, headers an
  // optional object, method an optional enum with a default.
  const schema = {
    type: "object",
    properties: {
      url: { type: "string" },
      method: { anyOf: [{ const: "GET" }, { const: "POST" }], default: "POST" },
      headers: { type: "object" },
      body: { type: "string" },
    },
    required: ["url"],
  };

  test("omits optional fields with no value and no default (does not persist empty placeholders)", () => {
    const vals = buildInitialValues(schema, undefined);
    // Optional object field must NOT be injected as "" (the original bug).
    expect("headers" in vals).toBe(false);
    // Optional string field with no default is omitted too.
    expect("body" in vals).toBe(false);
  });

  test("seeds required fields lacking a value/default with a typed empty value", () => {
    const vals = buildInitialValues(schema, undefined);
    expect(vals.url).toBe("");
  });

  test("applies declared defaults for optional fields", () => {
    const vals = buildInitialValues(schema, undefined);
    expect(vals.method).toBe("POST");
  });

  test("preserves existing values, including optional object fields", () => {
    const vals = buildInitialValues(schema, { url: "http://x", headers: { Authorization: "Bearer t" } });
    expect(vals.url).toBe("http://x");
    expect(vals.headers).toEqual({ Authorization: "Bearer t" });
  });

  test("a required object field defaults to an empty object, never an empty string", () => {
    const objRequired = {
      type: "object",
      properties: { cfg: { type: "object" } },
      required: ["cfg"],
    };
    const vals = buildInitialValues(objRequired, undefined);
    expect(vals.cfg).toEqual({});
  });
});

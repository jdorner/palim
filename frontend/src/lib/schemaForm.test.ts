import { describe, expect, test } from "bun:test";
import {
  applyFormEdit,
  buildInitialValues,
  getAvailableItems,
  getEmptyValue,
  getFormSchema,
  getInputType,
  getProperties,
  getRecordValueSchema,
  getVariants,
  hasNonTextValue,
  moveItem,
  parseTagList,
  type SchemaProperty,
} from "./schemaForm";

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

describe("complex field types", () => {
  test("number array is 'numberlist'", () => {
    expect(getInputType({ type: "array", items: { type: "number" } })).toBe("numberlist");
    expect(getInputType({ type: "array", items: { type: "integer" } })).toBe("numberlist");
  });

  test("TypeBox record of strings (patternProperties) is 'keyvalue'", () => {
    const prop: SchemaProperty = { type: "object", patternProperties: { "^.*$": { type: "string" } } };
    expect(getInputType(prop)).toBe("keyvalue");
    expect(getRecordValueSchema(prop)).toEqual({ type: "string" });
  });

  test("additionalProperties map of numbers is 'keyvalue'", () => {
    const prop: SchemaProperty = { type: "object", additionalProperties: { type: "number" } };
    expect(getInputType(prop)).toBe("keyvalue");
  });

  test("record with non-primitive values stays 'unsupported'", () => {
    const prop: SchemaProperty = { type: "object", patternProperties: { "^.*$": { type: "array" } } };
    expect(getInputType(prop)).toBe("unsupported");
  });

  test("object with properties is 'object' (not a record)", () => {
    const prop: SchemaProperty = { type: "object", properties: { a: { type: "string" } } };
    expect(getInputType(prop)).toBe("object");
    expect(getRecordValueSchema(prop)).toBeUndefined();
  });

  test("array of objects with properties is 'objectlist'", () => {
    const prop: SchemaProperty = {
      type: "array",
      items: { type: "object", properties: { a: { type: "string" } } },
    };
    expect(getInputType(prop)).toBe("objectlist");
  });

  test("array of nested arrays stays 'unsupported'", () => {
    expect(getInputType({ type: "array", items: { type: "array", items: { type: "string" } } })).toBe("unsupported");
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

describe("parseTagList", () => {
  test("splits on commas and drops empty entries", () => {
    expect(parseTagList(" alice, bob ,, ")).toEqual(["alice", "bob"]);
  });

  test("keeps commas inside template expressions", () => {
    expect(parseTagList('{{ before(trigger.payload.mail, "@") }}, bob')).toEqual([
      '{{ before(trigger.payload.mail, "@") }}',
      "bob",
    ]);
  });

  test("keeps an unclosed expression in one entry while typing", () => {
    expect(parseTagList("alice, {{ var.X, ")).toEqual(["alice", "{{ var.X,"]);
  });
});

/** `string | record | array`, as a TypeBox union serializes. */
const content: SchemaProperty = {
  anyOf: [
    { type: "string", minLength: 1 },
    { type: "object", patternProperties: { "^(.*)$": {} } },
    { type: "array", items: {} },
  ],
};

const choice: SchemaProperty = {
  type: "object",
  required: ["type", "instructions", "criteria"],
  properties: {
    type: { type: "string", const: "choice" },
    instructions: content,
    criteria: { type: "object", patternProperties: { "^(.*)$": { anyOf: [content, { type: "null" }] } } },
  },
};

const score: SchemaProperty = {
  type: "object",
  required: ["type", "instructions", "criteria"],
  properties: {
    type: { type: "string", const: "score" },
    instructions: content,
    criteria: { type: "array", items: { ...content, multiline: true } },
  },
};

const question: SchemaProperty = { anyOf: [choice, score] };

describe("loose unions", () => {
  test("a union with a string member renders as text, keeping the union's annotations", () => {
    const props = getProperties({ properties: { a: { ...content, title: "A", multiline: true } } });
    expect(props.a).toMatchObject({ type: "string", minLength: 1, title: "A", looseUnion: true });
    expect(getInputType(props.a!)).toBe("textarea");
  });

  test("nested unions are searched, enums are left alone", () => {
    expect(getInputType({ anyOf: [content, { type: "null" }] })).toBe("text");
    expect(getInputType({ anyOf: [{ const: "a" }, { const: "b" }] })).toBe("enum");
  });

  test("records and lists of loose unions become key/value and list fields", () => {
    const props = getProperties(choice);
    expect(getInputType(props.criteria!)).toBe("keyvalue");
    expect(getInputType(getProperties(score).criteria!)).toBe("stringlist");
    expect(getInputType({ type: "array", items: content })).toBe("tags");
  });

  test("structured values fall back to JSON editing", () => {
    const props = getProperties(choice);
    expect(hasNonTextValue(props.instructions!, "text")).toBe(false);
    expect(hasNonTextValue(props.instructions!, { a: 1 })).toBe(true);
    expect(hasNonTextValue(props.criteria!, { a: "x", b: null })).toBe(false);
    expect(hasNonTextValue(props.criteria!, { a: ["x"] })).toBe(true);
    const levels = getProperties(score).criteria!;
    expect(hasNonTextValue(levels, ["a", "b"])).toBe(false);
    expect(hasNonTextValue(levels, ["a", { b: 1 }])).toBe(true);
    expect(hasNonTextValue({ type: "string" }, { a: 1 })).toBe(false);
  });
});

describe("discriminated unions", () => {
  test("are detected by a shared const property", () => {
    expect(getInputType(question)).toBe("variant");
    expect(getVariants(question)).toMatchObject({
      discriminator: "type",
      variants: [{ value: "choice" }, { value: "score" }],
    });
    expect(getVariants({ anyOf: [choice, choice] })).toBeUndefined();
  });

  test("records and lists of them render nested forms", () => {
    expect(getInputType({ type: "object", patternProperties: { "^(.*)$": question } })).toBe("objectrecord");
    expect(getInputType({ type: "array", items: question })).toBe("objectlist");
  });

  test("the form schema follows the selected alternative, discriminator first as an enum", () => {
    const schema = getFormSchema(question, { type: "score" });
    expect(Object.keys(getProperties(schema))).toEqual(["type", "instructions", "criteria"]);
    expect(getInputType(getProperties(schema).type!)).toBe("enum");
    expect(getInputType(getProperties(schema).criteria!)).toBe("stringlist");
    expect(getInputType(getProperties(getFormSchema(question, undefined)).criteria!)).toBe("keyvalue");
    expect(buildInitialValues(getFormSchema(question, undefined))).toEqual({
      type: "choice",
      instructions: "",
      criteria: {},
    });
  });

  test("switching the alternative keeps compatible fields only", () => {
    const before = { type: "choice", instructions: "Pick one", criteria: { a: "A" } };
    const next = applyFormEdit(question, before, { ...before, type: "score" });
    expect(next).toEqual({ type: "score", instructions: "Pick one", criteria: [] });
    const edit = { ...before, instructions: "Changed" };
    expect(applyFormEdit(question, before, edit)).toBe(edit);
  });
});

describe("moveItem", () => {
  test("moves an item down", () => {
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  test("moves an item up", () => {
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
  });

  test("moves an item across several positions", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 3)).toEqual(["b", "c", "d", "a"]);
  });

  test("does not mutate the input", () => {
    const list = ["a", "b"];
    moveItem(list, 0, 1);
    expect(list).toEqual(["a", "b"]);
  });

  test("returns an unchanged copy for out-of-range or equal indexes", () => {
    const list = ["a", "b"];
    expect(moveItem(list, 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(list, 1, 2)).toEqual(["a", "b"]);
    expect(moveItem(list, 1, 1)).toEqual(["a", "b"]);
    expect(moveItem(list, 0, 2)).not.toBe(list);
  });
});

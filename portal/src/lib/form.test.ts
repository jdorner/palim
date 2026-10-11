import { describe, expect, test } from "bun:test";
import { collectData, formFields, initialValues } from "./form";

const schema = {
  type: "object",
  required: ["costCenter", "amount"],
  properties: {
    costCenter: { type: "string", title: "Cost center" },
    amount: { type: "number" },
    count: { type: "integer", default: 2 },
    urgent: { type: "boolean" },
    level: { enum: ["low", "high"] },
    size: {
      anyOf: [
        { const: 1, title: "Small" },
        { const: 2, title: "Large" },
      ],
    },
    note: { type: "string", maxLength: 2000 },
    day: { type: "string", format: "date" },
    tags: { type: "array" },
  },
};

describe("formFields", () => {
  test("maps JSON Schema properties to field kinds", () => {
    const fields = formFields(schema);
    expect(fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ["costCenter", "text", true],
      ["amount", "number", true],
      ["count", "integer", false],
      ["urgent", "boolean", false],
      ["level", "select", false],
      ["size", "select", false],
      ["note", "textarea", false],
      ["day", "date", false],
      ["tags", "unsupported", false],
    ]);
    expect(fields[0]!.label).toBe("Cost center");
    expect(fields[5]!.options).toEqual([
      { value: 1, label: "Small" },
      { value: 2, label: "Large" },
    ]);
  });

  test("returns no fields without an object schema", () => {
    expect(formFields(null)).toEqual([]);
    expect(formFields({ type: "string" })).toEqual([]);
  });
});

describe("initialValues and collectData", () => {
  test("uses defaults, parses numbers, omits empty optionals, reports missing required fields", () => {
    const fields = formFields(schema);
    const values = initialValues(fields);
    expect(values.count).toBe(2);
    expect(values.urgent).toBe(false);

    values.amount = "12.5";
    values.size = "2";
    const { data, missing } = collectData(fields, values);

    expect(missing).toEqual(["costCenter"]);
    expect(data).toEqual({ amount: 12.5, count: 2, urgent: false, size: 2 });
  });
});

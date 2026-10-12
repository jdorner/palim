import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { OutputSchemaShorthand } from "$shared/workflows";
import {
  emptyFormRow,
  FORM_FIELD_TYPES,
  type FormFieldRow,
  formRowsToSchema,
  isPlainKey,
  SHAPE_FIELD_TYPES,
  type ShapeFieldRow,
  schemaToFormRows,
  shapeRowsToShorthand,
  shorthandToShapeRows,
  validateFormRows,
  validateShapeRows,
} from "./fieldBuilder";

const row = (patch: Partial<FormFieldRow>): FormFieldRow => ({ ...emptyFormRow(), ...patch });

describe("form rows", () => {
  test("empty schema means no rows and back", () => {
    expect(schemaToFormRows(undefined)).toEqual({ ok: true, rows: [] });
    expect(formRowsToSchema([])).toBeUndefined();
    expect(formRowsToSchema([row({ key: " " })])).toBeUndefined();
  });

  test("maps every field type to what the portal renders", () => {
    const schema = formRowsToSchema([
      row({ key: "note", type: "textarea", label: "Note", required: true }),
      row({ key: "due", type: "date", description: "When" }),
      row({ key: "count", type: "integer", default: "3" }),
      row({ key: "ok", type: "boolean", default: "true" }),
      row({
        key: "size",
        type: "select",
        options: [
          { value: "s", label: "" },
          { value: "m", label: "" },
        ],
      }),
      row({
        key: "tier",
        type: "select",
        options: [
          { value: "a", label: "Gold" },
          { value: "b", label: "" },
        ],
      }),
    ]);
    expect(schema).toEqual({
      type: "object",
      properties: {
        note: { type: "string", multiline: true, title: "Note" },
        due: { type: "string", format: "date", description: "When" },
        count: { type: "integer", default: 3 },
        ok: { type: "boolean", default: true },
        size: { type: "string", enum: ["s", "m"] },
        tier: { type: "string", anyOf: [{ const: "a", title: "Gold" }, { const: "b" }] },
      },
      required: ["note"],
    });
    // Property order is kept (it is the portal's render order).
    expect(Object.keys((schema as { properties: object }).properties)).toEqual([
      "note",
      "due",
      "count",
      "ok",
      "size",
      "tier",
    ]);
  });

  test("hand-written schemas within the supported subset load as rows", () => {
    const result = schemaToFormRows({
      properties: { a: { type: "string" }, b: { enum: ["x", "y"], default: "x" } },
      required: ["a"],
    });
    expect(result).toEqual({
      ok: true,
      rows: [
        row({ key: "a", required: true }),
        row({
          key: "b",
          type: "select",
          default: "x",
          options: [
            { value: "x", label: "" },
            { value: "y", label: "" },
          ],
        }),
      ],
    });
  });

  test("anything the rows cannot represent falls back", () => {
    const fails = [
      [],
      { type: "array" },
      { type: "object", additionalProperties: false },
      { properties: { a: { type: "object" } } },
      { properties: { a: { type: "array", items: { type: "string" } } } },
      { properties: { a: { type: "string", pattern: "^x" } } },
      { properties: { a: { type: "string", maxLength: 300 } } },
      { properties: { a: { type: "string", format: "email" } } },
      { properties: { a: { enum: [1, 2] } } },
      { properties: { a: { oneOf: [{ const: "x" }] } } },
      { properties: { a: { type: "number", default: "1" } } },
      { properties: {}, required: ["missing"] },
    ];
    for (const schema of fails) expect(schemaToFormRows(schema).ok).toBe(false);
  });

  test("rows -> schema -> rows round-trips", () => {
    const optionArb = fc.record({
      value: fc.string({ minLength: 1, maxLength: 5 }),
      label: fc.string({ maxLength: 5 }),
    });
    const rowArb = fc
      .record({
        type: fc.constantFrom(...FORM_FIELD_TYPES),
        label: fc.string({ maxLength: 8 }),
        description: fc.string({ maxLength: 8 }),
        required: fc.boolean(),
        options: fc.uniqueArray(optionArb, { minLength: 1, maxLength: 4, selector: (o) => o.value }),
        defaultPick: fc.boolean(),
        num: fc.integer({ min: -100, max: 100 }),
        text: fc.string({ minLength: 1, maxLength: 6 }),
      })
      .map((r): Omit<FormFieldRow, "key"> => {
        const base = {
          type: r.type,
          label: r.label,
          description: r.description,
          required: r.required,
          options: [] as FormFieldRow["options"],
        };
        if (!r.defaultPick) return { ...base, default: "", options: r.type === "select" ? r.options : [] };
        switch (r.type) {
          case "number":
          case "integer":
            return { ...base, default: String(r.num) };
          case "boolean":
            return { ...base, default: r.num % 2 === 0 ? "true" : "false" };
          case "select":
            return { ...base, options: r.options, default: r.options[0]!.value };
          default:
            return { ...base, default: r.text };
        }
      });
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fc.stringMatching(/^[a-z]{1,6}$/), rowArb), { selector: ([k]) => k, maxLength: 5 }),
        (entries) => {
          const rows = entries.map(([key, r]) => ({ key, ...r }));
          expect(validateFormRows(rows)).toBeNull();
          const back = schemaToFormRows(formRowsToSchema(rows));
          expect(back).toEqual({ ok: true, rows });
        },
      ),
    );
  });

  test("validation reports missing keys, duplicates, options, and defaults", () => {
    expect(validateFormRows([row({ key: "" })])).toBeNull();
    expect(validateFormRows([row({ key: "", label: "Note" })])).toContain("1");
    expect(validateFormRows([row({ key: "a" }), row({ key: "a" })])).toContain('"a"');
    expect(validateFormRows([row({ key: "a", type: "select" })])).not.toBeNull();
    expect(validateFormRows([row({ key: "a", type: "select", options: [{ value: "", label: "" }] })])).not.toBeNull();
    expect(
      validateFormRows([row({ key: "a", type: "select", default: "z", options: [{ value: "x", label: "" }] })]),
    ).not.toBeNull();
    expect(validateFormRows([row({ key: "a", type: "integer", default: "1.5" })])).not.toBeNull();
    expect(validateFormRows([row({ key: "a", type: "number", default: "x" })])).not.toBeNull();
    expect(validateFormRows([row({ key: "a", type: "number", default: "1.5" })])).toBeNull();
  });

  test("isPlainKey accepts identifiers only", () => {
    expect(isPlainKey("note_1")).toBe(true);
    expect(isPlainKey("my-key")).toBe(false);
    expect(isPlainKey("1a")).toBe(false);
  });
});

describe("shape rows", () => {
  test("converts leaves, lists, nested objects, and lists of objects", () => {
    const shorthand: OutputSchemaShorthand = {
      id: "string",
      tags: ["string"],
      meta: { size: "number" },
      rows: [{ a: "any" }],
      raw: "object",
    };
    const result = shorthandToShapeRows(shorthand);
    expect(result).toEqual({
      ok: true,
      rows: [
        { key: "id", type: "string", array: false, children: [] },
        { key: "tags", type: "string", array: true, children: [] },
        {
          key: "meta",
          type: "object",
          array: false,
          children: [{ key: "size", type: "number", array: false, children: [] }],
        },
        { key: "rows", type: "object", array: true, children: [{ key: "a", type: "any", array: false, children: [] }] },
        { key: "raw", type: "object", array: false, children: [] },
      ],
    });
    if (result.ok) expect(shapeRowsToShorthand(result.rows)).toEqual(shorthand);
  });

  test("unrepresentable shorthands fall back", () => {
    expect(shorthandToShapeRows({ a: [["string"]] }).ok).toBe(false);
    expect(shorthandToShapeRows({ a: "date" }).ok).toBe(false);
    expect(shorthandToShapeRows({ a: {} }).ok).toBe(false);
    expect(shorthandToShapeRows({ a: { b: "nope" } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('"a.b"'),
    });
  });

  test("no rows means no shorthand; keyless rows are skipped", () => {
    expect(shapeRowsToShorthand([])).toBeUndefined();
    expect(shapeRowsToShorthand([{ key: "", type: "string", array: false, children: [] }])).toBeUndefined();
  });

  test("rows -> shorthand -> rows round-trips", () => {
    const leaf = fc.record({ type: fc.constantFrom(...SHAPE_FIELD_TYPES), array: fc.boolean() });
    const { tree } = fc.letrec<{ tree: ShapeFieldRow[] }>((tie) => ({
      tree: fc
        .uniqueArray(
          fc.tuple(
            fc.stringMatching(/^[a-z]{1,5}$/),
            fc.oneof(
              { depthSize: "small", withCrossShrink: true },
              leaf.map((l) => ({ ...l, children: [] as ShapeFieldRow[] })),
              fc.record({ array: fc.boolean(), children: tie("tree") as fc.Arbitrary<ShapeFieldRow[]> }).map((o) => ({
                type: "object" as const,
                ...o,
              })),
            ),
          ),
          { selector: ([k]) => k, maxLength: 4 },
        )
        .map((entries) => entries.map(([key, r]) => ({ key, ...r }))),
    }));
    fc.assert(
      fc.property(tree, (rows) => {
        expect(validateShapeRows(rows)).toBeNull();
        const shorthand = shapeRowsToShorthand(rows);
        expect(shorthandToShapeRows(shorthand)).toEqual({ ok: true, rows });
      }),
    );
  });

  test("validation checks keys on every level", () => {
    const nested: ShapeFieldRow = {
      key: "meta",
      type: "object",
      array: false,
      children: [
        { key: "a", type: "string", array: false, children: [] },
        { key: "a", type: "string", array: false, children: [] },
      ],
    };
    expect(validateShapeRows([nested])).toContain('"meta.a"');
    expect(
      validateShapeRows([{ ...nested, children: [{ key: "", type: "string", array: false, children: [] }] }]),
    ).toBeNull();
    expect(
      validateShapeRows([{ ...nested, children: [{ key: "", type: "number", array: false, children: [] }] }]),
    ).toContain('"meta"');
  });
});

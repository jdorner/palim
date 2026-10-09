import { describe, expect, test } from "bun:test";
import { inferOutputShorthand } from "./schemaInference";

describe("inferOutputShorthand", () => {
  test("infers primitives, nested maps, and arrays", () => {
    expect(
      inferOutputShorthand({
        type: "taskUpdated",
        task: { id: "a", isDone: false, created: 1, tagIds: ["x"], timeSpentOnDay: {}, attachments: [] },
        note: null,
      }),
    ).toEqual({
      type: "string",
      task: {
        id: "string",
        isDone: "boolean",
        created: "number",
        tagIds: ["string"],
        timeSpentOnDay: "object",
        attachments: ["any"],
      },
      note: "any",
    });
  });

  test("merges array element shapes", () => {
    expect(inferOutputShorthand({ rows: [{ a: 1 }, { a: 2, b: "x" }, { a: "s" }] })).toEqual({
      rows: [{ a: "any", b: "string" }],
    });
    expect(inferOutputShorthand({ rows: [null, { a: 1 }] })).toEqual({ rows: [{ a: "number" }] });
    expect(inferOutputShorthand({ rows: [{}, { a: 1 }] })).toEqual({ rows: [{ a: "number" }] });
  });

  test("returns null for non-object samples", () => {
    expect(inferOutputShorthand("text")).toBeNull();
    expect(inferOutputShorthand([1, 2])).toBeNull();
    expect(inferOutputShorthand(null)).toBeNull();
  });

  test("collapses values beyond the depth limit", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const inferred = inferOutputShorthand(deep);
    expect(JSON.stringify(inferred)).toContain('"any"');
  });
});

import { describe, expect, test } from "bun:test";
import { coerceRow, coerceToType, parseDate, parseDateTime, parseNumber } from "./coerce";
import type { ColumnDef } from "./types";

describe("parseNumber", () => {
  test.each([
    ["42", 42],
    ["-3.5", -3.5],
    ["3,5", 3.5],
    ["1.234,56", 1234.56],
    ["1,234.56", 1234.56],
    ["1e3", 1000],
    [" 7 ", 7],
  ])("%p -> %p", (input, expected) => {
    expect(parseNumber(input)).toBe(expected);
  });

  test.each(["", "abc", "1.2.3", "12a"])("rejects %p", (input) => {
    expect(parseNumber(input)).toBeUndefined();
  });
});

describe("parseDate", () => {
  test("accepts ISO, slashes, and German notation", () => {
    expect(parseDate("2024-03-01")).toBe("2024-03-01");
    expect(parseDate("2024/3/1")).toBe("2024-03-01");
    expect(parseDate("01.03.2024")).toBe("2024-03-01");
    expect(parseDate("1.3.24")).toBe("2024-03-01");
    expect(parseDate("2024-03-01T10:00:00Z")).toBe("2024-03-01");
  });

  test("rejects impossible dates", () => {
    expect(parseDate("2024-02-30")).toBeUndefined();
    expect(parseDate("31.04.2024")).toBeUndefined();
    expect(parseDate("tomorrow")).toBeUndefined();
  });
});

describe("parseDateTime", () => {
  test("normalizes to UTC ISO", () => {
    expect(parseDateTime("2024-03-01T10:00:00Z")).toBe("2024-03-01T10:00:00.000Z");
    expect(parseDateTime("2024-03-01T10:00:00+02:00")).toBe("2024-03-01T08:00:00.000Z");
    expect(parseDateTime("2024-03-01")).toBe("2024-03-01T00:00:00.000Z");
  });

  test("rejects garbage", () => {
    expect(parseDateTime("2024-13-01T10:00")).toBeUndefined();
    expect(parseDateTime("noon")).toBeUndefined();
  });
});

describe("coerceToType", () => {
  test("booleans", () => {
    expect(coerceToType("boolean", "ja")).toEqual({ ok: true, value: true });
    expect(coerceToType("boolean", "No")).toEqual({ ok: true, value: false });
    expect(coerceToType("boolean", 1)).toEqual({ ok: true, value: true });
    expect(coerceToType("boolean", "maybe").ok).toBe(false);
  });

  test("integers reject fractions", () => {
    expect(coerceToType("integer", "4")).toEqual({ ok: true, value: 4 });
    expect(coerceToType("integer", "4.5").ok).toBe(false);
  });

  test("text stringifies non-strings", () => {
    expect(coerceToType("text", 5)).toEqual({ ok: true, value: "5" });
    expect(coerceToType("text", { a: 1 })).toEqual({ ok: true, value: '{"a":1}' });
  });

  test("json parses strings when possible", () => {
    expect(coerceToType("json", '{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(coerceToType("json", "plain")).toEqual({ ok: true, value: "plain" });
  });

  test("dates accept Date objects", () => {
    expect(coerceToType("date", new Date("2024-05-06T12:00:00Z"))).toEqual({ ok: true, value: "2024-05-06" });
  });
});

describe("coerceRow", () => {
  const columns: ColumnDef[] = [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "qty", label: "Qty", type: "integer", default: 1 },
    { key: "active", label: "Active", type: "boolean" },
  ];

  test("applies defaults and nulls for missing columns", () => {
    expect(coerceRow(columns, { name: "a" })).toEqual({ row: { name: "a", qty: 1, active: null }, errors: [] });
  });

  test("reports required, type, and unknown-column errors", () => {
    const { errors } = coerceRow(columns, { qty: "x", extra: 1 });
    expect(errors).toContain('unknown column "extra"');
    expect(errors).toContain("name: value is required");
    expect(errors.some((e) => e.startsWith("qty:"))).toBe(true);
  });

  test("ignores metadata keys", () => {
    expect(coerceRow(columns, { _id: 5, name: "a" }).errors).toEqual([]);
  });

  test("partial mode only touches provided keys", () => {
    expect(coerceRow(columns, { qty: "3" }, { partial: true })).toEqual({ row: { qty: 3 }, errors: [] });
    expect(coerceRow(columns, { name: "" }, { partial: true }).errors).toEqual(["name: value is required"]);
  });
});

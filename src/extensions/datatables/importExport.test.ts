import { describe, expect, test } from "bun:test";
import { readXlsx, writeXlsx } from "hucre/xlsx";
import {
  buildPreview,
  decodeText,
  defaultMapping,
  exportTable,
  inferColumns,
  inferType,
  mapRows,
  parseFile,
  slugifyKey,
  splitHeader,
  xlsxSheetName,
} from "./importExport";
import type { RowRecord, TableDef } from "./types";

const encode = (s: string) => new TextEncoder().encode(s);

describe("inferType", () => {
  test.each([
    [["1", "2", ""], "integer"],
    [["1", "2,5"], "number"],
    [["0123", "45"], "text"],
    [["ja", "nein"], "boolean"],
    [["2024-01-01", "01.02.2024"], "date"],
    [["2024-01-01T10:00:00Z", "2024-01-01"], "datetime"],
    [["abc", "1"], "text"],
    [[null, ""], "text"],
    [[true, false], "boolean"],
    [[1, 2.5], "number"],
  ])("%p -> %s", (values, expected) => {
    expect(inferType(values)).toBe(expected as never);
  });

  test("XLSX dates", () => {
    expect(inferType([new Date("2024-01-01T00:00:00Z")])).toBe("date");
    expect(inferType([new Date("2024-01-01T10:30:00Z")])).toBe("datetime");
  });
});

describe("slugifyKey", () => {
  test("transliterates and deduplicates", () => {
    const used = new Set<string>();
    expect(slugifyKey("Größe (cm)", 0, used)).toBe("groesse_cm");
    expect(slugifyKey("Größe cm", 1, used)).toBe("groesse_cm_2");
    expect(slugifyKey("2024", 2, used)).toBe("c_2024");
    expect(slugifyKey("???", 3, used)).toBe("column_4");
  });
});

describe("parseFile", () => {
  test("parses semicolon CSV with header and infers columns", async () => {
    const parsed = await parseFile(encode("Name;Menge;Datum\nApfel;3;01.03.2024\nBirne;;02.03.2024\n\n"), "x.csv");
    expect(parsed.format).toBe("csv");
    const preview = buildPreview(parsed, true);
    expect(preview.headers).toEqual(["Name", "Menge", "Datum"]);
    expect(preview.columns.map((c) => [c.key, c.type])).toEqual([
      ["name", "text"],
      ["menge", "integer"],
      ["datum", "date"],
    ]);
    expect(preview.totalRows).toBe(2);
  });

  test("falls back to Windows-1252", () => {
    expect(decodeText(new Uint8Array([0x47, 0x72, 0xf6, 0xdf, 0x65]))).toBe("Größe");
  });

  test("reads XLSX sheets", async () => {
    const bytes = await writeXlsx({
      sheets: [
        { name: "A", rows: [["x"], [1]] },
        { name: "B", rows: [["When"], [new Date("2024-05-01T00:00:00Z")]] },
      ],
    });
    const parsed = await parseFile(bytes as Uint8Array, "f.xlsx", { sheet: "B" });
    expect(parsed.sheets).toEqual(["A", "B"]);
    expect(buildPreview(parsed, true).columns[0]?.type).toBe("date");
    await expect(parseFile(bytes as Uint8Array, "f.xlsx", { sheet: "C" })).rejects.toThrow("not found");
  });

  test("rejects legacy and corrupt spreadsheets", async () => {
    await expect(parseFile(encode("not a zip"), "f.xlsx")).rejects.toThrow("Unsupported");
  });
});

describe("mapping", () => {
  test("splitHeader without header row generates names", () => {
    expect(splitHeader([["a", "b"], ["c"]], false)).toEqual({
      headers: ["Column 1", "Column 2"],
      data: [
        ["a", "b"],
        ["c", null],
      ],
    });
  });

  test("defaultMapping matches labels and keys", () => {
    const columns = inferColumns(["Name", "Preis"], []);
    expect(defaultMapping(["preis", "Other", "NAME"], columns)).toEqual({ preis: 0, name: 2 });
    expect(mapRows([["1", "x", "Bob"]], { preis: 0, name: 2 })).toEqual([{ preis: "1", name: "Bob" }]);
  });
});

describe("exportTable", () => {
  const table: TableDef = {
    id: "t",
    name: "items",
    label: "Items",
    columns: [
      { key: "name", label: "Name", type: "text" },
      { key: "day", label: "Day", type: "date" },
      { key: "meta", label: "Meta", type: "json" },
    ],
    createdAt: 0,
    updatedAt: 0,
  };
  const rows: RowRecord[] = [{ _id: 1, _createdAt: 0, _updatedAt: 0, name: "=cmd", day: "2024-01-02", meta: { a: 1 } }];

  test("CSV escapes formulas and uses labels", async () => {
    const file = await exportTable(table, rows, "csv");
    expect(file.filename).toMatch(/^items-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = file.body as string;
    expect(text.startsWith("﻿Name,Day,Meta")).toBe(true);
    expect(text).toContain("'=cmd");
    expect(text).toContain('"{""a"":1}"');
  });

  test("XLSX round-trips dates", async () => {
    const file = await exportTable(table, rows, "xlsx");
    const wb = await readXlsx(file.body as Uint8Array);
    expect(wb.sheets[0]?.rows[0]).toEqual(["Name", "Day", "Meta"]);
    expect(wb.sheets[0]?.rows[1]?.[1]).toBeInstanceOf(Date);
  });

  test("XLSX auto-fits column widths (capped) and formats datetimes with time", async () => {
    const wide: TableDef = {
      ...table,
      columns: [
        { key: "name", label: "Name", type: "text" },
        { key: "at", label: "At", type: "datetime" },
        { key: "note", label: "Note", type: "text" },
      ],
    };
    const file = await exportTable(
      wide,
      [
        {
          _id: 1,
          _createdAt: 0,
          _updatedAt: 0,
          name: "A fairly long product name",
          at: "2024-01-02T03:04:05Z",
          note: "x".repeat(500),
        },
      ],
      "xlsx",
    );
    const sheet = (await readXlsx(file.body as Uint8Array, { readStyles: true })).sheets[0];
    expect(sheet?.cells?.get("1,1")?.style?.numFmt).toBe("yyyy-mm-dd hh:mm:ss");
    const widths = sheet?.columns?.map((c) => c.width ?? 0) ?? [];
    expect(widths).toHaveLength(3);
    expect(widths[0]).toBeGreaterThan("A fairly long product name".length);
    expect(widths[1]).toBeGreaterThanOrEqual("yyyy-mm-dd hh:mm:ss".length);
    expect(widths[2]).toBe(60);
  });
});

describe("xlsxSheetName", () => {
  test.each([
    ["Items", "Items"],
    ["a/b:c", "a b c"],
    ["'Quoted'", "Quoted"],
    [" ' x ' ", "x"],
    ["History", "History 1"],
    ["history", "history 1"],
    ["'''", "Sheet1"],
    ["", "Sheet1"],
    ["a".repeat(40), "a".repeat(31)],
  ])("%p -> %p", (label, expected) => {
    expect(xlsxSheetName(label)).toBe(expected);
  });

  test("labels Excel would reject still export", async () => {
    const table: TableDef = {
      id: "t",
      name: "history",
      label: "'History'",
      columns: [{ key: "name", label: "Name", type: "text" }],
      createdAt: 0,
      updatedAt: 0,
    };
    const file = await exportTable(table, [], "xlsx");
    const wb = await readXlsx(file.body as Uint8Array);
    expect(wb.sheets[0]?.name).toBe("History 1");
  });
});

/**
 * Tests for the excel-writer extension handler (create mode).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StepExecutionContext } from "@ext/types";
import { readXlsx } from "hucre/xlsx";
import { createExcelHandler, type ExcelStepResult } from "./handler";

/** Creates a temporary work directory for tests. */
function createTmpWorkDir(): string {
  return mkdtempSync(path.join(tmpdir(), "excel-writer-test-"));
}

/** Creates a minimal StepExecutionContext for testing. */
function createTestCtx(workDir: string): StepExecutionContext {
  const logs: string[] = [];
  return {
    resolveTemplate: async (template: string) => ({ resolved: template, warnings: [] }),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    workDir,
    jobLog: async (msg: string) => {
      logs.push(msg);
    },
  };
}

describe("excel handler - create mode", () => {
  test("creates a valid xlsx file with correct data", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);

      const stepDef = {
        slug: "gen-report",
        type: "excel",
        mode: "create",
        path: "output",
        filename: "report.xlsx",
        sheets: [
          {
            name: "Sales",
            columns: [
              { header: "Product", key: "product" },
              { header: "Revenue", key: "revenue" },
            ],
            data: [
              { product: "Widget", revenue: 100 },
              { product: "Gadget", revenue: 250 },
            ],
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;

      expect(result).toEqual({
        filePath: path.join(workDir, "output", "report.xlsx"),
        rowCount: 2,
        mode: "create",
      });

      // Verify file exists and is a valid xlsx
      const fileContent = await Bun.file(result.filePath).arrayBuffer();
      const workbook = await readXlsx(new Uint8Array(fileContent));
      expect(workbook.sheets).toHaveLength(1);
      expect(workbook.sheets[0]!.name).toBe("Sales");
      // Rows: header row + 2 data rows
      expect(workbook.sheets[0]!.rows.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("creates directories if they do not exist", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);

      const stepDef = {
        slug: "deep-path",
        type: "excel",
        mode: "create",
        path: "deep/nested/dir",
        filename: "test.xlsx",
        sheets: [
          {
            name: "Sheet1",
            columns: [{ header: "A", key: "a" }],
            data: [{ a: 1 }],
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;
      const exists = await Bun.file(result.filePath).exists();
      expect(exists).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("resolves template expressions in data string field", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx: StepExecutionContext = {
        resolveTemplate: async (template: string) => {
          if (template === "{{steps.fetch.result}}") {
            return { resolved: JSON.stringify([{ name: "Alice", age: 30 }]), warnings: [] };
          }
          return { resolved: template, warnings: [] };
        },
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
        workDir,
        jobLog: async () => {},
      };

      const stepDef = {
        slug: "tmpl-step",
        type: "excel",
        mode: "create",
        path: "out",
        filename: "tmpl.xlsx",
        sheets: [
          {
            name: "People",
            columns: [
              { header: "Name", key: "name" },
              { header: "Age", key: "age" },
            ],
            data: "{{steps.fetch.result}}",
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;
      expect(result.rowCount).toBe(1);

      const fileContent = await Bun.file(result.filePath).arrayBuffer();
      const workbook = await readXlsx(new Uint8Array(fileContent));
      expect(workbook.sheets[0]!.rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("resolves template expressions in filename", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx: StepExecutionContext = {
        resolveTemplate: async (template: string) => {
          const resolved = template.replace("{{date}}", "2024-01-15");
          return { resolved, warnings: [] };
        },
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
        workDir,
        jobLog: async () => {},
      };

      const stepDef = {
        slug: "dated-report",
        type: "excel",
        mode: "create",
        path: "reports",
        filename: "report-{{date}}.xlsx",
        sheets: [
          {
            name: "Data",
            columns: [{ header: "X", key: "x" }],
            data: [{ x: 1 }],
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;
      expect(result.filePath).toContain("report-2024-01-15.xlsx");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("handles multiple sheets", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);

      const stepDef = {
        slug: "multi-sheet",
        type: "excel",
        mode: "create",
        path: "out",
        filename: "multi.xlsx",
        sheets: [
          {
            name: "Sheet1",
            columns: [{ header: "A", key: "a" }],
            data: [{ a: 1 }, { a: 2 }],
          },
          {
            name: "Sheet2",
            columns: [{ header: "B", key: "b" }],
            data: [{ b: "x" }],
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;
      expect(result.rowCount).toBe(3); // 2 + 1

      const fileContent = await Bun.file(result.filePath).arrayBuffer();
      const workbook = await readXlsx(new Uint8Array(fileContent));
      expect(workbook.sheets).toHaveLength(2);
      expect(workbook.sheets[0]!.name).toBe("Sheet1");
      expect(workbook.sheets[1]!.name).toBe("Sheet2");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("throws on invalid step configuration", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);

      const stepDef = {
        slug: "bad-config",
        type: "excel",
        mode: "create",
        // missing path, filename, sheets
      };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Invalid excel step configuration");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("throws when data is not valid JSON after template resolution", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx: StepExecutionContext = {
        resolveTemplate: async () => ({ resolved: "not-json", warnings: [] }),
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
        workDir,
        jobLog: async () => {},
      };

      const stepDef = {
        slug: "bad-data",
        type: "excel",
        mode: "create",
        path: "out",
        filename: "fail.xlsx",
        sheets: [
          {
            name: "Sheet1",
            columns: [{ header: "A", key: "a" }],
            data: "{{steps.bad.result}}",
          },
        ],
      };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Failed to parse data as JSON");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("strips markdown code fences from LLM JSON output", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const fencedJson = '```json\n[{"name": "Alice", "age": 30}]\n```';
      const ctx: StepExecutionContext = {
        resolveTemplate: async () => ({ resolved: fencedJson, warnings: [] }),
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
        workDir,
        jobLog: async () => {},
      };

      const stepDef = {
        slug: "fenced-data",
        type: "excel",
        mode: "create",
        path: "out",
        filename: "fenced.xlsx",
        sheets: [
          {
            name: "Sheet1",
            columns: [
              { header: "Name", key: "name" },
              { header: "Age", key: "age" },
            ],
            data: "{{steps.extract.result}}",
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;
      expect(result.rowCount).toBe(1);

      const fileContent = await Bun.file(result.filePath).arrayBuffer();
      const workbook = await readXlsx(new Uint8Array(fileContent));
      expect(workbook.sheets[0]!.rows[1]![0]).toBe("Alice");
      expect(workbook.sheets[0]!.rows[1]![1]).toBe(30);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("strips code fences without language tag", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const fenced = '```\n[{"x": 42}]\n```';
      const ctx: StepExecutionContext = {
        resolveTemplate: async () => ({ resolved: fenced, warnings: [] }),
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
        workDir,
        jobLog: async () => {},
      };

      const stepDef = {
        slug: "bare-fence",
        type: "excel",
        mode: "create",
        path: "out",
        filename: "bare.xlsx",
        sheets: [{ name: "S", columns: [{ header: "X", key: "x" }], data: "{{result}}" }],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;
      expect(result.rowCount).toBe(1);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("handles empty data array gracefully", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);

      const stepDef = {
        slug: "empty-data",
        type: "excel",
        mode: "create",
        path: "out",
        filename: "empty.xlsx",
        sheets: [
          {
            name: "Sheet1",
            columns: [{ header: "A", key: "a" }],
            data: [],
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;
      expect(result.rowCount).toBe(0);
      const exists = await Bun.file(result.filePath).exists();
      expect(exists).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("excel handler - append mode", () => {
  /** Helper: creates an initial file via create mode and returns its path. */
  async function createInitialFile(
    workDir: string,
    filename = "data.xlsx",
    data: Record<string, unknown>[] = [{ product: "Widget", revenue: 100 }],
  ): Promise<string> {
    const handler = createExcelHandler();
    const ctx = createTestCtx(workDir);
    const stepDef = {
      slug: "init",
      type: "excel",
      mode: "create" as const,
      path: "out",
      filename,
      sheets: [
        {
          name: "Sales",
          columns: [
            { header: "Product", key: "product" },
            { header: "Revenue", key: "revenue" },
          ],
          data,
        },
      ],
    };
    const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;
    return result.filePath;
  }

  test("appends rows to an existing file", async () => {
    const workDir = createTmpWorkDir();
    try {
      await createInitialFile(workDir);

      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);
      const stepDef = {
        slug: "append-step",
        type: "excel",
        mode: "append",
        path: "out",
        filename: "data.xlsx",
        sheets: [
          {
            name: "Sales",
            columns: [
              { header: "Product", key: "product" },
              { header: "Revenue", key: "revenue" },
            ],
            data: [
              { product: "Gadget", revenue: 250 },
              { product: "Doohickey", revenue: 75 },
            ],
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;
      expect(result.mode).toBe("append");
      expect(result.rowCount).toBe(2);

      // Verify the file now has original + appended rows
      const fileContent = await Bun.file(result.filePath).arrayBuffer();
      const workbook = await readXlsx(new Uint8Array(fileContent));
      // Header row + 1 original + 2 appended = 4 rows
      expect(workbook.sheets[0]!.rows.length).toBe(4);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("throws when file does not exist", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);
      const stepDef = {
        slug: "append-missing",
        type: "excel",
        mode: "append",
        path: "out",
        filename: "nonexistent.xlsx",
        sheets: [
          {
            name: "Sheet1",
            columns: [{ header: "A", key: "a" }],
            data: [{ a: 1 }],
          },
        ],
      };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("file does not exist");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("throws on column count mismatch", async () => {
    const workDir = createTmpWorkDir();
    try {
      // Create file with 2 columns
      await createInitialFile(workDir);

      // Try to append with 3 columns
      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);
      const stepDef = {
        slug: "mismatch-step",
        type: "excel",
        mode: "append",
        path: "out",
        filename: "data.xlsx",
        sheets: [
          {
            name: "Sales",
            columns: [
              { header: "Product", key: "product" },
              { header: "Revenue", key: "revenue" },
              { header: "Extra", key: "extra" },
            ],
            data: [{ product: "X", revenue: 1, extra: "y" }],
          },
        ],
      };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("column count mismatch");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("multiple appends accumulate rows correctly", async () => {
    const workDir = createTmpWorkDir();
    try {
      await createInitialFile(workDir, "accumulate.xlsx", [{ product: "A", revenue: 1 }]);

      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);

      const appendDef = (data: Record<string, unknown>[]) => ({
        slug: "append",
        type: "excel",
        mode: "append" as const,
        path: "out",
        filename: "accumulate.xlsx",
        sheets: [
          {
            name: "Sales",
            columns: [
              { header: "Product", key: "product" },
              { header: "Revenue", key: "revenue" },
            ],
            data,
          },
        ],
      });

      // First append: 2 rows
      await handler.execute(
        appendDef([
          { product: "B", revenue: 2 },
          { product: "C", revenue: 3 },
        ]),
        ctx,
      );
      // Second append: 1 row
      await handler.execute(appendDef([{ product: "D", revenue: 4 }]), ctx);

      // Total: header + 1 original + 2 + 1 = 5 rows
      const filePath = path.join(workDir, "out", "accumulate.xlsx");
      const fileContent = await Bun.file(filePath).arrayBuffer();
      const workbook = await readXlsx(new Uint8Array(fileContent));
      expect(workbook.sheets[0]!.rows.length).toBe(5);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("preserves existing data when appending", async () => {
    const workDir = createTmpWorkDir();
    try {
      await createInitialFile(workDir, "preserve.xlsx", [
        { product: "Widget", revenue: 100 },
        { product: "Gadget", revenue: 200 },
      ]);

      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);
      const stepDef = {
        slug: "preserve-append",
        type: "excel",
        mode: "append",
        path: "out",
        filename: "preserve.xlsx",
        sheets: [
          {
            name: "Sales",
            columns: [
              { header: "Product", key: "product" },
              { header: "Revenue", key: "revenue" },
            ],
            data: [{ product: "New Item", revenue: 999 }],
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;

      // Verify all rows are present
      const fileContent = await Bun.file(result.filePath).arrayBuffer();
      const workbook = await readXlsx(new Uint8Array(fileContent));
      const rows = workbook.sheets[0]!.rows;

      // Header + 2 original + 1 appended = 4
      expect(rows.length).toBe(4);

      // Original data preserved (row indices: 0=header, 1=Widget, 2=Gadget, 3=New Item)
      expect(rows[1]![0]).toBe("Widget");
      expect(rows[1]![1]).toBe(100);
      expect(rows[2]![0]).toBe("Gadget");
      expect(rows[2]![1]).toBe(200);
      expect(rows[3]![0]).toBe("New Item");
      expect(rows[3]![1]).toBe(999);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("handles null values in appended data", async () => {
    const workDir = createTmpWorkDir();
    try {
      await createInitialFile(workDir, "nulls.xlsx");

      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);
      const stepDef = {
        slug: "null-append",
        type: "excel",
        mode: "append",
        path: "out",
        filename: "nulls.xlsx",
        sheets: [
          {
            name: "Sales",
            columns: [
              { header: "Product", key: "product" },
              { header: "Revenue", key: "revenue" },
            ],
            data: [{ product: "Missing Revenue" }], // revenue key missing -> null
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;
      expect(result.rowCount).toBe(1);

      const fileContent = await Bun.file(result.filePath).arrayBuffer();
      const workbook = await readXlsx(new Uint8Array(fileContent));
      const lastRow = workbook.sheets[0]!.rows[workbook.sheets[0]!.rows.length - 1]!;
      expect(lastRow[0]).toBe("Missing Revenue");
      expect(lastRow[1]).toBeNull();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("excel handler - value coercion", () => {
  test("coerces European comma-decimal strings to numbers in numFmt columns", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);

      const stepDef = {
        slug: "coerce-test",
        type: "excel",
        mode: "create",
        path: "out",
        filename: "coerced.xlsx",
        sheets: [
          {
            name: "Invoices",
            columns: [
              { header: "Vendor", key: "vendor" },
              { header: "Amount", key: "amount", numFmt: "#,##0.00" },
              { header: "VAT", key: "vat", numFmt: "#,##0.00" },
            ],
            data: [
              { vendor: "dm drogerie markt", amount: "5,55", vat: "0,89" },
              { vendor: "Golden Cab GmbH", amount: "25.00", vat: "1.64" },
              { vendor: "Big Corp", amount: "1.234,56", vat: "234,56" },
            ],
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;
      expect(result.rowCount).toBe(3);

      const fileContent = await Bun.file(result.filePath).arrayBuffer();
      const workbook = await readXlsx(new Uint8Array(fileContent));
      const rows = workbook.sheets[0]!.rows;

      // Row 1: "5,55" -> 5.55, "0,89" -> 0.89
      expect(rows[1]![0]).toBe("dm drogerie markt");
      expect(rows[1]![1]).toBe(5.55);
      expect(rows[1]![2]).toBe(0.89);

      // Row 2: "25.00" -> 25, "1.64" -> 1.64 (already valid number strings)
      expect(rows[2]![1]).toBe(25);
      expect(rows[2]![2]).toBe(1.64);

      // Row 3: "1.234,56" -> 1234.56 (European thousand separator)
      expect(rows[3]![1]).toBe(1234.56);
      expect(rows[3]![2]).toBe(234.56);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("does not coerce strings in non-numeric columns", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);

      const stepDef = {
        slug: "no-coerce",
        type: "excel",
        mode: "create",
        path: "out",
        filename: "nocoerce.xlsx",
        sheets: [
          {
            name: "Data",
            columns: [
              { header: "Date", key: "date" },
              { header: "Note", key: "note" },
            ],
            data: [{ date: "04.04.2025", note: "1,5 hours" }],
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;

      const fileContent = await Bun.file(result.filePath).arrayBuffer();
      const workbook = await readXlsx(new Uint8Array(fileContent));
      const rows = workbook.sheets[0]!.rows;

      // Strings should remain as strings (no numFmt = not numeric)
      expect(rows[1]![0]).toBe("04.04.2025");
      expect(rows[1]![1]).toBe("1,5 hours");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("coerces values with explicit type: number", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);

      const stepDef = {
        slug: "explicit-type",
        type: "excel",
        mode: "create",
        path: "out",
        filename: "typed.xlsx",
        sheets: [
          {
            name: "Data",
            columns: [{ header: "Value", key: "val", type: "number" }],
            data: [{ val: "3,14" }, { val: "42" }, { val: 99 }],
          },
        ],
      };

      const result = (await handler.execute(stepDef, ctx)) as ExcelStepResult;

      const fileContent = await Bun.file(result.filePath).arrayBuffer();
      const workbook = await readXlsx(new Uint8Array(fileContent));
      const rows = workbook.sheets[0]!.rows;

      expect(rows[1]![0]).toBe(3.14);
      expect(rows[2]![0]).toBe(42);
      expect(rows[3]![0]).toBe(99);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("coercion works in append mode too", async () => {
    const workDir = createTmpWorkDir();
    try {
      const handler = createExcelHandler();
      const ctx = createTestCtx(workDir);

      // Create initial file
      await handler.execute(
        {
          slug: "init",
          type: "excel",
          mode: "create",
          path: "out",
          filename: "append-coerce.xlsx",
          sheets: [
            {
              name: "Data",
              columns: [
                { header: "Name", key: "name" },
                { header: "Price", key: "price", numFmt: "#,##0.00" },
              ],
              data: [{ name: "A", price: 10.5 }],
            },
          ],
        },
        ctx,
      );

      // Append with string numbers (simulating LLM output)
      const result = (await handler.execute(
        {
          slug: "append",
          type: "excel",
          mode: "append",
          path: "out",
          filename: "append-coerce.xlsx",
          sheets: [
            {
              name: "Data",
              columns: [
                { header: "Name", key: "name" },
                { header: "Price", key: "price", numFmt: "#,##0.00" },
              ],
              data: [{ name: "B", price: "7,99" }],
            },
          ],
        },
        ctx,
      )) as ExcelStepResult;

      const fileContent = await Bun.file(result.filePath).arrayBuffer();
      const workbook = await readXlsx(new Uint8Array(fileContent));
      const rows = workbook.sheets[0]!.rows;

      // Original row stays numeric
      expect(rows[1]![1]).toBe(10.5);
      // Appended row: "7,99" coerced to 7.99
      expect(rows[2]![1]).toBe(7.99);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

/**
 * Integration test — end-to-end workflow with excel step.
 *
 * Verifies the full pipeline:
 * 1. Workflow definition with an excel step loads and validates
 * 2. The excel step handler executes via the step processor dispatch
 * 3. Template resolution works for data, filename, and config references
 * 4. Create mode produces a valid file, append mode adds rows
 * 5. {{steps.<slug>.config.columns}} resolves correctly for agent prompts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StepExecutionContext } from "@ext/types";
import { Value } from "@sinclair/typebox/value";
import { readXlsx } from "hucre/xlsx";
import { WorkflowDefinitionSchema } from "../core/workflows/schemas";
import { resolveTemplates, type TemplateContext } from "../core/workflows/template";
import type { WorkflowStepJobData } from "../core/workflows/types";
import { createStepProcessor, type StepWorkerDeps } from "../core/workflows/worker";
import { createExcelHandler, type ExcelStepResult } from "./handler";

/** Creates a temporary work directory for tests. */
function createTmpWorkDir(): string {
  return mkdtempSync(path.join(tmpdir(), "excel-integration-"));
}

describe("excel-writer integration", () => {
  describe("workflow definition validation", () => {
    test("workflow with excel step passes schema validation", () => {
      const workflow = {
        name: "scan-to-excel",
        trigger: { type: "manual" },
        steps: [
          {
            slug: "extract",
            type: "agent",
            prompt: "Extract data from the document",
          },
          {
            slug: "append-row",
            type: "excel",
            mode: "append",
            path: "data/reports",
            filename: "scanned-documents.xlsx",
            sheets: [
              {
                name: "Scans",
                columns: [
                  { header: "Date", key: "date", width: 12 },
                  { header: "Vendor", key: "vendor", width: 25 },
                  { header: "Amount", key: "amount", numFmt: "$#,##0.00" },
                ],
                data: "{{steps.extract.result}}",
              },
            ],
          },
        ],
      };

      expect(Value.Check(WorkflowDefinitionSchema, workflow)).toBe(true);
    });

    test("workflow with invalid excel step slug fails validation", () => {
      const workflow = {
        name: "bad-workflow",
        trigger: { type: "manual" },
        steps: [
          {
            slug: "123invalid",
            type: "excel",
            mode: "create",
            path: "out",
            filename: "test.xlsx",
            sheets: [{ name: "S", columns: [{ header: "A", key: "a" }], data: [] }],
          },
        ],
      };

      expect(Value.Check(WorkflowDefinitionSchema, workflow)).toBe(false);
    });
  });

  describe("config template resolution", () => {
    test("{{steps.<slug>.config.columns}} resolves to column definitions", async () => {
      const ctx: TemplateContext = {
        stepResults: {},
        stepConfigs: {
          "append-row": {
            slug: "append-row",
            type: "excel",
            mode: "append",
            path: "data/reports",
            filename: "report.xlsx",
            sheets: [
              {
                name: "Scans",
                columns: [
                  { header: "Date", key: "date", width: 12 },
                  { header: "Vendor", key: "vendor", width: 25 },
                  { header: "Amount", key: "amount", numFmt: "$#,##0.00" },
                ],
                data: "{{steps.extract.result}}",
              },
            ],
          },
        },
      };

      // Simulate what an agent step prompt would reference
      const { resolved, warnings } = await resolveTemplates(
        "Output JSON matching these columns: {{steps.append-row.config.sheets.0.columns}}",
        ctx,
      );

      expect(warnings).toEqual([]);
      expect(resolved).toContain('"key":"date"');
      expect(resolved).toContain('"key":"vendor"');
      expect(resolved).toContain('"key":"amount"');
      expect(resolved).toContain('"header":"Date"');
    });

    test("agent can reference excel step config for schema guidance", async () => {
      const ctx: TemplateContext = {
        stepResults: {},
        stepConfigs: {
          "write-excel": {
            slug: "write-excel",
            type: "excel",
            mode: "create",
            sheets: [
              {
                name: "Products",
                columns: [
                  { header: "Name", key: "name" },
                  { header: "Price", key: "price" },
                  { header: "Category", key: "category" },
                ],
              },
            ],
          },
        },
      };

      const prompt = [
        "Extract product data from the document.",
        "Return a JSON array where each object has these keys:",
        "{{steps.write-excel.config.sheets.0.columns}}",
      ].join("\n");

      const { resolved, warnings } = await resolveTemplates(prompt, ctx);

      expect(warnings).toEqual([]);
      expect(resolved).toContain("Extract product data");
      expect(resolved).toContain('"key":"name"');
      expect(resolved).toContain('"key":"price"');
      expect(resolved).toContain('"key":"category"');
    });
  });

  describe("step processor dispatch", () => {
    test("custom excel handler is invoked via createStepProcessor", async () => {
      const workDir = createTmpWorkDir();
      try {
        const handler = createExcelHandler();

        const deps: StepWorkerDeps = {
          ctx: {
            workDir,
            skills: { resolve: () => undefined, getNames: () => [], rescan: async () => {} },
            getToolNames: () => [],
            sessions: { append: () => {} },
            runAgent: async () => ({ answer: "", state: null, timestamp: Date.now() }),
            secrets: { get: async () => null, set: async () => {} },
          } as any,
          flowProducer: { getParentResult: () => undefined } as any,
          emitEvent: () => {},
          log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
          getStepHandler: (type) => (type === "excel" ? handler : undefined),
        };

        const processor = createStepProcessor(deps);

        const jobData: WorkflowStepJobData = {
          workflowRunId: "run-1",
          workflowName: "test-wf",
          stepSlug: "gen-report",
          stepIndex: 0,
          totalSteps: 1,
          stepDef: {
            slug: "gen-report",
            type: "excel",
            mode: "create",
            path: "reports",
            filename: "output.xlsx",
            sheets: [
              {
                name: "Data",
                columns: [
                  { header: "Name", key: "name" },
                  { header: "Value", key: "value" },
                ],
                data: [
                  { name: "Alpha", value: 10 },
                  { name: "Beta", value: 20 },
                ],
              },
            ],
          } as any,
          sessionId: "session-1",
        };

        const logs: string[] = [];
        const job = {
          id: "job-1",
          data: jobData,
          log: async (msg: string) => {
            logs.push(msg);
          },
        };

        const result = await processor(job as any);
        const excelResult = result.value as ExcelStepResult;

        expect(excelResult.mode).toBe("create");
        expect(excelResult.rowCount).toBe(2);
        expect(excelResult.filePath).toContain("output.xlsx");

        // Verify the file content
        const fileContent = await Bun.file(excelResult.filePath).arrayBuffer();
        const workbook = await readXlsx(new Uint8Array(fileContent));
        expect(workbook.sheets[0]!.name).toBe("Data");
        // Header + 2 data rows
        expect(workbook.sheets[0]!.rows.length).toBe(3);
        expect(workbook.sheets[0]!.rows[1]![0]).toBe("Alpha");
        expect(workbook.sheets[0]!.rows[1]![1]).toBe(10);
        expect(workbook.sheets[0]!.rows[2]![0]).toBe("Beta");
        expect(workbook.sheets[0]!.rows[2]![1]).toBe(20);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    test("excel step resolves data from previous step result template", async () => {
      const workDir = createTmpWorkDir();
      try {
        const handler = createExcelHandler();

        // Simulate a parent step that produced JSON data
        const parentResult = {
          value: JSON.stringify([
            { product: "Widget", revenue: 100 },
            { product: "Gadget", revenue: 250 },
          ]),
          _stepResults: {
            extract: JSON.stringify([
              { product: "Widget", revenue: 100 },
              { product: "Gadget", revenue: 250 },
            ]),
          },
          _triggerPayload: { file: "invoice.pdf" },
        };

        const deps: StepWorkerDeps = {
          ctx: {
            workDir,
            skills: { resolve: () => undefined, getNames: () => [], rescan: async () => {} },
            getToolNames: () => [],
            sessions: { append: () => {} },
            runAgent: async () => ({ answer: "", state: null, timestamp: Date.now() }),
            secrets: { get: async () => null, set: async () => {} },
          } as any,
          flowProducer: { getParentResult: () => parentResult } as any,
          emitEvent: () => {},
          log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
          getStepHandler: (type) => (type === "excel" ? handler : undefined),
        };

        const processor = createStepProcessor(deps);

        const jobData: WorkflowStepJobData = {
          workflowRunId: "run-2",
          workflowName: "scan-to-excel",
          stepSlug: "write-report",
          stepIndex: 1,
          totalSteps: 2,
          stepDef: {
            slug: "write-report",
            type: "excel",
            mode: "create",
            path: "output",
            filename: "scan-results.xlsx",
            sheets: [
              {
                name: "Results",
                columns: [
                  { header: "Product", key: "product" },
                  { header: "Revenue", key: "revenue" },
                ],
                data: "{{steps.extract.result}}",
              },
            ],
          } as any,
          sessionId: "session-2",
          __flowParentId: "parent-job-1",
        };

        const logs: string[] = [];
        const job = {
          id: "job-2",
          data: jobData,
          log: async (msg: string) => {
            logs.push(msg);
          },
        };

        const result = await processor(job as any);
        const excelResult = result.value as ExcelStepResult;

        expect(excelResult.mode).toBe("create");
        expect(excelResult.rowCount).toBe(2);

        // Verify file content
        const fileContent = await Bun.file(excelResult.filePath).arrayBuffer();
        const workbook = await readXlsx(new Uint8Array(fileContent));
        expect(workbook.sheets[0]!.rows[1]![0]).toBe("Widget");
        expect(workbook.sheets[0]!.rows[1]![1]).toBe(100);
        expect(workbook.sheets[0]!.rows[2]![0]).toBe("Gadget");
        expect(workbook.sheets[0]!.rows[2]![1]).toBe(250);

        // Verify the step result is accumulated
        expect(result._stepResults["extract"]).toBeDefined();
        expect(result._stepResults["write-report"]).toBeDefined();
        expect(result._triggerPayload).toEqual({ file: "invoice.pdf" });
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    test("create then append workflow (simulated two-run scenario)", async () => {
      const workDir = createTmpWorkDir();
      try {
        const handler = createExcelHandler();
        const ctx: StepExecutionContext = {
          resolveTemplate: async (t) => ({ resolved: t, warnings: [] }),
          log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
          workDir,
          jobLog: async () => {},
        };

        // First run: create the file
        const createDef = {
          slug: "init",
          type: "excel",
          mode: "create",
          path: "data",
          filename: "log.xlsx",
          sheets: [
            {
              name: "Entries",
              columns: [
                { header: "Date", key: "date" },
                { header: "Description", key: "desc" },
                { header: "Amount", key: "amount" },
              ],
              data: [{ date: "2024-01-01", desc: "Invoice A", amount: 500 }],
            },
          ],
        };

        const createResult = (await handler.execute(createDef, ctx)) as ExcelStepResult;
        expect(createResult.mode).toBe("create");
        expect(createResult.rowCount).toBe(1);

        // Second run: append to the file
        const appendDef = {
          slug: "append",
          type: "excel",
          mode: "append",
          path: "data",
          filename: "log.xlsx",
          sheets: [
            {
              name: "Entries",
              columns: [
                { header: "Date", key: "date" },
                { header: "Description", key: "desc" },
                { header: "Amount", key: "amount" },
              ],
              data: [
                { date: "2024-01-02", desc: "Invoice B", amount: 750 },
                { date: "2024-01-03", desc: "Invoice C", amount: 300 },
              ],
            },
          ],
        };

        const appendResult = (await handler.execute(appendDef, ctx)) as ExcelStepResult;
        expect(appendResult.mode).toBe("append");
        expect(appendResult.rowCount).toBe(2);

        // Verify final file state
        const filePath = path.join(workDir, "data", "log.xlsx");
        const fileContent = await Bun.file(filePath).arrayBuffer();
        const workbook = await readXlsx(new Uint8Array(fileContent));
        const rows = workbook.sheets[0]!.rows;

        // Header + 1 (create) + 2 (append) = 4 rows
        expect(rows.length).toBe(4);
        expect(rows[0]).toEqual(["Date", "Description", "Amount"]);
        expect(rows[1]).toEqual(["2024-01-01", "Invoice A", 500]);
        expect(rows[2]).toEqual(["2024-01-02", "Invoice B", 750]);
        expect(rows[3]).toEqual(["2024-01-03", "Invoice C", 300]);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

  describe("full business scenario: scan -> extract -> append", () => {
    test("simulates the complete document scanning workflow", async () => {
      const workDir = createTmpWorkDir();
      try {
        const handler = createExcelHandler();

        // Step 1: Simulate the agent extraction (would normally be LLM-powered)
        // The agent produces structured JSON matching the excel step's columns
        const extractedData = [{ date: "2024-03-15", vendor: "Acme Corp", amount: 1299.99, category: "supplies" }];

        // Step 2: The excel step appends to the spreadsheet
        // First, create the initial file
        const initCtx: StepExecutionContext = {
          resolveTemplate: async (t) => ({ resolved: t, warnings: [] }),
          log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
          workDir,
          jobLog: async () => {},
        };

        await handler.execute(
          {
            slug: "init-spreadsheet",
            type: "excel",
            mode: "create",
            path: "data/reports",
            filename: "scanned-documents.xlsx",
            sheets: [
              {
                name: "Scans",
                columns: [
                  { header: "Date", key: "date" },
                  { header: "Vendor", key: "vendor" },
                  { header: "Amount", key: "amount" },
                  { header: "Category", key: "category" },
                ],
                data: [],
              },
            ],
          },
          initCtx,
        );

        // Now simulate the append step with extracted data
        const appendCtx: StepExecutionContext = {
          resolveTemplate: async (template) => {
            if (template === "{{steps.extract.result}}") {
              return { resolved: JSON.stringify(extractedData), warnings: [] };
            }
            return { resolved: template, warnings: [] };
          },
          log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
          workDir,
          jobLog: async () => {},
        };

        const result = (await handler.execute(
          {
            slug: "append-scan",
            type: "excel",
            mode: "append",
            path: "data/reports",
            filename: "scanned-documents.xlsx",
            sheets: [
              {
                name: "Scans",
                columns: [
                  { header: "Date", key: "date" },
                  { header: "Vendor", key: "vendor" },
                  { header: "Amount", key: "amount" },
                  { header: "Category", key: "category" },
                ],
                data: "{{steps.extract.result}}",
              },
            ],
          },
          appendCtx,
        )) as ExcelStepResult;

        expect(result.mode).toBe("append");
        expect(result.rowCount).toBe(1);

        // Verify the spreadsheet has the correct content
        const filePath = path.join(workDir, "data/reports", "scanned-documents.xlsx");
        const fileContent = await Bun.file(filePath).arrayBuffer();
        const workbook = await readXlsx(new Uint8Array(fileContent));
        const rows = workbook.sheets[0]!.rows;

        // Header + 0 (initial empty create) + 1 (appended scan) = 2 rows
        expect(rows.length).toBe(2);
        expect(rows[0]).toEqual(["Date", "Vendor", "Amount", "Category"]);
        expect(rows[1]![0]).toBe("2024-03-15");
        expect(rows[1]![1]).toBe("Acme Corp");
        expect(rows[1]![2]).toBe(1299.99);
        expect(rows[1]![3]).toBe("supplies");

        // Simulate a second scan appended
        const secondScan = [{ date: "2024-03-16", vendor: "Widget Inc", amount: 89.5, category: "office" }];

        const secondCtx: StepExecutionContext = {
          resolveTemplate: async (template) => {
            if (template === "{{steps.extract.result}}") {
              return { resolved: JSON.stringify(secondScan), warnings: [] };
            }
            return { resolved: template, warnings: [] };
          },
          log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
          workDir,
          jobLog: async () => {},
        };

        await handler.execute(
          {
            slug: "append-scan-2",
            type: "excel",
            mode: "append",
            path: "data/reports",
            filename: "scanned-documents.xlsx",
            sheets: [
              {
                name: "Scans",
                columns: [
                  { header: "Date", key: "date" },
                  { header: "Vendor", key: "vendor" },
                  { header: "Amount", key: "amount" },
                  { header: "Category", key: "category" },
                ],
                data: "{{steps.extract.result}}",
              },
            ],
          },
          secondCtx,
        );

        // Final state: header + 2 appended rows = 3
        const finalContent = await Bun.file(filePath).arrayBuffer();
        const finalWorkbook = await readXlsx(new Uint8Array(finalContent));
        const finalRows = finalWorkbook.sheets[0]!.rows;

        expect(finalRows.length).toBe(3);
        expect(finalRows[2]![0]).toBe("2024-03-16");
        expect(finalRows[2]![1]).toBe("Widget Inc");
        expect(finalRows[2]![2]).toBe(89.5);
        expect(finalRows[2]![3]).toBe("office");
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });
});

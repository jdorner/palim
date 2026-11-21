import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionContext, StepExecutionContext } from "@ext/types";
import type { DagWorkflowDefinition } from "@src/extensions/core/workflows/schemas";
import { getDependencyWarnings } from "@src/extensions/core/workflows/workflowAnalysis";
import { createTestDb } from "@src/test/db";
import { createStepHandlers, parseRows } from "./steps";
import { DataTableStore } from "./store";

/** Minimal step context resolving `{{name}}` from a variable map. */
function makeCtx(vars: Record<string, unknown> = {}): StepExecutionContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    async resolveTemplate(template: string) {
      const resolved = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
        const v = vars[key];
        return v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
      });
      return { resolved, warnings: [] };
    },
    async jobLog(msg: string) {
      logs.push(msg);
    },
    log: console as never,
    workDir: "/tmp",
    fs: undefined as never,
  } as StepExecutionContext & { logs: string[] };
}

describe("data table steps", () => {
  let store: DataTableStore;
  let steps: ReturnType<typeof createStepHandlers>;

  beforeEach(() => {
    store = new DataTableStore(createTestDb() as never);
    store.createTable({
      name: "orders",
      columns: [
        { key: "order_no", label: "Order", type: "text" },
        { key: "amount", label: "Amount", type: "number" },
        { key: "paid", label: "Paid", type: "boolean", default: false },
      ],
      keyColumn: "order_no",
    });
    steps = createStepHandlers(store);
  });

  const run = (type: string, def: Record<string, unknown>, vars?: Record<string, unknown>) =>
    steps[type]?.execute({ slug: "s", type, ...def }, makeCtx(vars)) as Promise<Record<string, unknown>>;

  test("insert from values with templates", async () => {
    const result = await run(
      "datatable-insert",
      { table: "{{t}}", values: { order_no: "{{no}}", amount: "{{amt}}" } },
      { t: "orders", no: "A-1", amt: "12,50" },
    );
    expect(result.inserted).toBe(1);
    expect(store.queryRows("orders").rows[0]).toMatchObject({ order_no: "A-1", amount: 12.5, paid: false });
  });

  test("insert from a rows template", async () => {
    const items = [
      { order_no: "A", amount: 1 },
      { order_no: "B", amount: 2 },
    ];
    const result = await run("datatable-insert", { table: "orders", rows: "{{items}}" }, { items });
    expect(result).toMatchObject({ inserted: 2 });
  });

  test("upsert, update, query, delete, truncate", async () => {
    await run("datatable-upsert", {
      table: "orders",
      rows: '[{"order_no":"A","amount":1},{"order_no":"B","amount":5}]',
    });
    const up = await run("datatable-upsert", { table: "orders", values: { order_no: "A", amount: "3" } });
    expect(up).toMatchObject({ inserted: 0, updated: 1 });

    const upd = await run(
      "datatable-update",
      {
        table: "orders",
        where: [{ column: "amount", op: "gt", value: "{{min}}" }],
        set: { paid: "ja" },
      },
      { min: 2 },
    );
    expect(upd).toEqual({ updated: 2 });

    const q = await run("datatable-query", {
      table: "orders",
      where: [{ column: "paid", op: "eq", value: "true" }],
      orderBy: "amount",
      desc: true,
      limit: 1,
    });
    expect(q).toMatchObject({ count: 1, total: 2 });
    expect((q.first as Record<string, unknown>).order_no).toBe("B");

    await expect(run("datatable-delete", { table: "orders" })).rejects.toThrow("Delete all rows");
    expect(
      await run("datatable-delete", { table: "orders", where: [{ column: "order_no", op: "eq", value: "A" }] }),
    ).toEqual({ deleted: 1 });
    expect(await run("datatable-truncate", { table: "orders" })).toEqual({ deleted: 1 });
  });

  test("query output schema reflects the table columns", () => {
    const outputSchema = steps["datatable-query"]?.outputSchema as unknown as (def: Record<string, unknown>) => {
      properties: { first: { properties: Record<string, { type: string }> } };
    };
    const schema = outputSchema({ table: "orders" });
    expect(schema.properties.first.properties.amount?.type).toBe("number");
    expect(schema.properties.first.properties._id?.type).toBe("integer");
    // Unknown/templated tables still yield a generic schema.
    expect(outputSchema({ table: "{{x}}" })).toBeDefined();
  });

  test("validateInput reports unknown tables and columns", async () => {
    const validate = steps["datatable-update"]?.validateInput;
    expect(await validate?.(null, { table: "nope" })).toMatchObject({ valid: false });
    expect(
      await validate?.(null, { table: "orders", where: [{ column: "bogus", op: "eq" }], set: { paid: "1" } }),
    ).toMatchObject({ valid: false });
    expect(await validate?.(null, { table: "orders", set: { paid: "1" } })).toEqual({ valid: true });
    expect(await validate?.(null, { table: "{{dynamic}}" })).toEqual({ valid: true });
  });

  test("validateConfig reports unknown tables and columns by field", () => {
    const check = (type: string, config: Record<string, unknown>) => steps[type]?.validateConfig?.(config);
    expect(check("datatable-query", { table: "orders_old" })).toEqual([
      { field: "table", message: 'Data table "orders_old" does not exist. Available tables: orders.' },
    ]);
    expect(
      check("datatable-query", {
        table: "orders",
        where: [
          { column: "amount", op: "gt" },
          { column: "bogus", op: "eq" },
        ],
        orderBy: "sorting",
      })?.map((i) => i.field),
    ).toEqual(["where.1.column", "orderBy"]);
    expect(check("datatable-update", { table: "orders", set: { nope: "1", _id: "2" } })?.map((i) => i.field)).toEqual([
      "set.nope",
    ]);
    expect(
      check("datatable-upsert", { table: "orders", keyColumn: "key", values: { x: "1" } })?.map((i) => i.field),
    ).toEqual(["values.x", "keyColumn"]);
    expect(check("datatable-insert", { table: "orders", values: { order_no: "1", amount: "2" } })).toEqual([]);
  });

  test("validateConfig skips templated tables and columns", () => {
    const check = steps["datatable-query"]?.validateConfig;
    expect(check?.({ table: "{{trigger.payload.table}}", orderBy: "bogus" })).toEqual([]);
    expect(check?.({ table: "orders", where: [{ column: "{{col}}", op: "eq" }], orderBy: "{{sort}}" })).toEqual([]);
  });

  test("workflow analysis warns about an unknown table in a draft", () => {
    const ctx = {
      tools: { names: () => [] },
      skills: { names: () => [] },
      stepTypes: { get: (type: string) => steps[type] },
    } as unknown as ExtensionContext;
    const wf: DagWorkflowDefinition = {
      name: "wf",
      trigger: { type: "manual" },
      steps: { lookup: { type: "datatable-query", table: "orders2" } as never },
      edges: [],
    };
    expect(getDependencyWarnings(wf, ctx).map((w) => [w.stepSlug, w.field, w.message])).toEqual([
      [
        "lookup",
        "table",
        'Invalid "datatable-query" step config: Data table "orders2" does not exist. Available tables: orders.',
      ],
    ]);
  });

  test("rejects invalid config", async () => {
    await expect(run("datatable-truncate", { table: "orders", extra: 1 })).rejects.toThrow(
      "Invalid datatable-truncate",
    );
  });
});

describe("parseRows", () => {
  test("accepts objects, arrays, and fenced JSON", () => {
    expect(parseRows('{"a":1}')).toEqual([{ a: 1 }]);
    expect(parseRows('[{"a":1},{"a":2}]')).toHaveLength(2);
    expect(parseRows('Here:\n```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(parseRows("")).toEqual([]);
    expect(() => parseRows("[1,2]")).toThrow();
    expect(() => parseRows("nope")).toThrow();
  });
});

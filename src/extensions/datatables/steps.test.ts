import { beforeEach, describe, expect, test } from "bun:test";
import type { StepExecutionContext } from "@ext/types";
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

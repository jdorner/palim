import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "@src/test/db";
import { DataTableError } from "./errors";
import { DataTableStore } from "./store";
import type { ColumnDef, TableChangedEvent } from "./types";

const COLUMNS: ColumnDef[] = [
  { key: "sku", label: "SKU", type: "text" },
  { key: "name", label: "Name", type: "text", required: true },
  { key: "price", label: "Price", type: "number" },
  { key: "active", label: "Active", type: "boolean", default: true },
];

/** Asserts that `fn` throws a DataTableError with the given status. */
function expectStatus(fn: () => unknown, status: number): DataTableError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DataTableError);
    expect((err as DataTableError).status).toBe(status);
    return err as DataTableError;
  }
  throw new Error("expected an error");
}

describe("DataTableStore", () => {
  let store: DataTableStore;
  let events: TableChangedEvent[];

  beforeEach(() => {
    events = [];
    store = new DataTableStore(createTestDb() as never, { onChange: (e) => events.push(e) });
    store.createTable({ name: "products", label: "Products", columns: COLUMNS, keyColumn: "sku" }, "u1");
  });

  describe("tables", () => {
    test("creates tables and lists them with row counts", () => {
      store.insertRows("products", [{ sku: "a", name: "A" }]);
      const [table] = store.listTables();
      expect(table?.name).toBe("products");
      expect(table?.rowCount).toBe(1);
      expect(table?.createdByUserId).toBe("u1");
      // key column is forced unique + required
      expect(table?.columns[0]).toMatchObject({ key: "sku", unique: true, required: true });
    });

    test("rejects invalid names, keys, duplicates", () => {
      expectStatus(() => store.createTable({ name: "Bad Name", columns: COLUMNS }), 400);
      expectStatus(() => store.createTable({ name: "x", columns: [{ key: "_id", label: "", type: "text" }] }), 400);
      expectStatus(() => store.createTable({ name: "products", columns: COLUMNS }), 409);
      expectStatus(() => store.createTable({ name: "y", columns: [] }), 400);
    });

    test("deleting a table removes its rows", () => {
      store.insertRows("products", [{ sku: "a", name: "A" }]);
      store.deleteTable("products");
      expect(store.getTable("products")).toBeUndefined();
      store.createTable({ name: "products", columns: COLUMNS });
      expect(store.rowCount("products")).toBe(0);
    });
  });

  describe("insert/query", () => {
    beforeEach(() => {
      store.insertRows("products", [
        { sku: "a", name: "Apple", price: "1,50" },
        { sku: "b", name: "banana", price: 0.5, active: "no" },
        { sku: "c", name: "Cherry", price: 7 },
      ]);
    });

    test("coerces values and returns records with metadata", () => {
      const { rows, total } = store.queryRows("products");
      expect(total).toBe(3);
      expect(rows[0]).toMatchObject({ sku: "a", name: "Apple", price: 1.5, active: true });
      expect(rows[1]?.active).toBe(false);
      expect(typeof rows[0]?._id).toBe("number");
    });

    test("filters by operator", () => {
      const q = (filters: Parameters<DataTableStore["queryRows"]>[1]) =>
        store.queryRows("products", filters).rows.map((r) => r.sku);
      expect(q({ filters: [{ column: "price", op: "gte", value: "1.5" }] })).toEqual(["a", "c"]);
      expect(q({ filters: [{ column: "active", op: "eq", value: "false" }] })).toEqual(["b"]);
      expect(q({ filters: [{ column: "name", op: "contains", value: "an" }] })).toEqual(["b"]);
      expect(q({ filters: [{ column: "sku", op: "in", value: "a, c" }] })).toEqual(["a", "c"]);
      expect(q({ filters: [{ column: "name", op: "ne", value: "Apple" }] })).toEqual(["b", "c"]);
    });

    test("treats LIKE wildcards in filter values literally", () => {
      store.insertRows("products", [{ sku: "d", name: "100%_off" }]);
      const rows = store.queryRows("products", { filters: [{ column: "name", op: "contains", value: "%_" }] }).rows;
      expect(rows.map((r) => r.sku)).toEqual(["d"]);
    });

    test("filter values cannot inject SQL", () => {
      const rows = store.queryRows("products", {
        filters: [{ column: "name", op: "eq", value: "x' OR 1=1 --" }],
      }).rows;
      expect(rows).toHaveLength(0);
      expectStatus(
        () => store.queryRows("products", { filters: [{ column: 'name") OR 1=1 --', op: "eq", value: 1 }] }),
        400,
      );
    });

    test("sorts case-insensitively with nulls last and pages", () => {
      store.insertRows("products", [{ sku: "d", name: "date" }]);
      const sorted = store.queryRows("products", { sort: { column: "name" } }).rows.map((r) => r.sku);
      expect(sorted).toEqual(["a", "b", "c", "d"]);
      const byPrice = store.queryRows("products", { sort: { column: "price", desc: true } }).rows.map((r) => r.sku);
      expect(byPrice).toEqual(["c", "a", "b", "d"]);
      const page = store.queryRows("products", { sort: { column: "name" }, limit: 2, offset: 2 });
      expect(page.rows.map((r) => r.sku)).toEqual(["c", "d"]);
      expect(page.total).toBe(4);
    });

    test("strict inserts are all-or-nothing", () => {
      const err = expectStatus(
        () =>
          store.insertRows("products", [
            { sku: "x", name: "ok" },
            { sku: "y", price: "nope" },
          ]),
        400,
      );
      expect((err.details as { count: number }).count).toBe(1);
      expect(store.rowCount("products")).toBe(3);
    });

    test("unique violations are rejected, or skipped with skipInvalid", () => {
      expectStatus(() => store.insertRows("products", [{ sku: "a", name: "dup" }]), 400);
      expectStatus(
        () =>
          store.insertRows("products", [
            { sku: "z", name: "1" },
            { sku: "z", name: "2" },
          ]),
        400,
      );
      const result = store.insertRows("products", [{ sku: "z", name: "1" }, { sku: "z", name: "2" }, { sku: "y" }], {
        skipInvalid: true,
      });
      expect(result.inserted).toBe(1);
      expect(result.skipped.map((s) => s.index)).toEqual([1, 2]);
    });

    test("replace import deletes existing rows first", () => {
      store.insertRows("products", [{ sku: "a", name: "new" }], { replace: true });
      expect(store.queryRows("products").rows.map((r) => r.name)).toEqual(["new"]);
    });
  });

  describe("update/delete/upsert", () => {
    beforeEach(() => {
      store.insertRows("products", [
        { sku: "a", name: "A", price: 1 },
        { sku: "b", name: "B", price: 2 },
      ]);
    });

    test("updates a single row by id", () => {
      const id = store.queryRows("products").rows[0]?._id as number;
      const row = store.updateRow("products", id, { price: "3" });
      expect(row.price).toBe(3);
      expect(row.name).toBe("A");
      expectStatus(() => store.updateRow("products", id, { sku: "b" }), 400);
      expectStatus(() => store.updateRow("products", 9999, { price: 1 }), 404);
    });

    test("updates by filter", () => {
      expect(store.updateRows("products", [{ column: "price", op: "gt", value: 1 }], { active: false })).toEqual({
        updated: 1,
      });
      expect(store.queryRows("products", { filters: [{ column: "active", op: "eq", value: false }] }).total).toBe(1);
      // setting a unique column on several rows conflicts
      expectStatus(() => store.updateRows("products", [], { sku: "same" }), 400);
    });

    test("swapping unique values within one batch is allowed", () => {
      const result = store.upsertRows(
        "products",
        [
          { sku: "a", name: "B" },
          { sku: "b", name: "A" },
        ],
        "sku",
      );
      expect(result).toMatchObject({ inserted: 0, updated: 2 });
    });

    test("upserts by key column", () => {
      const result = store.upsertRows("products", [
        { sku: "a", price: 10 },
        { sku: "c", name: "C" },
        { sku: "c", price: 5 },
      ]);
      expect(result).toMatchObject({ inserted: 1, updated: 1 });
      const rows = store.queryRows("products").rows;
      expect(rows.find((r) => r.sku === "a")).toMatchObject({ name: "A", price: 10 });
      expect(rows.find((r) => r.sku === "c")).toMatchObject({ name: "C", price: 5, active: true });
      expectStatus(() => store.upsertRows("products", [{ name: "no key" }]), 400);
    });

    test("deletes by ids or filter, refuses untargeted deletes", () => {
      expectStatus(() => store.deleteRows("products", {}), 400);
      expect(store.deleteRows("products", { filters: [{ column: "sku", op: "eq", value: "a" }] })).toEqual({
        deleted: 1,
      });
      const id = store.queryRows("products").rows[0]?._id as number;
      expect(store.deleteRows("products", { ids: [id] })).toEqual({ deleted: 1 });
      expect(store.rowCount("products")).toBe(0);
    });

    test("truncates", () => {
      expect(store.truncate("products")).toEqual({ deleted: 2 });
    });

    test("emits change events", () => {
      expect(events.every((e) => e.table === "products")).toBe(true);
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe("schema changes", () => {
    beforeEach(() => {
      store.insertRows("products", [
        { sku: "a", name: "A", price: 1 },
        { sku: "b", name: "B", price: 2.5 },
      ]);
    });

    test("renames and drops columns", () => {
      const columns: ColumnDef[] = [
        { key: "sku", label: "SKU", type: "text" },
        { key: "title", label: "Title", type: "text" },
      ];
      const result = store.updateTable("products", { columns, renames: { name: "title" } });
      expect(result.rowsRewritten).toBe(2);
      const row = store.queryRows("products").rows[0];
      expect(row).toMatchObject({ sku: "a", title: "A" });
      expect(row).not.toHaveProperty("price");
      expect(result.table.keyColumn).toBe("sku");
    });

    test("renaming the key column moves the key", () => {
      const columns = COLUMNS.map((c) => (c.key === "sku" ? { ...c, key: "code" } : c));
      const { table } = store.updateTable("products", { columns, renames: { sku: "code" } });
      expect(table.keyColumn).toBe("code");
      expect(store.queryRows("products").rows[0]?.code).toBe("a");
    });

    test("type changes convert values or conflict", () => {
      const toText = COLUMNS.map((c) => (c.key === "price" ? { ...c, type: "text" as const } : c));
      store.updateTable("products", { columns: toText });
      expect(store.queryRows("products").rows[1]?.price).toBe("2.5");

      store.updateRow("products", store.queryRows("products").rows[0]?._id as number, { price: "cheap" });
      const toInt = COLUMNS.map((c) => (c.key === "price" ? { ...c, type: "integer" as const } : c));
      const err = expectStatus(() => store.updateTable("products", { columns: toInt }), 409);
      expect((err.details as { count: number }).count).toBe(2);

      const forced = store.updateTable("products", { columns: toInt, force: true });
      expect(forced.valuesCleared).toBe(2);
      expect(store.queryRows("products").rows.map((r) => r.price)).toEqual([null, null]);
    });

    test("making a column unique fails on duplicates", () => {
      store.updateRows("products", [], { price: 1 });
      const unique = COLUMNS.map((c) => (c.key === "price" ? { ...c, unique: true } : c));
      expectStatus(() => store.updateTable("products", { columns: unique }), 409);
    });

    test("rejects inconsistent renames", () => {
      expectStatus(() => store.updateTable("products", { columns: COLUMNS, renames: { nope: "name" } }), 400);
      expectStatus(() => store.updateTable("products", { columns: COLUMNS, renames: { name: "missing" } }), 400);
    });

    test("updates label and description without touching rows", () => {
      const result = store.updateTable("products", { label: "Items", description: "All items" });
      expect(result.table).toMatchObject({ label: "Items", description: "All items" });
      expect(result.rowsRewritten).toBe(0);
    });
  });
});

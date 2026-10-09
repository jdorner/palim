/**
 * Tests for the `datatable` skill command against a mock server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CommandContext } from "just-bash";
import { EMPTY_BYTES, encodeUtf8ToBytes, InMemoryFs } from "just-bash";
import { buildDatatableCommand, parseAssignments, parseWhere, renderTable } from "./datatable";

const requests: { method: string; path: string; body?: unknown }[] = [];
let server: ReturnType<typeof Bun.serve>;
let cmd: ReturnType<typeof buildDatatableCommand>;

const TABLE = {
  id: "t1",
  name: "contacts",
  label: "Contacts",
  columns: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "age", label: "Age", type: "integer" },
  ],
  keyColumn: "name",
  createdAt: 0,
  updatedAt: 0,
  rowCount: 1,
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? undefined : await req.json().catch(() => undefined);
      requests.push({ method: req.method, path: url.pathname + url.search, body });
      const p = url.pathname;
      if (p === "/tables") return Response.json({ tables: [TABLE] });
      if (p === "/tables/contacts") return Response.json({ table: TABLE });
      if (p === "/tables/contacts/rows" && req.method === "GET") {
        return Response.json({ rows: [{ _id: 1, _createdAt: 0, _updatedAt: 0, name: "Ada", age: 36 }], total: 1 });
      }
      if (p === "/tables/contacts/rows") {
        const rows = (body as { rows: Record<string, unknown>[] }).rows;
        if (rows.some((r) => !r.name)) {
          return Response.json(
            {
              error: "Row 1 failed validation",
              details: { rows: [{ index: 0, errors: ["name: value is required"] }] },
            },
            { status: 400 },
          );
        }
        return Response.json({ inserted: rows.length, ids: rows.map((_, i) => i + 10) }, { status: 201 });
      }
      if (p === "/tables/contacts/rows/update") return Response.json({ updated: 2 });
      if (p === "/tables/contacts/rows/delete") return Response.json({ deleted: 1 });
      if (p === "/tables/contacts/truncate") return Response.json({ deleted: 5 });
      if (p === "/tables/missing") return Response.json({ error: 'Table "missing" not found' }, { status: 404 });
      return Response.json({ error: "nope" }, { status: 404 });
    },
  });
  const baseUrl = `http://localhost:${server.port}`;
  cmd = buildDatatableCommand({ baseUrl, serverUrl: baseUrl, extensionsDir: "/tmp", fetch: globalThis.fetch } as never);
});

afterAll(() => server.stop(true));

function ctx(stdin?: string): CommandContext {
  return {
    fs: new InMemoryFs(),
    cwd: "/home/user/work",
    env: new Map(),
    stdin: stdin === undefined ? EMPTY_BYTES : encodeUtf8ToBytes(stdin),
  };
}

describe("helpers", () => {
  test("parseWhere", () => {
    expect(parseWhere("age:gt:30")).toEqual({ column: "age", op: "gt", value: "30" });
    expect(parseWhere("url:eq:http://x")).toEqual({ column: "url", op: "eq", value: "http://x" });
    expect(parseWhere("name=Ada")).toEqual({ column: "name", op: "eq", value: "Ada" });
    expect(parseWhere("email:isNull")).toEqual({ column: "email", op: "isNull", value: "" });
    expect(() => parseWhere("garbage")).toThrow();
  });

  test("parseAssignments", () => {
    expect(parseAssignments(["a=1", "b=x=y"])).toEqual({ a: "1", b: "x=y" });
    expect(() => parseAssignments(["a"])).toThrow();
  });

  test("renderTable aligns columns", () => {
    expect(renderTable(["a", "bb"], [{ a: "xyz", bb: 1 }])).toBe("a    bb\n---  --\nxyz  1");
  });
});

describe("datatable command", () => {
  test("list", async () => {
    const r = await cmd(["list"], ctx());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("contacts");
  });

  test("schema", async () => {
    const r = await cmd(["schema", "contacts"], ctx());
    expect(r.stdout).toContain("Key column: name");
    expect(r.stdout).toMatch(/name\s+Name\s+text\s+required/);
  });

  test("query passes filters and renders rows", async () => {
    const r = await cmd(["query", "contacts", "--where", "age:gt:30", "--sort", "age", "--desc"], ctx());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Ada");
    const q = requests.findLast((x) => x.path.startsWith("/tables/contacts/rows?"));
    const params = new URL(`http://x${q?.path}`).searchParams;
    expect(JSON.parse(params.get("filter") ?? "")).toEqual([{ column: "age", op: "gt", value: "30" }]);
    expect(params.get("desc")).toBe("true");
  });

  test("insert from argument and stdin", async () => {
    expect((await cmd(["insert", "contacts", '{"name":"Bob"}'], ctx())).stdout).toContain("Inserted 1 row(s)");
    const r = await cmd(["insert", "contacts"], ctx('[{"name":"C"},{"name":"D"}]'));
    expect(r.stdout).toContain("Inserted 2 row(s)");
  });

  test("insert reports row errors", async () => {
    const r = await cmd(["insert", "contacts", '{"age":3}'], ctx());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("name: value is required");
  });

  test("update requires conditions or --all", async () => {
    expect((await cmd(["update", "contacts", "--set", "age=1"], ctx())).exitCode).toBe(1);
    const r = await cmd(["update", "contacts", "--where", "name=Ada", "--set", "age=37"], ctx());
    expect(r.stdout).toContain("Updated 2 row(s)");
    expect(requests.at(-1)?.body).toEqual({
      filters: [{ column: "name", op: "eq", value: "Ada" }],
      values: { age: "37" },
    });
  });

  test("delete requires a target", async () => {
    expect((await cmd(["delete", "contacts"], ctx())).exitCode).toBe(1);
    expect((await cmd(["delete", "contacts", "--id", "3"], ctx())).stdout).toContain("Deleted 1");
    expect(requests.at(-1)?.body).toEqual({ ids: [3] });
  });

  test("truncate and missing tables", async () => {
    expect((await cmd(["truncate", "contacts"], ctx())).stdout).toContain("Deleted 5");
    const r = await cmd(["schema", "missing"], ctx());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
  });
});

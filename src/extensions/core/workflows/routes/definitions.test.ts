import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext, Logger, RouteHandler } from "@ext/types";
import type { Context } from "elysia";
import type { DagWorkflowDefinition } from "../schemas";
import { registerDefinitionsRoutes } from "./definitions";
import type { WorkflowRouteDeps } from "./types";

const FILE = `// Nightly report
{
  name: "report",
  description: "Sends the report", // shown in the list
  trigger: { type: "manual" },
  steps: { a: { type: "agent", prompt: "hi" } },
}
`;

let dir: string;
let store: Map<string, DagWorkflowDefinition>;
let reloads: number;
let handler: RouteHandler;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "palim-wf-group-"));
  await Bun.write(path.join(dir, "nightly.json5"), FILE);
  store = new Map([["report", Bun.JSON5.parse(FILE) as DagWorkflowDefinition]]);
  reloads = 0;
  const handlers = new Map<string, RouteHandler>();
  const ctx = {
    routes: { register: (method: string, p: string, h: RouteHandler) => handlers.set(`${method} ${p}`, h) },
  } as unknown as ExtensionContext;
  registerDefinitionsRoutes({
    ctx,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger,
    store,
    workflowsDir: dir,
    scheduleReload: () => {
      reloads++;
    },
  } as unknown as WorkflowRouteDeps);
  const h = handlers.get("PATCH /:name/group");
  if (!h) throw new Error("group route not registered");
  handler = h;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function patch(name: string, body: unknown): Promise<Response> {
  return Promise.resolve(handler({ params: { name }, body } as unknown as Context));
}

const fileText = () => Bun.file(path.join(dir, "nightly.json5")).text();

describe("PATCH /:name/group", () => {
  test("adds the group in place, keeping comments", async () => {
    const res = await patch("report", { group: "Reports" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, group: "Reports" });
    expect(await fileText()).toBe(
      FILE.replace(`// shown in the list\n`, `// shown in the list\n  group: "Reports",\n`),
    );
    expect(store.get("report")?.group).toBe("Reports");
    expect(reloads).toBe(1);
  });

  test("null removes the group", async () => {
    await patch("report", { group: "Reports" });
    const res = await patch("report", { group: null });
    expect(await res.json()).toEqual({ ok: true, group: null });
    expect(await fileText()).toBe(FILE);
    expect(store.get("report") && "group" in store.get("report")!).toBe(false);
  });

  test("moves workflows whose definition does not validate", async () => {
    const broken = `{ name: "report", trigger: { type: "webhook" }, steps: {} }`;
    await Bun.write(path.join(dir, "nightly.json5"), broken);
    const res = await patch("report", { group: "Broken" });
    expect(res.status).toBe(200);
    expect(Bun.JSON5.parse(await fileText())).toEqual({ ...(Bun.JSON5.parse(broken) as object), group: "Broken" });
  });

  test("rejects invalid group names", async () => {
    for (const group of ["", " padded", "x".repeat(65), 3]) {
      expect((await patch("report", { group })).status).toBe(400);
    }
    expect((await patch("report", {})).status).toBe(400);
    expect((await patch("report", { group: "G", extra: 1 })).status).toBe(400);
    expect(await fileText()).toBe(FILE);
  });

  test("unknown workflow is 404", async () => {
    expect((await patch("missing", { group: "G" })).status).toBe(404);
  });
});

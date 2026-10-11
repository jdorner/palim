/**
 * Tests for the portal launcher provider of the workflows extension.
 */

import { describe, expect, test } from "bun:test";
import { PORTAL_UPLOAD_DEFAULT_MB } from "@shared/portal";
import { countPortalWorkflowsRunAs, createPortalLauncherProvider, toPortalLauncher } from "./portalLaunchers";
import type { DagWorkflowDefinition } from "./schemas";

/** Builds a minimal workflow with the given trigger. */
function wf(
  name: string,
  trigger: DagWorkflowDefinition["trigger"],
  extra: Partial<DagWorkflowDefinition> = {},
): DagWorkflowDefinition {
  return { name, trigger, steps: { a: { type: "noop" } as never }, edges: [], ...extra };
}

describe("toPortalLauncher", () => {
  test("applies defaults", () => {
    expect(toPortalLauncher(wf("receipts", { type: "portal" }, { description: "Scan a receipt" }), "u1")).toEqual({
      name: "receipts",
      title: "receipts",
      description: "Scan a receipt",
      accept: null,
      fileRequired: true,
      maxSizeMb: PORTAL_UPLOAD_DEFAULT_MB,
      fields: null,
      roles: [],
      runAsUserId: "u1",
    });
  });

  test("uses the portal configuration", () => {
    const fields = { type: "object", properties: { note: { type: "string" } } };
    const launcher = toPortalLauncher(
      wf("receipts", {
        type: "portal",
        portal: { title: "Receipt", accept: "image/*", fileRequired: false, maxSizeMb: 5, fields, roles: ["acc"] },
      }),
      null,
    );
    expect(launcher).toMatchObject({
      title: "Receipt",
      accept: "image/*",
      fileRequired: false,
      maxSizeMb: 5,
      fields,
      roles: ["acc"],
      runAsUserId: null,
    });
  });

  test("skips other trigger types and disabled workflows", () => {
    expect(toPortalLauncher(wf("m", { type: "manual" }), "u1")).toBeNull();
    expect(toPortalLauncher(wf("p", { type: "portal" }, { enabled: false }), "u1")).toBeNull();
  });
});

describe("createPortalLauncherProvider", () => {
  const store = new Map<string, DagWorkflowDefinition>([
    ["receipts", wf("receipts", { type: "portal" })],
    ["manual", wf("manual", { type: "manual" })],
    ["off", wf("off", { type: "portal" }, { enabled: false })],
  ]);
  const bindings: Record<string, string> = { receipts: "u1", manual: "u1", off: "u1" };
  const runAsOf = (name: string) => bindings[name] ?? null;

  test("lists enabled portal workflows with their bindings", () => {
    const provider = createPortalLauncherProvider(store, async () => ({ workflowRunId: "r" }), runAsOf);
    expect(provider.list().map((l) => [l.name, l.runAsUserId])).toEqual([["receipts", "u1"]]);
  });

  test("starts a portal workflow as the given initiator and refuses others", async () => {
    const calls: [string, unknown, string][] = [];
    const provider = createPortalLauncherProvider(
      store,
      async (def, payload, initiator) => {
        calls.push([def.name, payload, initiator]);
        return { workflowRunId: "run-9" };
      },
      runAsOf,
    );
    expect(await provider.start("receipts", { x: 1 }, "u1")).toEqual({ runId: "run-9" });
    expect(calls).toEqual([["receipts", { x: 1 }, "u1"]]);
    await expect(provider.start("manual", {}, "u1")).rejects.toThrow();
    await expect(provider.start("off", {}, "u1")).rejects.toThrow();
    await expect(provider.start("missing", {}, "u1")).rejects.toThrow();
  });

  test("counts the portal workflows bound to the user, disabled ones included", () => {
    expect(countPortalWorkflowsRunAs(store, "u1", runAsOf)).toBe(2);
    expect(countPortalWorkflowsRunAs(store, "u2", runAsOf)).toBe(0);
  });
});

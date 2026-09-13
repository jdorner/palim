/**
 * Tests for the pluggable step type registry (registerStepType).
 */

import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { StepTypeHandler } from "../types";
import { EventBus } from "./eventBus";
import { createExtensionContext, type ExtensionContextDeps } from "./extensionContext";
import { serializeStepType, serializeStepTypes } from "./stepTypeSerialization";

/** Creates minimal deps for testing registerStepType. */
function createTestDeps(extensionName = "test-ext"): ExtensionContextDeps {
  return {
    extensionName,
    workDir: "/tmp/test-work",
    dataDir: "/tmp/test-data",
    extensionsDir: "/tmp/test-extensions",
    toolNameSet: new Set<string>(),
    routeKeySet: new Set<string>(),
    stepTypeNameSet: new Set<string>(),
    eventBus: new EventBus(),
    flowProducer: { addChain: async () => ({ jobIds: [] }) } as any,
    runAgentFn: async () => ({ answer: "", state: null, timestamp: Date.now() }),
    database: {} as any,
    sessionStore: { create: () => ({ id: "s1" }) } as any,
    isExtensionEnabledFn: () => true,
  };
}

/** Creates a simple step type handler for testing. */
function createTestHandler(label = "Test Step"): StepTypeHandler {
  return {
    schema: Type.Object({
      path: Type.String(),
    }),
    label,
    icon: "TableIcon",
    execute: async () => ({ success: true }),
  };
}

describe("registerStepType", () => {
  test("registers a step type successfully", () => {
    const deps = createTestDeps();
    const { context, loaded } = createExtensionContext(deps);
    const handler = createTestHandler("Excel Writer");

    context.stepTypes.register("excel", handler);

    expect(loaded.stepTypes).toHaveLength(1);
    expect(loaded.stepTypes[0]!.type).toBe("excel");
    expect(loaded.stepTypes[0]!.handler).toBe(handler);
    expect(loaded.stepTypes[0]!.extensionName).toBe("test-ext");
  });

  test("adds type to global stepTypeNameSet", () => {
    const deps = createTestDeps();
    const { context } = createExtensionContext(deps);

    context.stepTypes.register("excel", createTestHandler());

    expect(deps.stepTypeNameSet.has("excel")).toBe(true);
  });

  test("throws on duplicate step type name", () => {
    const deps = createTestDeps();
    deps.stepTypeNameSet.add("excel");

    const { context } = createExtensionContext(deps);

    expect(() => context.stepTypes.register("excel", createTestHandler())).toThrow(
      'step type "excel" conflicts with an already-registered type',
    );
  });

  test("throws when trying to override built-in agent type", () => {
    const deps = createTestDeps();
    const { context } = createExtensionContext(deps);

    expect(() => context.stepTypes.register("agent", createTestHandler())).toThrow(
      'step type "agent" is a built-in type and cannot be overridden',
    );
  });

  test("throws when trying to override built-in webhook type", () => {
    const deps = createTestDeps();
    const { context } = createExtensionContext(deps);

    expect(() => context.stepTypes.register("webhook", createTestHandler())).toThrow(
      'step type "webhook" is a built-in type and cannot be overridden',
    );
  });

  test("allows multiple different step types from same extension", () => {
    const deps = createTestDeps();
    const { context, loaded } = createExtensionContext(deps);

    context.stepTypes.register("excel", createTestHandler("Excel"));
    context.stepTypes.register("pdf", createTestHandler("PDF"));

    expect(loaded.stepTypes).toHaveLength(2);
    expect(deps.stepTypeNameSet.has("excel")).toBe(true);
    expect(deps.stepTypeNameSet.has("pdf")).toBe(true);
  });

  test("prevents cross-extension duplicate via shared stepTypeNameSet", () => {
    const sharedSet = new Set<string>();

    // First extension registers "excel"
    const deps1 = createTestDeps("ext-a");
    deps1.stepTypeNameSet = sharedSet;
    const { context: ctx1 } = createExtensionContext(deps1);
    ctx1.stepTypes.register("excel", createTestHandler());

    // Second extension tries to register "excel" - should fail
    const deps2 = createTestDeps("ext-b");
    deps2.stepTypeNameSet = sharedSet;
    const { context: ctx2 } = createExtensionContext(deps2);

    expect(() => ctx2.stepTypes.register("excel", createTestHandler())).toThrow(
      'step type "excel" conflicts with an already-registered type',
    );
  });
});

describe("ExtensionContext.stepTypes.list", () => {
  test("returns serialized metadata from the registry function", () => {
    const deps = createTestDeps();
    const handler = createTestHandler("Excel Writer");
    deps.listStepTypesFn = () => serializeStepTypes([{ type: "excel", handler, extensionName: "other-ext" }]);

    const { context } = createExtensionContext(deps);
    const listed = context.stepTypes.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]!.type).toBe("excel");
    expect(listed[0]!.label).toBe("Excel Writer");
    expect(listed[0]!.extensionName).toBe("other-ext");
  });

  test("sees step types registered by OTHER extensions, not just its own", () => {
    // The registry aggregates across all active extensions; the context's
    // list() delegates to that aggregation, so it is not scoped to the caller.
    const deps = createTestDeps("caller-ext");
    deps.listStepTypesFn = () =>
      serializeStepTypes([{ type: "pdf", handler: createTestHandler("PDF"), extensionName: "pdf-ext" }]);

    const { context } = createExtensionContext(deps);

    expect(context.stepTypes.list().map((s) => s.extensionName)).toEqual(["pdf-ext"]);
  });

  test("does not expose the live handler or its execute function", () => {
    const deps = createTestDeps();
    deps.listStepTypesFn = () =>
      serializeStepTypes([{ type: "excel", handler: createTestHandler(), extensionName: "test-ext" }]);

    const { context } = createExtensionContext(deps);
    const entry = context.stepTypes.list()[0]!;

    expect((entry as unknown as Record<string, unknown>).handler).toBeUndefined();
    expect((entry as unknown as Record<string, unknown>).execute).toBeUndefined();
    // Config schema is a plain serialized JSON Schema object.
    expect(entry.configSchema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  test("returns an empty array when no registry function is configured", () => {
    const deps = createTestDeps();
    // listStepTypesFn intentionally omitted
    const { context } = createExtensionContext(deps);

    expect(context.stepTypes.list()).toEqual([]);
  });
});

describe("serializeStepType", () => {
  test("serializes config and output schemas and drops execute", () => {
    const handler: StepTypeHandler = {
      schema: Type.Object({ url: Type.String() }),
      label: "HTTP",
      icon: "LinkIcon",
      terminal: false,
      category: "action",
      outputSchema: Type.Object({ status: Type.Number() }),
      execute: async () => ({ ok: true }),
    };

    const info = serializeStepType({ type: "http", handler, extensionName: "core-wf-steps" });

    expect(info).toEqual({
      type: "http",
      label: "HTTP",
      icon: "LinkIcon",
      extensionName: "core-wf-steps",
      terminal: false,
      category: "action",
      configSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      outputSchema: { type: "object", properties: { status: { type: "number" } }, required: ["status"] },
    });
    expect((info as unknown as Record<string, unknown>).execute).toBeUndefined();
  });

  test("leaves outputSchema undefined when the handler declares none", () => {
    const info = serializeStepType({
      type: "fail",
      handler: { schema: Type.Object({}), label: "Fail", terminal: true, execute: async () => undefined },
      extensionName: "core-wf-steps",
    });

    expect(info.outputSchema).toBeUndefined();
    expect(info.terminal).toBe(true);
  });
});

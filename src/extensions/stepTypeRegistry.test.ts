/**
 * Tests for the pluggable step type registry (registerStepType).
 */

import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { EventBus } from "./eventBus";
import { createExtensionContext, type ExtensionContextDeps } from "./extensionContext";
import type { StepTypeHandler } from "./types";

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
    icon: "📊",
    execute: async () => ({ success: true }),
  };
}

describe("registerStepType", () => {
  test("registers a step type successfully", () => {
    const deps = createTestDeps();
    const { context, loaded } = createExtensionContext(deps);
    const handler = createTestHandler("Excel Writer");

    context.registerStepType("excel", handler);

    expect(loaded.stepTypes).toHaveLength(1);
    expect(loaded.stepTypes[0]!.type).toBe("excel");
    expect(loaded.stepTypes[0]!.handler).toBe(handler);
    expect(loaded.stepTypes[0]!.extensionName).toBe("test-ext");
  });

  test("adds type to global stepTypeNameSet", () => {
    const deps = createTestDeps();
    const { context } = createExtensionContext(deps);

    context.registerStepType("excel", createTestHandler());

    expect(deps.stepTypeNameSet.has("excel")).toBe(true);
  });

  test("throws on duplicate step type name", () => {
    const deps = createTestDeps();
    deps.stepTypeNameSet.add("excel");

    const { context } = createExtensionContext(deps);

    expect(() => context.registerStepType("excel", createTestHandler())).toThrow(
      'step type "excel" conflicts with an already-registered type',
    );
  });

  test("throws when trying to override built-in agent type", () => {
    const deps = createTestDeps();
    const { context } = createExtensionContext(deps);

    expect(() => context.registerStepType("agent", createTestHandler())).toThrow(
      'step type "agent" is a built-in type and cannot be overridden',
    );
  });

  test("throws when trying to override built-in webhook type", () => {
    const deps = createTestDeps();
    const { context } = createExtensionContext(deps);

    expect(() => context.registerStepType("webhook", createTestHandler())).toThrow(
      'step type "webhook" is a built-in type and cannot be overridden',
    );
  });

  test("allows multiple different step types from same extension", () => {
    const deps = createTestDeps();
    const { context, loaded } = createExtensionContext(deps);

    context.registerStepType("excel", createTestHandler("Excel"));
    context.registerStepType("pdf", createTestHandler("PDF"));

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
    ctx1.registerStepType("excel", createTestHandler());

    // Second extension tries to register "excel" - should fail
    const deps2 = createTestDeps("ext-b");
    deps2.stepTypeNameSet = sharedSet;
    const { context: ctx2 } = createExtensionContext(deps2);

    expect(() => ctx2.registerStepType("excel", createTestHandler())).toThrow(
      'step type "excel" conflicts with an already-registered type',
    );
  });
});

/**
 * Tests for the workflow trigger type registry (`ctx.triggerTypes`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { TriggerTypeDefinition } from "../types";
import { EventBus } from "./eventBus";
import { createExtensionContext, type ExtensionContextDeps, setTriggerFireFn } from "./extensionContext";
import { serializeTriggerType } from "./triggerTypeSerialization";

/** Creates minimal deps for testing the trigger type registry. */
function createTestDeps(extensionName = "test-ext", triggerTypeNameSet = new Set<string>()): ExtensionContextDeps {
  return {
    extensionName,
    workDir: "/tmp/test-work",
    dataDir: "/tmp/test-data",
    extensionsDir: "/tmp/test-extensions",
    toolNameSet: new Set<string>(),
    routeKeySet: new Set<string>(),
    stepTypeNameSet: new Set<string>(),
    triggerTypeNameSet,
    eventBus: new EventBus(),
    flowProducer: { addChain: async () => ({ jobIds: [] }) } as any,
    runAgentFn: async () => ({ answer: "", state: null, timestamp: Date.now() }),
    database: {} as any,
    sessionStore: { create: () => ({ id: "s1" }) } as any,
    isExtensionEnabledFn: () => true,
  };
}

const updates: TriggerTypeDefinition = {
  label: "Extension update",
  outputSchema: Type.Object({ updates: Type.Array(Type.Object({ name: Type.String() })) }),
};

afterEach(() => setTriggerFireFn(undefined));

describe("ctx.triggerTypes.register", () => {
  test("records the registration and claims the name", () => {
    const deps = createTestDeps();
    const { context, loaded } = createExtensionContext(deps);
    context.triggerTypes.register("extension-update", updates);
    expect(loaded.triggerTypes).toEqual([{ type: "extension-update", definition: updates, extensionName: "test-ext" }]);
    expect(deps.triggerTypeNameSet.has("extension-update")).toBe(true);
  });

  test("rejects built-in names, invalid names, and a missing label", () => {
    const { context } = createExtensionContext(createTestDeps());
    expect(() => context.triggerTypes.register("webhook", updates)).toThrow("built-in");
    expect(() => context.triggerTypes.register("manual", updates)).toThrow("built-in");
    expect(() => context.triggerTypes.register("Bad Name", updates)).toThrow("not a valid name");
    expect(() => context.triggerTypes.register("ok-name", { label: " " })).toThrow("needs a label");
  });

  test("rejects a name another extension registered", () => {
    const shared = new Set<string>();
    createExtensionContext(createTestDeps("a", shared)).context.triggerTypes.register("extension-update", updates);
    const { context } = createExtensionContext(createTestDeps("b", shared));
    expect(() => context.triggerTypes.register("extension-update", updates)).toThrow("already-registered");
  });
});

describe("ctx.triggerTypes.fire", () => {
  test("hands the payload to the workflows extension", async () => {
    const calls: unknown[] = [];
    setTriggerFireFn(async (type, payload, options) => {
      calls.push({ type, payload, options });
      return [{ workflowRunId: "r1", jobIds: [] }];
    });
    const { context } = createExtensionContext(createTestDeps());
    context.triggerTypes.register("extension-update", updates);
    const result = await context.triggerTypes.fire("extension-update", { updates: [] }, { initiatorUserId: "u1" });
    expect(result).toEqual([{ workflowRunId: "r1", jobIds: [] }]);
    expect(calls).toEqual([
      { type: "extension-update", payload: { updates: [] }, options: { initiatorUserId: "u1", hasRefs: false } },
    ]);
  });

  test("only fires the extension's own types", async () => {
    setTriggerFireFn(async () => []);
    const shared = new Set<string>();
    createExtensionContext(createTestDeps("a", shared)).context.triggerTypes.register("extension-update", updates);
    const { context } = createExtensionContext(createTestDeps("b", shared));
    await expect(context.triggerTypes.fire("extension-update", {})).rejects.toThrow("has not registered");
  });

  test("a type with refs needs a ref", async () => {
    setTriggerFireFn(async () => []);
    const { context } = createExtensionContext(createTestDeps());
    context.triggerTypes.register("feed-item", { label: "Feed item", refs: () => ["news"] });
    await expect(context.triggerTypes.fire("feed-item", {})).rejects.toThrow("needs a ref");
    expect(await context.triggerTypes.fire("feed-item", {}, { ref: "news" })).toEqual([]);
  });

  test("fails while the workflows extension is not running", async () => {
    const { context } = createExtensionContext(createTestDeps());
    context.triggerTypes.register("extension-update", updates);
    await expect(context.triggerTypes.fire("extension-update", {})).rejects.toThrow("not initialized");
  });
});

describe("serializeTriggerType", () => {
  test("ships plain JSON Schema and reduces refs to a flag", () => {
    const info = serializeTriggerType({
      type: "feed-item",
      definition: { label: "Feed item", docs: "# Feed", refs: () => ["news"], outputSchema: Type.Object({}) },
      extensionName: "feeds",
    });
    expect(info).toEqual({
      type: "feed-item",
      label: "Feed item",
      description: undefined,
      docs: "# Feed",
      icon: undefined,
      extensionName: "feeds",
      hasRefs: true,
      outputSchema: { type: "object", properties: {} },
    });
  });
});

import { describe, expect, test } from "bun:test";
import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { createForEachHandler, type ForEachHandlerDeps } from "./for-each";

/** Creates a minimal fake StepExecutionContext for testing. */
function createFakeContext(overrides?: Partial<StepExecutionContext>): StepExecutionContext {
  return {
    resolveTemplate: async (template: string) => ({ resolved: template, warnings: [] }),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as StepExecutionContext["log"],
    workDir: "/tmp/test-work",
    jobLog: async () => {},
    workflowRunId: "test-run-123",
    ...overrides,
  };
}

/** A simple step handler that echoes back the resolved step definition fields. */
function createEchoHandler(): StepTypeHandler {
  return {
    schema: {} as StepTypeHandler["schema"],
    label: "Echo",
    async execute(stepDef: Record<string, unknown>, _ctx: StepExecutionContext): Promise<unknown> {
      const { slug: _s, type: _t, outputSchema: _o, ...rest } = stepDef;
      return rest;
    },
  };
}

/** A step handler that extracts a specific field and returns it uppercased. */
function createUppercaseHandler(): StepTypeHandler {
  return {
    schema: {} as StepTypeHandler["schema"],
    label: "Uppercase",
    async execute(stepDef: Record<string, unknown>, _ctx: StepExecutionContext): Promise<unknown> {
      const input = stepDef.input as string;
      return { text: input.toUpperCase() };
    },
  };
}

/** Creates default deps with a configurable handler map. */
function createDeps(handlers: Record<string, StepTypeHandler> = {}): ForEachHandlerDeps {
  return {
    getStepHandler: (type) => handlers[type],
  };
}

describe("createForEachHandler", () => {
  describe("metadata", () => {
    const handler = createForEachHandler(createDeps());

    test("has correct label and icon", () => {
      expect(handler.label).toBe("For Each");
      expect(handler.icon).toBe("RepeatIcon");
    });

    test("schema defines required items field", () => {
      expect(handler.schema.properties.items).toBeDefined();
    });

    test("schema defines optional as, concurrency, failStrategy, steps, edges fields", () => {
      expect(handler.schema.properties.as).toBeDefined();
      expect(handler.schema.properties.concurrency).toBeDefined();
      expect(handler.schema.properties.failStrategy).toBeDefined();
      expect(handler.schema.properties.steps).toBeDefined();
      expect(handler.schema.properties.edges).toBeDefined();
    });

    test("outputSchema declares results, totalItems, succeeded, failed", () => {
      expect(handler.outputSchema).toBeDefined();
      const properties = (handler.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(properties.results).toBeDefined();
      expect(properties.totalItems).toBeDefined();
      expect(properties.succeeded).toBeDefined();
      expect(properties.failed).toBeDefined();
    });
  });

  describe("empty array", () => {
    test("returns empty results when items array is empty", async () => {
      const handler = createForEachHandler(createDeps());
      const ctx = createFakeContext({
        resolveTemplate: async () => ({ resolved: "[]", warnings: [] }),
      });

      const result = (await handler.execute(
        {
          slug: "loop",
          type: "for-each",
          items: "[]",
          steps: { echo: { type: "echo", value: "{{item}}" } },
        },
        ctx,
      )) as { results: unknown[]; totalItems: number; succeeded: number; failed: number };

      expect(result.results).toEqual([]);
      expect(result.totalItems).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
    });
  });

  describe("basic iteration", () => {
    test("iterates over a simple array and executes sub-step for each element", async () => {
      const echoHandler = createEchoHandler();
      const handler = createForEachHandler(createDeps({ echo: echoHandler }));
      const ctx = createFakeContext({
        resolveTemplate: async (template: string) => {
          // Resolve item expressions (the handler calls resolveTemplate after its own item substitution)
          return { resolved: template, warnings: [] };
        },
      });

      const result = (await handler.execute(
        {
          slug: "loop",
          type: "for-each",
          items: '[{"name":"alice"},{"name":"bob"}]',
          steps: { greet: { type: "echo", value: "hello" } },
        },
        ctx,
      )) as { results: unknown[]; totalItems: number; succeeded: number; failed: number };

      expect(result.totalItems).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.results).toHaveLength(2);
    });

    test("resolves {{item}} to the current element in sub-step fields", async () => {
      const calls: string[] = [];
      const trackHandler: StepTypeHandler = {
        schema: {} as StepTypeHandler["schema"],
        label: "Track",
        async execute(stepDef: Record<string, unknown>): Promise<unknown> {
          calls.push(stepDef.value as string);
          return { captured: stepDef.value };
        },
      };

      const handler = createForEachHandler(createDeps({ track: trackHandler }));
      const ctx = createFakeContext();

      await handler.execute(
        {
          slug: "loop",
          type: "for-each",
          items: '["apple","banana","cherry"]',
          steps: { capture: { type: "track", value: "{{item}}" } },
        },
        ctx,
      );

      expect(calls).toEqual(["apple", "banana", "cherry"]);
    });

    test("resolves {{item.field}} for object elements", async () => {
      const calls: string[] = [];
      const trackHandler: StepTypeHandler = {
        schema: {} as StepTypeHandler["schema"],
        label: "Track",
        async execute(stepDef: Record<string, unknown>): Promise<unknown> {
          calls.push(stepDef.value as string);
          return { captured: stepDef.value };
        },
      };

      const handler = createForEachHandler(createDeps({ track: trackHandler }));
      const ctx = createFakeContext();

      await handler.execute(
        {
          slug: "loop",
          type: "for-each",
          items: '[{"id":"1","name":"alice"},{"id":"2","name":"bob"}]',
          steps: { capture: { type: "track", value: "{{item.name}}" } },
        },
        ctx,
      );

      expect(calls).toEqual(["alice", "bob"]);
    });

    test("resolves {{itemIndex}} to the zero-based index", async () => {
      const calls: string[] = [];
      const trackHandler: StepTypeHandler = {
        schema: {} as StepTypeHandler["schema"],
        label: "Track",
        async execute(stepDef: Record<string, unknown>): Promise<unknown> {
          calls.push(stepDef.value as string);
          return {};
        },
      };

      const handler = createForEachHandler(createDeps({ track: trackHandler }));
      const ctx = createFakeContext();

      await handler.execute(
        {
          slug: "loop",
          type: "for-each",
          items: '["a","b","c"]',
          steps: { capture: { type: "track", value: "{{itemIndex}}" } },
        },
        ctx,
      );

      expect(calls).toEqual(["0", "1", "2"]);
    });

    test("supports custom variable name via 'as' field", async () => {
      const calls: string[] = [];
      const trackHandler: StepTypeHandler = {
        schema: {} as StepTypeHandler["schema"],
        label: "Track",
        async execute(stepDef: Record<string, unknown>): Promise<unknown> {
          calls.push(stepDef.value as string);
          return {};
        },
      };

      const handler = createForEachHandler(createDeps({ track: trackHandler }));
      const ctx = createFakeContext();

      await handler.execute(
        {
          slug: "loop",
          type: "for-each",
          items: '["x","y"]',
          as: "element",
          steps: { capture: { type: "track", value: "{{element}}" } },
        },
        ctx,
      );

      expect(calls).toEqual(["x", "y"]);
    });
  });

  describe("sub-step chaining", () => {
    test("passes results between sub-steps via {{steps.<slug>.result}}", async () => {
      const uppercaseHandler = createUppercaseHandler();
      const calls: string[] = [];
      const trackHandler: StepTypeHandler = {
        schema: {} as StepTypeHandler["schema"],
        label: "Track",
        async execute(stepDef: Record<string, unknown>): Promise<unknown> {
          calls.push(stepDef.input as string);
          return {};
        },
      };

      const handler = createForEachHandler(createDeps({ uppercase: uppercaseHandler, track: trackHandler }));
      const ctx = createFakeContext();

      await handler.execute(
        {
          slug: "loop",
          type: "for-each",
          items: '[{"text":"hello"},{"text":"world"}]',
          steps: {
            upper: { type: "uppercase", input: "{{item.text}}" },
            log: { type: "track", input: "{{steps.upper.result.text}}" },
          },
          edges: [{ from: "upper", to: "log" }],
        },
        ctx,
      );

      expect(calls).toEqual(["HELLO", "WORLD"]);
    });

    test("executes sub-steps in topological order", async () => {
      const order: string[] = [];
      const orderHandler: StepTypeHandler = {
        schema: {} as StepTypeHandler["schema"],
        label: "Order",
        async execute(stepDef: Record<string, unknown>): Promise<unknown> {
          order.push(stepDef.name as string);
          return {};
        },
      };

      const handler = createForEachHandler(createDeps({ order: orderHandler }));
      const ctx = createFakeContext();

      await handler.execute(
        {
          slug: "loop",
          type: "for-each",
          items: '["x"]',
          steps: {
            c: { type: "order", name: "c" },
            a: { type: "order", name: "a" },
            b: { type: "order", name: "b" },
          },
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "c" },
          ],
        },
        ctx,
      );

      expect(order).toEqual(["a", "b", "c"]);
    });
  });

  describe("error handling", () => {
    test("throws on non-JSON items value", async () => {
      const handler = createForEachHandler(createDeps());
      const ctx = createFakeContext();

      await expect(
        handler.execute(
          {
            slug: "loop",
            type: "for-each",
            items: "not json",
            steps: { echo: { type: "echo" } },
          },
          ctx,
        ),
      ).rejects.toThrow("failed to parse items as JSON array");
    });

    test("throws when items resolves to a non-array", async () => {
      const handler = createForEachHandler(createDeps());
      const ctx = createFakeContext();

      await expect(
        handler.execute(
          {
            slug: "loop",
            type: "for-each",
            items: '{"key":"value"}',
            steps: { echo: { type: "echo" } },
          },
          ctx,
        ),
      ).rejects.toThrow("Expected an array");
    });

    test("throws when sub-step handler is not registered", async () => {
      const handler = createForEachHandler(createDeps({}));
      const ctx = createFakeContext();

      await expect(
        handler.execute(
          {
            slug: "loop",
            type: "for-each",
            items: '["a"]',
            steps: { missing: { type: "nonexistent", value: "x" } },
          },
          ctx,
        ),
      ).rejects.toThrow('no handler registered for sub-step type "nonexistent"');
    });

    test("fail-fast aborts on first sub-step failure", async () => {
      // First sub-step succeeds, second fails
      let callCount = 0;
      const conditionalHandler: StepTypeHandler = {
        schema: {} as StepTypeHandler["schema"],
        label: "Conditional",
        async execute(): Promise<unknown> {
          callCount++;
          if (callCount === 2) throw new Error("boom at item 2");
          return {};
        },
      };

      const handler = createForEachHandler(createDeps({ conditional: conditionalHandler }));
      const ctx = createFakeContext();

      await expect(
        handler.execute(
          {
            slug: "loop",
            type: "for-each",
            items: '["a","b","c"]',
            failStrategy: "fail-fast",
            steps: { step: { type: "conditional" } },
          },
          ctx,
        ),
      ).rejects.toThrow("iteration 1 failed");

      // Third iteration should not have been attempted
      expect(callCount).toBe(2);
    });

    test("continue strategy processes all items even when some fail", async () => {
      let callCount = 0;
      const conditionalHandler: StepTypeHandler = {
        schema: {} as StepTypeHandler["schema"],
        label: "Conditional",
        async execute(): Promise<unknown> {
          callCount++;
          if (callCount === 2) throw new Error("boom");
          return { ok: true };
        },
      };

      const handler = createForEachHandler(createDeps({ conditional: conditionalHandler }));
      const ctx = createFakeContext();

      const result = (await handler.execute(
        {
          slug: "loop",
          type: "for-each",
          items: '["a","b","c"]',
          failStrategy: "continue",
          steps: { step: { type: "conditional" } },
        },
        ctx,
      )) as { results: unknown[]; totalItems: number; succeeded: number; failed: number };

      expect(callCount).toBe(3);
      expect(result.totalItems).toBe(3);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
    });

    test("throws on cycle in sub-step edges", async () => {
      const handler = createForEachHandler(createDeps({ echo: createEchoHandler() }));
      const ctx = createFakeContext();

      await expect(
        handler.execute(
          {
            slug: "loop",
            type: "for-each",
            items: '["a"]',
            steps: {
              a: { type: "echo" },
              b: { type: "echo" },
            },
            edges: [
              { from: "a", to: "b" },
              { from: "b", to: "a" },
            ],
          },
          ctx,
        ),
      ).rejects.toThrow("Cycle detected");
    });

    test("throws when agent sub-step is used without runAgentInline dep", async () => {
      const handler = createForEachHandler(createDeps());
      const ctx = createFakeContext();

      await expect(
        handler.execute(
          {
            slug: "loop",
            type: "for-each",
            items: '["a"]',
            steps: { think: { type: "agent", prompt: "hello" } },
          },
          ctx,
        ),
      ).rejects.toThrow("agent sub-steps require runAgentInline");
    });
  });

  describe("agent sub-steps", () => {
    test("calls runAgentInline for agent-type sub-steps", async () => {
      const agentCalls: { prompt: string; tools?: string[]; skills?: string[] }[] = [];
      const deps: ForEachHandlerDeps = {
        getStepHandler: () => undefined,
        runAgentInline: async (prompt, opts) => {
          agentCalls.push({ prompt, ...opts });
          return `response to: ${prompt}`;
        },
      };

      const handler = createForEachHandler(deps);
      const ctx = createFakeContext();

      const result = (await handler.execute(
        {
          slug: "loop",
          type: "for-each",
          items: '[{"q":"what is 1+1"},{"q":"what is 2+2"}]',
          steps: { ask: { type: "agent", prompt: "{{item.q}}", tools: ["calc"] } },
        },
        ctx,
      )) as { results: unknown[]; totalItems: number };

      expect(agentCalls).toHaveLength(2);
      expect(agentCalls[0]!.prompt).toBe("what is 1+1");
      expect(agentCalls[0]!.tools).toEqual(["calc"]);
      expect(agentCalls[1]!.prompt).toBe("what is 2+2");
      expect(result.totalItems).toBe(2);
    });
  });

  describe("concurrency", () => {
    test("processes items in parallel when concurrency > 1", async () => {
      const startTimes: number[] = [];
      const slowHandler: StepTypeHandler = {
        schema: {} as StepTypeHandler["schema"],
        label: "Slow",
        async execute(): Promise<unknown> {
          const start = Date.now();
          startTimes.push(start);
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { done: true };
        },
      };

      const handler = createForEachHandler(createDeps({ slow: slowHandler }));
      const ctx = createFakeContext();

      const startTime = Date.now();
      const result = (await handler.execute(
        {
          slug: "loop",
          type: "for-each",
          items: '["a","b","c","d"]',
          concurrency: 4,
          steps: { wait: { type: "slow" } },
        },
        ctx,
      )) as { totalItems: number; succeeded: number };

      const elapsed = Date.now() - startTime;

      expect(result.totalItems).toBe(4);
      expect(result.succeeded).toBe(4);
      // With concurrency 4 and 50ms each, should complete in ~50-100ms, not 200ms+
      expect(elapsed).toBeLessThan(150);
    });
  });

  describe("parent template passthrough", () => {
    test("delegates non-item expressions to parent resolveTemplate", async () => {
      const calls: string[] = [];
      const trackHandler: StepTypeHandler = {
        schema: {} as StepTypeHandler["schema"],
        label: "Track",
        async execute(stepDef: Record<string, unknown>): Promise<unknown> {
          calls.push(stepDef.value as string);
          return {};
        },
      };

      const handler = createForEachHandler(createDeps({ track: trackHandler }));
      const ctx = createFakeContext({
        resolveTemplate: async (template: string) => {
          // Simulate parent resolving trigger.payload references
          const resolved = template.replace("{{trigger.payload.name}}", "workflow-name");
          return { resolved, warnings: [] };
        },
      });

      await handler.execute(
        {
          slug: "loop",
          type: "for-each",
          items: '["a"]',
          steps: { capture: { type: "track", value: "{{trigger.payload.name}}" } },
        },
        ctx,
      );

      expect(calls).toEqual(["workflow-name"]);
    });
  });
});

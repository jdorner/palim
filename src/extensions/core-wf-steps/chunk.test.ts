import { describe, expect, test } from "bun:test";
import type { StepExecutionContext } from "@ext/types";
import { InMemoryFs } from "just-bash";
import { type ChunkStepResult, createChunkHandler } from "./chunk";

/** Creates a minimal fake StepExecutionContext for testing. */
function createFakeContext(overrides?: Partial<StepExecutionContext>): StepExecutionContext {
  return {
    resolveTemplate: async (template: string) => ({ resolved: template, warnings: [] }),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as StepExecutionContext["log"],
    workDir: "/tmp/test-work",
    fs: new InMemoryFs(),
    jobLog: async () => {},
    workflowRunId: "test-run-123",
    ...overrides,
  };
}

describe("createChunkHandler", () => {
  const handler = createChunkHandler();

  describe("metadata", () => {
    test("has correct label, icon, and category", () => {
      expect(handler.label).toBe("Chunk");
      expect(handler.icon).toBe("KnifeIcon");
      expect(handler.category).toBe("action");
    });

    test("outputSchema declares batches, count, and itemCount", () => {
      const properties = (handler.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(properties).sort()).toEqual(["batches", "count", "itemCount"]);
    });
  });

  describe("string input (line splitting)", () => {
    test("splits newline-separated input into batches", async () => {
      const ctx = createFakeContext();
      const stepDef = {
        slug: "chunk",
        type: "chunk",
        input: "a\nb\nc\nd\ne",
        size: 2,
      };

      const result = (await handler.execute(stepDef, ctx)) as ChunkStepResult;

      expect(result.itemCount).toBe(5);
      expect(result.count).toBe(3);
      expect(result.batches).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    });

    test("normalizes CRLF line endings", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "chunk", type: "chunk", input: "a\r\nb\r\nc", size: 5 };

      const result = (await handler.execute(stepDef, ctx)) as ChunkStepResult;

      expect(result.batches).toEqual([["a", "b", "c"]]);
    });

    test("trims items and drops blank lines by default", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "chunk", type: "chunk", input: "  a  \n\n b \n   \nc", size: 10 };

      const result = (await handler.execute(stepDef, ctx)) as ChunkStepResult;

      expect(result.batches).toEqual([["a", "b", "c"]]);
      expect(result.itemCount).toBe(3);
    });

    test("keeps blank/whitespace items when trim is false", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "chunk", type: "chunk", input: "a\n\nb", size: 10, trim: false };

      const result = (await handler.execute(stepDef, ctx)) as ChunkStepResult;

      expect(result.batches).toEqual([["a", "", "b"]]);
    });

    test("splits on a custom separator when provided", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "chunk", type: "chunk", input: "a,b,c,d", size: 2, separator: "," };

      const result = (await handler.execute(stepDef, ctx)) as ChunkStepResult;

      expect(result.batches).toEqual([
        ["a", "b"],
        ["c", "d"],
      ]);
    });
  });

  describe("JSON array input", () => {
    test("groups a JSON array directly", async () => {
      const ctx = createFakeContext();
      const stepDef = {
        slug: "chunk",
        type: "chunk",
        input: '["one", "two", "three"]',
        size: 2,
      };

      const result = (await handler.execute(stepDef, ctx)) as ChunkStepResult;

      expect(result.batches).toEqual([["one", "two"], ["three"]]);
      expect(result.itemCount).toBe(3);
    });

    test("stringifies non-string array elements", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "chunk", type: "chunk", input: '[1, 2, {"a":3}]', size: 5 };

      const result = (await handler.execute(stepDef, ctx)) as ChunkStepResult;

      expect(result.batches).toEqual([["1", "2", '{"a":3}']]);
    });
  });

  describe("edge cases", () => {
    test("empty input after trimming produces zero batches", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "chunk", type: "chunk", input: "   \n  \n", size: 5 };

      const result = (await handler.execute(stepDef, ctx)) as ChunkStepResult;

      expect(result.batches).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.itemCount).toBe(0);
    });

    test("size larger than item count yields a single batch", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "chunk", type: "chunk", input: "a\nb", size: 100 };

      const result = (await handler.execute(stepDef, ctx)) as ChunkStepResult;

      expect(result.count).toBe(1);
      expect(result.batches).toEqual([["a", "b"]]);
    });
  });

  describe("template resolution", () => {
    test("resolves template expressions in input", async () => {
      const ctx = createFakeContext({
        resolveTemplate: async (template: string) => ({
          resolved: template.replace("{{steps.list.result.stdout}}", "x\ny\nz"),
          warnings: [],
        }),
      });
      const stepDef = {
        slug: "chunk",
        type: "chunk",
        input: "{{steps.list.result.stdout}}",
        size: 2,
      };

      const result = (await handler.execute(stepDef, ctx)) as ChunkStepResult;

      expect(result.batches).toEqual([["x", "y"], ["z"]]);
    });

    test("logs input template warnings", async () => {
      const logged: string[] = [];
      const ctx = createFakeContext({
        resolveTemplate: async (template: string) => ({
          resolved: template,
          warnings: ["Unresolvable template path: steps.missing.result"],
        }),
        jobLog: async (msg: string) => {
          logged.push(msg);
        },
      });
      const stepDef = { slug: "chunk", type: "chunk", input: "{{steps.missing.result}}", size: 2 };

      await handler.execute(stepDef, ctx);

      expect(logged.some((l) => l.includes("Warning (input)"))).toBe(true);
    });
  });

  describe("invalid configuration", () => {
    test("throws when input is missing", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "chunk", type: "chunk", size: 2 };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Invalid chunk step configuration");
    });

    test("throws when size is missing", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "chunk", type: "chunk", input: "a\nb" };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Invalid chunk step configuration");
    });

    test("throws when size is below the minimum", async () => {
      const ctx = createFakeContext();
      const stepDef = { slug: "chunk", type: "chunk", input: "a\nb", size: 0 };

      await expect(handler.execute(stepDef, ctx)).rejects.toThrow("Invalid chunk step configuration");
    });

    test("strips slug, type, and outputSchema before validation", async () => {
      const ctx = createFakeContext();
      const stepDef = {
        slug: "chunk",
        type: "chunk",
        outputSchema: { type: "object" },
        input: "a\nb\nc",
        size: 2,
      };

      const result = (await handler.execute(stepDef, ctx)) as ChunkStepResult;
      expect(result.itemCount).toBe(3);
    });
  });
});

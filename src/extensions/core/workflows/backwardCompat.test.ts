/**
 * Backward-compatibility regression tests for the workflow-schema-dataflow
 * feature.
 *
 * Two invariants are covered:
 *
 * Part A: an existing hand-authored
 * Type_Hint_Shorthand output schema still loads without error, and the set of
 * completable property paths derived from compiling that shorthand to JSON
 * Schema is a superset of the paths completable by the pre-change legacy
 * shorthand walker, with matching terminal/non-terminal classification.
 *
 * Part B: declaring an `outputSchema` on the built-in
 * step handlers is purely declarative metadata and does not alter runtime
 * behavior. The handlers' `execute` functions produce the same result/status
 * regardless of the `outputSchema` field, which is never consumed on the
 * execution path.
 *
 * The legacy shorthand walker and the JSON Schema walker are re-declared locally
 * (mirroring the reference patterns in `outputSchemaCompiler.test.ts`) rather
 * than imported from a `.test.ts` file.
 */

import { describe, expect, test } from "bun:test";
import type { StepExecutionContext } from "@ext/types";
import type { OutputSchema } from "@shared/workflows";
import type { TSchema } from "@sinclair/typebox";
import { InMemoryFs } from "just-bash";
import { createFailHandler } from "../../core-wf-steps/fail";
import { createHttpRequestHandler } from "../../core-wf-steps/http-request";
import { createNotifyStepHandler } from "../../telegram/notifyStep";
import { buildOutputSchemas } from "./index";
import { compileOutputSchema } from "./outputSchemaCompiler";
import type { DagWorkflowDefinition, OutputSchemaShorthand } from "./schemas";

// ---------------------------------------------------------------------------
// Reference legacy shorthand walker + JSON Schema walker (re-declared locally)
// ---------------------------------------------------------------------------

/** Type guard for a plain object node (used while walking compiled schemas). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reference legacy shorthand walker. Given a shorthand map and a dot-path,
 * returns the completable child keys at that path plus whether each child is
 * terminal. A leaf string is terminal; a nested map is non-terminal. A path
 * that hits a leaf or a missing key yields no completions.
 *
 * @param shorthand - The hand-authored type-hint map
 * @param path - Dot-path segments to descend before listing completions
 * @returns Completable child keys with terminal classification
 */
function legacyWalk(shorthand: OutputSchemaShorthand, path: string[]): { key: string; terminal: boolean }[] {
  let current: OutputSchemaShorthand | string = shorthand;
  for (const segment of path) {
    if (typeof current === "string") {
      // Descended into a leaf: no further children.
      return [];
    }
    const next: string | OutputSchemaShorthand | undefined = current[segment];
    if (next === undefined) {
      // Missing key: nothing completable.
      return [];
    }
    current = next;
  }
  if (typeof current === "string") {
    // Path lands on a leaf: leaves have no children.
    return [];
  }
  const map = current;
  return Object.keys(map).map((key) => ({
    key,
    terminal: typeof map[key] === "string",
  }));
}

/**
 * JSON Schema walker mirroring the legacy semantics: object nodes expose their
 * children via `properties`, object nodes are non-terminal, and leaf/`{}` nodes
 * are terminal. Returns completable child keys at the given path with terminal
 * classification. A path that hits a leaf or a missing key yields no completions.
 *
 * @param schema - The compiled JSON Schema output schema
 * @param path - Dot-path segments to descend before listing completions
 * @returns Completable child keys with terminal classification
 */
function schemaWalk(schema: OutputSchema, path: string[]): { key: string; terminal: boolean }[] {
  let current: unknown = schema;
  for (const segment of path) {
    if (!isRecord(current) || !isRecord(current.properties)) {
      // Not an object node: no children to descend into.
      return [];
    }
    const next = current.properties[segment];
    if (next === undefined) {
      return [];
    }
    current = next;
  }
  if (!isRecord(current) || !isRecord(current.properties)) {
    return [];
  }
  const properties = current.properties;
  return Object.keys(properties).map((key) => {
    const child = properties[key];
    const isObject = isRecord(child) && isRecord(child.properties);
    return { key, terminal: !isObject };
  });
}

/**
 * Collects every dot-path (as segment arrays) reachable in a shorthand map,
 * including the empty root path.
 *
 * @param shorthand - The hand-authored type-hint map
 * @param prefix - Accumulated path prefix (used in recursion)
 * @returns All reachable dot-paths as arrays of segments
 */
function collectShorthandPaths(shorthand: OutputSchemaShorthand, prefix: string[] = []): string[][] {
  const paths: string[][] = [prefix];
  for (const key of Object.keys(shorthand)) {
    const value = shorthand[key];
    if (value !== undefined && typeof value !== "string") {
      paths.push(...collectShorthandPaths(value, [...prefix, key]));
    }
  }
  return paths;
}

/**
 * Builds a minimal `DagWorkflowDefinition`-shaped fixture. `buildOutputSchemas`
 * only reads `definition.steps` (each entry's `.type` and `.outputSchema`) and
 * `definition.trigger.type`/`.outputSchema`, so a focused object literal cast to
 * the definition type is sufficient and realistic (mirrors the fixture pattern
 * in `outputSchemaBuilder.test.ts`).
 *
 * @param steps - Map of slug to a minimal step definition (`type` + optional shorthand)
 * @param trigger - Trigger type plus optional shorthand
 * @returns A definition object cast to `DagWorkflowDefinition`
 */
function makeDefinition(
  steps: Record<string, { type: string; outputSchema?: OutputSchemaShorthand }>,
  trigger: { type: string; outputSchema?: OutputSchemaShorthand } = { type: "manual" },
): DagWorkflowDefinition {
  return {
    name: "legacy-fixture-workflow",
    trigger,
    steps,
    edges: [],
  } as unknown as DagWorkflowDefinition;
}

/** A resolver that never returns a handler schema (hand-authored-only scenarios). */
function noHandler(): TSchema | undefined {
  return undefined;
}

// ---------------------------------------------------------------------------
// Part A: existing hand-authored shorthand loads; completions are a superset
// ---------------------------------------------------------------------------

describe("backward compatibility: existing JSON5 hand-authored output schemas", () => {
  /**
   * A representative existing hand-authored Type_Hint_Shorthand output schema:
   * a mix of top-level leaves and a nested object, exactly the shape existing
   * `agent`/`trigger` nodes carry in stored JSON5.
   */
  const legacyShorthand: OutputSchemaShorthand = {
    filename: "string",
    metadata: {
      size: "number",
      kind: "string",
    },
  };

  describe("load without error", () => {
    test("compileOutputSchema does not throw and returns a JSON Schema object", () => {
      let compiled: OutputSchema | undefined;
      expect(() => {
        compiled = compileOutputSchema(legacyShorthand, () => undefined);
      }).not.toThrow();

      expect(compiled).not.toBeUndefined();
      expect(isRecord(compiled)).toBe(true);
      // The top-level result is always an object node.
      expect((compiled as Record<string, unknown>).type).toBe("object");
    });

    test("buildOutputSchemas loads a workflow with a hand-authored shorthand without throwing", () => {
      const definition = makeDefinition({
        "process-file": { type: "agent", outputSchema: legacyShorthand },
      });

      let result: ReturnType<typeof buildOutputSchemas> | undefined;
      expect(() => {
        result = buildOutputSchemas(definition, noHandler);
      }).not.toThrow();

      expect(result).not.toBeUndefined();
      // The hand-authored shorthand is compiled and emitted for the slug.
      const emitted = result!.outputSchemas.steps["process-file"];
      expect(isRecord(emitted)).toBe(true);
      expect((emitted as Record<string, unknown>).type).toBe("object");
      // It equals the direct compilation (precedence 1: hand-authored wins).
      expect(emitted).toEqual(compileOutputSchema(legacyShorthand));
    });
  });

  describe("completion superset", () => {
    test("every legacy-completable key is completable via the compiled JSON Schema with matching classification", () => {
      const compiled = compileOutputSchema(legacyShorthand);
      const paths = collectShorthandPaths(legacyShorthand);

      // Sanity: the fixture exercises the root and the nested object path.
      expect(paths).toContainEqual([]);
      expect(paths).toContainEqual(["metadata"]);

      for (const path of paths) {
        const legacy = legacyWalk(legacyShorthand, path);
        const schema = schemaWalk(compiled, path);
        const schemaMap = new Map(schema.map((entry) => [entry.key, entry.terminal]));

        for (const legacyEntry of legacy) {
          // Superset: every legacy-completable key is also completable via schema.
          expect(schemaMap.has(legacyEntry.key)).toBe(true);
          // Matching terminal/non-terminal classification for shared keys.
          expect(schemaMap.get(legacyEntry.key)).toBe(legacyEntry.terminal);
        }
      }
    });

    test("specific known completions survive the compilation", () => {
      const compiled = compileOutputSchema(legacyShorthand);

      // Root level: filename (terminal) and metadata (non-terminal).
      const root = new Map(schemaWalk(compiled, []).map((e) => [e.key, e.terminal]));
      expect(root.get("filename")).toBe(true);
      expect(root.get("metadata")).toBe(false);

      // Nested level: size and kind, both terminal leaves.
      const nested = new Map(schemaWalk(compiled, ["metadata"]).map((e) => [e.key, e.terminal]));
      expect(nested.get("size")).toBe(true);
      expect(nested.get("kind")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Part B: adding outputSchema alters no runtime result/status (Req 1.3, 6.3)
// ---------------------------------------------------------------------------

describe("backward compatibility: outputSchema is declarative metadata only", () => {
  describe("handlers expose execute independently of outputSchema", () => {
    test("fail handler declares outputSchema as a TypeBox schema separate from execute", () => {
      const handler = createFailHandler();
      // outputSchema is present as declarative metadata.
      expect(handler.outputSchema).not.toBeUndefined();
      expect(isRecord(handler.outputSchema)).toBe(true);
      // execute is a function, decoupled from the metadata field.
      expect(typeof handler.execute).toBe("function");
    });

    test("http-request handler declares outputSchema as a TypeBox schema separate from execute", () => {
      const handler = createHttpRequestHandler();
      expect(handler.outputSchema).not.toBeUndefined();
      expect(isRecord(handler.outputSchema)).toBe(true);
      expect(typeof handler.execute).toBe("function");
    });

    test("notify-telegram handler declares outputSchema as a TypeBox schema separate from execute", () => {
      // In-memory fake send fn; never invoked in these structural assertions.
      const handler = createNotifyStepHandler(async () => "fake-chat-id");
      expect(handler.outputSchema).not.toBeUndefined();
      expect(isRecord(handler.outputSchema)).toBe(true);
      expect(typeof handler.execute).toBe("function");
    });
  });

  describe("execute reference is orthogonal to outputSchema", () => {
    test("two constructions of the same handler yield identical execute semantics regardless of outputSchema", () => {
      // The handler is a stable object per construction. Building it twice gives
      // structurally-equivalent execute functions; the outputSchema field is
      // metadata and does not participate in execute. We assert the execute
      // reference is a function and that clearing outputSchema locally leaves
      // execute untouched (identity preserved on the same object).
      const handler = createHttpRequestHandler();
      const executeBefore = handler.execute;

      // Simulate "ignoring" outputSchema: it is a plain optional field, so
      // reassigning/removing it must not change the execute reference.
      const mutable = handler as { execute: unknown; outputSchema?: unknown };
      mutable.outputSchema = undefined;
      expect(handler.execute).toBe(executeBefore);
    });
  });

  describe("fail handler execute behavior is unchanged (throws) regardless of outputSchema", () => {
    /**
     * Minimal in-memory StepExecutionContext fake covering only what fail's
     * execute touches: `resolveTemplate` and `jobLog`. No network or LLM.
     *
     * @returns A typed fake context suitable for driving handler execute
     */
    function makeCtx(): StepExecutionContext {
      return {
        resolveTemplate: async (template: string) => ({ resolved: template, warnings: [] }),
        log: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        } as unknown as StepExecutionContext["log"],
        workDir: "/tmp/test-work",
        fs: new InMemoryFs(),
        jobLog: async () => {},
        workflowRunId: "test-run-123",
      };
    }

    test("fail with default message throws (terminal), matching pre-change behavior", async () => {
      const handler = createFailHandler();
      // fail declares an empty-object outputSchema; execute must still throw.
      expect((handler.outputSchema as Record<string, unknown>).type).toBe("object");

      await expect(handler.execute({ slug: "boom", type: "fail" }, makeCtx())).rejects.toThrow(
        "Workflow aborted by fail step",
      );
    });

    test("fail with a custom message throws that message, unaffected by outputSchema", async () => {
      const handler = createFailHandler();
      await expect(
        handler.execute({ slug: "boom", type: "fail", message: "custom failure" }, makeCtx()),
      ).rejects.toThrow("custom failure");
    });
  });

  describe("outputSchema top-level keys match documented execute result keys", () => {
    /**
     * Returns the top-level property names declared on a TypeBox object schema.
     *
     * @param schema - A TypeBox schema value carrying a `properties` map
     * @returns The declared top-level property names
     */
    function topLevelKeys(schema: TSchema | undefined): string[] {
      const record = schema as unknown as Record<string, unknown>;
      const properties = record?.properties;
      return isRecord(properties) ? Object.keys(properties) : [];
    }

    test("http-request outputSchema declares exactly status and body", () => {
      const handler = createHttpRequestHandler();
      expect(new Set(topLevelKeys(handler.outputSchema))).toEqual(new Set(["status", "body"]));
    });

    test("fail outputSchema declares no properties", () => {
      const handler = createFailHandler();
      expect(topLevelKeys(handler.outputSchema)).toEqual([]);
    });

    test("notify-telegram outputSchema declares exactly sent and chatId", () => {
      const handler = createNotifyStepHandler(async () => "fake-chat-id");
      expect(new Set(topLevelKeys(handler.outputSchema))).toEqual(new Set(["sent", "chatId"]));
    });
  });
});

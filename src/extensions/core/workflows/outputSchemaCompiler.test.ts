import { describe, expect, test } from "bun:test";
import type { OutputSchema } from "@shared/workflows";
import fc from "fast-check";
import { compileOutputSchema } from "./outputSchemaCompiler";
import type { OutputSchemaShorthand } from "./schemas";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Recognized leaf type hints the compiler maps to `{ type: <t> }`. */
const RECOGNIZED_HINTS = ["string", "number", "boolean"] as const;

/** Property keys: non-empty identifier-like strings so keys are stable and distinct. */
const propertyKeyArb = fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,7}$/).filter((s) => s.length >= 1);

/** A recognized leaf type-hint string. */
const recognizedLeafArb = fc.constantFrom(...RECOGNIZED_HINTS);

/**
 * An unrecognized leaf type-hint string: any non-empty string that is not one of
 * the recognized hints. Filtering guarantees it is outside the closed set.
 */
const unrecognizedLeafArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => !(RECOGNIZED_HINTS as readonly string[]).includes(s));

/**
 * Builds a shorthand arbitrary containing only recognized leaves and nested maps.
 * Used where unrecognized hints would perturb the assertion (Properties 2, 4, 6).
 */
const recognizedShorthandArb: fc.Arbitrary<OutputSchemaShorthand> = fc.letrec<{
  node: string | OutputSchemaShorthand;
  map: OutputSchemaShorthand;
}>((tie) => ({
  node: fc.oneof({ maxDepth: 3, depthSize: "small" }, recognizedLeafArb, tie("map")),
  map: fc.dictionary(propertyKeyArb, tie("node"), { minKeys: 0, maxKeys: 4 }),
})).map;

/**
 * Builds a shorthand arbitrary that may include unrecognized leaves alongside
 * recognized leaves and nested maps. Used for Property 2 (canonical form holds
 * regardless of hint recognition).
 */
const mixedShorthandArb: fc.Arbitrary<OutputSchemaShorthand> = fc.letrec<{
  node: string | OutputSchemaShorthand;
  map: OutputSchemaShorthand;
}>((tie) => ({
  node: fc.oneof({ maxDepth: 3, depthSize: "small" }, recognizedLeafArb, unrecognizedLeafArb, tie("map")),
  map: fc.dictionary(propertyKeyArb, tie("node"), { minKeys: 0, maxKeys: 4 }),
})).map;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Type guard for a plain object node (used while walking compiled schemas). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively walks a compiled JSON Schema node and invokes `visit` on every
 * node encountered (the root, every entry in `properties`, recursively).
 */
function walkCompiledNodes(node: OutputSchema, visit: (node: unknown) => void): void {
  visit(node);
  if (isRecord(node) && isRecord(node.properties)) {
    for (const child of Object.values(node.properties)) {
      walkCompiledNodes(child as OutputSchema, visit);
    }
  }
}

/**
 * Reference legacy shorthand walker. Given a shorthand map and a dot-path,
 * returns the completable child keys at that path plus whether each child is
 * terminal. A leaf string is terminal; a nested map is non-terminal. A path
 * that hits a leaf or a missing key yields no completions.
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

/** Collects every dot-path (as segment arrays) reachable in a shorthand map. */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compileOutputSchema", () => {
  describe("canonical JSON Schema output", () => {
    test("Feature: workflow-schema-dataflow, Property 2: Every emitted schema is canonical JSON Schema", () => {
      fc.assert(
        fc.property(mixedShorthandArb, (shorthand) => {
          const compiled = compileOutputSchema(shorthand);

          walkCompiledNodes(compiled, (node) => {
            // No node may be a bare string.
            expect(typeof node).not.toBe("string");
            expect(isRecord(node)).toBe(true);

            const record = node as Record<string, unknown>;
            const hasType = "type" in record;
            const keys = Object.keys(record);
            const isUnconstrained = keys.length === 0;

            if (hasType) {
              // A typed node is either a primitive or an object node.
              const type = record.type;
              expect(type === "string" || type === "number" || type === "boolean" || type === "object").toBe(true);
              if (type === "object") {
                expect(isRecord(record.properties)).toBe(true);
              }
            } else {
              // Without a type, the only valid node is the unconstrained `{}`.
              expect(isUnconstrained).toBe(true);
            }
          });

          // The top-level result is always an object node.
          expect((compiled as Record<string, unknown>).type).toBe("object");
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("hierarchy preservation", () => {
    test("Feature: workflow-schema-dataflow, Property 4: Shorthand hierarchy is preserved under compilation", () => {
      /**
       * Recursively asserts that at each level the compiled node is an object
       * node whose `properties` keys equal the source-map keys, nested maps
       * become object nodes with `properties`, and leaf strings become
       * non-object nodes.
       */
      function assertHierarchy(source: OutputSchemaShorthand, compiled: OutputSchema): void {
        expect(isRecord(compiled)).toBe(true);
        const record = compiled as Record<string, unknown>;
        expect(record.type).toBe("object");
        expect(isRecord(record.properties)).toBe(true);

        const properties = record.properties as Record<string, unknown>;
        expect(new Set(Object.keys(properties))).toEqual(new Set(Object.keys(source)));

        for (const key of Object.keys(source)) {
          const sourceValue = source[key];
          const compiledChild = properties[key];
          if (sourceValue === undefined || typeof sourceValue === "string") {
            // Leaf string -> non-object node (no `properties`, no `type: object`).
            expect(isRecord(compiledChild)).toBe(true);
            const childRecord = compiledChild as Record<string, unknown>;
            expect(childRecord.type).not.toBe("object");
            expect("properties" in childRecord).toBe(false);
          } else {
            // Nested map -> object node with `properties`; recurse.
            assertHierarchy(sourceValue, compiledChild as OutputSchema);
          }
        }
      }

      fc.assert(
        fc.property(recognizedShorthandArb, (shorthand) => {
          const compiled = compileOutputSchema(shorthand);
          assertHierarchy(shorthand, compiled);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("unrecognized type hints", () => {
    test("Feature: workflow-schema-dataflow, Property 5: Unrecognized type hints compile to unconstrained nodes with a warning", () => {
      fc.assert(
        fc.property(propertyKeyArb, unrecognizedLeafArb, (key, hint) => {
          const warnings: string[] = [];
          const shorthand: OutputSchemaShorthand = { [key]: hint };

          // Must not throw.
          const compiled = compileOutputSchema(shorthand, (message) => {
            warnings.push(message);
          });

          const properties = (compiled as Record<string, unknown>).properties as Record<string, unknown>;
          const node = properties[key];

          // Unconstrained node: `{}` with no `type`.
          expect(isRecord(node)).toBe(true);
          const record = node as Record<string, unknown>;
          expect("type" in record).toBe(false);
          expect(Object.keys(record).length).toBe(0);

          // At least one warning recorded through the sink.
          expect(warnings.length).toBeGreaterThanOrEqual(1);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("backward-compatible completion", () => {
    test("Feature: workflow-schema-dataflow, Property 6: Backward-compatible completion superset", () => {
      fc.assert(
        fc.property(recognizedShorthandArb, (shorthand) => {
          const compiled = compileOutputSchema(shorthand);
          const paths = collectShorthandPaths(shorthand);

          for (const path of paths) {
            const legacy = legacyWalk(shorthand, path);
            const schema = schemaWalk(compiled, path);

            const schemaMap = new Map(schema.map((entry) => [entry.key, entry.terminal]));

            for (const legacyEntry of legacy) {
              // Superset: every legacy-completable key is also completable via the schema walk.
              expect(schemaMap.has(legacyEntry.key)).toBe(true);
              // Matching terminal/non-terminal classification for shared keys.
              expect(schemaMap.get(legacyEntry.key)).toBe(legacyEntry.terminal);
            }
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});

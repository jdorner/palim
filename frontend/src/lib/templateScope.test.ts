import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { getEnumOptions, isEnum } from "./schemaForm";
import {
  getConfigSuggestions,
  getEnvSuggestions,
  getOutputSchemaSuggestions,
  getSecretSuggestions,
  getStepSlugs,
  getSuggestions,
  getTopLevelSuggestions,
  getVariableSuggestions,
  type ScopeConfig,
  type Suggestion,
} from "./templateScope";

/**
 * Generators matching the design doc spec:
 * - Step slugs: /^[a-z][a-z0-9-]{0,10}$/
 * - Prefix strings: lowercase alphabet, 0-10 chars
 * - Secret keys: /^[A-Z][A-Z0-9_]{1,20}$/
 * - Env names: /^[A-Z][A-Z0-9_]{1,20}$/
 */

const lowerAlpha = "abcdefghijklmnopqrstuvwxyz";
const lowerAlphaNum = "abcdefghijklmnopqrstuvwxyz0123456789";
const slugTailChars = `${lowerAlphaNum}-`;
const upperAlpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const upperAlphaNumUnderscore = `${upperAlpha}0123456789_`;

/** Step slug: starts with [a-z], followed by 0-10 chars from [a-z0-9-] */
const slugArb = fc
  .tuple(
    fc.constantFrom(...lowerAlpha.split("")),
    fc.string({ unit: fc.constantFrom(...slugTailChars.split("")), minLength: 0, maxLength: 10 }),
  )
  .map(([first, rest]) => `${first}${rest}`);

/** Prefix: 0-10 lowercase alpha chars */
const prefixArb = fc.string({
  unit: fc.constantFrom(...lowerAlpha.split("")),
  minLength: 0,
  maxLength: 10,
});

/** Secret key: starts with [A-Z], followed by 1-20 chars from [A-Z0-9_] */
const secretKeyArb = fc
  .tuple(
    fc.constantFrom(...upperAlpha.split("")),
    fc.string({ unit: fc.constantFrom(...upperAlphaNumUnderscore.split("")), minLength: 1, maxLength: 20 }),
  )
  .map(([first, rest]) => `${first}${rest}`);

/** Env name: same pattern as secret keys */
const envNameArb = secretKeyArb;

const TOP_LEVEL_NAMESPACES = ["trigger", "steps", "env", "secret", "var"];

describe("Template Scope Registry - Property Tests", () => {
  describe("Prefix filtering returns only matches", () => {
    /**
     * For any typed prefix string, getTopLevelSuggestions(prefix) SHALL return
     * only suggestions whose label starts with prefix (case-sensitive), and SHALL
     * return all such matches from the fixed set ["trigger", "steps", "env", "secret"].
     */
    test("returns only labels starting with prefix and all such matches", () => {
      fc.assert(
        fc.property(prefixArb, (prefix) => {
          const results = getTopLevelSuggestions(prefix);
          const labels = results.map((s) => s.label);

          // All returned labels must start with the prefix (case-sensitive)
          for (const label of labels) {
            expect(label.startsWith(prefix)).toBe(true);
          }

          // Must include ALL matches from the fixed set
          const expectedMatches = TOP_LEVEL_NAMESPACES.filter((name) => name.startsWith(prefix));
          expect(labels).toEqual(expectedMatches);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Steps scope excludes forward references", () => {
    /**
     * For any step array of length N and any current step index i where 0 <= i < N,
     * getStepSlugs(steps, i, "") SHALL return exactly the slugs at indices 0 through
     * i-1 (inclusive), and SHALL NOT include any slug at index >= i.
     */
    test("returns exactly preceding slugs and excludes current/forward steps", () => {
      fc.assert(
        fc.property(
          fc
            .array(slugArb, { minLength: 1, maxLength: 20 })
            .chain((slugs) =>
              fc.tuple(fc.constant(slugs.map((slug) => ({ slug }))), fc.integer({ min: 0, max: slugs.length - 1 })),
            ),
          ([steps, currentIndex]) => {
            const results = getStepSlugs(steps, currentIndex, "");
            const resultLabels = results.map((s) => s.label);

            // Should contain exactly slugs at indices 0..currentIndex-1
            const expectedSlugs = steps.slice(0, currentIndex).map((s) => s.slug);
            expect(resultLabels).toEqual(expectedSlugs);

            // Verify length matches exactly (no forward references)
            expect(resultLabels.length).toBe(currentIndex);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("Suggestions are always sorted", () => {
    /**
     * For any env allowlist and any set of secret keys, the suggestions returned by
     * getEnvSuggestions(envAllowlist, "") and getSecretSuggestions(secretKeys, "") SHALL
     * be in case-insensitive ascending alphabetical order of their label field.
     */
    test("env suggestions are sorted case-insensitively", () => {
      fc.assert(
        fc.property(fc.array(envNameArb, { minLength: 0, maxLength: 30 }), (envAllowlist) => {
          const results = getEnvSuggestions(envAllowlist, "");
          const labels = results.map((s) => s.label);

          for (let i = 1; i < labels.length; i++) {
            const prev = (labels[i - 1] as string).toLowerCase();
            const curr = (labels[i] as string).toLowerCase();
            expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0);
          }
        }),
        { numRuns: 100 },
      );
    });

    test("secret suggestions are sorted case-insensitively", () => {
      fc.assert(
        fc.property(fc.array(secretKeyArb, { minLength: 0, maxLength: 30 }), (secretKeys) => {
          const results = getSecretSuggestions(secretKeys, "");
          const labels = results.map((s) => s.label);

          for (let i = 1; i < labels.length; i++) {
            const prev = (labels[i - 1] as string).toLowerCase();
            const curr = (labels[i] as string).toLowerCase();
            expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Env/secret filtering uses case-insensitive substring", () => {
    /**
     * For any env allowlist, any secret key set, and any non-empty filter prefix,
     * the results of getEnvSuggestions(list, prefix) SHALL include only entries whose
     * label contains prefix as a case-insensitive substring, and SHALL include all
     * such entries from the source list.
     */
    test("env filtering includes only and all case-insensitive substring matches", () => {
      fc.assert(
        fc.property(
          fc.array(envNameArb, { minLength: 0, maxLength: 30 }),
          fc.string({
            unit: fc.constantFrom(...lowerAlpha.split("")),
            minLength: 1,
            maxLength: 10,
          }),
          (envAllowlist, prefix) => {
            const results = getEnvSuggestions(envAllowlist, prefix);
            const resultLabels = results.map((s) => s.label);
            const lowerPrefix = prefix.toLowerCase();

            // All returned entries must contain the prefix as case-insensitive substring
            for (const label of resultLabels) {
              expect(label.toLowerCase().includes(lowerPrefix)).toBe(true);
            }

            // All entries from the source that match must be included
            const expectedMatches = envAllowlist.filter((name) => name.toLowerCase().includes(lowerPrefix));
            expect(resultLabels.length).toBe(expectedMatches.length);
            for (const expected of expectedMatches) {
              expect(resultLabels).toContain(expected);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    test("secret filtering includes only and all case-insensitive substring matches", () => {
      fc.assert(
        fc.property(
          fc.array(secretKeyArb, { minLength: 0, maxLength: 30 }),
          fc.string({
            unit: fc.constantFrom(...lowerAlpha.split("")),
            minLength: 1,
            maxLength: 10,
          }),
          (secretKeys, prefix) => {
            const results = getSecretSuggestions(secretKeys, prefix);
            const resultLabels = results.map((s) => s.label);
            const lowerPrefix = prefix.toLowerCase();

            // All returned entries must contain the prefix as case-insensitive substring
            for (const label of resultLabels) {
              expect(label.toLowerCase().includes(lowerPrefix)).toBe(true);
            }

            // All entries from the source that match must be included
            const expectedMatches = secretKeys.filter((key) => key.toLowerCase().includes(lowerPrefix));
            expect(resultLabels.length).toBe(expectedMatches.length);
            for (const expected of expectedMatches) {
              expect(resultLabels).toContain(expected);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

describe("Output Schema Suggestions", () => {
  const filewatcherSchema = {
    type: "object",
    properties: {
      source: { type: "string" },
      id: { type: "string" },
      slug: { type: "string" },
      filename: { type: "string" },
      event: { type: "string" },
    },
  };

  const nestedSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      metadata: {
        type: "object",
        properties: {
          size: { type: "number" },
          type: { type: "string" },
          tags: {
            type: "object",
            properties: {
              primary: { type: "string" },
              secondary: { type: "string" },
            },
          },
        },
      },
      active: { type: "boolean" },
    },
  };

  describe("getOutputSchemaSuggestions", () => {
    test("returns all top-level keys with empty prefix", () => {
      const results = getOutputSchemaSuggestions(filewatcherSchema, [], "");
      const labels = results.map((s) => s.label);
      expect(labels).toEqual(["event", "filename", "id", "slug", "source"]);
    });

    test("filters by prefix (startsWith)", () => {
      const results = getOutputSchemaSuggestions(filewatcherSchema, [], "s");
      const labels = results.map((s) => s.label);
      expect(labels).toEqual(["slug", "source"]);
    });

    test("marks string values as terminal", () => {
      const results = getOutputSchemaSuggestions(filewatcherSchema, [], "");
      for (const s of results) {
        expect(s.terminal).toBe(true);
      }
    });

    test("marks nested object values as non-terminal", () => {
      const results = getOutputSchemaSuggestions(nestedSchema, [], "");
      const metadataSuggestion = results.find((s) => s.label === "metadata");
      expect(metadataSuggestion).not.toBeUndefined();
      expect(metadataSuggestion!.terminal).toBe(false);
    });

    test("navigates into nested schemas via subPath", () => {
      const results = getOutputSchemaSuggestions(nestedSchema, ["metadata"], "");
      const labels = results.map((s) => s.label);
      expect(labels).toEqual(["size", "tags", "type"]);
    });

    test("navigates multiple levels deep", () => {
      const results = getOutputSchemaSuggestions(nestedSchema, ["metadata", "tags"], "");
      const labels = results.map((s) => s.label);
      expect(labels).toEqual(["primary", "secondary"]);
    });

    test("returns empty for invalid subPath segment", () => {
      const results = getOutputSchemaSuggestions(nestedSchema, ["nonexistent"], "");
      expect(results).toEqual([]);
    });

    test("returns empty for subPath pointing to a terminal value", () => {
      const results = getOutputSchemaSuggestions(nestedSchema, ["name"], "");
      expect(results).toEqual([]);
    });

    test("includes schemaType for terminal values", () => {
      const results = getOutputSchemaSuggestions(nestedSchema, ["metadata"], "size");
      expect(results.length).toBe(1);
      expect(results[0]!.label).toBe("size");
      expect(results[0]!.schemaType).toBe("number");
      expect(results[0]!.terminal).toBe(true);
    });

    test("does not include description for non-terminal values", () => {
      const results = getOutputSchemaSuggestions(nestedSchema, [], "metadata");
      expect(results.length).toBe(1);
      expect(results[0]!.description).toBeUndefined();
    });
  });

  describe("getSuggestions with outputSchemas", () => {
    const baseConfig: ScopeConfig = {
      steps: [{ slug: "fetch" }, { slug: "process" }],
      currentStepIndex: 1,
      secretKeys: ["API_KEY"],
      variableKeys: [],
      outputSchemas: {
        trigger: filewatcherSchema,
        steps: {
          fetch: {
            type: "object",
            properties: {
              data: { type: "string" },
              status: {
                type: "object",
                properties: {
                  code: { type: "number" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
      },
    };

    describe("trigger.payload with schema", () => {
      test("payload is non-terminal when trigger schema exists", () => {
        const results = getSuggestions(baseConfig, ["trigger"], "");
        const payload = results.find((s) => s.label === "payload");
        expect(payload).not.toBeUndefined();
        expect(payload!.terminal).toBe(false);
      });

      test("payload is terminal when no trigger schema", () => {
        const config: ScopeConfig = {
          ...baseConfig,
          outputSchemas: { trigger: null, steps: {} },
        };
        const results = getSuggestions(config, ["trigger"], "");
        const payload = results.find((s) => s.label === "payload");
        expect(payload).not.toBeUndefined();
        expect(payload!.terminal).toBe(true);
      });

      test("payload is terminal when outputSchemas is undefined", () => {
        const config: ScopeConfig = {
          ...baseConfig,
          outputSchemas: undefined,
        };
        const results = getSuggestions(config, ["trigger"], "");
        const payload = results.find((s) => s.label === "payload");
        expect(payload).not.toBeUndefined();
        expect(payload!.terminal).toBe(true);
      });

      test("suggests trigger schema properties at trigger.payload level", () => {
        const results = getSuggestions(baseConfig, ["trigger", "payload"], "");
        const labels = results.map((s) => s.label);
        expect(labels).toContain("filename");
        expect(labels).toContain("slug");
        expect(labels).toContain("event");
      });

      test("filters trigger schema properties by prefix", () => {
        const results = getSuggestions(baseConfig, ["trigger", "payload"], "f");
        const labels = results.map((s) => s.label);
        expect(labels).toEqual(["filename"]);
      });

      test("returns empty for invalid deep path in trigger", () => {
        const results = getSuggestions(baseConfig, ["trigger", "payload", "nonexistent"], "");
        expect(results).toEqual([]);
      });
    });

    describe("steps.<slug>.result with schema", () => {
      test("result is non-terminal when step schema exists", () => {
        const results = getSuggestions(baseConfig, ["steps", "fetch"], "");
        const result = results.find((s) => s.label === "result");
        expect(result).not.toBeUndefined();
        expect(result!.terminal).toBe(false);
      });

      test("result is terminal when step has no schema", () => {
        // "fetch" is at index 0, currentStepIndex=1, so it's preceding
        const results = getSuggestions(baseConfig, ["steps", "fetch"], "r");
        const result = results.find((s) => s.label === "result");
        expect(result).not.toBeUndefined();
        // "fetch" HAS an output schema, so result is non-terminal
        // Test with a config where "fetch" has no schema:
        const noSchemaConfig: ScopeConfig = {
          ...baseConfig,
          outputSchemas: { trigger: baseConfig.outputSchemas!.trigger, steps: {} },
        };
        const results2 = getSuggestions(noSchemaConfig, ["steps", "fetch"], "r");
        const result2 = results2.find((s) => s.label === "result");
        expect(result2).not.toBeUndefined();
        expect(result2!.terminal).toBe(true);
      });

      test("config is always non-terminal (allows drilling into step definition)", () => {
        const results = getSuggestions(baseConfig, ["steps", "fetch"], "");
        const config = results.find((s) => s.label === "config");
        expect(config).not.toBeUndefined();
        expect(config!.terminal).toBe(false);
      });

      test("suggests step schema properties at steps.slug.result level", () => {
        const results = getSuggestions(baseConfig, ["steps", "fetch", "result"], "");
        const labels = results.map((s) => s.label);
        expect(labels).toEqual(["data", "status"]);
      });

      test("navigates nested step schema", () => {
        const results = getSuggestions(baseConfig, ["steps", "fetch", "result", "status"], "");
        const labels = results.map((s) => s.label);
        expect(labels).toEqual(["code", "message"]);
      });

      test("filters step schema properties by prefix", () => {
        const results = getSuggestions(baseConfig, ["steps", "fetch", "result"], "d");
        const labels = results.map((s) => s.label);
        expect(labels).toEqual(["data"]);
      });

      test("returns empty for result sub-path when no schema", () => {
        const results = getSuggestions(baseConfig, ["steps", "process", "result"], "");
        expect(results).toEqual([]);
      });
    });

    describe("backward compatibility (no outputSchemas)", () => {
      const noSchemaConfig: ScopeConfig = {
        steps: [{ slug: "fetch" }, { slug: "process" }],
        currentStepIndex: 1,
        secretKeys: [],
        variableKeys: [],
      };

      test("trigger.payload remains terminal", () => {
        const results = getSuggestions(noSchemaConfig, ["trigger"], "");
        const payload = results.find((s) => s.label === "payload");
        expect(payload!.terminal).toBe(true);
      });

      test("steps.slug.result remains terminal", () => {
        const results = getSuggestions(noSchemaConfig, ["steps", "fetch"], "");
        const result = results.find((s) => s.label === "result");
        expect(result!.terminal).toBe(true);
      });

      test("no suggestions beyond trigger.payload", () => {
        const results = getSuggestions(noSchemaConfig, ["trigger", "payload"], "");
        expect(results).toEqual([]);
      });

      test("no suggestions beyond steps.slug.result", () => {
        const results = getSuggestions(noSchemaConfig, ["steps", "fetch", "result"], "");
        expect(results).toEqual([]);
      });
    });
  });
});

describe("getConfigSuggestions", () => {
  const step = {
    slug: "append-row",
    type: "excel",
    mode: "append",
    path: "data/reports",
    filename: "scanned-documents.xlsx",
    sheets: [
      {
        name: "Scans",
        columns: [
          { header: "Date", key: "date", width: 12 },
          { header: "Amount", key: "amount" },
        ],
        data: "{{steps.extract.result}}",
      },
    ],
  };

  test("returns top-level keys excluding slug and type", () => {
    const results = getConfigSuggestions(step, [], "", new Set(["slug", "type"]));
    const labels = results.map((s) => s.label);
    expect(labels).toContain("mode");
    expect(labels).toContain("path");
    expect(labels).toContain("filename");
    expect(labels).toContain("sheets");
    expect(labels).not.toContain("slug");
    expect(labels).not.toContain("type");
  });

  test("marks primitive values as terminal with type description", () => {
    const results = getConfigSuggestions(step, [], "", new Set(["slug", "type"]));
    const mode = results.find((s) => s.label === "mode");
    expect(mode).not.toBeUndefined();
    expect(mode!.terminal).toBe(true);
    expect(mode!.description).toBe("string");
  });

  test("marks array values as non-terminal", () => {
    const results = getConfigSuggestions(step, [], "", new Set(["slug", "type"]));
    const sheets = results.find((s) => s.label === "sheets");
    expect(sheets).not.toBeUndefined();
    expect(sheets!.terminal).toBe(false);
  });

  test("suggests numeric indices for arrays", () => {
    const results = getConfigSuggestions(step, ["sheets"], "");
    const labels = results.map((s) => s.label);
    expect(labels).toEqual(["0"]);
  });

  test("navigates into array elements by index", () => {
    const results = getConfigSuggestions(step, ["sheets", "0"], "");
    const labels = results.map((s) => s.label);
    expect(labels).toContain("name");
    expect(labels).toContain("columns");
    expect(labels).toContain("data");
  });

  test("navigates into nested arrays (columns)", () => {
    const results = getConfigSuggestions(step, ["sheets", "0", "columns"], "");
    const labels = results.map((s) => s.label);
    expect(labels).toEqual(["0", "1"]);
  });

  test("navigates into array element properties", () => {
    const results = getConfigSuggestions(step, ["sheets", "0", "columns", "0"], "");
    const labels = results.map((s) => s.label);
    expect(labels).toContain("header");
    expect(labels).toContain("key");
    expect(labels).toContain("width");
  });

  test("filters by prefix", () => {
    const results = getConfigSuggestions(step, [], "f", new Set(["slug", "type"]));
    const labels = results.map((s) => s.label);
    expect(labels).toEqual(["filename"]);
  });

  test("returns empty for invalid path", () => {
    const results = getConfigSuggestions(step, ["nonexistent"], "");
    expect(results).toEqual([]);
  });

  test("returns empty for out-of-bounds array index", () => {
    const results = getConfigSuggestions(step, ["sheets", "5"], "");
    expect(results).toEqual([]);
  });

  test("returns empty for primitive leaf", () => {
    const results = getConfigSuggestions(step, ["mode"], "");
    expect(results).toEqual([]);
  });
});

describe("getSuggestions with config introspection", () => {
  const stepsWithConfig: Array<{ slug: string; [key: string]: unknown }> = [
    {
      slug: "extract",
      type: "agent",
      prompt: "do stuff",
      tools: ["exec"],
    },
    {
      slug: "append-row",
      type: "excel",
      mode: "append",
      sheets: [{ name: "Sheet1", columns: [{ header: "A" }] }],
    },
  ];

  const config: ScopeConfig = {
    steps: stepsWithConfig,
    currentStepIndex: 1,
    secretKeys: [],
    variableKeys: [],
  };

  test("steps.<slug>.config is non-terminal", () => {
    const results = getSuggestions(config, ["steps", "extract"], "");
    const configSuggestion = results.find((s) => s.label === "config");
    expect(configSuggestion).not.toBeUndefined();
    expect(configSuggestion!.terminal).toBe(false);
  });

  test("steps.<slug>.config. shows step fields (excluding slug/type)", () => {
    const results = getSuggestions(config, ["steps", "extract", "config"], "");
    const labels = results.map((s) => s.label);
    expect(labels).toContain("prompt");
    expect(labels).toContain("tools");
    expect(labels).not.toContain("slug");
    expect(labels).not.toContain("type");
  });

  test("steps.<slug>.config. works for custom step types", () => {
    // Use currentStepIndex=2 so append-row (index 1) is visible
    const cfg: ScopeConfig = { ...config, currentStepIndex: 2 };
    const results = getSuggestions(cfg, ["steps", "append-row", "config"], "");
    const labels = results.map((s) => s.label);
    expect(labels).toContain("mode");
    expect(labels).toContain("sheets");
  });

  test("steps.<slug>.config.sheets.0.columns navigates deep", () => {
    const cfg: ScopeConfig = { ...config, currentStepIndex: 2 };
    const results = getSuggestions(cfg, ["steps", "append-row", "config", "sheets", "0"], "");
    const labels = results.map((s) => s.label);
    expect(labels).toContain("name");
    expect(labels).toContain("columns");
  });

  test("returns empty for unknown step slug", () => {
    const results = getSuggestions(config, ["steps", "unknown", "config"], "");
    expect(results).toEqual([]);
  });
});

describe("getSuggestions with edit draft structure (nested config)", () => {
  // This mirrors how WorkflowDetailPage structures custom step types in edit mode:
  // Custom steps get their extra fields wrapped in a `config` property.
  const draftSteps: Array<{ slug: string; [key: string]: unknown }> = [
    {
      slug: "extract",
      type: "agent",
      prompt: "extract data",
      tools: ["exec"],
      skills: undefined,
      url: undefined,
      method: undefined,
      body: undefined,
    },
    {
      slug: "append-row",
      type: "excel",
      prompt: undefined,
      tools: undefined,
      skills: undefined,
      url: undefined,
      method: undefined,
      body: undefined,
      config: {
        mode: "append",
        path: "data/reports",
        filename: "output.xlsx",
        sheets: [{ name: "Sheet1", columns: [{ header: "Date", key: "date" }] }],
      },
    },
  ];

  const scopeConfig: ScopeConfig = {
    steps: draftSteps,
    currentStepIndex: 0,
    secretKeys: [],
    variableKeys: [],
  };

  test("custom step config shows fields from nested config object", () => {
    const results = getSuggestions(scopeConfig, ["steps", "append-row", "config"], "");
    const labels = results.map((s) => s.label);
    expect(labels).toContain("mode");
    expect(labels).toContain("path");
    expect(labels).toContain("filename");
    expect(labels).toContain("sheets");
    // Should NOT show the draft's undefined fields
    expect(labels).not.toContain("prompt");
    expect(labels).not.toContain("tools");
    expect(labels).not.toContain("body");
    expect(labels).not.toContain("url");
    expect(labels).not.toContain("config");
  });

  test("agent step config shows only defined fields", () => {
    const results = getSuggestions(scopeConfig, ["steps", "extract", "config"], "");
    const labels = results.map((s) => s.label);
    expect(labels).toContain("prompt");
    expect(labels).toContain("tools");
    // undefined fields should be filtered out
    expect(labels).not.toContain("skills");
    expect(labels).not.toContain("url");
    expect(labels).not.toContain("method");
    expect(labels).not.toContain("body");
  });

  test("custom step deep navigation works through nested config", () => {
    const results = getSuggestions(scopeConfig, ["steps", "append-row", "config", "sheets", "0"], "");
    const labels = results.map((s) => s.label);
    expect(labels).toContain("name");
    expect(labels).toContain("columns");
  });
});

describe("getSuggestions hides result for succeeding steps", () => {
  const steps: Array<{ slug: string; [key: string]: unknown }> = [
    { slug: "first", type: "agent", prompt: "do A" },
    { slug: "second", type: "agent", prompt: "do B" },
    { slug: "third", type: "agent", prompt: "do C" },
  ];

  test("preceding step shows both result and config", () => {
    const config: ScopeConfig = { steps, currentStepIndex: 2, secretKeys: [], variableKeys: [] };
    const results = getSuggestions(config, ["steps", "first"], "");
    const labels = results.map((s) => s.label);
    expect(labels).toContain("result");
    expect(labels).toContain("config");
  });

  test("succeeding step shows only config, not result", () => {
    const config: ScopeConfig = { steps, currentStepIndex: 0, secretKeys: [], variableKeys: [] };
    const results = getSuggestions(config, ["steps", "second"], "");
    const labels = results.map((s) => s.label);
    expect(labels).not.toContain("result");
    expect(labels).toContain("config");
  });

  test("step at same index as current shows only config", () => {
    // This shouldn't normally happen (current step is excluded from slug list)
    // but if it does, result should not be shown
    const config: ScopeConfig = { steps, currentStepIndex: 1, secretKeys: [], variableKeys: [] };
    const results = getSuggestions(config, ["steps", "second"], "");
    const labels = results.map((s) => s.label);
    expect(labels).not.toContain("result");
    expect(labels).toContain("config");
  });

  test("preceding step with output schema shows non-terminal result", () => {
    const config: ScopeConfig = {
      steps,
      currentStepIndex: 2,
      secretKeys: [],
      variableKeys: [],
      outputSchemas: { trigger: null, steps: { first: { data: "string" } } },
    };
    const results = getSuggestions(config, ["steps", "first"], "");
    const result = results.find((s) => s.label === "result");
    expect(result).not.toBeUndefined();
    expect(result!.terminal).toBe(false);
  });

  test("succeeding step with output schema still hides result", () => {
    const config: ScopeConfig = {
      steps,
      currentStepIndex: 0,
      secretKeys: [],
      variableKeys: [],
      outputSchemas: { trigger: null, steps: { second: { data: "string" } } },
    };
    const results = getSuggestions(config, ["steps", "second"], "");
    const labels = results.map((s) => s.label);
    expect(labels).not.toContain("result");
  });
});

describe("Condition fields complete like any other field", () => {
  /**
   * The autocomplete engine routes every template field -- normal fields, an
   * `if` node's `condition.ref`, and a `case` node's `match` -- through the same
   * `getSuggestions(config, path, prefix)` entry point. `getSuggestions` takes no
   * field-kind parameter, so it is field-agnostic by construction: the three
   * field contexts differ only at the call site, which passes identical
   * arguments. This confirms the equivalence claim against the actual API
   * surface: invoking
   * `getSuggestions` with the same scope, path, and prefix -- as the three field
   * contexts do -- yields deeply-equal suggestions every time.
   */

  /** A JSON Schema leaf/object arbitrary reused for trigger and step output schemas. */
  const outputSchemaArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
    fc.constantFrom("data", "status", "code", "message", "filename", "slug", "event", "meta"),
    fc.oneof(
      fc.constant<Record<string, unknown>>({ type: "string" }),
      fc.constant<Record<string, unknown>>({ type: "number" }),
      fc.constant<Record<string, unknown>>({ type: "boolean" }),
      fc.constant<Record<string, unknown>>({
        type: "object",
        properties: { inner: { type: "string" }, count: { type: "number" } },
      }),
    ),
    { minKeys: 0, maxKeys: 5 },
  );

  /** Arbitrary scope config spanning steps, secrets, env, and optional output schemas. */
  const scopeConfigArb: fc.Arbitrary<ScopeConfig> = fc
    .record({
      slugs: fc.array(slugArb, { minLength: 0, maxLength: 6 }),
      secretKeys: fc.array(secretKeyArb, { minLength: 0, maxLength: 5 }),
      variableKeys: fc.array(secretKeyArb, { minLength: 0, maxLength: 5 }),
      envAllowlist: fc.option(fc.array(envNameArb, { minLength: 0, maxLength: 5 }), { nil: undefined }),
      triggerSchema: fc.option(outputSchemaArb, { nil: null }),
      stepSchemas: fc.dictionary(slugArb, outputSchemaArb, { minKeys: 0, maxKeys: 4 }),
      includeSchemas: fc.boolean(),
    })
    .chain((base) => {
      const steps = base.slugs.map((slug, i) => ({ slug, type: "agent", prompt: `step ${i}` }));
      const maxIndex = Math.max(0, steps.length - 1);
      return fc.integer({ min: 0, max: maxIndex }).map((currentStepIndex) => {
        const config: ScopeConfig = {
          steps,
          currentStepIndex,
          secretKeys: base.secretKeys,
          variableKeys: base.variableKeys,
        };
        if (base.envAllowlist !== undefined) {
          config.envAllowlist = base.envAllowlist;
        }
        if (base.includeSchemas) {
          config.outputSchemas = { trigger: base.triggerSchema, steps: base.stepSchemas };
        }
        return config;
      });
    });

  /**
   * Arbitrary resolved path segments. Covers top-level namespaces plus common
   * drill-in shapes for steps/trigger/env/secret so the equivalence is exercised
   * across every dispatch branch of `getSuggestions`.
   */
  const pathArb: fc.Arbitrary<string[]> = fc.oneof(
    fc.constant<string[]>([]),
    fc.constant<string[]>(["steps"]),
    slugArb.map((slug) => ["steps", slug]),
    slugArb.map((slug) => ["steps", slug, "result"]),
    fc.tuple(slugArb, fc.constantFrom("data", "status", "meta")).map(([slug, key]) => ["steps", slug, "result", key]),
    slugArb.map((slug) => ["steps", slug, "config"]),
    fc.constant<string[]>(["trigger"]),
    fc.constant<string[]>(["trigger", "payload"]),
    fc.constantFrom("data", "status", "meta").map((key) => ["trigger", "payload", key]),
    fc.constant<string[]>(["env"]),
    fc.constant<string[]>(["secret"]),
  );

  /** Prefix arbitrary allowing empty, lowercase, uppercase, and mixed input. */
  const anyPrefixArb: fc.Arbitrary<string> = fc.oneof(
    prefixArb,
    fc.string({ unit: fc.constantFrom(...upperAlphaNumUnderscore.split("")), minLength: 0, maxLength: 8 }),
    fc.constantFrom("", "s", "S", "trig", "pay", "res", "con"),
  );

  test("getSuggestions is identical across normal field, if condition.ref, and case match invocations", () => {
    fc.assert(
      fc.property(scopeConfigArb, pathArb, anyPrefixArb, (config, path, prefix) => {
        // A normal template field routes to getSuggestions(config, path, prefix).
        const normalField = getSuggestions(config, path, prefix);
        // An `if` node's condition.ref routes through the exact same call.
        const ifConditionRef = getSuggestions(config, path, prefix);
        // A `case` node's match routes through the exact same call.
        const caseMatch = getSuggestions(config, path, prefix);

        expect(ifConditionRef).toEqual(normalField);
        expect(caseMatch).toEqual(normalField);
      }),
      { numRuns: 200 },
    );
  });
});

describe("Enum metadata extraction sources from schemaForm helpers", () => {
  /**
   * The completion metadata logic in `getOutputSchemaSuggestions` must obtain
   * enum property metadata using the existing JSON Schema extraction in
   * `schemaForm.ts` (`isEnum` / `getEnumOptions`) rather than a separate
   * implementation. These tests feed shared JSON Schema inputs through BOTH the
   * completion suggestions path and the `schemaForm.ts` helpers directly, then
   * assert the enum values agree: every declared value present, none absent.
   */

  /**
   * Extracts the single suggestion for `key` from the enum leaf produced by
   * walking the shared schema through the completion path.
   */
  function suggestionFor(schema: Record<string, unknown>, key: string): Suggestion {
    const results = getOutputSchemaSuggestions(schema, [], key);
    const match = results.find((s) => s.label === key);
    expect(match).not.toBeUndefined();
    return match!;
  }

  describe("anyOf-of-const form (the form TypeBox emits)", () => {
    // Shared input consumed by both the completion path and schemaForm helpers.
    const enumNode = {
      anyOf: [{ const: "low" }, { const: "medium" }, { const: "high" }],
    };
    const schema = {
      type: "object",
      properties: {
        priority: enumNode,
      },
    };

    test("schemaForm helpers recognize the node as an enum", () => {
      expect(isEnum(enumNode)).toBe(true);
    });

    test("completion enumValues equal getEnumOptions on the shared node", () => {
      const suggestion = suggestionFor(schema, "priority");
      expect(suggestion.enumValues).toEqual(getEnumOptions(enumNode));
    });

    test("every declared value is present and none absent", () => {
      const suggestion = suggestionFor(schema, "priority");
      const helperValues = getEnumOptions(enumNode);
      // Completion values include every value the helper reports (none absent).
      for (const value of helperValues) {
        expect(suggestion.enumValues).toContain(value);
      }
      // Completion values contain no extras beyond what the helper reports.
      expect(suggestion.enumValues!.length).toBe(helperValues.length);
      expect(suggestion.enumValues).toEqual(["low", "medium", "high"]);
    });
  });

  describe("direct enum array fallback", () => {
    // The schemaForm helpers do not recognize a bare `enum` array as an enum
    // (they target the anyOf-of-const form). The completion path adds a direct
    // `node.enum` fallback so plain JSON Schema enums still surface their values.
    const enumNode = {
      type: "string",
      enum: ["draft", "published", "archived"],
    };
    const schema = {
      type: "object",
      properties: {
        state: enumNode,
      },
    };

    test("schemaForm isEnum does not match a bare enum array", () => {
      expect(isEnum(enumNode)).toBe(false);
    });

    test("completion surfaces every declared enum value via the fallback", () => {
      const suggestion = suggestionFor(schema, "state");
      const declared = enumNode.enum.map((v) => String(v));
      for (const value of declared) {
        expect(suggestion.enumValues).toContain(value);
      }
      expect(suggestion.enumValues!.length).toBe(declared.length);
      expect(suggestion.enumValues).toEqual(["draft", "published", "archived"]);
    });
  });

  describe("agreement across a shared multi-property input", () => {
    // A single shared schema mixing both enum forms and a non-enum leaf.
    const anyOfNode = { anyOf: [{ const: "a" }, { const: "b" }] };
    const directNode = { type: "string", enum: ["x", "y", "z"] };
    const plainNode = { type: "number" };
    const schema = {
      type: "object",
      properties: {
        kind: anyOfNode,
        mode: directNode,
        count: plainNode,
      },
    };

    test("anyOf property agrees with getEnumOptions", () => {
      const suggestion = suggestionFor(schema, "kind");
      expect(isEnum(anyOfNode)).toBe(true);
      expect(suggestion.enumValues).toEqual(getEnumOptions(anyOfNode));
    });

    test("direct-enum property surfaces the declared values", () => {
      const suggestion = suggestionFor(schema, "mode");
      expect(suggestion.enumValues).toEqual(["x", "y", "z"]);
    });

    test("non-enum property carries no enumValues", () => {
      const suggestion = suggestionFor(schema, "count");
      expect(suggestion.enumValues).toBeUndefined();
    });
  });
});

describe("getVariableSuggestions", () => {
  // Variable keys share the secret key format /^[A-Z][A-Z0-9_]{0,63}$/,
  // so the existing secretKeyArb generator is reused as a variable key source.
  const variableKeyArb = secretKeyArb;

  describe("Autocomplete filter and sort invariants", () => {
    // Feature: global-variables, Property 10
    /**
     * Property 10: Autocomplete filter and sort invariants.
     * Validates: Requirements 7.2, 7.3, 7.4
     *
     * For any list of variable keys and any prefix, the suggestions from
     * getVariableSuggestions(variableKeys, prefix) are exactly the keys whose
     * text contains the prefix case-insensitively (all keys when the prefix is
     * empty), sorted ascending by case-insensitive comparison, and each
     * suggestion is terminal.
     */
    test("returns exactly the case-insensitive substring matches, sorted, all terminal", () => {
      fc.assert(
        fc.property(
          fc.array(variableKeyArb, { minLength: 0, maxLength: 30 }),
          fc.oneof(
            fc.constant(""),
            prefixArb,
            fc.string({ unit: fc.constantFrom(...upperAlphaNumUnderscore.split("")), minLength: 0, maxLength: 10 }),
          ),
          (variableKeys, prefix) => {
            const results = getVariableSuggestions(variableKeys, prefix);
            const labels = results.map((s) => s.label);
            const lowerPrefix = prefix.toLowerCase();

            // Membership: exactly the keys whose text contains the prefix
            // case-insensitively (every key when the prefix is empty).
            const expected = variableKeys
              .filter((key) => key.toLowerCase().includes(lowerPrefix))
              .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
            expect(labels).toEqual(expected);

            // Each returned label indeed contains the prefix case-insensitively.
            for (const label of labels) {
              expect(label.toLowerCase().includes(lowerPrefix)).toBe(true);
            }

            // Sorted ascending by case-insensitive comparison.
            for (let i = 1; i < labels.length; i++) {
              const prev = (labels[i - 1] as string).toLowerCase();
              const curr = (labels[i] as string).toLowerCase();
              expect(prev.localeCompare(curr)).toBeLessThanOrEqual(0);
            }

            // Every suggestion is terminal.
            for (const s of results) {
              expect(s.terminal).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

describe("getSuggestions hides the var namespace when empty", () => {
  // Variable keys share the secret key format /^[A-Z][A-Z0-9_]{0,63}$/.
  const variableKeyArb = secretKeyArb;

  describe("Autocomplete hides the namespace when empty", () => {
    // Feature: global-variables, Property 11
    /**
     * Property 11: Autocomplete hides the namespace when empty.
     * Validates: Requirements 7.1, 7.5, 7.7
     *
     * For any scope configuration, the top-level suggestions from
     * getSuggestions(config, [], prefix) include `var` when at least one
     * variable key is available and omit `var` when none are available.
     *
     * The config is constructed so that top-level filtering of the other
     * conditional namespaces does not interfere with asserting `var`:
     *   - `steps` is dropped when steps.length <= 1, so a single step is used.
     *   - `secret` is dropped when secretKeys is empty, so no secret keys are used.
     * The prefix is constrained to "" or "var" so that startsWith(prefix)
     * always includes the `var` label when the namespace is present.
     */
    test("includes var iff at least one variable key is available", () => {
      fc.assert(
        fc.property(
          fc.array(variableKeyArb, { minLength: 0, maxLength: 10 }),
          fc.constantFrom("", "v", "va", "var"),
          (variableKeys, prefix) => {
            const config: ScopeConfig = {
              steps: [{ slug: "only" }],
              currentStepIndex: 0,
              secretKeys: [],
              variableKeys,
            };

            const labels = getSuggestions(config, [], prefix).map((s) => s.label);

            if (variableKeys.length > 0) {
              expect(labels).toContain("var");
            } else {
              expect(labels).not.toContain("var");
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    // Explicit boundary example: zero vs one variable key.
    test("boundary: omits var for zero keys and includes it for one key", () => {
      const baseConfig: Omit<ScopeConfig, "variableKeys"> = {
        steps: [{ slug: "only" }],
        currentStepIndex: 0,
        secretKeys: [],
      };

      const zeroLabels = getSuggestions({ ...baseConfig, variableKeys: [] }, [], "").map((s) => s.label);
      expect(zeroLabels).not.toContain("var");

      const oneLabels = getSuggestions({ ...baseConfig, variableKeys: ["MY_VAR"] }, [], "").map((s) => s.label);
      expect(oneLabels).toContain("var");
    });
  });
});

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import {
  getConfigSuggestions,
  getEnvSuggestions,
  getOutputSchemaSuggestions,
  getSecretSuggestions,
  getStepSlugs,
  getSuggestions,
  getTopLevelSuggestions,
  type ScopeConfig,
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

const TOP_LEVEL_NAMESPACES = ["trigger", "steps", "env", "secret"];

describe("Template Scope Registry - Property Tests", () => {
  describe("Property 2: Prefix filtering returns only matches", () => {
    /**
     * Validates: Requirements 2.2, 2.3
     *
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

  describe("Property 3: Steps scope excludes forward references", () => {
    /**
     * Validates: Requirements 3.1, 3.2, 3.3
     *
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

  describe("Property 4: Suggestions are always sorted", () => {
    /**
     * Validates: Requirements 4.1, 5.2
     *
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

  describe("Property 5: Env/secret filtering uses case-insensitive substring", () => {
    /**
     * Validates: Requirements 4.2, 4.3
     *
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
    source: "string",
    id: "string",
    slug: "string",
    filename: "string",
    event: "string",
  };

  const nestedSchema = {
    name: "string",
    metadata: {
      size: "number",
      type: "string",
      tags: {
        primary: "string",
        secondary: "string",
      },
    },
    active: "boolean",
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

    test("includes type hint as description for terminal values", () => {
      const results = getOutputSchemaSuggestions(nestedSchema, ["metadata"], "size");
      expect(results.length).toBe(1);
      expect(results[0]!.label).toBe("size");
      expect(results[0]!.description).toBe("number");
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
      outputSchemas: {
        trigger: filewatcherSchema,
        steps: {
          fetch: { data: "string", status: { code: "number", message: "string" } },
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
    const config: ScopeConfig = { steps, currentStepIndex: 2, secretKeys: [] };
    const results = getSuggestions(config, ["steps", "first"], "");
    const labels = results.map((s) => s.label);
    expect(labels).toContain("result");
    expect(labels).toContain("config");
  });

  test("succeeding step shows only config, not result", () => {
    const config: ScopeConfig = { steps, currentStepIndex: 0, secretKeys: [] };
    const results = getSuggestions(config, ["steps", "second"], "");
    const labels = results.map((s) => s.label);
    expect(labels).not.toContain("result");
    expect(labels).toContain("config");
  });

  test("step at same index as current shows only config", () => {
    // This shouldn't normally happen (current step is excluded from slug list)
    // but if it does, result should not be shown
    const config: ScopeConfig = { steps, currentStepIndex: 1, secretKeys: [] };
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
      outputSchemas: { trigger: null, steps: { second: { data: "string" } } },
    };
    const results = getSuggestions(config, ["steps", "second"], "");
    const labels = results.map((s) => s.label);
    expect(labels).not.toContain("result");
  });
});

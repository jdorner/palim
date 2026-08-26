import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { DagStepDef, DagWorkflowDefinition } from "./schemas";
import { findWorkflowsReferencingVariable } from "./variableReferenceCheck";

/**
 * Builds a minimal valid DAG workflow definition for reference-check tests.
 * Callers supply the workflow name and its steps map; trigger/enabled are
 * stubbed and edges default to empty (edges are irrelevant to the scan).
 */
function wf(name: string, steps: DagWorkflowDefinition["steps"]): DagWorkflowDefinition {
  return {
    name,
    trigger: { type: "manual" },
    enabled: true,
    steps,
    edges: [],
  } as DagWorkflowDefinition;
}

/** Wraps a variable key into a `{{var.KEY}}` template expression. */
function varRef(key: string): string {
  return `{{var.${key}}}`;
}

describe("findWorkflowsReferencingVariable", () => {
  describe("basic matching", () => {
    test("returns the workflow that references the key in an agent prompt", () => {
      const defs = [wf("uses-key", { a: { type: "agent", prompt: varRef("API_URL") } })];
      expect(findWorkflowsReferencingVariable(defs, "API_URL")).toEqual(["uses-key"]);
    });

    test("returns an empty array when no workflow references the key", () => {
      const defs = [wf("other", { a: { type: "agent", prompt: varRef("OTHER") } })];
      expect(findWorkflowsReferencingVariable(defs, "API_URL")).toEqual([]);
    });

    test("returns an empty array for an empty definition set", () => {
      expect(findWorkflowsReferencingVariable([], "API_URL")).toEqual([]);
    });

    test("finds references in if condition.ref", () => {
      const defs = [wf("if-wf", { c: { type: "if", condition: { ref: varRef("MODE"), eq: "prod" } } })];
      expect(findWorkflowsReferencingVariable(defs, "MODE")).toEqual(["if-wf"]);
    });

    test("finds references in case match", () => {
      const defs = [wf("case-wf", { c: { type: "case", match: varRef("ENV"), paths: ["a"] } })];
      expect(findWorkflowsReferencingVariable(defs, "ENV")).toEqual(["case-wf"]);
    });

    test("finds references in string-valued custom step config fields", () => {
      const defs = [wf("custom-wf", { c: { type: "http-request", url: varRef("BASE_URL") } })];
      expect(findWorkflowsReferencingVariable(defs, "BASE_URL")).toEqual(["custom-wf"]);
    });

    test("returns multiple workflow names in iteration order", () => {
      const defs = [
        wf("first", { a: { type: "agent", prompt: varRef("K") } }),
        wf("second", { a: { type: "agent", prompt: "no ref" } }),
        wf("third", { a: { type: "agent", prompt: varRef("K") } }),
      ];
      expect(findWorkflowsReferencingVariable(defs, "K")).toEqual(["first", "third"]);
    });

    test("deduplicates: a workflow referencing the key twice appears once", () => {
      const defs = [wf("dup", { a: { type: "agent", prompt: `${varRef("K")} and ${varRef("K")}` } })];
      expect(findWorkflowsReferencingVariable(defs, "K")).toEqual(["dup"]);
    });
  });

  describe("no false positives", () => {
    test("does not match a different variable key", () => {
      const defs = [wf("wf", { a: { type: "agent", prompt: varRef("OTHER") } })];
      expect(findWorkflowsReferencingVariable(defs, "KEY")).toEqual([]);
    });

    test("does not match a namespace that merely starts with var", () => {
      const defs = [wf("wf", { a: { type: "agent", prompt: "{{varX.KEY}}" } })];
      expect(findWorkflowsReferencingVariable(defs, "KEY")).toEqual([]);
    });

    test("does not match a deeper path like {{var.KEY.sub}}", () => {
      const defs = [wf("wf", { a: { type: "agent", prompt: "{{var.KEY.sub}}" } })];
      expect(findWorkflowsReferencingVariable(defs, "KEY")).toEqual([]);
    });

    test("does not match other namespaces (secret/env/steps)", () => {
      const defs = [
        wf("s", { a: { type: "agent", prompt: "{{secret.KEY}}" } }),
        wf("e", { a: { type: "agent", prompt: "{{env.KEY}}" } }),
        wf("t", { a: { type: "agent", prompt: "{{steps.KEY.result}}" } }),
      ];
      expect(findWorkflowsReferencingVariable(defs, "KEY")).toEqual([]);
    });

    test("matches a trimmed expression with surrounding whitespace", () => {
      const defs = [wf("wf", { a: { type: "agent", prompt: "{{  var.KEY  }}" } })];
      expect(findWorkflowsReferencingVariable(defs, "KEY")).toEqual(["wf"]);
    });
  });

  describe("property: reference check finds exactly the referencing workflows", () => {
    // Feature: global-variables, Property 12: Reference check finds exactly the
    // referencing workflows.
    // Validates: Requirements 3.4, 3.5, 3.6, 3.7
    //
    // For any set of workflow definitions and any variable key, the reference
    // check returns the names of exactly those workflows that contain at least
    // one {{var.KEY}} expression (matched as exactly ["var", KEY]) in a
    // template-bearing field, and no others.

    /** Valid variable key generator (UPPER_SNAKE_CASE, 1-64 chars). */
    const keyArb = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,10}$/).filter((s) => /^[A-Z][A-Z0-9_]{0,63}$/.test(s));

    /** Valid workflow name generator (lowercase-dash slug). */
    const nameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/).filter((s) => /^[a-z][a-z0-9-]*$/.test(s));

    test("Property 12: exact referencing set across a workflow collection", () => {
      fc.assert(
        fc.property(
          keyArb,
          fc.uniqueArray(nameArb, { minLength: 1, maxLength: 6 }),
          fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
          fc.array(fc.constantFrom("prompt", "if", "case", "custom"), { minLength: 6, maxLength: 6 }),
          (targetKey, names, refsFlags, fieldKinds) => {
            const expected: string[] = [];
            const defs: DagWorkflowDefinition[] = names.map((name, i) => {
              const references = refsFlags[i] ?? false;
              const kind = fieldKinds[i] ?? "prompt";
              if (references) expected.push(name);

              // A non-referencing field uses a decoy that must never match.
              const matchExpr = references ? varRef(targetKey) : "{{varX.DECOY}}";
              // Always include a distractor that differs from the target.
              const distractor = targetKey === "OTHER_VAR" ? "ANOTHER_VAR" : "OTHER_VAR";
              const withDistractor = `${matchExpr} ${varRef(distractor)}`;

              let step: DagStepDef;
              if (kind === "if") {
                step = { type: "if", condition: { ref: withDistractor, eq: "x" } };
              } else if (kind === "case") {
                step = { type: "case", match: withDistractor, paths: ["p"] };
              } else if (kind === "custom") {
                step = { type: "http-request", url: withDistractor } as DagStepDef;
              } else {
                step = { type: "agent", prompt: withDistractor };
              }
              return wf(name, { s: step });
            });

            const result = findWorkflowsReferencingVariable(defs, targetKey);
            expect(result).toEqual(expected);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

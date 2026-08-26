/**
 * Verifies that the workflow variable namespace prefix "var" is recognized
 * identically by all three consumers, so none can drift on the prefix spelling.
 *
 * Three consumers must agree that "var" is the Variable_Namespace prefix:
 *   - backend Template_Engine `template.ts` (resolveTemplates): a
 *     `{{var.KEY}}` reference with no variableStore in the context is left
 *     literal and produces exactly one warning (it is recognized as the var
 *     namespace, not an "unrecognized template expression").
 *   - backend Template_Validator `dagTemplateValidation.ts`
 *     (validateDagWorkflowTemplates): "var" is a KNOWN prefix, so a
 *     `{{var.KEY}}` reference does NOT produce the "unknown expression prefix"
 *     warning that a bogus prefix (e.g. "notaprefix") produces.
 *   - frontend Autocomplete_Engine `templateScope.ts`
 *     (getTopLevelSuggestions): "var" appears as a top-level namespace
 *     suggestion.
 *
 * The two backend modules keep their prefix handling internal, so recognition
 * is verified behaviorally by feeding a minimal single-step DAG workflow
 * through each and inspecting the resulting warnings. The frontend is verified
 * through its exported suggestion function.
 *
 * The guard's purpose is to fail if any of the three consumers stops treating
 * "var" as the shared Variable_Namespace prefix.
 *
 * _Requirements: 10.5_
 */

import { describe, expect, test } from "bun:test";
import type { TemplateVariableResolver } from "@src/variables";
import { getTopLevelSuggestions } from "../../../../frontend/src/lib/templateScope";
import { validateDagWorkflowTemplates } from "./dagTemplateValidation";
import type { DagWorkflowDefinition } from "./schemas";
import { resolveTemplates } from "./template";

/** The single shared Variable_Namespace prefix under guard. */
const VAR_PREFIX = "var";

/** A key used by the behavioral probes; its existence is irrelevant here. */
const PROBE_KEY = "SOME_KEY";

/** A prefix guaranteed not to be recognized by any consumer, for contrast. */
const UNKNOWN_PREFIX = "notaprefix";

/**
 * An empty in-memory variable resolver: knows no keys. Used to confirm that a
 * recognized "var" reference to a missing key stays literal and warns (rather
 * than being treated as an unrecognized expression).
 */
const EMPTY_VARIABLE_STORE: TemplateVariableResolver = {
  resolve: (_key: string) => null,
  has: (_key: string) => false,
};

/**
 * Builds a minimal single-step DAG workflow whose custom step config carries
 * the given template string. Custom step string config fields are scanned by
 * the validator's `getTemplateFields`, so this surfaces `{{...}}` references.
 */
function buildWorkflowWithProbe(probe: string): DagWorkflowDefinition {
  return {
    name: "probe-workflow",
    trigger: { type: "manual" },
    steps: {
      probe: {
        type: "http-request",
        url: probe,
      },
    },
    edges: [],
  } as unknown as DagWorkflowDefinition;
}

/** Counts validator warnings that flag an expression as an unknown prefix. */
function unknownPrefixWarningCount(warnings: Array<{ message: string }>): number {
  return warnings.filter((w) => w.message.includes("Unknown expression prefix")).length;
}

/** Counts template-engine warnings (plain strings) that mention unrecognized expressions. */
function unrecognizedExpressionWarningCount(warnings: string[]): number {
  return warnings.filter((w) => w.includes("Unrecognized template expression")).length;
}

describe("var prefix single source", () => {
  test("backend template engine (resolveTemplates) recognizes the var prefix", async () => {
    // With no variableStore, a recognized {{var.KEY}} reference is left literal
    // and warns about the missing store - it is NOT an unrecognized expression.
    const missingStore = await resolveTemplates(`{{${VAR_PREFIX}.${PROBE_KEY}}}`, { stepResults: {} });
    expect(missingStore.resolved).toContain(`{{${VAR_PREFIX}.${PROBE_KEY}}}`);
    expect(unrecognizedExpressionWarningCount(missingStore.warnings)).toBe(0);
    expect(missingStore.warnings.length).toBe(1);

    // With an empty store, a recognized {{var.KEY}} miss stays literal and
    // warns about the missing key - still not an unrecognized expression.
    const missingKey = await resolveTemplates(`{{${VAR_PREFIX}.${PROBE_KEY}}}`, {
      stepResults: {},
      variableStore: EMPTY_VARIABLE_STORE,
    });
    expect(missingKey.resolved).toContain(`{{${VAR_PREFIX}.${PROBE_KEY}}}`);
    expect(unrecognizedExpressionWarningCount(missingKey.warnings)).toBe(0);
    expect(missingKey.warnings.length).toBe(1);

    // Contrast: an unknown prefix IS reported as an unrecognized expression.
    const unknown = await resolveTemplates(`{{${UNKNOWN_PREFIX}.${PROBE_KEY}}}`, { stepResults: {} });
    expect(unrecognizedExpressionWarningCount(unknown.warnings)).toBe(1);
  });

  test("backend validator (dagTemplateValidation) treats var as a known prefix", async () => {
    // A recognized {{var.KEY}} reference must NOT produce the unknown-prefix
    // warning. With no variableStore, existence checks are skipped, so a
    // well-formed reference yields no warning at all.
    const varWarnings = await validateDagWorkflowTemplates(buildWorkflowWithProbe(`{{${VAR_PREFIX}.${PROBE_KEY}}}`));
    expect(unknownPrefixWarningCount(varWarnings)).toBe(0);

    // Contrast: a bogus prefix must produce exactly one unknown-prefix warning.
    const unknownWarnings = await validateDagWorkflowTemplates(
      buildWorkflowWithProbe(`{{${UNKNOWN_PREFIX}.${PROBE_KEY}}}`),
    );
    expect(unknownPrefixWarningCount(unknownWarnings)).toBe(1);
  });

  test("frontend autocomplete (templateScope) offers var as a top-level namespace", () => {
    // Empty prefix must include the var namespace among top-level suggestions.
    const allLabels = getTopLevelSuggestions("").map((s) => s.label);
    expect(allLabels).toContain(VAR_PREFIX);

    // Typing the exact prefix must still surface it.
    const varLabels = getTopLevelSuggestions(VAR_PREFIX).map((s) => s.label);
    expect(varLabels).toContain(VAR_PREFIX);
  });
});

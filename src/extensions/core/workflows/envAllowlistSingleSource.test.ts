/**
 * Verifies that the default workflow env-var allowlist is single-sourced from
 * the shared `DEFAULT_ENV_ALLOWLIST` constant in `@shared/workflows`.
 *
 * Three consumers must agree on the default allowlist:
 *   - backend `template.ts` (resolveTemplates)
 *   - backend `dagTemplateValidation.ts` (validateDagWorkflowTemplates)
 *   - frontend `templateScope.ts` (DEFAULT_ENV_ALLOWLIST export)
 *
 * The frontend copy is asserted for same-members equality with the shared
 * source (this remains true once task 2.1 rewires it to a literal import).
 * The two backend modules keep `getEnvAllowlist()` private, so their sourcing
 * is verified behaviorally: with no `WORKFLOW_ENV_ALLOWLIST` env var set, an
 * `{{env.NAME}}` reference for every shared name must produce no allowlist
 * warning, and an unknown name must produce exactly one.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_ENV_ALLOWLIST } from "@shared/workflows";
import { DEFAULT_ENV_ALLOWLIST as FRONTEND_DEFAULT_ENV_ALLOWLIST } from "../../../../frontend/src/lib/templateScope";
import { validateDagWorkflowTemplates } from "./dagTemplateValidation";
import type { DagWorkflowDefinition } from "./schemas";
import { resolveTemplates } from "./template";

/** Name guaranteed not to be on any allowlist for the negative-case probes. */
const UNKNOWN_ENV_NAME = "DEFINITELY_NOT_ALLOWED_XYZ";

/** Returns a new array sorted ascending, for order-independent equality checks. */
function sorted(names: readonly string[]): string[] {
  return [...names].sort();
}

/**
 * Builds a minimal single-step DAG workflow whose custom step config carries
 * the given template string. Custom step string config fields are scanned by
 * the validator's `getTemplateFields`, so this surfaces `{{env.*}}` references.
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

/** Counts DAG-validator warnings that concern the env allowlist for a var name. */
function validatorAllowlistWarningCount(warnings: Array<{ message: string }>, varName: string): number {
  return warnings.filter((w) => w.message.includes(varName) && w.message.includes("allowlist")).length;
}

/** Counts template-engine warnings (plain strings) that concern the env allowlist for a var name. */
function templateAllowlistWarningCount(warnings: string[], varName: string): number {
  return warnings.filter((w) => w.includes(varName) && w.includes("allowlist")).length;
}

describe("env allowlist single source", () => {
  test("shared DEFAULT_ENV_ALLOWLIST is non-empty and has unique members", () => {
    expect(DEFAULT_ENV_ALLOWLIST.length).toBeGreaterThan(0);
    expect(new Set(DEFAULT_ENV_ALLOWLIST).size).toBe(DEFAULT_ENV_ALLOWLIST.length);
  });

  test("frontend templateScope derives the same default members as the shared source", () => {
    // Same-members (order-independent) equality. This is what "import-equality"
    // reduces to and stays true after task 2.1 makes the frontend a literal import.
    expect(sorted(FRONTEND_DEFAULT_ENV_ALLOWLIST)).toEqual(sorted(DEFAULT_ENV_ALLOWLIST));
  });

  test("backend validator (dagTemplateValidation) default allowlist equals the shared source", async () => {
    // Positive case: every shared name must be accepted (no allowlist warning).
    for (const name of DEFAULT_ENV_ALLOWLIST) {
      const warnings = await validateDagWorkflowTemplates(buildWorkflowWithProbe(`{{env.${name}}}`));
      expect(validatorAllowlistWarningCount(warnings, name)).toBe(0);
    }

    // Negative case: an unknown name must produce exactly one allowlist warning.
    const unknownWarnings = await validateDagWorkflowTemplates(buildWorkflowWithProbe(`{{env.${UNKNOWN_ENV_NAME}}}`));
    expect(validatorAllowlistWarningCount(unknownWarnings, UNKNOWN_ENV_NAME)).toBe(1);
  });

  test("backend template engine (resolveTemplates) default allowlist equals the shared source", async () => {
    // Positive case: shared names are allowed, so no allowlist warning is emitted.
    for (const name of DEFAULT_ENV_ALLOWLIST) {
      const { warnings } = await resolveTemplates(`{{env.${name}}}`, { stepResults: {} });
      expect(templateAllowlistWarningCount(warnings, name)).toBe(0);
    }

    // Negative case: an unknown name is denied with exactly one allowlist warning.
    const { warnings } = await resolveTemplates(`{{env.${UNKNOWN_ENV_NAME}}}`, { stepResults: {} });
    expect(templateAllowlistWarningCount(warnings, UNKNOWN_ENV_NAME)).toBe(1);
  });
});

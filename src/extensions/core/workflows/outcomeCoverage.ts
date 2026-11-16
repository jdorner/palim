/**
 * Advisory check that a `case` branching on a human task's answer covers
 * every outcome the task can produce, and only those.
 *
 * The outcome ids, the `case` paths, and the edge branches are three separate
 * lists. When an outcome has no path and the `case` has no fallback, choosing
 * that outcome fails the run; a path no outcome produces never matches.
 *
 * @module
 */

import type { TemplateWarning } from "./dagTemplateValidation";
import { humanTaskOutcomeIds } from "./humanTask";
import type { DagCaseStep, DagHumanTaskStep, DagWorkflowDefinition } from "./schemas";

/** A `match` that is exactly one `{{steps.<slug>.result.outcome}}` template. */
const OUTCOME_MATCH = /^\{\{\s*steps\.([a-z][a-z0-9-]*)\.result\.outcome\s*\}\}$/;

/**
 * Warns about `case` steps whose `match` is exactly
 * `{{steps.<slug>.result.outcome}}` of a `humanTask` step and whose paths do
 * not agree with that task's outcomes:
 *
 * - without a fallback (`default` set, or an outgoing edge with branch
 *   `"default"`), one warning per outcome that has no path;
 * - one warning per path that is neither an outcome nor the `default` key.
 *
 * A path without an outgoing edge stays silent: that branch just ends the run.
 * Every other `match` is ignored.
 *
 * @param definition - The workflow definition
 * @returns One warning per uncovered outcome or stale path, on the `case` step's `paths`
 */
export function getOutcomeCoverageWarnings(definition: DagWorkflowDefinition): TemplateWarning[] {
  const warnings: TemplateWarning[] = [];

  for (const [slug, stepDef] of Object.entries(definition.steps)) {
    if (stepDef.type !== "case") continue;
    const caseStep = stepDef as DagCaseStep;
    if (typeof caseStep.match !== "string" || !Array.isArray(caseStep.paths)) continue;
    const taskSlug = OUTCOME_MATCH.exec(caseStep.match)?.[1];
    const task = taskSlug ? definition.steps[taskSlug] : undefined;
    if (!taskSlug || task?.type !== "humanTask") continue;

    const humanTask = task as DagHumanTaskStep;
    const expected = humanTaskOutcomeIds(humanTask);
    const paths = new Set(caseStep.paths);
    const hasFallback = !!caseStep.default || definition.edges.some((e) => e.from === slug && e.branch === "default");

    if (!hasFallback) {
      for (const outcome of expected) {
        if (paths.has(outcome)) continue;
        const consequence = outcome === "expired" ? "the timeout fails the run" : "choosing it fails the run";
        warnings.push({
          stepSlug: slug,
          field: "paths",
          message: `Outcome "${outcome}" of "${taskSlug}" has no path in "${slug}": ${consequence}`,
        });
      }
    }

    const expectedSet = new Set(expected);
    for (const path of paths) {
      if (expectedSet.has(path) || path === caseStep.default) continue;
      const reason =
        path === "expired"
          ? `"${taskSlug}" has no such outcome (it needs onTimeout: "expire")`
          : `"${taskSlug}" has no such outcome`;
      warnings.push({
        stepSlug: slug,
        field: "paths",
        message: `Path "${path}" of "${slug}" never matches: ${reason}`,
      });
    }
  }

  return warnings;
}

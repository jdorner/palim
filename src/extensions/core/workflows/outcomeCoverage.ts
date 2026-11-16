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
import { definitionTopology } from "./definitionTopology";
import { humanTaskOutcomeIds } from "./humanTask";
import { caseFallbackBranch } from "./runKernel";
import { DAG_SLUG_SOURCE, type DagCaseStep, type DagHumanTaskStep, type DagWorkflowDefinition } from "./schemas";

/** A `match` that is exactly one `{{steps.<slug>.result.outcome}}` template. */
const OUTCOME_MATCH = new RegExp(`^\\{\\{\\s*steps\\.(${DAG_SLUG_SOURCE})\\.result\\.outcome\\s*\\}\\}$`);

/** Any `steps.<slug>.result.outcome` reference inside a `match`. */
const OUTCOME_REF = new RegExp(`\\bsteps\\.(${DAG_SLUG_SOURCE})\\.result\\.outcome\\b`, "g");

/**
 * The human task whose outcome a `match` uses in some form other than exactly
 * `{{steps.<slug>.result.outcome}}`, or null when it uses none.
 *
 * @param match - The case step's `match`
 * @param definition - The workflow definition
 * @returns The human task's slug, or null
 */
function uncheckedOutcomeRef(match: string, definition: DagWorkflowDefinition): string | null {
  for (const [, slug] of match.matchAll(OUTCOME_REF)) {
    if (slug && definition.steps[slug]?.type === "humanTask") return slug;
  }
  return null;
}

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
 * A `match` that uses a human task's outcome in another form (a function
 * call, text around it) gets one warning saying the coverage is not checked.
 * Every other `match` is ignored.
 *
 * The fallback rule is the kernel's own ({@link caseFallbackBranch}).
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
    if (!taskSlug || task?.type !== "humanTask") {
      const unchecked = uncheckedOutcomeRef(caseStep.match, definition);
      if (unchecked) {
        warnings.push({
          stepSlug: slug,
          field: "match",
          message: `Outcome coverage of "${unchecked}" is not checked: use exactly {{steps.${unchecked}.result.outcome}} as the match`,
        });
      }
      continue;
    }

    const humanTask = task as DagHumanTaskStep;
    const expected = humanTaskOutcomeIds(humanTask);
    const paths = new Set(caseStep.paths);
    const hasFallback = caseFallbackBranch(caseStep, definitionTopology(definition).outgoing(slug)) !== null;

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
          ? `"${taskSlug}" has no such outcome (it needs a timeout and onTimeout: "expire")`
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

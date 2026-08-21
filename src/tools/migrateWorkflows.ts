/**
 * CLI tool to migrate sequential-format workflow JSON5 files to the new DAG format.
 *
 * Converts:
 * - `steps: [...]` array to `steps: {...}` map (slug as key)
 * - Sequential edges generated between consecutive steps
 * - `if` nodes: flatten then/else branches, generate branch + convergence edges
 * - `case` nodes: flatten path arrays, generate branch + convergence edges
 *
 * Usage: bun run migrate-workflows [dir]
 * Default dir: .work/workflows/
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A step in the old sequential format. */
interface OldStep {
  slug: string;
  type: string;
  [key: string]: unknown;
}

/** An if step in the old format (with inline branches). */
interface OldIfStep extends OldStep {
  type: "if";
  condition: Record<string, unknown>;
  then: OldStep[];
  else?: OldStep[];
}

/** A case step in the old format (with inline path arrays). */
interface OldCaseStep extends OldStep {
  type: "case";
  match: string;
  paths: Record<string, OldStep[]>;
  default?: OldStep[];
}

/** Edge in the new format. */
interface NewEdge {
  from: string;
  to: string;
  branch?: string;
}

/** The old workflow definition format (steps as array). */
interface OldWorkflowDef {
  name: string;
  description?: string;
  trigger: Record<string, unknown>;
  enabled?: boolean;
  steps: OldStep[];
}

/** The new DAG workflow definition format. */
interface NewWorkflowDef {
  name: string;
  description?: string;
  trigger: Record<string, unknown>;
  enabled?: boolean;
  steps: Record<string, Record<string, unknown>>;
  edges: NewEdge[];
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Converts an old sequential workflow definition to the new DAG format.
 *
 * @param old - The old workflow definition
 * @returns The new DAG workflow definition
 */
export function convertWorkflow(old: OldWorkflowDef): NewWorkflowDef {
  const stepsMap: Record<string, Record<string, unknown>> = {};
  const edges: NewEdge[] = [];

  processStepList(old.steps, stepsMap, edges, undefined);

  return {
    name: old.name,
    ...(old.description !== undefined ? { description: old.description } : {}),
    trigger: old.trigger,
    ...(old.enabled !== undefined ? { enabled: old.enabled } : {}),
    steps: stepsMap,
    edges,
  };
}

/**
 * Processes a list of steps (top-level or branch), adding them to the map
 * and generating edges.
 *
 * @param steps - The step list to process
 * @param stepsMap - Accumulator for the steps map
 * @param edges - Accumulator for edges
 * @param nextStepSlug - The slug to connect the last step of this list to (for convergence)
 * @returns The slug of the first step in the list (for branch edge generation)
 */
function processStepList(
  steps: OldStep[],
  stepsMap: Record<string, Record<string, unknown>>,
  edges: NewEdge[],
  nextStepSlug: string | undefined,
): string | undefined {
  if (steps.length === 0) return undefined;

  let firstSlug: string | undefined;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (i === 0) firstSlug = step.slug;

    if (step.type === "if") {
      const ifStep = step as OldIfStep;
      processIfStep(ifStep, stepsMap, edges, steps[i + 1]?.slug ?? nextStepSlug);
    } else if (step.type === "case") {
      const caseStep = step as OldCaseStep;
      processCaseStep(caseStep, stepsMap, edges, steps[i + 1]?.slug ?? nextStepSlug);
    } else {
      // Regular step: add to map (strip slug from value)
      const { slug, ...rest } = step;
      stepsMap[slug] = rest;
    }

    // Generate sequential edge to next step (if not the last in list)
    if (i < steps.length - 1) {
      const nextSlug = steps[i + 1]!.slug;
      // Only add edge if the current step is NOT a CF node (CF nodes get branch edges)
      if (step.type !== "if" && step.type !== "case") {
        edges.push({ from: step.slug, to: nextSlug });
      }
    } else if (nextStepSlug && step.type !== "if" && step.type !== "case") {
      // Last step in a branch list — connect to the convergence point
      edges.push({ from: step.slug, to: nextStepSlug });
    }
  }

  return firstSlug;
}

/**
 * Processes an if step: adds it to the map without then/else, flattens branches.
 */
function processIfStep(
  ifStep: OldIfStep,
  stepsMap: Record<string, Record<string, unknown>>,
  edges: NewEdge[],
  nextMainSlug: string | undefined,
): void {
  // Add the if node (strip slug, then, else — keep condition)
  stepsMap[ifStep.slug] = {
    type: "if",
    condition: ifStep.condition,
  };

  // Process "then" branch
  if (ifStep.then && ifStep.then.length > 0) {
    const thenFirst = processStepList(ifStep.then, stepsMap, edges, nextMainSlug);
    if (thenFirst) {
      edges.push({ from: ifStep.slug, to: thenFirst, branch: "then" });
    }
  }

  // Process "else" branch
  if (ifStep.else && ifStep.else.length > 0) {
    const elseFirst = processStepList(ifStep.else, stepsMap, edges, nextMainSlug);
    if (elseFirst) {
      edges.push({ from: ifStep.slug, to: elseFirst, branch: "else" });
    }
  }

  // If there's a next step in the main flow after this if node, the edge
  // is generated by the convergence logic in processStepList (last branch step -> nextMainSlug)
  // We don't add a direct edge from the if node to the next main step.
}

/**
 * Processes a case step: adds it to the map without inline path arrays, flattens branches.
 */
function processCaseStep(
  caseStep: OldCaseStep,
  stepsMap: Record<string, Record<string, unknown>>,
  edges: NewEdge[],
  nextMainSlug: string | undefined,
): void {
  const pathKeys = Object.keys(caseStep.paths);

  // Add the case node with paths as string array
  const caseDef: Record<string, unknown> = {
    type: "case",
    match: caseStep.match,
    paths: pathKeys,
  };

  // Process each path
  for (const key of pathKeys) {
    const pathSteps = caseStep.paths[key]!;
    if (pathSteps.length > 0) {
      const pathFirst = processStepList(pathSteps, stepsMap, edges, nextMainSlug);
      if (pathFirst) {
        edges.push({ from: caseStep.slug, to: pathFirst, branch: key });
      }
    }
  }

  // Process default branch
  if (caseStep.default && caseStep.default.length > 0) {
    caseDef.default = "default";
    const defaultFirst = processStepList(caseStep.default, stepsMap, edges, nextMainSlug);
    if (defaultFirst) {
      edges.push({ from: caseStep.slug, to: defaultFirst, branch: "default" });
    }
  }

  stepsMap[caseStep.slug] = caseDef;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Checks if a parsed workflow is already in DAG format.
 *
 * @param parsed - The parsed JSON5 object
 * @returns true if already migrated
 */
export function isAlreadyMigrated(parsed: Record<string, unknown>): boolean {
  const steps = parsed.steps;
  const edges = parsed.edges;
  // DAG format: steps is an object (not array) and edges is an array
  return steps !== null && typeof steps === "object" && !Array.isArray(steps) && Array.isArray(edges);
}

/**
 * Runs the migration CLI.
 *
 * @param dir - Directory containing workflow JSON5 files
 */
export function runMigration(dir: string): void {
  const resolvedDir = resolve(dir);

  if (!existsSync(resolvedDir)) {
    console.error(`Directory not found: ${resolvedDir}`);
    process.exit(1);
  }

  const files = readdirSync(resolvedDir).filter((f) => f.endsWith(".json5"));

  if (files.length === 0) {
    console.log(`No .json5 files found in ${resolvedDir}`);
    return;
  }

  let converted = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    const filePath = join(resolvedDir, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      // Use eval-based JSON5 parse (JSON5 allows comments, trailing commas)
      // biome-ignore lint/security/noGlobalEval: JSON5 parsing for workflow files
      const parsed = eval(`(${content})`) as Record<string, unknown>;

      if (isAlreadyMigrated(parsed)) {
        console.log(`  SKIP  ${file} (already in DAG format)`);
        skipped++;
        continue;
      }

      if (!Array.isArray(parsed.steps)) {
        console.log(`  SKIP  ${file} (no steps array found)`);
        skipped++;
        continue;
      }

      const result = convertWorkflow(parsed as unknown as OldWorkflowDef);
      const output = JSON.stringify(result, null, 2);
      writeFileSync(filePath, output, "utf-8");
      console.log(`  DONE  ${file} (${Object.keys(result.steps).length} steps, ${result.edges.length} edges)`);
      converted++;
    } catch (err) {
      console.error(`  ERROR ${file}: ${err instanceof Error ? err.message : String(err)}`);
      errors++;
    }
  }

  console.log(
    `\nSummary: ${files.length} files processed, ${converted} converted, ${skipped} skipped, ${errors} errors`,
  );
}

// Main entry point (not triggered during test imports)
if (import.meta.main && !process.env.BUN_TEST) {
  const dir = process.argv[2] ?? ".work/workflows";
  console.log(`Migrating workflows in: ${resolve(dir)}\n`);
  runMigration(dir);
}

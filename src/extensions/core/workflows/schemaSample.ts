/**
 * Infers an `outputSchema` shorthand for a workflow's trigger or a step from
 * the data of its most recent runs.
 *
 * @module
 */

import { inferOutputShorthand } from "@shared/schemaInference";
import type { OutputSchemaShorthand } from "@shared/workflows";
import type { DagWorkflowRun } from "./dagRunStore";

/** Where to take the sample value from. */
export type SchemaSampleSource = { kind: "trigger" } | { kind: "step"; slug: string };

/** A shorthand inferred from one run. */
export interface SchemaSample {
  /** The run the sample was taken from. */
  runId: string;
  /** Creation time of that run (epoch ms). */
  runCreatedAt: number;
  /** The inferred shorthand. */
  shorthand: OutputSchemaShorthand;
}

/**
 * Picks the newest run that has an object-shaped sample for the source and
 * infers its shorthand. Runs whose sample is missing or not an object (e.g. a
 * text payload, an agent step's string result) are skipped.
 *
 * Only the inferred types are returned, never the sample values themselves.
 *
 * @param runs - The workflow's runs, in any order
 * @param source - The trigger, or a step by slug
 * @returns The inferred sample, or `null` when no run has a usable sample
 */
export function inferSchemaFromRuns(runs: readonly DagWorkflowRun[], source: SchemaSampleSource): SchemaSample | null {
  const newestFirst = [...runs].sort((a, b) => b.createdAt - a.createdAt);
  for (const run of newestFirst) {
    const value = source.kind === "trigger" ? run.triggerPayload : run.stepResults[source.slug];
    const shorthand = inferOutputShorthand(value);
    if (shorthand) return { runId: run.id, runCreatedAt: run.createdAt, shorthand };
  }
  return null;
}

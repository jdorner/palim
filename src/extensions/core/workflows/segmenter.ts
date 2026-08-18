/**
 * Workflow step segmenter.
 *
 * Splits a flat step list into segments at control flow boundaries.
 * Each control flow node forms its own single-step segment; consecutive
 * non-control-flow steps form contiguous segments dispatched as one addChain() call.
 *
 * Pure function: no I/O, deterministic output for identical input.
 */

import type { WorkflowStep } from "./schemas";

/** A segment is a contiguous group of steps dispatched as one addChain() call. */
export interface Segment {
  /** Zero-based index of this segment in the workflow. */
  index: number;
  /** Steps in this segment (1+ for execution segments, exactly 1 for CF nodes). */
  steps: WorkflowStep[];
  /** Whether this segment is a control flow node (dispatch handled specially). */
  isControlFlow: boolean;
}

/** Control flow step type identifiers. */
export const CONTROL_FLOW_TYPES = new Set(["if", "case", "waitFor"]);

/**
 * Splits a flat step list into segments at control flow boundaries.
 * Pure function - no I/O, deterministic output for identical input.
 *
 * Consecutive non-control-flow steps are grouped into a single segment.
 * Each control flow node forms its own single-step segment.
 *
 * @param steps - The ordered step list from the workflow definition
 * @returns Ordered array of segments
 */
export function segmentWorkflow(steps: WorkflowStep[]): Segment[] {
  if (steps.length === 0) {
    return [];
  }

  const segments: Segment[] = [];
  let currentBatch: WorkflowStep[] = [];

  for (const step of steps) {
    if (CONTROL_FLOW_TYPES.has(step.type)) {
      // Flush any accumulated non-CF steps as a segment
      if (currentBatch.length > 0) {
        segments.push({
          index: segments.length,
          steps: currentBatch,
          isControlFlow: false,
        });
        currentBatch = [];
      }
      // CF node gets its own segment
      segments.push({
        index: segments.length,
        steps: [step],
        isControlFlow: true,
      });
    } else {
      currentBatch.push(step);
    }
  }

  // Flush remaining non-CF steps
  if (currentBatch.length > 0) {
    segments.push({
      index: segments.length,
      steps: currentBatch,
      isControlFlow: false,
    });
  }

  return segments;
}

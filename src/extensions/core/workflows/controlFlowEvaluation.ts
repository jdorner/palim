/**
 * Describes how a control-flow node (`if` / `case`) decided, from its
 * definition and its persisted step result. Used by the run detail API and the
 * `workflow_step_completed` broadcast so the run page can show the evaluation
 * in place of job logs.
 */

import type { ControlFlowEvaluation } from "@shared/workflows";
import { type Condition, extractOperator } from "./condition";
import type { DagCaseStep, DagIfStep } from "./schemas";

/** Result persisted by an `if` node. */
export interface IfStepResult {
  condition: boolean;
  chosenBranch: string;
  /** The resolved `condition.ref`; null when it could not be resolved. */
  value: string | null;
}

/** Result persisted by a `case` node. */
export interface CaseStepResult {
  matched: string;
  /** The resolved `match` expression. */
  value: string;
  /** True when no path matched and the fallback branch was taken. */
  fallback: boolean;
}

/**
 * Builds the evaluation summary of an `if` or `case` node.
 *
 * Results persisted before the value was recorded have no `value` field; the
 * summary then omits it.
 *
 * @param stepDef - The step definition (any type)
 * @param result - The step's persisted result
 * @returns The summary, or undefined for other step types or a missing result
 */
export function describeControlFlowStep(
  stepDef: { type: string } | undefined,
  result: unknown,
): ControlFlowEvaluation | undefined {
  if (!stepDef || !result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  const value = "value" in r ? (typeof r.value === "string" ? r.value : null) : undefined;

  if (stepDef.type === "if" && typeof r.chosenBranch === "string") {
    const condition = (stepDef as DagIfStep).condition;
    const evaluation: ControlFlowEvaluation = { expression: condition.ref, branch: r.chosenBranch };
    if (value !== undefined) evaluation.value = value;
    try {
      const [operator, operand] = extractOperator(condition as Condition);
      evaluation.operator = operator;
      evaluation.operand = operand;
    } catch {
      // A malformed condition fails the run before a result exists.
    }
    return evaluation;
  }

  if (stepDef.type === "case" && typeof r.matched === "string") {
    const evaluation: ControlFlowEvaluation = { expression: (stepDef as DagCaseStep).match, branch: r.matched };
    if (value !== undefined) evaluation.value = value;
    if (r.fallback === true) evaluation.fallback = true;
    return evaluation;
  }

  return undefined;
}

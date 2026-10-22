/**
 * Metadata and author docs for the step types the DAG engine evaluates itself
 * (agent and control flow). They are not registered through `ctx.stepTypes`,
 * so the `/meta/step-types` route merges them with the registered ones to give
 * the `workflow step-types` command one complete list.
 *
 * The Markdown docs live in `stepDocs/<type>.md`, next to the docs of the
 * registered `emit` handler.
 *
 * @module
 */

import type { StepTypeInfo } from "@shared/extensions";

/** Owner reported for engine step types (the workflows extension). */
const ENGINE_OWNER = "workflows";

/** An engine-evaluated step type. */
interface EngineStepType {
  type: string;
  label: string;
  description: string;
  category: StepTypeInfo["category"];
  /** Only available when human tasks are enabled (`HITL_ENABLED=true`). */
  hitlOnly?: boolean;
}

/** The engine-evaluated step types, in palette order. */
const ENGINE_STEP_TYPES: EngineStepType[] = [
  {
    type: "agent",
    label: "Agent",
    description: "Runs an LLM agent with a prompt, tools, and skills, and returns its answer.",
    category: "action",
  },
  {
    type: "if",
    label: "If / Condition",
    description: "Takes the then or else branch, depending on a condition.",
    category: "control-flow",
  },
  {
    type: "case",
    label: "Case / Switch",
    description: "Takes the branch whose value matches an expression, or the default branch.",
    category: "control-flow",
  },
  {
    type: "iterator",
    label: "Iterator",
    description: "Runs the steps inside it once for each item of a list (loop, for each).",
    category: "control-flow",
  },
  {
    type: "aggregator",
    label: "Aggregator",
    description: "Closes an iterator's loop and collects the results of all passes.",
    category: "control-flow",
  },
  {
    type: "waitFor",
    label: "Wait For",
    description: "Pauses the branch until a signal arrives or the timeout expires.",
    category: "control-flow",
  },
  {
    type: "humanTask",
    label: "Human Task",
    description: "Asks a person in the portal for a decision or input and waits for the answer (approval).",
    category: "control-flow",
    hitlOnly: true,
  },
];

/**
 * Reads the Markdown docs of a workflows-owned step type.
 *
 * @param type - Step type identifier (the doc file's base name)
 * @returns The Markdown docs
 * @throws When `stepDocs/<type>.md` is missing
 */
export function readStepDocs(type: string): Promise<string> {
  return Bun.file(`${import.meta.dir}/stepDocs/${type}.md`).text();
}

/**
 * Lists the engine-evaluated step types with their docs.
 *
 * @param options.hitl - Whether human tasks are enabled; `humanTask` is listed only then
 * @returns One {@link StepTypeInfo} per engine step type
 */
export async function listEngineStepTypes(options: { hitl: boolean }): Promise<StepTypeInfo[]> {
  const types = ENGINE_STEP_TYPES.filter((t) => options.hitl || !t.hitlOnly);
  return Promise.all(
    types.map(async ({ hitlOnly: _hitlOnly, ...t }) => ({
      ...t,
      extensionName: ENGINE_OWNER,
      docs: await readStepDocs(t.type),
    })),
  );
}

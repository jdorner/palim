/**
 * Start Workflow step type handler.
 *
 * Dispatches another named workflow run in a fire-and-forget fashion: the step
 * enqueues the target workflow and returns immediately without waiting for it
 * to finish. The started run is fully independent of the current run - its
 * success or failure does not affect the caller.
 *
 * This is deliberately NOT a sub-workflow: there is no join, no result
 * propagation, and no lifecycle coupling. Use it to trigger side-effect
 * pipelines (notifications, cleanups, downstream processing) that should run on
 * their own. If you need the started workflow's result or want failures to
 * propagate, model it as an explicit dependency instead.
 *
 * The `payload` supports `{{template}}` expressions, so it can forward context
 * from the trigger payload or previous step results. When the resolved payload
 * parses as JSON it is forwarded as structured data (so the started workflow
 * can access fields via `{{trigger.<path>}}`); otherwise it is forwarded as a
 * raw string. An omitted payload dispatches the workflow with no payload.
 *
 * The dispatch function is injected by the core-wf-steps extension from
 * `ctx.workflows.dispatch`, keeping this handler decoupled from the workflows
 * extension internals.
 */

import type { StepExecutionContext, StepInputValidation, StepTypeHandler, WorkflowDispatchResult } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { formatValidationErrors } from "@src/utils/validation";

/**
 * Name of the dynamic item provider that supplies the set of known workflow
 * names. Registered by the core-wf-steps extension against
 * `ctx.workflows.names()`. The workflow editor resolves this at request time to
 * populate the `workflowName` dropdown with existing workflows.
 */
export const WORKFLOW_NAMES_PROVIDER = "workflow-names";

/** TypeBox schema for the start-workflow step configuration. */
const StartWorkflowStepConfigSchema = Type.Object(
  {
    workflowName: Type.String({
      title: "Workflow Name",
      description: "Name of the workflow to start. Supports {{template}} expressions.",
      minLength: 1,
      // Resolved at request time to the current set of workflow names so the
      // editor can offer a dropdown instead of a free-text field.
      dynamicItems: WORKFLOW_NAMES_PROVIDER,
    }),
    payload: Type.Optional(
      Type.String({
        title: "Payload",
        description:
          "Payload to pass to the started workflow. Supports {{template}} expressions. Parsed as JSON when possible, otherwise forwarded as a raw string.",
        multiline: true,
      }),
    ),
  },
  { additionalProperties: false },
);

/** Result shape returned by the start-workflow step. */
export interface StartWorkflowResult {
  /** Always `true` once the target workflow has been dispatched (failures throw). */
  started: true;
  /** Name of the workflow that was dispatched. */
  workflowName: string;
  /** Unique identifier for the dispatched workflow run. */
  workflowRunId: string;
}

/**
 * Function that dispatches a named workflow run.
 *
 * Implemented by binding to `ctx.workflows.dispatch` in the extension's
 * `initialize`. Resolves once the run has been created and its jobs enqueued
 * (it does not wait for the run to complete).
 *
 * @param name - The name of the workflow to dispatch
 * @param payload - Optional payload forwarded to the workflow trigger context
 * @returns The dispatched run's identifiers
 * @throws If the workflow does not exist or is disabled
 */
export type WorkflowDispatchFn = (name: string, payload?: unknown) => Promise<WorkflowDispatchResult>;

/**
 * Function returning the names of all currently loaded workflows.
 *
 * Implemented by binding to `ctx.workflows.names()`. Used by
 * {@link StepTypeHandler.validateInput} to check that a statically configured
 * `workflowName` refers to an existing workflow before the step runs.
 *
 * @returns The names of all loaded workflow definitions
 */
export type WorkflowNamesFn = () => string[];

/**
 * Whether a configured value contains a `{{template}}` expression.
 *
 * Templated workflow names cannot be resolved ahead of execution (they depend
 * on runtime data), so validation must skip them.
 *
 * @param value - The raw configured value
 * @returns `true` if the value contains a template expression
 */
function containsTemplate(value: string): boolean {
  return value.includes("{{");
}

/**
 * Attempts to parse a resolved payload string as JSON.
 *
 * Structured payloads let the started workflow access fields via
 * `{{trigger.<path>}}`. When the string is not valid JSON it is forwarded
 * verbatim so plain-text payloads still work.
 *
 * @param raw - The resolved payload string
 * @returns The parsed JSON value, or the original string when parsing fails
 */
function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Creates the Start Workflow step type handler.
 *
 * @param dispatch - Function bound to the workflows extension that starts a named run
 * @param listNames - Function returning the names of all loaded workflows, used
 *   to validate a statically configured `workflowName` before the step runs
 * @returns A {@link StepTypeHandler} for the `start-workflow` step type
 */
export function createStartWorkflowHandler(dispatch: WorkflowDispatchFn, listNames: WorkflowNamesFn): StepTypeHandler {
  return {
    schema: StartWorkflowStepConfigSchema,
    outputSchema: Type.Object({
      started: Type.Boolean({ description: "Always true once the target workflow has been dispatched." }),
      workflowName: Type.String({ description: "Name of the workflow that was dispatched." }),
      workflowRunId: Type.String({ description: "Unique identifier for the dispatched workflow run." }),
    }),
    label: "Start Workflow",
    icon: "FlowArrowIcon",

    /**
     * Validate that this step's configured `workflowName` refers to an existing
     * workflow, giving a producing agent a chance to repair a bad target before
     * the transition. Only static (non-templated) names are checked; templated
     * names are resolved at runtime and cannot be validated here. The `output`
     * of the preceding step is not inspected - this step takes no upstream data.
     *
     * @param _output - The preceding step's output (unused; start-workflow has no input schema)
     * @param stepDef - This step's definition, containing the configured `workflowName`
     * @returns A validation result; invalid when the static name is unknown
     */
    validateInput(_output: unknown, stepDef: Record<string, unknown>): StepInputValidation {
      const workflowName = stepDef.workflowName;
      if (typeof workflowName !== "string" || workflowName.trim().length === 0) {
        // Structural problems are reported by execute()'s schema check; nothing
        // to validate here.
        return { valid: true };
      }

      // Templated names depend on runtime data - cannot validate statically.
      if (containsTemplate(workflowName)) {
        return { valid: true };
      }

      const known = listNames();
      if (known.includes(workflowName.trim())) {
        return { valid: true };
      }

      const available = known.length > 0 ? known.slice().sort().join(", ") : "(none loaded)";
      return {
        valid: false,
        diagnostics: [
          `start-workflow step references unknown workflow "${workflowName.trim()}". Available workflows: ${available}.`,
        ],
      };
    },

    async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext): Promise<StartWorkflowResult> {
      const { slug: _slug, type: _type, outputSchema: _os, ...configFields } = stepDef;

      if (!Value.Check(StartWorkflowStepConfigSchema, configFields)) {
        const errorMsg = formatValidationErrors(StartWorkflowStepConfigSchema, configFields);
        throw new Error(`Invalid start-workflow step configuration: ${errorMsg}`);
      }

      const config = configFields as { workflowName: string; payload?: string };

      // Resolve the target workflow name template.
      const { resolved: workflowName, warnings: nameWarnings } = await ctx.resolveTemplate(config.workflowName);
      for (const w of nameWarnings) {
        await ctx.jobLog(`Warning (workflowName): ${w}`);
      }

      const trimmedName = workflowName.trim();
      if (trimmedName.length === 0) {
        throw new Error("start-workflow step: resolved workflow name is empty");
      }

      // Resolve the optional payload template and parse it as JSON when possible.
      let payload: unknown;
      if (config.payload !== undefined) {
        const { resolved, warnings } = await ctx.resolveTemplate(config.payload);
        for (const w of warnings) {
          await ctx.jobLog(`Warning (payload): ${w}`);
        }
        payload = parsePayload(resolved);
      }

      await ctx.jobLog(`Starting workflow "${trimmedName}" (fire-and-forget)`);

      // Fire-and-forget: dispatch resolves once the run is created and its jobs
      // are enqueued. We do NOT await the run's completion, and the started
      // run's outcome is independent of this run.
      const result = await dispatch(trimmedName, payload);

      await ctx.jobLog(`Started workflow "${trimmedName}" -> run ${result.workflowRunId}`);

      return { started: true, workflowName: trimmedName, workflowRunId: result.workflowRunId };
    },
  };
}

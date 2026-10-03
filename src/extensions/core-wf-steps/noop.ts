/**
 * No-op step type handler.
 *
 * Does nothing and completes successfully. Intended as an explicit end marker
 * for control-flow branches (e.g. the `else` branch of an `if` node), so that
 * an intentionally empty branch is distinguishable from one the author forgot
 * to model. It only ends its own branch; it does not stop the workflow run or
 * any parallel branches.
 */

import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { formatValidationErrors } from "@src/utils/validation";

/** TypeBox schema for the noop step configuration (no fields). */
const NoopStepConfigSchema = Type.Object({});

/**
 * Creates the No-op step type handler.
 *
 * @returns A {@link StepTypeHandler} for the `noop` step type
 */
export function createNoopHandler(): StepTypeHandler {
  return {
    schema: NoopStepConfigSchema,
    outputSchema: Type.Object({}),
    label: "End Branch",
    icon: "FlagCheckeredIcon",
    terminal: true,

    async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext): Promise<Record<string, never>> {
      const { slug: _slug, type: _type, outputSchema: _os, ...configFields } = stepDef;

      if (!Value.Check(NoopStepConfigSchema, configFields)) {
        const errorMsg = formatValidationErrors(NoopStepConfigSchema, configFields);
        throw new Error(`Invalid noop step configuration: ${errorMsg}`);
      }

      await ctx.jobLog("No-op step: branch ended");
      return {};
    },
  };
}

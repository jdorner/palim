/**
 * Fail step type handler.
 *
 * Immediately aborts the workflow run by throwing an error with a configurable
 * message. Useful in control-flow branches (e.g. a `case` default path) where
 * hitting a particular branch means something unexpected happened and the
 * workflow should not continue.
 *
 * The message supports `{{template}}` expressions, so it can include context
 * from previous steps or the trigger payload.
 */

import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { formatValidationErrors } from "@src/utils/validation";

/** TypeBox schema for the fail step configuration. */
const FailStepConfigSchema = Type.Object({
  message: Type.Optional(
    Type.String({
      title: "Error Message",
      description: "Message to include in the failure. Supports {{template}} expressions.",
    }),
  ),
});

const DEFAULT_MESSAGE = "Workflow aborted by fail step";

/**
 * Creates the Fail step type handler.
 *
 * @returns A {@link StepTypeHandler} for the `fail` step type
 */
export function createFailHandler(): StepTypeHandler {
  return {
    schema: FailStepConfigSchema,
    label: "Fail",
    icon: "ProhibitIcon",
    terminal: true,

    async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext): Promise<never> {
      const { slug: _slug, type: _type, outputSchema: _os, ...configFields } = stepDef;

      if (!Value.Check(FailStepConfigSchema, configFields)) {
        const errorMsg = formatValidationErrors(FailStepConfigSchema, configFields);
        throw new Error(`Invalid fail step configuration: ${errorMsg}`);
      }

      let message = DEFAULT_MESSAGE;
      if (configFields.message && typeof configFields.message === "string") {
        const { resolved, warnings } = await ctx.resolveTemplate(configFields.message);
        for (const w of warnings) {
          await ctx.jobLog(`Warning (message): ${w}`);
        }
        message = resolved;
      }

      await ctx.jobLog(`Fail step triggered: ${message}`);
      throw new Error(message);
    },
  };
}

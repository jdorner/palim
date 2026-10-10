/**
 * DAG Emit step type handler.
 *
 * Fires a named signal to resume other DAG workflows paused on a matching
 * `waitFor` node. Returns the event name and delivery count.
 *
 * Registered as a `StepTypeHandler` by the workflows extension. When executed,
 * it queries the Signal Store for `broadcast` signals waiting on the resolved
 * event, narrowed by an optional correlation key and target run, and delivers
 * to each through {@link deliverSignal}. `instance` signals are never reached.
 *
 * @module
 */

import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import type { DagCoordinatorDeps } from "./dagCoordinator";
import { deliverSignal } from "./signalDelivery";
import * as signalStore from "./signalStore";

/** Dependencies injected into the DAG emit handler factory. */
export interface DagEmitHandlerDeps {
  /** Coordinator dependencies for resuming waiting runs. */
  coordinatorDeps: DagCoordinatorDeps;
}

/** TypeBox schema for the emit step configuration. */
const EmitStepConfigSchema = Type.Object({
  event: Type.String({
    title: "Event",
    description: "Signal event name to emit. Supports {{template}} expressions.",
    minLength: 1,
    maxLength: 128,
  }),
  payload: Type.Optional(
    Type.String({
      title: "Payload",
      description: "Optional payload template expression delivered to waiting runs.",
    }),
  ),
  correlate: Type.Optional(
    Type.String({
      title: "Correlation Key",
      description:
        "Only resume waits whose correlation key equals this value (waits without a key are still resumed). Supports {{template}} expressions.",
    }),
  ),
  targetRun: Type.Optional(
    Type.String({
      title: "Target Run",
      description: "Only resume waits of this workflow run ID. Supports {{template}} expressions.",
    }),
  ),
});

/** Result shape returned by the emit step. */
export interface EmitStepResult {
  /** The resolved event name that was emitted. */
  event: string;
  /** Number of waiting runs that received the signal. */
  delivered: number;
}

/**
 * Creates the DAG emit step type handler.
 *
 * @param deps - Coordinator dependencies needed for signal delivery
 * @returns A {@link StepTypeHandler} for the `emit` step type
 */
export function createDagEmitHandler(deps: DagEmitHandlerDeps): StepTypeHandler {
  return {
    schema: EmitStepConfigSchema,
    label: "Emit Signal",
    icon: "BroadcastIcon",

    async execute(stepDef: Record<string, unknown>, ctx: StepExecutionContext): Promise<EmitStepResult> {
      const eventTemplate = stepDef.event as string;
      const payloadTemplate = stepDef.payload as string | undefined;
      const correlateTemplate = stepDef.correlate as string | undefined;
      const targetRunTemplate = stepDef.targetRun as string | undefined;
      const runId = ctx.workflowRunId;

      /**
       * Resolves a template field, logging warnings and failing the step when
       * any expression stays unresolved.
       */
      async function resolveRequired(template: string, field: string): Promise<string> {
        const { resolved, warnings } = await ctx.resolveTemplate(template);
        for (const w of warnings) {
          await ctx.jobLog(`Warning (${field}): ${w}`);
        }
        const unresolvable =
          warnings.some((w) => w.includes("Unresolvable") || w.includes("Unknown step slug")) ||
          resolved.includes("{{");
        if (unresolvable) {
          throw new Error(`Template resolution failed for emit ${field}: unresolvable expression in "${template}"`);
        }
        return resolved;
      }

      const resolvedEvent = await resolveRequired(eventTemplate, "event");

      // Resolve the optional payload template expression
      let resolvedPayload: unknown = null;
      if (payloadTemplate) {
        const resolved = await resolveRequired(payloadTemplate, "payload");
        try {
          resolvedPayload = JSON.parse(resolved);
        } catch {
          resolvedPayload = resolved;
        }
      }

      const correlationKey = correlateTemplate ? await resolveRequired(correlateTemplate, "correlate") : undefined;
      const targetRun = targetRunTemplate ? await resolveRequired(targetRunTemplate, "targetRun") : undefined;

      // Broadcast signals waiting on the event, narrowed by key and target run
      const waitingSignals = signalStore.findBroadcastMatches(resolvedEvent, { correlationKey, runId: targetRun });

      let deliveredCount = 0;

      for (const signal of waitingSignals) {
        // Don't self-signal
        if (runId && signal.runId === runId) continue;

        try {
          const result = deliverSignal(signal.id, resolvedPayload, {
            via: "emit",
            coordinatorDeps: deps.coordinatorDeps,
          });
          if (result.ok) {
            deliveredCount++;
          } else {
            await ctx.jobLog(
              `Skipped run ${signal.runId} (step ${signal.stepSlug}): ${result.error}${
                result.details ? ` ${JSON.stringify(result.details)}` : ""
              }`,
            );
          }
        } catch (err) {
          deps.coordinatorDeps.log.error(
            `Failed to deliver emit signal "${resolvedEvent}" to run ${signal.runId} (step ${signal.stepSlug}):`,
            err,
          );
        }
      }

      await ctx.jobLog(`Emitted event "${resolvedEvent}", delivered to ${deliveredCount} run(s)`);

      return { event: resolvedEvent, delivered: deliveredCount };
    },
  };
}

/**
 * DAG Emit step type handler.
 *
 * Fires a named signal to resume other DAG workflows paused on a matching
 * `waitFor` node. Returns the event name and delivery count.
 *
 * Registered as a `StepTypeHandler` by the workflows extension. When executed,
 * it queries the Signal Store for runs waiting on the resolved event and resumes
 * each via the DAG coordinator's {@link resumeWaitForNode}.
 *
 * @module
 */

import type { StepExecutionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import type { DagCoordinatorDeps } from "./dagCoordinator";
import { resumeWaitForNode } from "./dagCoordinator";
import * as signalStore from "./signalStore";
import * as signalTimers from "./signalTimers";

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
      const runId = ctx.workflowRunId;

      // Resolve the event name template expression
      const { resolved: resolvedEvent, warnings: eventWarnings } = await ctx.resolveTemplate(eventTemplate);
      for (const w of eventWarnings) {
        await ctx.jobLog(`Warning (event): ${w}`);
      }
      const hasUnresolvableEvent =
        eventWarnings.some((w) => w.includes("Unresolvable") || w.includes("Unknown step slug")) ||
        resolvedEvent.includes("{{");
      if (hasUnresolvableEvent) {
        throw new Error(`Template resolution failed for emit event: unresolvable expression in "${eventTemplate}"`);
      }

      // Resolve the optional payload template expression
      let resolvedPayload: unknown = null;
      if (payloadTemplate) {
        const { resolved, warnings } = await ctx.resolveTemplate(payloadTemplate);
        for (const w of warnings) {
          await ctx.jobLog(`Warning (payload): ${w}`);
        }
        const hasUnresolvablePayload =
          warnings.some((w) => w.includes("Unresolvable") || w.includes("Unknown step slug")) ||
          resolved.includes("{{");
        if (hasUnresolvablePayload) {
          throw new Error(
            `Template resolution failed for emit payload: unresolvable expression in "${payloadTemplate}"`,
          );
        }
        try {
          resolvedPayload = JSON.parse(resolved);
        } catch {
          resolvedPayload = resolved;
        }
      }

      // Query Signal Store for all runs waiting on the resolved event
      const waitingSignals = signalStore.getAllWaitingByEvent(resolvedEvent);

      let deliveredCount = 0;

      for (const signal of waitingSignals) {
        // Don't self-signal
        if (runId && signal.runId === runId) continue;

        try {
          // Atomically mark the signal received
          signalStore.markReceived(signal.id, resolvedPayload);
          signalTimers.cancel(signal.id);

          // Verify the mark succeeded (race protection)
          const stillWaiting = signalStore.getWaiting(signal.runId, signal.event);
          if (stillWaiting) continue;

          // Resume the waiting run via the DAG coordinator (fire-and-forget)
          resumeWaitForNode(signal.runId, signal.stepSlug, resolvedPayload, deps.coordinatorDeps).catch((err) => {
            deps.coordinatorDeps.log.error(
              `Failed to resume run ${signal.runId} (step ${signal.stepSlug}) after emit "${resolvedEvent}":`,
              err,
            );
          });

          deliveredCount++;
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

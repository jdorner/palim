/**
 * Emit step type handler.
 *
 * Fires a named signal to resume other workflows that are paused on a
 * matching `waitFor` node. Returns the event name and delivery count.
 *
 * This handler is registered as a `StepTypeHandler` by the workflows
 * extension during initialization, allowing `emit` steps to be processed
 * by the queue worker like any other custom step type.
 *
 * @module
 */

import type { Logger, StepExecutionContext, StepTypeHandler } from "@ext/types";
import type { WorkflowWebSocketEvent } from "@shared/workflows";
import { Type } from "@sinclair/typebox";
import type { FlowProducer } from "bunqueue/client";
import type { SessionFactory } from "./engine";
import * as runStore from "./runStore";
import type { WorkflowStep } from "./schemas";
import { dispatchNextSegment } from "./segmentDispatcher";
import * as signalStore from "./signalStore";

/** Dependencies injected into the emit handler factory at creation time. */
export interface EmitHandlerDeps {
  /** FlowProducer for dispatching step chains when resuming waiting runs. */
  flowProducer: FlowProducer;
  /** Session factory for creating per-step sessions in resumed runs. */
  sessionFactory: SessionFactory;
  /** Logger instance. */
  log: Logger;
  /** Broadcasts a WebSocket event to connected clients. */
  broadcast: (event: WorkflowWebSocketEvent) => void;
  /** Retrieves a workflow definition by name (for cross-workflow dispatch). */
  getWorkflowDefinition: (name: string) => { steps: WorkflowStep[] } | undefined;
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
 * Creates the emit step type handler.
 *
 * The handler resolves the event name and optional payload via template
 * expressions, queries the Signal Store for runs waiting on that event,
 * delivers the signal to each, and resumes their execution.
 *
 * @param deps - Workflow engine internals needed for signal delivery
 * @returns A {@link StepTypeHandler} for the `emit` step type
 */
export function createEmitHandler(deps: EmitHandlerDeps): StepTypeHandler {
  return {
    schema: EmitStepConfigSchema,
    label: "Emit Signal",
    icon: "\uD83D\uDCE1",

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
        // Try to parse as JSON, fall back to raw string
        try {
          resolvedPayload = JSON.parse(resolved);
        } catch {
          resolvedPayload = resolved;
        }
      }

      // Query Signal Store for all runs waiting on the resolved event
      const waitingSignals = signalStore.getAllWaitingByEvent(resolvedEvent);

      // Deliver to each matching run
      let deliveredCount = 0;

      for (const signal of waitingSignals) {
        // Skip signals belonging to the current run (don't self-signal)
        if (runId && signal.runId === runId) {
          continue;
        }

        try {
          // Mark signal as received with the resolved payload
          signalStore.markReceived(signal.id, resolvedPayload);

          // Store payload as the waitFor step's result in Run Store
          runStore.updateStepResult(signal.runId, signal.stepSlug, resolvedPayload);

          // Transition the waiting run to "running" status
          runStore.updateStatus(signal.runId, "running");

          // Broadcast workflow_step_resumed for that run
          deps.broadcast({
            type: "workflow_step_resumed",
            workflowRunId: signal.runId,
            stepSlug: signal.stepSlug,
            signalEvent: resolvedEvent,
          });

          // Dispatch the next segment for the waiting run (fire-and-forget)
          const waitingRun = runStore.get(signal.runId);
          if (waitingRun) {
            const nextIndex = waitingRun.currentStepIndex + 1;

            // Look up workflow definition for the waiting run
            const wfDef = deps.getWorkflowDefinition(waitingRun.workflowName);

            if (wfDef) {
              // Fire-and-forget: don't await the dispatch of notified runs
              dispatchNextSegment(signal.runId, nextIndex, {
                steps: wfDef.steps,
                allStepDefs: Object.fromEntries(wfDef.steps.map((s) => [s.slug, s])),
                flowProducer: deps.flowProducer,
                sessionFactory: deps.sessionFactory,
                log: deps.log,
                broadcast: deps.broadcast,
                getWorkflowDefinition: deps.getWorkflowDefinition,
              }).catch((err) => {
                deps.log.error(`Failed to dispatch next segment for notified run ${signal.runId} after emit:`, err);
                try {
                  runStore.updateStatus(
                    signal.runId,
                    "failed",
                    `Segment dispatch failed after emit signal: ${err instanceof Error ? err.message : String(err)}`,
                  );
                } catch {
                  // best effort
                }
                deps.broadcast({
                  type: "workflow_failed",
                  workflowRunId: signal.runId,
                  failedStep: signal.stepSlug,
                  error: `Segment dispatch failed after emit signal: ${err instanceof Error ? err.message : String(err)}`,
                });
              });
            } else {
              deps.log.warn(
                `Workflow definition "${waitingRun.workflowName}" not found for notified run ${signal.runId} after emit`,
              );
            }
          }

          deliveredCount++;
        } catch (err) {
          // Partial failure: log error, exclude from count, continue
          deps.log.error(
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

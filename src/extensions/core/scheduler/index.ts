/**
 * Scheduler extension - provides cron and interval-based job scheduling
 * via the {@link ManagedQueuePort} abstraction. Schedules are persisted by
 * bunqueue's SQLite-backed scheduler, so they survive restarts.
 *
 * When a scheduled job fires, the extension emits a `"scheduler:fired"`
 * domain event on the shared event bus. Downstream consumers (e.g. the
 * workflows extension) subscribe to this event to dispatch work.
 *
 * State is encapsulated in a factory function so each call to
 * {@link createExtension} produces an isolated instance.
 *
 * Exposes:
 * - A `scheduler` skill with a `schedule` shell command for the agent
 * - REST routes under `/ext/scheduler/` for frontend integration
 * - A queue that processes scheduled jobs by emitting events
 */

import { formatValidationErrors } from "@ext/sdk";
import type {
  EventParam,
  Extension,
  ExtensionContext,
  ExtensionManifest,
  Logger,
  ManagedQueuePort,
  QueueJob,
  SchedulerInfo,
} from "@ext/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Payload for jobs produced by the scheduler. */
interface ScheduledJobData {
  /** Human-readable description of what this schedule does. */
  description?: string;
  /** Scheduler identifier. */
  schedulerId: string;
  /** Human-readable schedule label. */
  label?: string;
  /** IANA timezone for cron patterns (e.g. "Europe/Berlin"). */
  tz?: string;
}

/** Result returned by the scheduled job processor. */
interface ScheduledJobResult {
  /** Timestamp when the event was emitted. */
  timestamp: number;
}

/** TypeBox schema for the REST create-schedule payload. */
const CreateSchedulePayload = Type.Object({
  id: Type.String({ minLength: 1, description: "Unique scheduler ID" }),
  name: Type.String({ minLength: 1, description: "Human-readable label" }),
  description: Type.Optional(Type.String({ description: "What this schedule does" })),
  pattern: Type.Optional(Type.String({ description: "Cron expression" })),
  every: Type.Optional(Type.Number({ minimum: 1000, description: "Interval in ms" })),
  limit: Type.Optional(Type.Number({ minimum: 1, description: "Max number of executions (omit for infinite)" })),
  tz: Type.Optional(Type.String({ description: "IANA timezone" })),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const manifest = {
  name: "scheduler",
  version: "1.0.0",
  description: "Cron and interval-based job scheduling with persistent schedules",
  dependencies: [],
  core: true,
  ui: {
    navigation: [
      {
        label: "Schedules",
        route: "/schedules",
        icon: "ClockIcon",
        order: 60,
        badgeKey: "scheduleCount",
        iconColor: "text-blue-500 dark:text-blue-300",
      },
    ],
  },
} satisfies ExtensionManifest;

/**
 * Creates a fresh Scheduler extension instance with its own encapsulated state.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  let logger: Logger;
  let emitEvent: (event: EventParam) => void;
  let queue: ManagedQueuePort<ScheduledJobData> | null = null;

  /**
   * Processes a scheduled job by emitting a `"scheduler:fired"` domain event
   * on the shared event bus.
   *
   * @param job - The scheduled job to process
   * @returns The timestamp when the event was emitted
   */
  async function processScheduledJob(job: QueueJob<ScheduledJobData>): Promise<ScheduledJobResult> {
    const { description, schedulerId, label } = job.data;

    job.log(`Firing schedule "${schedulerId}"`);

    emitEvent({
      type: "scheduler:fired",
      context: {
        source: "scheduler",
        id: schedulerId,
        slug: schedulerId,
        description,
        label,
      },
    });

    job.log(`Emitted "scheduler:fired" event for "${schedulerId}"`);
    return { timestamp: Date.now() };
  }

  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      logger = ctx.log;

      // Capture emitEvent for use by the job processor
      emitEvent = (event) => ctx.emitEvent(event);

      // Create a queue for scheduled jobs
      queue = ctx.createQueue<ScheduledJobData, ScheduledJobResult>("jobs", processScheduledJob, {
        concurrency: 1,
        removeOnComplete: false,
        removeOnFail: false,
      });

      /**
       * Extracts a frontend-friendly schedule entry from a {@link SchedulerInfo},
       * pulling `description` and `label` from the persisted cron data.
       */
      function toScheduleEntry(s: SchedulerInfo) {
        const data = s.data as Record<string, unknown> | undefined;
        return {
          ...s,
          name: (data?.label as string) ?? s.name,
          description: (data?.description as string) ?? undefined,
          tz: (data?.tz as string) ?? undefined,
        };
      }

      /**
       * Fetches the current schedule list, extracts description and label from
       * persisted scheduler data, and broadcasts to all WS clients.
       */
      async function broadcastSchedules(): Promise<void> {
        if (!queue) return;
        const schedulers = await queue.getSchedulers();
        ctx.broadcast({ type: "schedules_updated", schedules: schedulers.map(toScheduleEntry) });
      }

      // Log existing schedulers
      const existing = await queue.getSchedulers();
      logger.info(`Loaded ${existing.length} existing scheduler(s)`);

      // -- REST routes -------------------------------------------------------

      // GET /ext/scheduler/schedules - list all schedulers
      ctx.registerRoute("GET", "/schedules", async () => {
        if (!queue) return Response.json({ error: "Scheduler not initialized" }, { status: 500 });
        const schedulers = await queue.getSchedulers();
        return Response.json(schedulers.map(toScheduleEntry));
      });

      // POST /ext/scheduler/schedules - create a new scheduler
      ctx.registerRoute("POST", "/schedules", async (reqCtx) => {
        if (!queue) return Response.json({ error: "Scheduler not initialized" }, { status: 500 });

        const body = reqCtx.body as Record<string, unknown>;
        if (!Value.Check(CreateSchedulePayload, body)) {
          return Response.json(
            { error: `Validation failed: ${formatValidationErrors(CreateSchedulePayload, body)}` },
            { status: 400 },
          );
        }

        const schedulers = await queue.getSchedulers();
        if (schedulers.some((s) => s.id === body.id)) {
          return Response.json({ error: `Schedule "${body.id}" already exists` }, { status: 409 });
        }

        const { id, name, description, pattern, every, limit, tz } = body as {
          id: string;
          name: string;
          description?: string;
          pattern?: string;
          every?: number;
          limit?: number;
          tz?: string;
        };

        if (!pattern && !every) {
          return Response.json({ error: "Provide either pattern (cron) or every (ms interval)" }, { status: 400 });
        }

        const result = await queue.upsertScheduler(
          id,
          { pattern, every, limit, tz },
          { name: `${id}`, data: { description, schedulerId: id, label: name, tz } },
        );

        await broadcastSchedules();
        return Response.json({ scheduler: result, name }, { status: 201 });
      });

      // POST /ext/scheduler/schedules/:id/trigger - manually fire a schedule
      // Emits a scheduler:fired event directly without creating a queue job,
      // so this does not count as a scheduler execution.
      ctx.registerRoute("POST", "/schedules/:id/trigger", async (reqCtx) => {
        if (!queue) {
          return Response.json({ error: "Scheduler not initialized" }, { status: 500 });
        }

        const id = (reqCtx.params as Record<string, string>).id;
        if (!id) return Response.json({ error: "Missing scheduler ID" }, { status: 400 });

        const info = await queue.getScheduler(id);
        if (!info) return Response.json({ error: "Schedule not found" }, { status: 404 });

        const data = info.data as Record<string, unknown> | undefined;
        const description = data?.description as string | undefined;
        const label = data?.label as string | undefined;

        // Emit event directly - bypasses the scheduler queue so this
        // doesn't increment the scheduler's execution count.
        ctx.emitEvent({
          type: "scheduler:fired",
          context: {
            source: "scheduler",
            id,
            slug: id,
            description,
            label,
          },
        });

        logger.info(`Manually triggered schedule "${id}" -> emitted scheduler:fired event`);
        return Response.json({ ok: true });
      });

      // DELETE /ext/scheduler/schedules/:id - remove a scheduler
      ctx.registerRoute("DELETE", "/schedules/:id", async (reqCtx) => {
        if (!queue) return Response.json({ error: "Scheduler not initialized" }, { status: 500 });

        const id = (reqCtx.params as Record<string, string>).id;
        if (!id) return Response.json({ error: "Missing scheduler ID" }, { status: 400 });

        const removed = await queue.removeScheduler(id);
        if (!removed) return Response.json({ error: "Not found" }, { status: 404 });

        await broadcastSchedules();
        return Response.json({ ok: true });
      });
    },

    async shutdown() {
      if (queue) {
        await queue.close();
        queue = null;
      }
    },
  };
}

export default createExtension();

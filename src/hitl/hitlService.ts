/**
 * Human task (HITL) service.
 *
 * Creates tasks on behalf of a source (v1: workflow `humanTask` steps),
 * decides who may see and answer them, records answers, and hands the answer
 * back to the source through a registered {@link HitlSourceHandler}.
 *
 * The service knows nothing about HTTP or the auth subsystem: callers describe
 * the acting user as a {@link HitlViewer}, and user/role lookups go through an
 * injected {@link HitlDirectory}. Failures are thrown as {@link HitlError} with
 * an HTTP-style status so routes can map them directly.
 *
 * Visibility: a user sees a task if it is assigned to them (directly or via
 * one of their roles), if they completed it, or if they manage tasks. Only
 * assignees and managers may answer.
 *
 * @module
 */

import {
  DEFAULT_HUMAN_TASK_OUTCOMES,
  type HumanTask,
  type HumanTaskCounts,
  type HumanTaskDetail,
  type HumanTaskStatus,
  type HumanTaskUserRef,
} from "@shared/portal";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { validateJsonSchema } from "@src/utils/jsonSchema";
import createLogger from "logging";
import { type TaskAssignees, type TaskRecord, TaskStore, type TaskVisibility } from "./taskStore";
import type { CreateTaskInput, HitlSourceHandler } from "./types";

export type { CreateTaskInput, HitlSourceHandler } from "./types";

const log = createLogger("HitlService");

/** Window for the "due soon" count. */
const DUE_SOON_MS = 24 * 60 * 60 * 1000;

/** The user acting on tasks. */
export interface HitlViewer {
  /** User ID. */
  userId: string;
  /** Role names the user holds. */
  roleNames: string[];
  /** Whether the user manages tasks (sees and may answer all, cancels, reassigns). */
  canManage: boolean;
}

/** User and role lookups the service needs. */
export interface HitlDirectory {
  /** Resolves a username to a user ID (null if unknown). */
  findUserIdByUsername(username: string): string | null;
  /** Whether a role with this name exists. */
  roleExists(name: string): boolean;
  /** Describes a user for display (null if unknown). */
  describeUser(id: string): HumanTaskUserRef | null;
}

/** A change notification for live updates (SSE, WebSocket). */
export interface HitlChange {
  /** `created` for new tasks, `updated` for every later change. */
  type: "created" | "updated";
  /** The task after the change. */
  task: TaskRecord;
  /** The task before the change (`updated` only), to detect who lost visibility. */
  previous?: TaskRecord;
}

/** Error with an HTTP-style status. */
export class HitlError extends Error {
  /**
   * @param status - 400 invalid input, 403 not allowed, 404 not found/visible, 409 conflict, 422 invalid answer
   * @param message - Human-readable reason
   * @param details - Optional validation details
   */
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "HitlError";
  }
}

/** Outcome ID pattern. */
const OUTCOME_ID_PATTERN = "^[a-z][a-z0-9_-]*$";

/** Input schema of {@link HitlService.createTask}. */
export const CreateTaskInputSchema = Type.Object(
  {
    source: Type.Object({
      kind: Type.String({ minLength: 1, maxLength: 64 }),
      id: Type.String({ minLength: 1, maxLength: 256 }),
      ref: Type.Record(Type.String(), Type.Unknown()),
    }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    body: Type.Optional(Type.String({ maxLength: 20_000 })),
    context: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
    outcomes: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 64, pattern: OUTCOME_ID_PATTERN }),
            label: Type.String({ minLength: 1, maxLength: 64 }),
            style: Type.Optional(
              Type.Union([Type.Literal("primary"), Type.Literal("danger"), Type.Literal("default")]),
            ),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 10 },
      ),
    ),
    form: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
    requireComment: Type.Optional(Type.Boolean()),
    priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")])),
    dueAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    assignees: Type.Object({
      users: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
      roles: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
    }),
    createdBy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);

// The runtime schema must accept exactly the contract type.
type _SchemaMatchesInput =
  Static<typeof CreateTaskInputSchema> extends CreateTaskInput
    ? CreateTaskInput extends Static<typeof CreateTaskInputSchema>
      ? true
      : never
    : never;
const _schemaMatchesInput: _SchemaMatchesInput = true;
void _schemaMatchesInput;

/** An answer to a task. */
export interface CompleteTaskInput {
  /** The chosen outcome ID. */
  outcome: string;
  /** Form data (required when the task has a form). */
  data?: unknown;
  /** Comment (required when the task requires one). */
  comment?: string | null;
  /** The version the user answered; a changed task is rejected with 409. Omit to skip the check. */
  version?: number;
}

/** Which tasks to list. */
export interface ListTasksOptions {
  /** `mine` (assigned to or completed by the viewer, default), `completed` (completed by the viewer), or `all` (managers). */
  scope?: "mine" | "completed" | "all";
  /** Only tasks with this status. */
  status?: HumanTaskStatus;
  /** Page size (default 50, max 200). */
  limit?: number;
  /** Cursor from a previous page's `nextCursor`. */
  cursor?: string;
}

/** A page of tasks. */
export interface TaskPage {
  /** The tasks, newest first. */
  tasks: HumanTask[];
  /** Cursor for the next page, or null when this is the last page. */
  nextCursor: string | null;
}

/** Dependencies of {@link createHitlService}. */
export interface HitlServiceDeps {
  /** Task persistence. */
  store: TaskStore;
  /** User and role lookups. */
  directory: HitlDirectory;
  /** Clock (injectable for tests). */
  now?: () => number;
}

/** Encodes a keyset cursor. */
function encodeCursor(task: TaskRecord): string {
  return `${task.createdAt}.${task.id}`;
}

/** Decodes a keyset cursor (throws 400 on garbage). */
function decodeCursor(cursor: string): { createdAt: number; id: string } {
  const dot = cursor.indexOf(".");
  const createdAt = Number(cursor.slice(0, dot));
  const id = cursor.slice(dot + 1);
  if (dot <= 0 || !Number.isSafeInteger(createdAt) || id.length === 0) {
    throw new HitlError(400, "Invalid cursor");
  }
  return { createdAt, id };
}

/**
 * Creates the HITL service.
 *
 * @param deps - Store, directory, and clock
 * @returns The service
 */
export function createHitlService(deps: HitlServiceDeps) {
  const { store, directory } = deps;
  const now = deps.now ?? Date.now;
  const sourceHandlers = new Map<string, HitlSourceHandler>();
  const listeners = new Set<(change: HitlChange) => void>();

  /** Notifies change listeners; a throwing listener does not affect others. */
  function notify(change: HitlChange): void {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (err) {
        log.error("HITL change listener failed:", err);
      }
    }
  }

  /** Runs a source callback, logging failures. */
  async function callSource(
    task: TaskRecord,
    pick: (handler: HitlSourceHandler) => (() => void | Promise<void>) | undefined,
  ): Promise<void> {
    const handler = sourceHandlers.get(task.source.kind);
    if (!handler) {
      log.warn(`No HITL source handler registered for "${task.source.kind}" (task ${task.id})`);
      return;
    }
    const callback = pick(handler);
    if (!callback) return;
    try {
      await callback();
    } catch (err) {
      log.error(`HITL source handler "${task.source.kind}" failed for task ${task.id}:`, err);
    }
  }

  /** Visibility restriction for store queries. */
  function visibility(viewer: HitlViewer): TaskVisibility {
    return { userId: viewer.userId, roleNames: viewer.roleNames };
  }

  /** Whether the viewer may answer a task. */
  function canRespond(task: TaskRecord, viewer: HitlViewer): boolean {
    return viewer.canManage || TaskStore.isAssignee(task, visibility(viewer));
  }

  /** Whether the viewer may see a task. */
  function canSee(task: TaskRecord, viewer: HitlViewer): boolean {
    return canRespond(task, viewer) || task.completedBy === viewer.userId;
  }

  /** Loads a task the viewer may see, or throws 404. */
  function loadVisible(id: string, viewer: HitlViewer): TaskRecord {
    const task = store.get(id);
    // Not visible looks exactly like not found, so task IDs leak nothing.
    if (!task || !canSee(task, viewer)) throw new HitlError(404, "Task not found");
    return task;
  }

  /** Throws 403 unless the viewer manages tasks. */
  function requireManager(viewer: HitlViewer): void {
    if (!viewer.canManage) throw new HitlError(403, "Managing tasks requires the hitl:manage permission");
  }

  /** Resolves usernames and validates role names. */
  function resolveAssignees(input: { users?: string[]; roles?: string[] }): TaskAssignees {
    const users: string[] = [];
    const unknownUsers: string[] = [];
    for (const username of input.users ?? []) {
      const id = directory.findUserIdByUsername(username);
      if (id) users.push(id);
      else unknownUsers.push(username);
    }
    const roles = [...new Set(input.roles ?? [])];
    const unknownRoles = roles.filter((r) => !directory.roleExists(r));
    if (unknownUsers.length > 0 || unknownRoles.length > 0) {
      const parts = [
        unknownUsers.length > 0 ? `unknown user(s): ${unknownUsers.join(", ")}` : "",
        unknownRoles.length > 0 ? `unknown role(s): ${unknownRoles.join(", ")}` : "",
      ].filter(Boolean);
      throw new HitlError(400, `Invalid assignees - ${parts.join("; ")}`);
    }
    if (users.length === 0 && roles.length === 0) {
      throw new HitlError(400, "A task needs at least one assignee (user or role)");
    }
    return { users: [...new Set(users)], roles };
  }

  /** Describes a user, tolerating deleted users. */
  function userRef(id: string | null): HumanTaskUserRef | null {
    return id ? directory.describeUser(id) : null;
  }

  /** Converts a record to the wire shape for a viewer. */
  function toView(task: TaskRecord, viewer: HitlViewer): HumanTask {
    return {
      id: task.id,
      title: task.title,
      body: task.body,
      context: task.context,
      outcomes: task.outcomes,
      formSchema: task.formSchema,
      requireComment: task.requireComment,
      priority: task.priority,
      status: task.status,
      dueAt: task.dueAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      assignees: {
        users: task.assignees.users.map(userRef).filter((u): u is HumanTaskUserRef => u !== null),
        roles: task.assignees.roles,
      },
      canRespond: task.status === "open" && canRespond(task, viewer),
      completion:
        task.status === "completed" && task.completedAt !== null && task.outcome !== null
          ? {
              at: task.completedAt,
              by: userRef(task.completedBy),
              outcome: task.outcome,
              data: task.response ?? null,
              comment: task.comment,
            }
          : null,
      source: viewer.canManage ? { kind: task.source.kind, ref: task.source.ref } : { kind: task.source.kind },
      version: task.version,
    };
  }

  return {
    /**
     * Registers the callbacks of a task source. Replaces an earlier handler
     * for the same kind.
     *
     * @param kind - Source kind (e.g. `workflow`)
     * @param handler - The callbacks
     * @returns A function that unregisters the handler
     */
    registerSourceHandler(kind: string, handler: HitlSourceHandler): () => void {
      sourceHandlers.set(kind, handler);
      return () => {
        if (sourceHandlers.get(kind) === handler) sourceHandlers.delete(kind);
      };
    },

    /**
     * Subscribes to task changes.
     *
     * @param listener - Called synchronously after every change
     * @returns A function that unsubscribes
     */
    subscribe(listener: (change: HitlChange) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Creates a task.
     *
     * @param input - Task content, source, and assignees (users by username)
     * @returns The created task
     * @throws {HitlError} 400 for invalid input, unknown assignees, or no assignees
     */
    createTask(input: CreateTaskInput): TaskRecord {
      if (!Value.Check(CreateTaskInputSchema, input)) {
        const first = [...Value.Errors(CreateTaskInputSchema, input)][0];
        throw new HitlError(400, `Invalid task: ${first ? `${first.path} ${first.message}` : "unknown error"}`);
      }
      const outcomes = input.outcomes ?? [...DEFAULT_HUMAN_TASK_OUTCOMES];
      const ids = outcomes.map((o) => o.id);
      if (new Set(ids).size !== ids.length) throw new HitlError(400, "Outcome IDs must be unique");

      const task = store.insert(
        {
          source: input.source,
          title: input.title,
          body: input.body ?? "",
          context: input.context ?? null,
          outcomes,
          formSchema: input.form ?? null,
          requireComment: input.requireComment ?? false,
          priority: input.priority ?? "normal",
          dueAt: input.dueAt ?? null,
          createdBy: input.createdBy ?? null,
          assignees: resolveAssignees(input.assignees),
        },
        now(),
      );
      notify({ type: "created", task });
      return task;
    },

    /**
     * Returns a task with its history. The first view by an assignee of an
     * open task is recorded in the history.
     *
     * @param id - Task ID
     * @param viewer - The acting user
     * @returns The task detail
     * @throws {HitlError} 404 if the task does not exist or is not visible
     */
    getTask(id: string, viewer: HitlViewer): HumanTaskDetail {
      const task = loadVisible(id, viewer);
      if (task.status === "open" && canRespond(task, viewer) && !store.hasViewed(id, viewer.userId)) {
        store.appendEvent({ taskId: id, at: now(), actorId: viewer.userId, kind: "viewed", data: null });
      }
      return {
        ...toView(task, viewer),
        history: store.listEvents(id).map((e) => ({
          at: e.at,
          kind: e.kind,
          actor: userRef(e.actorId),
          data: e.data,
        })),
      };
    },

    /**
     * Lists the tasks a viewer may see, newest first.
     *
     * @param viewer - The acting user
     * @param options - Scope, status, paging
     * @returns A page of tasks
     * @throws {HitlError} 403 for `scope: "all"` without manage rights, 400 for a bad cursor
     */
    listTasks(viewer: HitlViewer, options: ListTasksOptions = {}): TaskPage {
      const scope = options.scope ?? "mine";
      if (scope === "all") requireManager(viewer);
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const records = store.list({
        status: options.status,
        visibleTo: scope === "all" ? undefined : visibility(viewer),
        completedByViewer: scope === "completed",
        limit: limit + 1,
        before: options.cursor ? decodeCursor(options.cursor) : undefined,
      });
      const page = records.slice(0, limit);
      return {
        tasks: page.map((t) => toView(t, viewer)),
        nextCursor: records.length > limit ? encodeCursor(page[page.length - 1]!) : null,
      };
    },

    /**
     * Counts the open tasks assigned to a viewer.
     *
     * @param viewer - The acting user
     * @returns Open and due-soon counts
     */
    countTasks(viewer: HitlViewer): HumanTaskCounts {
      const assignedTo = visibility(viewer);
      return {
        open: store.countOpen({ assignedTo }),
        dueSoon: store.countOpen({ assignedTo, dueBefore: now() + DUE_SOON_MS }),
      };
    },

    /**
     * Answers a task and hands the answer to its source.
     *
     * @param id - Task ID
     * @param viewer - The acting user
     * @param input - Outcome, form data, comment, expected version
     * @returns The completed task
     * @throws {HitlError} 404 not visible, 403 not an assignee, 409 no longer open or changed, 422 invalid answer
     */
    async completeTask(id: string, viewer: HitlViewer, input: CompleteTaskInput): Promise<HumanTask> {
      const task = loadVisible(id, viewer);
      if (task.status !== "open") throw new HitlError(409, `Task is already ${task.status}`);
      if (!canRespond(task, viewer)) throw new HitlError(403, "You are not assigned to this task");

      if (!task.outcomes.some((o) => o.id === input.outcome)) {
        throw new HitlError(422, `Unknown outcome "${input.outcome}"`);
      }
      const comment = typeof input.comment === "string" && input.comment.trim() !== "" ? input.comment.trim() : null;
      if (task.requireComment && comment === null) throw new HitlError(422, "A comment is required");
      if (comment !== null && comment.length > 5000) throw new HitlError(422, "Comment is too long");

      let data: unknown = null;
      if (task.formSchema) {
        data = input.data ?? {};
        const validation = validateJsonSchema(task.formSchema, data);
        if (!validation.valid) throw new HitlError(422, "Form data is invalid", validation.errors);
      }

      const completed = store.complete(id, input.version ?? task.version, {
        by: viewer.userId,
        outcome: input.outcome,
        response: data,
        comment,
        at: now(),
      });
      if (!completed) {
        const current = store.get(id);
        throw new HitlError(
          409,
          current && current.status !== "open"
            ? `Task is already ${current.status}`
            : "Task has changed since it was loaded; reload and try again",
        );
      }

      const updated = store.get(id)!;
      notify({ type: "updated", task: updated, previous: task });
      await callSource(updated, (h) => h.onCompleted && (() => h.onCompleted!(updated)));
      return toView(updated, viewer);
    },

    /**
     * Cancels an open task (managers) and tells its source.
     *
     * @param id - Task ID
     * @param viewer - The acting user
     * @param reason - Optional reason, recorded in the history
     * @returns The cancelled task
     * @throws {HitlError} 403 without manage rights, 404 not found, 409 not open
     */
    async cancelTask(id: string, viewer: HitlViewer, reason: string | null = null): Promise<HumanTask> {
      requireManager(viewer);
      const task = loadVisible(id, viewer);
      if (!store.finish(id, "cancelled", { actorId: viewer.userId, data: reason ? { reason } : null, at: now() })) {
        throw new HitlError(409, `Task is already ${store.get(id)?.status ?? task.status}`);
      }
      const updated = store.get(id)!;
      notify({ type: "updated", task: updated, previous: task });
      await callSource(updated, (h) => h.onCancelled && (() => h.onCancelled!(updated, reason)));
      return toView(updated, viewer);
    },

    /**
     * Replaces the assignees of an open task (managers).
     *
     * @param id - Task ID
     * @param viewer - The acting user
     * @param assignees - New assignees (users by username)
     * @returns The updated task
     * @throws {HitlError} 403 without manage rights, 404 not found, 400 invalid assignees, 409 not open
     */
    reassignTask(id: string, viewer: HitlViewer, assignees: { users?: string[]; roles?: string[] }): HumanTask {
      requireManager(viewer);
      const previous = loadVisible(id, viewer);
      const resolved = resolveAssignees(assignees);
      if (!store.reassign(id, resolved, viewer.userId, now())) {
        throw new HitlError(409, `Task is already ${store.get(id)?.status ?? "closed"}`);
      }
      const updated = store.get(id)!;
      notify({ type: "updated", task: updated, previous });
      return toView(updated, viewer);
    },

    /**
     * Cancels all open tasks of a source (e.g. when a workflow run ends).
     * The source is not called back, since it initiated the cancellation.
     *
     * @param kind - Source kind
     * @param sourceId - Source grouping ID
     * @param reason - Optional reason, recorded in the history
     * @returns The number of cancelled tasks
     */
    cancelBySource(kind: string, sourceId: string, reason: string | null = null): number {
      let cancelled = 0;
      for (const task of store.listOpenBySource(kind, sourceId)) {
        if (store.finish(task.id, "cancelled", { data: reason ? { reason } : null, at: now() })) {
          cancelled++;
          notify({ type: "updated", task: store.get(task.id)!, previous: task });
        }
      }
      return cancelled;
    },

    /**
     * Lists the open tasks of a source (e.g. to find the task of a waiting
     * workflow step).
     *
     * @param kind - Source kind
     * @param sourceId - Source grouping ID
     * @returns The open task records
     */
    listOpenBySource(kind: string, sourceId: string): TaskRecord[] {
      return store.listOpenBySource(kind, sourceId);
    },

    /**
     * Marks an open task as expired (called by its source on timeout).
     *
     * @param id - Task ID
     * @returns True if the task was open and is now expired
     */
    expireTask(id: string): boolean {
      const previous = store.get(id);
      if (!previous || !store.finish(id, "expired", { at: now() })) return false;
      notify({ type: "updated", task: store.get(id)!, previous });
      return true;
    },

    /**
     * Describes a user for display.
     *
     * @param id - User ID
     * @returns The user reference, or null if unknown
     */
    describeUser(id: string): HumanTaskUserRef | null {
      return directory.describeUser(id);
    },

    /**
     * Returns a task record without visibility checks (for sources and
     * internal callers).
     *
     * @param id - Task ID
     * @returns The task, or null if not found
     */
    getRecord(id: string): TaskRecord | null {
      return store.get(id);
    },

    /**
     * Converts a task record to the wire shape for a viewer, or null if the
     * viewer may not see it (used to fan out live updates).
     *
     * @param task - The task
     * @param viewer - The viewing user
     * @returns The task view, or null when not visible
     */
    viewFor(task: TaskRecord, viewer: HitlViewer): HumanTask | null {
      return canSee(task, viewer) ? toView(task, viewer) : null;
    },
  };
}

/** The HITL service. */
export type HitlService = ReturnType<typeof createHitlService>;

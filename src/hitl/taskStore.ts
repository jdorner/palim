/**
 * SQLite-backed persistence for human tasks.
 *
 * Owns the three HITL tables (tasks, assignees, history). State transitions
 * out of `open` (complete, cancel, expire) are atomic `UPDATE ... WHERE
 * status = 'open'` statements that report whether this caller won, so two
 * people answering the same task at once cannot both succeed. Completion
 * additionally checks the optimistic `version`.
 *
 * Visibility filtering happens in SQL via the normalized assignee table.
 * Authorization decisions (who is a manager, which roles a user holds) are
 * made by the caller and passed in as a {@link TaskVisibility}.
 *
 * @module
 */

import type { HumanTaskEventKind, HumanTaskOutcome, HumanTaskPriority, HumanTaskStatus } from "@shared/portal";
import type { TaskAssignees, TaskRecord } from "./types";

export type { TaskAssignees, TaskRecord } from "./types";

import { and, asc, desc, eq, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { nanoid } from "nanoid";
import { hitlTaskAssignees, hitlTaskEvents, hitlTasks } from "./hitlSchema";

/** Input for {@link TaskStore.insert}. */
export type NewTask = Pick<
  TaskRecord,
  | "source"
  | "title"
  | "body"
  | "context"
  | "outcomes"
  | "formSchema"
  | "requireComment"
  | "priority"
  | "dueAt"
  | "createdBy"
  | "assignees"
>;

/** A persisted history entry. */
export interface TaskEventRecord {
  taskId: string;
  at: number;
  actorId: string | null;
  kind: HumanTaskEventKind;
  data: Record<string, unknown> | null;
}

/**
 * Restricts queries to the tasks a user may see: tasks assigned to them
 * directly or via one of their roles, and tasks they completed.
 */
export interface TaskVisibility {
  /** The viewing user's ID. */
  userId: string;
  /** The viewing user's role names. */
  roleNames: string[];
}

/** Filter for {@link TaskStore.list}. */
export interface TaskListFilter {
  /** Only tasks with this status. */
  status?: HumanTaskStatus;
  /** Restrict to tasks visible to this user (omit for all tasks). */
  visibleTo?: TaskVisibility;
  /** Only tasks the user completed (requires `visibleTo`). */
  completedByViewer?: boolean;
  /** Page size (default 50, max 200). */
  limit?: number;
  /** Keyset cursor: return tasks created before this task (newest first). */
  before?: { createdAt: number; id: string };
}

/** Completion data for {@link TaskStore.complete}. */
export interface TaskCompletion {
  by: string;
  outcome: string;
  response: unknown;
  comment: string | null;
  at: number;
}

type TaskRow = typeof hitlTasks.$inferSelect;

/** Parses a nullable JSON column. */
function parseJson<T>(value: string | null): T | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * SQLite-backed store for human tasks.
 */
export class TaskStore {
  readonly #db: BunSQLiteDatabase<Record<string, unknown>>;

  /**
   * @param db - The shared Drizzle database instance
   */
  constructor(db: BunSQLiteDatabase<Record<string, unknown>>) {
    this.#db = db;
  }

  /**
   * Inserts a task with its assignees and a `created` history entry.
   *
   * @param task - The task content
   * @param now - Creation timestamp (epoch ms)
   * @returns The persisted task
   */
  insert(task: NewTask, now: number = Date.now()): TaskRecord {
    const id = nanoid();
    this.#db.transaction((tx) => {
      tx.insert(hitlTasks)
        .values({
          id,
          sourceKind: task.source.kind,
          sourceId: task.source.id,
          sourceRef: JSON.stringify(task.source.ref),
          title: task.title,
          body: task.body,
          context: task.context ? JSON.stringify(task.context) : null,
          outcomes: JSON.stringify(task.outcomes),
          formSchema: task.formSchema ? JSON.stringify(task.formSchema) : null,
          requireComment: task.requireComment,
          priority: task.priority,
          status: "open",
          dueAt: task.dueAt,
          createdBy: task.createdBy,
          createdAt: now,
          updatedAt: now,
          version: 1,
        })
        .run();
      this.#insertAssignees(tx, id, task.assignees);
      tx.insert(hitlTaskEvents)
        .values({ taskId: id, at: now, actorId: task.createdBy, kind: "created", data: null })
        .run();
    });
    return this.get(id)!;
  }

  /**
   * Retrieves a task by ID.
   *
   * @param id - The task ID
   * @returns The task, or null if not found
   */
  get(id: string): TaskRecord | null {
    const row = this.#db.select().from(hitlTasks).where(eq(hitlTasks.id, id)).get();
    if (!row) return null;
    return this.#toRecord(row, this.#loadAssignees([id]).get(id));
  }

  /**
   * Lists tasks, newest first.
   *
   * @param filter - Status, visibility, paging
   * @returns The matching tasks
   */
  list(filter: TaskListFilter = {}): TaskRecord[] {
    const conditions: (SQL | undefined)[] = [];
    if (filter.status) conditions.push(eq(hitlTasks.status, filter.status));
    if (filter.visibleTo) {
      conditions.push(
        filter.completedByViewer
          ? eq(hitlTasks.completedBy, filter.visibleTo.userId)
          : this.#visibleCondition(filter.visibleTo),
      );
    }
    if (filter.before) {
      conditions.push(
        or(
          lt(hitlTasks.createdAt, filter.before.createdAt),
          and(eq(hitlTasks.createdAt, filter.before.createdAt), lt(hitlTasks.id, filter.before.id)),
        ),
      );
    }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

    const rows = this.#db
      .select()
      .from(hitlTasks)
      .where(and(...conditions))
      .orderBy(desc(hitlTasks.createdAt), desc(hitlTasks.id))
      .limit(limit)
      .all();

    const assignees = this.#loadAssignees(rows.map((r) => r.id));
    return rows.map((row) => this.#toRecord(row, assignees.get(row.id)));
  }

  /**
   * Counts open tasks, optionally restricted to a user's assignments and to
   * tasks due before a deadline.
   *
   * @param options - Visibility restriction and due deadline
   * @returns The number of matching open tasks
   */
  countOpen(options: { assignedTo?: TaskVisibility; dueBefore?: number } = {}): number {
    const conditions: (SQL | undefined)[] = [eq(hitlTasks.status, "open")];
    if (options.assignedTo) conditions.push(this.#assignedCondition(options.assignedTo));
    if (options.dueBefore !== undefined) {
      conditions.push(sql`${hitlTasks.dueAt} IS NOT NULL AND ${hitlTasks.dueAt} < ${options.dueBefore}`);
    }
    const row = this.#db
      .select({ n: sql<number>`count(*)` })
      .from(hitlTasks)
      .where(and(...conditions))
      .get();
    return row?.n ?? 0;
  }

  /**
   * Whether a task is assigned to a user, directly or via one of their roles.
   *
   * @param task - The task
   * @param viewer - The user
   * @returns True if the user is an assignee
   */
  static isAssignee(task: TaskRecord, viewer: TaskVisibility): boolean {
    return (
      task.assignees.users.includes(viewer.userId) || task.assignees.roles.some((r) => viewer.roleNames.includes(r))
    );
  }

  /**
   * Lists the open tasks created by a source.
   *
   * @param kind - Source kind
   * @param sourceId - Source grouping ID
   * @returns The open tasks
   */
  listOpenBySource(kind: string, sourceId: string): TaskRecord[] {
    const rows = this.#db
      .select()
      .from(hitlTasks)
      .where(and(eq(hitlTasks.sourceKind, kind), eq(hitlTasks.sourceId, sourceId), eq(hitlTasks.status, "open")))
      .all();
    const assignees = this.#loadAssignees(rows.map((r) => r.id));
    return rows.map((row) => this.#toRecord(row, assignees.get(row.id)));
  }

  /**
   * Atomically completes an open task at the expected version and records a
   * `completed` history entry.
   *
   * @param id - The task ID
   * @param version - The version the caller saw
   * @param completion - The answer
   * @returns True if this call completed the task, false if it was not open or the version changed
   */
  complete(id: string, version: number, completion: TaskCompletion): boolean {
    return this.#db.transaction((tx) => {
      const claimed = tx
        .update(hitlTasks)
        .set({
          status: "completed",
          completedAt: completion.at,
          completedBy: completion.by,
          outcome: completion.outcome,
          response: completion.response === undefined ? null : JSON.stringify(completion.response),
          comment: completion.comment,
          updatedAt: completion.at,
          version: sql`${hitlTasks.version} + 1`,
        })
        .where(and(eq(hitlTasks.id, id), eq(hitlTasks.status, "open"), eq(hitlTasks.version, version)))
        .returning({ id: hitlTasks.id })
        .all();
      if (claimed.length !== 1) return false;
      tx.insert(hitlTaskEvents)
        .values({
          taskId: id,
          at: completion.at,
          actorId: completion.by,
          kind: "completed",
          data: JSON.stringify({ outcome: completion.outcome }),
        })
        .run();
      return true;
    });
  }

  /**
   * Atomically ends an open task as cancelled or expired and records the
   * matching history entry.
   *
   * @param id - The task ID
   * @param status - `cancelled` or `expired`
   * @param options - Acting user, details, timestamp
   * @returns True if this call ended the task, false if it was not open
   */
  finish(
    id: string,
    status: "cancelled" | "expired",
    options: { actorId?: string | null; data?: Record<string, unknown> | null; at?: number } = {},
  ): boolean {
    const at = options.at ?? Date.now();
    return this.#db.transaction((tx) => {
      const claimed = tx
        .update(hitlTasks)
        .set({ status, updatedAt: at, version: sql`${hitlTasks.version} + 1` })
        .where(and(eq(hitlTasks.id, id), eq(hitlTasks.status, "open")))
        .returning({ id: hitlTasks.id })
        .all();
      if (claimed.length !== 1) return false;
      tx.insert(hitlTaskEvents)
        .values({
          taskId: id,
          at,
          actorId: options.actorId ?? null,
          kind: status,
          data: options.data ? JSON.stringify(options.data) : null,
        })
        .run();
      return true;
    });
  }

  /**
   * Replaces the assignees of an open task and records a `reassigned` entry.
   *
   * @param id - The task ID
   * @param assignees - The new assignees
   * @param actorId - Acting user
   * @param at - Timestamp (epoch ms)
   * @returns True if the task was open and updated
   */
  reassign(id: string, assignees: TaskAssignees, actorId: string | null, at: number = Date.now()): boolean {
    return this.#db.transaction((tx) => {
      const claimed = tx
        .update(hitlTasks)
        .set({ updatedAt: at, version: sql`${hitlTasks.version} + 1` })
        .where(and(eq(hitlTasks.id, id), eq(hitlTasks.status, "open")))
        .returning({ id: hitlTasks.id })
        .all();
      if (claimed.length !== 1) return false;
      tx.delete(hitlTaskAssignees).where(eq(hitlTaskAssignees.taskId, id)).run();
      this.#insertAssignees(tx, id, assignees);
      tx.insert(hitlTaskEvents)
        .values({
          taskId: id,
          at,
          actorId,
          kind: "reassigned",
          data: JSON.stringify({ users: assignees.users, roles: assignees.roles }),
        })
        .run();
      return true;
    });
  }

  /**
   * Appends a history entry (used for `viewed`).
   *
   * @param event - The entry
   */
  appendEvent(event: TaskEventRecord): void {
    this.#db
      .insert(hitlTaskEvents)
      .values({
        taskId: event.taskId,
        at: event.at,
        actorId: event.actorId,
        kind: event.kind,
        data: event.data ? JSON.stringify(event.data) : null,
      })
      .run();
  }

  /**
   * Whether a user has a `viewed` entry for a task.
   *
   * @param taskId - The task ID
   * @param userId - The user ID
   * @returns True if the user viewed the task before
   */
  hasViewed(taskId: string, userId: string): boolean {
    const row = this.#db
      .select({ id: hitlTaskEvents.id })
      .from(hitlTaskEvents)
      .where(
        and(eq(hitlTaskEvents.taskId, taskId), eq(hitlTaskEvents.actorId, userId), eq(hitlTaskEvents.kind, "viewed")),
      )
      .get();
    return row !== undefined;
  }

  /**
   * Lists a task's history, oldest first.
   *
   * @param taskId - The task ID
   * @returns The history entries
   */
  listEvents(taskId: string): TaskEventRecord[] {
    return this.#db
      .select()
      .from(hitlTaskEvents)
      .where(eq(hitlTaskEvents.taskId, taskId))
      .orderBy(asc(hitlTaskEvents.id))
      .all()
      .map((row) => ({
        taskId: row.taskId,
        at: row.at,
        actorId: row.actorId,
        kind: row.kind as HumanTaskEventKind,
        data: parseJson<Record<string, unknown>>(row.data),
      }));
  }

  /** SQL condition: task assigned to the viewer directly or via a role. */
  #assignedCondition(viewer: TaskVisibility): SQL {
    const matchesAssignee = viewer.roleNames.length
      ? or(
          and(eq(hitlTaskAssignees.kind, "user"), eq(hitlTaskAssignees.value, viewer.userId)),
          and(eq(hitlTaskAssignees.kind, "role"), inArray(hitlTaskAssignees.value, viewer.roleNames)),
        )
      : and(eq(hitlTaskAssignees.kind, "user"), eq(hitlTaskAssignees.value, viewer.userId));
    return inArray(
      hitlTasks.id,
      this.#db.select({ taskId: hitlTaskAssignees.taskId }).from(hitlTaskAssignees).where(matchesAssignee),
    );
  }

  /** SQL condition: task assigned to the viewer or completed by them. */
  #visibleCondition(viewer: TaskVisibility): SQL {
    return or(this.#assignedCondition(viewer), eq(hitlTasks.completedBy, viewer.userId))!;
  }

  /** Inserts assignee rows (deduplicated). */
  #insertAssignees(
    tx: Pick<BunSQLiteDatabase<Record<string, unknown>>, "insert">,
    taskId: string,
    assignees: TaskAssignees,
  ): void {
    const rows = [
      ...[...new Set(assignees.users)].map((value) => ({ taskId, kind: "user", value })),
      ...[...new Set(assignees.roles)].map((value) => ({ taskId, kind: "role", value })),
    ];
    if (rows.length > 0) tx.insert(hitlTaskAssignees).values(rows).run();
  }

  /** Loads the assignees of several tasks. */
  #loadAssignees(taskIds: string[]): Map<string, TaskAssignees> {
    const map = new Map<string, TaskAssignees>();
    if (taskIds.length === 0) return map;
    const rows = this.#db.select().from(hitlTaskAssignees).where(inArray(hitlTaskAssignees.taskId, taskIds)).all();
    for (const row of rows) {
      let entry = map.get(row.taskId);
      if (!entry) {
        entry = { users: [], roles: [] };
        map.set(row.taskId, entry);
      }
      (row.kind === "role" ? entry.roles : entry.users).push(row.value);
    }
    return map;
  }

  /** Converts a row to a record. */
  #toRecord(row: TaskRow, assignees: TaskAssignees | undefined): TaskRecord {
    return {
      id: row.id,
      source: {
        kind: row.sourceKind,
        id: row.sourceId,
        ref: parseJson<Record<string, unknown>>(row.sourceRef) ?? {},
      },
      title: row.title,
      body: row.body,
      context: parseJson<Record<string, unknown>>(row.context),
      outcomes: parseJson<HumanTaskOutcome[]>(row.outcomes) ?? [],
      formSchema: parseJson<Record<string, unknown>>(row.formSchema),
      requireComment: row.requireComment,
      priority: row.priority as HumanTaskPriority,
      status: row.status as HumanTaskStatus,
      dueAt: row.dueAt,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
      completedBy: row.completedBy,
      outcome: row.outcome,
      response: parseJson<unknown>(row.response),
      comment: row.comment,
      version: row.version,
      assignees: assignees ?? { users: [], roles: [] },
    };
  }
}

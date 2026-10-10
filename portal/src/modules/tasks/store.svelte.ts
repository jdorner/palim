/**
 * Task inbox state: the open and answered lists, badge counts, and live
 * updates from the portal event stream.
 *
 * @module
 */

import { request } from "$app/api";
import type { HumanTask, HumanTaskCounts, HumanTaskDetail, PortalEvent } from "$shared/portal";

/** An inbox tab. */
export type InboxTab = "open" | "done";

/** One list of the inbox. */
interface TaskList {
  tasks: HumanTask[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

/** Creates an empty list. */
function emptyList(): TaskList {
  return { tasks: [], nextCursor: null, loaded: false, loading: false, error: null };
}

/** List query per tab. */
const TAB_QUERY: Record<InboxTab, string> = {
  open: "scope=mine&status=open",
  done: "scope=completed",
};

/** Reactive task store. */
class TaskStore {
  /** Badge counts. */
  counts = $state<HumanTaskCounts>({ open: 0, dueSoon: 0 });
  /** Lists by tab. */
  lists = $state<Record<InboxTab, TaskList>>({ open: emptyList(), done: emptyList() });
  /** Bumped when a task changes, so an open detail page can reload. */
  changed = $state<{ id: string; at: number } | null>(null);

  /**
   * Loads the first page of a tab, or the next page.
   *
   * @param tab - The tab
   * @param more - Append the next page instead of reloading
   */
  async load(tab: InboxTab, more = false): Promise<void> {
    const list = this.lists[tab];
    if (list.loading || (more && !list.nextCursor)) return;
    list.loading = true;
    list.error = null;
    try {
      const cursor = more && list.nextCursor ? `&cursor=${encodeURIComponent(list.nextCursor)}` : "";
      const page = await request<{ tasks: HumanTask[]; nextCursor: string | null }>(
        `/api/portal/tasks?${TAB_QUERY[tab]}&limit=30${cursor}`,
      );
      list.tasks = more ? [...list.tasks, ...page.tasks] : page.tasks;
      list.nextCursor = page.nextCursor;
      list.loaded = true;
    } catch (err) {
      list.error = err instanceof Error ? err.message : String(err);
    } finally {
      list.loading = false;
    }
  }

  /** Reloads the badge counts. */
  async refreshCounts(): Promise<void> {
    try {
      this.counts = await request<HumanTaskCounts>("/api/portal/tasks/counts");
    } catch {
      // Counts arrive with the next event as well.
    }
  }

  /**
   * Loads a task with its history.
   *
   * @param id - Task ID
   * @returns The task detail
   */
  fetchTask(id: string): Promise<HumanTaskDetail> {
    return request<{ task: HumanTaskDetail }>(`/api/portal/tasks/${encodeURIComponent(id)}`).then((r) => r.task);
  }

  /**
   * Answers a task and applies the result to the lists.
   *
   * @param task - The task as shown (its version is sent along)
   * @param answer - Outcome, form data, comment
   * @returns The updated task
   */
  async complete(
    task: HumanTask,
    answer: { outcome: string; data?: unknown; comment?: string | null },
  ): Promise<HumanTask> {
    const result = await request<{ task: HumanTask }>(`/api/portal/tasks/${encodeURIComponent(task.id)}/complete`, {
      method: "POST",
      body: { ...answer, version: task.version },
    });
    this.#upsert(result.task);
    return result.task;
  }

  /**
   * Applies a live event.
   *
   * @param event - The portal event
   */
  handleEvent(event: PortalEvent): void {
    this.counts = event.counts;
    switch (event.type) {
      case "ready":
        // (Re)connected: lists may have missed changes while disconnected.
        for (const tab of ["open", "done"] as const) if (this.lists[tab].loaded) void this.load(tab);
        break;
      case "task_created":
      case "task_updated":
        this.#upsert(event.task);
        this.changed = { id: event.task.id, at: Date.now() };
        break;
      case "task_removed":
        for (const tab of ["open", "done"] as const) {
          this.lists[tab].tasks = this.lists[tab].tasks.filter((t) => t.id !== event.taskId);
        }
        this.changed = { id: event.taskId, at: Date.now() };
        break;
    }
  }

  /** Clears everything (sign-out). */
  reset(): void {
    this.counts = { open: 0, dueSoon: 0 };
    this.lists = { open: emptyList(), done: emptyList() };
    this.changed = null;
  }

  /** Places a task in the lists it belongs to now. */
  #upsert(task: HumanTask): void {
    const open = this.lists.open;
    open.tasks = open.tasks.filter((t) => t.id !== task.id);
    if (task.status === "open" && task.canRespond) open.tasks = [task, ...open.tasks].sort(byNewest);

    const done = this.lists.done;
    const inDone = done.tasks.some((t) => t.id === task.id);
    if (inDone) done.tasks = done.tasks.map((t) => (t.id === task.id ? task : t));
    else if (done.loaded && task.completion) done.tasks = [task, ...done.tasks].sort(byNewest);
  }
}

/** Newest first, as the server sorts. */
function byNewest(a: HumanTask, b: HumanTask): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);
}

/** The task store. */
export const tasks = new TaskStore();

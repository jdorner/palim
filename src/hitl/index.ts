/**
 * Human-in-the-loop (HITL) module.
 *
 * Human tasks are work items that background processes (v1: workflow
 * `humanTask` steps) create for people to answer through the portal. Provides
 * the SQLite-backed {@link TaskStore} and the {@link createHitlService}
 * service (visibility, lifecycle, source callbacks, change notifications).
 *
 * @module
 */

export { createUserDirectory } from "./directory";
export {
  type CompleteTaskInput,
  type CreateTaskInput,
  CreateTaskInputSchema,
  createHitlService,
  type HitlChange,
  type HitlDirectory,
  HitlError,
  type HitlService,
  type HitlServiceDeps,
  type HitlSourceHandler,
  type HitlViewer,
  type ListTasksOptions,
  type TaskPage,
} from "./hitlService";
export {
  type NewTask,
  type TaskAssignees,
  type TaskEventRecord,
  type TaskRecord,
  type TaskSource,
  TaskStore,
  type TaskVisibility,
} from "./taskStore";
export type { HitlApi } from "./types";

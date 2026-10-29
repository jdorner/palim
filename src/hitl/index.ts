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
  type CreateTaskInput,
  createHitlService,
  type HitlChange,
  type HitlDirectory,
  HitlError,
  type HitlService,
  type HitlViewer,
} from "./hitlService";
export { TaskStore } from "./taskStore";

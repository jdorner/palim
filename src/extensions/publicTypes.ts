/**
 * Public type surface for the extension API.
 *
 * This module is the single place where `@ext/types` reaches for the core and
 * shared types it exposes to extension authors. It re-exports those types via
 * RELATIVE paths into self-contained terminal type modules, deliberately
 * avoiding the `@src/*` and `@shared/*` path aliases.
 *
 * Why: `@ext/types` maps to the real `src/extensions/types.ts`. When an
 * external extension is type-checked, TypeScript follows that import into the
 * core tree and must resolve every transitive import. If those imports used
 * `@src/*`/`@shared/*`, the extension's own tsconfig would need to map those
 * aliases too - leaking core internals into every extension and, when the
 * aliases are absent, silently degrading exposed types (e.g. `StepIconName`)
 * to `any`, which breaks editor autocomplete.
 *
 * Relative imports resolve against the real filesystem regardless of the
 * consumer's tsconfig, so routing the public type surface through this barrel
 * keeps `@ext/types` self-contained: extensions need only the `@ext/*` aliases.
 *
 * INVARIANT: every module referenced here MUST be free of `@src`/`@shared`
 * imports (transitively, for the types actually used), so the relative chain
 * always resolves without aliases. The push and skill-entry types were
 * extracted into dedicated self-contained modules for exactly this reason.
 *
 * @module
 */

// Shared (backend + frontend) types.
export type { StepIconName, StepTypeInfo } from "../../shared/extensions";
export type { ModelIntent } from "../../shared/models";
export type { WebSocketMessage } from "../../shared/websocket";
// Push message value types (extracted from the value-heavy push service).
export type { PushMessageOptions, PushMessageResult } from "../push/types";
// Core queue contract.
export type {
  JobInfo,
  JobProcessor,
  ManagedQueueOptions,
  ManagedQueuePort,
  QueueJob,
  QueueJobLogs,
  SchedulerInfo,
} from "../queue/types";
// Secrets ACL options.
export type { SetSecretOptions } from "../secrets/types";
// Session store contract.
export type { SessionStorePort } from "../session/types";
// Skill entry (extracted from the value-heavy sandbox module).
export type { SkillEntry } from "../tools/skillEntry";

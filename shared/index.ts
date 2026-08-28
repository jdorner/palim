/**
 * Shared types used by both backend and frontend.
 *
 * Re-exports all domain-specific type modules for convenient single-import access.
 *
 * @module
 */

export type { ChatWebSocketEvent, TokenUsage } from "./chat";
export type {
  ExtensionInfo,
  ExtensionLifecycleEvent,
  ExtensionUiContribution,
  NavigationEntry,
  SecretSchemaEntry,
  StepIconName,
  StepTypeInfo,
} from "./extensions";
export { STEP_ICON_NAMES } from "./extensions";
export type { JobEntry, LogEntry } from "./jobs";
export type { AvailableModel, ModelIntent, SelectedModelResponse } from "./models";
export { MODEL_INTENTS } from "./models";
export type { ScheduleEntry } from "./schedules";
export type { GlobalVariableEntry } from "./variables";
export type { ApprovalRequestEvent, PushMessageEvent, WebSocketMessage } from "./websocket";
export type {
  BuilderConfig,
  BuilderDraft,
  EdgeDraft as BuilderEdgeDraft,
  StepDraft as BuilderStepDraft,
  StepTypeDescriptor,
} from "./workflowBuilder";
export { BUILTIN_STEP_TYPES, getDescriptor, WorkflowBuilder } from "./workflowBuilder";
export type {
  OutputSchema,
  OutputSchemas,
  ResolvedExpression,
  WorkflowStepSummary,
  WorkflowWebSocketEvent,
} from "./workflows";
export { DEFAULT_ENV_ALLOWLIST, walkSchemaPath } from "./workflows";

/**
 * Backward-compatible re-export of all shared types.
 *
 * New code should import from `@shared/types` (backend) or `../../../shared/types` (frontend)
 * as before - this file re-exports everything from the domain-specific modules.
 *
 * @module
 */

export type {
  ApprovalRequestEvent,
  AvailableModel,
  ChatWebSocketEvent,
  ExtensionInfo,
  ExtensionLifecycleEvent,
  ExtensionUiContribution,
  JobEntry,
  LogEntry,
  ModelIntent,
  NavigationEntry,
  PushMessageEvent,
  ScheduleEntry,
  SecretSchemaEntry,
  SelectedModelResponse,
  StepIconName,
  StepTypeInfo,
  TokenUsage,
  WebSocketMessage,
  WorkflowStepSummary,
  WorkflowWebSocketEvent,
} from "./index";
export { STEP_ICON_NAMES } from "./index";

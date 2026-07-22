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
  FeedbackReportEvent,
  JobEntry,
  LogEntry,
  ModelIntent,
  NavigationEntry,
  PushMessageEvent,
  ScheduleEntry,
  SecretSchemaEntry,
  SelectedModelResponse,
  SessionUsage,
  StepTypeInfo,
  TokenUsage,
  WebSocketMessage,
  WorkflowStepSummary,
  WorkflowWebSocketEvent,
} from "./index";

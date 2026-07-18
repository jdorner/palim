/**
 * WebSocket message union and event types shared between backend and frontend.
 *
 * @module
 */

import type { ChatWebSocketEvent } from "./chat";
import type { ExtensionLifecycleEvent } from "./extensions";
import type { JobEntry, LogEntry } from "./jobs";
import type { ScheduleEntry } from "./schedules";
import type { WorkflowWebSocketEvent } from "./workflows";

/** WebSocket event broadcast when a feedback analysis report is ready. */
export interface FeedbackReportEvent {
  type: "feedback_report";
  /** Markdown content of the feedback analysis report. */
  report: string;
  /** The conversation ID that the feedback was submitted from. */
  originalChatId: string;
  /** Flag indicating this should create a feedback conversation. */
  feedbackConversation: true;
}

/** WebSocket event broadcast when an extension requires user approval to install. */
export interface ApprovalRequestEvent {
  type: "approval_request";
  /** Extension name. */
  name: string;
  /** Extension version. */
  version: string;
  /** Human-readable description. */
  description: string;
  /** Bun packages that require approval. */
  packages: string[];
  /** Required system binaries. */
  binRequirements: string[];
  /** One-time token required to approve or reject the installation. */
  approvalToken: string;
}

/** WebSocket event broadcast when a push message is injected into a chat session. */
export interface PushMessageEvent {
  /** Discriminator for the WebSocket message union. */
  type: "push_message";
  /** The chat conversation ID to deliver the message to. */
  chatId: string;
  /** Message body content. */
  content: string;
  /** MIME type governing how the content should be rendered. */
  contentType: "text/markdown" | "text/plain";
}

/** Union of all WebSocket message types the server can broadcast to clients. */
export type WebSocketMessage =
  | { type: "initial_state"; jobs: JobEntry[] }
  | { type: "job_added"; job: JobEntry }
  | { type: "job_updated"; job: JobEntry }
  | { type: "job_removed"; jobId: string }
  | { type: "job_log"; jobId: string; log: LogEntry }
  | { type: "schedules_updated"; schedules: ScheduleEntry[] }
  | { type: "webhooks_reload" }
  | { type: "filewatcher_reload" }
  | ChatWebSocketEvent
  | WorkflowWebSocketEvent
  | FeedbackReportEvent
  | ApprovalRequestEvent
  | ExtensionLifecycleEvent
  | PushMessageEvent;

/**
 * Central workflow WebSocket event store. Processes all workflow-related
 * WebSocket events globally so real-time updates work regardless of which
 * page is mounted (same pattern as chatStreamStore).
 *
 * Pages subscribe to specific events via callbacks or read reactive state.
 */

import type { WebSocketMessage } from "../../../shared/types";

/** A single step within a workflow run. */
export interface RunStep {
  slug: string;
  type: string;
  status: "waiting" | "active" | "completed" | "failed" | "waiting-signal";
  jobId: string;
  /** Signal event name (populated when status is waiting-signal). */
  waitEvent?: string;
  /** JSON Schema for signal payload validation (populated when status is waiting-signal). */
  waitInputSchema?: Record<string, unknown> | null;
}

/** Workflow run detail tracked by the store. */
export interface RunDetail {
  runId: string;
  workflowName: string;
  status: string;
  trigger?: { type: string; ref?: string } | null;
  steps: RunStep[];
  /** Branch choices made by control flow nodes (if/case). Keyed by CF step slug. */
  chosenBranches?: Record<string, string>;
}

/** Callback signature for workflow event subscribers. */
export type WorkflowEventHandler = (message: WorkflowEvent) => void;

/** Subset of WebSocketMessage types relevant to workflows. */
export type WorkflowEvent = Extract<
  WebSocketMessage,
  | { type: "workflow_started" }
  | { type: "workflow_step_started" }
  | { type: "workflow_step_completed" }
  | { type: "workflow_step_failed" }
  | { type: "workflow_step_waiting" }
  | { type: "workflow_step_resumed" }
  | { type: "workflow_completed" }
  | { type: "workflow_failed" }
  | { type: "workflow_reload" }
  | { type: "workflow_deleted" }
>;

/**
 * Reactive workflow store exposed as a Svelte 5 class with `$state` fields.
 * A single module-level instance (`workflowStore`) is exported for global use.
 */
class WorkflowStore {
  // -------------------------------------------------------------------------
  // Run page state (reactive, for WorkflowRunPage)
  // -------------------------------------------------------------------------

  /** The currently tracked run (set by the page when it mounts). */
  run = $state<RunDetail | null>(null);
  /** The run ID being observed (set by the page). */
  activeRunId = $state<string | null>(null);
  /**
   * Tracks which branch was chosen for each control flow step (if/case).
   * Keyed by step slug, value is the branch label (e.g. "then", "else", path key).
   */
  chosenBranches = $state<Record<string, string>>({});

  // -------------------------------------------------------------------------
  // Event subscribers (for WorkflowsPage, WorkflowDetailPage, etc.)
  // -------------------------------------------------------------------------

  private subscribers = new Set<WorkflowEventHandler>();

  /**
   * Subscribe to workflow events. Returns an unsubscribe function.
   * @param handler - Callback invoked for each workflow WebSocket event.
   * @returns Unsubscribe function.
   */
  subscribe(handler: WorkflowEventHandler): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  // -------------------------------------------------------------------------
  // Run page methods
  // -------------------------------------------------------------------------

  /**
   * Sets the active run to observe. Called by WorkflowRunPage after fetching run data.
   * @param runId - The run ID to track events for.
   * @param detail - The initial run detail from the API.
   */
  track(runId: string, detail: RunDetail): void {
    this.activeRunId = runId;
    this.run = detail;
    this.chosenBranches = detail.chosenBranches ?? {};
  }

  /** Clears the tracked run (called when the page unmounts). */
  untrack(): void {
    this.activeRunId = null;
    this.run = null;
    this.chosenBranches = {};
  }

  // -------------------------------------------------------------------------
  // Central event handler (called from App.svelte)
  // -------------------------------------------------------------------------

  /**
   * Processes an incoming workflow WebSocket event. Called by the global WS
   * handler in App.svelte for all workflow_* message types.
   * @param message - The WebSocket message.
   */
  handleEvent(message: WebSocketMessage): void {
    // Update reactive run state for WorkflowRunPage
    if (this.run && this.activeRunId) {
      this.updateRunState(message);
    }

    // Notify subscribers (WorkflowsPage, WorkflowDetailPage)
    for (const handler of this.subscribers) {
      try {
        handler(message as WorkflowEvent);
      } catch {
        /* ignore subscriber errors */
      }
    }
  }

  /**
   * Updates the reactive run state based on the incoming event.
   * @param message - The WebSocket message.
   */
  private updateRunState(message: WebSocketMessage): void {
    if (!this.run) return;

    switch (message.type) {
      case "workflow_step_started":
        if (message.workflowRunId === this.activeRunId) {
          const existsStarted = this.run.steps.some((s) => s.slug === message.stepSlug);
          this.run = {
            ...this.run,
            status: "running",
            steps: existsStarted
              ? this.run.steps.map((s) =>
                  s.slug === message.stepSlug ? { ...s, status: "active" as const, jobId: message.jobId } : s,
                )
              : [
                  ...this.run.steps,
                  {
                    slug: message.stepSlug,
                    type: "",
                    status: "active" as const,
                    jobId: message.jobId,
                  },
                ],
          };
        }
        break;

      case "workflow_step_completed":
        if (message.workflowRunId === this.activeRunId) {
          // Track which branch was chosen for control flow nodes
          if (message.chosenBranch) {
            this.chosenBranches = { ...this.chosenBranches, [message.stepSlug]: message.chosenBranch };
          }
          this.run = {
            ...this.run,
            steps: this.run.steps.map((s) =>
              s.slug === message.stepSlug ? { ...s, status: "completed" as const } : s,
            ),
          };
        }
        break;

      case "workflow_step_waiting":
        if (message.workflowRunId === this.activeRunId) {
          const waitSchema = message.inputSchema ?? null;
          const exists = this.run.steps.some((s) => s.slug === message.stepSlug);
          this.run = {
            ...this.run,
            status: "waiting-signal",
            steps: exists
              ? this.run.steps.map((s) =>
                  s.slug === message.stepSlug
                    ? { ...s, status: "waiting-signal" as const, waitEvent: message.event, waitInputSchema: waitSchema }
                    : s,
                )
              : [
                  ...this.run.steps,
                  {
                    slug: message.stepSlug,
                    type: "waitFor",
                    status: "waiting-signal" as const,
                    jobId: "",
                    waitEvent: message.event,
                    waitInputSchema: waitSchema,
                  },
                ],
          };
        }
        break;

      case "workflow_step_resumed":
        if (message.workflowRunId === this.activeRunId) {
          // Signal was received — the waitFor step is now complete
          this.run = {
            ...this.run,
            status: "running",
            steps: this.run.steps.map((s) =>
              s.slug === message.stepSlug ? { ...s, status: "completed" as const } : s,
            ),
          };
        }
        break;

      case "workflow_step_failed":
        if (message.workflowRunId === this.activeRunId) {
          this.run = {
            ...this.run,
            steps: this.run.steps.map((s) => (s.slug === message.stepSlug ? { ...s, status: "failed" as const } : s)),
            status: "failed",
          };
        }
        break;

      case "workflow_completed":
        if (message.workflowRunId === this.activeRunId) {
          this.run = { ...this.run, status: "completed" };
        }
        break;

      case "workflow_failed":
        if (message.workflowRunId === this.activeRunId) {
          this.run = { ...this.run, status: "failed" };
        }
        break;
    }
  }
}

/** Singleton workflow store instance. */
export const workflowStore = new WorkflowStore();

/**
 * Launcher state: the workflows the user may start, and starting one.
 *
 * @module
 */

import { request, upload } from "$app/api";
import type { PortalWorkflow, PortalWorkflowStartResult } from "$shared/portal";

/** Reactive launcher store. */
class LauncherStore {
  /** The launchers, sorted by title. */
  items = $state<PortalWorkflow[]>([]);
  /** Whether the list has been loaded once. */
  loaded = $state(false);
  /** Whether a load is in flight. */
  loading = $state(false);
  /** Load error message. */
  error = $state<string | null>(null);

  /** Loads (or reloads) the launcher list. */
  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = null;
    try {
      this.items = await request<PortalWorkflow[]>("/api/portal/workflows");
      this.loaded = true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Starts a workflow.
   *
   * @param name - Workflow name
   * @param file - The file to upload, if any
   * @param data - Form field values
   * @returns The started run
   * @throws {ApiError} when the server refuses the start
   */
  start(name: string, file: File | null, data: Record<string, unknown>): Promise<PortalWorkflowStartResult> {
    const form = new FormData();
    if (file) form.append("file", file, file.name);
    form.append("data", JSON.stringify(data));
    return upload<PortalWorkflowStartResult>(`/api/portal/workflows/${encodeURIComponent(name)}/start`, form);
  }

  /** Clears all state (on sign-out). */
  reset(): void {
    this.items = [];
    this.loaded = false;
    this.error = null;
  }
}

/** The launcher store. */
export const launchers = new LauncherStore();

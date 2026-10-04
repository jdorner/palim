import { type Writable, writable } from "svelte/store";
import type { JobEntry, ScheduleEntry } from "../../../shared/types";
import { authFetch, getToken } from "./auth";

/** Whether the WebSocket is connected. */
export const connected = writable(false);

/** Whether the WebSocket has ever successfully connected since page load. */
export const hasConnected = writable(false);

/** All known jobs. */
export const jobs = writable<JobEntry[]>([]);

/** All known schedules. */
export const schedules = writable<ScheduleEntry[]>([]);

/** Whether a queue clean operation is in progress. */
export const cleaning = writable(false);

/** Number of configured webhooks. */
export const webhookCount = writable(0);

/** Number of loaded workflow definitions. */
export const workflowCount = writable(0);

/** Number of configured file watchers. */
export const fileWatcherCount = writable(0);

/** Number of configured MCP servers (enabled + disabled). */
export const mcpServerCount = writable(0);

/**
 * Builds the WebSocket URL and returns connection options.
 * The auth token is passed via the Sec-WebSocket-Protocol header
 * (subprotocol) to avoid exposing it in the URL.
 */
export function buildWsConnection(): { url: string; protocols?: string[] } {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws`;
  const token = getToken();
  return token ? { url, protocols: [`auth-${token}`] } : { url };
}

/**
 * Fetches a list endpoint and stores a derived count. Errors are ignored
 * because sidebar badges are non-critical.
 * @param url - API endpoint to fetch
 * @param store - Count store to update
 * @param pick - Extracts the count from the response body (defaults to array length)
 */
async function fetchCount(url: string, store: Writable<number>, pick: (data: any) => number = (d) => d.length) {
  try {
    const res = await authFetch(url);
    if (res.ok) store.set(pick(await res.json()));
  } catch {
    // Silently ignore - sidebar badge is non-critical
  }
}

/** Fetches the webhook count from the API. */
export const fetchWebhookCount = () => fetchCount("/ext/webhooks", webhookCount);

/** Fetches the workflow count from the API. */
export const fetchWorkflowCount = () => fetchCount("/ext/workflows", workflowCount);

/** Fetches the file watcher count from the API. */
export const fetchFileWatcherCount = () => fetchCount("/ext/filewatcher", fileWatcherCount);

/** Fetches the MCP server count from the API. */
export const fetchMcpServerCount = () => fetchCount("/ext/mcp/servers", mcpServerCount, (d) => d.servers.length);

/** Fetches the schedule list from the scheduler extension API. */
export async function fetchScheduleCount() {
  try {
    const res = await authFetch("/ext/scheduler/schedules");
    if (res.ok) {
      schedules.set(await res.json());
    }
  } catch {
    // Silently ignore - sidebar badge is non-critical
  }
}

/** Cancels a job by ID via the REST API. */
export async function cancelJob(jobId: string) {
  try {
    const res = await authFetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
    if (!res.ok) {
      console.error("Cancel failed:", await res.text());
    }
  } catch (err) {
    console.error("Failed to cancel job:", err);
  }
}

/** Cleans completed or failed jobs from the queue. */
export async function cleanQueue(type: string) {
  cleaning.set(true);
  try {
    const res = await authFetch("/api/queues/clean", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grace: 0, limit: 1000, type }),
    });
    if (!res.ok) {
      console.error("Cleanup failed:", await res.text());
    }
  } catch (err) {
    console.error("Failed to clean queue:", err);
  } finally {
    cleaning.set(false);
  }
}

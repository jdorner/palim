/**
 * Server-sent event stream for the portal (`GET /api/portal/events`).
 *
 * Portal accounts cannot use the operator WebSocket, so the portal gets its
 * own per-user event stream. The hub subscribes to HITL task changes and
 * forwards each change only to clients that may see the task, as the task
 * looks to that viewer (see {@link PortalEvent}). A client that could see the
 * previous state but no longer sees the new one gets `task_removed`; clients
 * that never saw the task get nothing, so task IDs do not leak.
 *
 * Every send re-resolves the client's token, so logout, disabling, or a role
 * change takes effect on the next event; a heartbeat comment every 25 seconds
 * keeps proxies from closing idle streams and revalidates too.
 *
 * @module
 */

import { PERMISSIONS } from "@shared/auth";
import type { PortalEvent } from "@shared/portal";
import type { AuthResolver, ResolvedPrincipal } from "@src/auth";
import type { HitlChange, HitlService, HitlViewer } from "@src/hitl";
import { mainLogger as log } from "@src/utils/logger";

/** Heartbeat interval for idle streams. */
const HEARTBEAT_MS = 25_000;

/**
 * Describes a principal as a HITL viewer.
 *
 * @param principal - The authenticated principal
 * @returns The viewer (user, role names, manage flag)
 */
export function hitlViewerFor(principal: ResolvedPrincipal): HitlViewer {
  return {
    userId: principal.user.id,
    roleNames: principal.user.roles,
    canManage: principal.isAdmin || principal.permissions.includes(PERMISSIONS.HITL_MANAGE),
  };
}

/**
 * Whether a principal may use the human task API at all (`hitl:respond`,
 * `hitl:manage`, or admin).
 *
 * @param principal - The authenticated principal
 * @returns True when the principal may see and answer tasks
 */
export function canUseHitl(principal: ResolvedPrincipal): boolean {
  return principal.ability.can("update", "HumanTask");
}

/** A connected stream. */
interface Client {
  token: string;
  principal: ResolvedPrincipal;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

const encoder = new TextEncoder();

/**
 * Fans HITL task changes out to connected portal clients.
 */
export class PortalEventHub {
  readonly #clients = new Set<Client>();
  readonly #service: HitlService;
  readonly #resolver: AuthResolver;
  #unsubscribe: (() => void) | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  /**
   * @param service - The HITL service to subscribe to
   * @param resolver - Resolves client tokens on every send
   */
  constructor(service: HitlService, resolver: AuthResolver) {
    this.#service = service;
    this.#resolver = resolver;
  }

  /** Number of connected clients (for tests and diagnostics). */
  get size(): number {
    return this.#clients.size;
  }

  /**
   * Opens a stream for an authenticated principal.
   *
   * @param token - The bearer token (re-resolved before every send)
   * @param principal - The principal resolved for the request
   * @returns The `text/event-stream` response
   */
  connect(token: string, principal: ResolvedPrincipal): Response {
    let client: Client | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = { token, principal, controller };
        this.#clients.add(client);
        this.#ensureRunning();
        const viewer = hitlViewerFor(principal);
        this.#write(client, { type: "ready", counts: this.#service.countTasks(viewer) });
      },
      cancel: () => {
        if (client) this.#remove(client);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Disable response buffering in nginx so events arrive immediately.
        "X-Accel-Buffering": "no",
      },
    });
  }

  /** Closes every stream and stops listening (shutdown). */
  close(): void {
    for (const client of [...this.#clients]) this.#remove(client, true);
  }

  /** Subscribes and starts the heartbeat while clients are connected. */
  #ensureRunning(): void {
    if (!this.#unsubscribe) this.#unsubscribe = this.#service.subscribe((change) => this.#onChange(change));
    if (!this.#heartbeat) {
      this.#heartbeat = setInterval(() => this.#beat(), HEARTBEAT_MS);
      this.#heartbeat.unref?.();
    }
  }

  /** Removes a client; stops listening when none are left. */
  #remove(client: Client, closeStream = false): void {
    this.#clients.delete(client);
    if (closeStream) {
      try {
        client.controller.close();
      } catch {
        // Already closed or cancelled.
      }
    }
    if (this.#clients.size === 0) {
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      if (this.#heartbeat) clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }

  /**
   * Re-resolves a client's principal. Drops the client when the token is no
   * longer valid or the account lost access to human tasks.
   *
   * @returns The current principal, or null when the client was dropped
   */
  #revalidate(client: Client): ResolvedPrincipal | null {
    let principal: ResolvedPrincipal | null;
    try {
      principal = this.#resolver.resolveToken(client.token);
    } catch (err) {
      // Keep the stream on transient resolver failures.
      log.error("Failed to revalidate portal event client:", err);
      return client.principal;
    }
    if (!principal || !canUseHitl(principal)) {
      this.#remove(client, true);
      return null;
    }
    client.principal = principal;
    return principal;
  }

  /** Sends the matching event for a task change to every client. */
  #onChange(change: HitlChange): void {
    for (const client of [...this.#clients]) {
      const principal = this.#revalidate(client);
      if (!principal) continue;
      const viewer = hitlViewerFor(principal);
      const view = this.#service.viewFor(change.task, viewer);
      const sawBefore = change.previous ? this.#service.viewFor(change.previous, viewer) !== null : false;
      if (!view && !sawBefore) continue;

      const counts = this.#service.countTasks(viewer);
      if (!view) {
        this.#write(client, { type: "task_removed", taskId: change.task.id, counts });
      } else if (change.type === "created" || !sawBefore) {
        this.#write(client, { type: "task_created", task: view, counts });
      } else {
        this.#write(client, { type: "task_updated", task: view, counts });
      }
    }
  }

  /** Heartbeat: revalidates every client and sends an SSE comment. */
  #beat(): void {
    for (const client of [...this.#clients]) {
      if (this.#revalidate(client)) this.#enqueue(client, ": ping\n\n");
    }
  }

  /** Writes one event. */
  #write(client: Client, event: PortalEvent): void {
    this.#enqueue(client, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  /** Enqueues raw SSE text; drops the client when its stream is gone. */
  #enqueue(client: Client, text: string): void {
    try {
      client.controller.enqueue(encoder.encode(text));
    } catch {
      this.#remove(client);
    }
  }
}

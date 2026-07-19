/**
 * Web server factory - creates the Elysia app, wires auth middleware,
 * WebSocket, and composes route modules from `./routes/`.
 */

import { cors } from "@elysia/cors";
import { staticPlugin } from "@elysiajs/static";
import type { ExtensionRegistry } from "@src/extensions";
import type { AgentJob, ChatJob } from "@src/jobs";
import { createPushService } from "@src/push";
import type { ManagedQueuePort } from "@src/queue";
import type { SecretVault } from "@src/secrets/vault";
import { mainLogger as log } from "@src/utils/logger";
import { type AnyElysia, Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { authEnabled, extractBearerToken, validateToken } from "./auth";
import { compression } from "./compression";
import { QueueMonitor } from "./monitor";
import { authRoutes } from "./routes/auth";
import { chatRoutes } from "./routes/chat";
import { extensionRoutes } from "./routes/extensions";
import { globalSecretRoutes } from "./routes/globalSecrets";
import { jobRoutes } from "./routes/jobs";
import { modelRoutes } from "./routes/models";
import { pushRoutes } from "./routes/push";
import { secretRoutes } from "./routes/secrets";
import { sessionRoutes } from "./routes/sessions";

/** WebSocket auth protocol prefix. */
const WS_AUTH_PREFIX = "auth-";

/** Dependencies injected into the web server factory. */
interface WebServerDeps {
  /** The managed agent queue for general agent prompt jobs. */
  agentQueue: ManagedQueuePort<AgentJob>;
  /** The managed chat queue for conversational interactions. */
  chatQueue: ManagedQueuePort<ChatJob>;
  /** Getter for the extension registry (available after extensions are initialized). */
  getRegistry: () => ExtensionRegistry | undefined;
  /** Optional SecretVault instance (undefined when no master key is configured). */
  secretVault?: SecretVault;
}

/** Options for starting the web server. */
interface WebServerListenOptions {
  /** Hostname to bind to (e.g. "localhost", "0.0.0.0"). */
  hostname?: string;
  /** Port number to listen on. */
  port?: number;
}

/**
 * Extracts an auth token from the WebSocket `Sec-WebSocket-Protocol` header.
 *
 * Clients send the token as a sub-protocol in the format `auth-<token>`.
 *
 * @param protocolHeader - Raw `Sec-WebSocket-Protocol` header value
 * @returns The extracted token, or empty string if none found
 */
function extractWsToken(protocolHeader: string | null): string {
  if (!protocolHeader) return "";
  const authProtocol = protocolHeader
    .split(",")
    .map((p) => p.trim())
    .find((p) => p.startsWith(WS_AUTH_PREFIX));
  return authProtocol?.slice(WS_AUTH_PREFIX.length) ?? "";
}

/**
 * Creates the Elysia web server with WebSocket support but does NOT start listening.
 * Call {@link startWebServer} after all routes (including extension routes) are registered.
 *
 * @param deps - The managed queues and registry getter to wire into the server
 * @param deps.agentQueue - Queue for general agent prompt jobs
 * @param deps.chatQueue - Queue for conversational chat jobs
 * @param deps.getRegistry - Getter for the extension registry
 * @returns Object containing the Elysia app instance and QueueMonitor
 */
export async function createWebServer(deps: WebServerDeps) {
  const { agentQueue, chatQueue, getRegistry } = deps;

  // Feed managed queues to the monitor for event-based tracking
  const monitor = new QueueMonitor([agentQueue, chatQueue]);

  // Create the push service with broadcast wired to the monitor
  const pushService = createPushService({ broadcastFn: (msg) => monitor.broadcast(msg) });
  const app = new Elysia()
    .get("/health", () => "OK")
    .use(compression())
    .use(
      await staticPlugin({
        assets: "./frontend/dist",
        prefix: "/",
      }),
    )
    .use(cors({ origin: true }))
    .use(
      rateLimit({
        max: process.env.NODE_ENV === "development" ? Number.MAX_SAFE_INTEGER : 60,
        duration: 60_000,
        skip: (request) => {
          const path = new URL(request.url).pathname;
          return !path.startsWith("/api/") && !path.startsWith("/ext/") && !path.startsWith("/ws");
        },
      }),
    )
    .onBeforeHandle(authCheck)
    .onBeforeHandle(checkIfExtensionIsUnloaded(getRegistry))
    // --- Route modules ---
    .use(authRoutes())
    .use(jobRoutes(monitor))
    .use(extensionRoutes(getRegistry))
    .use(modelRoutes(getRegistry))
    .use(chatRoutes(chatQueue))
    .use(sessionRoutes())
    .use(pushRoutes(pushService.pushMessage))
    .use(secretRoutes(getRegistry, () => deps.secretVault))
    .use(globalSecretRoutes(() => deps.secretVault))
    // --- WebSocket ---
    .ws("/ws", {
      async open(ws) {
        if (authEnabled) {
          const token = extractWsToken(ws.data.request.headers.get("sec-websocket-protocol"));
          if (!validateToken(token)) {
            ws.close(4001, "Unauthorized");
            return;
          }
        }
        monitor.addClient(ws);
      },
      close(ws) {
        monitor.removeClient(ws);
      },
    });

  return { app, monitor, pushMessage: pushService.pushMessage };
}

/**
 * Starts the Elysia server listening on the given host and port.
 * Call this after all routes (including extension routes) have been registered.
 *
 * @param app - The Elysia app instance from {@link createWebServer}
 * @param opts - Server listen options (hostname, port)
 */
export function startWebServer(app: AnyElysia, opts: WebServerListenOptions) {
  app.listen(opts);
  log.info(`Web UI available at ${app.server?.url}`);
}

/**
 * HTTP request middleware to check for a valid auth token on protected routes.
 *
 * @param params - Elysia handler parameters including the request and status
 * @returns 401 Unauthorized response if token is missing or invalid
 */
function authCheck(params: { request: Request; status: any }) {
  if (!authEnabled) return;

  const url = new URL(params.request.url);
  const path = url.pathname;

  // Skip auth for static files, the validate endpoint, and webhook receive routes
  if (!path.startsWith("/api/") && !path.startsWith("/ext/")) return;
  if (path === "/api/auth/validate") return;
  if (path.startsWith("/ext/webhooks/receive/")) return;

  const token = extractBearerToken(params.request.headers.get("authorization"));
  if (!validateToken(token)) {
    return params.status(401, { error: "Unauthorized" });
  }
}

// Route guard for unloaded/disabled extensions
function checkIfExtensionIsUnloaded(getRegistry: () => ExtensionRegistry | undefined) {
  return (params: { request: Request; status: any }) => {
    const url = new URL(params.request.url);
    if (!url.pathname.startsWith("/ext/")) return;

    const registry = getRegistry();
    if (!registry) return;

    for (const prefix of registry.getDisabledRoutePrefixes()) {
      if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
        return params.status(404, { error: "Extension not available" });
      }
    }
  };
}

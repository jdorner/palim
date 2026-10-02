/**
 * Web server factory - creates the Elysia app, wires auth middleware,
 * WebSocket, and composes route modules from `./routes/`.
 */

import { cors } from "@elysia/cors";
import { staticPlugin } from "@elysiajs/static";
import type { AuthService, UserStore } from "@src/auth";
import type { ExtensionRegistry } from "@src/extensions";
import type { AgentJob, ChatJob } from "@src/jobs";
import { createPushService } from "@src/push";
import type { ManagedQueuePort } from "@src/queue";
import type { SecretVault } from "@src/secrets/vault";
import { getSessionStore } from "@src/session";
import { mainLogger as log } from "@src/utils/logger";
import type { VariableStore } from "@src/variables/store";
import { type AnyElysia, Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { extractBearerToken, extractWsToken, setPrincipal } from "./auth";
import { authorizeRequest } from "./authorize";
import { compression } from "./compression";
import { QueueMonitor } from "./monitor";
import { authRoutes } from "./routes/auth";
import { chatRoutes } from "./routes/chat";
import { extensionRoutes } from "./routes/extensions";
import { globalSecretRoutes } from "./routes/globalSecrets";
import { globalVariableRoutes } from "./routes/globalVariables";
import { jobRoutes } from "./routes/jobs";
import { modelRoutes } from "./routes/models";
import { pushRoutes } from "./routes/push";
import { secretRoutes } from "./routes/secrets";
import { sessionRoutes } from "./routes/sessions";
import { userRoutes } from "./routes/users";

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
  /** VariableStore instance for plaintext global variables (always available). */
  variableStore?: VariableStore;
  /** Authentication service resolving bearer tokens to principals and issuing logins. */
  authService?: AuthService;
  /** User store for account/role lookups (used by admin routes). */
  userStore?: UserStore;
}

/** Options for starting the web server. */
interface WebServerListenOptions {
  /** Hostname to bind to (e.g. "localhost", "0.0.0.0"). */
  hostname?: string;
  /** Port number to listen on. */
  port?: number;
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
  const { agentQueue, chatQueue, getRegistry, authService } = deps;

  // Feed managed queues to the monitor for event-based tracking
  const monitor = new QueueMonitor([agentQueue, chatQueue]);
  // Lets the monitor drop or re-scope open sockets when their credentials change.
  if (authService) monitor.setAuthResolver(authService);
  const revalidateSockets = () => monitor.revalidateClients();

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
    .onBeforeHandle((ctx) => authCheck(ctx, authService))
    .onBeforeHandle(checkIfExtensionIsUnloaded(getRegistry))
    // --- Route modules ---
    .use(authRoutes(() => authService, revalidateSockets))
    .use(jobRoutes(monitor))
    .use(extensionRoutes(getRegistry))
    .use(modelRoutes(getRegistry))
    .use(chatRoutes(chatQueue, (chatId, userId) => monitor.registerChatOwner(chatId, userId)))
    .use(sessionRoutes())
    .use(pushRoutes(pushService.pushMessage))
    .use(secretRoutes(getRegistry, () => deps.secretVault))
    .use(globalSecretRoutes(() => deps.secretVault))
    .use(globalVariableRoutes(() => deps.variableStore))
    .use(
      userRoutes(
        () => deps.userStore,
        () => authService,
        revalidateSockets,
        (userId) => getSessionStore().deleteByUser(userId),
      ),
    )
    // --- WebSocket ---
    .ws("/ws", {
      async open(ws) {
        // Resolve the per-user identity from the auth subprotocol. When no auth
        // service is wired (should not happen in production), reject to fail closed.
        const token = extractWsToken(ws.data.request.headers.get("sec-websocket-protocol"));
        const principal = authService?.resolveToken(token) ?? null;
        if (!principal) {
          ws.close(4001, "Unauthorized");
          return;
        }
        // Keep the token so the monitor can revalidate this connection later.
        monitor.addClient(ws, principal, token);
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
 * HTTP request middleware: authenticates the bearer token to a per-user
 * principal, attaches it to the request, and enforces coarse route
 * authorization via the central rule table.
 *
 * Public paths (static assets, `/api/auth/login`, webhook receive routes) are
 * exempt. Protected paths require a resolvable token (else 401) and must pass
 * the authorization rules for the method+path (else 403). Fine-grained
 * ownership checks live in the individual route handlers.
 *
 * @param params - Elysia handler parameters (request + status helper).
 * @param authService - The resolver mapping tokens to principals.
 * @returns A 401/403 response when unauthenticated/unauthorized; otherwise undefined.
 */
export function authCheck(params: { request: Request; status: any }, authService: WebServerDeps["authService"]) {
  const url = new URL(params.request.url);
  const path = url.pathname;

  // Only /api/ and /ext/ paths are protected; everything else (static assets,
  // health) is public.
  if (!path.startsWith("/api/") && !path.startsWith("/ext/")) return;
  // Public auth endpoints (login/validate) and machine-facing webhook ingress.
  if (path === "/api/auth/login" || path === "/api/auth/validate") return;
  if (path.startsWith("/ext/webhooks/receive/")) return;

  // Fail closed if the auth service is missing (misconfiguration).
  if (!authService) {
    return params.status(503, { error: "Auth service unavailable" });
  }

  const token = extractBearerToken(params.request.headers.get("authorization"));
  const principal = authService.resolveToken(token);
  if (!principal) {
    return params.status(401, { error: "Unauthorized" });
  }

  // Attach identity for downstream handlers (ownership checks, admin routes).
  setPrincipal(params.request, principal);

  // Coarse, feature-level authorization from the central rule table.
  const decision = authorizeRequest(params.request.method, path, principal.ability);
  if (!decision.allowed) {
    return params.status(403, { error: "Forbidden" });
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

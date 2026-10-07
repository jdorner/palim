/**
 * Web server factory - creates the Elysia app, wires auth middleware,
 * WebSocket, and composes route modules from `./routes/`.
 */

import { cors } from "@elysia/cors";
import { staticPlugin } from "@elysiajs/static";
import { type AuthService, hashToken, type UserStore } from "@src/auth";
import { EXT_UI_DIR } from "@src/config";
import type { ExtensionRegistry } from "@src/extensions";
import type { AgentJob, ChatJob } from "@src/jobs";
import { createPushService } from "@src/push";
import type { ManagedQueuePort } from "@src/queue";
import type { SecretVault } from "@src/secrets/vault";
import { getSessionStore } from "@src/session";
import { mainLogger as log } from "@src/utils/logger";
import type { VariableStore } from "@src/variables/store";
import { type AnyElysia, type Context, Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { clientAddress, extractBearerToken, extractWsToken, resolveRequestPrincipal, setPrincipal } from "./auth";
import { authorizeRequest } from "./authorize";
import { compression } from "./compression";
import { ExtensionRouter } from "./extensionRouter";
import { serveExtensionUiAsset } from "./extensionUiAssets";
import { LoginThrottle } from "./loginThrottle";
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

/**
 * Requests per minute for each authenticated token. Keyed by token rather than
 * user, so a user's browser session and the internal token their agent jobs run
 * with get separate buckets: a runaway sandbox loop cannot starve the UI.
 */
const AUTHENTICATED_RATE_LIMIT = 1000;

/**
 * Requests per minute per client IP for unauthenticated traffic (login, public
 * extension routes such as webhooks, WebSocket upgrades, rejected tokens).
 * Login additionally has its own failure throttle ({@link LoginThrottle}).
 */
const UNAUTHENTICATED_RATE_LIMIT = 60;

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
 * Call {@link startWebServer} once core setup is done. Extension routes live in the returned
 * {@link ExtensionRouter} and may be added or removed at any time, including after listen.
 *
 * @param deps - The managed queues and registry getter to wire into the server
 * @param deps.agentQueue - Queue for general agent prompt jobs
 * @param deps.chatQueue - Queue for conversational chat jobs
 * @param deps.getRegistry - Getter for the extension registry
 * @returns Object containing the Elysia app instance, QueueMonitor, push function, and extension router
 */
export async function createWebServer(deps: WebServerDeps) {
  const { agentQueue, chatQueue, getRegistry, authService } = deps;

  // Runtime table of extension routes (filled by the route registry). Dispatched
  // through the fixed `/ext/*` mount below so routes can change after listen().
  const extensionRouter = new ExtensionRouter();
  const dispatchExtension = (ctx: Context) => extensionRouter.dispatch(ctx);

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
        duration: 60_000,
        // Authenticated requests are bucketed per token, everything else per IP.
        generator: (request, server) => {
          if (authService && resolveRequestPrincipal(request, authService)) {
            return `tok:${hashToken(extractBearerToken(request.headers.get("authorization")))}`;
          }
          return `ip:${clientAddress(request, server)}`;
        },
        max: (key) => {
          if (process.env.NODE_ENV === "development") return Number.MAX_SAFE_INTEGER;
          return key.startsWith("tok:") ? AUTHENTICATED_RATE_LIMIT : UNAUTHENTICATED_RATE_LIMIT;
        },
        skip: (request) => {
          const path = new URL(request.url).pathname;
          return !path.startsWith("/api/") && !path.startsWith("/ext/") && !path.startsWith("/ws");
        },
      }),
    )
    .onBeforeHandle((ctx) => authCheck(ctx, authService, extensionRouter))
    // --- Route modules ---
    .use(authRoutes(() => authService, revalidateSockets, new LoginThrottle()))
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
    // --- Compiled extension UI bundles (public, content-hashed) ---
    .get("/ext-ui/*", ({ request }) => serveExtensionUiAsset(new URL(request.url).pathname, EXT_UI_DIR))
    // --- Extension routes (dynamic; body parsing is done per route by the router) ---
    .get("/ext/*", dispatchExtension, { parse: "none" })
    .post("/ext/*", dispatchExtension, { parse: "none" })
    .put("/ext/*", dispatchExtension, { parse: "none" })
    .delete("/ext/*", dispatchExtension, { parse: "none" })
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

  return { app, monitor, pushMessage: pushService.pushMessage, extensionRouter };
}

/**
 * Starts the Elysia server listening on the given host and port.
 * Extension routes are dispatched dynamically and need not be registered beforehand.
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
 * Public paths (static assets, `/api/auth/login`, extension routes registered
 * with `{ public: true }` such as webhook receive) are exempt. Protected paths require a resolvable token (else 401) and must pass
 * the authorization rules for the method+path (else 403). Fine-grained
 * ownership checks live in the individual route handlers.
 *
 * @param params - Elysia handler parameters (request + status helper).
 * @param authService - The resolver mapping tokens to principals.
 * @param extensionRouter - Extension route table (identifies routes that opted out of token auth).
 * @returns A 401/403 response when unauthenticated/unauthorized; otherwise undefined.
 */
export function authCheck(
  params: { request: Request; status: any },
  authService: WebServerDeps["authService"],
  extensionRouter?: ExtensionRouter,
) {
  const url = new URL(params.request.url);
  const path = url.pathname;

  // Only /api/ and /ext/ paths are protected; everything else (static assets,
  // health) is public.
  if (!path.startsWith("/api/") && !path.startsWith("/ext/")) return;
  // Public auth endpoint (login).
  if (path === "/api/auth/login") return;
  // Extension routes that authenticate callers themselves (webhook HMAC, OAuth state).
  if (extensionRouter?.isPublic(params.request.method, path)) return;

  // Fail closed if the auth service is missing (misconfiguration).
  if (!authService) {
    return params.status(503, { error: "Auth service unavailable" });
  }

  const principal = resolveRequestPrincipal(params.request, authService);
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

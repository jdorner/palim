import { createRouter } from "sv-router";
import { get, type Readable, toStore } from "svelte/store";
import { getToken } from "$lib/auth";
import { disabledExtensionRoutes } from "$lib/extensionStore";
import { identity } from "$lib/identity.svelte";

export const { navigate, route } = createRouter({
  "/": () => import("./routes/ChatPage.svelte"),
  "/jobs": () => import("./routes/JobsPage.svelte"),
  "/chat": () => import("./routes/ChatPage.svelte"),
  "/chat/:conversationId": () => import("./routes/ChatPage.svelte"),
  "/filewatchers": () => import("./routes/FileWatchersPage.svelte"),
  "/login": () => import("./routes/LoginPage.svelte"),
  "/mcp": () => import("./routes/McpServersPage.svelte"),
  "/schedules": () => import("./routes/SchedulesPage.svelte"),
  "/settings": () => import("./routes/SettingsPage.svelte"),
  "/users": () => import("./routes/UsersPage.svelte"),
  "/webhooks": () => import("./routes/WebhooksPage.svelte"),
  "/workflows": () => import("./routes/WorkflowsPage.svelte"),
  "/workflows/:name": () => import("./routes/WorkflowDetailPage.svelte"),
  "/workflows/:name/runs/:runId": () => import("./routes/WorkflowRunPage.svelte"),
  "/ext-page/:extensionName": () => import("./routes/ExtensionPage.svelte"),
  "/ext-page/:extensionName/:pageId": () => import("./routes/ExtensionPage.svelte"),
  "/ext-page/:extensionName/:pageId/*rest": () => import("./routes/ExtensionPage.svelte"),

  hooks: {
    async beforeLoad(context) {
      if (context.pathname === "/login") return;

      if (!getToken()) {
        throw navigate("/login");
      }

      // Role-gated routes: the admin Users/Roles page requires users:manage.
      // Ensure identity is loaded, then redirect non-admins away.
      if (context.pathname === "/users" || context.pathname.startsWith("/users/")) {
        if (!identity.isAuthenticated) {
          await identity.refresh();
        }
        if (!identity.can("manage", "User")) {
          throw navigate("/");
        }
      }

      // Extension route guard: redirect away from disabled extension routes.
      // Fail-open when the store is empty (extensions not yet loaded).
      const disabledRoutes = get(disabledExtensionRoutes);
      for (const route of disabledRoutes) {
        if (context.pathname === route || context.pathname.startsWith(`${route}/`)) {
          throw navigate("/");
        }
      }
    },
  },
});

/**
 * Derives the current pathname from the URL hash (source of truth for hash-based routing).
 */
function getHashPathname(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash || "/";
}

/**
 * A Svelte store with the current route pathname (including a `?query`), for
 * `$pathname` in components and `subscribe`/`get` in plain TS.
 *
 * Reads the URL hash, so the value is right before the router's first
 * navigation has resolved (sv-router's own state starts at `/`), and uses
 * `route.pathname` only as the change signal.
 */
export const pathname: Readable<string> = toStore(() => {
  void route.pathname;
  return getHashPathname();
});

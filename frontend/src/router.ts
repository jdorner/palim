import { createRouter } from "sv-router";
import { get, readable } from "svelte/store";
import { checkAuthRequired, getToken } from "$lib/auth";
import { disabledExtensionRoutes } from "$lib/extensionStore";

export const { p, navigate, isActive, route } = createRouter({
  "/": () => import("./routes/ChatPage.svelte"),
  "/jobs": () => import("./routes/JobsPage.svelte"),
  "/chat": () => import("./routes/ChatPage.svelte"),
  "/chat/:conversationId": () => import("./routes/ChatPage.svelte"),
  "/filewatchers": () => import("./routes/FileWatchersPage.svelte"),
  "/login": () => import("./routes/LoginPage.svelte"),
  "/mcp": () => import("./routes/McpServersPage.svelte"),
  "/schedules": () => import("./routes/SchedulesPage.svelte"),
  "/settings": () => import("./routes/SettingsPage.svelte"),
  "/webhooks": () => import("./routes/WebhooksPage.svelte"),
  "/workflows": () => import("./routes/WorkflowsPage.svelte"),
  "/workflows/:name": () => import("./routes/WorkflowDetailPage.svelte"),
  "/workflows/:name/runs/:runId": () => import("./routes/WorkflowRunPage.svelte"),

  hooks: {
    async beforeLoad(context) {
      if (context.pathname === "/login") return;

      const isAuthRequired = await checkAuthRequired();
      if (isAuthRequired && !getToken()) {
        throw navigate("/login");
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
 * A Svelte store that tracks the current route pathname.
 * Bridges sv-router's Svelte 5 `$state` reactivity with Svelte 4 legacy components.
 */
export const pathname = readable(getHashPathname(), (set) => {
  function update() {
    set(getHashPathname());
  }

  // Catch the initial route resolution (Router's init + onNavigate use replaceState)
  queueMicrotask(update);

  window.addEventListener("popstate", update);
  window.addEventListener("hashchange", update);

  const original = window.history.pushState.bind(window.history);
  const originalReplace = window.history.replaceState.bind(window.history);
  window.history.pushState = (...args) => {
    original(...args);
    queueMicrotask(update);
  };
  window.history.replaceState = (...args) => {
    originalReplace(...args);
    queueMicrotask(update);
  };

  return () => {
    window.removeEventListener("popstate", update);
    window.removeEventListener("hashchange", update);
    window.history.pushState = original;
    window.history.replaceState = originalReplace;
  };
});

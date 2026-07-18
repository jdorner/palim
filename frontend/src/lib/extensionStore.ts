import { derived, get, writable } from "svelte/store";
import type { ExtensionInfo } from "../../../shared/types";
import {
  fetchFileWatcherCount,
  fetchMcpServerCount,
  fetchScheduleCount,
  fetchWebhookCount,
  fetchWorkflowCount,
} from "./appStore";
import { authFetch } from "./auth";

/** All extensions as returned by the API. */
export const extensions = writable<ExtensionInfo[]>([]);

/** Navigation entries from enabled extensions, sorted by order then label. */
export const extensionNavItems = derived(extensions, ($extensions) => {
  return $extensions
    .filter((ext) => ext.enabled && ext.ui?.navigation)
    .flatMap((ext) => ext.ui!.navigation.map((nav) => ({ ...nav, extensionName: ext.name })))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
});

/** Set of routes from disabled extensions (used to guard navigation). */
export const disabledExtensionRoutes = derived(extensions, ($extensions) => {
  const routes = new Set<string>();
  for (const ext of $extensions) {
    if (!ext.enabled && ext.ui?.navigation) {
      for (const nav of ext.ui.navigation) {
        routes.add(nav.route);
      }
    }
  }
  return routes;
});

/** Fetches the extension list from the API. Retains previous state on failure. */
export async function fetchExtensions(): Promise<void> {
  try {
    const res = await authFetch("/api/extensions");
    if (res.ok) {
      extensions.set(await res.json());
    }
  } catch {
    // Retain last known state on failure
  }
}

/** Maps badge keys declared in extension manifests to their fetch functions. */
const badgeFetchMap: Record<string, () => void> = {
  scheduleCount: fetchScheduleCount,
  webhookCount: fetchWebhookCount,
  workflowCount: fetchWorkflowCount,
  fileWatcherCount: fetchFileWatcherCount,
  mcpServerCount: fetchMcpServerCount,
};

/**
 * Fetches badge data for all enabled extensions that declare a badgeKey.
 * Optionally accepts an additional badge fetch map for keys handled outside appStore
 * (e.g. scheduleCount which is fetched locally in App.svelte).
 */
export function fetchBadgesForEnabledExtensions(extraFetchMap?: Record<string, () => void>): void {
  const allExtensions = get(extensions);
  if (allExtensions.length === 0) return;

  const mergedMap = extraFetchMap ? { ...badgeFetchMap, ...extraFetchMap } : badgeFetchMap;

  for (const ext of allExtensions) {
    if (!ext.enabled || !ext.ui?.navigation) continue;
    for (const nav of ext.ui.navigation) {
      if (nav.badgeKey && mergedMap[nav.badgeKey]) {
        mergedMap[nav.badgeKey]();
      }
    }
  }
}

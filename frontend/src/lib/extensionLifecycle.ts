import type { ExtensionLifecycleEvent } from "$shared/extensions";

/** What one combined refresh after a burst of `extension_lifecycle` events has to do. */
export interface LifecycleRefreshPlan {
  /** Whether extension translation catalogs changed (new or reloaded catalogs). */
  reloadCatalogs: boolean;
  /** Extensions that are (still) running and whose nav badges should be refetched. */
  badgeExtensions: Set<string>;
  /** Extensions whose last event was `deactivated` (the app leaves their routes). */
  deactivated: Set<string>;
}

/** Actions after which an extension's catalogs may differ from the loaded ones. */
const CATALOG_ACTIONS = new Set<ExtensionLifecycleEvent["action"]>(["loaded", "activated", "locales_updated"]);

/** Actions after which an extension no longer runs. */
const STOP_ACTIONS = new Set<ExtensionLifecycleEvent["action"]>(["deactivated", "unloaded"]);

/**
 * Plans one refresh for a burst of lifecycle events (an update alone sends
 * `deactivated`, `unloaded`, `activated`, and `loaded`). Only the last event
 * per extension decides whether it runs; badges of untouched extensions are
 * not refetched.
 *
 * @param events - Events in arrival order
 * @returns The refresh plan
 */
export function planLifecycleRefresh(events: readonly ExtensionLifecycleEvent[]): LifecycleRefreshPlan {
  const last = new Map<string, ExtensionLifecycleEvent["action"]>();
  for (const event of events) last.set(event.name, event.action);

  const badgeExtensions = new Set<string>();
  const deactivated = new Set<string>();
  for (const [name, action] of last) {
    if (action === "deactivated") deactivated.add(name);
    else if (!STOP_ACTIONS.has(action)) badgeExtensions.add(name);
  }
  return {
    reloadCatalogs: events.some((e) => CATALOG_ACTIONS.has(e.action)),
    badgeExtensions,
    deactivated,
  };
}

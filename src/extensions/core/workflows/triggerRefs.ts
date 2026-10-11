/**
 * Trigger ref lookups: the webhooks, schedules, and file watchers a workflow
 * trigger can point at, fetched from their owning extensions on behalf of a
 * request, and the warnings for refs that no longer exist.
 *
 * @module
 */

import { createInternalFetch, resolveAmbientToken } from "@src/utils/fetch";
import { extractBearerToken } from "@src/web/auth";
import type { TemplateWarning } from "./dagTemplateValidation";
import type { DagWorkflowDefinition } from "./schemas";

/** Route namespaces of the extensions that own trigger refs (webhooks, file watchers, schedules). */
const TRIGGER_SOURCE_PREFIXES = ["/ext/webhooks", "/ext/filewatcher", "/ext/scheduler"];

/**
 * Builds an internal fetch for looking up trigger refs on behalf of a request.
 *
 * `ctx.fetch` is confined to `/ext/workflows`, so it cannot reach the
 * trigger-owning extensions. This fetch is additionally allowed into their
 * route namespaces and authorizes as the requesting user (falling back to the
 * ambient/system identity when the request carries no bearer token).
 *
 * @param request - The incoming request whose principal the lookups act as.
 * @returns A `fetch`-compatible function confined to trigger-source routes.
 */
export function createTriggerSourceFetch(request: Request): typeof globalThis.fetch {
  const token = extractBearerToken(request.headers.get("authorization"));
  return createInternalFetch({
    tokenProvider: () => token || resolveAmbientToken(),
    prefix: "/ext/workflows",
    allowExtraPrefixes: TRIGGER_SOURCE_PREFIXES,
  });
}

/** Trigger types whose `ref` points at an entity owned by another extension. */
type RefTriggerType = "webhook" | "schedule" | "filewatcher";

/**
 * Known trigger refs per trigger type. `null` means the lookup failed (owning
 * extension disabled, unreachable, or access denied), so refs of that type
 * cannot be verified.
 */
export type TriggerRefLookup = Record<RefTriggerType, string[] | null>;

/** Human-readable names of the entities a trigger ref points at. */
const TRIGGER_REF_LABELS: Record<RefTriggerType, string> = {
  webhook: "Webhook",
  schedule: "Schedule",
  filewatcher: "File watcher",
};

/**
 * Looks up the existing trigger refs (webhook slugs, schedule ids, file
 * watcher slugs) on behalf of a request.
 *
 * @param request - The incoming request whose principal the lookups act as.
 * @param origin - Internal server origin to fetch from.
 * @returns The known refs per trigger type (`null` for a failed lookup).
 */
export async function fetchTriggerRefs(request: Request, origin: string): Promise<TriggerRefLookup> {
  const triggerFetch = createTriggerSourceFetch(request);
  const lookup = <T>(path: string, key: (item: T) => string): Promise<string[] | null> =>
    triggerFetch(`${origin}${path}`)
      .then((r) => (r.ok ? (r.json() as Promise<T[]>) : null))
      .then((list) => (Array.isArray(list) ? list.map(key).sort() : null))
      .catch(() => null);

  const [webhook, schedule, filewatcher] = await Promise.all([
    lookup<{ slug: string }>("/ext/webhooks", (w) => w.slug),
    lookup<{ id: string }>("/ext/scheduler/schedules", (s) => s.id),
    lookup<{ slug: string }>("/ext/filewatcher", (w) => w.slug),
  ]);
  return { webhook, schedule, filewatcher };
}

/**
 * Produces warnings for a trigger whose `ref` is missing or points at an
 * entity that no longer exists (e.g. a deleted webhook). Warnings use the
 * reserved `__trigger__` step slug so the UI attributes them to the trigger
 * node. Refs whose lookup failed are not reported.
 *
 * @param definition - The DAG workflow definition to check
 * @param refs - Known trigger refs per trigger type
 * @returns Array of trigger warnings (empty if the trigger is valid or unverifiable)
 */
export function getTriggerRefWarnings(definition: DagWorkflowDefinition, refs: TriggerRefLookup): TemplateWarning[] {
  const { type, ref } = definition.trigger;
  if (type === "manual") return [];

  const label = TRIGGER_REF_LABELS[type];
  if (!ref) {
    return [{ stepSlug: "__trigger__", field: "ref", message: `${label} trigger has no ref` }];
  }
  const known = refs[type];
  if (known && !known.includes(ref)) {
    return [{ stepSlug: "__trigger__", field: "ref", message: `${label} "${ref}" does not exist` }];
  }
  return [];
}

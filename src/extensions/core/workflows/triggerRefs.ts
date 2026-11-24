/**
 * Trigger ref lookups: the webhooks, schedules, file watchers, and extension
 * trigger refs a workflow trigger can point at, fetched from their owning
 * extensions on behalf of a request, and the warnings for refs that no longer
 * exist or trigger types no extension registers.
 *
 * @module
 */

import type { ExtensionContext, TriggerTypeDefinition } from "@ext/types";
import {
  type BUILTIN_REF_TRIGGER_TYPES,
  isBuiltinTriggerType,
  triggerRefMode as sharedTriggerRefMode,
} from "@shared/workflows";
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
function createTriggerSourceFetch(request: Request): typeof globalThis.fetch {
  const token = extractBearerToken(request.headers.get("authorization"));
  return createInternalFetch({
    tokenProvider: () => token || resolveAmbientToken(),
    prefix: "/ext/workflows",
    allowExtraPrefixes: TRIGGER_SOURCE_PREFIXES,
  });
}

/** Built-in trigger types whose `ref` points at an entity owned by another extension. */
type BuiltinRefTriggerType = (typeof BUILTIN_REF_TRIGGER_TYPES)[number];

/** Looks up a trigger type registered by an extension (`ctx.triggerTypes.get`). */
export type TriggerTypeLookup = (type: string) => TriggerTypeDefinition | undefined;

/**
 * How a trigger type takes a `ref` ({@link sharedTriggerRefMode}), for a
 * backend that looks up live trigger type definitions.
 *
 * @param type - The trigger type
 * @param getTriggerType - Looks up extension trigger types
 * @returns The ref rule of the type
 */
export function triggerRefMode(type: string, getTriggerType: TriggerTypeLookup): "required" | "none" | "unknown" {
  return sharedTriggerRefMode(type, (t) => {
    const registered = getTriggerType(t);
    return registered && { hasRefs: typeof registered.refs === "function" };
  });
}

/**
 * Known trigger refs per ref-taking trigger type (built-in and extension).
 * `null` means the lookup failed (owning extension disabled, unreachable,
 * access denied, or its `refs()` threw), so refs of that type cannot be
 * verified. A type missing from the record is treated the same way.
 */
export type TriggerRefLookup = Record<string, string[] | null>;

/** Human-readable names of the entities a built-in trigger ref points at. */
const TRIGGER_REF_LABELS: Record<BuiltinRefTriggerType, string> = {
  webhook: "Webhook",
  schedule: "Schedule",
  filewatcher: "File watcher",
};

/**
 * Lists the refs of every extension trigger type that declares `refs`.
 *
 * @param triggerTypes - The context's trigger type registry
 * @returns Sorted refs per extension trigger type (`null` when its `refs()` failed)
 */
export async function fetchExtensionTriggerRefs(
  triggerTypes: Pick<ExtensionContext["triggerTypes"], "get" | "list">,
): Promise<TriggerRefLookup> {
  const entries = await Promise.all(
    triggerTypes
      .list()
      .filter((info) => info.hasRefs)
      .map(async (info): Promise<[string, string[] | null]> => {
        try {
          const refs = await triggerTypes.get(info.type)?.refs?.();
          return [info.type, Array.isArray(refs) ? refs.filter((r) => typeof r === "string").sort() : null];
        } catch {
          return [info.type, null];
        }
      }),
  );
  return Object.fromEntries(entries);
}

/**
 * Looks up the existing trigger refs (webhook slugs, schedule ids, file
 * watcher slugs, and the refs of extension trigger types) on behalf of a
 * request.
 *
 * @param request - The incoming request whose principal the built-in lookups act as.
 * @param origin - Internal server origin to fetch from.
 * @param triggerTypes - The context's trigger type registry, for extension refs (omit to skip them)
 * @returns The known refs per trigger type (`null` for a failed lookup).
 */
export async function fetchTriggerRefs(
  request: Request,
  origin: string,
  triggerTypes?: Pick<ExtensionContext["triggerTypes"], "get" | "list">,
): Promise<TriggerRefLookup> {
  const triggerFetch = createTriggerSourceFetch(request);
  const lookup = <T>(path: string, key: (item: T) => string): Promise<string[] | null> =>
    triggerFetch(`${origin}${path}`)
      .then((r) => (r.ok ? (r.json() as Promise<T[]>) : null))
      .then((list) => (Array.isArray(list) ? list.map(key).sort() : null))
      .catch(() => null);

  const [webhook, schedule, filewatcher, extensionRefs] = await Promise.all([
    lookup<{ slug: string }>("/ext/webhooks", (w) => w.slug),
    lookup<{ id: string }>("/ext/scheduler/schedules", (s) => s.id),
    lookup<{ slug: string }>("/ext/filewatcher", (w) => w.slug),
    triggerTypes ? fetchExtensionTriggerRefs(triggerTypes) : Promise.resolve({}),
  ]);
  // Built-in names cannot be registered by extensions, so the spread never overwrites them.
  return { ...extensionRefs, webhook, schedule, filewatcher };
}

/**
 * Produces warnings for a trigger whose `ref` is missing or points at an
 * entity that no longer exists (e.g. a deleted webhook). Warnings use the
 * reserved `__trigger__` step slug so the UI attributes them to the trigger
 * node. Refs whose lookup failed are not reported.
 *
 * Portal triggers have no ref; they are reported when their run-as binding
 * is missing or unusable (when `describeRunAs` is given).
 *
 * Extension trigger types are checked against their registration (when
 * `getTriggerType` is given): an unregistered type is reported, since the
 * workflow never starts until an extension registers it again.
 *
 * @param definition - The DAG workflow definition to check
 * @param refs - Known trigger refs per trigger type
 * @param describeRunAs - Describes a portal workflow's run-as account (null = unbound or deleted); omit to skip the check
 * @param getTriggerType - Looks up extension trigger types; omit to skip checking extension triggers
 * @returns Array of trigger warnings (empty if the trigger is valid or unverifiable)
 */
export function getTriggerRefWarnings(
  definition: DagWorkflowDefinition,
  refs: TriggerRefLookup,
  describeRunAs?: (workflowName: string) => { username: string; usable: boolean } | null,
  getTriggerType?: TriggerTypeLookup,
): TemplateWarning[] {
  const { type, ref } = definition.trigger;
  if (type === "portal") {
    if (!describeRunAs) return [];
    const runAs = describeRunAs(definition.name);
    const warn = (message: string): TemplateWarning[] => [{ stepSlug: "__trigger__", field: "runAs", message }];
    if (!runAs) return warn("Portal trigger has no run-as account: save the workflow in the editor to bind it");
    if (!runAs.usable) return warn(`Run-as account "${runAs.username}" is disabled or not an operator account`);
    return [];
  }
  if (!isBuiltinTriggerType(type)) {
    if (!getTriggerType) return [];
    const registered = getTriggerType(type);
    if (!registered) {
      return [
        {
          stepSlug: "__trigger__",
          field: "type",
          message: `Trigger type "${type}" is not registered by any active extension: the workflow does not start`,
        },
      ];
    }
    if (typeof registered.refs !== "function") return [];
    return refWarnings(registered.label, ref, refs[type]);
  }
  const label = TRIGGER_REF_LABELS[type as BuiltinRefTriggerType];
  return label ? refWarnings(label, ref, refs[type]) : [];
}

/**
 * Warns about a missing ref, or one that is not among the known refs.
 *
 * @param label - What the ref points at (e.g. "Webhook")
 * @param ref - The trigger's ref
 * @param known - The known refs; null or undefined when unverifiable
 * @returns Zero or one warning
 */
function refWarnings(label: string, ref: string | undefined, known: string[] | null | undefined): TemplateWarning[] {
  if (!ref) {
    return [{ stepSlug: "__trigger__", field: "ref", message: `${label} trigger has no ref` }];
  }
  if (known && !known.includes(ref)) {
    return [{ stepSlug: "__trigger__", field: "ref", message: `${label} "${ref}" does not exist` }];
  }
  return [];
}

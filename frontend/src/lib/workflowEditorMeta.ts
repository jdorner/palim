/**
 * Fetchers for the reference data the workflow editor needs: available tools,
 * skills, and trigger refs, plus secret/variable keys for template
 * autocomplete. All fail soft, returning empty values on error.
 */
import type { OutputSchemaShorthand, OutputSchemas } from "$shared/workflows";
import { authFetch } from "./auth";
import type { InferSource } from "./outputSchemaShorthand";
import type { WorkflowWarning } from "./workflowDetail";

/** Trigger refs available per trigger type (webhook names, schedule ids, ...). */
export type TriggerRefs = Record<string, string[]>;

export interface WorkflowEditorMeta {
  tools: string[];
  skills: string[];
  triggerRefs: TriggerRefs;
}

/** @returns An empty trigger-ref map with the known trigger types. */
export function emptyTriggerRefs(): TriggerRefs {
  return { webhook: [], schedule: [], filewatcher: [] };
}

/**
 * Fetches available tools, skills and trigger refs from the workflow meta endpoints.
 *
 * @returns The meta data; each part is empty if its request failed.
 */
export async function fetchWorkflowEditorMeta(): Promise<WorkflowEditorMeta> {
  try {
    const [toolsRes, skillsRes, triggersRes] = await Promise.all([
      authFetch("/ext/workflows/meta/tools"),
      authFetch("/ext/workflows/meta/skills"),
      authFetch("/ext/workflows/meta/triggers"),
    ]);
    return {
      tools: toolsRes.ok ? await toolsRes.json() : [],
      skills: skillsRes.ok ? await skillsRes.json() : [],
      triggerRefs: triggersRes.ok ? await triggersRes.json() : emptyTriggerRefs(),
    };
  } catch {
    return { tools: [], skills: [], triggerRefs: emptyTriggerRefs() };
  }
}

/**
 * Fetches the keys of a keyed listing endpoint (e.g. `/api/secrets`).
 *
 * @param url - Endpoint returning `{ [field]: Array<{ key: string }> }`.
 * @param field - Name of the array property in the response.
 * @returns The keys, or an empty array on failure.
 */
async function fetchKeys(url: string, field: string): Promise<string[]> {
  try {
    const res = await authFetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as Record<string, Array<{ key: string }>>;
    return (data[field] ?? []).map((entry) => entry.key);
  } catch {
    return [];
  }
}

/** @returns Global secret keys for `{{secret.*}}` autocomplete. */
export function fetchSecretKeys(): Promise<string[]> {
  return fetchKeys("/api/secrets", "secrets");
}

/** @returns Global variable keys for `{{var.*}}` autocomplete. */
export function fetchVariableKeys(): Promise<string[]> {
  return fetchKeys("/api/variables", "variables");
}

/** Server analysis of an unsaved workflow draft (`POST /ext/workflows/meta/analyze`). */
export interface WorkflowAnalysis {
  /** Whether the draft is a valid workflow definition. */
  valid: boolean;
  /** Output schemas resolved for the draft (best effort when invalid). */
  outputSchemas: OutputSchemas;
  /** Advisory warnings, as the detail route reports them for a saved workflow. */
  warnings: WorkflowWarning[];
}

/**
 * Analyzes a workflow draft on the server: resolves output schemas for template
 * autocomplete and collects template/config warnings without saving.
 *
 * @param definition - The serialized draft (see `serializeWorkflowDraft`).
 * @param signal - Aborts the request when the draft changes again.
 * @returns The analysis, or `null` if the request failed or was aborted.
 */
export async function fetchWorkflowAnalysis(
  definition: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<WorkflowAnalysis | null> {
  try {
    const res = await authFetch("/ext/workflows/meta/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(definition),
      signal,
    });
    return res.ok ? ((await res.json()) as WorkflowAnalysis) : null;
  } catch {
    return null;
  }
}

/** A shorthand inferred from a run (`GET /ext/workflows/meta/infer-schema/:name`). */
export interface InferredSchema {
  runId: string;
  runCreatedAt: number;
  shorthand: OutputSchemaShorthand;
}

/**
 * Fetches a shorthand inferred from the newest run of a saved workflow that has
 * an object-shaped sample for the trigger or step.
 *
 * @param workflowName - The saved workflow name
 * @param source - The trigger, or a step by slug
 * @returns The inferred schema
 * @throws {Error} With the server's message when no sample exists or the request fails
 */
export async function fetchInferredSchema(workflowName: string, source: InferSource): Promise<InferredSchema> {
  const params = new URLSearchParams({ source: source.kind });
  if (source.kind === "step") params.set("slug", source.slug);
  const res = await authFetch(`/ext/workflows/meta/infer-schema/${encodeURIComponent(workflowName)}?${params}`);
  const body = (await res.json().catch(() => ({}))) as Partial<InferredSchema> & { error?: string };
  if (!res.ok || !body.shorthand) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as InferredSchema;
}

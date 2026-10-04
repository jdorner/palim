/**
 * Fetchers for the reference data the workflow editor needs: available tools,
 * skills, and trigger refs, plus secret/variable keys for template
 * autocomplete. All fail soft, returning empty values on error.
 */
import { authFetch } from "./auth";

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

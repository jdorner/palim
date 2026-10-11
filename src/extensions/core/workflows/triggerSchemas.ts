/**
 * Built-in output schemas for known trigger types.
 *
 * These describe the shape of `trigger.payload` for each trigger type,
 * enabling deep property path autocomplete in the frontend editor.
 *
 * The schemas are derived from the actual event payloads emitted by each
 * trigger source (filewatcher, webhooks, scheduler, portal).
 */

import type { OutputSchemaShorthand } from "./schemas";

/**
 * Output schema for filewatcher triggers.
 *
 * The workflow engine passes the full `filewatcher:detected` event context
 * as `triggerPayload`. Shape: `{ source, id, slug, filename, event }`.
 */
export const FILEWATCHER_TRIGGER_SCHEMA: OutputSchemaShorthand = {
  source: "string",
  id: "string",
  slug: "string",
  filename: "string",
  event: "string",
};

/**
 * Output schema for scheduler triggers.
 *
 * The workflow engine passes the full `scheduler:fired` event context
 * as `triggerPayload`. Shape: `{ source, id, slug, description, label }`.
 */
export const SCHEDULER_TRIGGER_SCHEMA: OutputSchemaShorthand = {
  source: "string",
  id: "string",
  slug: "string",
  description: "string",
  label: "string",
};

/**
 * Output schema for portal triggers.
 *
 * Built by the portal start route: the uploaded file (saved in the work
 * directory; `null` when none was uploaded), the form fields, and the portal
 * user who started the run.
 */
export const PORTAL_TRIGGER_SCHEMA: OutputSchemaShorthand = {
  file: { path: "string", name: "string", mimeType: "string", size: "number" },
  data: "object",
  submittedBy: { id: "string", username: "string", displayName: "string" },
  submittedAt: "string",
};

/**
 * Built-in trigger output schemas keyed by trigger type.
 *
 * Webhook and manual triggers have no built-in schema since their
 * payload shape is user-defined (arbitrary JSON body or manual input).
 * Users can still declare a custom `outputSchema` on those triggers.
 */
export const BUILTIN_TRIGGER_SCHEMAS: Partial<Record<string, OutputSchemaShorthand>> = {
  filewatcher: FILEWATCHER_TRIGGER_SCHEMA,
  schedule: SCHEDULER_TRIGGER_SCHEMA,
  portal: PORTAL_TRIGGER_SCHEMA,
};

/**
 * Returns the effective output schema for a trigger, preferring an explicit
 * user-defined schema over the built-in default.
 *
 * @param triggerType - The trigger type (e.g. "filewatcher", "webhook", "schedule", "manual")
 * @param explicitSchema - User-defined outputSchema from the workflow definition (if any)
 * @returns The resolved output schema, or undefined if none is available
 */
export function resolveTriggerOutputSchema(
  triggerType: string,
  explicitSchema?: OutputSchemaShorthand,
): OutputSchemaShorthand | undefined {
  return explicitSchema ?? BUILTIN_TRIGGER_SCHEMAS[triggerType];
}

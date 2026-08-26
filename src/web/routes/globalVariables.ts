/**
 * Global variable management routes - CRUD operations for non-sensitive,
 * plaintext key-value pairs stored at the global scope.
 *
 * Unlike global secrets, variables carry no encryption, no per-consumer ACL,
 * and no value masking: listings return full plaintext values. Variables are
 * typically referenced by workflow templates via `{{var.KEY}}` syntax.
 *
 * Handles:
 * - `GET /api/variables` - List all global variables (full unmasked values)
 * - `PUT /api/variables` - Upsert global variables with optional descriptions
 * - `DELETE /api/variables/:key` - Remove a variable after a workflow
 *   reference check (requires confirmation when workflows still reference it)
 */

import path from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { WORK_DIR } from "@src/config";
import { loadDagWorkflows } from "@src/extensions/core/workflows/dagLoader";
import { findWorkflowsReferencingVariable } from "@src/extensions/core/workflows/variableReferenceCheck";
import { mainLogger as log } from "@src/utils/logger";
import { formatValidationErrors } from "@src/utils/validation";
import type { VariableStore } from "@src/variables/store";
import type { GlobalVariableEntry } from "@src/variables/types";
import { Elysia } from "elysia";

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

/**
 * Valid variable key format: UPPER_SNAKE_CASE, 1 to 64 characters, starting
 * with a letter. Mirrors the global secret key format.
 */
const VARIABLE_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Maximum length of a variable value in characters. */
const MAX_VALUE_LEN = 65536;

/** Maximum length of a variable description in characters. */
const MAX_DESCRIPTION_LEN = 1024;

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

/**
 * Request body schema for `PUT /api/variables`.
 *
 * `variables` is a record of key to plaintext value; `descriptions` is an
 * optional record of key to description. Fine-grained rules (key format, value
 * emptiness, length limits, description key subset) are enforced in the handler
 * after the shape check so that per-field 400 messages can name the offender.
 */
const UpsertBody = Type.Object({
  variables: Type.Record(Type.String(), Type.String(), {
    description: "Key-value pairs to store (plaintext)",
  }),
  descriptions: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Per-key descriptions" })),
});

/**
 * Path parameters for `DELETE /api/variables/:key`.
 *
 * The key must be non-empty; format validity beyond that is not required here
 * because a nonexistent key is reported as a 404 by the handler.
 */
const DeleteParams = Type.Object({
  key: Type.String({ minLength: 1, description: "Variable key to delete" }),
});

/**
 * Query parameters for `DELETE /api/variables/:key`.
 *
 * `confirm=true` proceeds with deletion even when workflows reference the
 * variable; otherwise a referenced variable yields a 409 confirmation prompt.
 */
const DeleteQuery = Type.Object({
  confirm: Type.Optional(Type.Boolean({ description: "Confirm deletion despite references" })),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the global variable management route group.
 *
 * @param getStore - Getter for the VariableStore instance (may be undefined
 *   before the store is wired during boot); a 503 is returned when absent.
 * @returns Elysia plugin with global variable management routes
 */
export function globalVariableRoutes(getStore: () => VariableStore | undefined) {
  return new Elysia()
    .get("/api/variables", ({ status }) => {
      const store = getStore();
      if (!store) return status(503, { error: "Variable store not available" });

      try {
        const variables: GlobalVariableEntry[] = store.list();
        return status(200, { variables });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return status(500, { error: `Failed to read variables: ${message}` });
      }
    })
    .put(
      "/api/variables",
      ({ body, status }) => {
        const store = getStore();
        if (!store) return status(503, { error: "Variable store not available" });

        if (!Value.Check(UpsertBody, body)) {
          return status(400, {
            error: `Validation failed: ${formatValidationErrors(UpsertBody, body)}`,
          });
        }

        const { variables, descriptions } = body;

        // Require at least one entry.
        const keys = Object.keys(variables);
        if (keys.length === 0) {
          return status(400, { error: "No variables provided" });
        }

        // Validate key format.
        for (const key of keys) {
          if (!VARIABLE_KEY_RE.test(key)) {
            return status(400, {
              error: `Invalid key format: "${key}" (must be UPPER_SNAKE_CASE, 1-64 chars)`,
            });
          }
        }

        // Validate no empty/whitespace values.
        for (const [key, value] of Object.entries(variables)) {
          if (value.trim().length === 0) {
            return status(400, { error: `Empty value for key: ${key}` });
          }
        }

        // Validate value length limits.
        for (const [key, value] of Object.entries(variables)) {
          if (value.length > MAX_VALUE_LEN) {
            return status(400, {
              error: `Value for key "${key}" exceeds maximum length of ${MAX_VALUE_LEN} characters`,
            });
          }
        }

        // Validate description length limits.
        if (descriptions) {
          for (const [key, description] of Object.entries(descriptions)) {
            if (description.length > MAX_DESCRIPTION_LEN) {
              return status(400, {
                error: `Description for key "${key}" exceeds maximum length of ${MAX_DESCRIPTION_LEN} characters`,
              });
            }
          }
        }

        // Validate description keys are a subset of variable keys.
        if (descriptions) {
          for (const key of Object.keys(descriptions)) {
            if (!keys.includes(key)) {
              return status(400, { error: `Description for unknown key: ${key}` });
            }
          }
        }

        // All validation passed: persist each entry (overwriting existing keys).
        for (const [key, value] of Object.entries(variables)) {
          store.upsert(key, value, descriptions?.[key] ?? null);
        }

        return status(200, { success: true });
      },
      {
        body: UpsertBody,
      },
    )
    .delete(
      "/api/variables/:key",
      async ({ params, query, status }) => {
        const store = getStore();
        if (!store) return status(503, { error: "Variable store not available" });

        const { key } = params;

        // Reject missing/empty key (defense in depth; the schema also enforces this).
        if (!key || key.trim().length === 0) {
          return status(400, { error: "Missing or empty variable key" });
        }

        // A nonexistent key is a 404 and leaves the store unchanged.
        if (!store.has(key)) {
          return status(404, { error: "Variable not found" });
        }

        // Run the reference check against the on-disk workflow definitions.
        const workflowsDir = path.join(WORK_DIR, "workflows");
        const definitions = await loadDagWorkflows(workflowsDir, log);
        const referencingWorkflows = findWorkflowsReferencingVariable(definitions.values(), key);

        const confirmed = query.confirm === true;

        // Referenced and not confirmed: require confirmation, do not delete.
        if (referencingWorkflows.length > 0 && !confirmed) {
          return status(409, { requiresConfirmation: true, referencingWorkflows });
        }

        // Referenced + confirmed, or unreferenced: delete.
        store.remove(key);
        return status(200, { success: true });
      },
      {
        params: DeleteParams,
        query: DeleteQuery,
      },
    );
}

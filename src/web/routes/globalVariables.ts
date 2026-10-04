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
 * - `POST /api/variables` - Create global variables (409 if a key already exists)
 * - `PUT /api/variables` - Upsert global variables with optional descriptions
 * - `DELETE /api/variables/:key` - Remove a variable after a workflow
 *   reference check (requires confirmation when workflows still reference it)
 */

import path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
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

/**
 * Keys that must never be accepted because they can pollute an object's
 * prototype chain. These never match {@link VARIABLE_KEY_RE} anyway (they are
 * lowercase), but they must be detected from the RAW request body: Elysia's
 * body parser silently drops them from the parsed object, so they would
 * otherwise disappear before the format check runs.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Maximum length of a variable value in characters. */
const MAX_VALUE_LEN = 65536;

/** Maximum length of a variable description in characters. */
const MAX_DESCRIPTION_LEN = 1024;

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

/**
 * Request body schema shared by `POST` and `PUT /api/variables`.
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
// Raw-body inspection
// ---------------------------------------------------------------------------

/**
 * Scans a parsed request body for prototype-polluting keys in the `variables`
 * or `descriptions` records.
 *
 * Must be run on a body obtained via {@link JSON.parse} (which preserves keys
 * such as `__proto__` as own enumerable properties). Elysia's own body parser
 * strips those keys, so this check would find nothing on the framework-parsed
 * body - the route parses the raw text itself for this reason.
 *
 * @param parsed - The natively-parsed request body
 * @returns The first forbidden key found, or `null` if none
 */
function findForbiddenKey(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object") return null;

  for (const field of ["variables", "descriptions"] as const) {
    const record = (parsed as Record<string, unknown>)[field];
    if (record !== null && typeof record === "object") {
      for (const key of Object.keys(record)) {
        if (FORBIDDEN_KEYS.has(key)) return key;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Body parsing + validation
// ---------------------------------------------------------------------------

/** Outcome of {@link readWriteBody}. */
type WriteBodyResult = { ok: true; body: Static<typeof UpsertBody> } | { ok: false; error: string };

/**
 * Reads and validates a create/upsert request body.
 *
 * Parses the raw JSON body itself rather than relying on Elysia's parsed
 * `body` (routes using this must set `parse: "none"`): Elysia's parser
 * silently drops prototype-polluting keys (e.g. "__proto__"), so an attempt to
 * set such a key would otherwise vanish without an error. The native
 * JSON.parse preserves them as own enumerable properties, letting us detect and
 * reject them by name.
 *
 * @param request - The incoming request (body not yet consumed)
 * @returns The validated body, or an error message for a 400 response
 */
async function readWriteBody(request: Request): Promise<WriteBodyResult> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, error: "Could not read request body" };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }

  // Reject prototype-polluting keys before anything else.
  const forbiddenKey = findForbiddenKey(body);
  if (forbiddenKey) {
    return {
      ok: false,
      error: `Invalid key format: "${forbiddenKey}" (must be UPPER_SNAKE_CASE, 1-64 chars)`,
    };
  }

  if (!Value.Check(UpsertBody, body)) {
    return {
      ok: false,
      error: `Validation failed: ${formatValidationErrors(UpsertBody, body)}`,
    };
  }

  const { variables, descriptions } = body;

  // Require at least one entry.
  const keys = Object.keys(variables);
  if (keys.length === 0) {
    return { ok: false, error: "No variables provided" };
  }

  // Validate key format.
  for (const key of keys) {
    if (!VARIABLE_KEY_RE.test(key)) {
      return {
        ok: false,
        error: `Invalid key format: "${key}" (must be UPPER_SNAKE_CASE, 1-64 chars)`,
      };
    }
  }

  // Validate no empty/whitespace values.
  for (const [key, value] of Object.entries(variables)) {
    if (value.trim().length === 0) {
      return { ok: false, error: `Empty value for key: ${key}` };
    }
  }

  // Validate value length limits.
  for (const [key, value] of Object.entries(variables)) {
    if (value.length > MAX_VALUE_LEN) {
      return {
        ok: false,
        error: `Value for key "${key}" exceeds maximum length of ${MAX_VALUE_LEN} characters`,
      };
    }
  }

  // Validate description length limits.
  if (descriptions) {
    for (const [key, description] of Object.entries(descriptions)) {
      if (description.length > MAX_DESCRIPTION_LEN) {
        return {
          ok: false,
          error: `Description for key "${key}" exceeds maximum length of ${MAX_DESCRIPTION_LEN} characters`,
        };
      }
    }
  }

  // Validate description keys are a subset of variable keys.
  if (descriptions) {
    for (const key of Object.keys(descriptions)) {
      if (!keys.includes(key)) {
        return { ok: false, error: `Description for unknown key: ${key}` };
      }
    }
  }

  return { ok: true, body };
}

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
    .post(
      "/api/variables",
      async ({ request, status }) => {
        const store = getStore();
        if (!store) return status(503, { error: "Variable store not available" });

        const parsed = await readWriteBody(request);
        if (!parsed.ok) return status(400, { error: parsed.error });

        // Never overwrite on create. The check and the inserts run without an
        // await in between, so no other request can slip in.
        const { variables, descriptions } = parsed.body;
        const existing = Object.keys(variables).filter((key) => store.has(key));
        if (existing.length > 0) {
          return status(409, { error: `Variable already exists: ${existing.join(", ")}`, existing });
        }
        for (const [key, value] of Object.entries(variables)) {
          store.upsert(key, value, descriptions?.[key] ?? null);
        }

        return status(201, { success: true });
      },
      // readWriteBody reads the raw body. Without this, a global hook that
      // takes the whole context makes Elysia consume the body first.
      { parse: "none" },
    )
    .put(
      "/api/variables",
      async ({ request, status }) => {
        const store = getStore();
        if (!store) return status(503, { error: "Variable store not available" });

        const parsed = await readWriteBody(request);
        if (!parsed.ok) return status(400, { error: parsed.error });

        // All validation passed: persist each entry (overwriting existing keys).
        const { variables, descriptions } = parsed.body;
        for (const [key, value] of Object.entries(variables)) {
          store.upsert(key, value, descriptions?.[key] ?? null);
        }

        return status(200, { success: true });
      },
      { parse: "none" },
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

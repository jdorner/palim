/**
 * Tests for the global variable management routes (globalVariableRoutes).
 *
 * Exercises the Elysia route group end-to-end by building the app from a real
 * VariableStore backed by an in-memory Drizzle database (via createTestDb, which
 * runs the real migrations including the global_variables table) and driving it
 * with `app.handle(new Request(...))`, asserting on `res.status` and the awaited
 * JSON body. No mocking frameworks are used.
 *
 * Coverage:
 * - Property 4 (key-format validation): the PUT handler accepts a key iff it
 *   matches ^[A-Z][A-Z0-9_]{0,63}$; a rejected key returns 400, leaves the store
 *   unchanged, and names the offending key.
 * - Property 5 (value/description validation): empty/whitespace values and
 *   over-length values/descriptions are rejected with 400 and leave the variable
 *   unchanged.
 * - Route status codes: 400 / 404 / 409 / 200 / 503 across GET/PUT/DELETE,
 *   including the DELETE reference-check confirmation flow.
 *
 * The DELETE reference-check loads workflow definitions from
 * `WORK_DIR/workflows` at call time (Option A in the design). The 409 test
 * writes a temporary workflow file referencing the key into that directory and
 * removes it (and the directory, if the test created it) afterward. This is the
 * only way to drive the real reference-check path without hardcoding, since the
 * route resolves WORK_DIR at import time from AGENT_WORK_DIR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { WORK_DIR } from "@src/config";
import { createTestDb } from "@src/test/db";
import { VariableStore } from "@src/variables/store";
import { Elysia } from "elysia";
import fc from "fast-check";
import { globalVariableRoutes } from "./globalVariables";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const MAX_VALUE_LEN = 65536;
const MAX_DESCRIPTION_LEN = 1024;
const VARIABLE_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

type TestApp = { handle: (req: Request) => Response | Promise<Response> };

/**
 * Build an app + store where the store is always present.
 *
 * @returns The Elysia app and the underlying VariableStore.
 */
function createApp() {
  const db = createTestDb();
  const store = new VariableStore(db);
  const app = new Elysia().use(globalVariableRoutes(() => store));
  return { app, store };
}

/**
 * Build an app whose store accessor always returns undefined (503 path).
 *
 * @returns The Elysia app with an absent store.
 */
function createAppWithoutStore() {
  const app = new Elysia().use(globalVariableRoutes(() => undefined));
  return { app };
}

function get(app: TestApp, p: string) {
  return app.handle(new Request(`http://localhost${p}`));
}

function put(app: TestApp, p: string, body: unknown) {
  return app.handle(
    new Request(`http://localhost${p}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function del(app: TestApp, p: string) {
  return app.handle(new Request(`http://localhost${p}`, { method: "DELETE" }));
}

/** A loose JSON body shape used only for reading assertion fields in tests. */
type JsonBody = Record<string, unknown> & {
  error?: string;
  success?: boolean;
  variables?: Array<{ key: string; value: string; description?: string }>;
  requiresConfirmation?: boolean;
  referencingWorkflows?: string[];
};

/** Parse a response body as loose JSON for assertion convenience. */
async function json(res: Response): Promise<JsonBody> {
  return (await res.json()) as JsonBody;
}

/**
 * Report whether a string survives as an own enumerable property when used as a
 * computed key in an object literal and JSON-serialized.
 *
 * Keys such as `__proto__` set the prototype instead of an own property in an
 * object literal, so they cannot be transmitted as a JSON key this way. Tests
 * that assert the handler names the offending key must exclude such keys, since
 * they would never reach the handler as a distinct entry.
 */
function isTransmittableKey(key: string): boolean {
  return Object.keys({ [key]: 1 }).length === 1 && Object.keys({ [key]: 1 })[0] === key;
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

const FIRST_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const REST_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split("");

/** Generate a valid variable key matching ^[A-Z][A-Z0-9_]{0,63}$. */
const validKeyArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...FIRST_CHARS), fc.array(fc.constantFrom(...REST_CHARS), { minLength: 0, maxLength: 63 }))
  .map(([first, rest]) => first + rest.join(""));

/**
 * Generate an arbitrary string usable as a JSON object key (may or may not be a
 * valid variable key). Excludes keys like `__proto__` that do not survive as an
 * own enumerable property in an object literal.
 */
const anyKeyArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 80 }).filter(isTransmittableKey);

/** Generate a non-empty, non-whitespace value within the length limit. */
const goodValueArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 256 })
  .filter((s) => s.trim().length > 0 && s.length <= MAX_VALUE_LEN);

// ---------------------------------------------------------------------------
// Property 4: key-format validation
// ---------------------------------------------------------------------------

describe("globalVariableRoutes", () => {
  // Feature: global-variables, Property 4
  describe("key-format validation", () => {
    // Validates: Requirements 1.4, 10.3, 10.4
    test("accepts a key iff it matches the key format, leaving the store unchanged on rejection", async () => {
      await fc.assert(
        fc.asyncProperty(anyKeyArb, goodValueArb, async (key, value) => {
          const { app, store } = createApp();

          const res = await put(app, "/api/variables", { variables: { [key]: value } });
          const matches = VARIABLE_KEY_RE.test(key);

          if (matches) {
            expect(res.status).toBe(200);
            expect(store.get(key)?.value).toBe(value);
          } else {
            expect(res.status).toBe(400);
            // The store must not have been touched.
            expect(store.list()).toEqual([]);
            expect(store.has(key)).toBe(false);
          }
        }),
        { numRuns: 100 },
      );
    });

    // Validates: Requirements 1.4, 10.4
    test("a rejected key error message names the offending key and prior state is preserved", async () => {
      await fc.assert(
        fc.asyncProperty(
          validKeyArb,
          goodValueArb,
          anyKeyArb.filter((k) => !VARIABLE_KEY_RE.test(k)),
          goodValueArb,
          async (existingKey, existingValue, badKey, badValue) => {
            const { app, store } = createApp();

            // Seed a valid, existing variable first.
            const seed = await put(app, "/api/variables", { variables: { [existingKey]: existingValue } });
            expect(seed.status).toBe(200);

            // Attempt a write with an invalid key.
            const res = await put(app, "/api/variables", { variables: { [badKey]: badValue } });
            expect(res.status).toBe(400);
            const body = await json(res);
            expect(body.error).toContain(badKey);

            // The previously stored value is unchanged and the bad key was not added.
            expect(store.get(existingKey)?.value).toBe(existingValue);
            expect(store.has(badKey)).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 5: value/description validation
  // -------------------------------------------------------------------------

  // Feature: global-variables, Property 5
  describe("value/description validation", () => {
    // Validates: Requirements 1.5, 2.5
    test("empty or whitespace-only value is rejected and any prior stored value is unchanged", async () => {
      const whitespaceArb = fc.stringMatching(/^[ \t\n\r]*$/).filter((s) => s.trim().length === 0);

      await fc.assert(
        fc.asyncProperty(validKeyArb, goodValueArb, whitespaceArb, async (key, priorValue, emptyish) => {
          const { app, store } = createApp();

          // Seed a valid prior value.
          const seed = await put(app, "/api/variables", { variables: { [key]: priorValue } });
          expect(seed.status).toBe(200);

          // Attempt to overwrite with an empty/whitespace value.
          const res = await put(app, "/api/variables", { variables: { [key]: emptyish } });
          expect(res.status).toBe(400);
          const body = await json(res);
          expect(body.error).toContain(key);

          // The prior value is unchanged.
          expect(store.get(key)?.value).toBe(priorValue);
        }),
        { numRuns: 100 },
      );
    });

    // Validates: Requirements 1.6, 2.6
    test("over-length value is rejected and the variable is unchanged", async () => {
      await fc.assert(
        fc.asyncProperty(
          validKeyArb,
          goodValueArb,
          fc.integer({ min: MAX_VALUE_LEN + 1, max: MAX_VALUE_LEN + 64 }),
          async (key, priorValue, overLen) => {
            const { app, store } = createApp();

            const seed = await put(app, "/api/variables", { variables: { [key]: priorValue } });
            expect(seed.status).toBe(200);

            const tooLong = "x".repeat(overLen);
            const res = await put(app, "/api/variables", { variables: { [key]: tooLong } });
            expect(res.status).toBe(400);
            const body = await json(res);
            expect(body.error).toContain(String(MAX_VALUE_LEN));

            // The prior value is unchanged.
            expect(store.get(key)?.value).toBe(priorValue);
          },
        ),
        { numRuns: 100 },
      );
    });

    // Validates: Requirements 1.6, 2.6
    test("over-length description is rejected and the variable is unchanged", async () => {
      await fc.assert(
        fc.asyncProperty(
          validKeyArb,
          goodValueArb,
          goodValueArb,
          fc.integer({ min: MAX_DESCRIPTION_LEN + 1, max: MAX_DESCRIPTION_LEN + 64 }),
          async (key, priorValue, newValue, overLen) => {
            const { app, store } = createApp();

            const seed = await put(app, "/api/variables", { variables: { [key]: priorValue } });
            expect(seed.status).toBe(200);

            const tooLongDesc = "d".repeat(overLen);
            const res = await put(app, "/api/variables", {
              variables: { [key]: newValue },
              descriptions: { [key]: tooLongDesc },
            });
            expect(res.status).toBe(400);
            const body = await json(res);
            expect(body.error).toContain(String(MAX_DESCRIPTION_LEN));

            // The variable is unchanged (neither value nor description updated).
            const entry = store.get(key);
            expect(entry?.value).toBe(priorValue);
            expect(entry?.description ?? "").toBe("");
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Route status codes (unit / example tests)
  // -------------------------------------------------------------------------

  describe("status codes", () => {
    // Validates: Requirements 10.4
    test("PUT returns 400 on a bad key format naming the key", async () => {
      const { app } = createApp();
      const res = await put(app, "/api/variables", { variables: { "lower-case": "value" } });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("Invalid key format");
      expect(body.error).toContain("lower-case");
    });

    // Validates: Requirements 1.5, 2.5
    test("PUT returns 400 on an empty value naming the key", async () => {
      const { app } = createApp();
      const res = await put(app, "/api/variables", { variables: { MY_KEY: "   " } });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("Empty value");
      expect(body.error).toContain("MY_KEY");
    });

    // Validates: Requirements 1.6, 2.6
    test("PUT returns 400 on an over-length value", async () => {
      const { app } = createApp();
      const res = await put(app, "/api/variables", { variables: { MY_KEY: "x".repeat(MAX_VALUE_LEN + 1) } });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain(String(MAX_VALUE_LEN));
    });

    // Validates: Requirements 1.6, 2.6
    test("PUT returns 400 on an over-length description", async () => {
      const { app } = createApp();
      const res = await put(app, "/api/variables", {
        variables: { MY_KEY: "value" },
        descriptions: { MY_KEY: "d".repeat(MAX_DESCRIPTION_LEN + 1) },
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain(String(MAX_DESCRIPTION_LEN));
    });

    test("PUT returns 400 when no variables are provided", async () => {
      const { app } = createApp();
      const res = await put(app, "/api/variables", { variables: {} });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toContain("No variables provided");
    });

    test("PUT returns 200 and persists a valid variable", async () => {
      const { app, store } = createApp();
      const res = await put(app, "/api/variables", {
        variables: { MY_KEY: "my-value" },
        descriptions: { MY_KEY: "a description" },
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);

      const entry = store.get("MY_KEY");
      expect(entry?.value).toBe("my-value");
      expect(entry?.description).toBe("a description");
    });

    // Validates: Requirements 3.2
    test("DELETE returns 404 for a missing key and leaves the store unchanged", async () => {
      const { app, store } = createApp();
      const res = await del(app, "/api/variables/DOES_NOT_EXIST");
      expect(res.status).toBe(404);
      const body = await json(res);
      expect(body.error).toContain("not found");
      expect(store.list()).toEqual([]);
    });

    // Validates: Requirements 4.6, 4.7
    test("GET returns an empty array when no variables exist", async () => {
      const { app } = createApp();
      const res = await get(app, "/api/variables");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.variables).toEqual([]);
    });

    // Validates: Requirements 4.2, 4.6, 10.2
    test("GET returns full unmasked values for all stored variables", async () => {
      const { app, store } = createApp();
      store.upsert("ALPHA", "alpha-plaintext-value", "first");
      store.upsert("BETA", "beta-plaintext-value");

      const res = await get(app, "/api/variables");
      expect(res.status).toBe(200);
      const body = await json(res);

      const variables = body.variables;
      expect(variables).toBeDefined();
      if (!variables) throw new Error("variables missing");

      expect(variables.length).toBe(2);
      const alpha = variables.find((v) => v.key === "ALPHA");
      const beta = variables.find((v) => v.key === "BETA");
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      if (!alpha || !beta) throw new Error("entries missing");
      expect(alpha.value).toBe("alpha-plaintext-value");
      expect(alpha.description).toBe("first");
      expect(beta.value).toBe("beta-plaintext-value");
    });

    // Validates: Requirements 3.2, 3.7
    test("DELETE returns 200 for an unreferenced existing key and removes it", async () => {
      const { app, store } = createApp();
      // A key that no workflow references (unique per run to avoid collisions).
      const key = `UNREFERENCED_${Date.now()}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      store.upsert(key, "to-be-deleted");

      const res = await del(app, `/api/variables/${key}`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(store.has(key)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Store-absent (503) path
  // -------------------------------------------------------------------------

  describe("store absent", () => {
    // Validates: store unavailable guard
    test("GET returns 503 when the store is absent", async () => {
      const { app } = createAppWithoutStore();
      const res = await get(app, "/api/variables");
      expect(res.status).toBe(503);
      const body = await json(res);
      expect(body.error).toContain("not available");
    });

    test("PUT returns 503 when the store is absent", async () => {
      const { app } = createAppWithoutStore();
      const res = await put(app, "/api/variables", { variables: { MY_KEY: "value" } });
      expect(res.status).toBe(503);
    });

    test("DELETE returns 503 when the store is absent", async () => {
      const { app } = createAppWithoutStore();
      const res = await del(app, "/api/variables/MY_KEY");
      expect(res.status).toBe(503);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE reference-check flow (409 / confirmed 200)
  // -------------------------------------------------------------------------
  //
  // These tests drive the real reference check, which loads workflow
  // definitions from `WORK_DIR/workflows` at call time. We write a temporary
  // workflow file that references the variable, then clean it up. The workflow
  // directory is created if it does not already exist and removed on cleanup
  // only when this test created it, so we never disturb a developer's real
  // workflows directory contents.
  describe("delete reference-check flow", () => {
    const workflowsDir = path.join(WORK_DIR, "workflows");
    const referencedKey = "DELETE_REFCHECK_KEY";
    const workflowName = "refcheck-delete-test";
    const workflowFile = path.join(workflowsDir, `${workflowName}.json5`);
    let createdWorkflowsDir = false;

    beforeEach(async () => {
      // Ensure the workflows directory exists; remember whether we created it.
      try {
        await readdir(workflowsDir);
      } catch {
        await mkdir(workflowsDir, { recursive: true });
        createdWorkflowsDir = true;
      }

      // A minimal single-step DAG workflow whose agent prompt references the key.
      const definition = {
        name: workflowName,
        trigger: { type: "manual" },
        steps: {
          greet: {
            type: "agent",
            prompt: `Hello {{var.${referencedKey}}}`,
          },
        },
        edges: [],
      };
      await writeFile(workflowFile, JSON.stringify(definition), "utf8");
    });

    afterEach(async () => {
      await rm(workflowFile, { force: true });
      if (createdWorkflowsDir) {
        // Only remove the directory if this test created it (best-effort).
        await rm(workflowsDir, { recursive: true, force: true });
        createdWorkflowsDir = false;
      }
    });

    // Validates: Requirements 3.4, 3.5
    test("returns 409 with referencingWorkflows when a referenced key is deleted without confirm", async () => {
      const { app, store } = createApp();
      store.upsert(referencedKey, "some-value");

      const res = await del(app, `/api/variables/${referencedKey}`);
      expect(res.status).toBe(409);
      const body = await json(res);
      expect(body.requiresConfirmation).toBe(true);
      expect(body.referencingWorkflows).toContain(workflowName);

      // The variable must NOT have been deleted.
      expect(store.has(referencedKey)).toBe(true);
    });

    // Validates: Requirements 3.6
    test("returns 200 and deletes when a referenced key is deleted with confirm=true", async () => {
      const { app, store } = createApp();
      store.upsert(referencedKey, "some-value");

      const res = await del(app, `/api/variables/${referencedKey}?confirm=true`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(store.has(referencedKey)).toBe(false);
    });
  });
});

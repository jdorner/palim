import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionInfo, SecretSchemaEntry } from "@shared/types";
import * as schema from "@src/db/schema";
import type { ExtensionRegistry } from "@src/extensions";
import { SecretVault } from "@src/secrets/vault";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Elysia } from "elysia";
import fc from "fast-check";
import { secretRoutes } from "./secrets";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(__dirname, "../../../drizzle");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db as unknown as BunSQLiteDatabase;
}

const TEST_SCHEMA: SecretSchemaEntry[] = [
  { key: "API_KEY", description: "API key", required: true },
  { key: "API_SECRET", description: "API secret", required: true },
  { key: "WEBHOOK_URL", description: "Webhook URL", required: false, group: "webhooks" },
];

function createFakeRegistry(extensions: Partial<ExtensionInfo>[] = []) {
  const defaultExt: ExtensionInfo = {
    name: "test-ext",
    version: "1.0.0",
    description: "Test extension",
    enabled: true,
    source: "external",
    core: false,
    toolCount: 0,
    routeCount: 0,
    queueCount: 0,
    skillCount: 0,
    settingsSchema: null,
    secretsSchema: TEST_SCHEMA,
    error: null,
    ui: null,
  };

  const infos = extensions.length > 0 ? extensions.map((e) => ({ ...defaultExt, ...e })) : [defaultExt];

  const fakeEventBus = { dispatch: () => {} };

  return {
    getLoadedExtensionInfo: () => infos as ExtensionInfo[],
    getEventBus: () => fakeEventBus,
  } as unknown as ExtensionRegistry;
}

async function createApp(registryOverride?: ExtensionRegistry, vaultOverride?: SecretVault) {
  const db = createTestDb();
  const masterKey = Buffer.alloc(32, 0xab);
  const vault = vaultOverride ?? (await SecretVault.create({ database: db, masterKey }));
  const registry = registryOverride ?? createFakeRegistry();

  const app = new Elysia().use(
    secretRoutes(
      () => registry,
      () => vault,
    ),
  );

  return { app, vault, registry, db };
}

type TestApp = { handle: (req: Request) => Response | Promise<Response> };

function get(app: TestApp, path: string) {
  return app.handle(new Request(`http://localhost${path}`));
}

function put(app: TestApp, path: string, body: unknown) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function del(app: TestApp, path: string) {
  return app.handle(new Request(`http://localhost${path}`, { method: "DELETE" }));
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("secretRoutes", () => {
  describe("GET /api/extensions/:name/secrets", () => {
    test("returns schema and status without values", async () => {
      const { app, vault } = await createApp();
      // Store a secret so one is "set"
      await vault.bulkUpsert("test-ext", { API_KEY: "my-key-value" });

      const res = await get(app, "/api/extensions/test-ext/secrets");
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.schema).toEqual(TEST_SCHEMA);
      expect(body.secrets).toBeArrayOfSize(3);

      const apiKey = body.secrets.find((s: { key: string }) => s.key === "API_KEY");
      expect(apiKey.status).toBe("set");

      const apiSecret = body.secrets.find((s: { key: string }) => s.key === "API_SECRET");
      expect(apiSecret.status).toBe("unset");

      // Verify no plaintext values are returned
      for (const s of body.secrets) {
        expect(s.value).toBeUndefined();
      }
    });

    test("returns 404 for non-existent extension", async () => {
      const { app } = await createApp();
      const res = await get(app, "/api/extensions/nonexistent/secrets");
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.error).toContain("not found");
    });

    test("returns 404 for extension without secretsSchema", async () => {
      const registry = createFakeRegistry([{ name: "no-schema-ext", secretsSchema: null }]);
      const { app } = await createApp(registry);

      const res = await get(app, "/api/extensions/no-schema-ext/secrets");
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.error).toContain("no secrets schema");
    });
  });

  describe("PUT /api/extensions/:name/secrets", () => {
    test("rejects unknown keys with 400", async () => {
      const { app } = await createApp();
      const res = await put(app, "/api/extensions/test-ext/secrets", {
        secrets: { UNKNOWN_KEY: "value" },
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.error).toContain("Unrecognized key");
    });

    test("rejects empty values with 400", async () => {
      const { app } = await createApp();
      const res = await put(app, "/api/extensions/test-ext/secrets", {
        secrets: { API_KEY: "   " },
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.error).toContain("Empty value");
    });

    test("rejects invalid consumer patterns with 400", async () => {
      const { app } = await createApp();
      const res = await put(app, "/api/extensions/test-ext/secrets", {
        secrets: { API_KEY: "valid-value" },
        consumers: ["INVALID PATTERN!!"],
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.error).toContain("Invalid consumer pattern");
    });

    test("succeeds and persists encrypted values atomically", async () => {
      const { app, vault } = await createApp();
      const res = await put(app, "/api/extensions/test-ext/secrets", {
        secrets: { API_KEY: "my-key", API_SECRET: "my-secret" },
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // Verify both secrets are persisted and resolvable
      const result1 = await vault.resolve("test-ext", "API_KEY", "ext:test-ext");
      expect(result1.value).toBe("my-key");

      const result2 = await vault.resolve("test-ext", "API_SECRET", "ext:test-ext");
      expect(result2.value).toBe("my-secret");
    });

    test("succeeds with valid consumer patterns", async () => {
      const { app } = await createApp();
      const res = await put(app, "/api/extensions/test-ext/secrets", {
        secrets: { API_KEY: "my-key" },
        consumers: ["ext:other", "workflow:*", "*"],
      });
      expect(res.status).toBe(200);
    });

    test("returns 404 for non-existent extension", async () => {
      const { app } = await createApp();
      const res = await put(app, "/api/extensions/nonexistent/secrets", {
        secrets: { API_KEY: "value" },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/extensions/:name/secrets/:key", () => {
    test("returns 404 for non-existent key", async () => {
      const { app } = await createApp();
      const res = await del(app, "/api/extensions/test-ext/secrets/API_KEY");
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.error).toContain("not found");
    });

    test("successfully deletes an existing secret", async () => {
      const { app, vault } = await createApp();
      // First store a secret
      await vault.bulkUpsert("test-ext", { API_KEY: "to-delete" });

      const res = await del(app, "/api/extensions/test-ext/secrets/API_KEY");
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // Verify it is gone
      const has = await vault.has("test-ext", "API_KEY");
      expect(has).toBe(false);
    });

    test("returns 404 for non-existent extension", async () => {
      const { app } = await createApp();
      const res = await del(app, "/api/extensions/nonexistent/secrets/API_KEY");
      expect(res.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

/**
 * Property-based tests for secrets API routes.
 *
 * Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 5.2, 5.3
 */
describe("secretRoutes (property-based)", () => {
  test("Feature: web-secret-management, Property 6: PUT key-schema membership", async () => {
    const { app } = await createApp();

    // Generator for schema keys (valid)
    const schemaKeyArb = fc.constantFrom("API_KEY", "API_SECRET", "WEBHOOK_URL");

    // Generator for potentially unknown keys (UPPER_SNAKE_CASE)
    const unknownKeyArb = fc
      .stringMatching(/^[A-Z][A-Z0-9_]{2,15}$/)
      .filter((k) => k !== "API_KEY" && k !== "API_SECRET" && k !== "WEBHOOK_URL");

    // Generator for non-empty, non-whitespace values
    const validValueArb = fc.string({ minLength: 1, maxLength: 128 }).filter((v) => v.trim().length > 0);

    // Generator for empty/whitespace-only values
    const emptyValueArb = fc.constantFrom("", " ", "   ", "\t", "\n");

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          // Case 1: All valid keys + non-empty values -> should succeed (200)
          fc
            .uniqueArray(schemaKeyArb, { minLength: 1, maxLength: 3 })
            .chain((keys) =>
              fc.tuple(fc.constant(keys), fc.array(validValueArb, { minLength: keys.length, maxLength: keys.length })),
            )
            .map(([keys, values]) => ({
              secrets: Object.fromEntries(keys.map((k, i) => [k, values[i]!])),
              expectSuccess: true,
            })),
          // Case 2: At least one unknown key -> should fail (400)
          unknownKeyArb.chain((unknownKey) =>
            validValueArb.map((value) => ({
              secrets: { [unknownKey]: value },
              expectSuccess: false,
            })),
          ),
          // Case 3: Valid key with empty value -> should fail (400)
          schemaKeyArb.chain((key) =>
            emptyValueArb.map((emptyVal) => ({
              secrets: { [key]: emptyVal },
              expectSuccess: false,
            })),
          ),
        ),
        async ({ secrets, expectSuccess }) => {
          const res = await put(app, "/api/extensions/test-ext/secrets", { secrets });

          if (expectSuccess) {
            expect(res.status).toBe(200);
          } else {
            expect(res.status).toBe(400);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("Feature: web-secret-management, Property 9: Consumer pattern format validation", async () => {
    const { app } = await createApp();

    // Valid consumer pattern generator
    const validPatternArb = fc.oneof(
      fc.constant("*"),
      // Exact identity: prefix:name
      fc
        .tuple(fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/), fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,10}$/))
        .map(([prefix, name]) => `${prefix}:${name}`),
      // Wildcard suffix: prefix:*
      fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/).map((prefix) => `${prefix}:*`),
    );

    // Invalid consumer pattern generator
    const invalidPatternArb = fc.oneof(
      fc.constant(""),
      fc.constant("::"),
      fc.constant("UPPERCASE:name"),
      fc.constant("has spaces:name"),
      fc.constant("ext:**"),
      fc.constant("ext:na me"),
      fc.constant(":missing-prefix"),
      fc.constant("123starts-with-number:name"),
      // Random strings unlikely to match the pattern
      fc.string({ minLength: 1, maxLength: 30 }).filter((s) => {
        const re = /^(\*|[a-z][a-z0-9-]*:[a-z0-9_-]+|[a-z][a-z0-9-]*:\*)$/;
        return !re.test(s);
      }),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          // Valid patterns should be accepted (200)
          fc.array(validPatternArb, { minLength: 1, maxLength: 3 }).map((patterns) => ({
            consumers: patterns,
            expectSuccess: true,
          })),
          // Invalid patterns should be rejected (400)
          invalidPatternArb.map((pattern) => ({
            consumers: [pattern],
            expectSuccess: false,
          })),
        ),
        async ({ consumers, expectSuccess }) => {
          const res = await put(app, "/api/extensions/test-ext/secrets", {
            secrets: { API_KEY: "test-value" },
            consumers,
          });

          if (expectSuccess) {
            expect(res.status).toBe(200);
          } else {
            expect(res.status).toBe(400);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

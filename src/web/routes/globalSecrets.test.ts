import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@src/db/schema";
import { SecretVault } from "@src/secrets/vault";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Elysia } from "elysia";
import { globalSecretRoutes } from "./globalSecrets";

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

async function createApp() {
  const db = createTestDb();
  const masterKey = Buffer.alloc(32, 0xab);
  const vault = await SecretVault.create({ database: db, masterKey });

  const app = new Elysia().use(globalSecretRoutes(() => vault));

  return { app, vault };
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

function patch(app: TestApp, path: string, body: unknown) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function del(app: TestApp, path: string) {
  return app.handle(new Request(`http://localhost${path}`, { method: "DELETE" }));
}

/** Seed a secret into the vault for testing. */
async function seedSecret(
  vault: SecretVault,
  key: string,
  value: string,
  consumers = ["workflow:*"],
  description?: string,
) {
  const descriptions = description ? { [key]: description } : undefined;
  await vault.upsertGlobal({ [key]: value }, consumers, descriptions);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("globalSecretRoutes", () => {
  describe("GET /api/secrets", () => {
    test("returns empty list when no secrets exist", async () => {
      const { app } = await createApp();
      const res = await get(app, "/api/secrets");
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.secrets).toEqual([]);
    });

    test("returns metadata without plaintext values", async () => {
      const { app, vault } = await createApp();
      await seedSecret(vault, "MY_TOKEN", "super-secret-value", ["workflow:*"], "A test token");

      const res = await get(app, "/api/secrets");
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.secrets).toBeArrayOfSize(1);
      expect(body.secrets[0].key).toBe("MY_TOKEN");
      expect(body.secrets[0].description).toBe("A test token");
      expect(body.secrets[0].consumers).toEqual(["workflow:*"]);
      expect(body.secrets[0].updatedAt).toBeNumber();
      // No plaintext value exposed
      expect(body.secrets[0].value).toBeUndefined();
      expect(body.secrets[0].encryptedValue).toBeUndefined();
    });
  });

  describe("PUT /api/secrets", () => {
    test("creates a new secret", async () => {
      const { app, vault } = await createApp();

      const res = await put(app, "/api/secrets", {
        secrets: { API_KEY: "my-api-key" },
        consumers: ["workflow:*"],
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // Verify stored and resolvable
      const resolved = await vault.resolve("global", "API_KEY", "workflow:daily");
      expect(resolved.value).toBe("my-api-key");
    });

    test("creates a secret with description", async () => {
      const { app } = await createApp();

      const res = await put(app, "/api/secrets", {
        secrets: { GITEA_TOKEN: "tok_123" },
        consumers: ["workflow:*"],
        descriptions: { GITEA_TOKEN: "Gitea API token" },
      });
      expect(res.status).toBe(200);

      const list = await get(app, "/api/secrets");
      const secrets = ((await list.json()) as any).secrets;
      expect(secrets[0].description).toBe("Gitea API token");
    });

    test("upserts an existing secret (overwrites value)", async () => {
      const { app, vault } = await createApp();
      await seedSecret(vault, "MY_KEY", "old-value", ["workflow:*"]);

      const res = await put(app, "/api/secrets", {
        secrets: { MY_KEY: "new-value" },
        consumers: ["workflow:*"],
      });
      expect(res.status).toBe(200);

      const resolved = await vault.resolve("global", "MY_KEY", "workflow:test");
      expect(resolved.value).toBe("new-value");
    });

    test("rejects empty secrets object", async () => {
      const { app } = await createApp();
      const res = await put(app, "/api/secrets", {
        secrets: {},
        consumers: ["workflow:*"],
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.error).toContain("No secrets provided");
    });

    test("rejects invalid key format", async () => {
      const { app } = await createApp();
      const res = await put(app, "/api/secrets", {
        secrets: { "lower-case": "value" },
        consumers: ["workflow:*"],
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.error).toContain("Invalid key format");
    });

    test("rejects empty values", async () => {
      const { app } = await createApp();
      const res = await put(app, "/api/secrets", {
        secrets: { MY_KEY: "   " },
        consumers: ["workflow:*"],
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.error).toContain("Empty value");
    });

    test("rejects missing consumers", async () => {
      const { app } = await createApp();
      const res = await put(app, "/api/secrets", {
        secrets: { MY_KEY: "value" },
        consumers: [],
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.error).toContain("At least one consumer pattern");
    });

    test("rejects invalid consumer patterns", async () => {
      const { app } = await createApp();
      const res = await put(app, "/api/secrets", {
        secrets: { MY_KEY: "value" },
        consumers: ["INVALID"],
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.error).toContain("Invalid consumer pattern");
    });

    test("rejects description for unknown key", async () => {
      const { app } = await createApp();
      const res = await put(app, "/api/secrets", {
        secrets: { MY_KEY: "value" },
        consumers: ["workflow:*"],
        descriptions: { OTHER_KEY: "wrong" },
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.error).toContain("Description for unknown key");
    });
  });

  describe("DELETE /api/secrets/:key", () => {
    test("deletes an existing secret", async () => {
      const { app, vault } = await createApp();
      await seedSecret(vault, "TO_DELETE", "some-value", ["workflow:*"]);

      const res = await del(app, "/api/secrets/TO_DELETE");
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // Verify it is gone
      const list = await get(app, "/api/secrets");
      const secrets = ((await list.json()) as any).secrets;
      expect(secrets).toEqual([]);
    });

    test("returns 404 for non-existent key", async () => {
      const { app } = await createApp();
      const res = await del(app, "/api/secrets/DOES_NOT_EXIST");
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.error).toContain("Secret not found");
    });
  });

  describe("PATCH /api/secrets/:key", () => {
    test("updates consumers for an existing secret", async () => {
      const { app, vault } = await createApp();
      await seedSecret(vault, "MY_TOKEN", "secret-val", ["workflow:*"]);

      const res = await patch(app, "/api/secrets/MY_TOKEN", {
        consumers: ["ext:telegram", "workflow:daily"],
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.success).toBe(true);

      // Verify consumers were updated
      const list = await get(app, "/api/secrets");
      const secrets = ((await list.json()) as any).secrets;
      const entry = secrets.find((s: any) => s.key === "MY_TOKEN");
      expect(entry.consumers).toContain("ext:telegram");
      expect(entry.consumers).toContain("workflow:daily");
    });

    test("updates description for an existing secret", async () => {
      const { app, vault } = await createApp();
      await seedSecret(vault, "MY_TOKEN", "secret-val", ["workflow:*"], "Old description");

      const res = await patch(app, "/api/secrets/MY_TOKEN", {
        consumers: ["workflow:*"],
        description: "New description",
      });
      expect(res.status).toBe(200);

      const list = await get(app, "/api/secrets");
      const secrets = ((await list.json()) as any).secrets;
      expect(secrets[0].description).toBe("New description");
    });

    test("clears description when null is passed", async () => {
      const { app, vault } = await createApp();
      await seedSecret(vault, "MY_TOKEN", "secret-val", ["workflow:*"], "Has description");

      const res = await patch(app, "/api/secrets/MY_TOKEN", {
        consumers: ["workflow:*"],
        description: null,
      });
      expect(res.status).toBe(200);

      const list = await get(app, "/api/secrets");
      const secrets = ((await list.json()) as any).secrets;
      expect(secrets[0].description).toBeUndefined();
    });

    test("preserves description when not provided in body", async () => {
      const { app, vault } = await createApp();
      await seedSecret(vault, "MY_TOKEN", "secret-val", ["workflow:*"], "Keep me");

      const res = await patch(app, "/api/secrets/MY_TOKEN", {
        consumers: ["workflow:*"],
      });
      expect(res.status).toBe(200);

      const list = await get(app, "/api/secrets");
      const secrets = ((await list.json()) as any).secrets;
      expect(secrets[0].description).toBe("Keep me");
    });

    test("returns 404 for non-existent key", async () => {
      const { app } = await createApp();
      const res = await patch(app, "/api/secrets/NONEXISTENT", {
        consumers: ["workflow:*"],
      });
      expect(res.status).toBe(404);

      const body = (await res.json()) as any;
      expect(body.error).toContain("Secret not found");
    });

    test("rejects empty consumers", async () => {
      const { app, vault } = await createApp();
      await seedSecret(vault, "MY_TOKEN", "val", ["workflow:*"]);

      const res = await patch(app, "/api/secrets/MY_TOKEN", {
        consumers: [],
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.error).toContain("At least one consumer pattern");
    });

    test("rejects invalid consumer patterns", async () => {
      const { app, vault } = await createApp();
      await seedSecret(vault, "MY_TOKEN", "val", ["workflow:*"]);

      const res = await patch(app, "/api/secrets/MY_TOKEN", {
        consumers: ["BAD PATTERN"],
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.error).toContain("Invalid consumer pattern");
    });

    test("does not modify value (value remains accessible)", async () => {
      const { app, vault } = await createApp();
      await seedSecret(vault, "MY_TOKEN", "original-secret", ["workflow:*"]);

      await patch(app, "/api/secrets/MY_TOKEN", {
        consumers: ["ext:telegram"],
      });

      // Value is still accessible with new consumer
      const resolved = await vault.resolve("global", "MY_TOKEN", "ext:telegram");
      expect(resolved.value).toBe("original-secret");
    });
  });

  describe("GET /api/secrets/audit", () => {
    test("returns audit entries after operations", async () => {
      const { app, vault } = await createApp();
      await seedSecret(vault, "AUDITED_KEY", "value", ["workflow:*"]);

      const res = await get(app, "/api/secrets/audit");
      expect(res.status).toBe(200);

      const body = (await res.json()) as any;
      expect(body.entries).toBeArray();
      expect(body.entries.length).toBeGreaterThan(0);
    });
  });
});

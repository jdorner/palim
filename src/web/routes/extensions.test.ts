/**
 * Integration tests for the extension settings route's dynamic item enrichment.
 *
 * Uses the real getDb() (backed by the test DATA_DIR) and a mock registry
 * that provides controlled settingsSchema values.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionInfo } from "@shared/extensions";
import type { ExtensionRegistry } from "@src/extensions";
import { clearDynamicItemProviders, registerDynamicItemProvider } from "@src/web/dynamicItemProviders";
import { Elysia } from "elysia";
import { extensionRoutes } from "./extensions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal mock registry that returns a single extension with the
 * given settings schema. The route only calls `getLoadedExtensionInfo()`.
 */
function createMockRegistry(settingsSchema: Record<string, unknown> | null): ExtensionRegistry {
  return {
    getLoadedExtensionInfo: (): ExtensionInfo[] => [
      {
        name: "test-ext",
        version: "1.0.0",
        description: "A test extension",
        enabled: true,
        source: "builtin",
        core: false,
        toolCount: 0,
        routeCount: 0,
        queueCount: 0,
        skillCount: 0,
        settingsSchema,
        secretsSchema: null,
        error: null,
        ui: null,
      },
    ],
  } as unknown as ExtensionRegistry;
}

function createApp(settingsSchema: Record<string, unknown> | null) {
  const registry = createMockRegistry(settingsSchema);
  const app = new Elysia().use(extensionRoutes(() => registry));
  return app;
}

type TestApp = { handle: (req: Request) => Response | Promise<Response> };

function get(app: TestApp, path: string) {
  return app.handle(new Request(`http://localhost${path}`));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extensionRoutes - dynamic item enrichment", () => {
  beforeEach(() => {
    clearDynamicItemProviders();
  });

  test("enriches availableItems from a registered dynamic provider", async () => {
    registerDynamicItemProvider("all-queue-names", () => ["agents", "chat", "converter", "scheduler", "workflows"]);

    const schema = {
      type: "object",
      properties: {
        monitoredQueues: {
          type: "array",
          items: { type: "string" },
          title: "Monitored Queues",
          availableItems: ["agents", "chat", "workflows"],
          dynamicItems: "all-queue-names",
          default: ["agents", "workflows"],
        },
      },
      required: [],
    };

    const app = createApp(schema);
    const res = await get(app, "/api/extensions/test-ext/settings");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { schema: Record<string, any>; values: Record<string, unknown> };
    const prop = body.schema.properties.monitoredQueues;
    expect(prop.availableItems).toEqual(["agents", "chat", "converter", "scheduler", "workflows"]);
    // dynamicItems annotation is still present in the schema
    expect(prop.dynamicItems).toBe("all-queue-names");
  });

  test("preserves static availableItems when no provider is registered", async () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
          availableItems: ["static1", "static2"],
          dynamicItems: "nonexistent-provider",
          default: [],
        },
      },
      required: [],
    };

    const app = createApp(schema);
    const res = await get(app, "/api/extensions/test-ext/settings");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { schema: Record<string, any>; values: Record<string, unknown> };
    expect(body.schema.properties.items.availableItems).toEqual(["static1", "static2"]);
  });

  test("returns schema unchanged when no dynamicItems are declared", async () => {
    const schema = {
      type: "object",
      properties: {
        name: {
          type: "string",
          title: "Name",
          default: "hello",
        },
      },
      required: [],
    };

    const app = createApp(schema);
    const res = await get(app, "/api/extensions/test-ext/settings");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { schema: Record<string, any>; values: Record<string, unknown> };
    expect(body.schema.properties.name.type).toBe("string");
    expect(body.schema.properties.name.dynamicItems).toBeUndefined();
  });

  test("does not mutate the original schema object", async () => {
    registerDynamicItemProvider("test-items", () => ["x", "y", "z"]);

    const originalSchema = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "string" },
          availableItems: ["a"],
          dynamicItems: "test-items",
          default: [],
        },
      },
      required: [],
    };

    const app = createApp(originalSchema);
    await get(app, "/api/extensions/test-ext/settings");
    // Original schema should not be modified
    expect(originalSchema.properties.list.availableItems).toEqual(["a"]);
  });
});

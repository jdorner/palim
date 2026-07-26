import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocketMessage } from "@shared/types";
import { DATA_DIR } from "@src/config";
import { closeDb, getDb, schema } from "@src/db";
import { ExtensionWatcher } from "./extensionWatcher";
import type { RegistryInitDeps } from "./registry";
import { ExtensionRegistry } from "./registry";

afterAll(() => {
  closeDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/**
 * Creates a minimal valid extension in the given base directory.
 */
async function createTempExtension(baseDir: string, name: string): Promise<string> {
  const extDir = join(baseDir, name);
  mkdirSync(extDir, { recursive: true });

  const manifest = {
    name,
    version: "1.0.0",
    description: `Test extension ${name}`,
  };

  const code = `
export default {
  manifest: ${JSON.stringify(manifest)},
  async initialize(ctx) {
    ctx.tools.register({
      name: "${name}_tool",
      label: "${name} tool",
      description: "A test tool",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
  },
  async shutdown() {},
};
`;

  await Bun.write(join(extDir, "index.ts"), code);
  return extDir;
}

/**
 * Creates fake RegistryInitDeps for testing.
 */
function createFakeDeps(): { deps: RegistryInitDeps; broadcasts: WebSocketMessage[] } {
  const broadcasts: WebSocketMessage[] = [];

  const deps: RegistryInitDeps = {
    routeRegistry: {
      registerRoute: () => {},
    },
    broadcastFn: (msg: WebSocketMessage) => broadcasts.push(msg),
    onQueueCreated: () => {},
    database: {} as any,
    runAgentFn: async () => ({ answer: "", state: "completed" as const, timestamp: Date.now() }),
    sessionStore: {} as any,
  };

  return { deps, broadcasts };
}

/**
 * Enables an extension in the DB so it participates in queries.
 */
function enableExtension(name: string): void {
  const db = getDb();
  db.insert(schema.extensionSettings)
    .values({ name, enabled: true, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: schema.extensionSettings.name,
      set: { enabled: true, updatedAt: Date.now() },
    })
    .run();
}

/** Waits for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait time for filesystem events + debounce to settle in tests. */
const EVENT_SETTLE_MS = 1500;

describe("ExtensionWatcher", () => {
  let tempDir: string;
  let externalDir: string;
  let registry: ExtensionRegistry;
  let watcher: ExtensionWatcher;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `ext-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });

    const builtinDir = join(tempDir, "builtin");
    externalDir = join(tempDir, "external");
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });

    registry = new ExtensionRegistry({
      extensionDirs: [builtinDir, externalDir],
      workDir: join(tempDir, "work"),
      dataDir: join(tempDir, "data"),
    });

    const fakes = createFakeDeps();
    await registry.initializeAll(fakes.deps);

    watcher = new ExtensionWatcher({
      directory: externalDir,
      registry,
      debounceMs: 100, // Short debounce for tests
    });
  });

  afterEach(async () => {
    await watcher.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("start and stop", () => {
    test("starts without error on valid directory", async () => {
      await watcher.start();
      // No exception means success
    });

    test("start is idempotent (second call is a no-op)", async () => {
      await watcher.start();
      await watcher.start();
      // No exception means success
    });

    test("does not throw when directory does not exist", async () => {
      const missingDirWatcher = new ExtensionWatcher({
        directory: join(tempDir, "nonexistent"),
        registry,
        debounceMs: 100,
      });
      await missingDirWatcher.start();
      await missingDirWatcher.stop();
    });

    test("stop without start is safe", async () => {
      await watcher.stop();
    });
  });

  describe("detecting new extensions", () => {
    test("loads extension when index.ts is created in a new subdirectory", async () => {
      await watcher.start();

      // Create a new extension directory with index.ts
      await createTempExtension(externalDir, "new-ext");

      // Wait for debounce + processing
      await sleep(EVENT_SETTLE_MS);

      const info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "new-ext")).toBe(true);
    });

    test("loads extension when directory with existing index.ts is created", async () => {
      await watcher.start();

      // Create directory and file in quick succession (simulates cp -r)
      const extDir = join(externalDir, "copied-ext");
      mkdirSync(extDir, { recursive: true });
      const manifest = {
        name: "copied-ext",
        version: "1.0.0",
        description: "Copied extension",
      };
      const code = `
export default {
  manifest: ${JSON.stringify(manifest)},
  async initialize(ctx) {},
  async shutdown() {},
};
`;
      await Bun.write(join(extDir, "index.ts"), code);

      await sleep(EVENT_SETTLE_MS);

      const info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "copied-ext")).toBe(true);
    });

    test("does not load extension without index.ts", async () => {
      await watcher.start();

      // Create directory without index.ts
      const extDir = join(externalDir, "incomplete-ext");
      mkdirSync(extDir, { recursive: true });
      await Bun.write(join(extDir, "readme.md"), "not an extension");

      await sleep(EVENT_SETTLE_MS);

      const info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "incomplete-ext")).toBe(false);
    });

    test("does not re-load already known extensions", async () => {
      // Pre-load an extension
      const extDir = await createTempExtension(externalDir, "preloaded-ext");
      await registry.loadOne(join(extDir, "index.ts"));
      enableExtension("preloaded-ext");

      // Now start the watcher - it should seed "preloaded-ext" as known
      await watcher.start();

      // Simulate a file change event by touching index.ts
      await Bun.write(join(extDir, "index.ts"), await Bun.file(join(extDir, "index.ts")).text());

      await sleep(EVENT_SETTLE_MS);

      // Should still only have one instance
      const info = registry.getLoadedExtensionInfo();
      const matches = info.filter((i) => i.name === "preloaded-ext");
      expect(matches.length).toBe(1);
    });
  });

  describe("detecting removed extensions", () => {
    test("unloads extension when directory is removed", async () => {
      // Load an extension first
      const extDir = await createTempExtension(externalDir, "remove-ext");
      await registry.loadOne(join(extDir, "index.ts"));
      enableExtension("remove-ext");

      // Start watcher (seeds known extensions)
      await watcher.start();

      // Remove the extension directory
      rmSync(extDir, { recursive: true, force: true });

      await sleep(EVENT_SETTLE_MS);

      const info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "remove-ext")).toBe(false);
    });

    test("unloads extension when index.ts is deleted", async () => {
      // Load an extension first
      const extDir = await createTempExtension(externalDir, "index-delete-ext");
      await registry.loadOne(join(extDir, "index.ts"));
      enableExtension("index-delete-ext");

      await watcher.start();

      // Delete just index.ts (leave the directory)
      rmSync(join(extDir, "index.ts"));

      await sleep(EVENT_SETTLE_MS);

      const info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "index-delete-ext")).toBe(false);
    });

    test("does not unload unknown extensions", async () => {
      await watcher.start();

      // Remove a directory that was never loaded
      const fakeDir = join(externalDir, "never-loaded");
      mkdirSync(fakeDir, { recursive: true });
      await sleep(200); // Let watcher settle

      rmSync(fakeDir, { recursive: true, force: true });

      await sleep(EVENT_SETTLE_MS);

      // No crash, no changes to loaded extensions
      const info = registry.getLoadedExtensionInfo();
      expect(info.length).toBe(0);
    });

    test("unloads extension when directory name differs from manifest name", async () => {
      await watcher.start();

      // Create extension with directory name "ext_my-app" but manifest name "my-app"
      const dirName = "ext_my-app";
      const extDir = join(externalDir, dirName);
      mkdirSync(extDir, { recursive: true });
      const manifest = {
        name: "my-app",
        version: "1.0.0",
        description: "Extension with different dir/manifest name",
      };
      const code = `
export default {
  manifest: ${JSON.stringify(manifest)},
  async initialize(ctx) {},
  async shutdown() {},
};
`;
      await Bun.write(join(extDir, "index.ts"), code);

      // Wait for watcher to detect and load
      await sleep(EVENT_SETTLE_MS);

      // Verify it loaded with manifest name
      let info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "my-app")).toBe(true);

      // Now remove the directory
      rmSync(extDir, { recursive: true, force: true });

      await sleep(EVENT_SETTLE_MS);

      // Should be unloaded using the manifest name
      info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "my-app")).toBe(false);
    });
  });

  describe("debouncing", () => {
    test("batches multiple rapid additions into a single processing pass", async () => {
      await watcher.start();

      // Create multiple extensions rapidly
      await createTempExtension(externalDir, "batch-ext-1");
      await createTempExtension(externalDir, "batch-ext-2");
      await createTempExtension(externalDir, "batch-ext-3");

      // Wait for single debounced processing
      await sleep(EVENT_SETTLE_MS);

      const info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "batch-ext-1")).toBe(true);
      expect(info.some((i) => i.name === "batch-ext-2")).toBe(true);
      expect(info.some((i) => i.name === "batch-ext-3")).toBe(true);
    });

    test("cancel pending load if directory is removed before debounce fires", async () => {
      await watcher.start();

      // Create then immediately remove
      const extDir = await createTempExtension(externalDir, "canceled-ext");
      rmSync(extDir, { recursive: true, force: true });

      await sleep(EVENT_SETTLE_MS);

      const info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "canceled-ext")).toBe(false);
    });
  });

  describe("error handling", () => {
    test("gracefully handles broken extension (invalid manifest)", async () => {
      await watcher.start();

      // Create an extension with invalid code
      const extDir = join(externalDir, "broken-ext");
      mkdirSync(extDir, { recursive: true });
      await Bun.write(join(extDir, "index.ts"), "export default { broken: true };");

      await sleep(EVENT_SETTLE_MS);

      // Watcher should not crash, and the broken extension should not be loaded
      const info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "broken-ext")).toBe(false);
    });

    test("stop clears pending timers and does not process after stop", async () => {
      await watcher.start();

      // Create an extension (starts debounce timer)
      await createTempExtension(externalDir, "stopped-ext");

      // Immediately stop before debounce fires
      await watcher.stop();

      await sleep(EVENT_SETTLE_MS);

      // Extension should NOT have been loaded (processing was canceled)
      const info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "stopped-ext")).toBe(false);
    });
  });

  describe("reloading", () => {
    test("reloads extension when index.ts is overwritten", async () => {
      await watcher.start();

      // Create and load the extension
      const extDir = join(externalDir, "reload-ext");
      mkdirSync(extDir, { recursive: true });
      const manifestV1 = { name: "reload-ext", version: "1.0.0", description: "v1" };
      const codeV1 = `
export default {
  manifest: ${JSON.stringify(manifestV1)},
  async initialize(ctx) {
    ctx.tools.register({
      name: "reload-ext_tool_v1",
      label: "v1 tool",
      description: "v1",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "v1" }], details: {} }),
    });
  },
  async shutdown() {},
};
`;
      await Bun.write(join(extDir, "index.ts"), codeV1);
      await sleep(EVENT_SETTLE_MS);

      // Verify v1 loaded
      let info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "reload-ext")).toBe(true);
      expect(registry.getRegisteredTools().some((t) => t.name === "reload-ext_tool_v1")).toBe(true);

      // Overwrite with v2 (simulates cp over existing)
      const manifestV2 = { name: "reload-ext", version: "2.0.0", description: "v2" };
      const codeV2 = `
export default {
  manifest: ${JSON.stringify(manifestV2)},
  async initialize(ctx) {
    ctx.tools.register({
      name: "reload-ext_tool_v2",
      label: "v2 tool",
      description: "v2",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "v2" }], details: {} }),
    });
  },
  async shutdown() {},
};
`;
      await Bun.write(join(extDir, "index.ts"), codeV2);
      await sleep(EVENT_SETTLE_MS);

      // v1 tool should be gone, v2 tool should be present
      info = registry.getLoadedExtensionInfo();
      expect(info.some((i) => i.name === "reload-ext" && i.version === "2.0.0")).toBe(true);
      expect(registry.getRegisteredTools().some((t) => t.name === "reload-ext_tool_v1")).toBe(false);
      expect(registry.getRegisteredTools().some((t) => t.name === "reload-ext_tool_v2")).toBe(true);
    });
  });
});

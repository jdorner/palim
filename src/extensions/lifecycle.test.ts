import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocketMessage } from "@shared/types";
import { DATA_DIR } from "@src/config";
import { closeDb, getDb, schema } from "@src/db";
import type { RegistryInitDeps } from "./registry";
import { ExtensionRegistry } from "./registry";

/** Collects all temp directories created during tests for cleanup. */
const tempDirsToClean: string[] = [];

afterAll(() => {
  closeDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  for (const dir of tempDirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Creates a temporary directory with a minimal valid extension for testing.
 */
async function createTempExtension(
  baseDir: string,
  name: string,
  opts?: { throwOnInit?: boolean; core?: boolean },
): Promise<string> {
  const extDir = join(baseDir, name);
  mkdirSync(extDir, { recursive: true });

  const manifest = {
    name,
    version: "1.0.0",
    description: `Test extension ${name}`,
    dependencies: [],
    ...(opts?.core ? { core: true } : {}),
  };

  const throwCode = opts?.throwOnInit ? `throw new Error("MISSING_TOKEN");` : "";

  const code = `
export default {
  manifest: ${JSON.stringify(manifest)},
  async initialize(ctx) {
    ${throwCode}
    ctx.registerTool({
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
 * Creates a minimal set of RegistryInitDeps fakes for testing.
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
 * Marks an extension as disabled in the DB.
 */
function disableExtension(name: string): void {
  const db = getDb();
  db.insert(schema.extensionSettings)
    .values({ name, enabled: false, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: schema.extensionSettings.name,
      set: { enabled: false, updatedAt: Date.now() },
    })
    .run();
}

/**
 * Marks an extension as enabled in the DB.
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

describe("Extension Lifecycle", () => {
  describe("boot with disabled extensions", () => {
    test("disabled extension is not initialized at boot", async () => {
      const tempDir = join(tmpdir(), `lifecycle-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      tempDirsToClean.push(tempDir);
      const builtinDir = join(tempDir, "builtin");
      mkdirSync(builtinDir, { recursive: true });

      // Create an extension in the builtin dir
      await createTempExtension(builtinDir, "disabled-ext");

      // Mark it as disabled BEFORE boot
      disableExtension("disabled-ext");

      const registry = new ExtensionRegistry({
        extensionDirs: [builtinDir],
        workDir: join(tempDir, "work"),
        dataDir: join(tempDir, "data"),
      });

      const fakes = createFakeDeps();
      await registry.initializeAll(fakes.deps);

      // Extension should be in the loaded list
      const info = registry.getLoadedExtensionInfo();
      const ext = info.find((e) => e.name === "disabled-ext");
      expect(ext).not.toBeUndefined();
      expect(ext!.enabled).toBe(false);

      // But it should have no tools registered (never initialized)
      const tools = registry.getRegisteredTools();
      expect(tools.some((t) => t.name === "disabled-ext_tool")).toBe(false);
      expect(ext!.toolCount).toBe(0);

      await registry.shutdownAll();
    });

    test("enabled extension is initialized normally at boot", async () => {
      const tempDir = join(tmpdir(), `lifecycle-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      tempDirsToClean.push(tempDir);
      const builtinDir = join(tempDir, "builtin");
      mkdirSync(builtinDir, { recursive: true });

      await createTempExtension(builtinDir, "enabled-ext");
      enableExtension("enabled-ext");

      const registry = new ExtensionRegistry({
        extensionDirs: [builtinDir],
        workDir: join(tempDir, "work"),
        dataDir: join(tempDir, "data"),
      });

      const fakes = createFakeDeps();
      await registry.initializeAll(fakes.deps);

      const tools = registry.getRegisteredTools();
      expect(tools.some((t) => t.name === "enabled-ext_tool")).toBe(true);

      await registry.shutdownAll();
    });
  });

  describe("deactivate and activate", () => {
    let tempDir: string;
    let registry: ExtensionRegistry;
    let broadcasts: WebSocketMessage[];

    beforeEach(async () => {
      tempDir = join(tmpdir(), `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      tempDirsToClean.push(tempDir);
      const builtinDir = join(tempDir, "builtin");
      mkdirSync(builtinDir, { recursive: true });

      await createTempExtension(builtinDir, "test-ext");
      enableExtension("test-ext");

      registry = new ExtensionRegistry({
        extensionDirs: [builtinDir],
        workDir: join(tempDir, "work"),
        dataDir: join(tempDir, "data"),
      });

      const fakes = createFakeDeps();
      broadcasts = fakes.broadcasts;
      await registry.initializeAll(fakes.deps);
    });

    test("deactivate shuts down extension and removes tools", async () => {
      // Verify tool is present before deactivation
      let tools = registry.getRegisteredTools();
      expect(tools.some((t) => t.name === "test-ext_tool")).toBe(true);

      await registry.deactivate("test-ext");

      // Tool should be gone
      tools = registry.getRegisteredTools();
      expect(tools.some((t) => t.name === "test-ext_tool")).toBe(false);

      // Extension still in loaded list but disabled
      const info = registry.getLoadedExtensionInfo();
      const ext = info.find((e) => e.name === "test-ext");
      expect(ext).not.toBeUndefined();
      expect(ext!.toolCount).toBe(0);
    });

    test("deactivate broadcasts lifecycle event", async () => {
      await registry.deactivate("test-ext");

      const event = broadcasts.find((b) => b.type === "extension_lifecycle" && (b as any).action === "deactivated");
      expect(event).not.toBeUndefined();
      expect((event as any).name).toBe("test-ext");
    });

    test("deactivate is no-op for already suspended extension", async () => {
      await registry.deactivate("test-ext");
      broadcasts.length = 0;

      // Second deactivation should be a no-op
      await registry.deactivate("test-ext");

      // No additional broadcast
      const events = broadcasts.filter((b) => b.type === "extension_lifecycle" && (b as any).action === "deactivated");
      expect(events.length).toBe(0);
    });

    test("deactivate throws for unknown extension", async () => {
      expect(registry.deactivate("nonexistent")).rejects.toThrow("not found");
    });

    test("activate re-initializes a suspended extension", async () => {
      await registry.deactivate("test-ext");

      // Tool should be gone
      let tools = registry.getRegisteredTools();
      expect(tools.some((t) => t.name === "test-ext_tool")).toBe(false);

      await registry.activate("test-ext");

      // Tool should be back
      tools = registry.getRegisteredTools();
      expect(tools.some((t) => t.name === "test-ext_tool")).toBe(true);
    });

    test("activate broadcasts lifecycle event", async () => {
      await registry.deactivate("test-ext");
      broadcasts.length = 0;

      await registry.activate("test-ext");

      const event = broadcasts.find((b) => b.type === "extension_lifecycle" && (b as any).action === "activated");
      expect(event).not.toBeUndefined();
      expect((event as any).name).toBe("test-ext");
    });

    test("activate is no-op for already active extension", async () => {
      broadcasts.length = 0;

      await registry.activate("test-ext");

      // No broadcast since it was already active
      const events = broadcasts.filter((b) => b.type === "extension_lifecycle" && (b as any).action === "activated");
      expect(events.length).toBe(0);
    });

    test("activate throws for unknown extension", async () => {
      expect(registry.activate("nonexistent")).rejects.toThrow("not found");
    });

    test("activate with failed initialize keeps extension suspended", async () => {
      // Create a new registry with an extension that throws on init
      const tempDir2 = join(tmpdir(), `lifecycle-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      tempDirsToClean.push(tempDir2);
      const builtinDir2 = join(tempDir2, "builtin");
      mkdirSync(builtinDir2, { recursive: true });

      await createTempExtension(builtinDir2, "failing-ext", { throwOnInit: true });
      disableExtension("failing-ext");

      const registry2 = new ExtensionRegistry({
        extensionDirs: [builtinDir2],
        workDir: join(tempDir2, "work"),
        dataDir: join(tempDir2, "data"),
      });

      const fakes2 = createFakeDeps();
      await registry2.initializeAll(fakes2.deps);

      // Extension should be suspended (disabled at boot)
      const infoBefore = registry2.getLoadedExtensionInfo();
      expect(infoBefore.find((e) => e.name === "failing-ext")!.toolCount).toBe(0);

      // Attempting to activate should throw
      expect(registry2.activate("failing-ext")).rejects.toThrow("MISSING_TOKEN");

      // Extension should still have no tools
      const tools = registry2.getRegisteredTools();
      expect(tools.some((t) => t.name === "failing-ext_tool")).toBe(false);

      await registry2.shutdownAll();
    });

    test("extension that fails at boot appears in loaded list as suspended with error", async () => {
      const tempDir2 = join(tmpdir(), `lifecycle-boot-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      tempDirsToClean.push(tempDir2);
      const builtinDir2 = join(tempDir2, "builtin");
      mkdirSync(builtinDir2, { recursive: true });

      await createTempExtension(builtinDir2, "boot-fail-ext", { throwOnInit: true });
      enableExtension("boot-fail-ext");

      const registry2 = new ExtensionRegistry({
        extensionDirs: [builtinDir2],
        workDir: join(tempDir2, "work"),
        dataDir: join(tempDir2, "data"),
      });

      const fakes2 = createFakeDeps();
      await registry2.initializeAll(fakes2.deps);

      // Extension should still appear in loaded list
      const info = registry2.getLoadedExtensionInfo();
      const ext = info.find((e) => e.name === "boot-fail-ext");
      expect(ext).not.toBeUndefined();
      expect(ext!.enabled).toBe(true);
      expect(ext!.toolCount).toBe(0);
      expect(ext!.error).toContain("MISSING_TOKEN");

      await registry2.shutdownAll();
    });
  });
});

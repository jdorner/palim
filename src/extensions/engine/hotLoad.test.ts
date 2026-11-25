import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocketMessage } from "@shared/websocket";
import { DATA_DIR } from "@src/config";
import { closeDb, getDb, schema } from "@src/db";
import { eq } from "drizzle-orm";
import type { ExternalExtensionsApi } from "../types";
import type { RegistryInitDeps } from "./registry";
import { ExtensionRegistry } from "./registry";

afterAll(() => {
  closeDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/**
 * Creates a temporary directory with a minimal valid extension for testing.
 */
async function createTempExtension(
  baseDir: string,
  name: string,
  opts?: { dependencies?: string[]; withSkill?: boolean; withRoute?: boolean },
): Promise<string> {
  const extDir = join(baseDir, name);
  mkdirSync(extDir, { recursive: true });

  const manifest = {
    name,
    version: "1.0.0",
    description: `Test extension ${name}`,
    dependencies: opts?.dependencies ?? [],
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
    });${opts?.withRoute ? '\n    ctx.routes.register("GET", "ping", () => new Response("pong"));' : ""}
  },
  async shutdown() {},
};
`;

  await Bun.write(join(extDir, "index.ts"), code);

  if (opts?.withSkill) {
    const skillDir = join(extDir, "skills", "test-skill");
    mkdirSync(skillDir, { recursive: true });
    const skillContent = `---
name: ${name}-skill
description: A test skill
---
# Test skill content
`;
    await Bun.write(join(skillDir, "SKILL.md"), skillContent);
  }

  return extDir;
}

/**
 * Creates a minimal set of RegistryInitDeps fakes for testing.
 */
function createFakeDeps(): { deps: RegistryInitDeps; broadcasts: WebSocketMessage[]; routes: Set<string> } {
  const broadcasts: WebSocketMessage[] = [];
  // Currently mounted routes as "METHOD path" (mirrors the web server's extension router).
  const routes = new Set<string>();

  const deps: RegistryInitDeps = {
    routeRegistry: {
      registerRoute: (method, path) => {
        routes.add(`${method} ${path}`);
      },
      unregisterRoute: (method, path) => {
        routes.delete(`${method} ${path}`);
      },
    },
    broadcastFn: (msg: WebSocketMessage) => broadcasts.push(msg),
    onQueueCreated: () => {},
    database: {} as any,
    runAgentFn: async () => ({ answer: "", state: "completed" as const, timestamp: Date.now() }),
    sessionStore: {} as any,
  };

  return { deps, broadcasts, routes };
}

/**
 * Inserts an extension_settings row with enabled=true so the extension
 * is visible through getRegisteredTools/resolveSkill (non-core extensions
 * are disabled by default when no row exists).
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

/** Sets an extension's settings row to enabled=false, as the operator's toggle does. */
function disableExtension(name: string): void {
  getDb()
    .update(schema.extensionSettings)
    .set({ enabled: false, updatedAt: Date.now() })
    .where(eq(schema.extensionSettings.name, name))
    .run();
}

describe("ExtensionRegistry.loadOne", () => {
  let tempDir: string;
  let registry: ExtensionRegistry;
  let broadcasts: WebSocketMessage[];
  let routes: Set<string>;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });

    // Create a built-in extensions dir (empty) and external dir
    const builtinDir = join(tempDir, "builtin");
    const externalDir = join(tempDir, "external");
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });

    registry = new ExtensionRegistry({
      extensionDirs: [builtinDir, externalDir],
      workDir: join(tempDir, "work"),
      dataDir: join(tempDir, "data"),
    });

    const fakes = createFakeDeps();
    broadcasts = fakes.broadcasts;
    routes = fakes.routes;

    // Initialize with no extensions discovered (empty dirs)
    await registry.initializeAll(fakes.deps);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("valid extension loads successfully and returns true", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "test-ext");
    const modulePath = join(extDir, "index.ts");
    enableExtension("test-ext");

    const result = await registry.loadOne(modulePath);

    expect(result).toBe(true);

    // Tool should be registered
    const tools = registry.getRegisteredTools();
    expect(tools.some((t) => t.name === "test-ext_tool")).toBe(true);

    // Extension should appear in loaded info
    const info = registry.getLoadedExtensionInfo();
    expect(info.some((i) => i.name === "test-ext")).toBe(true);
  });

  test("an extension without a settings row loads suspended and is not initialized", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "new-ext", { withRoute: true });

    expect(await registry.loadOne(join(extDir, "index.ts"))).toBe(true);

    expect(registry.getLoadedExtensionInfo().find((i) => i.name === "new-ext")).toMatchObject({
      enabled: false,
      toolCount: 0,
      routeCount: 0,
    });
    expect(routes.has("GET /ext/new-ext/ping")).toBe(false);
  });

  test("reloading an extension the operator disabled keeps it suspended", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "off-ext", { withRoute: true });
    enableExtension("off-ext");
    await registry.loadOne(join(extDir, "index.ts"));
    expect(routes.has("GET /ext/off-ext/ping")).toBe(true);

    await registry.deactivate("off-ext");
    disableExtension("off-ext");
    await registry.unloadOne("off-ext");
    expect(await registry.loadOne(join(extDir, "index.ts"))).toBe(true);

    expect(registry.getLoadedExtensionInfo().find((i) => i.name === "off-ext")).toMatchObject({
      enabled: false,
      toolCount: 0,
      routeCount: 0,
    });
    expect(routes.has("GET /ext/off-ext/ping")).toBe(false);
  });

  test("exposes loaded extensions and load failures via ctx.internal.extensions", async () => {
    const externalDir = join(tempDir, "external");
    const probeDir = join(externalDir, "probe-ext");
    mkdirSync(probeDir, { recursive: true });
    await Bun.write(
      join(probeDir, "index.ts"),
      `export default {
  manifest: { name: "probe-ext", version: "1.0.0" },
  async initialize(ctx) { globalThis.__probeApi = ctx.internal.extensions; },
  async shutdown() {},
};`,
    );
    enableExtension("probe-ext");
    expect(await registry.loadOne(join(probeDir, "index.ts"))).toBe(true);
    const api = (globalThis as Record<string, unknown>).__probeApi as ExternalExtensionsApi;
    expect(api.externalDir).toBe(externalDir);
    expect(api.list().find((e) => e.name === "probe-ext")).toMatchObject({
      dir: probeDir,
      source: "external",
      state: "active",
      enabled: true,
    });

    const brokenDir = join(externalDir, "broken-ext");
    mkdirSync(brokenDir, { recursive: true });
    await Bun.write(join(brokenDir, "index.ts"), "export default { manifest: {} };");
    expect(await registry.loadOne(join(brokenDir, "index.ts"))).toBe(false);
    expect(api.lastLoadFailure(brokenDir)?.reason).toContain("Invalid extension module");

    await createTempExtension(externalDir, "broken-ext");
    expect(await registry.loadOne(join(brokenDir, "index.ts"))).toBe(true);
    expect(api.lastLoadFailure(brokenDir)).toBeNull();
  });

  test("broadcasts extension_lifecycle loaded event on success", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "broadcast-ext");
    const modulePath = join(extDir, "index.ts");

    await registry.loadOne(modulePath);

    const lifecycleEvent = broadcasts.find((b) => b.type === "extension_lifecycle" && (b as any).action === "loaded");
    expect(lifecycleEvent).not.toBeUndefined();
    expect((lifecycleEvent as any).name).toBe("broadcast-ext");
    expect((lifecycleEvent as any).version).toBe("1.0.0");
  });

  test("missing dependency returns false with no state change", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "dep-ext", {
      dependencies: ["nonexistent-dep"],
    });
    const modulePath = join(extDir, "index.ts");

    const result = await registry.loadOne(modulePath);

    expect(result).toBe(false);

    // No tools should be registered
    const tools = registry.getRegisteredTools();
    expect(tools.some((t) => t.name === "dep-ext_tool")).toBe(false);

    // No extension in loaded info
    const info = registry.getLoadedExtensionInfo();
    expect(info.some((i) => i.name === "dep-ext")).toBe(false);
  });

  test("duplicate name returns false", async () => {
    const extDir1 = await createTempExtension(join(tempDir, "external"), "dup-ext");
    await registry.loadOne(join(extDir1, "index.ts"));

    // Try to load again with same name from a different path
    const extDir2 = await createTempExtension(join(tempDir, "external2"), "dup-ext");
    const result = await registry.loadOne(join(extDir2, "index.ts"));

    expect(result).toBe(false);
  });

  test("discovers skills for newly loaded extension", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "skill-ext", { withSkill: true });
    const modulePath = join(extDir, "index.ts");

    await registry.loadOne(modulePath);
    enableExtension("skill-ext");

    const skill = registry.resolveSkill("skill-ext-skill");
    expect(skill).not.toBeUndefined();
    expect(skill?.extensionName).toBe("skill-ext");
  });
});

describe("ExtensionRegistry.unloadOne", () => {
  let tempDir: string;
  let registry: ExtensionRegistry;
  let broadcasts: WebSocketMessage[];
  let routes: Set<string>;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });

    const builtinDir = join(tempDir, "builtin");
    const externalDir = join(tempDir, "external");
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });

    registry = new ExtensionRegistry({
      extensionDirs: [builtinDir, externalDir],
      workDir: join(tempDir, "work"),
      dataDir: join(tempDir, "data"),
    });

    const fakes = createFakeDeps();
    broadcasts = fakes.broadcasts;
    routes = fakes.routes;
    await registry.initializeAll(fakes.deps);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("unloads extension, removes tools, and returns true", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "unload-ext");
    enableExtension("unload-ext");
    await registry.loadOne(join(extDir, "index.ts"));

    // Verify it's loaded
    expect(registry.getRegisteredTools().some((t) => t.name === "unload-ext_tool")).toBe(true);

    const result = await registry.unloadOne("unload-ext");

    expect(result).toBe(true);
    expect(registry.getRegisteredTools().some((t) => t.name === "unload-ext_tool")).toBe(false);
    expect(registry.getLoadedExtensionInfo().some((i) => i.name === "unload-ext")).toBe(false);
  });

  test("non-existent name returns false", async () => {
    const result = await registry.unloadOne("nonexistent");
    expect(result).toBe(false);
  });

  test("broadcasts extension_lifecycle unloaded event on success", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "bc-unload-ext");
    await registry.loadOne(join(extDir, "index.ts"));
    broadcasts.length = 0; // Clear the "loaded" broadcast

    await registry.unloadOne("bc-unload-ext");

    const lifecycleEvent = broadcasts.find((b) => b.type === "extension_lifecycle" && (b as any).action === "unloaded");
    expect(lifecycleEvent).not.toBeUndefined();
    expect((lifecycleEvent as any).name).toBe("bc-unload-ext");
  });

  test("removes skills on unload", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "skill-unload-ext", { withSkill: true });
    enableExtension("skill-unload-ext");
    await registry.loadOne(join(extDir, "index.ts"));

    // Verify skill exists
    expect(registry.resolveSkill("skill-unload-ext-skill")).not.toBeUndefined();

    await registry.unloadOne("skill-unload-ext");

    // Skill should be gone
    expect(registry.resolveSkill("skill-unload-ext-skill")).toBeUndefined();
  });

  test("unregisters the extension's routes", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "route-ext", { withRoute: true });
    enableExtension("route-ext");
    await registry.loadOne(join(extDir, "index.ts"));
    expect(routes.has("GET /ext/route-ext/ping")).toBe(true);

    await registry.unloadOne("route-ext");

    expect(routes.has("GET /ext/route-ext/ping")).toBe(false);
  });

  test("re-loading after unload registers the routes again", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "reload-ext", { withRoute: true });
    enableExtension("reload-ext");
    await registry.loadOne(join(extDir, "index.ts"));
    await registry.unloadOne("reload-ext");
    expect(routes.has("GET /ext/reload-ext/ping")).toBe(false);

    // Re-load
    await registry.loadOne(join(extDir, "index.ts"));

    expect(routes.has("GET /ext/reload-ext/ping")).toBe(true);
  });
});

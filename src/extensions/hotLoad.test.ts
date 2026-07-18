import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocketMessage } from "@shared/types";
import { DATA_DIR } from "@src/config";
import { closeDb, getDb, schema } from "@src/db";
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
  opts?: { dependencies?: string[]; withSkill?: boolean },
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

describe("ExtensionRegistry.loadOne", () => {
  let tempDir: string;
  let registry: ExtensionRegistry;
  let broadcasts: WebSocketMessage[];

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

    // Initialize with no extensions discovered (empty dirs)
    await registry.initializeAll(fakes.deps);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("valid extension loads successfully and returns true", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "test-ext");
    const modulePath = join(extDir, "index.ts");

    const result = await registry.loadOne(modulePath);

    expect(result).toBe(true);

    // Enable the extension so it appears in tool/info queries
    enableExtension("test-ext");

    // Tool should be registered
    const tools = registry.getRegisteredTools();
    expect(tools.some((t) => t.name === "test-ext_tool")).toBe(true);

    // Extension should appear in loaded info
    const info = registry.getLoadedExtensionInfo();
    expect(info.some((i) => i.name === "test-ext")).toBe(true);
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
    await registry.initializeAll(fakes.deps);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("unloads extension, removes tools, and returns true", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "unload-ext");
    await registry.loadOne(join(extDir, "index.ts"));
    enableExtension("unload-ext");

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
    await registry.loadOne(join(extDir, "index.ts"));
    enableExtension("skill-unload-ext");

    // Verify skill exists
    expect(registry.resolveSkill("skill-unload-ext-skill")).not.toBeUndefined();

    await registry.unloadOne("skill-unload-ext");

    // Skill should be gone
    expect(registry.resolveSkill("skill-unload-ext-skill")).toBeUndefined();
  });

  test("adds route prefix to disabled set", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "route-ext");
    await registry.loadOne(join(extDir, "index.ts"));

    await registry.unloadOne("route-ext");

    const disabled = registry.getDisabledRoutePrefixes();
    expect(disabled.has("/ext/route-ext")).toBe(true);
  });

  test("re-loading after unload clears disabled prefix", async () => {
    const extDir = await createTempExtension(join(tempDir, "external"), "reload-ext");
    await registry.loadOne(join(extDir, "index.ts"));
    await registry.unloadOne("reload-ext");

    expect(registry.getDisabledRoutePrefixes().has("/ext/reload-ext")).toBe(true);

    // Re-load
    await registry.loadOne(join(extDir, "index.ts"));

    expect(registry.getDisabledRoutePrefixes().has("/ext/reload-ext")).toBe(false);
  });
});

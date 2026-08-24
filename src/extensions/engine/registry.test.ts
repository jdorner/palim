/**
 * Tests for registry serialization of step-type output schemas.
 *
 * Exercises the `ui.stepTypes` builder in `getLoadedExtensionInfo()`:
 * a handler that declares an `outputSchema` yields a serialized, distinct
 * `StepTypeInfo.outputSchema`; a handler that omits it leaves the field
 * `undefined`.
 *
 * Validates: Requirements 3.1, 3.2
 */

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
 * Writes a temporary extension that registers two custom step types:
 *  - `with-output`: declares a TypeBox `outputSchema`.
 *  - `without-output`: omits `outputSchema` entirely.
 *
 * @param baseDir - The directory the extension folder is created under
 * @param name - The extension (and folder) name
 * @returns The absolute path to the created extension directory
 */
async function createStepTypeExtension(baseDir: string, name: string): Promise<string> {
  const extDir = join(baseDir, name);
  mkdirSync(extDir, { recursive: true });

  const manifest = {
    name,
    version: "1.0.0",
    description: `Test extension ${name}`,
    dependencies: [],
  };

  // The fixture is written to a temp directory outside the project tree, so it
  // cannot resolve `@sinclair/typebox`. TypeBox schemas are plain JSON-serializable
  // objects, and the registry only JSON round-trips `handler.outputSchema`, so we
  // declare the already-serialized JSON Schema shapes directly. This exercises the
  // identical serialization path in `getLoadedExtensionInfo`.
  const withOutputConfig = { type: "object", properties: { url: { type: "string" } }, required: ["url"] };
  const withOutputSchema = {
    type: "object",
    properties: {
      status: { type: "number", description: "HTTP status code of the response." },
      body: { description: "Response body." },
    },
    required: ["status", "body"],
  };
  const withoutOutputConfig = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };

  const code = `
export default {
  manifest: ${JSON.stringify(manifest)},
  async initialize(ctx) {
    ctx.stepTypes.register("with-output", {
      schema: ${JSON.stringify(withOutputConfig)},
      label: "With Output",
      outputSchema: ${JSON.stringify(withOutputSchema)},
      execute: async () => ({ status: 200, body: "ok" }),
    });
    ctx.stepTypes.register("without-output", {
      schema: ${JSON.stringify(withoutOutputConfig)},
      label: "Without Output",
      execute: async () => ({ done: true }),
    });
  },
  async shutdown() {},
};
`;

  await Bun.write(join(extDir, "index.ts"), code);
  return extDir;
}

/**
 * Builds a minimal set of {@link RegistryInitDeps} fakes for booting a registry
 * in tests without a live web server, queue system, or agent runtime.
 */
function createFakeDeps(): RegistryInitDeps {
  return {
    routeRegistry: {
      registerRoute: () => {},
    },
    broadcastFn: (_msg: WebSocketMessage) => {},
    onQueueCreated: () => {},
    database: {} as never,
    runAgentFn: async () => ({ answer: "", state: "completed" as const, timestamp: Date.now() }),
    sessionStore: {} as never,
  };
}

/** Marks an extension as enabled in the DB so it initializes at boot. */
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

/**
 * Reads the serialized step types surfaced through {@link ExtensionRegistry.getLoadedExtensionInfo}
 * for a given extension.
 *
 * @param registry - The initialized registry
 * @param extensionName - The extension whose step types to read
 * @returns The step type UI info entries, keyed by step type name
 */
function stepTypesByType(
  registry: ExtensionRegistry,
  extensionName: string,
): Map<string, { configSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> }> {
  const info = registry.getLoadedExtensionInfo();
  const ext = info.find((e) => e.name === extensionName);
  const stepTypes = ext?.ui?.stepTypes ?? [];
  return new Map(stepTypes.map((st) => [st.type, st]));
}

describe("ExtensionRegistry.getLoadedExtensionInfo (step-type outputSchema serialization)", () => {
  let registry: ExtensionRegistry;

  beforeEach(async () => {
    const tempDir = join(tmpdir(), `registry-serialization-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirsToClean.push(tempDir);
    const builtinDir = join(tempDir, "builtin");
    mkdirSync(builtinDir, { recursive: true });

    await createStepTypeExtension(builtinDir, "step-types-ext");
    enableExtension("step-types-ext");

    registry = new ExtensionRegistry({
      extensionDirs: [builtinDir],
      workDir: join(tempDir, "work"),
      dataDir: join(tempDir, "data"),
    });

    await registry.initializeAll(createFakeDeps());
  });

  test("a handler declaring an outputSchema yields a serialized StepTypeInfo.outputSchema", () => {
    const byType = stepTypesByType(registry, "step-types-ext");
    const withOutput = byType.get("with-output");

    expect(withOutput).toBeDefined();
    expect(withOutput!.outputSchema).toBeDefined();
    // Serialized to canonical JSON Schema via a JSON round-trip.
    expect(withOutput!.outputSchema).toEqual({
      type: "object",
      properties: {
        status: { type: "number", description: "HTTP status code of the response." },
        body: { description: "Response body." },
      },
      required: ["status", "body"],
    });
  });

  test("a handler omitting outputSchema leaves StepTypeInfo.outputSchema undefined", () => {
    const byType = stepTypesByType(registry, "step-types-ext");
    const withoutOutput = byType.get("without-output");

    expect(withoutOutput).toBeDefined();
    expect(withoutOutput!.outputSchema).toBeUndefined();
  });

  test("outputSchema is distinct from configSchema", () => {
    const byType = stepTypesByType(registry, "step-types-ext");
    const withOutput = byType.get("with-output");

    expect(withOutput).toBeDefined();
    expect(withOutput!.configSchema).toBeDefined();
    expect(withOutput!.outputSchema).toBeDefined();
    // The output schema is a separate field describing the result, not the config inputs.
    expect(withOutput!.outputSchema).not.toBe(withOutput!.configSchema);
    expect(withOutput!.outputSchema).not.toEqual(withOutput!.configSchema);
  });
});

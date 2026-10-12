/**
 * Tests for runtime extension warnings (`ctx.status.setWarnings()`):
 * surfaced through `getLoadedExtensionInfo()`, broadcast as
 * `extension_schemas_changed` only on change, and cleared on deactivation.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocketMessage } from "@shared/websocket";
import { DATA_DIR } from "@src/config";
import { closeDb, getDb, schema } from "@src/db";
import type { ExtensionContext } from "../types";
import type { RegistryInitDeps } from "./registry";
import { ExtensionRegistry } from "./registry";

const EXT_NAME = "warnings-ext";

/** Global slot the fixture extension stores its context in, so tests can drive it. */
const CTX_SLOT = "__warningsExtCtx";

const tempDirsToClean: string[] = [];

afterAll(() => {
  closeDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  for (const dir of tempDirsToClean) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes a fixture extension that reports a warning during initialize and exposes its context. */
async function createWarningsExtension(baseDir: string): Promise<void> {
  const extDir = join(baseDir, EXT_NAME);
  mkdirSync(extDir, { recursive: true });
  const manifest = { name: EXT_NAME, version: "1.0.0", description: "Warnings fixture", dependencies: [] };
  await Bun.write(
    join(extDir, "index.ts"),
    `
export default {
  manifest: ${JSON.stringify(manifest)},
  async initialize(ctx) {
    globalThis.${CTX_SLOT} = ctx;
    ctx.status.setWarnings(["Configured workflow is missing"]);
  },
  async shutdown() {},
};
`,
  );
}

/** Marks the fixture extension as enabled so it initializes at boot. */
function enableExtension(name: string): void {
  getDb()
    .insert(schema.extensionSettings)
    .values({ name, enabled: true, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: schema.extensionSettings.name, set: { enabled: true, updatedAt: Date.now() } })
    .run();
}

describe("extension runtime warnings", () => {
  let registry: ExtensionRegistry;
  let messages: WebSocketMessage[];

  /** The fixture extension's live context. */
  const ctx = () => (globalThis as unknown as Record<string, ExtensionContext>)[CTX_SLOT]!;
  /** The fixture extension's currently reported warnings. */
  const warnings = () => registry.getLoadedExtensionInfo().find((e) => e.name === EXT_NAME)?.warnings;
  /** Schema-change broadcasts for the fixture extension. */
  const changes = () => messages.filter((m) => m.type === "extension_schemas_changed");

  beforeEach(async () => {
    const tempDir = join(tmpdir(), `registry-warnings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirsToClean.push(tempDir);
    const builtinDir = join(tempDir, "builtin");
    mkdirSync(builtinDir, { recursive: true });
    await createWarningsExtension(builtinDir);
    enableExtension(EXT_NAME);

    messages = [];
    const deps: RegistryInitDeps = {
      routeRegistry: { registerRoute: () => {}, unregisterRoute: () => {} },
      broadcastFn: (msg) => messages.push(msg),
      onQueueCreated: () => {},
      database: {} as never,
      runAgentFn: async () => ({ answer: "", state: "completed" as const, timestamp: Date.now() }),
      sessionStore: {} as never,
    };
    registry = new ExtensionRegistry({
      extensionDirs: [builtinDir],
      workDir: join(tempDir, "work"),
      dataDir: join(tempDir, "data"),
    });
    await registry.initializeAll(deps);
  });

  test("warnings reported during initialize are listed", () => {
    expect(warnings()).toEqual(["Configured workflow is missing"]);
  });

  test("changes are broadcast, unchanged warnings are not", () => {
    const before = changes().length;
    ctx().status.setWarnings(["Configured workflow is missing"]);
    expect(changes().length).toBe(before);

    ctx().status.setWarnings([]);
    expect(warnings()).toEqual([]);
    expect(changes().length).toBe(before + 1);
    expect(changes().at(-1)).toEqual({ type: "extension_schemas_changed", name: EXT_NAME });
  });

  test("deactivation clears warnings", async () => {
    await registry.deactivate(EXT_NAME);
    expect(warnings()).toEqual([]);
  });
});

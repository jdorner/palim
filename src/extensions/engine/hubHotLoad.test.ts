/**
 * End-to-end: hub installs and removals picked up by the real directory
 * watcher and extension registry.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExternalExtensionsApi } from "@ext/types";
import { DATA_DIR } from "@src/config";
import { closeDb } from "@src/db";
import { createTestDb } from "@src/test/db";
import createLogger from "logging";
import { HubService } from "../extension-hub/hub";
import { HubStore } from "../extension-hub/store";
import { ExtensionWatcher } from "./extensionWatcher";
import { ExtensionRegistry } from "./registry";

let root: string;
let registry: ExtensionRegistry;
let watcher: ExtensionWatcher;
let api: ExternalExtensionsApi;
let hub: HubService;
let sourceId: string;

/** Runs git synchronously. */
function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "palim-hub-watcher-"));
  const repo = path.join(root, "source");
  const ext = path.join(repo, "greeter");
  mkdirSync(ext, { recursive: true });
  await writeFile(path.join(ext, "package.json"), JSON.stringify({ name: "greeter", version: "1.0.0" }));
  // Manifest version taken from package.json, as recommended for hub extensions.
  await writeFile(
    path.join(ext, "index.ts"),
    `import pkg from "./package.json";
export default {
  manifest: { name: pkg.name, version: pkg.version },
  async initialize() {},
  async shutdown() {},
};
`,
  );
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "greeter");
  git(repo, "tag", "greeter@1.0.0");

  const builtinDir = path.join(root, "builtin");
  const externalDir = path.join(root, "external");
  mkdirSync(builtinDir);
  mkdirSync(externalDir);
  const probe = path.join(builtinDir, "probe");
  mkdirSync(probe);
  await writeFile(
    path.join(probe, "index.ts"),
    `export default {
  manifest: { name: "probe", version: "1.0.0", core: true },
  async initialize(ctx) { globalThis.__hubProbeApi = ctx.internal.extensions; },
  async shutdown() {},
};
`,
  );

  registry = new ExtensionRegistry({
    extensionDirs: [builtinDir, externalDir],
    workDir: path.join(root, "work"),
    dataDir: path.join(root, "data"),
  });
  await registry.initializeAll({
    routeRegistry: { registerRoute: () => {}, unregisterRoute: () => {} },
    broadcastFn: () => {},
    onQueueCreated: () => {},
    database: {} as never,
    runAgentFn: async () => ({ answer: "", state: "completed" as const, timestamp: Date.now() }),
    sessionStore: {} as never,
  });
  api = (globalThis as Record<string, unknown>).__hubProbeApi as ExternalExtensionsApi;
  expect(api.externalDir).toBe(externalDir);

  watcher = new ExtensionWatcher({ directory: externalDir, registry, debounceMs: 50 });
  await watcher.start();

  hub = new HubService({
    store: new HubStore(createTestDb()),
    extensions: api,
    workRoot: path.join(root, "hub"),
    log: createLogger("hub-watcher-test"),
    getToken: async () => null,
    setToken: async () => {},
    includePrereleases: () => false,
    loadWait: { timeoutMs: 20_000, pollMs: 50 },
    unloadWait: { timeoutMs: 10_000, pollMs: 50 },
  });
  const created = await hub.createSource({ name: "Local", url: repo });
  expect(created.error).toBeNull();
  sourceId = created.source.id;
});

afterAll(async () => {
  await watcher?.stop();
  await registry?.shutdownAll();
  closeDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("hub with the real watcher", () => {
  test("installs, loads, uninstalls, and unloads", async () => {
    const result = await hub.install({ sourceId, name: "greeter", userId: null });
    expect(result.outcome).toEqual({ status: "loaded", version: "1.0.0" });
    expect(result.warnings).toEqual([]);
    expect(api.list().find((e) => e.name === "greeter")?.state).toBe("active");

    const view = await hub.catalog();
    expect(view.sources[0]!.extensions[0]!.installed?.loaded).toMatchObject({ version: "1.0.0", state: "active" });

    expect(await hub.uninstall("greeter")).toEqual({ unloaded: true });
    expect(api.list().some((e) => e.name === "greeter")).toBe(false);
    expect(existsSync(path.join(api.externalDir, "greeter"))).toBe(false);
  }, 30_000);
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExternalExtensionsApi, ExternalFolderStatus, LoadedExtensionStatus } from "@ext/types";
import { createTestDb } from "@src/test/db";
import createLogger from "logging";
import { HubError } from "./errors";
import { HubService, WATCH_MODE_WARNING } from "./hub";
import { hashTree, loadOutcome, SOURCE_MARKER, treeFingerprint } from "./installer";
import { assertContainedLinks } from "./sources";
import { HubStore } from "./store";

let root: string;
let repoDir: string;

/** Runs git synchronously in a directory. */
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** Writes an extension folder into the source working tree. */
async function writeExtension(name: string, pkg: Record<string, unknown> | null, extra: Record<string, string> = {}) {
  const dir = path.join(repoDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.ts"), `export default {};\n`);
  if (pkg) await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [file, content] of Object.entries(extra)) await writeFile(path.join(dir, file), content);
}

/** Commits everything in the source working tree. */
function commit(message: string): string {
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", message);
  return git(repoDir, "rev-parse", "HEAD");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "palim-extension-hub-"));
  repoDir = path.join(root, "source");
  await mkdir(repoDir);
  git(repoDir, "init", "-q", "-b", "main");

  await writeExtension("foo", { name: "foo", version: "1.0.0", description: "Foo extension" });
  await writeExtension("bar", null);
  await writeExtension("baz", { name: "baz", version: "0.2.0" });
  await mkdir(path.join(repoDir, "docs"));
  await writeFile(path.join(repoDir, "docs", "README.md"), "docs");
  commit("initial");
  git(repoDir, "tag", "foo@1.0.0");
  git(repoDir, "tag", "baz@0.1.0"); // package.json says 0.2.0

  await writeExtension("foo", { name: "foo", version: "1.1.0", description: "Foo extension" });
  commit("foo 1.1.0");
  git(repoDir, "tag", "-a", "foo@1.1.0", "-m", "release");

  await writeExtension("foo", { name: "foo", version: "2.0.0-rc.1" });
  commit("foo 2.0.0-rc.1");
  git(repoDir, "tag", "foo@2.0.0-rc.1");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Test fixture: a hub over a fresh database and directories, with a fake registry. */
interface Fixture {
  hub: HubService;
  store: HubStore;
  externalDir: string;
  failing: Set<string>;
  stuck: Set<string>;
  hanging: Set<string>;
  manifestVersion: { value: string | null };
  includePrereleases: { value: boolean };
  tokens: Map<string, string>;
}

/**
 * The fake registry reports every folder with an index.ts as loaded at once
 * (the directory watcher's job), with its package.json version (or
 * `manifestVersion` when set), except folders listed in `failing` as `name`
 * or `name@version`. Folders in `stuck` stay loaded after they were moved
 * away; loads of folders in `hanging` (`name` or `name@version`) never finish.
 */
async function createFixture(options: { watchMode?: boolean } = {}): Promise<Fixture> {
  const base = await mkdtemp(path.join(root, "case-"));
  const externalDir = path.join(base, "extensions");
  await mkdir(externalDir);
  const failing = new Set<string>();
  const stuck = new Set<string>();
  const hanging = new Set<string>();
  const manifestVersion: { value: string | null } = { value: null };
  const pkgVersion = (f: string): string => {
    try {
      return JSON.parse(readFileSync(path.join(externalDir, f, "package.json"), "utf8")).version;
    } catch {
      return "0.0.0";
    }
  };
  const matches = (set: Set<string>, f: string) => set.has(f) || set.has(`${f}@${pkgVersion(f)}`);
  const fails = (f: string) => matches(failing, f);
  const loaded = (): LoadedExtensionStatus[] =>
    readdirSync(externalDir)
      .filter((f) => existsSync(path.join(externalDir, f, "index.ts")) && !fails(f))
      .map((f) => ({
        name: f,
        version: manifestVersion.value ?? pkgVersion(f),
        source: "external",
        dir: path.join(externalDir, f),
        state: "active",
        enabled: false,
        error: null,
      }));
  const api: ExternalExtensionsApi = {
    externalDir,
    list: loaded,
    sync: (f) => {
      if (!existsSync(path.join(externalDir, f, "index.ts"))) {
        const status: ExternalFolderStatus = stuck.has(f)
          ? { status: "active", name: f, version: "0.0.0" }
          : { status: "unloaded" };
        return Promise.resolve(status);
      }
      if (matches(hanging, f)) return new Promise(() => {});
      if (fails(f)) return Promise.resolve({ status: "failed", error: "boom" });
      return Promise.resolve({ status: "active", name: f, version: manifestVersion.value ?? pkgVersion(f) });
    },
    lastLoadFailure: (dir) =>
      existsSync(dir) && fails(path.basename(dir)) ? { reason: "boom", at: Date.now() } : null,
  };
  const store = new HubStore(createTestDb());
  const tokens = new Map<string, string>();
  const includePrereleases = { value: false };
  const hub = new HubService({
    store,
    extensions: api,
    workRoot: path.join(base, "hub"),
    log: createLogger("hub-test"),
    getToken: async (id) => tokens.get(id) ?? null,
    setToken: async (id, token) => {
      if (token) tokens.set(id, token);
      else tokens.delete(id);
    },
    includePrereleases: () => includePrereleases.value,
    loadWait: { timeoutMs: 200 },
    unloadWait: { timeoutMs: 200 },
    watchMode: options.watchMode,
  });
  return { hub, store, externalDir, failing, stuck, hanging, manifestVersion, includePrereleases, tokens };
}

/** Asserts that a promise rejects with a HubError of the given status. */
async function expectHubError(promise: Promise<unknown>, status: number): Promise<HubError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HubError);
    expect((err as HubError).status).toBe(status);
    return err as HubError;
  }
  throw new Error(`expected HubError ${status}`);
}

describe("HubService", () => {
  let f: Fixture;
  let sourceId: string;

  beforeEach(async () => {
    f = await createFixture();
    const { source, error } = await f.hub.createSource({ name: "Test", url: repoDir });
    expect(error).toBeNull();
    sourceId = source.id;
  });

  test("lists extensions with releases, newest first, and hides prereleases by default", async () => {
    const view = await f.hub.catalog();
    const entries = view.sources[0]!.extensions;
    expect(entries.map((e) => e.name)).toEqual(["bar", "baz", "foo"]);

    const foo = entries.find((e) => e.name === "foo")!;
    expect(foo.releases.map((r) => r.version)).toEqual(["2.0.0-rc.1", "1.1.0", "1.0.0"]);
    expect(foo.latest?.version).toBe("1.1.0");
    expect(foo.description).toBe("Foo extension");
    expect(foo.head).toMatchObject({ branch: "main", version: "2.0.0-rc.1", installable: true });

    const bar = entries.find((e) => e.name === "bar")!;
    expect(bar.head).toMatchObject({ installable: false, problem: "package.json is missing" });

    const baz = entries.find((e) => e.name === "baz")!;
    expect(baz.releases[0]).toMatchObject({ version: "0.1.0", installable: true });
    expect(baz.releases[0]!.problem).toContain("differs from the tag");

    f.includePrereleases.value = true;
    expect((await f.hub.catalog()).sources[0]!.extensions.find((e) => e.name === "foo")!.latest?.version).toBe(
      "2.0.0-rc.1",
    );
  });

  test("installs the newest release by default", async () => {
    f.manifestVersion.value = "9.9.9";
    const result = await f.hub.install({ sourceId, name: "foo", userId: "u1" });
    expect(result.install).toMatchObject({ ref: "foo@1.1.0", refKind: "tag", version: "1.1.0", installedBy: "u1" });
    expect(result.outcome.status).toBe("loaded");
    expect(result.warnings[0]).toContain("differs from package.json version 1.1.0");

    const dir = path.join(f.externalDir, "foo");
    expect(JSON.parse(await Bun.file(path.join(dir, "package.json")).text()).version).toBe("1.1.0");
    expect(JSON.parse(await Bun.file(path.join(dir, SOURCE_MARKER)).text())).toMatchObject({ ref: "foo@1.1.0" });
    expect(f.store.getInstall("foo")?.contentHash).toBe(await hashTree(dir));
  });

  test("installs a version, a branch, or a commit", async () => {
    await f.hub.install({ sourceId, name: "foo", version: "1.0.0", userId: null });
    expect(f.store.getInstall("foo")).toMatchObject({ refKind: "tag", version: "1.0.0" });
    await f.hub.uninstall("foo");

    await f.hub.install({ sourceId, name: "foo", ref: "main", userId: null });
    expect(f.store.getInstall("foo")).toMatchObject({ refKind: "branch", ref: "main", version: "2.0.0-rc.1" });
    await f.hub.uninstall("foo");

    const sha = git(repoDir, "rev-parse", "foo@1.0.0^{commit}");
    await f.hub.install({ sourceId, name: "foo", ref: sha.slice(0, 12), userId: null });
    expect(f.store.getInstall("foo")).toMatchObject({ refKind: "commit", ref: sha, commit: sha, version: "1.0.0" });
  });

  test("reports updates for tag installs", async () => {
    await f.hub.install({ sourceId, name: "foo", version: "1.0.0", userId: null });
    const view = await f.hub.catalog();
    const foo = view.sources[0]!.extensions.find((e) => e.name === "foo")!;
    expect(foo.installed?.version).toBe("1.0.0");
    expect(foo.update).toMatchObject({ ref: "foo@1.1.0", version: "1.1.0" });
    expect(view.updateCount).toBe(1);
  });

  test("reports updates for branch installs after a fetch", async () => {
    await f.hub.install({ sourceId, name: "foo", ref: "main", userId: null });
    expect((await f.hub.catalog()).updateCount).toBe(0);

    await writeFile(path.join(repoDir, "foo", "extra.ts"), "export {};\n");
    const head = commit("foo extra");
    await f.hub.refreshSource(sourceId);
    const foo = (await f.hub.catalog()).sources[0]!.extensions.find((e) => e.name === "foo")!;
    expect(foo.update).toEqual({ ref: "main", commit: head, version: "2.0.0-rc.1" });
  });

  test("refuses conflicts and uninstallable trees", async () => {
    await mkdir(path.join(f.externalDir, "foo"));
    await writeFile(path.join(f.externalDir, "foo", "index.ts"), "export default {};\n");
    await expectHubError(f.hub.install({ sourceId, name: "foo", userId: null }), 409);
    const foo = (await f.hub.catalog()).sources[0]!.extensions.find((e) => e.name === "foo")!;
    expect(foo).toMatchObject({ blockedByLocal: true, installed: null });
    await expectHubError(f.hub.uninstall("foo"), 404);

    await expectHubError(f.hub.install({ sourceId, name: "bar", ref: "main", userId: null }), 422);
    await expectHubError(f.hub.install({ sourceId, name: "baz", version: "9.9.9", userId: null }), 404);
    await expectHubError(f.hub.install({ sourceId, name: "../etc", userId: null }), 400);
    await expectHubError(f.hub.install({ sourceId, name: "baz", ref: "-x", userId: null }), 400);
    expect(readdirSync(f.externalDir)).toEqual(["foo"]);
  });

  test("refuses a second install of the same extension", async () => {
    await f.hub.install({ sourceId, name: "baz", userId: null });
    await expectHubError(f.hub.install({ sourceId, name: "baz", userId: null }), 409);
  });

  test("removes a fresh install that fails to load", async () => {
    f.failing.add("foo");
    const err = await expectHubError(f.hub.install({ sourceId, name: "foo", userId: null }), 422);
    expect(err.message).toContain("boom");
    expect(existsSync(path.join(f.externalDir, "foo"))).toBe(false);
    expect(f.store.getInstall("foo")).toBeUndefined();
  });

  test("uninstalls and keeps local folders", async () => {
    await mkdir(path.join(f.externalDir, "mine"));
    await writeFile(path.join(f.externalDir, "mine", "index.ts"), "export default {};\n");
    await f.hub.install({ sourceId, name: "foo", userId: null });

    await f.hub.uninstall("foo");
    expect(existsSync(path.join(f.externalDir, "foo"))).toBe(false);
    expect(f.store.getInstall("foo")).toBeUndefined();
    expect(readdirSync(f.externalDir)).toEqual(["mine"]);
  });

  test("keeps files and install record when the uninstalled extension does not unload", async () => {
    await f.hub.install({ sourceId, name: "foo", userId: null });
    f.stuck.add("foo");

    const err = await expectHubError(f.hub.uninstall("foo"), 500);
    expect(err.message).toContain("could not be unloaded");
    expect(existsSync(path.join(f.externalDir, "foo", "index.ts"))).toBe(true);
    expect(f.store.getInstall("foo")).toBeDefined();
  });

  test("keeps a source whose fetch fails and refuses deleting a used source", async () => {
    const { source, error } = await f.hub.createSource({ name: "Broken", url: path.join(root, "missing.git") });
    expect(error).toContain("git clone failed");
    expect(f.store.getSource(source.id)?.lastError).toContain("git clone failed");
    await f.hub.deleteSource(source.id);

    await f.hub.install({ sourceId, name: "foo", userId: null });
    await expectHubError(f.hub.deleteSource(sourceId), 409);
    await expectHubError(f.hub.createSource({ name: "Test", url: repoDir }), 409);
  });

  test("requires re-entering a stored token when the source moves to another host", async () => {
    f.tokens.set(sourceId, "secret");
    await expectHubError(f.hub.updateSource(sourceId, { url: "https://git.invalid/ext.git" }), 400);
    expect(f.store.getSource(sourceId)?.url).toBe(repoDir);

    // Clearing the token explicitly is fine.
    await f.hub.updateSource(sourceId, { url: "https://git.invalid/ext.git", token: null });
    expect(f.tokens.has(sourceId)).toBe(false);
  });

  test("refuses access tokens on non-HTTPS sources", async () => {
    await expectHubError(
      f.hub.createSource({ name: "Local", url: path.join(root, "other.git"), token: "secret" }),
      400,
    );
    expect(f.store.listSources().some((s) => s.name === "Local")).toBe(false);
    await expectHubError(f.hub.updateSource(sourceId, { token: "secret" }), 400);
    expect(f.tokens.has(sourceId)).toBe(false);

    // A token stored before the rule (e.g. on an old http:// row) is not sent.
    f.tokens.set(sourceId, "secret");
    await expectHubError(f.hub.updateSource(sourceId, { url: path.join(root, "other.git") }), 400);
  });
});

describe("HubService updates", () => {
  let f: Fixture;
  let sourceId: string;

  beforeEach(async () => {
    f = await createFixture();
    sourceId = (await f.hub.createSource({ name: "Test", url: repoDir })).source.id;
    await f.hub.install({ sourceId, name: "foo", version: "1.0.0", userId: null });
  });

  const installedVersion = async () =>
    JSON.parse(await Bun.file(path.join(f.externalDir, "foo", "package.json")).text()).version as string;
  /** Where an update parks the old tree (fixture workRoot is next to the extensions directory). */
  const backupDir = () => path.join(path.dirname(f.externalDir), "hub", "backup", "foo");

  test("updates to the available version and drops the old tree once loaded", async () => {
    expect(f.hub.updates()).toEqual([
      expect.objectContaining({
        name: "foo",
        installedVersion: "1.0.0",
        update: expect.objectContaining({ version: "1.1.0" }),
      }),
    ]);

    const result = await f.hub.update({ name: "foo", userId: "u2" });
    expect(result).toMatchObject({ from: "1.0.0", outcome: { status: "loaded", version: "1.1.0" }, warnings: [] });
    expect(result.install).toMatchObject({ ref: "foo@1.1.0", version: "1.1.0", installedBy: "u2" });
    expect(await installedVersion()).toBe("1.1.0");
    expect(existsSync(backupDir())).toBe(false);
    expect(f.hub.updates()).toEqual([]);

    const foo = (await f.hub.catalog()).sources[0]!.extensions.find((e) => e.name === "foo")!;
    expect(foo.installed).toMatchObject({ version: "1.1.0", modified: false });

    await expectHubError(f.hub.update({ name: "foo", userId: null }), 409); // up to date
  });

  test("updates to an explicit version or ref, including downgrades", async () => {
    f.includePrereleases.value = true;
    await f.hub.update({ name: "foo", version: "2.0.0-rc.1", userId: null });
    expect(await installedVersion()).toBe("2.0.0-rc.1");
    await f.hub.update({ name: "foo", ref: "foo@1.0.0", userId: null });
    expect(f.store.getInstall("foo")).toMatchObject({ version: "1.0.0", refKind: "tag" });
    await f.hub.update({ name: "foo", ref: "main", userId: null });
    expect(f.store.getInstall("foo")).toMatchObject({ refKind: "branch", ref: "main" });
  });

  test("refuses to overwrite local changes unless forced", async () => {
    await writeFile(path.join(f.externalDir, "foo", "index.ts"), "// patched\n");
    expect((await f.hub.catalog()).sources[0]!.extensions.find((e) => e.name === "foo")!.installed?.modified).toBe(
      true,
    );
    const err = await expectHubError(f.hub.update({ name: "foo", userId: null }), 409);
    expect(err.details).toEqual({ modified: true });

    await f.hub.update({ name: "foo", force: true, userId: null });
    expect(await installedVersion()).toBe("1.1.0");
    expect(await Bun.file(path.join(f.externalDir, "foo", "index.ts")).text()).not.toBe("// patched\n");
    expect((await f.hub.catalog()).sources[0]!.extensions.find((e) => e.name === "foo")!.installed?.modified).toBe(
      false,
    );
  });

  test("restores the previous version when the update fails to load", async () => {
    f.failing.add("foo@1.1.0");
    const err = await expectHubError(f.hub.update({ name: "foo", userId: null }), 422);
    expect(err.message).toContain("restored 1.0.0");
    expect(await installedVersion()).toBe("1.0.0");
    expect(f.store.getInstall("foo")).toMatchObject({ version: "1.0.0", ref: "foo@1.0.0" });
    expect(f.store.getInstall("foo")?.contentHash).toBe(await hashTree(path.join(f.externalDir, "foo")));
    expect(existsSync(backupDir())).toBe(false);
    expect(f.hub.updates().map((u) => u.name)).toEqual(["foo"]);
  });

  test("restores the previous version when the update does not load in time", async () => {
    f.hanging.add("foo@1.1.0");
    const err = await expectHubError(f.hub.update({ name: "foo", userId: null }), 422);
    expect(err.message).toContain("timed out");
    expect(err.message).toContain("restored 1.0.0");
    expect(await installedVersion()).toBe("1.0.0");
    expect(f.store.getInstall("foo")).toMatchObject({ version: "1.0.0", ref: "foo@1.0.0" });
    expect(existsSync(backupDir())).toBe(false);
  });

  test("reports a failed rollback distinctly when the restored version does not load either", async () => {
    f.failing.add("foo@1.1.0");
    f.failing.add("foo@1.0.0");
    const err = await expectHubError(f.hub.update({ name: "foo", userId: null }), 500);
    expect(err.message).toContain("rollback to 1.0.0 failed to load too");
    expect(err.message).not.toContain("restored 1.0.0");
    expect(err.details).toEqual({ rollbackFailed: true, restoreError: "boom" });
    expect(await installedVersion()).toBe("1.0.0");
    expect(f.store.getInstall("foo")).toMatchObject({ version: "1.0.0", ref: "foo@1.0.0" });
    expect(existsSync(backupDir())).toBe(false);
  });

  test("aborts the update without replacing anything when the old version does not unload", async () => {
    f.stuck.add("foo");
    const err = await expectHubError(f.hub.update({ name: "foo", userId: null }), 500);
    expect(err.message).toContain("could not be unloaded");
    expect(await installedVersion()).toBe("1.0.0");
    expect(f.store.getInstall("foo")).toMatchObject({ version: "1.0.0", ref: "foo@1.0.0" });
    expect(f.store.getInstall("foo")?.contentHash).toBe(await hashTree(path.join(f.externalDir, "foo")));
    expect(existsSync(backupDir())).toBe(false);
    expect(readdirSync(path.join(path.dirname(f.externalDir), "hub", "staging"))).toEqual([]);
  });

  test("check fetches sources and reports updates and fetch errors", async () => {
    await f.hub.createSource({ name: "Broken", url: path.join(root, "missing.git") });
    const result = await f.hub.check();
    expect(result.updates.map((u) => u.update.version)).toEqual(["1.1.0"]);
    expect(result.errors).toEqual([{ source: "Broken", error: expect.stringContaining("git clone failed") }]);
  });

  test("warns under bun --watch that updates need a restart", async () => {
    const watched = await createFixture({ watchMode: true });
    const id = (await watched.hub.createSource({ name: "Test", url: repoDir })).source.id;
    await watched.hub.install({ sourceId: id, name: "foo", version: "1.0.0", userId: null });
    expect((await watched.hub.update({ name: "foo", userId: null })).warnings).toEqual([WATCH_MODE_WARNING]);
  });
});

describe("tree checks", () => {
  test("rejects symbolic links leaving the tree", async () => {
    const dir = await mkdtemp(path.join(root, "links-"));
    await writeFile(path.join(dir, "a.ts"), "");
    await symlink("a.ts", path.join(dir, "inside"));
    await assertContainedLinks(dir);

    await symlink("../../etc/passwd", path.join(dir, "outside"));
    await expectHubError(assertContainedLinks(dir), 422);
  });

  test("content hash ignores node_modules and generated files", async () => {
    const dir = await mkdtemp(path.join(root, "hash-"));
    await writeFile(path.join(dir, "index.ts"), "x");
    const before = await hashTree(dir);
    await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "pkg", "index.js"), "y");
    await writeFile(path.join(dir, "tsconfig.json"), "{}");
    await writeFile(path.join(dir, SOURCE_MARKER), "{}");
    expect(await hashTree(dir)).toBe(before);
    await writeFile(path.join(dir, "index.ts"), "changed");
    expect(await hashTree(dir)).not.toBe(before);
  });

  test("fingerprint tracks the hashed files without reading them", async () => {
    const dir = await mkdtemp(path.join(root, "fingerprint-"));
    await writeFile(path.join(dir, "index.ts"), "x");
    const before = await treeFingerprint(dir);
    await writeFile(path.join(dir, SOURCE_MARKER), "{}");
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "a.js"), "y");
    expect(await treeFingerprint(dir)).toBe(before);
    await writeFile(path.join(dir, "extra.ts"), "");
    expect(await treeFingerprint(dir)).not.toBe(before);
  });
});

describe("loadOutcome", () => {
  test("counts only active or operator-disabled extensions as loaded", () => {
    expect(loadOutcome({ status: "active", name: "a", version: "1.0.0" })).toEqual({
      status: "loaded",
      version: "1.0.0",
    });
    expect(loadOutcome({ status: "suspended", name: "a", version: "1.0.0", enabled: false, error: null })).toEqual({
      status: "loaded",
      version: "1.0.0",
    });
    expect(loadOutcome({ status: "suspended", name: "a", version: "1.0.0", enabled: true, error: "x" })).toEqual({
      status: "failed",
      error: "x",
    });
    expect(loadOutcome({ status: "unloaded" }).status).toBe("failed");
    expect(loadOutcome(null)).toEqual({ status: "timeout" });
  });
});

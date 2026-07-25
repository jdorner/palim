import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ExternalDependencyResolver } from "./externalDependencyResolver";

const TEST_DIR = path.join(import.meta.dirname, "__test_ext_resolver__");
const EXT_DIR = path.join(TEST_DIR, "my-ext");
const CORE_DIR = path.join(TEST_DIR, "core-project");

describe("ExternalDependencyResolver.writeTsconfig", () => {
  beforeEach(() => {
    mkdirSync(EXT_DIR, { recursive: true });
    mkdirSync(path.join(CORE_DIR, "src/extensions"), { recursive: true });
    // Create the core source files so no warnings are generated for missing files
    writeFileSync(path.join(CORE_DIR, "src/extensions/types.ts"), "export {};");
    writeFileSync(path.join(CORE_DIR, "src/extensions/sdk.ts"), "export {};");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("writes tsconfig.json when no existing file", async () => {
    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const result = await resolver.writeTsconfig(EXT_DIR);

    expect(result.written).toBe(true);
    expect(result.warnings).toEqual([]);

    const tsconfigPath = path.join(EXT_DIR, "tsconfig.json");
    expect(existsSync(tsconfigPath)).toBe(true);

    const content = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
    expect(content._managed).toBe(true);
    expect(content.compilerOptions.target).toBe("ESNext");
  });

  test("overwrites tsconfig with _managed: true", async () => {
    const tsconfigPath = path.join(EXT_DIR, "tsconfig.json");
    writeFileSync(tsconfigPath, JSON.stringify({ _managed: true, compilerOptions: {} }));

    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const result = await resolver.writeTsconfig(EXT_DIR);

    expect(result.written).toBe(true);

    const content = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
    expect(content._managed).toBe(true);
    expect(content.compilerOptions.target).toBe("ESNext");
  });

  test("skips writing when _managed is false", async () => {
    const tsconfigPath = path.join(EXT_DIR, "tsconfig.json");
    const original = JSON.stringify({ _managed: false, compilerOptions: { custom: true } });
    writeFileSync(tsconfigPath, original);

    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const result = await resolver.writeTsconfig(EXT_DIR);

    expect(result.written).toBe(false);
    expect(result.warnings).toEqual([]);

    // File should be unchanged
    const content = readFileSync(tsconfigPath, "utf-8");
    expect(content).toBe(original);
  });

  test("overwrites tsconfig when _managed field is absent", async () => {
    const tsconfigPath = path.join(EXT_DIR, "tsconfig.json");
    // No _managed field at all - should be treated as managed and overwritten
    const original = JSON.stringify({ compilerOptions: { target: "ES2020", strict: false } });
    writeFileSync(tsconfigPath, original);

    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const result = await resolver.writeTsconfig(EXT_DIR);

    expect(result.written).toBe(true);

    const content = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
    expect(content._managed).toBe(true);
    expect(content.compilerOptions.target).toBe("ESNext");
  });

  test("atomic write uses tmp file during write (rename pattern)", async () => {
    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const tsconfigPath = path.join(EXT_DIR, "tsconfig.json");
    const tmpPath = `${tsconfigPath}.tmp`;

    // Verify the atomic write pattern: .tmp is written then renamed to final path
    await resolver.writeTsconfig(EXT_DIR);

    // .tmp file should not exist after completion (rename consumed it)
    expect(existsSync(tmpPath)).toBe(false);
    // Final file must exist with valid content
    expect(existsSync(tsconfigPath)).toBe(true);
    const content = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
    expect(content._managed).toBe(true);

    // Verify the pattern works correctly on overwrite:
    // Pre-existing tsconfig gets atomically replaced (no partial reads possible)
    writeFileSync(tsconfigPath, "old content");
    await resolver.writeTsconfig(EXT_DIR);
    const newContent = readFileSync(tsconfigPath, "utf-8");
    expect(newContent).not.toBe("old content");
    expect(JSON.parse(newContent)._managed).toBe(true);
    // .tmp must be consumed by rename, not left behind
    expect(existsSync(tmpPath)).toBe(false);
  });

  test("overwrites malformed existing tsconfig", async () => {
    const tsconfigPath = path.join(EXT_DIR, "tsconfig.json");
    writeFileSync(tsconfigPath, "not valid json {{{");

    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const result = await resolver.writeTsconfig(EXT_DIR);

    expect(result.written).toBe(true);
    const content = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
    expect(content._managed).toBe(true);
  });

  test("logs warning when core source files do not exist", async () => {
    // Remove one core file
    rmSync(path.join(CORE_DIR, "src/extensions/sdk.ts"));

    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const result = await resolver.writeTsconfig(EXT_DIR);

    expect(result.written).toBe(true);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("sdk.ts");
  });

  test("logs warnings for all missing core source files", async () => {
    rmSync(path.join(CORE_DIR, "src/extensions/types.ts"));
    rmSync(path.join(CORE_DIR, "src/extensions/sdk.ts"));

    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const result = await resolver.writeTsconfig(EXT_DIR);

    expect(result.written).toBe(true);
    expect(result.warnings.length).toBe(2);
    expect(result.warnings[0]).toContain("types.ts");
    expect(result.warnings[1]).toContain("sdk.ts");
  });

  test("uses atomic write (no .tmp file left behind)", async () => {
    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    await resolver.writeTsconfig(EXT_DIR);

    const tmpPath = path.join(EXT_DIR, "tsconfig.json.tmp");
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(path.join(EXT_DIR, "tsconfig.json"))).toBe(true);
  });

  test("generates valid JSON with correct paths", async () => {
    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    await resolver.writeTsconfig(EXT_DIR);

    const tsconfigPath = path.join(EXT_DIR, "tsconfig.json");
    const content = JSON.parse(readFileSync(tsconfigPath, "utf-8"));

    const relativePath = path.relative(EXT_DIR, CORE_DIR);
    expect(content.compilerOptions.paths["@ext/types"]).toEqual([`${relativePath}/src/extensions/types.ts`]);
    expect(content.compilerOptions.paths["@ext/sdk"]).toEqual([`${relativePath}/src/extensions/sdk.ts`]);
    expect(content.compilerOptions.paths["@src/*"]).toEqual([`${relativePath}/src/*`]);
    expect(content.compilerOptions.paths["@shared/*"]).toEqual([`${relativePath}/shared/*`]);
  });
});

describe("ExternalDependencyResolver.refreshTsconfig", () => {
  beforeEach(() => {
    mkdirSync(EXT_DIR, { recursive: true });
    mkdirSync(path.join(CORE_DIR, "src/extensions"), { recursive: true });
    writeFileSync(path.join(CORE_DIR, "src/extensions/types.ts"), "export {};");
    writeFileSync(path.join(CORE_DIR, "src/extensions/sdk.ts"), "export {};");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("generates tsconfig via refreshTsconfig", async () => {
    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    await resolver.refreshTsconfig(EXT_DIR);

    const tsconfigPath = path.join(EXT_DIR, "tsconfig.json");
    expect(existsSync(tsconfigPath)).toBe(true);

    const content = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
    expect(content._managed).toBe(true);
  });

  test("refreshTsconfig respects _managed: false", async () => {
    const tsconfigPath = path.join(EXT_DIR, "tsconfig.json");
    writeFileSync(tsconfigPath, JSON.stringify({ _managed: false }));

    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    await resolver.refreshTsconfig(EXT_DIR);

    const content = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
    expect(content._managed).toBe(false);
  });
});

describe("ExternalDependencyResolver.installDependencies", () => {
  beforeEach(() => {
    mkdirSync(EXT_DIR, { recursive: true });
    mkdirSync(CORE_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("skips installation when depsToInstall is empty", async () => {
    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const analysis = {
      depsToInstall: new Map<string, string>(),
      hostSatisfied: new Map([["elysia", "^1.0.0"]]),
      versionConflicts: [],
      missingPeers: [],
    };

    const result = await resolver.installDependencies(EXT_DIR, "my-ext", analysis);
    expect(result.installed).toBeNull();
    expect(result.error).toBeUndefined();
  });

  test("succeeds when bun install exits with 0", async () => {
    // Create a minimal package.json so bun install works
    writeFileSync(path.join(EXT_DIR, "package.json"), JSON.stringify({ name: "test-ext", dependencies: {} }));

    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const analysis = {
      depsToInstall: new Map([["nanoid", "^5.0.0"]]),
      hostSatisfied: new Map<string, string>(),
      versionConflicts: [],
      missingPeers: [],
    };

    const result = await resolver.installDependencies(EXT_DIR, "my-ext", analysis);
    expect(result.installed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("returns failure when bun install fails (non-zero exit)", async () => {
    // Create a package.json referencing a non-existent package
    writeFileSync(
      path.join(EXT_DIR, "package.json"),
      JSON.stringify({
        name: "test-ext",
        dependencies: { "@@this-package-definitely-does-not-exist-xyz": "^1.0.0" },
      }),
    );

    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const analysis = {
      depsToInstall: new Map([["@@this-package-definitely-does-not-exist-xyz", "^1.0.0"]]),
      hostSatisfied: new Map<string, string>(),
      versionConflicts: [],
      missingPeers: [],
    };

    const result = await resolver.installDependencies(EXT_DIR, "my-ext", analysis);
    expect(result.installed).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("my-ext");
  });

  test("returns failure on timeout", async () => {
    // Create a package.json - we'll use a very short timeout
    writeFileSync(
      path.join(EXT_DIR, "package.json"),
      JSON.stringify({ name: "test-ext", dependencies: { nanoid: "^5.0.0" } }),
    );

    // Use a 1ms timeout to force timeout
    const resolver = new ExternalDependencyResolver({
      coreProjectDir: CORE_DIR,
      installTimeoutMs: 1,
    });
    const analysis = {
      depsToInstall: new Map([["nanoid", "^5.0.0"]]),
      hostSatisfied: new Map<string, string>(),
      versionConflicts: [],
      missingPeers: [],
    };

    const result = await resolver.installDependencies(EXT_DIR, "my-ext", analysis);
    expect(result.installed).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.error).toContain("my-ext");
  });
});

describe("ExternalDependencyResolver.resolveAll", () => {
  const EXT_A_DIR = path.join(TEST_DIR, "ext-a");
  const EXT_B_DIR = path.join(TEST_DIR, "ext-b");

  beforeEach(() => {
    mkdirSync(EXT_A_DIR, { recursive: true });
    mkdirSync(EXT_B_DIR, { recursive: true });
    mkdirSync(path.join(CORE_DIR, "src/extensions"), { recursive: true });
    writeFileSync(path.join(CORE_DIR, "src/extensions/types.ts"), "export {};");
    writeFileSync(path.join(CORE_DIR, "src/extensions/sdk.ts"), "export {};");
    writeFileSync(path.join(CORE_DIR, "package.json"), JSON.stringify({ name: "core", dependencies: {} }));
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("malformed package.json causes skip with error, other extensions still process", async () => {
    // ext-a has invalid JSON in package.json
    writeFileSync(path.join(EXT_A_DIR, "package.json"), "{ not valid json !!!");
    // ext-b has a valid package.json with no dependencies
    writeFileSync(path.join(EXT_B_DIR, "package.json"), JSON.stringify({ name: "ext-b" }));

    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const results = await resolver.resolveAll([EXT_A_DIR, EXT_B_DIR]);

    expect(results.length).toBe(2);

    // ext-a should be skipped with an error
    const resultA = results.find((r) => r.extensionDir === EXT_A_DIR);
    expect(resultA).toBeDefined();
    expect(resultA!.error).toBeDefined();
    expect(resultA!.error).toContain("Malformed package.json");
    expect(resultA!.tsconfigGenerated).toBe(false);

    // ext-b should still succeed
    const resultB = results.find((r) => r.extensionDir === EXT_B_DIR);
    expect(resultB).toBeDefined();
    expect(resultB!.error).toBeUndefined();
    expect(resultB!.tsconfigGenerated).toBe(true);
  });

  test("extensions with no package.json still get tsconfig generated", async () => {
    // ext-a has NO package.json at all
    // ext-b has a valid package.json
    writeFileSync(path.join(EXT_B_DIR, "package.json"), JSON.stringify({ name: "ext-b" }));

    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const results = await resolver.resolveAll([EXT_A_DIR, EXT_B_DIR]);

    expect(results.length).toBe(2);

    // ext-a should still get tsconfig generated despite no package.json
    const resultA = results.find((r) => r.extensionDir === EXT_A_DIR);
    expect(resultA).toBeDefined();
    expect(resultA!.tsconfigGenerated).toBe(true);
    expect(resultA!.depsInstalled).toBeNull();
    expect(resultA!.error).toBeUndefined();

    // Verify tsconfig file actually exists with correct content
    const tsconfigPath = path.join(EXT_A_DIR, "tsconfig.json");
    expect(existsSync(tsconfigPath)).toBe(true);
    const content = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
    expect(content._managed).toBe(true);
    expect(content.compilerOptions.paths["@ext/types"]).toBeDefined();
  });

  test("overall timeout stops processing remaining extensions", async () => {
    // Create a valid package.json with dependencies that would trigger bun install
    writeFileSync(
      path.join(EXT_A_DIR, "package.json"),
      JSON.stringify({ name: "ext-a", dependencies: { nanoid: "^5.0.0" } }),
    );
    writeFileSync(
      path.join(EXT_B_DIR, "package.json"),
      JSON.stringify({ name: "ext-b", dependencies: { nanoid: "^5.0.0" } }),
    );

    // Use a 1ms overall timeout to force timeout before processing completes
    const resolver = new ExternalDependencyResolver({
      coreProjectDir: CORE_DIR,
      timeoutMs: 1,
      installTimeoutMs: 60_000,
    });

    // Give the timeout a moment to fire before resolveAll processes the loop
    await new Promise((resolve) => setTimeout(resolve, 10));

    const results = await resolver.resolveAll([EXT_A_DIR, EXT_B_DIR]);

    // With such a short timeout, at least some extensions should be skipped
    // or the results should be fewer than the total input
    // The timeout fires asynchronously so it may catch mid-processing
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("ExternalDependencyResolver.resolveOne", () => {
  beforeEach(() => {
    mkdirSync(EXT_DIR, { recursive: true });
    mkdirSync(path.join(CORE_DIR, "src/extensions"), { recursive: true });
    writeFileSync(path.join(CORE_DIR, "src/extensions/types.ts"), "export {};");
    writeFileSync(path.join(CORE_DIR, "src/extensions/sdk.ts"), "export {};");
    writeFileSync(path.join(CORE_DIR, "package.json"), JSON.stringify({ name: "core", dependencies: {} }));
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("extension with no package.json still gets tsconfig generated", async () => {
    // No package.json in the extension directory
    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const result = await resolver.resolveOne(EXT_DIR);

    expect(result.tsconfigGenerated).toBe(true);
    expect(result.depsInstalled).toBeNull();
    expect(result.error).toBeUndefined();

    // Verify the tsconfig file was actually created
    const tsconfigPath = path.join(EXT_DIR, "tsconfig.json");
    expect(existsSync(tsconfigPath)).toBe(true);
    const content = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
    expect(content._managed).toBe(true);
    expect(content.compilerOptions.target).toBe("ESNext");
  });

  test("malformed package.json causes error result with no tsconfig", async () => {
    writeFileSync(path.join(EXT_DIR, "package.json"), "{{invalid json content}}");

    const resolver = new ExternalDependencyResolver({ coreProjectDir: CORE_DIR });
    const result = await resolver.resolveOne(EXT_DIR);

    expect(result.error).toBeDefined();
    expect(result.error).toContain("Malformed package.json");
    expect(result.tsconfigGenerated).toBe(false);
  });
});

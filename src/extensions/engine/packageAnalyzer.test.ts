import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import {
  analyzeExtensionPackage,
  type CorePackageJson,
  type ExtensionPackageJson,
  ExternalDependencyResolver,
  parseVersion,
  satisfiesRange,
} from "./externalDependencyResolver";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TMP_DIR = path.join(import.meta.dir, ".test-node-modules");

function setupNodeModules(packages: Record<string, string>) {
  mkdirSync(TMP_DIR, { recursive: true });
  for (const [name, version] of Object.entries(packages)) {
    const pkgDir = path.join(TMP_DIR, name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name, version }));
  }
}

function cleanupNodeModules() {
  rmSync(TMP_DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// parseVersion
// ---------------------------------------------------------------------------

describe("parseVersion", () => {
  test("parses standard version", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
  });

  test("parses version with v prefix", () => {
    expect(parseVersion("v2.0.1")).toEqual([2, 0, 1]);
  });

  test("parses version with prerelease suffix", () => {
    expect(parseVersion("1.0.0-beta.1")).toEqual([1, 0, 0]);
  });

  test("returns null for invalid version", () => {
    expect(parseVersion("not-a-version")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseVersion("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// satisfiesRange
// ---------------------------------------------------------------------------

describe("satisfiesRange", () => {
  describe("wildcard", () => {
    test("* matches any version", () => {
      expect(satisfiesRange("1.0.0", "*")).toBe(true);
      expect(satisfiesRange("99.99.99", "*")).toBe(true);
    });
  });

  describe("exact match", () => {
    test("matches exact version", () => {
      expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
    });

    test("rejects different version", () => {
      expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false);
    });

    test("= prefix matches exact version", () => {
      expect(satisfiesRange("1.2.3", "=1.2.3")).toBe(true);
      expect(satisfiesRange("1.2.4", "=1.2.3")).toBe(false);
    });
  });

  describe("caret ranges", () => {
    test("^1.2.3 allows patch and minor bumps", () => {
      expect(satisfiesRange("1.2.3", "^1.2.3")).toBe(true);
      expect(satisfiesRange("1.2.4", "^1.2.3")).toBe(true);
      expect(satisfiesRange("1.9.0", "^1.2.3")).toBe(true);
    });

    test("^1.2.3 rejects major bumps", () => {
      expect(satisfiesRange("2.0.0", "^1.2.3")).toBe(false);
    });

    test("^1.2.3 rejects lower versions", () => {
      expect(satisfiesRange("1.2.2", "^1.2.3")).toBe(false);
      expect(satisfiesRange("1.1.9", "^1.2.3")).toBe(false);
    });

    test("^0.2.3 allows patch bumps only", () => {
      expect(satisfiesRange("0.2.3", "^0.2.3")).toBe(true);
      expect(satisfiesRange("0.2.9", "^0.2.3")).toBe(true);
      expect(satisfiesRange("0.3.0", "^0.2.3")).toBe(false);
      expect(satisfiesRange("1.0.0", "^0.2.3")).toBe(false);
    });

    test("^0.0.3 requires exact patch match", () => {
      expect(satisfiesRange("0.0.3", "^0.0.3")).toBe(true);
      expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false);
    });
  });

  describe("tilde ranges", () => {
    test("~1.2.3 allows patch bumps", () => {
      expect(satisfiesRange("1.2.3", "~1.2.3")).toBe(true);
      expect(satisfiesRange("1.2.9", "~1.2.3")).toBe(true);
    });

    test("~1.2.3 rejects minor bumps", () => {
      expect(satisfiesRange("1.3.0", "~1.2.3")).toBe(false);
    });

    test("~1.2.3 rejects lower patch", () => {
      expect(satisfiesRange("1.2.2", "~1.2.3")).toBe(false);
    });
  });

  describe("comparison operators", () => {
    test(">= operator", () => {
      expect(satisfiesRange("1.2.3", ">=1.2.3")).toBe(true);
      expect(satisfiesRange("2.0.0", ">=1.2.3")).toBe(true);
      expect(satisfiesRange("1.2.2", ">=1.2.3")).toBe(false);
    });

    test("> operator", () => {
      expect(satisfiesRange("1.2.4", ">1.2.3")).toBe(true);
      expect(satisfiesRange("1.2.3", ">1.2.3")).toBe(false);
    });

    test("<= operator", () => {
      expect(satisfiesRange("1.2.3", "<=1.2.3")).toBe(true);
      expect(satisfiesRange("1.2.2", "<=1.2.3")).toBe(true);
      expect(satisfiesRange("1.2.4", "<=1.2.3")).toBe(false);
    });

    test("< operator", () => {
      expect(satisfiesRange("1.2.2", "<1.2.3")).toBe(true);
      expect(satisfiesRange("1.2.3", "<1.2.3")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// analyzeExtensionPackage
// ---------------------------------------------------------------------------

describe("analyzeExtensionPackage", () => {
  beforeEach(() => {
    cleanupNodeModules();
  });

  afterEach(() => {
    cleanupNodeModules();
  });

  test("returns empty analysis for extension with no dependencies", () => {
    const extPkg: ExtensionPackageJson = { name: "test-ext" };
    const corePkg: CorePackageJson = { dependencies: { elysia: "^1.4.0" } };

    const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

    expect(result.depsToInstall.size).toBe(0);
    expect(result.hostSatisfied.size).toBe(0);
    expect(result.versionConflicts).toEqual([]);
    expect(result.missingPeers).toEqual([]);
  });

  test("returns empty analysis for extension with empty dependencies", () => {
    const extPkg: ExtensionPackageJson = { name: "test-ext", dependencies: {} };
    const corePkg: CorePackageJson = { dependencies: { elysia: "^1.4.0" } };

    const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

    expect(result.depsToInstall.size).toBe(0);
    expect(result.hostSatisfied.size).toBe(0);
  });

  test("identifies dependency satisfied by host", () => {
    setupNodeModules({ elysia: "1.4.29" });

    const extPkg: ExtensionPackageJson = {
      name: "test-ext",
      dependencies: { elysia: "^1.4.0" },
    };
    const corePkg: CorePackageJson = { dependencies: { elysia: "^1.4.29" } };

    const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

    expect(result.hostSatisfied.get("elysia")).toBe("^1.4.0");
    expect(result.depsToInstall.size).toBe(0);
    expect(result.versionConflicts).toEqual([]);
  });

  test("identifies dependency needing installation (not in host)", () => {
    setupNodeModules({});

    const extPkg: ExtensionPackageJson = {
      name: "test-ext",
      dependencies: { "some-unique-pkg": "^2.0.0" },
    };
    const corePkg: CorePackageJson = { dependencies: { elysia: "^1.4.0" } };

    const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

    expect(result.depsToInstall.get("some-unique-pkg")).toBe("^2.0.0");
    expect(result.hostSatisfied.size).toBe(0);
  });

  test("detects version conflict when host has incompatible version", () => {
    setupNodeModules({ elysia: "1.4.29" });

    const extPkg: ExtensionPackageJson = {
      name: "test-ext",
      dependencies: { elysia: "^2.0.0" },
    };
    const corePkg: CorePackageJson = { dependencies: { elysia: "^1.4.29" } };

    const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

    expect(result.versionConflicts).toEqual([
      { packageName: "elysia", requestedRange: "^2.0.0", installedVersion: "1.4.29" },
    ]);
    expect(result.depsToInstall.get("elysia")).toBe("^2.0.0");
    expect(result.hostSatisfied.size).toBe(0);
  });

  test("detects missing peer dependencies", () => {
    setupNodeModules({ elysia: "1.4.29" });

    const extPkg: ExtensionPackageJson = {
      name: "test-ext",
      peerDependencies: { "drizzle-orm": "^0.45.0", "non-existent-pkg": "^1.0.0" },
    };
    const corePkg: CorePackageJson = { dependencies: { elysia: "^1.4.0" } };

    const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

    expect(result.missingPeers).toContain("drizzle-orm");
    expect(result.missingPeers).toContain("non-existent-pkg");
  });

  test("peer dependency found in host is not reported as missing", () => {
    setupNodeModules({ "drizzle-orm": "0.45.2" });

    const extPkg: ExtensionPackageJson = {
      name: "test-ext",
      peerDependencies: { "drizzle-orm": "^0.45.0" },
    };
    const corePkg: CorePackageJson = { dependencies: { "drizzle-orm": "^0.45.2" } };

    const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

    expect(result.missingPeers).toEqual([]);
  });

  test("considers devDependencies from core for host satisfaction", () => {
    setupNodeModules({ "fast-check": "4.9.0" });

    const extPkg: ExtensionPackageJson = {
      name: "test-ext",
      dependencies: { "fast-check": "^4.0.0" },
    };
    const corePkg: CorePackageJson = {
      dependencies: {},
      devDependencies: { "fast-check": "^4.9.0" },
    };

    const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

    expect(result.hostSatisfied.get("fast-check")).toBe("^4.0.0");
    expect(result.depsToInstall.size).toBe(0);
  });

  test("handles mixed scenario with satisfied, conflicting, and new deps", () => {
    setupNodeModules({ elysia: "1.4.29", yaml: "2.9.0" });

    const extPkg: ExtensionPackageJson = {
      name: "test-ext",
      dependencies: {
        elysia: "^1.4.0", // satisfied by host
        yaml: "^3.0.0", // conflict with host
        "new-package": "^1.0.0", // not in host
      },
      peerDependencies: {
        "missing-peer": "^1.0.0", // not installed
      },
    };
    const corePkg: CorePackageJson = {
      dependencies: { elysia: "^1.4.29", yaml: "^2.9.0" },
    };

    const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

    expect(result.hostSatisfied.get("elysia")).toBe("^1.4.0");
    expect(result.depsToInstall.get("yaml")).toBe("^3.0.0");
    expect(result.depsToInstall.get("new-package")).toBe("^1.0.0");
    expect(result.versionConflicts).toEqual([
      { packageName: "yaml", requestedRange: "^3.0.0", installedVersion: "2.9.0" },
    ]);
    expect(result.missingPeers).toEqual(["missing-peer"]);
  });

  test("handles scoped packages in node_modules", () => {
    // Scoped packages live in nested dirs: node_modules/@scope/pkg
    const scopedDir = path.join(TMP_DIR, "@sinclair", "typebox");
    mkdirSync(scopedDir, { recursive: true });
    writeFileSync(
      path.join(scopedDir, "package.json"),
      JSON.stringify({ name: "@sinclair/typebox", version: "0.34.52" }),
    );

    const extPkg: ExtensionPackageJson = {
      name: "test-ext",
      dependencies: { "@sinclair/typebox": "^0.34.0" },
    };
    const corePkg: CorePackageJson = {
      dependencies: { "@sinclair/typebox": "^0.34.52" },
    };

    const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

    expect(result.hostSatisfied.get("@sinclair/typebox")).toBe("^0.34.0");
    expect(result.depsToInstall.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe("Feature: external-extension-deps, Property 5: Dependency installation decision", () => {
  /**
   * **Validates: Requirements 3.1, 3.2, 3.6, 4.4**
   *
   * Property 5: Dependency installation decision
   * For any extension package.json with a non-empty `dependencies` field, the resolver
   * SHALL determine that installation is needed (depsToInstall non-empty) when deps are
   * NOT in the host. For any extension with empty or absent `dependencies` field, the
   * resolver SHALL skip installation (depsToInstall empty).
   */

  const NON_EXISTENT_NODE_MODULES = "/tmp/.palim-test-nonexistent-node-modules-dir";

  // Generator for valid npm package names (lowercase letters followed by alphanumeric/hyphens)
  const packageNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/).filter((s) => !s.endsWith("-"));

  // Generator for semver ranges (caret ranges like ^1.2.3)
  const semverRangeArb = fc
    .tuple(fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 99 }))
    .map(([major, minor, patch]) => `^${major}.${minor}.${patch}`);

  // Generator for non-empty dependencies record (1-5 unique deps)
  const nonEmptyDepsArb = fc
    .array(fc.tuple(packageNameArb, semverRangeArb), { minLength: 1, maxLength: 5 })
    .map((entries) => Object.fromEntries(entries))
    .filter((obj) => Object.keys(obj).length > 0);

  test("non-empty dependencies result in non-empty depsToInstall when not in host", () => {
    fc.assert(
      fc.property(nonEmptyDepsArb, packageNameArb, (deps, name) => {
        const extPkg: ExtensionPackageJson = {
          name,
          dependencies: deps,
        };
        // Core package has no matching deps, node_modules path does not exist
        const corePkg: CorePackageJson = { dependencies: {} };

        const result = analyzeExtensionPackage(extPkg, corePkg, NON_EXISTENT_NODE_MODULES);

        // All extension deps should need installation since none are in the host
        expect(result.depsToInstall.size).toBeGreaterThan(0);
        // Every declared dep should appear in depsToInstall
        for (const pkgName of Object.keys(deps)) {
          expect(result.depsToInstall.has(pkgName)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  test("empty dependencies result in empty depsToInstall", () => {
    fc.assert(
      fc.property(packageNameArb, (name) => {
        const extPkg: ExtensionPackageJson = {
          name,
          dependencies: {},
        };
        const corePkg: CorePackageJson = { dependencies: { elysia: "^1.4.0" } };

        const result = analyzeExtensionPackage(extPkg, corePkg, NON_EXISTENT_NODE_MODULES);

        expect(result.depsToInstall.size).toBe(0);
        expect(result.hostSatisfied.size).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  test("absent (undefined) dependencies result in empty depsToInstall", () => {
    fc.assert(
      fc.property(packageNameArb, (name) => {
        const extPkg: ExtensionPackageJson = {
          name,
          // dependencies field absent (undefined)
        };
        const corePkg: CorePackageJson = {
          dependencies: { elysia: "^1.4.0", yaml: "^2.0.0" },
          devDependencies: { vitest: "^1.0.0" },
        };

        const result = analyzeExtensionPackage(extPkg, corePkg, NON_EXISTENT_NODE_MODULES);

        expect(result.depsToInstall.size).toBe(0);
        expect(result.hostSatisfied.size).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  test("installation decision is independent of devDependencies and peerDependencies presence", () => {
    fc.assert(
      fc.property(
        nonEmptyDepsArb,
        fc.option(nonEmptyDepsArb),
        fc.option(nonEmptyDepsArb),
        (deps, devDeps, peerDeps) => {
          const extPkg: ExtensionPackageJson = {
            name: "test-ext",
            dependencies: deps,
            devDependencies: devDeps ?? undefined,
            peerDependencies: peerDeps ?? undefined,
          };
          const corePkg: CorePackageJson = { dependencies: {} };

          const result = analyzeExtensionPackage(extPkg, corePkg, NON_EXISTENT_NODE_MODULES);

          // Non-empty regular dependencies should still all need installation
          expect(result.depsToInstall.size).toBe(Object.keys(deps).length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: external-extension-deps, Property 6: Host package deduplication", () => {
  /**
   * **Validates: Requirements 6.3, 6.4**
   *
   * Property 6: Host package deduplication
   * For any extension dependency whose name matches a package in the core project's
   * package.json and whose version range is satisfied by the installed version, the
   * resolver SHALL exclude it from the install list. For any peer dependency matching
   * a host package, the resolver SHALL not trigger installation.
   */

  beforeEach(() => {
    cleanupNodeModules();
  });

  afterEach(() => {
    cleanupNodeModules();
  });

  // Generator for valid npm package names
  const packageNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/).filter((s) => !s.endsWith("-"));

  // Generator for a version tuple [major, minor, patch] with major >= 1 (ensures caret range satisfaction is straightforward)
  const versionTupleArb = fc.tuple(
    fc.integer({ min: 1, max: 9 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
  );

  // Generator for a satisfying pair: an installed version and a caret range guaranteed to be satisfied
  // Strategy: generate a base version for the caret range, then generate an installed version
  // that is >= the base but same major (since major >= 1, caret allows minor/patch bumps)
  const satisfiedPairArb = fc
    .tuple(
      fc.integer({ min: 1, max: 9 }), // major (shared)
      fc.integer({ min: 0, max: 49 }), // range minor
      fc.integer({ min: 0, max: 49 }), // range patch
      fc.integer({ min: 0, max: 50 }), // minor bump (added to range minor)
      fc.integer({ min: 0, max: 50 }), // patch bump (added to range patch)
    )
    .map(([major, rangeMinor, rangePatch, minorBump, patchBump]) => {
      const installedMinor = rangeMinor + minorBump;
      const installedPatch = minorBump > 0 ? patchBump : rangePatch + patchBump;
      const installedVersion = `${major}.${installedMinor}.${installedPatch}`;
      const caretRange = `^${major}.${rangeMinor}.${rangePatch}`;
      return { installedVersion, caretRange };
    });

  test("extension dependency matching host with satisfying version is in hostSatisfied and not in depsToInstall", () => {
    fc.assert(
      fc.property(packageNameArb, satisfiedPairArb, (pkgName, { installedVersion, caretRange }) => {
        // Set up node_modules with the installed version
        setupNodeModules({ [pkgName]: installedVersion });

        const extPkg: ExtensionPackageJson = {
          name: "test-ext",
          dependencies: { [pkgName]: caretRange },
        };
        const corePkg: CorePackageJson = {
          dependencies: { [pkgName]: `^${installedVersion}` },
        };

        const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

        // Should be host-satisfied
        expect(result.hostSatisfied.has(pkgName)).toBe(true);
        expect(result.hostSatisfied.get(pkgName)).toBe(caretRange);
        // Should NOT be in depsToInstall
        expect(result.depsToInstall.has(pkgName)).toBe(false);

        cleanupNodeModules();
      }),
      { numRuns: 100 },
    );
  });

  test("extension peer dependency matching a host package does not appear in missingPeers or depsToInstall", () => {
    fc.assert(
      fc.property(packageNameArb, versionTupleArb, (pkgName, [major, minor, patch]) => {
        const installedVersion = `${major}.${minor}.${patch}`;

        // Set up node_modules with the host package
        setupNodeModules({ [pkgName]: installedVersion });

        const extPkg: ExtensionPackageJson = {
          name: "test-ext",
          peerDependencies: { [pkgName]: `^${major}.${minor}.${patch}` },
        };
        const corePkg: CorePackageJson = {
          dependencies: { [pkgName]: `^${installedVersion}` },
        };

        const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

        // Peer dep found in host should NOT be in missingPeers
        expect(result.missingPeers).not.toContain(pkgName);
        // Peer deps should never trigger installation
        expect(result.depsToInstall.has(pkgName)).toBe(false);

        cleanupNodeModules();
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: external-extension-deps, Property 7: Version conflict detection", () => {
  /**
   * **Validates: Requirements 3.5, 6.5**
   *
   * Property 7: Version conflict detection
   * For any extension dependency whose name matches a core project package but whose
   * version range is NOT satisfied by the installed version, the resolver SHALL report
   * a version conflict identifying the package name, requested range, and installed version.
   */

  beforeEach(() => {
    cleanupNodeModules();
  });

  afterEach(() => {
    cleanupNodeModules();
  });

  // Generator for valid npm package names
  const packageNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/).filter((s) => !s.endsWith("-"));

  // Generator for an incompatible pair where installed major < requested major
  // e.g. installed "1.5.0", range "^2.0.0"
  const incompatibleMajorPairArb = fc
    .tuple(
      fc.integer({ min: 1, max: 8 }), // installed major
      fc.integer({ min: 0, max: 99 }), // installed minor
      fc.integer({ min: 0, max: 99 }), // installed patch
    )
    .map(([installedMajor, installedMinor, installedPatch]) => {
      const requestedMajor = installedMajor + 1;
      const installedVersion = `${installedMajor}.${installedMinor}.${installedPatch}`;
      const requestedRange = `^${requestedMajor}.0.0`;
      return { installedVersion, requestedRange };
    });

  // Generator for an incompatible pair where installed is below range minimum (same major)
  // e.g. installed "1.2.0", range "^1.5.0"
  const incompatibleMinorPairArb = fc
    .tuple(
      fc.integer({ min: 1, max: 9 }), // shared major
      fc.integer({ min: 0, max: 48 }), // installed minor (low)
      fc.integer({ min: 0, max: 99 }), // installed patch
      fc.integer({ min: 1, max: 50 }), // minor gap (ensures requested > installed)
    )
    .map(([major, installedMinor, installedPatch, minorGap]) => {
      const requestedMinor = installedMinor + minorGap;
      const installedVersion = `${major}.${installedMinor}.${installedPatch}`;
      const requestedRange = `^${major}.${requestedMinor}.0`;
      return { installedVersion, requestedRange };
    });

  // Combined arbitrary that picks one of the two incompatible strategies
  const incompatiblePairArb = fc.oneof(incompatibleMajorPairArb, incompatibleMinorPairArb);

  test("version conflict is reported with correct package name, requested range, and installed version", () => {
    fc.assert(
      fc.property(packageNameArb, incompatiblePairArb, (pkgName, { installedVersion, requestedRange }) => {
        // Set up node_modules with the installed version
        setupNodeModules({ [pkgName]: installedVersion });

        const extPkg: ExtensionPackageJson = {
          name: "test-ext",
          dependencies: { [pkgName]: requestedRange },
        };
        const corePkg: CorePackageJson = {
          dependencies: { [pkgName]: `^${installedVersion}` },
        };

        const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

        // Should have exactly one version conflict
        expect(result.versionConflicts.length).toBe(1);
        expect(result.versionConflicts[0]).toEqual({
          packageName: pkgName,
          requestedRange,
          installedVersion,
        });

        // Conflicting package should appear in depsToInstall
        expect(result.depsToInstall.has(pkgName)).toBe(true);
        expect(result.depsToInstall.get(pkgName)).toBe(requestedRange);

        // Conflicting package should NOT appear in hostSatisfied
        expect(result.hostSatisfied.has(pkgName)).toBe(false);

        cleanupNodeModules();
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: external-extension-deps, Property 8: Missing peer dependency detection", () => {
  /**
   * **Validates: Requirements 3.4**
   *
   * Property 8: Missing peer dependency detection
   * For any extension declaring peer dependencies, the resolver SHALL identify peers
   * that do not exist in the core project's node_modules and report them as warnings
   * without blocking initialization.
   */

  beforeEach(() => {
    cleanupNodeModules();
  });

  afterEach(() => {
    cleanupNodeModules();
  });

  // Generator for valid npm package names
  const packageNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/).filter((s) => !s.endsWith("-"));

  // Generator for semver ranges (caret ranges like ^1.2.3)
  const semverRangeArb = fc
    .tuple(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 0, max: 99 }), fc.integer({ min: 0, max: 99 }))
    .map(([major, minor, patch]) => `^${major}.${minor}.${patch}`);

  // Generator for a version tuple [major, minor, patch]
  const versionTupleArb = fc.tuple(
    fc.integer({ min: 1, max: 9 }),
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 0, max: 99 }),
  );

  test("peer dependencies not found in core node_modules are reported as missing", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(packageNameArb, semverRangeArb), {
          minLength: 1,
          maxLength: 5,
          selector: ([name]) => name,
        }),
        (peerEntries) => {
          // Set up an empty node_modules (none of the peers exist)
          setupNodeModules({});

          const peerDeps = Object.fromEntries(peerEntries);
          const extPkg: ExtensionPackageJson = {
            name: "test-ext",
            peerDependencies: peerDeps,
          };
          const corePkg: CorePackageJson = { dependencies: {} };

          const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

          // All peer deps should be reported as missing
          for (const [pkgName] of peerEntries) {
            expect(result.missingPeers).toContain(pkgName);
          }
          expect(result.missingPeers.length).toBe(peerEntries.length);

          cleanupNodeModules();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("peer dependencies found in core node_modules are NOT reported as missing", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(packageNameArb, versionTupleArb), {
          minLength: 1,
          maxLength: 5,
          selector: ([name]) => name,
        }),
        (peerEntries) => {
          // Set up node_modules with all the peer packages installed
          const nodeModulesSetup: Record<string, string> = {};
          const peerDeps: Record<string, string> = {};

          for (const [name, [major, minor, patch]] of peerEntries) {
            const version = `${major}.${minor}.${patch}`;
            nodeModulesSetup[name] = version;
            peerDeps[name] = `^${major}.${minor}.${patch}`;
          }

          setupNodeModules(nodeModulesSetup);

          const extPkg: ExtensionPackageJson = {
            name: "test-ext",
            peerDependencies: peerDeps,
          };
          const corePkg: CorePackageJson = { dependencies: {} };

          const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

          // No peers should be missing since they are all installed
          expect(result.missingPeers).toEqual([]);

          cleanupNodeModules();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("missing peers do not block analysis (no error thrown, other fields still populated)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(packageNameArb, semverRangeArb), {
          minLength: 1,
          maxLength: 3,
          selector: ([name]) => name,
        }),
        fc.uniqueArray(fc.tuple(packageNameArb, semverRangeArb), {
          minLength: 1,
          maxLength: 3,
          selector: ([name]) => name,
        }),
        (depEntries, peerEntries) => {
          // Ensure no overlap between dep names and peer names
          const depNames = new Set(depEntries.map(([n]) => n));
          const filteredPeers = peerEntries.filter(([n]) => !depNames.has(n));
          if (filteredPeers.length === 0) return; // skip if all overlapped

          // Set up empty node_modules (peers will be missing)
          setupNodeModules({});

          const deps = Object.fromEntries(depEntries);
          const peerDeps = Object.fromEntries(filteredPeers);

          const extPkg: ExtensionPackageJson = {
            name: "test-ext",
            dependencies: deps,
            peerDependencies: peerDeps,
          };
          const corePkg: CorePackageJson = { dependencies: {} };

          const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

          // Analysis completes without throwing
          // depsToInstall should contain the regular dependencies
          expect(result.depsToInstall.size).toBe(depEntries.length);
          for (const [pkgName] of depEntries) {
            expect(result.depsToInstall.has(pkgName)).toBe(true);
          }

          // missingPeers should contain all the peer deps
          for (const [pkgName] of filteredPeers) {
            expect(result.missingPeers).toContain(pkgName);
          }

          cleanupNodeModules();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("partial peer satisfaction: only truly missing peers are reported", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(packageNameArb, versionTupleArb), {
          minLength: 2,
          maxLength: 6,
          selector: ([name]) => name,
        }),
        fc.integer({ min: 1, max: 5 }),
        (peerEntries, splitIndex) => {
          // Split peers into installed and missing groups
          const actualSplit = Math.min(splitIndex, peerEntries.length - 1);
          const installedPeers = peerEntries.slice(0, actualSplit);
          const missingPeerEntries = peerEntries.slice(actualSplit);

          if (installedPeers.length === 0 || missingPeerEntries.length === 0) return;

          // Set up only the installed peers in node_modules
          const nodeModulesSetup: Record<string, string> = {};
          for (const [name, [major, minor, patch]] of installedPeers) {
            nodeModulesSetup[name] = `${major}.${minor}.${patch}`;
          }
          setupNodeModules(nodeModulesSetup);

          // Build peerDependencies with all entries
          const peerDeps: Record<string, string> = {};
          for (const [name, [major, minor, patch]] of peerEntries) {
            peerDeps[name] = `^${major}.${minor}.${patch}`;
          }

          const extPkg: ExtensionPackageJson = {
            name: "test-ext",
            peerDependencies: peerDeps,
          };
          const corePkg: CorePackageJson = { dependencies: {} };

          const result = analyzeExtensionPackage(extPkg, corePkg, TMP_DIR);

          // Installed peers should NOT be in missingPeers
          for (const [name] of installedPeers) {
            expect(result.missingPeers).not.toContain(name);
          }

          // Missing peers SHOULD be in missingPeers
          for (const [name] of missingPeerEntries) {
            expect(result.missingPeers).toContain(name);
          }

          cleanupNodeModules();
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: external-extension-deps, Property 9: Failed installation does not block other extensions", () => {
  /**
   * **Validates: Requirements 3.3, 4.3**
   *
   * Property 9: Failed installation does not block other extensions
   * For any set of extensions where some extensions' package.json is malformed (causing
   * a failure), the resolver SHALL still process and return results for ALL extensions,
   * marking only the failed ones as errored. Non-failing extensions still get tsconfig generated.
   */

  const TMP_BASE = path.join(import.meta.dir, ".test-property9-tmp");
  const CORE_PROJECT_DIR = path.resolve(import.meta.dir, "../..");

  function cleanupTmpBase() {
    rmSync(TMP_BASE, { recursive: true, force: true });
  }

  beforeEach(() => {
    cleanupTmpBase();
    mkdirSync(TMP_BASE, { recursive: true });
  });

  afterEach(() => {
    cleanupTmpBase();
  });

  // Generator for valid extension names (lowercase alpha with optional hyphens)
  const extNameArb = fc.stringMatching(/^[a-z][a-z0-9-]{1,10}$/).filter((s) => !s.endsWith("-"));

  // Generator for the "failing" or "succeeding" status of each extension in a set
  // We generate arrays of booleans where true = valid extension, false = malformed package.json
  // Ensure at least one valid and one malformed extension
  const extensionSetArb = fc
    .tuple(
      fc.integer({ min: 1, max: 3 }), // number of valid extensions
      fc.integer({ min: 1, max: 3 }), // number of malformed extensions
    )
    .chain(([validCount, malformedCount]) =>
      fc.tuple(
        fc.uniqueArray(extNameArb, { minLength: validCount, maxLength: validCount }),
        fc.uniqueArray(extNameArb, { minLength: malformedCount, maxLength: malformedCount }),
      ),
    )
    .filter(([validNames, malformedNames]) => {
      // Ensure no name overlap between valid and malformed sets
      const validSet = new Set(validNames);
      return malformedNames.every((n) => !validSet.has(n));
    });

  test("resolveAll returns one result per extension and non-failing extensions get tsconfig generated", async () => {
    await fc.assert(
      fc.asyncProperty(extensionSetArb, async ([validNames, malformedNames]) => {
        // Clean up from previous iteration
        rmSync(TMP_BASE, { recursive: true, force: true });
        mkdirSync(TMP_BASE, { recursive: true });

        // Create valid extension directories with proper package.json (no deps)
        const allDirs: string[] = [];

        for (const name of validNames) {
          const extDir = path.join(TMP_BASE, name);
          mkdirSync(extDir, { recursive: true });
          writeFileSync(path.join(extDir, "package.json"), JSON.stringify({ name: `ext-${name}` }));
          allDirs.push(extDir);
        }

        // Create malformed extension directories with invalid JSON in package.json
        for (const name of malformedNames) {
          const extDir = path.join(TMP_BASE, name);
          mkdirSync(extDir, { recursive: true });
          writeFileSync(path.join(extDir, "package.json"), "{ invalid json !!! }");
          allDirs.push(extDir);
        }

        const resolver = new ExternalDependencyResolver({
          coreProjectDir: CORE_PROJECT_DIR,
          timeoutMs: 30_000,
          installTimeoutMs: 10_000,
        });

        const results = await resolver.resolveAll(allDirs);

        // Property 1: results.length === total number of extension dirs
        expect(results.length).toBe(allDirs.length);

        // Property 2: Each extension directory appears exactly once in results
        const resultDirs = results.map((r) => r.extensionDir);
        for (const dir of allDirs) {
          expect(resultDirs).toContain(dir);
        }

        // Property 3: Valid extensions (no malformed package.json) get tsconfig generated
        for (const name of validNames) {
          const extDir = path.join(TMP_BASE, name);
          const result = results.find((r) => r.extensionDir === extDir);
          expect(result).toBeDefined();
          expect(result!.tsconfigGenerated).toBe(true);
          expect(result!.error).toBeUndefined();
        }

        // Property 4: Malformed extensions have error set
        for (const name of malformedNames) {
          const extDir = path.join(TMP_BASE, name);
          const result = results.find((r) => r.extensionDir === extDir);
          expect(result).toBeDefined();
          expect(result!.error).toBeDefined();
          expect(result!.error).toContain("Malformed");
        }
      }),
      { numRuns: 100 },
    );
  });

  test("order of failing extensions does not affect results of non-failing extensions", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(extNameArb, { minLength: 3, maxLength: 6 }), async (names) => {
        // Clean up from previous iteration
        rmSync(TMP_BASE, { recursive: true, force: true });
        mkdirSync(TMP_BASE, { recursive: true });

        // First name is malformed, rest are valid
        const malformedIndex = 0;
        const allDirs: string[] = [];

        for (let i = 0; i < names.length; i++) {
          const extDir = path.join(TMP_BASE, names[i]!);
          mkdirSync(extDir, { recursive: true });

          if (i === malformedIndex) {
            writeFileSync(path.join(extDir, "package.json"), "not valid json {{{");
          } else {
            writeFileSync(path.join(extDir, "package.json"), JSON.stringify({ name: `ext-${names[i]!}` }));
          }
          allDirs.push(extDir);
        }

        const resolver = new ExternalDependencyResolver({
          coreProjectDir: CORE_PROJECT_DIR,
          timeoutMs: 30_000,
          installTimeoutMs: 10_000,
        });

        const results = await resolver.resolveAll(allDirs);

        // All extensions get a result regardless of the malformed one at index 0
        expect(results.length).toBe(allDirs.length);

        // The malformed one has an error
        const malformedResult = results.find((r) => r.extensionDir === allDirs[malformedIndex]);
        expect(malformedResult).toBeDefined();
        expect(malformedResult!.error).toBeDefined();

        // All other extensions still get tsconfig generated
        for (let i = 1; i < names.length; i++) {
          const result = results.find((r) => r.extensionDir === allDirs[i]);
          expect(result).toBeDefined();
          expect(result!.tsconfigGenerated).toBe(true);
          expect(result!.error).toBeUndefined();
        }
      }),
      { numRuns: 100 },
    );
  });
});

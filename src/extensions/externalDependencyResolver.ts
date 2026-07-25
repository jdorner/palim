/**
 * External extension dependency resolution module.
 *
 * Resolves TypeScript configuration and npm dependencies for external extensions
 * placed outside the core project tree. Generates per-extension tsconfig.json files
 * with path mappings to the core project, and installs extension-specific npm
 * packages when declared in package.json.
 *
 * The existing `dependencyResolver.ts` handles topological sort of extension load
 * order - this module handles npm/TypeScript dependency resolution for external
 * extensions.
 */

import { existsSync, readFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import createLogger from "logging";

const logger = createLogger("ExtDeps");

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Configuration for the external dependency resolver.
 */
export interface ResolverConfig {
  /** Absolute path to the core project root (where tsconfig.json and node_modules live). */
  coreProjectDir: string;
  /** Timeout in ms for all dependency resolution (default: 120_000). */
  timeoutMs?: number;
  /** Timeout in ms for a single bun install invocation (default: 60_000). */
  installTimeoutMs?: number;
}

/**
 * Result of resolving dependencies for a single extension.
 */
export interface ResolutionResult {
  /** Extension directory path. */
  extensionDir: string;
  /** Extension name (from package.json or directory name). */
  name: string;
  /** Whether tsconfig generation succeeded. */
  tsconfigGenerated: boolean;
  /** Whether dependency installation succeeded (null if no install was needed). */
  depsInstalled: boolean | null;
  /** Error message if resolution failed. */
  error?: string;
  /** Warnings (missing peers, version conflicts, etc.). */
  warnings: string[];
}

/**
 * Structure of the generated tsconfig.json for an external extension.
 *
 * Contains a `_managed` marker to indicate auto-generation, compiler options
 * with path aliases pointing back to the core project, and include/exclude globs.
 */
export interface ExtensionTsconfigContent {
  /** Marker indicating this tsconfig is auto-generated and safe to overwrite. */
  _managed: boolean;
  compilerOptions: {
    target: string;
    module: string;
    moduleResolution: string;
    strict: boolean;
    noUncheckedIndexedAccess: boolean;
    noImplicitOverride: boolean;
    noFallthroughCasesInSwitch: boolean;
    allowImportingTsExtensions: boolean;
    verbatimModuleSyntax: boolean;
    noEmit: boolean;
    skipLibCheck: boolean;
    typeRoots: string[];
    paths: Record<string, string[]>;
  };
  include: string[];
  exclude: string[];
}

/**
 * Analysis of an extension's package.json dependencies against the core project.
 */
export interface PackageAnalysis {
  /** Dependencies that need to be installed (not satisfied by host). */
  depsToInstall: Map<string, string>;
  /** Dependencies satisfied by the host (skipped). */
  hostSatisfied: Map<string, string>;
  /** Version conflicts (requested range incompatible with installed). */
  versionConflicts: VersionConflict[];
  /** Missing peer dependencies (not found in core node_modules). */
  missingPeers: string[];
}

/**
 * Describes a version conflict between an extension dependency and a host package.
 */
export interface VersionConflict {
  /** Name of the conflicting package. */
  packageName: string;
  /** Semver range requested by the extension. */
  requestedRange: string;
  /** Version currently installed in the core project. */
  installedVersion: string;
}

// ---------------------------------------------------------------------------
// Pure Helper Functions
// ---------------------------------------------------------------------------

/**
 * Generates the tsconfig.json content for an external extension.
 *
 * Computes relative paths from the extension directory to the core project and
 * builds a complete tsconfig object with path aliases, compiler options, and
 * type roots that allow TypeScript tooling to resolve imports correctly.
 *
 * @param extensionDir - Absolute path to the extension directory
 * @param coreProjectDir - Absolute path to the core project root
 * @returns The tsconfig object ready for JSON serialization
 */
export function generateExtensionTsconfig(extensionDir: string, coreProjectDir: string): ExtensionTsconfigContent {
  const relativeToCoreProject = path.relative(extensionDir, coreProjectDir);

  return {
    _managed: true,
    compilerOptions: {
      target: "ESNext",
      module: "Preserve",
      moduleResolution: "bundler",
      strict: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      noEmit: true,
      skipLibCheck: true,
      typeRoots: [`${relativeToCoreProject}/node_modules/@types`],
      paths: {
        "@ext/types": [`${relativeToCoreProject}/src/extensions/types.ts`],
        "@ext/sdk": [`${relativeToCoreProject}/src/extensions/sdk.ts`],
        "@src/*": [`${relativeToCoreProject}/src/*`],
        "@shared/*": [`${relativeToCoreProject}/shared/*`],
        "*": ["./node_modules/*", `${relativeToCoreProject}/node_modules/*`],
      },
    },
    include: ["./**/*.ts"],
    exclude: ["node_modules"],
  };
}

// ---------------------------------------------------------------------------
// Package Analysis Types
// ---------------------------------------------------------------------------

/**
 * Minimal representation of an extension's package.json for dependency analysis.
 */
export interface ExtensionPackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * Minimal representation of the core project's package.json for dependency analysis.
 */
export interface CorePackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Semver Utilities
// ---------------------------------------------------------------------------

/**
 * Parses a version string like "1.2.3" into its numeric components.
 *
 * @param version - Semver version string (may include leading "v")
 * @returns Tuple of [major, minor, patch] or null if parsing fails
 */
export function parseVersion(version: string): [number, number, number] | null {
  const cleaned = version.replace(/^v/, "").trim();
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compares two parsed version tuples.
 *
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareVersions(a: [number, number, number], b: [number, number, number]): -1 | 0 | 1 {
  if (a[0] < b[0]) return -1;
  if (a[0] > b[0]) return 1;
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  if (a[2] < b[2]) return -1;
  if (a[2] > b[2]) return 1;
  return 0;
}

/**
 * Checks if a version satisfies a semver range string.
 *
 * Supports common npm range operators:
 * - `^1.2.3` - Compatible with version (>=1.2.3, <2.0.0 for major>=1; >=0.2.3, <0.3.0 for 0.x)
 * - `~1.2.3` - Approximately equivalent (>=1.2.3, <1.3.0)
 * - `>=1.2.3`, `>1.2.3`, `<=1.2.3`, `<1.2.3` - Comparison operators
 * - `=1.2.3` or `1.2.3` - Exact match
 * - `*` - Any version
 *
 * @param version - The installed version string (e.g. "1.2.3")
 * @param range - The semver range to check against (e.g. "^1.0.0")
 * @returns true if the version satisfies the range
 */
export function satisfiesRange(version: string, range: string): boolean {
  const trimmedRange = range.trim();

  // Wildcard matches anything
  if (trimmedRange === "*" || trimmedRange === "x" || trimmedRange === "") {
    return true;
  }

  const ver = parseVersion(version);
  if (!ver) return false;

  // Caret range: ^1.2.3
  if (trimmedRange.startsWith("^")) {
    const rangeVer = parseVersion(trimmedRange.slice(1));
    if (!rangeVer) return false;
    return satisfiesCaret(ver, rangeVer);
  }

  // Tilde range: ~1.2.3
  if (trimmedRange.startsWith("~")) {
    const rangeVer = parseVersion(trimmedRange.slice(1));
    if (!rangeVer) return false;
    return satisfiesTilde(ver, rangeVer);
  }

  // Comparison operators: >=, >, <=, <, =
  if (trimmedRange.startsWith(">=")) {
    const rangeVer = parseVersion(trimmedRange.slice(2));
    if (!rangeVer) return false;
    return compareVersions(ver, rangeVer) >= 0;
  }
  if (trimmedRange.startsWith(">") && !trimmedRange.startsWith(">=")) {
    const rangeVer = parseVersion(trimmedRange.slice(1));
    if (!rangeVer) return false;
    return compareVersions(ver, rangeVer) > 0;
  }
  if (trimmedRange.startsWith("<=")) {
    const rangeVer = parseVersion(trimmedRange.slice(2));
    if (!rangeVer) return false;
    return compareVersions(ver, rangeVer) <= 0;
  }
  if (trimmedRange.startsWith("<") && !trimmedRange.startsWith("<=")) {
    const rangeVer = parseVersion(trimmedRange.slice(1));
    if (!rangeVer) return false;
    return compareVersions(ver, rangeVer) < 0;
  }
  if (trimmedRange.startsWith("=")) {
    const rangeVer = parseVersion(trimmedRange.slice(1));
    if (!rangeVer) return false;
    return compareVersions(ver, rangeVer) === 0;
  }

  // Exact version match (no operator prefix)
  const rangeVer = parseVersion(trimmedRange);
  if (!rangeVer) return false;
  return compareVersions(ver, rangeVer) === 0;
}

/**
 * Checks caret range satisfaction: ^MAJOR.MINOR.PATCH
 * - For major >= 1: allows changes that do not modify the major version
 * - For major === 0 and minor >= 1: allows changes that do not modify the minor version
 * - For major === 0 and minor === 0: requires exact match
 */
function satisfiesCaret(ver: [number, number, number], range: [number, number, number]): boolean {
  // Must be >= the range version
  if (compareVersions(ver, range) < 0) return false;

  if (range[0] > 0) {
    // ^1.2.3 means >=1.2.3, <2.0.0
    return ver[0] === range[0];
  }
  if (range[1] > 0) {
    // ^0.2.3 means >=0.2.3, <0.3.0
    return ver[0] === 0 && ver[1] === range[1];
  }
  // ^0.0.3 means >=0.0.3, <0.0.4 (exact match on patch)
  return ver[0] === 0 && ver[1] === 0 && ver[2] === range[2];
}

/**
 * Checks tilde range satisfaction: ~MAJOR.MINOR.PATCH
 * Allows patch-level changes: >=MAJOR.MINOR.PATCH, <MAJOR.(MINOR+1).0
 */
function satisfiesTilde(ver: [number, number, number], range: [number, number, number]): boolean {
  // Must be >= the range version
  if (compareVersions(ver, range) < 0) return false;

  // Same major and minor
  return ver[0] === range[0] && ver[1] === range[1];
}

// ---------------------------------------------------------------------------
// Package Analysis Function
// ---------------------------------------------------------------------------

/**
 * Analyzes extension dependencies against the core project's installed packages.
 *
 * Reads actual installed versions from `coreNodeModulesDir` to determine which
 * extension dependencies are already satisfied by the host, which need installation,
 * and which have version conflicts.
 *
 * @param extensionPkg - The extension's package.json data
 * @param corePackageJson - The core project's package.json data
 * @param coreNodeModulesDir - Absolute path to the core project's node_modules directory
 * @returns Analysis of dependencies with install decisions and conflict information
 */
export function analyzeExtensionPackage(
  extensionPkg: ExtensionPackageJson,
  corePackageJson: CorePackageJson,
  coreNodeModulesDir: string,
): PackageAnalysis {
  const depsToInstall = new Map<string, string>();
  const hostSatisfied = new Map<string, string>();
  const versionConflicts: VersionConflict[] = [];
  const missingPeers: string[] = [];

  const extDeps = extensionPkg.dependencies ?? {};
  const extPeers = extensionPkg.peerDependencies ?? {};

  // Merge core dependencies and devDependencies for host lookup
  const hostDeclared: Record<string, string> = {
    ...(corePackageJson.dependencies ?? {}),
    ...(corePackageJson.devDependencies ?? {}),
  };

  // Analyze regular dependencies
  for (const [pkgName, requestedRange] of Object.entries(extDeps)) {
    const installedVersion = getInstalledVersion(coreNodeModulesDir, pkgName);

    if (installedVersion && pkgName in hostDeclared) {
      // Package exists in host - check version compatibility
      if (satisfiesRange(installedVersion, requestedRange)) {
        hostSatisfied.set(pkgName, requestedRange);
      } else {
        // Version conflict - host has incompatible version
        versionConflicts.push({ packageName: pkgName, requestedRange, installedVersion });
        depsToInstall.set(pkgName, requestedRange);
      }
    } else {
      // Package not in host - needs installation
      depsToInstall.set(pkgName, requestedRange);
    }
  }

  // Analyze peer dependencies
  for (const pkgName of Object.keys(extPeers)) {
    const installedVersion = getInstalledVersion(coreNodeModulesDir, pkgName);
    if (!installedVersion) {
      missingPeers.push(pkgName);
    }
    // Peer deps matching host packages are never installed separately (Req 6.3)
  }

  return { depsToInstall, hostSatisfied, versionConflicts, missingPeers };
}

/**
 * Reads the installed version of a package from node_modules.
 *
 * @param nodeModulesDir - Absolute path to node_modules
 * @param packageName - Name of the package to look up
 * @returns The installed version string, or null if not found
 */
function getInstalledVersion(nodeModulesDir: string, packageName: string): string | null {
  const pkgJsonPath = path.join(nodeModulesDir, packageName, "package.json");
  if (!existsSync(pkgJsonPath)) return null;

  try {
    const content = readFileSync(pkgJsonPath, "utf-8");
    const parsed = JSON.parse(content);
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ExternalDependencyResolver
// ---------------------------------------------------------------------------

/**
 * Resolves TypeScript configuration and npm dependencies for external extensions.
 *
 * Generates per-extension tsconfig.json files with path mappings to the core project,
 * and installs extension-specific npm packages when declared in package.json.
 *
 * @example
 * ```ts
 * const resolver = new ExternalDependencyResolver({
 *   coreProjectDir: "/home/joe/projects/palim",
 * });
 * const results = await resolver.resolveAll(["/path/to/extensions/my-ext"]);
 * ```
 */
export class ExternalDependencyResolver {
  private readonly coreProjectDir: string;
  private readonly timeoutMs: number;
  private readonly installTimeoutMs: number;

  /**
   * Create a new ExternalDependencyResolver.
   *
   * @param config - Resolver configuration with core project path and optional timeouts.
   */
  constructor(config: ResolverConfig) {
    this.coreProjectDir = config.coreProjectDir;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.installTimeoutMs = config.installTimeoutMs ?? 60_000;
  }

  /**
   * Write (or skip) the tsconfig.json for an extension directory.
   *
   * Handles the full tsconfig write lifecycle:
   * 1. Reads existing tsconfig.json if present
   * 2. If `_managed` is explicitly `false`, skips writing (user manages their own)
   * 3. Generates tsconfig content via `generateExtensionTsconfig()`
   * 4. Checks if referenced core source files exist and logs warnings if not
   * 5. Writes atomically via `.tmp` file + rename
   * 6. Catches filesystem errors (EACCES, ENOSPC) and logs warnings without throwing
   *
   * @param extensionDir - Absolute path to the extension directory.
   * @returns Object with `written` indicating if the file was written, and `warnings` array.
   */
  async writeTsconfig(extensionDir: string): Promise<{ written: boolean; warnings: string[] }> {
    const warnings: string[] = [];
    const tsconfigPath = path.join(extensionDir, "tsconfig.json");
    const tmpPath = `${tsconfigPath}.tmp`;

    // 1. Read existing tsconfig if present - check _managed flag
    if (existsSync(tsconfigPath)) {
      try {
        const existing = readFileSync(tsconfigPath, "utf-8");
        const parsed = JSON.parse(existing);
        if (parsed._managed === false) {
          logger.warn(`Skipping tsconfig generation for ${path.basename(extensionDir)} (_managed: false)`);
          return { written: false, warnings };
        }
      } catch {
        // Malformed JSON or read error - proceed with overwrite
      }
    }

    // 2. Generate tsconfig content
    const tsconfig = generateExtensionTsconfig(extensionDir, this.coreProjectDir);

    // 3. Check if referenced core source files exist
    const coreFiles = [
      path.join(this.coreProjectDir, "src/extensions/types.ts"),
      path.join(this.coreProjectDir, "src/extensions/sdk.ts"),
    ];
    for (const filePath of coreFiles) {
      if (!existsSync(filePath)) {
        const msg = `Core source file does not exist: ${filePath}`;
        logger.warn(msg);
        warnings.push(msg);
      }
    }

    // 4. Write atomically: write to .tmp then rename
    try {
      const content = JSON.stringify(tsconfig, null, 2);
      await Bun.write(tmpPath, content);
      await rename(tmpPath, tsconfigPath);
      return { written: true, warnings };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "ENOSPC") {
        const msg = `Failed to write tsconfig for ${path.basename(extensionDir)}: ${code}`;
        logger.warn(msg);
        warnings.push(msg);
        return { written: false, warnings };
      }
      // For other filesystem errors, also log and continue (Req 5.4)
      const msg = `Failed to write tsconfig for ${path.basename(extensionDir)}: ${(err as Error).message}`;
      logger.warn(msg);
      warnings.push(msg);
      return { written: false, warnings };
    }
  }

  /**
   * Install extension-specific npm dependencies via `bun install`.
   *
   * Spawns `bun install` in the extension directory and enforces a per-install timeout.
   * If the `depsToInstall` map is empty (no dependencies needed), skips installation
   * and returns `null`. On failure (non-zero exit or timeout), returns `false` with
   * error details. On success, returns `true`.
   *
   * @param extensionDir - Absolute path to the extension directory where `bun install` runs.
   * @param extensionName - Name of the extension (for logging).
   * @param analysis - Result of `analyzeExtensionPackage()` indicating what needs installation.
   * @returns `true` on success, `false` on failure, or `null` if no installation was needed.
   *          When `false`, an error string is also returned.
   */
  async installDependencies(
    extensionDir: string,
    extensionName: string,
    analysis: PackageAnalysis,
  ): Promise<{ installed: boolean | null; error?: string }> {
    // Skip if no dependencies need installation (Req 3.6, 4.4)
    if (analysis.depsToInstall.size === 0) {
      return { installed: null };
    }

    let proc: ReturnType<typeof Bun.spawn> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    try {
      proc = Bun.spawn(["bun", "install"], {
        cwd: extensionDir,
        stdout: "ignore",
        stderr: "pipe",
      });

      // Enforce per-install timeout (Req 3.3 - timeout >60s)
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          proc?.kill();
          resolve("timeout");
        }, this.installTimeoutMs);
      });

      const exitPromise = proc.exited.then(() => "exited" as const);
      await Promise.race([exitPromise, timeoutPromise]);

      if (timeoutId) clearTimeout(timeoutId);

      if (timedOut) {
        const msg = `bun install timed out after ${this.installTimeoutMs}ms for extension "${extensionName}"`;
        logger.error(msg);
        return { installed: false, error: msg };
      }

      const exitCode = proc.exitCode;

      if (exitCode !== 0) {
        // Capture stderr for error reporting (Req 4.3)
        let stderr = "";
        try {
          if (proc.stderr && typeof proc.stderr !== "number") {
            stderr = await new Response(proc.stderr).text();
          }
        } catch {
          // stderr capture failed - proceed with generic message
        }
        const msg = `bun install failed for extension "${extensionName}" (exit code ${exitCode}): ${stderr.trim()}`;
        logger.error(msg);
        return { installed: false, error: msg };
      }

      return { installed: true };
    } catch (err: unknown) {
      if (timeoutId) clearTimeout(timeoutId);
      const msg = `bun install error for extension "${extensionName}": ${(err as Error).message}`;
      logger.error(msg);
      return { installed: false, error: msg };
    }
  }

  /**
   * Process all external extension directories: generate tsconfigs and install deps.
   *
   * Iterates extensions sequentially. If one extension fails, the error is captured
   * in its result and processing continues with remaining extensions. The overall
   * operation is subject to `timeoutMs`.
   *
   * @param extensionDirs - Absolute paths to extension directories to process.
   * @returns Per-extension resolution results indicating success/failure.
   */
  async resolveAll(extensionDirs: string[]): Promise<ResolutionResult[]> {
    const results: ResolutionResult[] = [];
    let timedOut = false;

    // Overall timeout: resolve with whatever results are collected so far
    const timeoutId = setTimeout(() => {
      timedOut = true;
      logger.error(`Overall dependency resolution timed out after ${this.timeoutMs}ms`);
    }, this.timeoutMs);

    try {
      for (const extensionDir of extensionDirs) {
        if (timedOut) {
          logger.error(`Skipping remaining extensions due to overall timeout`);
          break;
        }

        const result: ResolutionResult = {
          extensionDir,
          name: path.basename(extensionDir),
          tsconfigGenerated: false,
          depsInstalled: null,
          warnings: [],
        };

        try {
          // Determine extension name from package.json or fall back to basename
          const extPkgPath = path.join(extensionDir, "package.json");
          let extensionPkg: ExtensionPackageJson | null = null;

          if (existsSync(extPkgPath)) {
            try {
              const raw = readFileSync(extPkgPath, "utf-8");
              extensionPkg = JSON.parse(raw) as ExtensionPackageJson;
              if (extensionPkg.name) {
                result.name = extensionPkg.name;
              }
            } catch (parseErr) {
              const msg = `Malformed package.json in ${path.basename(extensionDir)}: ${(parseErr as Error).message}`;
              logger.error(msg);
              result.error = msg;
              results.push(result);
              continue;
            }
          }

          // Generate/update tsconfig.json
          const tsconfigResult = await this.writeTsconfig(extensionDir);
          result.tsconfigGenerated = tsconfigResult.written;
          result.warnings.push(...tsconfigResult.warnings);

          // If the extension has a package.json with dependencies, analyze and install
          if (extensionPkg?.dependencies && Object.keys(extensionPkg.dependencies).length > 0) {
            // Read the core project's package.json
            const corePkgPath = path.join(this.coreProjectDir, "package.json");
            let corePackageJson: CorePackageJson = {};

            if (existsSync(corePkgPath)) {
              try {
                const raw = readFileSync(corePkgPath, "utf-8");
                corePackageJson = JSON.parse(raw) as CorePackageJson;
              } catch (parseErr) {
                const msg = `Failed to parse core package.json: ${(parseErr as Error).message}`;
                logger.error(msg);
                result.error = msg;
                results.push(result);
                continue;
              }
            }

            const coreNodeModulesDir = path.join(this.coreProjectDir, "node_modules");
            const analysis = analyzeExtensionPackage(extensionPkg, corePackageJson, coreNodeModulesDir);

            // Log warnings for version conflicts
            for (const conflict of analysis.versionConflicts) {
              const msg = `Version conflict for "${conflict.packageName}" in extension "${result.name}": requested ${conflict.requestedRange}, installed ${conflict.installedVersion}`;
              logger.warn(msg);
              result.warnings.push(msg);
            }

            // Log warnings for missing peer dependencies
            for (const peer of analysis.missingPeers) {
              const msg = `Missing peer dependency "${peer}" for extension "${result.name}"`;
              logger.warn(msg);
              result.warnings.push(msg);
            }

            // Install dependencies if there are any to install
            if (analysis.depsToInstall.size > 0) {
              const installResult = await this.installDependencies(extensionDir, result.name, analysis);
              result.depsInstalled = installResult.installed;
              if (installResult.error) {
                result.error = installResult.error;
              }
            } else {
              result.depsInstalled = null;
            }
          }
          // If no package.json or no dependencies: tsconfigGenerated is set, depsInstalled stays null
        } catch (err: unknown) {
          const msg = `Resolution failed for extension "${result.name}": ${(err as Error).message}`;
          logger.error(msg);
          result.error = msg;
        }

        results.push(result);
      }
    } finally {
      clearTimeout(timeoutId);
    }

    return results;
  }

  /**
   * Process a single extension directory (used during hot-load).
   *
   * Generates tsconfig and installs dependencies for the specified extension.
   * Called by `ExtensionRegistry.loadOne()` before the dynamic import.
   *
   * @param extensionDir - Absolute path to the extension directory.
   * @returns Resolution result for the extension.
   */
  async resolveOne(extensionDir: string): Promise<ResolutionResult> {
    const result: ResolutionResult = {
      extensionDir,
      name: path.basename(extensionDir),
      tsconfigGenerated: false,
      depsInstalled: null,
      warnings: [],
    };

    try {
      // Read extension package.json if present
      const extPkgPath = path.join(extensionDir, "package.json");
      let extensionPkg: ExtensionPackageJson | null = null;

      if (existsSync(extPkgPath)) {
        try {
          const raw = readFileSync(extPkgPath, "utf-8");
          extensionPkg = JSON.parse(raw) as ExtensionPackageJson;
          if (extensionPkg.name) {
            result.name = extensionPkg.name;
          }
        } catch (parseErr) {
          const msg = `Malformed package.json in ${path.basename(extensionDir)}: ${(parseErr as Error).message}`;
          logger.error(msg);
          result.error = msg;
          return result;
        }
      }

      // Generate/update tsconfig.json
      const tsconfigResult = await this.writeTsconfig(extensionDir);
      result.tsconfigGenerated = tsconfigResult.written;
      result.warnings.push(...tsconfigResult.warnings);

      // If the extension has dependencies, analyze and install
      if (extensionPkg?.dependencies && Object.keys(extensionPkg.dependencies).length > 0) {
        const corePkgPath = path.join(this.coreProjectDir, "package.json");
        let corePackageJson: CorePackageJson = {};

        if (existsSync(corePkgPath)) {
          try {
            const raw = readFileSync(corePkgPath, "utf-8");
            corePackageJson = JSON.parse(raw) as CorePackageJson;
          } catch (parseErr) {
            const msg = `Failed to parse core package.json: ${(parseErr as Error).message}`;
            logger.error(msg);
            result.error = msg;
            return result;
          }
        }

        const coreNodeModulesDir = path.join(this.coreProjectDir, "node_modules");
        const analysis = analyzeExtensionPackage(extensionPkg, corePackageJson, coreNodeModulesDir);

        // Log warnings for version conflicts
        for (const conflict of analysis.versionConflicts) {
          const msg = `Version conflict for "${conflict.packageName}" in extension "${result.name}": requested ${conflict.requestedRange}, installed ${conflict.installedVersion}`;
          logger.warn(msg);
          result.warnings.push(msg);
        }

        // Log warnings for missing peer dependencies
        for (const peer of analysis.missingPeers) {
          const msg = `Missing peer dependency "${peer}" for extension "${result.name}"`;
          logger.warn(msg);
          result.warnings.push(msg);
        }

        // Install dependencies if there are any to install
        if (analysis.depsToInstall.size > 0) {
          const installResult = await this.installDependencies(extensionDir, result.name, analysis);
          result.depsInstalled = installResult.installed;
          if (installResult.error) {
            result.error = installResult.error;
          }
        } else {
          result.depsInstalled = null;
        }
      }
    } catch (err: unknown) {
      const msg = `Resolution failed for extension "${result.name}": ${(err as Error).message}`;
      logger.error(msg);
      result.error = msg;
    }

    return result;
  }

  /**
   * Regenerate tsconfig for a specific extension (manual refresh command).
   *
   * Recomputes path aliases from the current core project location and writes
   * the tsconfig. Does not perform dependency installation. Respects `_managed: false`.
   *
   * @param extensionDir - Absolute path to the extension directory.
   */
  async refreshTsconfig(extensionDir: string): Promise<void> {
    await this.writeTsconfig(extensionDir);
  }
}

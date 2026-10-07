/**
 * Extension UI builder.
 *
 * Compiles the Svelte pages an extension declares in `manifest.ui.pages` into
 * browser ES modules, one per page, plus a stylesheet holding the Tailwind
 * utilities the extension's sources use. The frontend imports a page module and
 * calls its default export, `(target, palim) => unmount`, to mount it.
 *
 * Every bundle carries its own Svelte runtime, pinned to Palim's copy so all
 * extensions compile against the same version. `@palim/ui` resolves to the
 * curated UI kit (`frontend/src/lib/extensionKit.ts`), whose component sources
 * are compiled into the bundle; other frontend internals (`$lib/*`) are not
 * importable from extension code.
 *
 * Results are cached on disk under `EXT_UI_DIR/<extension>/<hash>/`, keyed by a
 * hash of the extension's `ui/` sources, its page declarations, and the core UI
 * kit sources, so unchanged extensions are not rebuilt across restarts.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ExtensionUiPage } from "@shared/extensions";
import { EXT_UI_DIR, FRONTEND_SRC_DIR, PROJECT_DIR } from "@src/config";
import { compile as compileTailwind, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import type { BunPlugin } from "bun";
import { compileModule, compile as compileSvelte, VERSION as SVELTE_VERSION } from "svelte/compiler";

/** URL prefix under which compiled bundles are served. */
export const EXT_UI_URL_PREFIX = "/ext-ui";

/** Directory of the extension UI SDK (`@ext/ui`). */
const EXT_UI_SDK = path.resolve(PROJECT_DIR, "src/extensions/ui/index.ts");

/** The curated UI kit entry (`@palim/ui`). */
const UI_KIT_ENTRY = path.join(FRONTEND_SRC_DIR, "lib/extensionKit.ts");

/** Tailwind theme tokens shared with the host app. */
const THEME_CSS = path.join(FRONTEND_SRC_DIR, "theme.css");

/** The Svelte package every bundle is pinned to. */
const SVELTE_DIR = path.resolve(PROJECT_DIR, "node_modules/svelte");

/** Export conditions applied when resolving pinned packages, in priority order. */
const BROWSER_CONDITIONS = ["svelte", "browser", "import", "default"];

/**
 * Packages extension pages may import without installing them (they ship with
 * Palim's frontend): matched exactly, with optional subpaths.
 */
const PROVIDED_PACKAGES_FILTER = /^(phosphor-svelte|bits-ui|clsx|tailwind-merge|tailwind-variants)(\/.*)?$/;

/** Name of the metadata file written next to a successful build. */
const BUILD_MANIFEST = "build.json";

/** A page declaration from an extension manifest. */
export interface UiPageDeclaration {
  /** Page identifier, unique within the extension. */
  id: string;
  /** Page title. */
  title: string;
  /** Entry component, relative to the extension directory (e.g. `ui/AccountsPage.svelte`). */
  entry: string;
}

/** Input for {@link buildExtensionUi}. */
export interface UiBuildOptions {
  /** Extension name (used for the output path and URLs). */
  name: string;
  /** Absolute extension directory. */
  dir: string;
  /** Declared pages. */
  pages: UiPageDeclaration[];
  /** Output root; defaults to {@link EXT_UI_DIR}. */
  outRoot?: string;
}

/** Result of {@link buildExtensionUi}. Never thrown: failures are reported per page. */
export interface UiBuildResult {
  /** Content hash of the build inputs. */
  hash: string;
  /** Page descriptors for the frontend (with `module`/`css` URLs, or `error`). */
  pages: ExtensionUiPage[];
  /** Whether the result was served from the on-disk cache. */
  cached: boolean;
}

/** Metadata persisted with a successful build. */
interface BuildManifest {
  pages: Record<string, { module: string; css?: string }>;
}

/**
 * Picks the target of a package `exports` entry for the given conditions.
 *
 * @param target - An exports value (string, condition map, or array)
 * @param conditions - Accepted conditions in priority order
 * @returns The selected relative path, or null when nothing matches
 */
function selectExportTarget(target: unknown, conditions: string[]): string | null {
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const selected = selectExportTarget(item, conditions);
      if (selected) return selected;
    }
    return null;
  }
  if (target && typeof target === "object") {
    for (const [key, value] of Object.entries(target)) {
      if (conditions.includes(key)) {
        const selected = selectExportTarget(value, conditions);
        if (selected) return selected;
      }
    }
  }
  return null;
}

/**
 * Resolves a package specifier against a package directory using its `exports`
 * map and browser conditions (Bun's runtime resolver would pick server builds).
 *
 * @param pkgDir - Absolute package directory
 * @param subpath - Subpath within the package (`"."` or `"./internal/client"`)
 * @param conditions - Accepted conditions in priority order
 * @returns The absolute file path
 * @throws {Error} When the subpath is not exported
 */
export function resolvePackageExport(
  pkgDir: string,
  subpath: string,
  conditions: string[] = BROWSER_CONDITIONS,
): string {
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
    exports?: unknown;
    module?: string;
    main?: string;
  };
  const exportsField = pkg.exports;
  if (exportsField === undefined) {
    const file = subpath === "." ? (pkg.module ?? pkg.main ?? "index.js") : subpath;
    return path.join(pkgDir, file);
  }
  const map: Record<string, unknown> =
    typeof exportsField === "string" ||
    Array.isArray(exportsField) ||
    !Object.keys(exportsField as object)[0]?.startsWith(".")
      ? { ".": exportsField }
      : (exportsField as Record<string, unknown>);

  let selected: string | null = null;
  if (subpath in map) {
    selected = selectExportTarget(map[subpath], conditions);
  } else {
    for (const [key, value] of Object.entries(map)) {
      const star = key.indexOf("*");
      if (star === -1) continue;
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1) {
        const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
        selected = selectExportTarget(value, conditions)?.replaceAll("*", middle) ?? null;
        if (selected) break;
      }
    }
  }
  if (!selected) throw new Error(`Package at ${pkgDir} does not export "${subpath}"`);
  return path.join(pkgDir, selected);
}

/**
 * Hashes every file matched by a glob below a directory (path + content).
 *
 * @param hash - Hash to update
 * @param dir - Base directory
 * @param pattern - Glob pattern relative to `dir`
 */
async function hashFiles(hash: ReturnType<typeof createHash>, dir: string, pattern: string): Promise<void> {
  const files: string[] = [];
  for await (const rel of new Bun.Glob(pattern).scan({ cwd: dir, onlyFiles: true })) {
    if (rel.split(path.sep).includes("node_modules")) continue;
    files.push(rel);
  }
  files.sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(new Uint8Array(await Bun.file(path.join(dir, rel)).arrayBuffer()));
    hash.update("\0");
  }
}

/** Memoized fingerprint of the core sources compiled into every bundle. */
let coreFingerprint: Promise<string> | null = null;

/**
 * Fingerprints the core UI sources (builder, kit, theme, compiler version) so
 * extension bundles rebuild when Palim's build pipeline or UI kit changes.
 *
 * @returns Hex digest
 */
function getCoreFingerprint(): Promise<string> {
  coreFingerprint ??= (async () => {
    const hash = createHash("sha256");
    // The builder's own source: pipeline changes invalidate every cached bundle.
    hash.update(await Bun.file(import.meta.path).text());
    hash.update(`|svelte@${SVELTE_VERSION}`);
    await hashFiles(hash, path.join(FRONTEND_SRC_DIR, "lib"), "{extensionKit.ts,utils.ts,components/**/*}");
    await hashFiles(
      hash,
      FRONTEND_SRC_DIR,
      "{theme.css,components/MultiSelect.svelte,components/StatusDot.svelte,components/multiSelectFilter.ts}",
    );
    return hash.digest("hex");
  })();
  return coreFingerprint;
}

/**
 * Computes the cache key for an extension's UI build.
 *
 * @param dir - Extension directory
 * @param pages - Declared pages
 * @returns Short hex hash
 */
export async function computeUiHash(dir: string, pages: UiPageDeclaration[]): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await getCoreFingerprint());
  hash.update(JSON.stringify(pages));
  await hashFiles(hash, path.join(dir, "ui"), "**/*");
  return hash.digest("hex").slice(0, 16);
}

/**
 * Checks whether a path lies inside a directory.
 *
 * @param file - Absolute path
 * @param dir - Absolute directory
 * @returns True when `file` is `dir` or below it
 */
function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Prefixes a Svelte compiler error with its source location, which Bun's build
 * logs would otherwise drop.
 *
 * @param err - The compiler error (carries `start: { line, column }`)
 * @param file - Absolute source path
 * @param extensionDir - Extension directory for a shorter path
 * @returns An error with a `file:line:column: message` message
 */
function withSvelteLocation(err: unknown, file: string, extensionDir: string): Error {
  const start = (err as { start?: { line: number; column: number } }).start;
  const message = err instanceof Error ? err.message : String(err);
  const where = start
    ? `${path.relative(extensionDir, file)}:${start.line}:${start.column}`
    : path.relative(extensionDir, file);
  return new Error(`${where}: ${message}`);
}

/**
 * Creates the Bun plugin that compiles Svelte sources and applies Palim's
 * resolution rules (pinned Svelte runtime, `@palim/ui`, `@ext/ui`, guarded `$lib`).
 *
 * @param extensionDir - The extension directory (for error messages and provided-package resolution)
 * @returns The plugin
 */
function createSveltePlugin(extensionDir: string): BunPlugin {
  return {
    name: "palim-extension-ui",
    setup(build) {
      // One Svelte runtime per bundle, regardless of who imports it (extension
      // code, the UI kit, bits-ui in frontend/node_modules, ...).
      // Every resolve hook below has an exact filter and always returns a path:
      // with Bun 1.3, an onResolve hook that returns undefined (to fall through
      // to the default resolver) silently drops the import from the bundle.
      build.onResolve({ filter: /^svelte(\/.*)?$/ }, (args) => {
        const subpath = args.path === "svelte" ? "." : `.${args.path.slice("svelte".length)}`;
        return { path: resolvePackageExport(SVELTE_DIR, subpath) };
      });

      build.onResolve({ filter: /^@palim\/ui$/ }, () => ({ path: UI_KIT_ENTRY }));
      build.onResolve({ filter: /^@ext\/ui$/ }, () => ({ path: EXT_UI_SDK }));

      // `$lib` is the frontend's internal alias: valid inside the kit sources,
      // rejected from extension code (it would duplicate stateful host modules).
      build.onResolve({ filter: /^\$lib(\/.*)?$/ }, (args) => {
        if (!isInside(args.importer, FRONTEND_SRC_DIR)) {
          const where = path.relative(extensionDir, args.importer) || args.importer;
          throw new Error(
            `${where}: "${args.path}" is internal to Palim and cannot be imported by extensions. Import UI components from "@palim/ui" and use the \`palim\` host object for app state.`,
          );
        }
        const target = path.join(FRONTEND_SRC_DIR, "lib", args.path.slice("$lib".length));
        return { path: Bun.resolveSync(target, path.dirname(args.importer)) };
      });

      // UI packages Palim provides to extensions (icons, primitives, class
      // helpers), resolved from the extension's own install when present, else
      // from Palim's frontend. The filter matches these packages exactly and the
      // hook always returns a path (see the note above).
      build.onResolve({ filter: PROVIDED_PACKAGES_FILTER }, (args) => {
        const pkgName = args.path.split("/")[0] ?? args.path;
        const subpath = `.${args.path.slice(pkgName.length)}`;
        const candidates = [
          path.join(extensionDir, "node_modules", pkgName),
          path.join(FRONTEND_SRC_DIR, "..", "node_modules", pkgName),
          path.join(PROJECT_DIR, "node_modules", pkgName),
        ];
        const pkgDir = candidates.find((dir) => existsSync(path.join(dir, "package.json")));
        if (!pkgDir) throw new Error(`Package "${pkgName}" is not installed`);
        return { path: resolvePackageExport(pkgDir, subpath) };
      });

      build.onLoad({ filter: /\.svelte$/ }, async (args) => {
        const source = await Bun.file(args.path).text();
        try {
          const result = compileSvelte(source, {
            filename: args.path,
            generate: "client",
            css: "injected",
            dev: false,
          });
          return { contents: result.js.code, loader: "js" };
        } catch (err) {
          throw withSvelteLocation(err, args.path, extensionDir);
        }
      });

      build.onLoad({ filter: /\.svelte\.(ts|js)$/ }, async (args) => {
        let source = await Bun.file(args.path).text();
        if (args.path.endsWith(".ts")) {
          source = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
        }
        try {
          const result = compileModule(source, { filename: args.path, generate: "client", dev: false });
          return { contents: result.js.code, loader: "js" };
        } catch (err) {
          throw withSvelteLocation(err, args.path, extensionDir);
        }
      });
    },
  };
}

/**
 * Compiles the Tailwind utilities used by an extension's UI sources against
 * the host theme. Only utilities are emitted: the host already ships preflight
 * and base styles, and cascade layers merge across stylesheets by name.
 *
 * @param uiDir - The extension's `ui/` directory
 * @returns Minified CSS, or an empty string when no utilities are used
 */
async function buildTailwindCss(uiDir: string): Promise<string> {
  const input = [
    `@import "tailwindcss/theme.css" layer(theme);`,
    `@import "tailwindcss/utilities.css" layer(utilities);`,
    `@import ${JSON.stringify(THEME_CSS)};`,
    `@source ${JSON.stringify(uiDir)};`,
  ].join("\n");
  const compiler = await compileTailwind(input, { base: PROJECT_DIR, onDependency: () => {} });
  const candidates = new Scanner({ sources: compiler.sources }).scan();
  if (candidates.length === 0) return "";
  return optimize(compiler.build(candidates), { minify: true }).code;
}

/**
 * Formats Bun build logs into a readable error message.
 *
 * @param logs - Build logs
 * @param dir - Extension directory (paths are shown relative to it)
 * @returns The message
 */
function formatBuildLogs(logs: Array<BuildMessage | ResolveMessage>, dir: string): string {
  const lines = logs
    .filter((log) => log.level === "error")
    .map((log) => {
      // Plugin errors carry their own location prefix and a 0:0 position.
      const pos = log.position;
      const where = pos?.file && pos.line > 0 ? `${path.relative(dir, pos.file)}:${pos.line}:${pos.column}: ` : "";
      return `${where}${log.message}`;
    });
  return lines.length > 0 ? lines.join("\n") : "Build failed";
}

/**
 * Converts any thrown value into a message.
 *
 * @param err - The thrown value
 * @param dir - Extension directory for shortening paths
 * @returns The message
 */
function errorMessage(err: unknown, dir: string): string {
  if (err instanceof AggregateError) {
    return formatBuildLogs(err.errors as Array<BuildMessage | ResolveMessage>, dir);
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Validates a page declaration's entry path.
 *
 * @param dir - Extension directory
 * @param entry - Declared entry
 * @returns The absolute entry path
 * @throws {Error} When the entry escapes `ui/`, is not a .svelte file, or does not exist
 */
async function resolveEntry(dir: string, entry: string): Promise<string> {
  const abs = path.resolve(dir, entry);
  if (!isInside(abs, path.join(dir, "ui")) || !abs.endsWith(".svelte")) {
    throw new Error(`Page entry "${entry}" must be a .svelte file inside the extension's ui/ directory`);
  }
  if (!(await Bun.file(abs).exists())) throw new Error(`Page entry "${entry}" does not exist`);
  return abs;
}

/**
 * Builds (or loads from cache) an extension's UI pages.
 *
 * @param options - Extension name, directory, declared pages, and output root
 * @returns Page descriptors with module/CSS URLs, or per-page errors
 */
export async function buildExtensionUi(options: UiBuildOptions): Promise<UiBuildResult> {
  const { name, dir, pages } = options;
  const outRoot = options.outRoot ?? EXT_UI_DIR;
  const extOut = path.join(outRoot, name);
  const failed = (hash: string, message: string): UiBuildResult => ({
    hash,
    cached: false,
    pages: pages.map((p) => ({ id: p.id, title: p.title, error: message })),
  });

  let hash: string;
  try {
    hash = await computeUiHash(dir, pages);
  } catch (err) {
    return failed("", errorMessage(err, dir));
  }

  const toResult = (manifest: BuildManifest, cached: boolean): UiBuildResult => ({
    hash,
    cached,
    pages: pages.map((p) => {
      const files = manifest.pages[p.id];
      const base = `${EXT_UI_URL_PREFIX}/${name}/${hash}`;
      return files
        ? {
            id: p.id,
            title: p.title,
            module: `${base}/${files.module}`,
            ...(files.css ? { css: `${base}/${files.css}` } : {}),
          }
        : { id: p.id, title: p.title, error: "Page missing from build output" };
    }),
  });

  const finalDir = path.join(extOut, hash);
  const manifestFile = Bun.file(path.join(finalDir, BUILD_MANIFEST));
  if (await manifestFile.exists()) {
    return toResult((await manifestFile.json()) as BuildManifest, true);
  }

  const tmpDir = path.join(extOut, `.tmp-${hash}-${Date.now()}`);
  try {
    const entriesDir = path.join(tmpDir, "_entries");
    const outDir = path.join(tmpDir, "out");
    await mkdir(entriesDir, { recursive: true });

    // One wrapper per page: mounts the component with the page's own runtime.
    const entrypoints: string[] = [];
    for (const page of pages) {
      const entry = await resolveEntry(dir, page.entry);
      const wrapper = path.join(entriesDir, `${page.id}.js`);
      await Bun.write(
        wrapper,
        [
          `import Page from ${JSON.stringify(entry)};`,
          `import { mount, unmount } from "svelte";`,
          `export default function mountPage(target, palim) {`,
          `  const instance = mount(Page, { target, props: { palim } });`,
          `  return () => unmount(instance);`,
          `}`,
        ].join("\n"),
      );
      entrypoints.push(wrapper);
    }

    const result = await Bun.build({
      entrypoints,
      outdir: outDir,
      target: "browser",
      format: "esm",
      splitting: true,
      minify: true,
      conditions: ["svelte", "production"],
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]", asset: "asset-[hash].[ext]" },
      plugins: [createSveltePlugin(dir)],
      throw: false,
    });
    if (!result.success) return failed(hash, formatBuildLogs(result.logs, dir));

    // Stylesheet: Tailwind utilities plus any CSS files the sources imported.
    const cssParts: string[] = [await buildTailwindCss(path.join(dir, "ui"))];
    const manifest: BuildManifest = { pages: {} };
    for (const output of result.outputs) {
      const file = path.relative(outDir, output.path);
      if (output.kind === "entry-point" && file.endsWith(".js")) {
        const id = path.basename(file).replace(/-[^-]+\.js$/, "");
        manifest.pages[id] = { module: file };
      } else if (file.endsWith(".css")) {
        cssParts.push(await output.text());
        await rm(output.path);
      }
    }
    const css = cssParts.filter((part) => part.trim()).join("\n");
    if (css) {
      const cssName = `styles-${createHash("sha256").update(css).digest("hex").slice(0, 8)}.css`;
      await Bun.write(path.join(outDir, cssName), css);
      for (const files of Object.values(manifest.pages)) files.css = cssName;
    }
    await Bun.write(path.join(outDir, BUILD_MANIFEST), JSON.stringify(manifest));

    // Publish atomically, then drop older builds of this extension.
    await rm(finalDir, { recursive: true, force: true });
    await rename(outDir, finalDir);
    await removeStaleBuilds(extOut, hash);
    return toResult(manifest, false);
  } catch (err) {
    return failed(hash, errorMessage(err, dir));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Removes every build directory of an extension except the current one.
 *
 * @param extOut - The extension's output directory
 * @param keep - Hash of the build to keep
 */
async function removeStaleBuilds(extOut: string, keep: string): Promise<void> {
  const entries = await readdir(extOut).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => entry !== keep && !entry.startsWith(".tmp-"))
      .map((entry) => rm(path.join(extOut, entry), { recursive: true, force: true })),
  );
}

/**
 * Removes all compiled UI bundles of an extension (e.g. when it is unloaded).
 *
 * @param name - Extension name
 * @param outRoot - Output root; defaults to {@link EXT_UI_DIR}
 */
export async function removeExtensionUi(name: string, outRoot: string = EXT_UI_DIR): Promise<void> {
  await rm(path.join(outRoot, name), { recursive: true, force: true });
}

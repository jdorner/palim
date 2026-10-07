/**
 * Tests for the extension UI builder: Svelte compilation, Palim resolution
 * rules (`@palim/ui`, pinned Svelte, provided packages, guarded `$lib`),
 * Tailwind output, caching, and error reporting.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROJECT_DIR } from "@src/config";
import { buildExtensionUi, resolvePackageExport, type UiPageDeclaration } from "./uiBuilder";

let root: string;
let outRoot: string;

/**
 * Writes a fixture extension's ui/ files.
 *
 * @param name - Extension directory name
 * @param files - Map of path (relative to the extension) to content
 * @returns The extension directory
 */
async function fixture(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    await Bun.write(path.join(dir, rel), content);
  }
  return dir;
}

const PAGE: UiPageDeclaration = { id: "main", title: "Main", entry: "ui/Page.svelte" };

const VALID_PAGE = `<script lang="ts">
  import type { PalimHost } from "@ext/ui";
  import { Button, Card, CardContent } from "@palim/ui";
  import StarIcon from "phosphor-svelte/lib/StarIcon";
  import { counter } from "./counter.svelte.ts";
  let { palim }: { palim: PalimHost } = $props();
  const c = counter();
</script>
<Card><CardContent class="p-6 text-emerald-600">
  <StarIcon /> {palim.extension.name}
  <Button onclick={() => c.inc()}>Count {c.value}</Button>
</CardContent></Card>
`;

const COUNTER = `export function counter() {
  let value = $state(0);
  return { get value() { return value; }, inc() { value++; } };
}
`;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "palim-ui-builder-"));
  outRoot = path.join(root, "out");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildExtensionUi", () => {
  test("compiles a page using the UI kit, a provided package, and a runes module", async () => {
    const dir = await fixture("valid", { "ui/Page.svelte": VALID_PAGE, "ui/counter.svelte.ts": COUNTER });

    const result = await buildExtensionUi({ name: "valid", dir, pages: [PAGE], outRoot });

    expect(result.cached).toBe(false);
    const [page] = result.pages;
    expect(page?.error).toBeUndefined();
    expect(page?.module).toMatch(new RegExp(`^/ext-ui/valid/${result.hash}/main-[^/]+\\.js$`));
    expect(page?.css).toMatch(new RegExp(`^/ext-ui/valid/${result.hash}/styles-[^/]+\\.css$`));

    const outDir = path.join(outRoot, "valid", result.hash);
    const js = await Bun.file(path.join(outDir, path.basename(page!.module!))).text();
    expect(js).toContain("export");
    // The bits-ui primitives used by the kit must be bundled, not dropped.
    expect(js).not.toMatch(/from\s*["']bits-ui["']/);

    const css = await Bun.file(path.join(outDir, path.basename(page!.css!))).text();
    expect(css).toContain(".text-emerald-600");
    expect(css).toContain(".p-6");
    expect(css).not.toContain("preflight");
  }, 60_000);

  test("the compiled module can be imported", async () => {
    const result = await buildExtensionUi({ name: "valid", dir: path.join(root, "valid"), pages: [PAGE], outRoot });
    const file = path.join(outRoot, "valid", result.hash, path.basename(result.pages[0]!.module!));
    const mod = await import(file);
    expect(typeof mod.default).toBe("function");
  }, 60_000);

  test("serves an unchanged extension from the cache and rebuilds on change", async () => {
    const dir = path.join(root, "valid");
    const first = await buildExtensionUi({ name: "valid", dir, pages: [PAGE], outRoot });
    expect(first.cached).toBe(true);

    await Bun.write(path.join(dir, "ui/Page.svelte"), `${VALID_PAGE}\n<p class="mt-3">changed</p>\n`);
    const second = await buildExtensionUi({ name: "valid", dir, pages: [PAGE], outRoot });
    expect(second.cached).toBe(false);
    expect(second.hash).not.toBe(first.hash);
    // Older builds of the extension are removed.
    expect(await readdir(path.join(outRoot, "valid"))).toEqual([second.hash]);
  }, 60_000);

  test("rejects frontend internals imported from extension code", async () => {
    const dir = await fixture("internal", {
      "ui/Page.svelte": `<script>\n  import { authFetch } from "$lib/auth";\n</script>\n<p>x</p>\n`,
    });
    const result = await buildExtensionUi({ name: "internal", dir, pages: [PAGE], outRoot });
    expect(result.pages[0]?.module).toBeUndefined();
    expect(result.pages[0]?.error).toContain(`"$lib/auth" is internal to Palim`);
  }, 60_000);

  test("reports Svelte syntax errors with their location", async () => {
    const dir = await fixture("syntax", { "ui/Page.svelte": `<script>\n  let x = ;\n</script>\n<p>{x}</p>\n` });
    const result = await buildExtensionUi({ name: "syntax", dir, pages: [PAGE], outRoot });
    expect(result.pages[0]?.error).toMatch(/^ui\/Page\.svelte:2:\d+: /);
  }, 60_000);

  test("rejects entries outside ui/ and missing entries", async () => {
    const dir = await fixture("entries", { "ui/Page.svelte": "<p>x</p>\n", "Outside.svelte": "<p>x</p>\n" });
    const outside = await buildExtensionUi({
      name: "entries",
      dir,
      pages: [{ id: "main", title: "Main", entry: "ui/../Outside.svelte" }],
      outRoot,
    });
    expect(outside.pages[0]?.error).toContain("inside the extension's ui/ directory");

    const missing = await buildExtensionUi({
      name: "entries",
      dir,
      pages: [{ id: "main", title: "Main", entry: "ui/Missing.svelte" }],
      outRoot,
    });
    expect(missing.pages[0]?.error).toContain("does not exist");
  });
});

describe("resolvePackageExport", () => {
  const svelteDir = path.join(PROJECT_DIR, "node_modules/svelte");

  test("prefers browser builds over server builds", () => {
    expect(resolvePackageExport(svelteDir, ".")).toEndWith("/src/index-client.js");
    expect(resolvePackageExport(svelteDir, "./store")).toEndWith("/src/store/index-client.js");
  });

  test("resolves subpath patterns with the svelte condition", () => {
    const phosphor = path.join(PROJECT_DIR, "frontend/node_modules/phosphor-svelte");
    expect(resolvePackageExport(phosphor, "./lib/StarIcon")).toEndWith("/lib/StarIcon.svelte");
  });

  test("throws for subpaths the package does not export", () => {
    expect(() => resolvePackageExport(svelteDir, "./does-not-exist")).toThrow('does not export "./does-not-exist"');
  });
});

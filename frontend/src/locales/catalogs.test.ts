import { describe, expect, test } from "bun:test";
import path from "node:path";
import { diffCatalogKeys, type Messages, SUPPORTED_LOCALES } from "$shared/i18n";

const CORE_DIR = import.meta.dir;
const EXTENSIONS_DIR = path.resolve(import.meta.dir, "../../../src/extensions");

/** Catalog directories: the core UI catalogs plus every extension's `locales/`. */
const catalogDirs = [
  { name: "core", dir: CORE_DIR },
  ...[...new Bun.Glob("**/locales/en.json").scanSync({ cwd: EXTENSIONS_DIR })].map((file) => ({
    name: `extension ${path.dirname(path.dirname(file))}`,
    dir: path.join(EXTENSIONS_DIR, path.dirname(file)),
  })),
];

describe("translation catalogs", () => {
  for (const { name, dir } of catalogDirs) {
    for (const locale of SUPPORTED_LOCALES.filter((l) => l !== "en")) {
      test(`${name}: ${locale} has the same keys as en`, async () => {
        const en = (await Bun.file(path.join(dir, "en.json")).json()) as Messages;
        const translated = (await Bun.file(path.join(dir, `${locale}.json`)).json()) as Messages;
        expect(diffCatalogKeys(en, translated)).toEqual({ missing: [], extra: [] });
      });
    }
  }

  test("core catalog keys are all referenced by the frontend", async () => {
    const en = (await Bun.file(path.join(CORE_DIR, "en.json")).json()) as Messages;
    const sources = await Promise.all(
      [...new Bun.Glob("**/*.{svelte,ts}").scanSync({ cwd: path.dirname(CORE_DIR) })]
        .filter((f) => !f.endsWith(".test.ts"))
        .map((f) => Bun.file(path.join(path.dirname(CORE_DIR), f)).text()),
    );
    const code = sources.join("\n");
    // Keys built dynamically from a prefix (e.g. `status.${s}`) are referenced by that prefix.
    const dynamicPrefixes = [...code.matchAll(/["`]([a-zA-Z]+(?:\.[a-zA-Z-]+)*\.)\$\{/g)].map((m) => m[1] ?? "");
    const unused = flatKeys(en)
      .map((k) => k.replace(/_(zero|one|two|few|many|other)$/, ""))
      .filter((k) => !code.includes(`"${k}"`) && !dynamicPrefixes.some((p) => k.startsWith(p)));
    expect([...new Set(unused)]).toEqual([]);
  });
});

/**
 * Flattens a catalog to dot keys.
 *
 * @param messages - Nested catalog
 * @param prefix - Key prefix
 * @returns The keys
 */
function flatKeys(messages: Messages, prefix = ""): string[] {
  return Object.entries(messages).flatMap(([key, value]) =>
    typeof value === "string" ? [`${prefix}${key}`] : flatKeys(value, `${prefix}${key}.`),
  );
}

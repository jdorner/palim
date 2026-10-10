import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensionLocales } from "./localeLoader";

describe("loadExtensionLocales", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `ext-locales-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns an empty map without a locales directory", async () => {
    expect(await loadExtensionLocales("demo", dir)).toEqual({});
  });

  test("loads valid catalogs for supported locales", async () => {
    await Bun.write(join(dir, "locales/en.json"), JSON.stringify({ nav: { "/demo": "Demo" }, title: "Hello" }));
    await Bun.write(join(dir, "locales/de.json"), JSON.stringify({ title: "Hallo" }));
    expect(await loadExtensionLocales("demo", dir)).toEqual({
      en: { nav: { "/demo": "Demo" }, title: "Hello" },
      de: { title: "Hallo" },
    });
  });

  test("skips unsupported locales, malformed JSON, and non-string leaves", async () => {
    await Bun.write(join(dir, "locales/en.json"), JSON.stringify({ title: "Hello" }));
    await Bun.write(join(dir, "locales/xx.json"), JSON.stringify({ title: "?" }));
    await Bun.write(join(dir, "locales/de.json"), "{ not json");
    expect(await loadExtensionLocales("demo", dir)).toEqual({ en: { title: "Hello" } });

    await Bun.write(join(dir, "locales/de.json"), JSON.stringify({ count: 3 }));
    expect(await loadExtensionLocales("demo", dir)).toEqual({ en: { title: "Hello" } });
  });
});

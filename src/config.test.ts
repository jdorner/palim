import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathInside, resolveConfigPath } from "@src/config";

const root = mkdtempSync(join(tmpdir(), "palim-config-test-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isPathInside", () => {
  test("detects equal and nested paths", () => {
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(join(root, "a", "b"), root)).toBe(true);
  });

  test("rejects siblings and parents, including name prefixes", () => {
    expect(isPathInside(`${root}-other`, root)).toBe(false);
    expect(isPathInside(join(root, ".."), root)).toBe(false);
    expect(isPathInside(join(root, "work"), join(root, "work", "sub"))).toBe(false);
  });

  test("resolves symlinks for paths that do not exist yet", () => {
    const work = join(root, "work");
    mkdirSync(work);
    const link = join(root, "link");
    symlinkSync(work, link);
    expect(isPathInside(join(link, ".palim", "extensions"), work)).toBe(true);
    expect(isPathInside(join(work, "x"), link)).toBe(true);
  });
});

describe("resolveConfigPath", () => {
  test("expands a leading ~/ to the home directory", () => {
    expect(resolveConfigPath("~/palim/data", "/project", "DATA_DIR", "/home/u")).toBe("/home/u/palim/data");
  });

  test("expands a bare ~ to the home directory", () => {
    expect(resolveConfigPath("~", "/project", "DATA_DIR", "/home/u")).toBe("/home/u");
  });

  test("resolves relative paths against the base directory", () => {
    expect(resolveConfigPath(".work/.palim", "/project", "DATA_DIR", "/home/u")).toBe("/project/.work/.palim");
  });

  test("keeps absolute paths and normalizes them", () => {
    expect(resolveConfigPath("/data/palim/", "/project", "DATA_DIR", "/home/u")).toBe("/data/palim");
  });

  test("does not expand ~ inside a path or ~user", () => {
    expect(resolveConfigPath("~other/x", "/project", "DATA_DIR", "/home/u")).toBe("/project/~other/x");
  });

  test("throws when ~ is used without a home directory", () => {
    expect(() => resolveConfigPath("~/x", "/project", "DATA_DIR", "")).toThrow("DATA_DIR uses ~ but $HOME is not set");
  });
});

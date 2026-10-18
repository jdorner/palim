import { describe, expect, test } from "bun:test";
import { resolveConfigPath } from "./config";

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

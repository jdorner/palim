/**
 * Tests for the public `/ext-ui/*` bundle file handler.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveExtensionUiAsset } from "./extensionUiAssets";

let base: string;
let root: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "palim-ext-ui-"));
  root = path.join(base, "ext-ui");
  await Bun.write(path.join(root, "demo/abc123/main-x1.js"), "export default () => () => {};");
  await Bun.write(path.join(root, "demo/abc123/styles-y2.css"), ".p-6{padding:1.5rem}");
  await Bun.write(path.join(root, "demo/.tmp-abc/main.js"), "partial");
  await Bun.write(path.join(base, "secret.txt"), "outside the root");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("serveExtensionUiAsset", () => {
  test("serves bundle files with content type and immutable caching", async () => {
    const js = await serveExtensionUiAsset("/ext-ui/demo/abc123/main-x1.js", root);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await js.text()).toBe("export default () => () => {};");

    const css = await serveExtensionUiAsset("/ext-ui/demo/abc123/styles-y2.css", root);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  test.each([
    ["missing file", "/ext-ui/demo/abc123/nope.js"],
    ["directory", "/ext-ui/demo/abc123"],
    ["parent traversal", "/ext-ui/../secret.txt"],
    ["encoded traversal", "/ext-ui/demo/%2e%2e/%2e%2e/secret.txt"],
    ["in-progress build", "/ext-ui/demo/.tmp-abc/main.js"],
    ["malformed encoding", "/ext-ui/demo/%E0%A4%A"],
    ["wrong prefix", "/ext/demo/abc123/main-x1.js"],
  ])("returns 404 for %s", async (_label, pathname) => {
    const res = await serveExtensionUiAsset(pathname, root);
    expect(res.status).toBe(404);
  });
});

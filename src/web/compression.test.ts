/**
 * Tests for the compression plugin's handling of Response objects.
 */

import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { compression } from "./compression";

describe("compression", () => {
  test("keeps the original response headers when compressing a Response", async () => {
    const body = "x".repeat(4096);
    const app = new Elysia().use(compression()).get(
      "/asset.js",
      () =>
        new Response(body, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        }),
    );

    const res = await app.handle(new Request("http://localhost/asset.js", { headers: { "accept-encoding": "gzip" } }));

    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())))).toBe(body);
  });

  test("keeps the original response headers below the compression threshold", async () => {
    const app = new Elysia()
      .use(compression())
      .get(
        "/small",
        () => new Response("ok", { headers: { "content-type": "text/plain", "referrer-policy": "no-referrer" } }),
      );

    const res = await app.handle(new Request("http://localhost/small", { headers: { "accept-encoding": "gzip" } }));

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toBe("ok");
  });

  test("compresses binary Response bodies byte-for-byte (no text decoding)", async () => {
    // Invalid UTF-8 sequences would be replaced with U+FFFD if the body were decoded as text
    const bytes = new Uint8Array(4096).map((_, i) => (i * 37 + 0x80) % 256);
    const app = new Elysia()
      .use(compression())
      .get("/bin", () => new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));

    const res = await app.handle(new Request("http://localhost/bin", { headers: { "accept-encoding": "gzip" } }));

    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer()))).toEqual(bytes);
  });

  test("passes Office Open XML (xlsx) responses through untouched", async () => {
    const bytes = new Uint8Array(4096).map((_, i) => (i * 37 + 0x80) % 256);
    const contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const app = new Elysia()
      .use(compression())
      .get("/export.xlsx", () => new Response(bytes, { headers: { "content-type": contentType } }));

    const res = await app.handle(
      new Request("http://localhost/export.xlsx", { headers: { "accept-encoding": "gzip" } }),
    );

    expect(res.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });
});

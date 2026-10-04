import { describe, expect, test } from "bun:test";
import { ensureOk, responseError } from "./http";

describe("responseError", () => {
  test("uses the JSON error field", async () => {
    const res = new Response(JSON.stringify({ error: "Invalid key" }), { status: 400 });
    expect(await responseError(res)).toBe("Invalid key");
  });

  test("falls back to the status for a non-JSON body", async () => {
    expect(await responseError(new Response("oops", { status: 502 }))).toBe("HTTP 502");
  });

  test("falls back to the status when the body has no error field", async () => {
    expect(await responseError(new Response("null", { status: 500 }))).toBe("HTTP 500");
  });
});

describe("ensureOk", () => {
  test("returns an OK response unchanged", async () => {
    const res = new Response("{}", { status: 200 });
    expect(await ensureOk(res)).toBe(res);
  });

  test("throws with the extracted message", async () => {
    const res = new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
    expect(ensureOk(res)).rejects.toThrow("Forbidden");
  });
});

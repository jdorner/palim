import { describe, expect, test } from "bun:test";
import { parsePayloadText, payloadSkeleton } from "./payloadSkeleton";

describe("payloadSkeleton", () => {
  test("no schema gives an empty object", () => {
    expect(payloadSkeleton(undefined)).toEqual({});
    expect(payloadSkeleton({})).toEqual({});
  });

  test("each leaf type gets its placeholder", () => {
    expect(
      payloadSkeleton({ s: "string", n: "number", b: "boolean", o: "object", a: "any", x: "unknown-hint" }),
    ).toEqual({ s: "", n: 0, b: false, o: {}, a: null, x: null });
  });

  test("arrays become empty arrays and nested maps are recursed", () => {
    expect(
      payloadSkeleton({ tags: ["string"], items: [{ id: "string" }], task: { id: "string", meta: { n: "number" } } }),
    ).toEqual({
      tags: [],
      items: [],
      task: { id: "", meta: { n: 0 } },
    });
  });
});

describe("parsePayloadText", () => {
  test("accepts any JSON value", () => {
    expect(parsePayloadText('{"month":"2026-10"}')).toEqual({ ok: true, value: { month: "2026-10" } });
    expect(parsePayloadText("[1]")).toEqual({ ok: true, value: [1] });
  });

  test("rejects invalid and empty text", () => {
    expect(parsePayloadText("{month: 1")).toEqual({ ok: false });
    expect(parsePayloadText("   ")).toEqual({ ok: false });
  });
});

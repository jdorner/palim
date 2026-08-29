import { describe, expect, test } from "bun:test";
import { buildEvalScope, evaluateExpression, referencesForbiddenKey } from "./templateEval";

describe("referencesForbiddenKey", () => {
  test("flags constructor / prototype / __proto__ / dunders", () => {
    expect(referencesForbiddenKey("constructor")).toBe(true);
    expect(referencesForbiddenKey("x.prototype")).toBe(true);
    expect(referencesForbiddenKey("image.__proto__")).toBe(true);
    expect(referencesForbiddenKey("a.__defineGetter__")).toBe(true);
    expect(referencesForbiddenKey('x["constructor"]')).toBe(true);
  });

  test("allows ordinary paths and function calls", () => {
    expect(referencesForbiddenKey("image.dataUrl")).toBe(false);
    expect(referencesForbiddenKey("stripDataUri(image.dataUrl)")).toBe(false);
    expect(referencesForbiddenKey("steps.fetch.result.body")).toBe(false);
  });
});

describe("buildEvalScope", () => {
  test("produces a null-prototype object", () => {
    const scope = buildEvalScope({ a: 1 });
    expect(Object.getPrototypeOf(scope)).toBeNull();
  });

  test("bare prototype-chain keys resolve to undefined", () => {
    const scope = buildEvalScope({ a: 1 });
    expect((scope as Record<string, unknown>).constructor).toBeUndefined();
    expect((scope as Record<string, unknown>).toString).toBeUndefined();
  });

  test("includes registered functions and provided namespaces", () => {
    const scope = buildEvalScope({ image: { dataUrl: "x" } });
    expect(typeof scope.stripDataUri).toBe("function");
    expect(scope.image).toEqual({ dataUrl: "x" });
  });
});

describe("evaluateExpression", () => {
  describe("evaluation", () => {
    test("evaluates a path lookup", () => {
      const r = evaluateExpression("image.dataUrl", { image: { dataUrl: "hello" } });
      expect(r.ok).toBe(true);
      expect(r.value).toBe("hello");
    });

    test("evaluates a function call over a path", () => {
      const r = evaluateExpression("stripDataUri(image.dataUrl)", {
        image: { dataUrl: "data:image/jpeg;base64,ABC" },
      });
      expect(r.ok).toBe(true);
      expect(r.value).toBe("ABC");
    });

    test("evaluates nested/composed function calls", () => {
      const r = evaluateExpression("jsonEscape(stripDataUri(image.dataUrl))", {
        image: { dataUrl: 'data:text/plain;base64,QUJD"' },
      });
      expect(r.ok).toBe(true);
      // stripDataUri removes the prefix, jsonEscape escapes the trailing quote
      expect(r.value).toBe('QUJD\\"');
    });
  });

  describe("sandbox (self-enforced; subscript's guard is bypassable)", () => {
    test("constructor escape does NOT return host process and is refused", () => {
      const hostProcess = (globalThis as { process?: unknown }).process;
      const r = evaluateExpression('constructor.constructor("return process")()', {});
      expect(r.ok).toBe(false);
      expect(r.value).not.toBe(hostProcess);
      expect(r.value).toBeUndefined();
      expect(r.warning).toContain("Forbidden key");
    });

    test("__proto__ access is refused", () => {
      const r = evaluateExpression("image.__proto__", { image: {} });
      expect(r.ok).toBe(false);
      expect(r.warning).toContain("Forbidden key");
    });

    test("prototype access is refused", () => {
      const r = evaluateExpression("x.prototype", { x: {} });
      expect(r.ok).toBe(false);
    });
  });

  describe("failure handling", () => {
    test("unknown function fails soft (does not throw)", () => {
      const r = evaluateExpression("notAFunction(x)", { x: 1 });
      expect(r.ok).toBe(false);
      expect(r.warning).toBeDefined();
    });

    test("parse error fails soft", () => {
      const r = evaluateExpression("stripDataUri(", {});
      expect(r.ok).toBe(false);
      expect(r.warning).toBeDefined();
    });
  });
});

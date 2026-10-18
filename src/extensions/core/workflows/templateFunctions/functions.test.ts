import { describe, expect, test } from "bun:test";
import { evaluateExpression } from "../templateEval";
import { TEMPLATE_FUNCTIONS } from ".";

/** Evaluates an expression against the given scope and returns its value. */
function ev(expr: string, scope: Record<string, unknown> = {}): unknown {
  const result = evaluateExpression(expr, scope);
  if (!result.ok) throw new Error(result.warning);
  return result.value;
}

describe("math", () => {
  test("round rounds half away from zero, also for binary edge cases", () => {
    expect(ev("round(2.345, 2)")).toBe(2.35);
    expect(ev("round(1.005, 2)")).toBe(1.01);
    expect(ev("round(-2.5)")).toBe(-3);
    expect(ev("round(1234, -2)")).toBe(1200);
    expect(ev('round("3.7")')).toBe(4);
  });

  test("floor, ceil, abs, clamp", () => {
    expect(ev("floor(2.7)")).toBe(2);
    expect(ev("ceil(2.1)")).toBe(3);
    expect(ev("abs(-4)")).toBe(4);
    expect(ev("clamp(150, 0, 100)")).toBe(100);
    expect(ev("clamp(-5, 0, 100)")).toBe(0);
  });

  test("min and max take several numbers or one list, skipping non-numbers", () => {
    expect(ev("min(3, 1, 2)")).toBe(1);
    expect(ev('max([3, "7", "x", 5])')).toBe(7);
    expect(ev("max([])")).toBeNaN();
  });

  test("formatNumber groups digits per locale", () => {
    expect(ev("formatNumber(1234.5, 2)")).toBe("1.234,50");
    expect(ev('formatNumber(1234.5, 2, "en-US")')).toBe("1,234.50");
    expect(ev('formatNumber("x")')).toBe("");
    expect(ev('formatNumber(1, 0, "not a locale!")')).toBe("1");
  });
});

describe("string", () => {
  test("case functions", () => {
    expect(ev('upper("abc")')).toBe("ABC");
    expect(ev('lower("ÄB")')).toBe("äb");
    expect(ev('capitalize("hello world")')).toBe("Hello world");
  });

  test("length counts characters and list elements", () => {
    expect(ev('length("abc")')).toBe(3);
    expect(ev("length([1, 2])")).toBe(2);
    expect(ev("length(missing)")).toBe(0);
  });

  test("substring and slice-like positions", () => {
    expect(ev('substring("abcdef", 1, 3)')).toBe("bc");
    expect(ev('substring("abcdef", -2)')).toBe("ef");
  });

  test("replace replaces every occurrence as plain text", () => {
    expect(ev('replace("a.b.c", ".", "-")')).toBe("a-b-c");
    expect(ev('replace("a+b", "+", "")')).toBe("ab");
    expect(ev('replace("abc", "", "x")')).toBe("abc");
  });

  test("split and join", () => {
    expect(ev('split("a,b,c", ",")')).toEqual(["a", "b", "c"]);
    expect(ev('split("", ",")')).toEqual([]);
    expect(ev('join(["a", "b"])')).toBe("a, b");
    expect(ev('join([1, 2], "-")')).toBe("1-2");
  });

  test("padStart and padEnd", () => {
    expect(ev('padStart(7, 3, "0")')).toBe("007");
    expect(ev('padEnd("ab", 4, ".")')).toBe("ab..");
  });

  test("contains, startsWith, endsWith", () => {
    expect(ev('contains("hello", "ell")')).toBe(true);
    expect(ev('contains(["1", "2"], 2)')).toBe(true);
    expect(ev('contains([1, 2], "3")')).toBe(false);
    expect(ev('startsWith("hello", "he")')).toBe(true);
    expect(ev('endsWith("hello", "lo")')).toBe(true);
  });

  test("truncate", () => {
    expect(ev('truncate("hello world", 8)')).toBe("hello w…");
    expect(ev('truncate("short", 10)')).toBe("short");
    expect(ev('truncate("hello", 3, "...")')).toBe("hel");
  });

  test("beforeLast and afterLast", () => {
    expect(ev('beforeLast("a/b/c", "/")')).toBe("a/b");
    expect(ev('afterLast("a/b/c", "/")')).toBe("c");
    expect(ev('afterLast("abc", "/")')).toBe("");
  });
});

describe("list", () => {
  const rows = [
    { name: "b", price: 2 },
    { name: "a", price: "10" },
    { name: "c", price: 1 },
  ];

  test("first, last, at, count", () => {
    expect(ev("first([1, 2])")).toBe(1);
    expect(ev("last([1, 2])")).toBe(2);
    expect(ev("at([1, 2, 3], -2)")).toBe(2);
    expect(ev("first([])")).toBeNull();
    expect(ev("count(rows)", { rows })).toBe(3);
    expect(ev('count("abc")')).toBe(0);
  });

  test("sum and avg, of a list or a field", () => {
    expect(ev('sum([1, "2", "x"])')).toBe(3);
    expect(ev('sum(rows, "price")', { rows })).toBe(13);
    expect(ev("avg([2, 4])")).toBe(3);
    expect(ev("avg([])")).toBeNaN();
  });

  test("pluck, unique, sort, reverse, slice", () => {
    expect(ev('pluck(rows, "name")', { rows })).toEqual(["b", "a", "c"]);
    expect(ev('unique([1, "1", 1, {a: 1}, {a: 1}])')).toEqual([1, "1", { a: 1 }]);
    expect(ev("sort([10, 9, 1])")).toEqual([1, 9, 10]);
    expect(ev('pluck(sort(rows, "price"), "name")', { rows })).toEqual(["c", "b", "a"]);
    expect(ev("reverse([1, 2, 3])")).toEqual([3, 2, 1]);
    expect(ev("slice([1, 2, 3, 4], 1, -1)")).toEqual([2, 3]);
  });

  test("keys, values, range", () => {
    expect(ev("keys(o)", { o: { a: 1, b: 2 } })).toEqual(["a", "b"]);
    expect(ev("values(o)", { o: { a: 1, b: 2 } })).toEqual([1, 2]);
    expect(ev("range(3)")).toEqual([0, 1, 2]);
    expect(ev("range(2, 5)")).toEqual([2, 3, 4]);
    expect((ev("range(1e9)") as unknown[]).length).toBe(10_000);
  });

  test("field reads never reach inherited properties", () => {
    const key = "constructor";
    expect(ev("pluck(rows, key)", { rows, key })).toEqual([null, null, null]);
    expect(ev("first(pluck(rows, key))", { rows, key })).toBeNull();
    expect(ev("sort(rows, key)", { rows, key })).toEqual(rows);
    expect(ev('pluck([[1, 2]], "length")')).toEqual([2]);
  });
});

describe("logic", () => {
  test("if picks by condition", () => {
    expect(ev("if(n > 1, 2, 3)", { n: 5 })).toBe(2);
    expect(ev("if(n > 1, 2, 3)", { n: 0 })).toBe(3);
    expect(ev("if(false, 1)")).toBeNull();
  });

  test("choose maps cases with an optional fallback", () => {
    expect(ev('choose(s, "ok", "✓", "error", "✗", "?")', { s: "error" })).toBe("✗");
    expect(ev('choose(s, "ok", "✓", "?")', { s: "other" })).toBe("?");
    expect(ev('choose(s, "ok", "✓")', { s: "other" })).toBeNull();
    expect(ev('choose(n, "1", "one")', { n: 1 })).toBe("one");
  });

  test("isEmpty, isNumber, between", () => {
    for (const v of [null, "", [], {}]) expect(ev("isEmpty(v)", { v })).toBe(true);
    expect(ev("isEmpty(missing)")).toBe(true);
    expect(ev('isEmpty(" ")')).toBe(false);
    expect(ev("isEmpty(0)")).toBe(false);
    expect(ev('isNumber("4.5")')).toBe(true);
    expect(ev('isNumber("")')).toBe(false);
    expect(ev("between(5, 1, 5)")).toBe(true);
    expect(ev("between(6, 1, 5)")).toBe(false);
  });
});

describe("json & encoding", () => {
  test("toJson and parseJson", () => {
    expect(ev('toJson("a")')).toBe('"a"');
    expect(ev("toJson(o)", { o: { a: [1] } })).toBe('{"a":[1]}');
    expect(ev("toJson(missing)")).toBe("null");
    expect(ev('parseJson("{\\"a\\": 1}")')).toEqual({ a: 1 });
    expect(ev('parseJson("nope")')).toBeNull();
  });

  test("urlEncode and urlDecode", () => {
    expect(ev('urlEncode("a b&c")')).toBe("a%20b%26c");
    expect(ev('urlDecode("a%20b")')).toBe("a b");
    expect(ev('urlDecode("%E0%A4%A")')).toBe("%E0%A4%A");
  });
});

describe("totality", () => {
  test("no function throws on unusual inputs", () => {
    const inputs = [undefined, null, "", "x", 0, -1, 1.5, Number.NaN, true, [], [1, "a", null], {}, { a: 1 }];
    for (const [name, fn] of Object.entries(TEMPLATE_FUNCTIONS)) {
      for (const a of inputs) {
        for (const b of inputs) {
          expect(() => fn(a, b, a), `${name}(${String(a)}, ${String(b)})`).not.toThrow();
        }
      }
    }
  });
});

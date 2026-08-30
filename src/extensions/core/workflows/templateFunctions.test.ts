import { afterEach, describe, expect, test } from "bun:test";
import { TEMPLATE_FUNCTION_META, TEMPLATE_FUNCTION_NAME_LIST } from "../../../../shared/templateFunctionMeta";
import {
  after,
  base64Decode,
  before,
  jsonEscape,
  nowIso,
  setClock,
  stripDataUri,
  TEMPLATE_FUNCTION_NAMES,
  TEMPLATE_FUNCTIONS,
  trim,
} from "./templateFunctions";

describe("stripDataUri", () => {
  describe("data URI prefixes", () => {
    test("strips a standard image data URI prefix", () => {
      expect(stripDataUri("data:image/jpeg;base64,ABC123")).toBe("ABC123");
    });

    test("strips a png prefix", () => {
      expect(stripDataUri("data:image/png;base64,iVBORw0K")).toBe("iVBORw0K");
    });

    test("strips a prefix with extra media parameters", () => {
      expect(stripDataUri("data:image/svg+xml;charset=utf-8;base64,PD94bWw=")).toBe("PD94bWw=");
    });
  });

  describe("passthrough", () => {
    test("returns raw base64 unchanged when no prefix present", () => {
      expect(stripDataUri("ABC123")).toBe("ABC123");
    });

    test("coerces non-string input", () => {
      expect(stripDataUri(12345)).toBe("12345");
    });

    test("empty for null/undefined", () => {
      expect(stripDataUri(null)).toBe("");
      expect(stripDataUri(undefined)).toBe("");
    });
  });
});

describe("base64Decode", () => {
  test("decodes base64 to utf-8 text", () => {
    expect(base64Decode("aGVsbG8=")).toBe("hello");
  });

  test("round-trips with stripDataUri output", () => {
    const encoded = Buffer.from("world").toString("base64");
    expect(base64Decode(stripDataUri(`data:text/plain;base64,${encoded}`))).toBe("world");
  });
});

describe("jsonEscape", () => {
  test("escapes double quotes", () => {
    expect(jsonEscape('he said "hi"')).toBe('he said \\"hi\\"');
  });

  test("escapes newlines and backslashes", () => {
    expect(jsonEscape("line1\nline2\\end")).toBe("line1\\nline2\\\\end");
  });

  test("produces a value that yields valid JSON when embedded between quotes", () => {
    const raw = 'quote " and newline \n and tab \t';
    const body = `{"data": "${jsonEscape(raw)}"}`;
    const parsed = JSON.parse(body) as { data: string };
    expect(parsed.data).toBe(raw);
  });
});

describe("after", () => {
  test("returns substring after the delimiter", () => {
    expect(after("data:image/jpeg;base64,XYZ", ",")).toBe("XYZ");
  });

  test("returns empty string when delimiter absent", () => {
    expect(after("nodelimiter", ",")).toBe("");
  });
});

describe("before", () => {
  test("returns substring before the delimiter", () => {
    expect(before("key=value", "=")).toBe("key");
  });

  test("returns whole string when delimiter absent", () => {
    expect(before("nodelimiter", "=")).toBe("nodelimiter");
  });
});

describe("trim", () => {
  test("trims surrounding whitespace", () => {
    expect(trim("  padded  ")).toBe("padded");
  });
});

describe("nowIso", () => {
  afterEach(() => {
    setClock(null);
  });

  test("returns a fixed ISO timestamp when the clock is injected", () => {
    setClock(() => Date.parse("2026-08-29T12:00:00.000Z"));
    expect(nowIso()).toBe("2026-08-29T12:00:00.000Z");
  });

  test("is deterministic across calls with a fixed clock", () => {
    setClock(() => 0);
    expect(nowIso()).toBe(nowIso());
    expect(nowIso()).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("TEMPLATE_FUNCTION_NAMES", () => {
  test("contains the registered built-ins", () => {
    expect(TEMPLATE_FUNCTION_NAMES.has("stripDataUri")).toBe(true);
    expect(TEMPLATE_FUNCTION_NAMES.has("jsonEscape")).toBe(true);
    expect(TEMPLATE_FUNCTION_NAMES.has("base64Decode")).toBe(true);
    expect(TEMPLATE_FUNCTION_NAMES.has("notAFunction")).toBe(false);
  });

  test("is derived from the shared metadata name list", () => {
    expect([...TEMPLATE_FUNCTION_NAMES].sort()).toEqual([...TEMPLATE_FUNCTION_NAME_LIST].sort());
  });
});

describe("shared metadata / runtime registry consistency", () => {
  test("every implemented function has a metadata entry (no orphan implementations)", () => {
    const declared = new Set(TEMPLATE_FUNCTION_META.map((meta) => meta.name));
    for (const name of Object.keys(TEMPLATE_FUNCTIONS)) {
      expect(declared.has(name)).toBe(true);
    }
  });

  test("every metadata entry has an implementation (no orphan metadata)", () => {
    for (const meta of TEMPLATE_FUNCTION_META) {
      expect(typeof TEMPLATE_FUNCTIONS[meta.name]).toBe("function");
    }
  });

  test("metadata and implementation describe the same set of names", () => {
    expect(TEMPLATE_FUNCTION_META.map((meta) => meta.name).sort()).toEqual(Object.keys(TEMPLATE_FUNCTIONS).sort());
  });

  test("each metadata entry declares a signature, description, and return type", () => {
    for (const meta of TEMPLATE_FUNCTION_META) {
      expect(meta.signature.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
      expect(meta.returnType.length).toBeGreaterThan(0);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { setTopLevelJson5Property } from "./json5Edit";

const DOC = `// Daily report
{
  name: "report", // the id
  description: "Sends the report",
  /* trigger block */
  trigger: { type: "manual" },
  steps: {
    a: { type: "agent", group: "not-top-level" },
  },
}
`;

describe("setTopLevelJson5Property", () => {
  test("inserts a new member after the preferred key, on its own line", () => {
    const out = setTopLevelJson5Property(DOC, "group", "Reports", ["description", "name"]);
    expect(out).toBe(
      DOC.replace(`  description: "Sends the report",\n`, `  description: "Sends the report",\n  group: "Reports",\n`),
    );
  });

  test("falls back to the next preferred key and keeps its trailing comment", () => {
    const doc = `{\n  name: "x", // id\n  steps: {},\n}\n`;
    const out = setTopLevelJson5Property(doc, "group", "G", ["description", "name"]);
    expect(out).toBe(`{\n  name: "x", // id\n  group: "G",\n  steps: {},\n}\n`);
  });

  test("adds the missing comma when inserting after the last member", () => {
    const doc = `{\n  steps: {},\n  name: "x" // last\n}\n`;
    const out = setTopLevelJson5Property(doc, "group", "G", ["name"]);
    expect(out).toBe(`{\n  steps: {},\n  name: "x", // last\n  group: "G"\n}\n`);
  });

  test("inserts first when no preferred key exists, matching quoted key style", () => {
    const doc = `{\n  "steps": {}\n}`;
    const out = setTopLevelJson5Property(doc, "group", "G", ["name"]);
    expect(out).toBe(`{\n  "group": "G",\n  "steps": {}\n}`);
  });

  test("replaces only the value of an existing member", () => {
    const doc = `{\n  name: 'x',\n  group: 'Old', // keep me\n  steps: {},\n}`;
    expect(setTopLevelJson5Property(doc, "group", "New")).toBe(
      `{\n  name: 'x',\n  group: "New", // keep me\n  steps: {},\n}`,
    );
  });

  test("removes the member's whole line, including its comment", () => {
    const doc = `{\n  name: "x",\n  group: "Old", // gone\n  steps: {},\n}`;
    expect(setTopLevelJson5Property(doc, "group", undefined)).toBe(`{\n  name: "x",\n  steps: {},\n}`);
  });

  test("removes the last member without a trailing comma", () => {
    const doc = `{\n  name: "x",\n  group: "Old"\n}`;
    const out = setTopLevelJson5Property(doc, "group", undefined);
    expect(out).toBe(`{\n  name: "x",\n}`);
    expect(Bun.JSON5.parse(out!)).toEqual({ name: "x" });
  });

  test("removing an absent member leaves the text unchanged", () => {
    expect(setTopLevelJson5Property(DOC, "group", undefined)).toBe(DOC);
  });

  test("handles single-line documents", () => {
    expect(setTopLevelJson5Property(`{"name":"x","steps":{}}`, "group", "G", ["name"])).toBe(
      `{"name":"x", "group": "G","steps":{}}`,
    );
    expect(setTopLevelJson5Property(`{"name":"x","group":"G","steps":{}}`, "group", undefined)).toBe(
      `{"name":"x","steps":{}}`,
    );
  });

  test("keeps CRLF line endings", () => {
    const doc = `{\r\n  name: "x",\r\n  steps: {},\r\n}\r\n`;
    expect(setTopLevelJson5Property(doc, "group", "G", ["name"])).toBe(
      `{\r\n  name: "x",\r\n  group: "G",\r\n  steps: {},\r\n}\r\n`,
    );
  });

  test("ignores braces and keys inside strings and comments", () => {
    const doc = `{\n  name: "x } group: 1",\n  // group: "commented",\n  steps: { s: "/* { */" },\n}`;
    const out = setTopLevelJson5Property(doc, "group", "G", ["name"]);
    expect(Bun.JSON5.parse(out!)).toEqual({ name: "x } group: 1", group: "G", steps: { s: "/* { */" } });
    expect(out).toContain(`// group: "commented"`);
  });

  test("escapes the value as a JSON string", () => {
    const out = setTopLevelJson5Property(`{ name: "x" }`, "group", 'Ops "Daily"', ["name"]);
    expect((Bun.JSON5.parse(out!) as { group: string }).group).toBe('Ops "Daily"');
  });

  test("returns null for invalid or non-object documents", () => {
    expect(setTopLevelJson5Property("{ name: ", "group", "G")).toBeNull();
    expect(setTopLevelJson5Property("[1, 2]", "group", "G")).toBeNull();
  });
});

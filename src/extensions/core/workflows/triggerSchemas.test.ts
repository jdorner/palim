import { describe, expect, test } from "bun:test";
import {
  BUILTIN_TRIGGER_SCHEMAS,
  FILEWATCHER_TRIGGER_SCHEMA,
  resolveTriggerOutputSchema,
  SCHEDULER_TRIGGER_SCHEMA,
} from "./triggerSchemas";

describe("resolveTriggerOutputSchema", () => {
  test("returns filewatcher built-in schema when no explicit schema", () => {
    const result = resolveTriggerOutputSchema("filewatcher");
    expect(result).toEqual(FILEWATCHER_TRIGGER_SCHEMA);
  });

  test("returns scheduler built-in schema when no explicit schema", () => {
    const result = resolveTriggerOutputSchema("schedule");
    expect(result).toEqual(SCHEDULER_TRIGGER_SCHEMA);
  });

  test("returns undefined for webhook (no built-in schema)", () => {
    const result = resolveTriggerOutputSchema("webhook");
    expect(result).toBeUndefined();
  });

  test("returns undefined for manual (no built-in schema)", () => {
    const result = resolveTriggerOutputSchema("manual");
    expect(result).toBeUndefined();
  });

  test("prefers explicit schema over built-in", () => {
    const custom = { customField: "string" };
    const result = resolveTriggerOutputSchema("filewatcher", custom);
    expect(result).toEqual(custom);
  });

  test("uses explicit schema for webhook when provided", () => {
    const custom = { body: "object", headers: { contentType: "string" } };
    const result = resolveTriggerOutputSchema("webhook", custom);
    expect(result).toEqual(custom);
  });

  test("returns undefined for unknown trigger type with no explicit schema", () => {
    const result = resolveTriggerOutputSchema("unknown-type");
    expect(result).toBeUndefined();
  });
});

describe("BUILTIN_TRIGGER_SCHEMAS", () => {
  test("filewatcher schema has expected keys", () => {
    const schema = BUILTIN_TRIGGER_SCHEMAS.filewatcher;
    expect(schema).not.toBeUndefined();
    expect(Object.keys(schema!).sort()).toEqual(["event", "filename", "id", "slug", "source"]);
  });

  test("scheduler schema has expected keys", () => {
    const schema = BUILTIN_TRIGGER_SCHEMAS.schedule;
    expect(schema).not.toBeUndefined();
    expect(Object.keys(schema!).sort()).toEqual(["description", "id", "label", "slug", "source"]);
  });

  test("all schema values are strings (flat schemas)", () => {
    for (const [, schema] of Object.entries(BUILTIN_TRIGGER_SCHEMAS)) {
      if (!schema) continue;
      for (const value of Object.values(schema)) {
        expect(typeof value).toBe("string");
      }
    }
  });
});
